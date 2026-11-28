import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { db, exportAll, readMigrationDatabase } from '../js/db.js';
import { exportMigration, openMigration, restoreMigration } from '../js/migration.js';
import { parseMaterialPackage, parseTopicDocument, currentMaterial, MATERIAL_FORMAT, TOPIC_FORMAT } from '../js/deeptalk-materials.js';
import { buildDeepTalkContext } from '../js/deeptalk-context.js';
import { deepTalkMaterials, deepTalkMemory, generateDeepTalk, readDeepTalkThread, rememberDeepTalkTurn,
  restoreMaterialEdition, reviseDeepTalkMemory, saveDeepTalkMaterials, saveDeepTalkSettings, saveMaterialEdit,
  selectedReply, setTurnExcluded, deepTalkReplyTokens, getDeepTalkSpend, deepTalkSettings } from '../js/deeptalk.js';
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

test('聊天页显示用量和花费，普通入口和专题卡片都能导入资料包', async t => {
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
  await until(() => [...document.querySelectorAll('.deeptalk-sheet .deeptalk-list-item button')].filter(button => button.textContent === '查看全文与编辑').length === 3);
  const names = [...document.querySelectorAll('.deeptalk-sheet .deeptalk-list-title')].map(item => item.textContent);
  assert.deepEqual(names, ['核心名片', '长期档案', '敏感记忆', '健身与运动', '兰瓷×颜令']);
  findButton('查看全文与编辑').click();
  assert.equal(document.querySelector('[aria-label="核心名片全文"]').value, pack.documents[2].text);
  assert.doesNotMatch(document.querySelector('.deeptalk-feed').textContent, /^false/);

  const fitness = source('fitness', [['fitness-1', '训练记录🐾\r\n这次学会了新动作。', 'soft_recall']]);
  fitness.sections[0].hint = '聊学习新动作时';
  const shengweian = source('shengweian', [['story-1', '朋友组的故事原文。', 'soft_recall']]);
  shengweian.sections[0].hint = '提到朋友组时';
  const topicPack = { format: TOPIC_FORMAT, version: 1, offsetUnit: 'utf16', documents: [fitness, shengweian] };
  findButton('返回资料').click();
  (await until(() => findButton('导入专题'))).click();
  const topicPicker = document.querySelector('input[type="file"]');
  assert.ok(topicPicker.accept.split(',').includes('.json'));
  assert.ok(topicPicker.accept.split(',').includes('.md'));
  const topicFile = new File([JSON.stringify(topicPack)], '专题.JSON', { type: 'application/octet-stream' });
  Object.defineProperty(topicPicker, 'files', { value: [topicFile] });
  topicPicker.dispatchEvent(new dom.window.Event('change'));
  await until(() => [...document.querySelectorAll('.deeptalk-sheet .deeptalk-list-item button')].filter(button => button.textContent === '查看全文与编辑').length === 5);
  const materials = await deepTalkMaterials();
  for (const original of topicPack.documents) {
    assert.equal(materials[original.slot].original.text, original.text);
    assert.equal(materials[original.slot].original.sections[0].hint, original.sections[0].hint);
  }
});

