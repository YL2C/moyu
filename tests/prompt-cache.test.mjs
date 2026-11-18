import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { streamChat } from '../js/api.js';
import { buildContext } from '../js/prompt.js';
import { emptyMemory } from '../js/memory.js';
import { normalizeUsage, computeCost } from '../js/cost.js';
import { db } from '../js/db.js';

const scope = 'cache-test';
const fixed = '固定设置和前情档案。'.repeat(600);
const opts = (suffix = '现况一', cacheScope = scope) => ({
  system: `${fixed}\n\n${suffix}`, cachePrefix: fixed, cacheScope,
  messages: [{ role: 'user', content: '本轮动作' }],
});
const json = (data, status = 200) => Response.json(data, { status });
const openai = (cached = 0) => ({ choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4300, prompt_tokens_details: { cached_tokens: cached }, completion_tokens: 18 } });
const cacheName = 'projects/1234/locations/global/cachedContents/fixture';
const cacheResponse = () => ({ name: cacheName, createTime: new Date().toISOString(),
  expireTime: new Date(Date.now() + 300_000).toISOString(), usageMetadata: { totalTokenCount: 4096 } });

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
function vertex(id, model = 'gemini-3.5-flash', viaRelay = false) {
  return { format: 'vertex', model, viaRelay, stream: false, promptCache: true,
    apiKey: JSON.stringify({ type: 'service_account', project_id: 'fixture-project', client_email: `${id}@example.test`, private_key: privateKey }) };
}
function mock(t, fetch, relay = null) {
  const originalFetch = globalThis.fetch;
  const originalGet = db.kvGet;
  globalThis.fetch = fetch;
  db.kvGet = async (key, fallback) => key === 'relay' ? relay : fallback;
  t.after(() => { globalThis.fetch = originalFetch; db.kvGet = originalGet; });
}

test('同一档案下更换当轮人物和规则不会改前缀，更新档案则刷新', () => {
  const story = { rules:'故事规则', world:'固定世界', modules:{ weather:true },
    cards:[{ name:'阿白', core:true, initial:'固定身份' }, { name:'阿青', initial:'本轮提及' }] };
  const modules = [{ id:'weather', name:'风雨', mode:'keyword', keywords:'打雷', text:'用雷雨线索' }];
  const a = { id:'checkpoint-1', role:'assistant', kind:'play', text:'故事开始', checkpoint: { ...emptyMemory(), upTo:1, early:'旧档案原文' } };
  const ctx = text => buildContext(story, [a, { id:'turn', role:'user', kind:'play', text }], { modules });
  const one = ctx('前进');
  const two = ctx('打雷时找阿青');
  assert.equal(one.cachePrefix, two.cachePrefix);
  assert.ok(two.cachePrefix.indexOf('故事规则') < two.cachePrefix.indexOf('固定身份'));
  assert.ok(two.cachePrefix.indexOf('固定身份') < two.cachePrefix.indexOf('旧档案原文'));
  assert.ok(two.system.startsWith(two.cachePrefix));
  assert.ok(two.system.slice(two.cachePrefix.length).includes('用雷雨线索'));
  assert.ok(two.system.slice(two.cachePrefix.length).includes('本轮提及'));
  assert.equal(two.messages.at(-1).content.startsWith('打雷时找阿青'), true);
  a.checkpoint.early = '手动改好的前情';
  assert.notEqual(ctx('前进').cachePrefix, two.cachePrefix);
});

test('Claude 原生两轮发送同一个断点，缓存写入和随后命中采用接口真实用量', async t => {
  const bodies = [];
  mock(t, async (_, init) => {
    bodies.push(JSON.parse(init.body));
    const second = bodies.length === 2;
    return json({ content:[{type:'text',text:'正文'}], stop_reason:'end_turn',
      usage:{ input_tokens:200, cache_creation_input_tokens:second ? 0 : 4096, cache_read_input_tokens:second ? 4096 : 0, output_tokens:22 } });
  });
  const conn = { format:'anthropic', model:'claude-sonnet-4-6', apiKey:'test-key', promptCache:true, stream:false };
  const first = normalizeUsage((await streamChat(conn, opts())).usage);
  const next = normalizeUsage((await streamChat(conn, opts('现况二'))).usage);
  assert.deepEqual(bodies[0].system[0], { type:'text', text:fixed, cache_control:{type:'ephemeral'} });
  assert.deepEqual(bodies[0].system[0], bodies[1].system[0]);
  assert.equal(bodies[1].system[1].text, '现况二');
  assert.equal(first.written, 4096);
  assert.deepEqual([next.input, next.cached, next.written, next.cacheReported], [4296, 4096, 0, true]);
  assert.equal(computeCost(first,{priceIn:1,priceCacheWrite:2}).amount, 8392 / 1e6);
});

