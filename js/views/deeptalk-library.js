import { el, sheet, pickRawFile, toast, promptText } from '../util.js';
import { connLabel, go } from '../state.js';
import { MATERIAL_SLOTS, MATERIAL_LABELS, TOPIC_SLOTS, MATERIAL_MAX_BYTES, RECALL_LABELS,
  parseMaterialPackage, parseTopicDocument, currentMaterial } from '../deeptalk-materials.js';
import { deepTalkMaterials, deepTalkMemory, deepTalkSettings, deepTalkConnections, saveDeepTalkMaterials, saveMaterialEdit,
  restoreMaterialEdition, reviseDeepTalkMemory, saveDeepTalkSettings, readDeepTalkTurn } from '../deeptalk.js';

const button = (label, click, attrs = {}) => el('button', { type: 'button', class: 'btn small', onclick: click, ...attrs }, label);
const date = timestamp => new Date(timestamp).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const PACKAGE_FILE_TYPES = '.json,application/json';
const TOPIC_FILE_TYPES = `${PACKAGE_FILE_TYPES},.md,.markdown,.txt,text/markdown,text/plain`;

async function readPackage(file, options) {
  if (file.size > MATERIAL_MAX_BYTES) throw new Error('资料包不能超过 4 MB');
  return parseMaterialPackage(await file.text(), options);
}