test('专题原件和目录分别导入，按章节查看，旧资料与历史版本仍可读取', async () => {
  const exercise = '\uFEFF\\# 训练支持 🐾\r\n\r\n\\## 进步\r\n\r\n已经更快学会新动作。\r\n';
  const stories = '# 故事\n\n## 朋友\n原文记下了友情的变化。\n';
  const fitness = await parseTopicDocument('fitness', new File([exercise], '运动.md'));
  const shengweian = await parseTopicDocument('shengweian', new File([stories], '故事.md'));
  assert.equal(fitness.text, exercise);
  assert.equal(fitness.sha256, createHash('sha256').update(exercise).digest('hex'));
  assert.equal(fitness.text.slice(fitness.sections[1].start, fitness.sections[1].end), '\\## 进步\r\n\r\n已经更快学会新动作。\r\n');
  assert.equal(fitness.sections[1].hint, '进步');
  const document = { ...fitness, sections: fitness.sections.map(part => part.id === 'fitness-2' ? { ...part, hint: '聊动作学习时' } : part) };
  const parsed = await parseMaterialPackage(JSON.stringify({ format: TOPIC_FORMAT, version: 1, offsetUnit: 'utf16', documents: [document, shengweian] }));
  await saveDeepTalkMaterials({ fitness });
  await saveDeepTalkMaterials(parsed);
  const materials = await deepTalkMaterials();
  assert.equal(materials.fitness.original.text, exercise);
  assert.equal(materials.fitness.original.sections[1].hint, '聊动作学习时');
  assert.ok(materials.core_card);
  assert.ok(materials.sensitive_memory);
  const restored = await openMigration(await exportMigration('测试专题原文能通过加密迁移备份'), '测试专题原文能通过加密迁移备份');
  assert.equal(restored.stores.kv.find(([key]) => key === 'deeptalk.v1.materials')[1].fitness.original.text, exercise);
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

test('专题筛选只看短目录与普通发言，选一段并记账，失败时回到聊天', async t => {
  await db.kvSet('deeptalk.v1.thread', []);
  const fitness = await parseTopicDocument('fitness', new File(['# 能力变化\n\n测试健身原文：动作变熟练。'], '健身.md'));
  const storyText = '# 朋友组\n\n测试友情原文：和朋友有合作，也替对方上心。\n\n'
    + '朋友们都过着自己的生活。'.repeat(100) + '\n\n# 另一节\n测试完全不同的章节。';
  const shengweian = await parseTopicDocument('shengweian', new File([storyText], '故事.md'));
  await saveDeepTalkMaterials({ fitness, shengweian });
  await saveDeepTalkSettings({ connectionId: 'standard', memoryConnectionId: 'archivist', autoTopics: true });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const selecting = body.model === 'example-archivist';
    const input = body.messages.at(-1).content;
    const current = input.split('\n', 1)[0];
    if (selecting && current.includes('模拟筛选失败')) return new Response('service unavailable', { status: 503 });
    const choice = input.match(/^(\d+) 兰瓷×颜令／朋友组/m)?.[1];
    const content = selecting ? (current.includes('其实能真心') ? choice : '0') : '测试回复';
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } });
  });
  await generateDeepTalk({ text: '我想聊我和前任的经历' });
  assert.equal(calls.length, 1);
  const first = selectedReply(await generateDeepTalk({ text: '会计算朋友的合作价值，其实能真心待人吗？' }));
  const selector = calls.at(-2);
  const main = calls.at(-1);
  assert.equal(selector.model, 'example-archivist');
  assert.equal(main.model, 'openai/gpt-5.6-sol');
  assert.doesNotMatch(JSON.stringify(selector), /前任|测试友情原文|测试健身原文|测试名片/);
  assert.match(main.messages[0].content, /测试友情原文/);
  assert.doesNotMatch(main.messages[0].content, /测试健身原文|测试完全不同的章节/);
  assert.ok(main.messages[0].content.length < storyText.length);
  assert.deepEqual(first.refs.filter(ref => ref.topic).map(ref => [ref.key, ref.topic]), [['shengweian/shengweian-1', 'automatic']]);
  const none = selectedReply(await generateDeepTalk({ text: '我今天见了几位朋友。' }));
  assert.ok(!none.refs.some(ref => ref.topic));
  const failed = selectedReply(await generateDeepTalk({ text: '我想聊运动，模拟筛选失败。' }));
  assert.equal(failed.status, 'done');
  assert.ok(!failed.refs.some(ref => ref.topic));
  const before = calls.length;
  await generateDeepTalk({ text: '谢谢你！' });
  assert.equal(calls.length, before + 1);
  const spend = (await getDeepTalkSpend()).all;
  assert.equal(spend.byKind['专题联想'].count, 3);
  assert.equal(spend.byKind['专题联想'].total, 20);
  assert.ok(spend.requests.some(row => row.kind === '专题联想' && row.status === 503));
});

