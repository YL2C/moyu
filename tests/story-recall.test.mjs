import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryRecall, runStoryRecall, selectStoryExcerpts } from '../js/story-recall.js';
import { db } from '../js/db.js';

const chest = '伊莱恩收下了银色胸针，答应代你保管到冬至。';
const story = { id: 'story', recallEnabled: true, cards: [{ name: '伊莱恩' }] };
const context = { system: '遵守当前设定。', messages: [{ role: 'assistant', content: '伊莱恩回到了大厅。' }], info: { parts: [] } };
const path = [
  { role: 'assistant', status: 'done', text: '# 信物\n' + chest + '\n\n【选项】\nA. 银色胸针被扔进了河里。\nB. 离开' },
  { role: 'assistant', kind: 'ooc', text: '场外提案：伊莱恩把银色胸针退还。' },
  { role: 'assistant', status: 'partial', text: '伊莱恩意外弄丢了银色胸针。' },
  { role: 'user', text: '我问伊莱恩银色胸针还在不在。' },
];
const answer = quote => JSON.stringify([{ id: 1, quote }]);

test('只从传入的当前分支取已完成的正文，过滤场外内容、选项和半章', () => {
  const selection = buildStoryRecall(story, path, context);
  assert.deepEqual(selection.choices, [{ id: 1, chapter: 1, text: chest }]);
  assert.equal(buildStoryRecall({ ...story, recallEnabled: false }, path, context), null);
  assert.equal(buildStoryRecall(story, path.slice(1), context), null);
  assert.equal(buildStoryRecall(story, [...path.slice(0, -1), { role: 'user', kind: 'ooc', text: path.at(-1).text }], context), null);
  assert.equal(buildStoryRecall(story, [...path.slice(0, -1), { role: 'user', text: '继续' }], context), null);
  assert.equal(buildStoryRecall(story, path, { ...context, messages: [{ role: 'assistant', content: chest }] }), null);
});

test('只接受逐字匹配的引文，去掉重复并限制整个补充段落的大小', () => {
  const selection = buildStoryRecall(story, path, context);
  assert.match(selectStoryExcerpts(answer(chest), selection), /银色胸针/);
  assert.equal(selectStoryExcerpts(answer('伊莱恩把胸针丢进河里了。'), selection), '');
  assert.equal(selectStoryExcerpts(answer(chest), { ...selection, visible: ['伊莱恩收下了银色胸针答应代你保管到冬至'] }), '');
  assert.equal(selectStoryExcerpts('想另外加一句', selection), '');
  const oversized = '过长的剧情内容不会被逐字硬切。'.repeat(60);
  assert.equal(selectStoryExcerpts(answer(oversized), { choices: [{ id: 1, chapter: 1, text: oversized }], visible: [] }), '');
  const text = '伊莱恩收下的胸针在冬至才会交还。'.repeat(7);
  const block = selectStoryExcerpts(JSON.stringify([1, 2, 3].map(id => ({ id, quote: text }))),
    { choices: [1, 2, 3].map(id => ({ id, chapter: id, text })), visible: [] });
  assert.ok(block);
  assert.ok(new TextEncoder().encode('\n\n' + block).length <= 760);
});

test('启用后至多选一次，关闭不发请求，请求失败或取消时可以照常续写', async t => {
  t.mock.method(db, 'kvGet', async (_key, fallback) => fallback);
  t.mock.method(db, 'kvUpdate', async () => null);
  let requests = 0;
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    requests++;
    assert.equal(JSON.parse(init.body).model, 'helper');
    if (fail) return new Response('server busy', { status: 503 });
    return Response.json({ choices: [{ message: { content: answer(chest) }, finish_reason: 'stop' }] });
  });
  const args = { story, path, context, conn: { apiKey: 'fixture', model: 'helper', baseUrl: 'https://example.test/v1' } };
  assert.equal(await runStoryRecall({ ...args, story: { ...story, recallEnabled: false } }), '');
  assert.equal(requests, 0);
  assert.match(await runStoryRecall(args), /胸针/);
  assert.equal(requests, 1);
  fail = true;
  assert.equal(await runStoryRecall(args), '');
  assert.equal(requests, 2);
  assert.equal(await runStoryRecall({ ...args, signal: AbortSignal.abort() }), '');
  assert.equal(requests, 2);
  assert.equal(context.system, '遵守当前设定。');
});
