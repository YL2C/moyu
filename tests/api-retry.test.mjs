import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { holdStoryJob, releaseStoryJob, streamWithRetry } from '../js/api.js';
import { getRequestLog } from '../js/cost.js';
import { db } from '../js/db.js';

const conn = { format: 'openai', baseUrl: 'https://model.example/v1', apiKey: 'mock-key', model: 'test', stream: true };
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const success = () => json({ choices: [{ message: { content: '生成成功' }, finish_reason: 'stop' }] });
const waitTurn = () => new Promise((resolve) => setImmediate(resolve));

test('HTTP 429 和流式 RESOURCE_EXHAUSTED 均不重发，失败也记请求数', async (t) => {
  const responses = [json({ error: { message: 'quota exceeded' } }, 429),
    new Response('data: {"error":{"status":"RESOURCE_EXHAUSTED","message":"Try later"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    json([{ error: { status: 'RESOURCE_EXHAUSTED', message: 'Try later' } }], 503)];
  const mock = t.mock.method(globalThis, 'fetch', async () => responses.shift());
  for (let i = 0; i < 3; i++) {
    await assert.rejects(streamWithRetry(conn, {}, { requestKind: '正文', storyId: 'rate-limit' }),
      (error) => error.kind === 'ratelimit' && error.message.includes('手动重试或换模型'));
    assert.equal(mock.mock.callCount(), i + 1);
  }
  const log = await getRequestLog('rate-limit');
  assert.deepEqual(log.map((r) => [r.posts, r.outcome, r.status]), [[1, 'ratelimit', 429], [1, 'ratelimit', 0], [1, 'ratelimit', 503]]);
});

test('参数降级和服务错误共用重发额度，之后同一连接直接省略参数', async (t) => {
  const body = [];
  const responses = [json({ error: { message: 'stream_options.include_usage is unsupported' } }, 400), json({ error: 'temporarily down' }, 503), success()];
  t.mock.method(globalThis, 'fetch', async (_, init) => { body.push(JSON.parse(init.body)); return responses.shift(); });
  const saved = { ...conn, id: 'memo-retry' };
  await assert.rejects(streamWithRetry(saved, {}, { requestKind: '番外', storyId: 'memo' }), (error) => error.status === 503);
  assert.equal(body.length, 2);
  assert.deepEqual(body[0].stream_options, { include_usage: true });
  assert.equal(body[1].stream_options, undefined);
  assert.equal((await streamWithRetry({ ...saved }, {}, { requestKind: '正文', storyId: 'memo' })).text, '生成成功');
  assert.equal(body.length, 3);
  assert.equal(body[2].stream_options, undefined);
  assert.deepEqual((await getRequestLog('memo')).map((r) => r.posts), [2, 1]);
});

test('可重试的直连网络错误等待四秒后只再发一次', async (t) => {
  const times = [];
  t.mock.method(globalThis, 'fetch', async () => { times.push(performance.now()); throw new TypeError('network disconnected'); });
  await assert.rejects(streamWithRetry(conn, {}), (error) => error.kind === 'network');
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 3900);
});

test('转发的模型 429 只提交一个任务，接回 429 只查询原任务', async (t) => {
  await db.kvSet('relay', { on: true, url: 'https://relay.example/relay', token: 'mock-token' });
  const calls = [];
  let throttled = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push(init.method || 'GET');
    if (init.method === 'POST') return json({ id: 'one-job' }, 201);
    if (throttled) return json({}, 429);
    if (url.includes('/stream?')) return json({ error: { status: 'RESOURCE_EXHAUSTED' } }, 200,
      { 'X-Job-State': 'done', 'X-Upstream-Status': '429', 'X-Upstream-Content-Type': 'application/json' });
    return json({ state: 'done' });
  });
  await assert.rejects(streamWithRetry({ ...conn, viaRelay: true }, {}, { requestKind: '正文', storyId: 'relay-test' }),
    (error) => error.kind === 'ratelimit' && error.status === 429);
  assert.equal(calls.filter((m) => m === 'POST').length, 1);
  throttled = true;
  const n = calls.length;
  await assert.rejects(streamWithRetry(conn, { resumeJob: 'one-job' }, { requestKind: '接回正文', storyId: 'relay-test' }),
    (error) => error.kind === 'relay_throttled');
  assert.deepEqual(calls.slice(n), ['GET']);
  assert.deepEqual((await getRequestLog('relay-test')).map((r) => [r.posts, r.relayPosts]), [[1, 1], [0, 0]]);
});

test('前情整理等待正文以及暂时脱离阅读页的后台正文任务', async (t) => {
  let finishStory;
  const first = new Promise((resolve) => { finishStory = resolve; });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    calls.push(JSON.parse(init.body).messages[0].content);
    return calls.length === 1 ? first : success();
  });
  const play = streamWithRetry(conn, { messages: [{ role: 'user', content: '正文' }] }, { queueStory: 'play' });
  const archive = streamWithRetry(conn, { messages: [{ role: 'user', content: '整理前情' }] }, { queueStory: 'archive' });
  await waitTurn();
  assert.deepEqual(calls, ['正文']);
  holdStoryJob('detached-test');
  try {
    finishStory(success());
    await play;
    await waitTurn();
    assert.deepEqual(calls, ['正文']);
  } finally { releaseStoryJob('detached-test'); }
  await archive;
  assert.deepEqual(calls, ['正文', '整理前情']);
});
