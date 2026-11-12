import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, exportAll, exportStory } from '../js/db.js';
import { relayFetch, relayUrl, saveRelay, testRelay } from '../js/relay.js';
import { streamChat, streamWithRetry } from '../js/api.js';

const config = { on: true, url: 'https://relay.example/relay', token: 'relay-secret' };
const conn = { id: 'conn', viaRelay: true, format: 'openai', baseUrl: 'https://api.example/v1', apiKey: 'model-secret', model: 'test' };
const response = (text, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
const sse = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
const streamResponse = (body = sse, status = 200, state = 'done') => new Response(body, { headers: { 'X-Upstream-Status': String(status), 'X-Upstream-Content-Type': 'text/event-stream', 'X-Job-State': state } });

function setup(t, mock, relay = config) {
  const original = { fetch: globalThis.fetch, get: db.kvGet, set: db.kvSet };
  globalThis.fetch = mock; db.kvGet = async (key, fallback) => key === 'relay' ? relay : fallback;
  t.after(() => { globalThis.fetch = original.fetch; db.kvGet = original.get; db.kvSet = original.set; });
}

test('新任务先保存编号再订阅，原来的 SSE 解析器得到正文及用量', async (t) => {
  let persisted = false; let created = 0;
  setup(t, async (url, init) => {
    assert.equal(init.headers.get('Authorization'), 'Bearer relay-secret');
    if (url.endsWith('/jobs')) {
      created++;
      const payload = JSON.parse(init.body); assert.equal(payload.headers.authorization, 'Bearer model-secret');
      return response('{"id":"job-1"}', 201);
    }
    if (url.includes('/stream?from=0')) { assert.ok(persisted); return streamResponse(); }
    return response('{"state":"done"}');
  });
  const r = await streamChat(conn, { messages: [{ role: 'user', content: '开始' }], onJob: async (id, server) => { assert.equal(id, 'job-1'); assert.equal(server, config.url); persisted = true; } });
  assert.equal(r.text, '你好，世界'); assert.equal(r.usage.completion_tokens, 5); assert.equal(created, 1);
});

test('恢复只读原任务，不创建请求、不重新换 Vertex 令牌、不需要原密钥', async (t) => {
  const requests = [];
  setup(t, async (url) => { requests.push(url); return url.includes('/stream?from=0') ? streamResponse() : response('{"state":"done"}'); });
  for (let n = 0; n < 2; n++) {
    const r = await streamChat({ format: 'vertex', model: 'old-model' }, { resumeJob: 'job-existing', relayServer: config.url });
    assert.equal(r.text, '你好，世界');
  }
  assert.equal(requests.filter((url) => url.endsWith('/jobs')).length, 0);
  assert.equal(requests.length, 4);
});

test('全局关闭或连接关闭时直连', async (t) => {
  setup(t, async (url) => { assert.equal(url, 'https://api.example/v1/chat/completions'); return response('{"choices":[{"message":{"content":"直连"},"finish_reason":"stop"}]}'); }, { ...config, on: false });
  assert.equal((await streamChat(conn, { messages: [] })).text, '直连');
  assert.equal((await streamChat({ ...conn, viaRelay: false }, { messages: [] })).text, '直连');
});

test('401、任务过期与服务器生成失败分别报告；上游 401 仍报告模型密钥错误', async (t) => {
  let mode = 'auth';
  setup(t, async (url) => {
    if (mode === 'auth') return response('{}', 401);
    if (mode === 'expired') return response('{}', 404);
    if (mode === 'job') return url.includes('/stream?') ? streamResponse('', 200, 'error') : response('{"state":"error","error":"已取消"}');
    return url.includes('/stream?') ? new Response('{"error":"invalid key"}', { headers: { 'X-Upstream-Status': '401', 'X-Upstream-Content-Type': 'application/json', 'X-Job-State': 'done' } }) : response('{"state":"done"}');
  });
  for (const [m, kind] of [['auth', 'relay_auth'], ['expired', 'relay_expired'], ['job', 'relay_job'], ['upstream', 'auth']]) {
    mode = m; await assert.rejects(streamChat(conn, { resumeJob: 'job' }), (e) => e.kind === kind);
  }
});

test('流意外结束后查询状态，不能把未完成或错误的任务当成成功', async (t) => {
  setup(t, async (url) => url.includes('/stream?') ? streamResponse(sse, 200, 'running') : response('{"state":"error","error":"上游断开"}'));
  await assert.rejects(streamChat(conn, { resumeJob: 'job' }), (e) => e.kind === 'relay_job' && e.partial === '你好，世界');
});

test('主动停止才 DELETE；切走和重连接保留后台任务', async (t) => {
  const requests = [];
  setup(t, async (url, init) => {
    requests.push({ url, method: init.method });
    if (init.method === 'DELETE') return response('{"state":"error"}');
    return streamResponse(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"前文"}}]}\n\n'));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
    } }), 200, 'running');
  });
  for (const reason of ['reconnect', 'leave', 'user']) {
    const ctrl = new AbortController();
    await assert.rejects(streamChat(conn, { resumeJob: 'job', signal: ctrl.signal, onText: () => ctrl.abort(reason) }), (e) => e.kind === 'aborted');
  }
  assert.equal(requests.filter((r) => r.method === 'DELETE').length, 1);
});

