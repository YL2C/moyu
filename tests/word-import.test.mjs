import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { indexedDB } from 'fake-indexeddb';
import { db } from '../js/db.js';
import { readWordPreset, splitWordPreset, wordImportMarkdown } from '../js/preset-docx.js';
import { importMarkdownPack, deleteModules, undoModuleDelete, undoWordImport } from '../js/rules.js';
import { getModules, modulesFromMarkdown } from '../js/state.js';
import { buildContext } from '../js/prompt.js';
import { showWordImport } from '../js/views/word-import.js';
import { render as renderSettings } from '../js/views/settings.js';

const { window } = new JSDOM('<body></body>', { url: 'https://qa.example/moyu/' });
for (const key of ['window', 'document', 'Node', 'Event', 'CustomEvent', 'DOMParser', 'localStorage']) globalThis[key] = window[key];
globalThis.indexedDB = indexedDB;
const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const xml = (tag, content) => `<w:${tag} xmlns:w="${ns}">${content}</w:${tag}>`;
const encode = str => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const run = text => `<w:r><w:t xml:space="preserve">${encode(text)}</w:t></w:r>`;
const p = (text, props = '') => `<w:p>${props ? '<w:pPr>' + props + '</w:pPr>' : ''}${run(text)}</w:p>`;

function docx(body, other = {}) {
  const entries = { 'word/document.xml': xml('document', '<w:body>' + body + '</w:body>'), ...other };
  const files = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const filename = Buffer.from(name);
    const raw = Buffer.from(value);
    const zip = deflateRawSync(raw);
    const local = Buffer.alloc(30), header = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); header.writeUInt32LE(0x02014b50);
    local.writeUInt16LE(20, 4); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    local.writeUInt16LE(8, 8); header.writeUInt16LE(8, 10);
    local.writeUInt32LE(crc32(raw), 14); header.writeUInt32LE(crc32(raw), 16);
    local.writeUInt32LE(zip.length, 18); header.writeUInt32LE(zip.length, 20);
    local.writeUInt32LE(raw.length, 22); header.writeUInt32LE(raw.length, 24);
    local.writeUInt16LE(filename.length, 26); header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(offset, 42);
    offset += local.length + filename.length + zip.length;
    files.push(local, filename, zip);
    central.push(header, filename);
  }
  const entriesCount = Object.keys(entries).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entriesCount, 8); end.writeUInt16LE(entriesCount, 10);
  end.writeUInt32LE(central.reduce((n, bytes) => n + bytes.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return new File([...files, ...central, end], '样本.docx');
}

function decode(rows) { return modulesFromMarkdown(wordImportMarkdown(rows), '', { verbatim: true }); }

test('设置的同一个文件按钮按格式导入 Word、Markdown 和两种 JSON 规则', async (t) => {
  const root = document.body.appendChild(document.createElement('main'));
  const toast = document.body.appendChild(document.createElement('div'));
  toast.id = 'toast';
  globalThis.confirm = () => true;
  t.after(() => { root.remove(); toast.remove(); delete globalThis.confirm; });
  await renderSettings(root, {});
  const button = (label, parent = root) => [...parent.querySelectorAll('button')].find(b => b.textContent === label);
  const waitFor = async (check) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('导入界面未刷新');
  };
  const choose = (file) => {
    button('导入文件').click();
    const picker = document.querySelector('input[type=file][accept*=".docx"]');
    assert.ok(picker);
    assert.match(picker.accept, /\.docx,\.md,\.markdown,\.txt,\.json/);
    Object.defineProperty(picker, 'files', { value: [file] });
    picker.dispatchEvent(new Event('change'));
  };
  assert.equal(root.querySelector('#sec-modules')?.textContent.includes('规则模块'), true);
  assert.equal(button('导入 Word（.docx）'), undefined);
  assert.ok(button('导入酒馆文件'));

  choose(new File(['## 测试 Markdown\n这是规则。'], '规则.MD'));
  await waitFor(() => root.textContent.includes('规则') && toast.textContent.includes('已导入 1 个模块') && button('导入文件'));
  assert.ok((await getModules()).some(m => m.name === '测试 Markdown'));

  choose(new File([JSON.stringify({ name: 'JSON 规则组', modules: [{ name: '测试 JSON', text: '正文\n## 保留小标题' }] })], '规则.JSON'));
  await waitFor(() => root.textContent.includes('JSON 规则组'));
  assert.equal((await getModules()).find(m => m.name === '测试 JSON').text, '正文\n## 保留小标题');

  choose(new File([JSON.stringify({ name: '酒馆预设样本', prompts: [{ identifier: 'main', name: '酒馆条目', content: '酒馆规则', enabled: false }] })], '酒馆.json'));
  await waitFor(() => root.textContent.includes('酒馆预设样本'));
  assert.equal((await getModules()).find(m => m.name === '酒馆条目').defaultOn, false);
  button('好', document).click();

  const count = (await getModules()).length;
  choose(new File(['{broken'], '坏掉的.json'));
  await waitFor(() => toast.textContent.includes('不是有效的 JSON'));
  assert.equal((await getModules()).length, count);

  choose(docx(p('Word 正文')));
  await waitFor(() => !!button('确认导入', document));
  button('确认导入', document).click();
  await waitFor(() => !!button('撤销上次 Word 导入'));
  assert.ok((await getModules()).some(m => m.text === 'Word 正文'));
  assert.equal(await undoWordImport(), true);
});

