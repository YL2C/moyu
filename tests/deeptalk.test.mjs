import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { db, exportAll, readMigrationDatabase } from '../js/db.js';
import { exportMigration, openMigration, restoreMigration } from '../js/migration.js';
import { parseMaterialPackage, currentMaterial, MATERIAL_FORMAT } from '../js/deeptalk-materials.js';
import { buildDeepTalkContext } from '../js/deeptalk-context.js';
import { deepTalkMaterials, deepTalkMemory, generateDeepTalk, readDeepTalkThread, rememberDeepTalkTurn,
  restoreMaterialEdition, reviseDeepTalkMemory, saveDeepTalkMaterials, saveDeepTalkSettings, saveMaterialEdit,
  selectedReply, setTurnExcluded, deepTalkReplyTokens, getDeepTalkSpend } from '../js/deeptalk.js';
import { organizeDeepTalk } from '../js/deeptalk-memory.js';

globalThis.indexedDB = new IDBFactory();

function source(slot, rows) {
  let text = '';
  const sections = rows.map(([id, excerpt, recall, topic]) => {
    const start = text.length;
    text += excerpt;
    const end = text.length;
    text += '\n\n';
    return { id, title: id, start, end, recall, topic };
  });
  return { slot, sourceName: '示例.md', text, sections, sha256: createHash('sha256').update(text).digest('hex') };
}

const pack = { format: MATERIAL_FORMAT, version: 1, offsetUnit: 'utf16', documents: [
  source('sensitive_memory', [
    ['REL-BRK-01', '示例关系的底稿。', 'explicit_topic', 'past_relationship'],
    ['REL-BRK-03', '测试用金钱片段，讨论过旅行预算。', 'explicit_topic', 'past_relationship'],
    ['REL-BRK-05', '测试用分手片段，当时有一个约定。', 'explicit_topic', 'past_relationship'],
    ['REL-BRK-08-family', '仅为测试的家庭片段。', 'explicit_topic', 'family_history'],
  ]),
  source('long_term_profile', [
    ['core-copy', '轻松聊，先听她说。🪶', 'view_only'],
    ['profile-past', '测试档案中的私密旧事。', 'explicit_topic', 'past_relationship'],
    ['fish', '这是只有同伴才懂的鱼的暗号。', 'on_topic', 'fish_joke'],
  ]),
  source('core_card', [
    ['tone', '轻松聊，先听她说。🪶', 'always'],
    ['core-past', '测试名片中的私密旧事。', 'explicit_topic', 'past_relationship'],
  ]),
] };

test('一个资料包按类型归位，字节不变，编辑与重导入保留版本', async () => {
  const documents = await parseMaterialPackage(JSON.stringify(pack));
  assert.equal(await saveDeepTalkMaterials(documents).then(result => result.changed), 3);
  const materials = await deepTalkMaterials();
  for (const original of pack.documents) assert.equal(materials[original.slot].original.text, original.text);
  const record = materials.core_card;
  await saveMaterialEdit('core_card', record.original.id, 'tone', '测试用的新语气。', true);
  assert.equal((await saveDeepTalkMaterials(documents)).changed, 0);
  const edited = (await deepTalkMaterials()).core_card;
  const current = currentMaterial(edited);
  const past = current.sections.find(item => item.id === 'core-past');
  assert.equal(current.text.slice(past.start, past.end), '测试名片中的私密旧事。');
  assert.equal(edited.original.text, record.original.text);
  await restoreMaterialEdition('core_card', edited.original.id);
  assert.equal(currentMaterial((await deepTalkMaterials()).core_card).text, record.original.text);
  const tampered = structuredClone(pack);
  tampered.documents[1].text += '损坏';
  await assert.rejects(parseMaterialPackage(JSON.stringify(tampered)), /校验失败/);
  const unsafe = structuredClone(pack);
  unsafe.documents[0].sections[0].recall = 'always';
  await assert.rejects(parseMaterialPackage(JSON.stringify(unsafe)), /调用范围/);
});

