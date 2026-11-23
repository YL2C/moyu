import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildContext, formatContract } from '../js/prompt.js';
import { parseReply, replyForContext } from '../js/parse.js';
import { optionInput, expandOptionInput } from '../js/personal.js';
import { APP_VERSION } from '../js/util.js';

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

test('最近的旧回复没有昵称时，本轮仍明确要求每条弹幕带网名', () => {
  const ctx = buildContext({}, [
    { id: 'old', role: 'assistant', text: '# 开门\n\n你推开门。\n\n【弹幕】\n这也敢进去！' },
    { role: 'user', kind: 'continue' },
  ]);
  assert.match(ctx.system, /每条都用“网名｜弹幕内容”/);
  assert.match(ctx.messages.at(-1).content, /每条都写成“网名｜弹幕内容”/);
});

test('混合弹幕逐条显示清楚标记的网名，句内冒号原样保留', () => {
  const node = {
    text: '# 开门\n\n你推开门。\n\n【弹幕】\n- 灯笼放映室｜来了！\n【桥头第一排】：我等到了。\n我只想说: 门后还有人。\n回头看啊！\n\n【选项】\nA. 进门\nB. 等一会儿',
    optionEdits: { A: '直接进门' },
  };
  const expected = [
    { name: '灯笼放映室', text: '来了！' },
    { name: '桥头第一排', text: '我等到了。' },
    { name: '', text: '我只想说: 门后还有人。' },
    { name: '', text: '回头看啊！' },
  ];
  assert.deepEqual(parseReply(node.text).danmu, expected);
  const rebuilt = parseReply(replyForContext(node));
  assert.deepEqual(rebuilt.danmu, expected);
  assert.deepEqual(rebuilt.options, ['直接进门', '等一会儿']);
});

test('旧弹幕的冒号格式兼容，无昵称的旧弹幕保留原样', () => {
  assert.deepEqual(parseReply('【弹幕】\n夜灯：吓一跳。\n山风: 里面还有人。').danmu, [
    { name: '夜灯', text: '吓一跳。' },
    { name: '山风', text: '里面还有人。' },
  ]);
  assert.deepEqual(parseReply('【弹幕】\n吓一跳。\n里面还有人。').danmu, [
    { name: '', text: '吓一跳。' },
    { name: '', text: '里面还有人。' },
  ]);
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
      keys: async () => ['moyu-v0.6.14', 'yl2c-cache', 'moyu-yl2c-personal-old', 'moyu-yl2c-personal-0.6.14-personal.3', 'moyu-yl2c-personal-' + APP_VERSION],
      delete: async key => deleted.push(key),
      open: async key => { opened.push(key); return { match: async req => req === './index.html' ? 'personal-index' : undefined }; },
    },
    URL, fetch: async () => { throw new Error('offline'); }, setTimeout: () => {},
  });
  let finished;
  handlers.activate({ waitUntil: p => finished = p }); await finished;
  assert.deepEqual(deleted, ['moyu-yl2c-personal-old', 'moyu-yl2c-personal-0.6.14-personal.3']);
  handlers.fetch({ request: { method: 'GET', url: 'https://yl2c.github.io/moyu/' }, respondWith: p => finished = p });
  assert.equal(await finished, 'personal-index');
  assert.deepEqual(opened, ['moyu-yl2c-personal-' + APP_VERSION]);
});

test('安装新版逐个绕过 HTTP 缓存，资源全部就绪后才启用', async () => {
  const handlers = {}, requests = [];
  let activate = false;
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    self: {
      addEventListener: (type, fn) => handlers[type] = fn,
      location: { origin: 'https://yl2c.github.io', href: 'https://yl2c.github.io/moyu/sw.js' },
      skipWaiting: async () => { activate = true; },
    },
    caches: { open: async () => ({ addAll: async (assets) => {
      assert.equal(activate, false);
      requests.push(...assets);
    } }) },
    URL, Request,
  });
  let finished;
  handlers.install({ waitUntil: p => finished = p }); await finished;
  assert.ok(activate);
  assert.ok(requests.some(r => r.url === 'https://yl2c.github.io/moyu/css/app.css'));
  assert.ok(requests.some(r => r.url === 'https://yl2c.github.io/moyu/js/views/play.js'));
  assert.ok(requests.every(r => r.cache === 'reload'));
});

test('在线取文件必须重新核验服务器，离线可回退，第三方 API 不拦截', async () => {
  const handlers = {}, fetched = [], saved = [];
  const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    self: { addEventListener: (type, fn) => handlers[type] = fn, location: { origin: 'https://yl2c.github.io' } },
    caches: { open: async () => ({ put: async (req, res) => saved.push(await res.text()) }) },
    fetch: async (req, init) => { fetched.push({ url: req.url, cache: init.cache }); return new Response('新版右侧按钮'); },
    URL, setTimeout: () => {},
  });
  let finished;
  handlers.fetch({ request: { method: 'GET', url: 'https://yl2c.github.io/moyu/js/views/play.js' }, respondWith: p => finished = p });
  assert.equal(await (await finished).text(), '新版右侧按钮');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched[0].cache, 'no-cache');
  assert.deepEqual(saved, ['新版右侧按钮']);
  handlers.fetch({ request: { method: 'GET', url: 'https://api.example/v1/models' }, respondWith: () => assert.fail('不能拦截第三方 API') });
  assert.equal(fetched.length, 1);
});
