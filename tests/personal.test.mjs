import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildContext, formatContract } from '../js/prompt.js';
import { optionInput, expandOptionInput } from '../js/personal.js';

test('导入旧规则后仍按个人输入约定解释，保留故事规则，正文要求四选项', () => {
  const oldRule = '玩家输入里，“”内是台词，引号外是动作。';
  const ctx = buildContext({ rules: oldRule, danmu: false }, [{ role: 'user', kind: 'play', text: '（收好信）我跟你走。' }]);
  assert.ok(ctx.system.includes(oldRule));
  assert.ok(ctx.system.includes('括号外是主角说出口的台词，不需要加引号'));
  assert.ok(ctx.system.indexOf('【玩家输入约定】') > ctx.system.indexOf(oldRule));
  assert.ok(ctx.system.includes('D. ……'));
  assert.ok(ctx.messages[0].content.includes('A/B/C/D 四行'));
  assert.ok(!ctx.system.includes('【弹幕】'));
  assert.ok(!formatContract({ options: false }).includes('【选项】'));
});

test('选择行动不误作台词，已有括号保持原样', () => {
  assert.equal(optionInput('收好信'), '（收好信）');
  assert.equal(optionInput('（收好信）'), '（收好信）');
  assert.equal(optionInput('(收好信)'), '(收好信)');
});

test('选项字母在发送时展开全文，保留补充、改选、多选和自由输入', () => {
  const options = ['查看地图', '（留在原地）', '询问路人', '收好信'];
  assert.equal(expandOptionInput('A', options), '（查看地图）');
  assert.equal(expandOptionInput('A（把信收好）我跟你去。', options), '（查看地图）\n（把信收好）我跟你去。');
  assert.equal(expandOptionInput('B', options), '（留在原地）');
  assert.equal(expandOptionInput('AB（先看看）', options), '（查看地图）\n（留在原地）\n（先看看）');
  assert.equal(expandOptionInput('AA', options), '（查看地图）');
  assert.equal(expandOptionInput('d\n我跟你去。', options), '（收好信）\n我跟你去。');
  assert.equal(expandOptionInput('（只说自己的行动）', options), '（只说自己的行动）');
  assert.equal(expandOptionInput('Actually, wait.', options), 'Actually, wait.');
  assert.equal(expandOptionInput('D', options.slice(0, 3)), 'D');
  assert.equal(expandOptionInput('A', []), 'A');
  assert.equal(expandOptionInput('', options), '');
});

test('个人版升级只清理自己的旧缓存，离线查找不读取其他应用缓存', async () => {
  const handlers = {}, deleted = [], opened = [];
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    self: { addEventListener: (type, fn) => handlers[type] = fn, clients: { claim: async () => {} }, location: { origin: 'https://yl2c.github.io' } },
    caches: {
      keys: async () => ['moyu-v0.6.14', 'yl2c-cache', 'moyu-yl2c-personal-old', 'moyu-yl2c-personal-0.6.14-personal.1', 'moyu-yl2c-personal-0.6.14-personal.2', 'moyu-yl2c-personal-0.6.14-personal.3'],
      delete: async key => deleted.push(key),
      open: async key => { opened.push(key); return { match: async req => req === './index.html' ? 'personal-index' : undefined }; },
    },
    URL, fetch: async () => { throw new Error('offline'); }, setTimeout: () => {},
  });
  let finished;
  handlers.activate({ waitUntil: p => finished = p }); await finished;
  assert.deepEqual(deleted, ['moyu-yl2c-personal-old', 'moyu-yl2c-personal-0.6.14-personal.1', 'moyu-yl2c-personal-0.6.14-personal.2']);
  handlers.fetch({ request: { method: 'GET', url: 'https://yl2c.github.io/moyu/' }, respondWith: p => finished = p });
  assert.equal(await finished, 'personal-index');
  assert.deepEqual(opened, ['moyu-yl2c-personal-0.6.14-personal.3']);
});
