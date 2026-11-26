import { el, sheet, pickRawFile, toast, promptText } from '../util.js';
import { connLabel, go } from '../state.js';
import { MATERIAL_SLOTS, MATERIAL_MAX_BYTES, RECALL_LABELS, parseMaterialPackage, currentMaterial } from '../deeptalk-materials.js';
import { deepTalkMaterials, deepTalkMemory, deepTalkSettings, deepTalkConnections, saveDeepTalkMaterials, saveMaterialEdit,
  restoreMaterialEdition, reviseDeepTalkMemory, saveDeepTalkSettings, readDeepTalkTurn } from '../deeptalk.js';

const button = (label, click, attrs = {}) => el('button', { type: 'button', class: 'btn small', onclick: click, ...attrs }, label);
const date = timestamp => new Date(timestamp).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

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

  function drawMaterials(data) {
    const importButton = button('导入资料包', async () => {
      importButton.disabled = true;
      try {
        const file = await pickRawFile('.json,application/json');
        if (!file) return;
        if (file.size > MATERIAL_MAX_BYTES) throw new Error('日常聊天资料包不能超过 4 MB');
        const documents = await parseMaterialPackage(await file.text());
        const present = await deepTalkMaterials();
        const changed = Object.entries(documents).some(([slot, original]) => present[slot] && present[slot].original.sha256 !== original.sha256);
        if (changed && !window.confirm('导入后会启用新资料。旧原件和编辑记录仍可在版本中查看。继续导入吗？')) return;
        const result = await saveDeepTalkMaterials(documents);
        toast(result.changed ? '已导入核心名片、长期档案和敏感记忆' : '这份资料包已经导入');
        await draw();
      } catch (error) { toast(error.message || '资料导入失败', 4200); }
      finally { importButton.disabled = false; }
    });
    content.replaceChildren(
      el('div', { class: 'deeptalk-panel-actions' }, importButton),
      el('p', { class: 'deeptalk-subtle' }, '在本机读取一个 JSON。聊天时，选中的原文片段会随本轮请求发给所选 API。'),
      ...Object.entries(MATERIAL_SLOTS).map(([slot, label]) => {
        const document = currentMaterial(data[slot]);
        return el('div', { class: 'deeptalk-list-item' },
          el('div', { class: 'deeptalk-list-title' }, label),
          el('div', { class: 'deeptalk-subtle' }, document ? document.sourceName : '等待导入'),
          document && button('查看全文与编辑', () => drawDocument(slot, data[slot])));
      }));
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
    const full = el('textarea', { readonly: true, rows: '9', 'aria-label': `${MATERIAL_SLOTS[slot]}全文`, class: 'deeptalk-document-text' });
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
      el('h3', {}, MATERIAL_SLOTS[slot]),
      el('div', { class: 'deeptalk-panel-actions' }, versionSelect,
        !editable && button('启用该版本', async () => {
          try { const result = await restoreMaterialEdition(slot, document.id); drawDocument(slot, result[slot], document.id, part.id); }
          catch (error) { toast(error.message); }
        })),
      el('div', { class: 'deeptalk-panel-actions' }, find, button('查找', search)), full,
      el('h3', {}, '按段编辑'), sectionSelect,
      el('p', { class: 'deeptalk-subtle' }, `默认调用 · ${RECALL_LABELS[part.recall]}`), editor,
      ...(editable ? [el('label', { class: 'deeptalk-check' }, onlyManual, '仅手动带入')] : []),
      el('div', { class: 'deeptalk-panel-actions' }, editable && save,
        editable && !part.duplicateOf && button('带入下一条', () => { onCarry(`${slot}/${part.id}`, part.title); panel.close(); })));
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
    select.addEventListener('change', () => { automatic.disabled = !select.value; if (!select.value) automatic.checked = false; });
    const save = async () => saveDeepTalkSettings({ memoryConnectionId: select.value, autoMemory: !!select.value && automatic.checked });
    content.replaceChildren(
      el('label', { class: 'deeptalk-field' }, '日常记忆整理 API', select),
      el('p', { class: 'deeptalk-subtle' }, '可选用与跑团相同的 API。整理请求只带日常聊天里已稳定的普通发言。'),
      ...(!connections.length ? [button('前往 API 连接设置', () => { panel.close(); go('settings/connections'); })] : []),
      el('label', { class: 'deeptalk-check' }, automatic, '满约 20 轮自动整理'),
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