test('旧关系章节和敏感历史只在对应话题被召回', async () => {
  const materials = await deepTalkMaterials();
  const old = { text: '我和前任那段关系', sensitiveTopics: ['past_relationship'], selectedId: 'reply',
    replies: [{ id: 'reply', status: 'done', text: '测试版敏感历史回复' }] };
  const context = text => buildDeepTalkContext({ text, materials, turns: [old] });
  const normal = context('今天好开心，买了一条鱼');
  assert.doesNotMatch(normal.system, /测试用分手|私密旧事|家庭片段|鱼的暗号/);
  assert.equal(normal.messages.length, 1);
  assert.match(context('这么久了你还记得我的鱼吗').system, /鱼的暗号/);
  assert.doesNotMatch(context('我朋友的前任分手了').system, /测试用分手|私密旧事/);
  assert.doesNotMatch(context('今天不聊前任').system, /测试用分手|私密旧事/);
  const explicit = context('我和前任当初为什么分手？');
  assert.match(explicit.system, /测试用分手片段/);
  assert.doesNotMatch(explicit.system, /测试用金钱片段|家庭片段/);
  assert.equal(explicit.messages[1].content, old.replies[0].text);
  assert.ok(explicit.used.length <= 3);
  const following = context('那她为什么当时不愿意复合');
  assert.match(following.system, /测试用分手片段/);
  const manual = buildDeepTalkContext({ text: '说说这一条', materials, manualKeys: ['sensitive_memory/REL-BRK-08-family'] });
  assert.match(manual.system, /家庭片段/);
  assert.deepEqual(manual.activeSensitive, ['family_history']);
});

test('切换 Sol / Flex、单条深入和重写使用同一线程与各自参数', async t => {
  const connection = { format: 'openai', stream: false, mt8000: true, temperature: 0.7,
    apiKey: 'fictional-key', baseUrl: 'https://api.example.test/v1' };
  await db.putMany('connections', [
    { ...connection, id: 'standard', model: 'openai/gpt-5.6-sol' },
    { ...connection, id: 'flex', model: 'openai/gpt-5.6-sol:flex', currency: 'USD', priceIn: 2, priceOut: 10, priceCache: 0.2 },
    { ...connection, id: 'archivist', model: 'example-archivist' },
  ]);
  const requestBodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    const archive = body.model === 'example-archivist';
    const input = archive && JSON.parse(body.messages.at(-1).content)[0];
    const content = archive ? JSON.stringify({ snapshot: [{ category: '近期近况', turnId: input.turnId, quote: input.text }],
      memories: [{ turnId: input.turnId, quote: input.text }, { turnId: input.turnId, quote: '测试模型编造的内容' }] }) : '<think>hidden</think>测试回复';
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 },
        ...(body.model.endsWith(':flex') ? { prompt_tokens_details: { cached_tokens: 4 } } : {}),
        ...(body.model === 'openai/gpt-5.6-sol' ? { total_tokens: 18 } : {}) } });
  });
  await saveDeepTalkSettings({ connectionId: 'standard' });
  const first = await generateDeepTalk({ text: '测试中我学会了一道新菜' });
  await saveDeepTalkSettings({ connectionId: 'flex', efforts: { flex: 'low' } });
  const second = await generateDeepTalk({ text: '这道菜还想再试一次', deeper: true });
  await generateDeepTalk({ turnId: second.id });
  assert.equal(requestBodies[0].model, 'openai/gpt-5.6-sol');
  assert.equal(requestBodies[0].reasoning_effort, 'medium');
  assert.equal(requestBodies[1].model, 'openai/gpt-5.6-sol:flex');
  assert.equal(requestBodies[1].reasoning_effort, 'high');
  assert.equal(requestBodies[2].reasoning_effort, 'low');
  assert.equal(requestBodies[1].temperature, undefined);
  assert.equal(requestBodies[1].messages[1].content, first.text);
  assert.doesNotMatch(selectedReply(first).text, /hidden/);
  assert.deepEqual(deepTalkReplyTokens(selectedReply(first)), { total: 18, estimated: false });
  assert.deepEqual(deepTalkReplyTokens(selectedReply(second)), { total: 14, estimated: false });
  assert.equal((await readDeepTalkThread()).turns[1].replies.length, 2);
  assert.equal(await organizeDeepTalk({ automatic: true }), null);
  await generateDeepTalk({ text: '今天还买了好喝的茶' });
  await saveDeepTalkSettings({ memoryConnectionId: 'archivist' });
  assert.equal((await organizeDeepTalk()).added, 1);
  const spend = (await getDeepTalkSpend()).all;
  assert.equal(spend.total.total, 74);
  assert.equal(spend.total.cached, 12);
  assert.equal(spend.total.cacheCount, 3);
  assert.ok(Math.abs(spend.total.costs.USD - 0.0001584) < 1e-12);
  assert.equal(spend.byKind['重写 / 重试'].count, 1);
  assert.equal(spend.byKind['整理记忆'].count, 1);
  assert.ok(spend.requests.some(row => row.kind === '重写回复' && row.posts === 1));
  assert.equal(requestBodies.at(-1).model, 'example-archivist');
  assert.doesNotMatch(JSON.stringify(requestBodies.at(-1)), /轻松聊|私密旧事|测试用分手片段/);
  const memory = await deepTalkMemory();
  assert.equal(memory.entries[0].status, 'candidate');
  await rememberDeepTalkTurn(second);
  await setTurnExcluded(second.id, true);
  const after = await deepTalkMemory();
  assert.equal(after.entries.find(item => item.turnId === second.id).excludedSource, true);
  await reviseDeepTalkMemory(memory.entries[0].id, { status: 'deleted' });
  assert.equal((await deepTalkMemory()).snapshot.length, 0);
  const plain = JSON.stringify(await exportAll());
  assert.doesNotMatch(plain, /deeptalk\.v1|测试档案中的私密旧事|学会了一道新菜/);
  const full = await readMigrationDatabase();
  assert.ok(full.kv.some(([key]) => key === 'deeptalk.v1.materials'));
  assert.ok(full.kv.some(([key]) => key === 'deeptalk.v1.thread'));
  assert.ok(full.kv.some(([key]) => key === 'deeptalk.v1.memoryUsage'));
});