test('标题样式优先、标题 1 取组名，且标题 2 之前是第 0 条', async () => {
  const styles = xml('styles', '<w:style w:styleId="CustomTwo"><w:basedOn w:val="Heading2"/></w:style>' +
    '<w:style w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>');
  const doc = await readWordPreset(docx(p('组名', '<w:pStyle w:val="Heading1"/>') + p('开头说明……') +
    p('标题', '<w:pStyle w:val="CustomTwo"/>') + p('  ## 正文里的小标题——  ') +
    p('## 正文的小标题') + p('<原样>') + p('空白条目', '<w:pStyle w:val="Heading2"/>'), { 'word/styles.xml': styles }));
  const result = splitWordPreset(doc);
  assert.equal(result.group, '组名');
  assert.equal(result.audit.reconstruction, result.audit.source);
  assert.deepEqual(decode(result.rows), [
    { name:'0. 使用说明', text:'开头说明……' },
    { name:'1. 标题', text:'  ## 正文里的小标题——  \n\n## 正文的小标题\n\n<原样>' },
    { name:'2. 空白条目', text:'' },
  ]);
});

test('XML 包裹、属性、嵌套和使用说明，包含段内换行', async () => {
  const doc = await readWordPreset(docx([
    p('<writing_style>'), p('[样本]'), p('<usage>'), p('看说明'), p('</usage>'),
    '<w:p>' + run('<核心 key="a > b">') + '<w:r><w:br/></w:r>' + run('<nested>') + '</w:p>',
    p('中文标点…… ——'), p('<break />'), p('</nested>'), p('</核心>'), p('<end>'), p('结尾'), p('</end>'), p('</writing_style>'),
  ].join('')));
  const parsed = splitWordPreset(doc);
  assert.equal(parsed.audit.source, parsed.audit.reconstruction);
  assert.deepEqual(parsed.rows.map(r => r.title), ['使用说明', '核心', 'end']);
  assert.equal(parsed.rows[0].text, '[样本]\n\n<usage>\n\n看说明\n\n</usage>');
  assert.ok(parsed.rows[1].text.startsWith('<核心 key="a > b">\n<nested>'));
  assert.ok(parsed.rows[1].text.includes('<break />'));
  assert.ok(!parsed.audit.source.includes('writing_style'));
  const wrapped = splitWordPreset(doc, { unwrap:false });
  assert.equal(wrapped.rows.map(r => r.text).join('\n\n'), doc.paragraphs.map(r => r.text).join('\n\n'));
  assert.equal(wrapped.audit.source, wrapped.audit.reconstruction);
});

test('无标题整份导入，识别普通段落和段内的 ## 或编号标题', async () => {
  const plain = splitWordPreset(await readWordPreset(docx(p('普通话。') + p('') + p('<未配对>  原样'))));
  assert.deepEqual(decode(plain.rows), [{ name:'0. 样本', text:'普通话。\n\n<未配对>  原样' }]);
  const headings = '<w:p>' + run('说明') + '<w:r><w:br/></w:r>' + run('## 正文标题') + '<w:r><w:br/></w:r>' + run('正文') + '</w:p>';
  const sections = splitWordPreset(await readWordPreset(docx(headings)));
  assert.equal(sections.audit.source, sections.audit.reconstruction);
  assert.deepEqual(decode(sections.rows), [{ name:'0. 使用说明', text:'说明' }, { name:'1. 正文标题', text:'正文' }]);
  const numbers = splitWordPreset(await readWordPreset(docx(p('一、开头') + p('说明正文。') + p('2. 结尾') + p('结尾正文。'))));
  assert.deepEqual(numbers.rows.map(r => r.title), ['开头', '结尾']);
});

