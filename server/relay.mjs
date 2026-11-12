// 墨游 · 临时内存转发器。请求内容及凭证不落盘、不写日志。
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const VERSION = '1.0.0';
const denied = new BlockList();
for (const [ip, mask] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) denied.addSubnet(ip, mask, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, mask] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) denied.addSubnet(ip, mask, 'ipv6');

export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

function problem(status, message) { return Object.assign(new Error(message), { status }); }

export async function checkedTarget(value, lookup = dnsLookup) {
  let url;
  try { url = new URL(value); } catch { throw problem(400, '上游地址格式不对'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || !host || /(^|\.)(localhost|local|internal|home|lan)$/i.test(host)) {
    throw problem(400, '只允许不带账号密码的公网 HTTPS 地址');
  }
  let addresses;
  try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }); }
  catch { throw problem(400, '上游域名解析失败'); }
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw problem(400, '不能转发到内网或保留地址');
  url.hash = '';
  return { url, address: addresses[0] };
}

const allowedHeaders = new Set(['authorization', 'content-type', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'anthropic-dangerous-direct-browser-access', 'x-goog-api-key', 'openai-organization', 'openai-project']);
function requestHeaders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem(400, 'headers 必须是对象');
  const headers = { 'accept-encoding': 'identity' };
  for (const [key, value] of Object.entries(input)) {
    if (!allowedHeaders.has(key.toLowerCase()) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw problem(400, '请求头不受支持');
    headers[key.toLowerCase()] = value;
  }
  return headers;
}

// 固定本次解析出的公网 IP；TLS 仍验证原域名。禁止重定向，避免凭证泄漏和 DNS 重绑定。
function upstreamRequest(target, headers, body, signal) {
  return new Promise((resolve, reject) => {
    const { address, family } = target.address;
    const req = https.request(target.url, {
      method: 'POST', headers, signal, agent: false,
      lookup: (_host, options, cb) => options.all ? cb(null, [{ address, family }]) : cb(null, address, family),
    }, resolve);
    req.on('error', reject);
    req.end(body);
  });
}

