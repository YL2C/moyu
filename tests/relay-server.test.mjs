import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelayServer, checkedTarget, publicAddress } from '../server/relay.mjs';

const token = 'x'.repeat(40);
const payload = { url: 'https://api.example.com/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer private-key', 'Content-Type': 'application/json' }, body: '{"model":"test"}' };

async function fixture(t, options = {}) {
  const calls = []; const logs = [];
  const requestUpstream = async (target, headers, body, signal) => {
    const stream = new PassThrough(); stream.statusCode = 200; stream.headers = { 'content-type': 'text/event-stream' };
    calls.push({ target, headers, body, signal, stream });
    signal.addEventListener('abort', () => stream.destroy(new Error('aborted')), { once: true });
    return stream;
  };
  const server = createRelayServer({ token, lookup: async () => [{ address: '8.8.8.8', family: 4 }], requestUpstream, log: (entry) => logs.push(entry), ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.shutdown());
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = (path, init = {}) => fetch(base + path, { ...init, headers: { Authorization: 'Bearer ' + token, ...init.headers } });
  const create = async () => { const res = await req('/jobs', { method: 'POST', body: JSON.stringify(payload) }); assert.equal(res.status, 201); return (await res.json()).id; };
  return { req, create, calls, logs, base };
}

test('拒绝内网、保留地址、IPv6 映射、十进制 IP 和 DNS 重绑定目标', async () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '100.64.0.1', '169.254.169.254', '172.31.1.1', '192.168.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8', '2002:7f00:1::', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
  for (const url of ['http://example.com', 'https://localhost.', 'https://user:pass@example.com', 'https://2130706433', 'https://[::1]']) await assert.rejects(checkedTarget(url));
  await assert.rejects(checkedTarget('https://example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]));
});

test('健康检查无需口令；鉴权、CORS 和预检', async (t) => {
  const { base, req } = await fixture(t);
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/jobs/nope')).status, 401);
  assert.equal((await req('/jobs/nope')).status, 404);
  assert.equal((await req('/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const preflight = await fetch(base + '/jobs', { method: 'OPTIONS', headers: { Origin: 'https://lishbuwe.github.io', 'Access-Control-Request-Headers': 'Authorization, Content-Type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://lishbuwe.github.io');
});

test('无人订阅也生成；手机断线后可从 0 或 UTF-8 字节偏移重放，不另发上游请求', async (t) => {
  const { create, req, calls, logs } = await fixture(t);
  const id = await create();
  const text = Buffer.from('你好，世界\n');
  calls[0].stream.write(text.subarray(0, 5)); await delay(10);
  assert.equal((await (await req('/jobs/' + id)).json()).bytes, 5);
  const ctrl = new AbortController();
  const live = await req('/jobs/' + id + '/stream?from=0', { signal: ctrl.signal });
  assert.equal(live.headers.get('X-Upstream-Status'), '200');
  const reader = live.body.getReader(); assert.deepEqual(Buffer.from((await reader.read()).value), text.subarray(0, 5));
  ctrl.abort(); await reader.cancel().catch(() => {});
  assert.equal(calls[0].signal.aborted, false);
  calls[0].stream.end(text.subarray(5)); await delay(10);
  assert.equal(await (await req('/jobs/' + id + '/stream?from=0')).text(), text.toString());
  assert.deepEqual(Buffer.from(await (await req('/jobs/' + id + '/stream?from=5')).arrayBuffer()), text.subarray(5));
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['bytes', 'host', 'id', 'ms', 'status']);
  assert.ok(!JSON.stringify(logs).includes('private-key'));
});

test('同时订阅、上游错误原文与状态码保留', async (t) => {
  const { create, req, calls } = await fixture(t);
  const id = await create();
  const a = await req('/jobs/' + id + '/stream'); const b = await req('/jobs/' + id + '/stream');
  const first = a.text(); const second = b.text(); calls[0].stream.end('data: 一章\n\n');
  assert.equal(await first, await second);
  const other = await fixture(t, { requestUpstream: async () => {
    const res = new PassThrough(); res.statusCode = 429; res.headers = { 'content-type': 'application/json' };
    queueMicrotask(() => res.end('{"error":"slow down"}')); return res;
  } });
  const errorId = await other.create();
  const err = await other.req('/jobs/' + errorId + '/stream');
  assert.equal(err.status, 200); assert.equal(err.headers.get('X-Upstream-Status'), '429');
  assert.equal(await err.text(), '{"error":"slow down"}');
});

test('大于 1 MB 的已完成结果可以完整重放，慢订阅不阻塞其他订阅', async (t) => {
  const { create, req, calls } = await fixture(t);
  const id = await create();
  const data = Buffer.alloc(2 * 1024 * 1024, '文');
  calls[0].stream.end(data);
  await delay(10);
  const a = await req('/jobs/' + id + '/stream');
  const b = await req('/jobs/' + id + '/stream');
  assert.deepEqual(Buffer.from(await b.arrayBuffer()), data);
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), data);
});

test('主动停止中断上游，失败状态可查询', async (t) => {
  const { create, req, calls } = await fixture(t);
  const id = await create();
  assert.equal((await req('/jobs/' + id, { method: 'DELETE' })).status, 200);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal((await (await req('/jobs/' + id)).json()).state, 'error');
});

test('限制请求、返回大小、任务数及完成后的保留时间', async (t) => {
  let time = 0;
  const { create, req, calls } = await fixture(t, { maxJobs: 1, maxBytes: 5, maxBody: 1024, ttl: 100, now: () => time });
  assert.equal((await req('/jobs', { method: 'POST', body: 'x'.repeat(1025) })).status, 413);
  const id = await create();
  assert.equal((await req('/jobs', { method: 'POST', body: JSON.stringify(payload) })).status, 503);
  calls[0].stream.write('123456'); await delay(10);
  assert.equal((await (await req('/jobs/' + id)).json()).state, 'error');
  assert.equal(calls[0].signal.aborted, true);
  time = 99; assert.equal((await req('/jobs/' + id)).status, 200);
  time = 100; assert.equal((await req('/jobs/' + id)).status, 404);
});

test('from 范围校验，拒绝重定向和敏感的代理请求头', async (t) => {
  const { create, req, calls } = await fixture(t);
  assert.equal((await req('/jobs', { method: 'POST', body: JSON.stringify({ ...payload, headers: { Host: 'localhost' } }) })).status, 400);
  const id = await create();
  calls[0].stream.end('test'); await delay(10);
  assert.equal((await req('/jobs/' + id + '/stream?from=-1')).status, 400);
  assert.equal((await req('/jobs/' + id + '/stream?from=5')).status, 416);
  const redirect = await fixture(t, { requestUpstream: async () => {
    const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'https://127.0.0.1' }; return res;
  } });
  const rid = await redirect.create();
  const state = await (await redirect.req('/jobs/' + rid)).json(); assert.equal(state.state, 'error');
});
