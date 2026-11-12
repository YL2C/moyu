import { db } from './db.js';

const HINT = '检查设置里的服务器地址和口令；也可以在连接里关掉“经服务器转发”改直连。';
export class RelayError extends Error {
  constructor(kind, message, { hint = HINT, status = 0 } = {}) { super(message); this.kind = kind; this.hint = hint; this.status = status; }
}

export function relayUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new RelayError('relay_config', '请填写转发服务器的 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new RelayError('relay_config', '转发服务器必须使用 HTTPS，地址里不要带口令、查询参数或 #');
  }
  return url.href.replace(/\/+$/, '');
}

export async function getRelay() { return (await db.kvGet('relay', null)) || { url: '', token: '', on: false, region: '' }; }
export async function saveRelay(config) {
  const url = config.url?.trim() ? relayUrl(config.url) : '';
  const token = String(config.token || '').trim();
  if (config.on && (!url || !token)) throw new RelayError('relay_config', '启用转发前，请填好服务器地址和口令');
  return db.kvSet('relay', { url, token, on: !!config.on, region: config.region || '' });
}

async function call(config, path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', 'Bearer ' + config.token);
  let res;
  try { res = await fetch(relayUrl(config.url) + path, { ...init, headers, cache: 'no-store', credentials: 'omit', redirect: 'error' }); }
  catch (e) {
    if (init.signal?.aborted) throw e;
    throw new RelayError('relay_network', '连不上转发服务器');
  }
  if (res.status === 401) throw new RelayError('relay_auth', '连不上转发服务器：口令不正确', { status: 401 });
  return res;
}

export async function testRelay(config) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(relayUrl(config.url) + '/health', { signal: ctrl.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (!res.ok || (await res.json()).ok !== true) throw new Error('health');
    const auth = await call(config, '/jobs/connection-test-not-a-job', { signal: ctrl.signal });
    if (auth.status !== 404) throw new Error('auth');
    return true;
  } catch (e) {
    if (e instanceof RelayError) throw e;
    throw new RelayError('relay_network', '连不上转发服务器，请检查 HTTPS 地址和网络');
  } finally { clearTimeout(timer); }
}

export async function cancelRelayJob(id, server) {
  const config = await getRelay();
  if (!config.token || (server && relayUrl(server) !== relayUrl(config.url))) throw new RelayError('relay_config', '请先恢复这一章使用的转发服务器设置');
  const res = await call(config, '/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new RelayError('relay_network', '暂时无法停止后台任务');
}

/** 返回 fetch 形状的 Response；重放从 0 开始，继续复用原有模型解析器。 */
export async function relayFetch(url, init, { config, resumeJob = null, relayServer = '', onJob = () => {} } = {}) {
  config ||= await getRelay();
  if (!config.on || !config.url || !config.token) throw new RelayError('relay_config', '请先在设置里启用服务器转发');
  if (relayServer && relayUrl(config.url) !== relayUrl(relayServer)) throw new RelayError('relay_config', '这一章在另一台转发服务器上，请恢复原来的服务器设置后接回');
  const { signal } = init;
  signal?.throwIfAborted();
  let id = resumeJob;
  const cancelJob = () => { if (id) void call(config, '/jobs/' + encodeURIComponent(id), { method: 'DELETE', keepalive: true }).catch(() => {}); };
  const onAbort = () => { if (!['idle', 'leave', 'reconnect'].includes(signal.reason)) cancelJob(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  let reader;
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  const state = async () => {
    const res = await call(config, '/jobs/' + encodeURIComponent(id), { signal });
    if (res.status === 404) throw new RelayError('relay_expired', '后台生成任务已过期或服务器已重启', { status: 404, hint: '服务器只保留完成后 30 分钟的结果。已收到的内容会保留，可以续写或重试。' });
    if (!res.ok) throw new RelayError('relay_network', '暂时无法查询转发任务', { status: res.status });
    return res.json();
  };
  try {
    if (!id) {
      const res = await call(config, '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: init.body }), signal });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new RelayError('relay_job', error.error || '转发服务器没有接受任务', { status: res.status });
      }
      id = (await res.json()).id;
      if (typeof id !== 'string' || !id) throw new RelayError('relay_network', '转发服务器没有返回任务编号');
      try { await onJob(id, relayUrl(config.url)); } catch (e) { cancelJob(); throw e; }
      if (signal?.aborted) { onAbort(); signal.throwIfAborted(); }
    }
    const res = await call(config, '/jobs/' + encodeURIComponent(id) + '/stream?from=0', { signal });
    if (res.status === 404) throw new RelayError('relay_expired', '后台生成任务已过期或服务器已重启', { status: 404, hint: '服务器只保留完成后 30 分钟的结果。已收到的内容会保留，可以续写或重试。' });
    if (!res.ok) throw new RelayError('relay_network', '连不上转发服务器的生成任务', { status: res.status });
    if (res.headers.get('X-Job-State') === 'error') {
      const job = await state();
      await res.body?.cancel();
      throw new RelayError('relay_job', job.error || '后台生成失败', { hint: '已收到的部分会保留，可以续写或重试。' });
    }
    const status = Number(res.headers.get('X-Upstream-Status'));
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new RelayError('relay_network', '转发服务器返回的状态不正确');
    reader = res.body.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (!done) { controller.enqueue(value); return; }
          const job = await state();
          if (job.state === 'error') throw new RelayError('relay_job', job.error || '后台生成中断', { hint: '已收到的部分会保留，可以续写或重试。' });
          if (job.state !== 'done') throw new RelayError('relay_network', '与转发服务器的连接中断了');
          cleanup(); controller.close();
        } catch (e) { cleanup(); controller.error(e); }
      },
      cancel(reason) { cleanup(); return reader.cancel(reason); },
    });
    // 这些状态没有响应体；模型 API 正常不会返回它们。
    if ([204, 205, 304].includes(status)) { await reader.cancel(); cleanup(); return new Response(null, { status }); }
    return new Response(stream, { status, headers: { 'content-type': res.headers.get('X-Upstream-Content-Type') || 'application/octet-stream' } });
  } catch (e) { cleanup(); if (reader) await reader.cancel().catch(() => {}); throw e; }
}