export function createRelayServer({
  token, origins = ['https://lishbuwe.github.io'], lookup = dnsLookup,
  requestUpstream = upstreamRequest, log = (entry) => console.info(JSON.stringify(entry)),
  now = Date.now, ttl = 30 * 60_000, maxJobs = 20, maxBytes = 5 * 1024 * 1024,
  maxBody = 2 * 1024 * 1024, maxRunMs = 15 * 60_000,
} = {}) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('RELAY_TOKEN 必须是至少 32 位的随机口令');
  const jobs = new Map();
  const expectedToken = Buffer.from('Bearer ' + token);
  const auth = (value = '') => {
    const received = Buffer.from(value);
    return received.length === expectedToken.length && timingSafeEqual(received, expectedToken);
  };
  const finish = (job, error = null) => {
    if (job.state !== 'running') return;
    job.state = error ? 'error' : 'done'; job.error = error; job.endedAt = now();
    clearTimeout(job.timer); job.readyResolve();
    for (const listener of job.listeners) void pump(job, listener);
    log({ id: job.id, host: job.host, status: job.upstreamStatus, bytes: job.bytes, ms: job.endedAt - job.createdAt });
  };
  const drained = (res) => new Promise((resolve) => {
    const end = (ok) => { res.off('drain', drain); res.off('close', close); res.off('error', close); resolve(ok); };
    const drain = () => end(true); const close = () => end(false);
    res.once('drain', drain); res.once('close', close); res.once('error', close);
  });
  const pump = async (job, listener) => {
    if (listener.pumping) return;
    listener.pumping = true;
    const { res } = listener;
    try {
      // 每个订阅只保留游标，共享同一份原始缓存；背压不会阻塞上游生成。
      while (!res.destroyed && listener.index < job.chunks.length) {
        const chunk = job.chunks[listener.index++].subarray(listener.skip);
        listener.skip = 0;
        if (!res.write(chunk) && !(await drained(res))) return;
      }
      if (!res.destroyed && job.state !== 'running') { job.listeners.delete(listener); res.end(); }
    } catch { res.destroy(); }
    finally { listener.pumping = false; }
  };
  const run = async (job, target, headers, body) => {
    job.timer = setTimeout(() => { finish(job, '生成超过 15 分钟，已停止'); job.abort.abort(); }, maxRunMs);
    job.timer.unref();
    try {
      const upstream = await requestUpstream(target, headers, body, job.abort.signal);
      if (job.state !== 'running') { upstream.destroy(); return; }
      job.upstreamStatus = upstream.statusCode;
      job.contentType = upstream.headers['content-type'] || 'application/octet-stream';
      if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
        upstream.destroy(); finish(job, '上游要求重定向，请填写最终 API 地址'); return;
      }
      job.readyResolve();
      const encoding = (upstream.headers['content-encoding'] || '').toLowerCase();
      const decode = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
      if (encoding && encoding !== 'identity' && !decode) { upstream.destroy(); throw new Error('encoding'); }
      const source = decode ? upstream.pipe(decode()) : upstream;
      if (decode) upstream.on('error', (e) => source.destroy(e));
      for await (const data of source) {
        if (job.state !== 'running') break;
        const chunk = Buffer.from(data);
        if (job.bytes + chunk.length > maxBytes) {
          finish(job, '返回内容超过 5 MB，已停止'); job.abort.abort(); upstream.destroy(); return;
        }
        job.chunks.push(chunk); job.bytes += chunk.length;
        for (const listener of job.listeners) void pump(job, listener);
      }
      finish(job);
    } catch { finish(job, '上游连接失败或生成中途断开'); }
  };
  const sweep = () => {
    for (const [id, job] of jobs) if (job.endedAt != null && now() - job.endedAt >= ttl) {
      for (const { res } of job.listeners) res.destroy();
      jobs.delete(id);
    }
  };
  const gc = setInterval(sweep, 60_000); gc.unref();
  const json = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) { json(res, 403, { error: '不允许这个网页来源' }); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Expose-Headers', 'X-Upstream-Status, X-Upstream-Content-Type, X-Job-State');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const path = new URL(req.url, 'http://relay.invalid');
    if (req.method === 'GET' && path.pathname === '/health') { json(res, 200, { ok: true, version: VERSION }); return; }
    if (!auth(req.headers.authorization)) { json(res, 401, { error: '转发口令不正确' }); return; }
    try {
      sweep();
      if (req.method === 'POST' && path.pathname === '/jobs') {
        if (jobs.size >= maxJobs) throw problem(503, '转发任务已满，请稍后再试');
        if (Number(req.headers['content-length']) > maxBody) throw problem(413, '请求超过 2 MB');
        const buffers = []; let size = 0;
        for await (const data of req) {
          size += data.length;
          if (size > maxBody) throw problem(413, '请求超过 2 MB');
          buffers.push(data);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw problem(400, '请求必须是 JSON'); }
        if (!input || input.method !== 'POST' || typeof input.body !== 'string') throw problem(400, '只接受 POST 和字符串 body');
        const headers = requestHeaders(input.headers);
        const target = await checkedTarget(input.url, lookup);
        if (jobs.size >= maxJobs) throw problem(503, '转发任务已满，请稍后再试');
        const job = { id: randomUUID(), state: 'running', upstreamStatus: null, contentType: '', chunks: [], bytes: 0,
          createdAt: now(), endedAt: null, error: null, abort: new AbortController(), listeners: new Set(), host: target.url.hostname };
        job.ready = new Promise((resolve) => { job.readyResolve = resolve; });
        jobs.set(job.id, job);
        // 启动上游不依赖订阅连接；手机断开不取消此任务。
        void run(job, target, headers, input.body);
        json(res, 201, { id: job.id }); return;
      }
      const match = /^\/jobs\/([a-zA-Z0-9-]+)(\/stream)?$/.exec(path.pathname);
      const job = match && jobs.get(match[1]);
      if (!job) throw problem(404, '转发任务不存在或已过期');
      if (req.method === 'GET' && !match[2]) {
        json(res, 200, { state: job.state, upstreamStatus: job.upstreamStatus, contentType: job.contentType, bytes: job.bytes, error: job.error }); return;
      }
      if (req.method === 'DELETE' && !match[2]) {
        finish(job, '已取消'); job.abort.abort(); json(res, 200, { state: job.state }); return;
      }
      if (req.method === 'GET' && match[2]) {
        const value = path.searchParams.get('from') || '0';
        const from = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(from) || from < 0) throw problem(400, 'from 必须是非负字节数');
        await job.ready;
        if (res.destroyed) return;
        if (from > job.bytes) throw problem(416, 'from 超出已有内容');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Upstream-Status': job.upstreamStatus || 502,
          'X-Upstream-Content-Type': job.contentType || 'application/octet-stream', 'X-Job-State': job.state, 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        let offset = 0; let index = 0;
        while (index < job.chunks.length && offset + job.chunks[index].length <= from) offset += job.chunks[index++].length;
        const listener = { res, index, skip: from - offset, pumping: false };
        job.listeners.add(listener);
        res.on('close', () => job.listeners.delete(listener));
        void pump(job, listener);
        return;
      }
      throw problem(405, '不支持这个方法');
    } catch (e) {
      if (!res.headersSent && !res.destroyed) json(res, e.status || 500, { error: e.status ? e.message : '转发服务器处理失败' });
      else res.destroy();
    }
  });
  server.requestTimeout = 30_000;
  server.shutdown = () => {
    clearInterval(gc);
    for (const job of jobs.values()) { finish(job, '转发服务已停止'); job.abort.abort(); }
    server.close(); server.closeAllConnections();
  };
  server.on('close', () => clearInterval(gc));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const origins = ['https://lishbuwe.github.io', ...(process.env.RELAY_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean)];
  const server = createRelayServer({ token: process.env.RELAY_TOKEN, origins });
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1');
  const stop = () => server.shutdown();
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