test('创建任务时网络不确定，不自动重发导致重复调用', async (t) => {
  let requests = 0;
  setup(t, async () => { requests++; throw new TypeError('network unavailable'); });
  await assert.rejects(streamWithRetry(conn, { messages: [] }), (e) => e.kind === 'relay_network');
  assert.equal(requests, 1);
});

test('任务创建响应损坏时也不自动重复创建', async (t) => {
  let requests = 0;
  setup(t, async () => { requests++; return response('{"id":'); });
  await assert.rejects(streamWithRetry(conn, { messages: [] }), (e) => e.kind === 'relay_network');
  assert.equal(requests, 1);
});

test('转发设置只接受 HTTPS，不把旧任务接到另一台服务器', async (t) => {
  setup(t, async () => { throw new Error('should not fetch'); });
  for (const url of ['http://relay.example', 'https://user:pass@relay.example', 'https://relay.example?token=secret']) assert.throws(() => relayUrl(url));
  await assert.rejects(relayFetch('', {}, { resumeJob: 'job', relayServer: 'https://different.example' }), (e) => e.kind === 'relay_config');
  await assert.rejects(saveRelay({ on: true, url: 'https://relay.example', token: '' }));
});

test('测试按钮同时检查 health 和带口令的任务接口', async (t) => {
  const paths = [];
  setup(t, async (url) => { paths.push(url); return url.endsWith('/health') ? response('{"ok":true}') : response('{}', 404); });
  assert.equal(await testRelay(config), true); assert.equal(paths.length, 2);
});

test('全部备份与单故事备份不含转发口令', async (t) => {
  const original = { all: db.all, byStory: db.byStory, get: db.get, extrasOf: db.extrasOf };
  setup(t, async () => { throw new Error('no requests'); });
  const pending = { id: 'node', text: '已有正文', relayJob: 'temporary-job', relayContext: { server: config.url } };
  db.all = async (store) => store === 'nodes' ? [pending] : []; db.byStory = async () => [pending]; db.get = async () => ({ id: 'story' }); db.extrasOf = async () => [];
  t.after(() => Object.assign(db, original));
  for (const backup of [await exportAll(), await exportAll({ includeKeys: true }), await exportStory('story')]) {
    assert.equal(JSON.stringify(backup).includes('relay-secret'), false);
    assert.equal('relay' in backup, false);
    assert.equal('relayJob' in backup.nodes[0], false);
    assert.equal(backup.nodes[0].text, '已有正文');
  }
});