test('聊天和专题共用一个选段请求，跑团只引用有出处的当前分支原文', async t => {
  const canon = { id: 'canon', title: '圣维安正史测试', headId: 'canon-head', cards: [
    { name: '颜令', initial: '正史测试身份：白川会负责人。', relation: '和兰瓷合作调查灯塔误报。' },
    { name: '兰瓷', initial: '担任灯塔技术顾问，负责通行证。' },
    { name: '不在场角色', initial: '未参与本案。' },
  ] };
  const au = { id: 'au', title: '星际AU测试', headId: 'au-head', cards: [
    { name: '颜令', initial: '星际独有人设：舰队指挥。' }, { name: '兰瓷', initial: '星港调查员。' },
  ] };
  const marker = '灯塔误报以后，颜令把兰瓷的银色通行证压在桌上。';
  const longChapter = marker + '灯塔依然亮着，窗外海浪轻轻拍打石阶。'.repeat(36);
  await db.putMany('stories', [canon, au]);
  await db.putMany('nodes', [
    { id: canon.headId, storyId: canon.id, role: 'assistant', status: 'done', text: '# 灯塔误报\n\n' + longChapter },
    { id: 'side-branch', storyId: canon.id, role: 'assistant', status: 'done', text: '# 灯塔误报\n\n灯塔误报以后，颜令拿走兰瓷的银色通行证。分支专有内容。' },
    { id: au.headId, storyId: au.id, role: 'assistant', status: 'done', text: '# 灯塔误报\n\n' + marker + '星际分支专有内容。' },
  ]);
  await db.kvSet('deeptalk.v1.thread', []);
  const chat = '颜令在灯塔误报后当时说了什么？找银色通行证的章节原文。';
  const calls = [];
  let includeCards = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const directory = body.messages.at(-1).content;
    const selecting = body.model === 'example-archivist';
    const number = directory.match(/^(\d+) 跑团／/m)?.[1];
    const content = selecting ? (number ? number + (includeCards ? '+A+B' : '') : '0') : '测试聊天回复';
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });
  });
  const replyOf = async text => selectedReply(await generateDeepTalk({ text }));

  await saveDeepTalkSettings({ autoStoryRecall: false, autoTopics: true, storyRecallScope: 'all' });
  const disabled = await replyOf('圣维安正史测试 · ' + chat);
  assert.ok(!disabled.refs.some(ref => ref.story));
  assert.doesNotMatch(calls.at(-2).messages.at(-1).content, /跑团／/);

  await saveDeepTalkSettings({ autoStoryRecall: true });
  const beforeClarification = calls.length;
  const ambiguous = await replyOf(chat);
  assert.equal(calls.length - beforeClarification, 1);
  assert.match(calls.at(-1).messages[0].content, /跑团检索待确认/);
  assert.match(calls.at(-1).messages[0].content, /圣维安正史测试.*星际AU测试|星际AU测试.*圣维安正史测试/);
  assert.ok(!ambiguous.refs.some(ref => ref.story));

  await saveDeepTalkSettings({ storyRecallScope: 'selected', storyRecallIds: [canon.id] });
  const beforeShared = calls.length;
  const exact = await replyOf(chat);
  assert.equal(calls.length - beforeShared, 2);
  const directory = calls.at(-2).messages.at(-1).content;
  assert.match(directory, /跑团／圣维安正史测试／第1章/);
  assert.match(directory, /兰瓷×颜令／|健身与运动／/);
  assert.doesNotMatch(directory, /星际AU测试|桌上|分支专有内容/);
  const input = calls.at(-1).messages[0].content;
  const excerpt = JSON.parse(input.split('【跑团存档引文】\n')[1].split('\n', 1)[0]);
  assert.match(excerpt.出处, /圣维安正史测试.*第1章/);
  assert.ok(excerpt.原文.includes(marker));
  assert.ok(excerpt.原文.length > 460 && excerpt.原文.length <= 800);
  assert.ok(longChapter.includes(excerpt.原文));
  assert.deepEqual(exact.refs.filter(ref => ref.story).map(ref => ref.title), [excerpt.出处]);
  assert.equal(excerpt.角色梗概, undefined);

  includeCards = true;
  const backed = await replyOf('颜令和兰瓷各是什么身份？他们在灯塔误报后怎么处理银色通行证？找原文。');
  includeCards = false;
  const cardDirectory = calls.at(-2).messages.at(-1).content;
  assert.match(cardDirectory, /可附角色 [AB]=/);
  assert.doesNotMatch(cardDirectory, /白川会负责人|舰队指挥|不在场角色/);
  const bundled = JSON.parse(calls.at(-1).messages[0].content.split('【跑团存档引文】\n')[1].split('\n', 1)[0]);
  assert.deepEqual(bundled.角色梗概.map(card => card.角色).sort(), ['兰瓷', '颜令'].sort());
  assert.match(bundled.角色梗概.find(card => card.角色 === '颜令').梗概, /白川会负责人/);
  assert.ok(bundled.原文.includes(marker));
  assert.ok(JSON.stringify(bundled.原文).length - 2 + JSON.stringify({ 角色梗概: bundled.角色梗概 }).length <= 800);
  assert.deepEqual(backed.refs.find(ref => ref.story).characters.sort(), ['兰瓷', '颜令'].sort());

  await db.put('nodes', { id: canon.headId, storyId: canon.id, role: 'assistant', status: 'done',
    text: '# 灯塔误报\n\n灯塔误报以后，颜令将兰瓷的银色通行证收进保险柜。更新后的原文。' });
  await replyOf(chat);
  assert.match(calls.at(-1).messages[0].content, /更新后的原文/);
  assert.doesNotMatch(calls.at(-1).messages[0].content, /分支专有内容/);

  await db.updateStory(canon.id, story => ({ ...story, headId: 'side-branch' }));
  await replyOf(chat);
  assert.match(calls.at(-1).messages[0].content, /分支专有内容/);
  assert.doesNotMatch(calls.at(-1).messages[0].content, /更新后的原文|星际分支专有内容/);

  await saveDeepTalkSettings({ storyRecallScope: 'all', autoTopics: false });
  await replyOf('星际AU测试的第一章原文。');
  assert.match(calls.at(-1).messages[0].content, /星际分支专有内容/);
  assert.doesNotMatch(calls.at(-2).messages.at(-1).content, /兰瓷×颜令／|健身与运动／/);

  await saveDeepTalkSettings({ storyRecallScope: 'selected', storyRecallIds: [] });
  const beforeEmpty = calls.length;
  await replyOf(chat);
  assert.equal(calls.length - beforeEmpty, 1);
  const state = await deepTalkSettings();
  assert.equal(state.storyRecallScope, 'selected');
  assert.ok(!(await deepTalkMemory()).entries.some(entry => entry.text.includes('分支专有内容')));
});
