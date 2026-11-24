import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';

globalThis.indexedDB = new IDBFactory();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem(key) { return this[key] ?? null; },
    setItem(key, value) { this[key] = String(value); },
    removeItem(key) { delete this[key]; },
  },
});
for (const method of ['getItem', 'setItem', 'removeItem']) {
  Object.defineProperty(localStorage, method, { enumerable: false });
}

const { db, exportAll, readMigrationDatabase, replaceMigrationDatabase } = await import('../js/db.js');
const { exportMigration, openMigration, restoreMigration } = await import('../js/migration.js');
const { CURRENT_STORY_KEY } = await import('../js/personal.js');
const password = '迁移测试密码-2026-墨游';
const template = { id: 'api-1', name: '正文', model: 'fixture-model',
  baseUrl: 'https://api.example.test', apiKey: 'fictional-api-secret-for-test' };
const vertex = { id: 'api-2', format: 'vertex', apiKey: '{"private_key":"fictional-vertex-for-test"}' };
const relay = { on: true, token: 'fictional-relay-for-test', url: 'https://relay.example.test' };
const font = new File([new Uint8Array([0, 1, 200, 255])], '测试字体.woff2', { lastModified: 1234, type: 'font/woff2' });
const base = {
  kv: [
    ['relay', relay], ['defaultConn', template.id], ['extraConnectionId', vertex.id],
    ['prefs', { theme: 'patent', patentFont: 'local-font-test' }],
    ['readingFonts', [{ id: 'local-font-test', name: '测试字体' }]], ['local-font-test', font],
    ['modules', [{ id: 'module', name: '模块' }]], ['packs', [{ id: 'pack' }]], ['budget', { amount: 500 }],
    ['disc.index', [{ id: 'discussion', title: '讨论' }]],
    ['disc.discussion', { id: 'discussion', connId: vertex.id, messages: [
      { role: 'user', content: '这里有一份附件', attachments: [{ original: 'AAHI/w==' }] },
      { role: 'assistant', content: '讨论正文' },
    ] }],
  ],
  stories: [{ id: 'story', connectionId: template.id, title: '旧故事', headId: 'branch' }],
  nodes: [{ id: 'branch', storyId: 'story', role: 'assistant', text: '分支正文', checkpoint: { mem: '前情' } }],
  connections: [template, vertex],
  extras: [{ id: 'extra', storyId: 'story', connectionId: vertex.id, versions: [{ text: '番外' }] }],
};
const empty = { kv: [], stories: [], nodes: [], extras: [], connections: [] };

test('迁移包可恢复 API、转发、档案、讨论附件和本地阅读字体，普通备份仍去密钥', async () => {
  await replaceMigrationDatabase(base);
  localStorage.setItem(CURRENT_STORY_KEY, 'story');
  localStorage.setItem('unrelated-website-data', 'source');
  const blob = await exportMigration(password);
  const second = await exportMigration(password);
  assert.notDeepEqual(await blob.slice(0, 60).arrayBuffer(), await second.slice(0, 60).arrayBuffer());
  const bytes = await blob.text();
  for (const clear of [template.apiKey, vertex.apiKey, relay.token, '分支正文']) {
    assert.equal(bytes.includes(clear), false);
  }
  const regular = await exportAll();
  assert.ok(regular.connections.every(connection => !connection.apiKey));
  assert.equal(regular.relay, undefined);

  await replaceMigrationDatabase({ ...empty, stories: [{ id: 'target', title: '目的地' }] });
  localStorage.setItem(CURRENT_STORY_KEY, 'target');
  localStorage.setItem('unrelated-website-data', 'target');
  await assert.rejects(openMigration(blob, '错误密码'), /密码不正确/);
  const tampered = new Uint8Array(await blob.arrayBuffer());
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(openMigration(new Blob([tampered]), password), /已损坏/);
  await assert.rejects(openMigration(new Blob(['{}']), password), /完整迁移包/);
  assert.equal((await db.get('stories', 'target')).title, '目的地');

  const snapshot = await openMigration(blob, password);
  assert.ok(await restoreMigration(snapshot));
  assert.ok(await restoreMigration(snapshot));
  assert.deepEqual(await db.all('stories'), base.stories);
  assert.deepEqual(await db.all('nodes'), base.nodes);
  assert.deepEqual(await db.all('extras'), base.extras);
  assert.deepEqual(await db.all('connections'), base.connections);
  assert.deepEqual(await db.kvGet('relay'), relay);
  assert.equal(await db.kvGet('defaultConn'), template.id);
  assert.equal(await db.kvGet('extraConnectionId'), vertex.id);
  assert.equal((await db.kvGet('disc.discussion')).messages[0].attachments[0].original, 'AAHI/w==');
  const restoredFont = await db.kvGet('local-font-test');
  assert.equal(restoredFont.type, font.type);
  assert.deepEqual(await restoredFont.arrayBuffer(), await font.arrayBuffer());
  assert.equal(localStorage.getItem(CURRENT_STORY_KEY), 'story');
  assert.equal(localStorage.getItem('unrelated-website-data'), 'target');
});

test('迁移写入失败时回滚所有表，已有故事和连接保持可读', async () => {
  await replaceMigrationDatabase(base);
  const original = await readMigrationDatabase();
  await assert.rejects(replaceMigrationDatabase({
    ...empty, stories: [{ id: 'duplicate' }, { id: 'duplicate' }], connections: [{ id: 'temporary' }],
  }), { name: 'ConstraintError' });
  assert.deepEqual(await readMigrationDatabase(), original);
});

test('迁移保留已写出的内容与完成的草稿，旧入口的后台任务不在新入口自动运行', async () => {
  const data = {
    ...empty,
    nodes: [{ id: 'a', text: '前半章', status: 'streaming', relayJob: 'job', relayContext: { server: relay.url } }],
    extras: [{ id: 'pending-extra', pending: true, versions: [] }],
    kv: [
      ['background.discussion.test.reply.1', { state: 'pending', job: 'old', server: relay.url, text: '已收到的回复' }],
      ['background.discussion.test.story', { state: 'done', text: '可用的草稿' }],
      ['disc.test', { id: 'test', messages: [{ role: 'assistant', content: '', taskId: '1', streaming: true }] }],
    ],
  };
  await replaceMigrationDatabase(data);
  await restoreMigration(await openMigration(await exportMigration(password), password));
  const node = await db.get('nodes', 'a');
  assert.equal(node.text, '前半章');
  assert.equal(node.status, 'partial');
  assert.equal(node.relayJob, undefined);
  assert.equal((await db.get('extras', 'pending-extra')).pending, undefined);
  const task = await db.kvGet('background.discussion.test.reply.1');
  assert.equal(task.state, 'error');
  assert.equal(task.job, undefined);
  assert.equal((await db.kvGet('background.discussion.test.story')).state, 'done');
  const [message] = (await db.kvGet('disc.test')).messages;
  assert.equal(message.content, '已收到的回复');
  assert.equal(message.taskId, undefined);
});