test('加密迁移保存资料、聊天和设置，迁入后清除旧入口的转发任务号', async () => {
  const before = (await readDeepTalkThread()).turns.at(-1);
  const withJob = { ...before, replies: before.replies.map(reply => ({ ...reply, status: 'running', relayJob: 'example-task' })) };
  await db.kvSet('deeptalk.v1.turn.' + before.id, withJob);
  const password = '这是墨游日常聊天的测试迁移用密码';
  const file = await exportMigration(password);
  const saved = await openMigration(file, password);
  assert.ok(saved.stores.kv.some(([key, value]) => key === 'deeptalk.v1.settings' && value.connectionId === 'flex'));
  await restoreMigration(saved);
  const restored = (await readDeepTalkThread()).turns.at(-1);
  assert.equal(restored.text, before.text);
  assert.equal(selectedReply(restored).relayJob, undefined);
  assert.equal(selectedReply(restored).status, 'partial');
  assert.equal((await deepTalkMaterials()).sensitive_memory.original.text, pack.documents[0].text);
});

test('聊天页显示每轮用量和花费面板，资料包导入后可打开全文', async t => {
  const dom = new JSDOM('<main id="root"></main><div id="toast"></div>', { url: 'https://moyu.example.test/#/chat', pretendToBeVisual: true });
  const bindings = { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window) };
  const descriptors = new Map(Object.keys(bindings).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(bindings)) Object.defineProperty(globalThis, name, { value, configurable: true });
  t.after(() => {
    dom.window.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  await db.kvSet('deeptalk.v1.materials', {});
  const first = (await readDeepTalkThread()).turns[0];
  const now = new Date();
  const lastMonth = +new Date(now.getFullYear(), now.getMonth(), 0, 12);
  await db.kvSet(`deeptalk.v1.turn.${first.id}`, { ...first, at: lastMonth,
    replies: first.replies.map(reply => ({ ...reply, at: lastMonth })) });
  const { render } = await import('../js/views/deeptalk.js');
  const close = await render(document.querySelector('#root'));
  t.after(close);
  const findButton = label => [...document.querySelectorAll('button')].find(button => button.textContent === label);
  const until = async check => {
    for (let i = 0; i < 100; ++i) {
      const result = check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('没有显示预期的聊天界面');
  };
  assert.equal(document.querySelector('.deeptalk-turn-tokens').textContent, '本轮 18 Token');
  findButton('花费').click();
  const panel = await until(() => document.querySelector('.deeptalk-spend'));
  const periods = await until(() => panel.querySelector('.deeptalk-spend-periods:not([hidden])'));
  const periodButtons = periods.querySelectorAll('button');
  assert.deepEqual([...periodButtons].map(button => button.firstElementChild.textContent), ['今天', '本月', '累计']);
  assert.equal(periodButtons[2].lastElementChild.textContent, '74 Token');
  assert.equal(periodButtons[2].getAttribute('aria-pressed'), 'true');
  assert.match(panel.textContent, /整理记忆 × 1/);
  assert.match(panel.textContent, /缓存命中 12/);
  assert.match(panel.textContent, /最近操作的请求次数/);
  assert.match(panel.querySelector('.deeptalk-spend-amount').textContent, /^约 \$/);
  periodButtons[0].click();
  assert.equal(periodButtons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(periodButtons[0].lastElementChild.textContent, '56 Token');
  assert.match(panel.textContent, /共 4 次调用/);
  panel.querySelector('.sf .primary').click();
  findButton('资料与记忆').click();
  (await until(() => findButton('导入资料包'))).click();
  const picker = document.querySelector('input[type="file"]');
  const file = new File([JSON.stringify(pack)], '虚构资料.json', { type: 'application/json' });
  Object.defineProperty(picker, 'files', { value: [file] });
  picker.dispatchEvent(new dom.window.Event('change'));
  await until(() => document.querySelectorAll('.deeptalk-sheet .deeptalk-list-item > button').length === 3);
  const names = [...document.querySelectorAll('.deeptalk-sheet .deeptalk-list-title')].map(item => item.textContent);
  assert.deepEqual(names, ['核心名片', '长期档案', '敏感记忆']);
  findButton('查看全文与编辑').click();
  assert.equal(document.querySelector('[aria-label="核心名片全文"]').value, pack.documents[2].text);
  assert.doesNotMatch(document.querySelector('.deeptalk-feed').textContent, /^false/);
});

test('有回传的失败请求可统计；完成但缺少回传时显示估算', async t => {
  const responses = [
    { choices: [{ message: { content: '' } }], usage: { total_tokens: 27 } },
    { choices: [{ message: { content: '' } }], usage: { total_tokens: 30, prompt_tokens: 27, completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 } } },
    { choices: [{ message: { content: '测试回复' } }] },
  ];
  t.mock.method(globalThis, 'fetch', async () => Response.json(responses.shift()));
  const turn = await generateDeepTalk({ text: '模拟有用量的空回复' });
  const failed = selectedReply(turn);
  assert.equal(failed.status, 'error');
  assert.deepEqual(deepTalkReplyTokens(failed), { total: 27, estimated: false });
  const retry = selectedReply(await generateDeepTalk({ turnId: turn.id }));
  assert.equal(retry.usage.input, 27);
  assert.equal(retry.usage.output, 3);
  assert.equal(retry.usage.cacheReported, true);
  assert.equal(retry.usage.cached, 0);
  assert.ok((await getDeepTalkSpend()).all.requests.some(row => row.kind === '重试回复' && row.posts === 1));
  const completed = selectedReply(await generateDeepTalk({ text: '模拟无用量的正常回复' }));
  assert.equal(completed.status, 'done');
  assert.ok(deepTalkReplyTokens(completed).estimated);
  assert.ok(deepTalkReplyTokens(completed).total > completed.text.length);
});

test('按回复时间和设备日期计算今天、本月、累计，早期记录和重写不会漏算', async () => {
  const today = +new Date(2026, 10, 26);
  const thisMonth = +new Date(2026, 10, 2, 15);
  const lastMonth = +new Date(2026, 9, 31, 23, 59);
  const fixture = Array.from({ length: 305 }, (_, i) => ({ id: `earlier-${i}`, at: lastMonth,
    replies: [{ status: 'done', usage: { input: 2, output: 1 } }] }));
  fixture.push(
    { id: 'a', at: lastMonth, selectedId: 'new', replies: [
      { id: 'old', at: lastMonth, status: 'done', usage: { input: 100, output: 20 } },
      { id: 'new', at: today, status: 'done', usage: { input: 60, output: 40, est: true } },
    ] },
    { id: 'b', at: thisMonth, replies: [{ status: 'done', usage: { total: 200, input: 80, output: 5, est: true } }] },
    { id: 'c', at: today + 60_000, replies: [{ status: 'stopped' }] },
  );
  await Promise.all(fixture.map(turn => db.kvSet(`deeptalk.v1.turn.${turn.id}`, turn)));
  await db.kvSet('deeptalk.v1.thread', fixture.map(turn => turn.id));
  await db.kvSet('deeptalk.v1.memoryUsage', null);
  await db.kvSet('usageLog', [
    { kind: '日常记忆整理', at: today, input: 100_000, output: 500 },
    { kind: '整理前情', at: today, storyId: 'story-test', input: 9_999, output: 50 },
  ]);
  await db.kvSet('requestLog', [
    { kind: '正文', at: today, storyId: 'story-test', posts: 1, outcome: 'ok' },
    { kind: '日常聊天', at: lastMonth, posts: 1, outcome: 'ok' },
    { kind: '日常聊天', at: today, posts: 1, outcome: 'ratelimit', status: 429 },
  ]);
  const now = today + 12 * 3600_000;
  const spend = await getDeepTalkSpend(now);
  assert.deepEqual([spend.today.total.total, spend.month.total.total, spend.all.total.total], [100600, 100800, 101835]);
  assert.deepEqual([spend.today.total.count, spend.month.total.count, spend.all.total.count], [3, 4, 310]);
  assert.equal(spend.today.total.counted, 2);
  assert.equal(spend.today.total.estimated, true);
  assert.equal(spend.all.byKind['重写 / 重试'].total, 100);
  assert.equal(spend.all.byKind['整理记忆'].total, 100500);
  assert.deepEqual(spend.today.requests.map(row => row.status), [429]);
  assert.equal(spend.all.requests.length, 2);
  await db.kvSet('usageLog', []);
  assert.equal((await getDeepTalkSpend(now)).all.total.total, 101835);
});