test('Vertex 直连创建短期缓存、两轮引用相同资源，固定和动态内容只发一次', async t => {
  const creation = [];
  const generates = [];
  mock(t, async (url, init) => {
    if (url.endsWith('/token')) return json({ access_token:'test-token', expires_in:3600 });
    const payload = JSON.parse(init.body);
    if (url.endsWith('/cachedContents')) { creation.push(payload); return json(cacheResponse()); }
    generates.push(payload);
    return json(openai(4096));
  });
  const events = [];
  const conn = vertex('direct');
  const run = suffix => streamChat(conn, { ...opts(suffix,'vertex-direct'), onCache:e=>events.push(e) });
  await run('现况一');
  const response = await run('现况二');
  assert.equal(creation.length, 1);
  assert.equal(creation[0].systemInstruction.parts[0].text, fixed);
  assert.equal(creation[0].ttl, '300s');
  assert.equal(events.filter(e=>e.created).length, 1);
  assert.equal(events.find(e=>e.created).created.tokens, 4096);
  for (const [i,b] of generates.entries()) {
    assert.equal(b.extra_body.google.cached_content, cacheName);
    assert.equal(b.messages[0].role, 'user');
    assert.ok(b.messages[0].content.startsWith(i ? '现况二' : '现况一'));
    assert.ok(!JSON.stringify(b).includes(fixed));
  }
  assert.equal(normalizeUsage(response.usage).cached, 4096);
});

test('Vertex 只支持隐式的模型跳过创建，显式引用被明确拒绝时恢复完整普通请求', async t => {
  const requests = [];
  mock(t, async (url, init) => {
    if (url.endsWith('/token')) return json({ access_token:'test-token', expires_in:3600 });
    const body = JSON.parse(init.body);
    requests.push(body);
    if (url.endsWith('/cachedContents')) return json(cacheResponse());
    if (body.extra_body) return json({error:{message:'cached_content does not exist'}}, 404);
    return json(openai());
  });
  await streamChat(vertex('implicit','gemini-3.8-flash'),opts('现况一','vertex-implicit'));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages[0].content.includes(fixed));
  await streamChat(vertex('missing'),opts('现况二','vertex-missing'));
  assert.equal(requests.length, 4);
  assert.ok(requests[2].extra_body.google.cached_content);
  assert.ok(requests[3].messages[0].content.includes(fixed));
  assert.ok(!requests[3].extra_body);
});

test('经转发的 Vertex 只登记正文任务，接回从同一任务读取而不重建缓存和模型请求', async t => {
  const relay = { on:true, url:'https://relay.example', token:'fixture-relay' };
  const starts = [];
  const subscriptions = [];
  mock(t, async (url, init) => {
    if (url.endsWith('/token')) return json({ access_token:'test-token', expires_in:3600 });
    assert.ok(url.startsWith(relay.url + '/jobs'));
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body);
      starts.push(payload);
      const id = payload.url.endsWith('/cachedContents') ? 'fixture-cache' : 'fixture-generation';
      return json({ id }, 201);
    }
    if (url.includes('/stream?')) {
      subscriptions.push(url);
      return new Response(JSON.stringify(url.includes('fixture-cache') ? cacheResponse() : openai(4096)), {
        headers:{ 'X-Upstream-Status':'200', 'X-Upstream-Content-Type':'application/json', 'X-Job-State':'done' },
      });
    }
    return json({ state:'done' });
  }, relay);
  const conn = vertex('relay','gemini-3.5-flash',true);
  const jobs = [];
  const one = await streamChat(conn,{...opts('现况','vertex-relay'),onJob:id=>jobs.push(id)});
  assert.equal(normalizeUsage(one.usage).cached, 4096);
  assert.deepEqual(jobs,['fixture-generation']);
  const resumed = await streamChat({ format:'vertex', stream:false },{...opts('现况','vertex-relay'),resumeJob:jobs[0],relayServer:relay.url});
  assert.equal(normalizeUsage(resumed.usage).cached, 4096);
  assert.equal(starts.length, 2);
  assert.equal(subscriptions.filter(url=>url.includes('fixture-cache')).length, 1);
  assert.equal(subscriptions.filter(url=>url.includes('fixture-generation')).length, 2);
});