test('忽略非正文，接受插入修订，表格与自动编号转 Markdown', async () => {
  const numbering = xml('numbering', '<w:abstractNum w:abstractNumId="0">' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="8"><w:abstractNumId w:val="0"/></w:num>');
  const num = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="8"/></w:numPr>';
  const annotations = '<w:p><w:commentRangeStart w:id="1"/>' + run('正常正文') + '<w:r><w:commentReference w:id="1"/>' +
    '<w:footnoteReference w:id="2"/><w:endnoteReference w:id="3"/><w:drawing/>' +
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
    '<mc:Choice Requires="wps"><w:drawing><w:txbxContent>' + p('框内不导入') + '</w:txbxContent></w:drawing></mc:Choice>' +
    '<mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>' +
    '<w:fldSimple w:instr="PAGE">' + run('99') + '</w:fldSimple>' +
    '<w:del>' + run('旧内容') + '</w:del><w:ins>' + run('新内容') + '</w:ins></w:p>';
  const section = '<w:sectPr xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:headerReference r:id="r1"/><w:footerReference r:id="r2"/></w:sectPr>';
  const strong = '<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>强调</w:t></w:r></w:p>';
  const table = '<w:tbl><w:tr><w:tc>' + p('A|B') + '</w:tc><w:tc>' + p('C') + '</w:tc></w:tr></w:tbl>';
  const doc = await readWordPreset(docx(p('目录里的文字', '<w:pStyle w:val="TOC1"/>') + annotations +
    p('步骤一', num) + p('步骤二', '<w:pStyle w:val="ListNumber"/>') + strong + table + section, {
    'word/numbering.xml':numbering,
    'word/styles.xml':xml('styles', '<w:style w:styleId="ListNumber"><w:pPr>' + num + '</w:pPr></w:style>'),
    'word/header1.xml':'秘密页眉', 'word/footer1.xml':'秘密页脚',
  }));
  assert.equal(splitWordPreset(doc).rows.length, 1);
  const text = splitWordPreset(doc).rows[0].text;
  assert.equal(text, '正常正文新内容\n\n1. 步骤一\n\n2. 步骤二\n\n强调\n\n| A\\|B | C |\n| --- | --- |');
  assert.ok(splitWordPreset(doc, { emphasis:true }).rows[0].text.includes('***强调***'));
  assert.deepEqual(Object.fromEntries(doc.ignored.map(x => [x.name, x.count])), {
    目录段落:1, 批注:1, 脚注:1, 尾注:1, 图片:1, 文本框:1, 页码:1, 已删除的修订:1, 页眉:1, 页脚:1,
  });
});

test('拒绝 .doc、超过 5 MB 的文件和无效 ZIP', async () => {
  await assert.rejects(readWordPreset(new File([], '旧.doc')), /另存为 .docx/);
  await assert.rejects(readWordPreset({ name:'大.docx', size:5 * 1024 * 1024 + 1 }), /5 MB/);
  await assert.rejects(readWordPreset(new File(['invalid'], '坏.docx')), /ZIP/);
});

test('预览可勾选、拆合、修改标题，按原样显示标签并离线写入同一种规则组', async () => {
  const doc = await readWordPreset(docx(p('<!>（保留）') + p('## 去掉') + p('不要发送') + p('## 留下') + p('<script>别解析</script>')));
  const scoped = { id:'word-test-story', title:'旧故事', world:'原有数据', localModules:[], modules:{}, packs:[] };
  await db.put('stories', scoped);
  const imported = await new Promise(resolve => {
    showWordImport(doc, { story:scoped, onImported:resolve });
    const find = name => document.querySelector(`[aria-label="${name}"]`);
    const button = name => [...document.querySelectorAll('button')].find(b => b.textContent === name);
    assert.ok(document.body.textContent.includes('<script>别解析</script>'));
    assert.equal(document.querySelector('script'), null);
    const firstText = find('第 0 条正文');
    firstText.setSelectionRange(3,3);
    button('从光标处拆分').click();
    assert.ok(find('第 3 条正文'));
    button('与下一条合并').click();
    assert.equal(find('第 0 条正文').value, '<!>（保留）');
    find('导入第 1 条').click();
    const title = find('第 2 条标题');
    title.value = '改完的标题';
    title.dispatchEvent(new Event('input'));
    find('组名').value = '改完的组名';
    button('确认导入').click();
  });
  const saved = await db.get('stories', scoped.id);
  assert.equal(saved.world, '原有数据');
  assert.equal(saved.packs[0].name, '改完的组名');
  assert.deepEqual(saved.localModules.map(m => m.name), ['0. 使用说明', '1. 改完的标题']);
  assert.ok(saved.localModules.every(m => m.mode === 'always' && m.defaultOn && saved.modules[m.id]));
  assert.ok((await getModules()).every(m => m.pack !== imported.pack.id));
  const ctx = buildContext(saved, []);
  assert.ok(ctx.system.includes('<script>别解析</script>'));
  assert.ok(!ctx.system.includes('不要发送'));
  assert.equal(await undoWordImport(scoped), true);
  const undone = await db.get('stories', scoped.id);
  assert.equal(undone.localModules.length, 0);
  assert.deepEqual(undone.modules, {});
  assert.equal(undone.world, '原有数据');
});

test('全局整组撤销保留其他导入，且不会被撤销删除复活', async () => {
  const old = await importMarkdownPack('## 原有\n旧规则', '原有.md');
  const rows = [{ title:'Word 条目', text:'\\保留反斜杠\n## 正文标题\n尾部留空  ', included:true }];
  const word = await importMarkdownPack(wordImportMarkdown(rows), '样本.docx', { verbatim:true, undo:true });
  const later = await importMarkdownPack('## 之后导入\n保持独立', '新规则.md');
  assert.equal(word.mods[0].text, rows[0].text);
  await deleteModules(word.mods.map(m => m.id));
  assert.equal(await undoWordImport(), true);
  await undoModuleDelete();
  const remain = await getModules();
  assert.ok(remain.some(m => m.pack === old.pack.id) && remain.some(m => m.pack === later.pack.id));
  assert.ok(!remain.some(m => m.pack === word.pack.id));
  assert.equal(await undoWordImport(), false);
});

for (const [name, length] of [['金鱼灯', 16], ['气泡水', 18]]) {
  test(`本地样本 ${name} 保留全部正文和 ${length} 条规则`, async t => {
    const file = new URL(`./fixtures/word-local/${name}.docx`, import.meta.url);
    const bytes = await readFile(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!bytes) { t.skip('原始文档仅在本机验收时放入 tests/fixtures/word-local'); return; }
    const doc = await readWordPreset(new File([bytes], name + '.docx'));
    const result = splitWordPreset(doc);
    const expected = doc.paragraphs.slice(1, -1).map(r => r.text).join('\n\n');
    assert.ok(result.wrapper);
    assert.equal(result.rows.length, length);
    assert.equal(result.rows[0].title, '使用说明');
    assert.equal(result.rows.map(r => r.text).join('\n\n'), expected);
    assert.equal(result.audit.reconstruction, expected);
    assert.equal(decode(result.rows).map(r => r.text).join('\n\n'), expected);
    assert.equal(splitWordPreset(doc, { unwrap:false }).audit.reconstruction, doc.paragraphs.map(r => r.text).join('\n\n'));
  });
}

test('AI 标题需要主动确认，一次请求只带每条前 200 字，并再次确认应用', async () => {
  const doc = await readWordPreset(docx(p('## 原标题') + p('🐟'.repeat(200) + '第201字')));
  const oldFetch = globalThis.fetch, oldConfirm = globalThis.confirm;
  const requests = [];
  await db.put('connections', { id:'word-ai', format:'openai', model:'test', baseUrl:'https://qa.example/v1', apiKey:'fake', stream:false });
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices:[{ message:{ content:'[{"id":0,"title":"新标题"}]' }, finish_reason:'stop' }] });
  };
  try {
    const button = name => [...document.querySelectorAll('button')].find(b => b.textContent === name);
    const currentTitle = () => document.querySelector('[aria-label="第 0 条标题"]').value;
    showWordImport(doc, { story:{ connectionId:'word-ai' } });
    assert.equal(requests.length, 0);
    globalThis.confirm = () => false;
    button('让 AI 起标题').click();
    assert.equal(requests.length, 0);
    globalThis.confirm = () => true;
    button('让 AI 起标题').click();
    for (let i = 0; i < 50 && !button('应用建议'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(button('应用建议'), document.querySelector('[role="alert"]').textContent);
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].messages.find(m => m.role === 'user').content), [{ id:0, text:'🐟'.repeat(200) }]);
    assert.equal(currentTitle(), '原标题');
    button('应用建议').click();
    assert.equal(currentTitle(), '新标题');
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.confirm = oldConfirm;
    document.body.replaceChildren();
    await db.del('connections', 'word-ai');
  }
});