export function openDeepTalkLibrary({ onCarry, onOrganize, onClose }) {
  const panel = sheet({ title: '资料与记忆', onClose });
  panel.panel.classList.add('deeptalk-sheet');
  const content = el('div', { class: 'deeptalk-sheet-content' });
  const tabs = el('div', { class: 'deeptalk-sheet-tabs' });
  panel.body.append(tabs, content);
  panel.foot.append(button('完成', panel.close));
  let request = 0;

  async function draw(tab = 'materials') {
    const token = ++request;
    tabs.hidden = false;
    tabs.replaceChildren(...[['materials', '资料包'], ['memories', '聊天记忆'], ['settings', '整理设置']].map(([id, label]) =>
      button(label, () => void draw(id), { 'aria-pressed': String(tab === id) })));
    content.replaceChildren(el('div', { class: 'deeptalk-subtle' }, '读取中…'));
    try {
      if (tab === 'materials') {
        const data = await deepTalkMaterials();
        if (token === request) drawMaterials(data);
      } else if (tab === 'memories') {
        const data = await deepTalkMemory();
        if (token === request) drawMemories(data);
      } else {
        const [settings, connections] = await Promise.all([deepTalkSettings(), deepTalkConnections()]);
        if (token === request) drawSettings(settings, connections);
      }
    } catch (error) { if (token === request) content.replaceChildren(el('p', { class: 'deeptalk-subtle' }, error.message)); }
  }

  async function importDocuments(button, load) {
    const token = request;
    button.disabled = true;
    try {
      const documents = await load();
      if (!documents) return;
      const present = await deepTalkMaterials();
      const changed = Object.entries(documents).some(([slot, original]) => present[slot] && present[slot].original.sha256 !== original.sha256);
      if (changed) {
        const activation = Object.keys(TOPIC_SLOTS).every(slot => Object.hasOwn(documents, slot))
          ? '导入后会同时启用两份专题。' : '导入后会启用新资料。';
        if (!window.confirm(activation + '旧原件和编辑记录仍可在版本中查看。继续导入吗？')) return;
      }
      const result = await saveDeepTalkMaterials(documents);
      toast(result.changed ? '已导入' : '这份资料已经导入');
      if (token === request && panel.panel.isConnected) await draw();
    } catch (error) { toast(error.message || '资料导入失败', 4200); }
    finally { button.disabled = false; }
  }

  function drawMaterials(data) {
    const importButton = button('导入资料包', event => importDocuments(event.currentTarget, async () => {
      const file = await pickRawFile(PACKAGE_FILE_TYPES);
      return file ? readPackage(file) : null;
    }));
    const cards = slots => Object.entries(slots).map(([slot, label]) => {
      const document = currentMaterial(data[slot]);
      const isTopic = Object.hasOwn(TOPIC_SLOTS, slot);
      return el('div', { class: 'deeptalk-list-item' },
        el('div', { class: 'deeptalk-list-title' }, label),
        el('div', { class: 'deeptalk-subtle' }, document ? document.sourceName : '等待导入'),
        el('div', { class: 'deeptalk-panel-actions' },
          document && button('查看全文与编辑', () => drawDocument(slot, data[slot])),
          isTopic && button(document ? '导入新版本' : '导入专题', event => importDocuments(event.currentTarget, async () => {
            const file = await pickRawFile(TOPIC_FILE_TYPES);
            if (!file) return null;
            if (/\.json$/i.test(file.name) || file.type === 'application/json') return readPackage(file, { topicsOnly: true });
            return { [slot]: await parseTopicDocument(slot, file) };
          }))));
    });
    content.replaceChildren(
      el('div', { class: 'deeptalk-panel-actions' }, importButton),
      ...cards(MATERIAL_SLOTS),
      el('h3', {}, '专题资料'),
      el('p', { class: 'deeptalk-subtle' }, '可单独导入 Markdown 或 TXT。专题 JSON 资料包会一次导入两份。'),
      ...cards(TOPIC_SLOTS));
  }

  function drawDocument(slot, record, versionId = currentMaterial(record).id, partId = '') {
    request++;
    tabs.hidden = true;
    const active = currentMaterial(record);
    const versions = [record.original, ...record.editions];
    const document = versions.find(version => version.id === versionId) || active;
    const editable = document.id === active.id;
    const part = document.sections.find(section => section.id === partId) || document.sections[0];
    const versionSelect = el('select', { 'aria-label': '资料版本', onchange: event => drawDocument(slot, record, event.target.value, part.id) },
      versions.map(version => el('option', { value: version.id, selected: version.id === document.id },
        `${version.id === record.original.id ? '导入原件' : date(version.at)}${version.id === active.id ? ' · 使用中' : ''}`)));
    const full = el('textarea', { readonly: true, rows: '9', 'aria-label': `${MATERIAL_LABELS[slot]}全文`, class: 'deeptalk-document-text' });
    full.value = document.text;
    const find = el('input', { type: 'search', placeholder: '搜索原文', 'aria-label': '搜索原文' });
    const search = () => {
      const query = find.value.trim();
      if (!query) return;
      let at = full.value.toLowerCase().indexOf(query.toLowerCase(), full.selectionEnd);
      if (at < 0) at = full.value.toLowerCase().indexOf(query.toLowerCase());
      if (at < 0) { toast('没有找到这段文字'); return; }
      full.focus(); full.setSelectionRange(at, at + query.length);
    };
    find.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
    const sectionSelect = el('select', { 'aria-label': '选择段落', onchange: event => drawDocument(slot, record, document.id, event.target.value) },
      document.sections.map(section => el('option', { value: section.id, selected: section.id === part.id }, section.title)));
    const editor = el('textarea', { rows: '6', readonly: !editable, 'aria-label': '段落原文', class: 'deeptalk-document-text' });
    editor.value = document.text.slice(part.start, part.end);
    const onlyManual = el('input', { type: 'checkbox', checked: !!part.manualOnly, disabled: !editable });
    const save = button('保存编辑', async () => {
      save.disabled = true;
      try {
        const materials = await saveMaterialEdit(slot, document.id, part.id, editor.value, onlyManual.checked);
        drawDocument(slot, materials[slot], undefined, part.id);
        toast('已保存新版本');
      } catch (error) { toast(error.message); save.disabled = false; }
    });
    content.replaceChildren(button('返回资料', () => void draw()),
      el('h3', {}, MATERIAL_LABELS[slot]),
      el('div', { class: 'deeptalk-panel-actions' }, versionSelect,
        !editable && button('启用该版本', async () => {
          try { const result = await restoreMaterialEdition(slot, document.id); drawDocument(slot, result[slot], document.id, part.id); }
          catch (error) { toast(error.message); }
        })),
      el('div', { class: 'deeptalk-panel-actions' }, find, button('查找', search)), full,
      el('h3', {}, '按段编辑'), sectionSelect,
      el('p', { class: 'deeptalk-subtle' }, `默认调用 · ${RECALL_LABELS[part.recall]}`),
      part.hint && el('p', { class: 'deeptalk-subtle' }, part.hint), editor,
      ...(editable ? [el('label', { class: 'deeptalk-check' }, onlyManual, '仅手动带入')] : []),
      el('div', { class: 'deeptalk-panel-actions' }, editable && save,
        editable && !part.duplicateOf && !(Object.hasOwn(TOPIC_SLOTS, slot) && part.recall === 'view_only') &&
          button('带入下一条', () => { onCarry(`${slot}/${part.id}`, part.title); panel.close(); })));
  }

  function drawMemories(memory) {
    const recent = (memory.snapshot || []).map(item => el('div', { class: 'deeptalk-list-item' },
      el('span', { class: 'deeptalk-subtle' }, item.label), el('div', { class: 'deeptalk-quote' }, item.quote)));
    const entries = (memory.entries || []).filter(item => ['active', 'candidate'].includes(item.status)).reverse();
    content.replaceChildren(el('h3', {}, '近期脉络'), ...(recent.length ? recent : [el('p', { class: 'deeptalk-subtle' }, '整理后显示近期发言。')]),
      el('h3', {}, '长期记忆'), ...(entries.length ? entries.map(memoryCard) : [el('p', { class: 'deeptalk-subtle' }, '聊天里点「记住这条」，也可以从整理候选中保存。')]));
  }

  function memoryCard(entry) {
    const change = async patch => {
      try { await reviseDeepTalkMemory(entry.id, patch); await draw('memories'); }
      catch (error) { toast(error.message); }
    };
    return el('article', { class: 'deeptalk-list-item' },
      el('div', { class: 'deeptalk-subtle' }, [entry.status === 'candidate' ? '待确认' : '已记住', entry.pinned && '已置顶', date(entry.at)].filter(Boolean).join(' · ')),
      el('div', { class: 'deeptalk-quote' }, entry.text),
      entry.text !== entry.quote && el('div', { class: 'deeptalk-subtle deeptalk-quote' }, `原话：${entry.quote}`),
      el('div', { class: 'deeptalk-panel-actions' },
        entry.status === 'candidate' && button('确认保存', () => change({ status: 'active' })),
        entry.status === 'active' && button(entry.pinned ? '取消置顶' : '置顶', () => change({ pinned: !entry.pinned })),
        entry.status === 'active' && button(entry.manualOnly ? '恢复按需' : '仅手动', () => change({ manualOnly: !entry.manualOnly })),
        button('编辑', async () => {
          const text = await promptText({ title: '编辑记忆', value: entry.text, multiline: true });
          if (text?.trim()) await change({ text: text.trim().slice(0, 4000) });
        }),
        entry.status === 'active' && button('带入下一条', () => { onCarry('memory/' + entry.id, '手动记忆'); panel.close(); }),
        button('来源', async () => {
          const turn = await readDeepTalkTurn(entry.turnId);
          const source = sheet({ title: '记忆来源' });
          source.body.append(el('div', { class: 'deeptalk-quote' }, turn ? (entry.replyId && entry.origin === 'manual'
            ? turn.replies.find(reply => reply.id === entry.replyId)?.text || entry.quote : turn.text) : entry.quote));
          source.foot.append(button('关闭', source.close));
        }),
        button(entry.status === 'candidate' ? '忽略' : '删除', () => change({ status: 'deleted' }))));
  }

  function drawSettings(settings, connections) {
    const select = el('select', { 'aria-label': '日常记忆整理 API' },
      el('option', { value: '' }, '暂不选择'), connections.map(conn => el('option', { value: conn.id }, `${connLabel(conn)} · ${conn.model}`)));
    select.value = connections.some(conn => conn.id === settings.memoryConnectionId) ? settings.memoryConnectionId : '';
    const automatic = el('input', { type: 'checkbox', checked: !!select.value && settings.autoMemory, disabled: !select.value });
    const topics = el('input', { type: 'checkbox', checked: !!select.value && settings.autoTopics, disabled: !select.value });
    select.addEventListener('change', () => {
      automatic.disabled = topics.disabled = !select.value;
      if (!select.value) automatic.checked = topics.checked = false;
    });
    const save = async () => saveDeepTalkSettings({ memoryConnectionId: select.value,
      autoMemory: !!select.value && automatic.checked, autoTopics: !!select.value && topics.checked });
    content.replaceChildren(
      el('label', { class: 'deeptalk-field' }, '日常记忆整理 API', select),
      el('p', { class: 'deeptalk-subtle' }, '可选用与跑团相同的 API。整理请求只带日常聊天里已稳定的普通发言。'),
      ...(!connections.length ? [button('前往 API 连接设置', () => { panel.close(); go('settings/connections'); })] : []),
      el('label', { class: 'deeptalk-check' }, automatic, '满约 20 轮自动整理'),
      el('label', { class: 'deeptalk-check' }, topics, '专题自动联想'),
      el('p', { class: 'deeptalk-subtle' }, '整理连接根据本轮发言、最近一句普通发言和短目录选段。专题联想在花费里单独显示。'),
      el('div', { class: 'deeptalk-panel-actions' },
        button('保存设置', async () => { try { await save(); toast('日常记忆设置已保存'); } catch (error) { toast(error.message); } }),
        button('整理记忆', async () => {
          try { await save(); panel.close(); await onOrganize(); }
          catch (error) { toast(error.message); }
        })));
  }

  void draw();
  return panel;
}
