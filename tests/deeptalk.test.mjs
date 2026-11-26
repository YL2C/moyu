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
  selectedReply, setTurnExcluded } from '../js/deeptalk.js';
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
    { ...connection, id: 'flex', model: 'openai/gpt-5.6-sol:flex' },
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
      usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } });
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
  assert.equal((await readDeepTalkThread()).turns[1].replies.length, 2);
  assert.equal(await organizeDeepTalk({ automatic: true }), null);
  await generateDeepTalk({ text: '今天还买了好喝的茶' });
  await saveDeepTalkSettings({ memoryConnectionId: 'archivist' });
  assert.equal((await organizeDeepTalk()).added, 1);
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

test('聊天页的文件选择按钮导入三份资料，并能在界面打开全文', async t => {
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
    assert.fail('没有显示预期的导入界面');
  };
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
