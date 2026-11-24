import { el, sheet, toast, uid } from '../util.js';
import { MODULE_MODES } from '../state.js';

// 所有选择仅作用本面板；故事启用状态与显示折叠状态各自保存。
export function rulePanel({ mods, packs = [], enabled, onChange = () => {}, onEdit, onDelete, onGroup, onUndo }) {
  const root = el('div', { class: 'rule-manager' }), selected = new Set();
  const toolbar = el('div', { class: 'row batch-bar' }), list = el('div');
  const summary = el('span', { class: 'hint' });
  const boxes = [], switches = [];
  const sync = () => {
    for (const { input, ids } of boxes) {
      input.checked = ids.every(id => selected.has(id));
      input.indeterminate = !input.checked && ids.some(id => selected.has(id));
    }
    for (const { input, ids } of switches) {
      input.checked = ids.every(id => !!enabled[id]);
      input.indeterminate = !input.checked && ids.some(id => !!enabled[id]);
    }
    summary.textContent = `已选 ${selected.size}/${mods.length}`;
    toolbar.querySelectorAll('[data-needs-selection]').forEach(button => button.disabled = !selected.size);
  };
  const selectBox = (ids, label) => {
    const input = el('input', { type: 'checkbox', 'aria-label': label, onchange: () => {
      ids.forEach(id => input.checked ? selected.add(id) : selected.delete(id)); sync();
    } });
    boxes.push({ input, ids }); return input;
  };
  const enableSwitch = (ids, label) => {
    const input = el('input', { type: 'checkbox', 'aria-label': label, onchange: () => {
      ids.forEach(id => enabled[id] = input.checked); onChange(); sync();
    } });
    switches.push({ input, ids }); return el('label', { class: 'switch' }, input, el('span'));
  };
  const action = (label, onclick) => el('button', { class: 'btn small', 'data-needs-selection': true, onclick: () => onclick([...selected]) }, label);
  toolbar.append(
    el('button', { class: 'btn small', onclick: () => { mods.forEach(m => selected.add(m.id)); sync(); } }, '全选'),
    el('button', { class: 'btn small', onclick: () => { mods.forEach(m => selected.has(m.id) ? selected.delete(m.id) : selected.add(m.id)); sync(); } }, '反选'), summary,
  );
  if (enabled) toolbar.append(
    action('开启所选', ids => { ids.forEach(id => enabled[id] = true); onChange(); sync(); }),
    action('关闭所选', ids => { ids.forEach(id => enabled[id] = false); onChange(); sync(); }),
    el('button', { class: 'btn small', onclick: () => { mods.forEach(m => enabled[m.id] = true); onChange(); sync(); } }, '全部开启'),
    el('button', { class: 'btn small', onclick: () => { mods.forEach(m => enabled[m.id] = false); onChange(); sync(); } }, '全部关闭'),
  );
  if (onGroup) toolbar.append(action('归为预设', onGroup));
  if (onDelete) toolbar.append(action('删除所选', onDelete));
  if (onUndo) toolbar.append(el('button', { class: 'btn small', onclick: onUndo }, '撤销上次删除'));
  const groups = new Map();
  for (const m of mods) { const key = m.pack || ''; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(m); }
  for (const [key, members] of groups) {
    const name = packs.find(p => p.id === key)?.name || (key ? '导入的预设' : '未分组模块');
    const ids = members.map(m => m.id), body = el('div');
    const details = el('details', { class: 'rule-pack' });
    const title = el('summary', {}, el('span', { text: key ? '📦 ' + name : name }), el('span', { class: 'badge', text: `${members.length} 条` }));
    const controls = el('div', { class: 'row rule-group-controls' },
      el('label', {}, selectBox(ids, '选择整组 ' + name), '选择整组'),
      enabled ? enableSwitch(ids, '启用整组 ' + name) : null);
    details.append(title, controls, body);
    for (const m of members) {
      const title = el('div', { class: 'lbl' }, m.name, el('small', { text: `${m.text?.length || 0} 字${m.mode === 'keyword' ? ' · 按关键词' : m.mode === 'manual' ? ' · 情境开关' : ''}` }));
      body.append(el('div', { class: 'switch-row' }, selectBox([m.id], '选择模块 ' + m.name), title,
        enabled ? enableSwitch([m.id], '启用模块 ' + m.name) : null,
        onEdit ? el('button', { class: 'btn small ghost', onclick: () => onEdit(m) }, '编辑') : null));
    }
    list.append(details);
  }
  if (!mods.length) list.append(el('div', { class: 'hint', text: '还没有规则模块。' }));
  root.append(toolbar, list); sync(); return root;
}

export function collapseSettings(wrap, section = '') {
  const children = [...wrap.children];
  let current = null, index = 0;
  const groups = [];
  for (const child of children) {
    if (child.classList.contains('section-title')) {
      const key = 'moyu-yl2c.settings.fold.' + (child.id || child.textContent);
      let stored = null; try { stored = localStorage.getItem(key); } catch {}
      const active = child.id === 'sec-' + section;
      current = el('details', { class: 'settings-section', id: child.id || 'settings-section-' + index++ });
      current.open = active || stored === 'open' || (stored === null && child.textContent === '关于');
      current.append(el('summary', { 'data-section': child.textContent, text: child.textContent }));
      current.addEventListener('toggle', () => { try { localStorage.setItem(key, currentForEvent.open ? 'open' : 'closed'); } catch {} });
      const currentForEvent = current;
      child.replaceWith(current); groups.push(current);
    } else if (current) current.append(child);
  }
  wrap.prepend(el('div', { class: 'row fold-tools' },
    el('button', { class: 'btn small', onclick: () => groups.forEach(g => g.open = true) }, '全部展开'),
    el('button', { class: 'btn small', onclick: () => groups.forEach(g => g.open = false) }, '全部收起')));
}

export function editRuleModule(existing, { onSave, onDelete }) {
  const isNew = !existing;
  const m = existing ? { ...existing } : { id: uid(), name: '', text: '', note: '', mode: 'always', keywords: '' };
  const s = sheet({ title: isNew ? '新规则模块' : '编辑模块' });
  const name = el('input', { type: 'text', placeholder: '例：成人场景、弹幕写法、现代奢华' }); name.value = m.name;
  const mode = el('select');
  for (const [k, v] of Object.entries(MODULE_MODES)) mode.append(el('option', { value: k }, v));
  mode.value = m.mode || 'always';
  const kw = el('input', { type: 'text', placeholder: '用顿号分开，例：宴会、晚宴、酒会' }); kw.value = m.keywords || '';
  const kwField = el('div', { class: 'field' }, el('label', { text: '关键词' }), kw, el('div', { class: 'hint', text: '最近的剧情或你的输入里出现其中任何一个，这一轮就发送这个模块。' }));
  const text = el('textarea', { class: 'tall', placeholder: '发给模型的规则正文' }); text.value = m.text; text.style.minHeight = '34vh';
  const note = el('textarea', { placeholder: '为什么定这条、原话、例子……只给自己看，不发给模型，不花钱。' }); note.value = m.note || '';
  const syncKw = () => { kwField.style.display = mode.value === 'keyword' ? '' : 'none'; };
  mode.addEventListener('change', syncKw); syncKw();
  s.body.append(
    el('div', { class: 'field' }, el('label', { text: '名字' }), name),
    el('div', { class: 'field' }, el('label', { text: '什么时候发送' }), mode,
      el('div', { class: 'hint', text: '“一直发送”：启用的故事每轮都带上。“手动开关”：在游玩页右上角打开才带上，适合成人场景这类情境规则。“关键词”：提到时才带上。' })),
    kwField,
    el('div', { class: 'field' }, el('label', { text: '规则正文（发给模型）' }), text),
    el('div', { class: 'field' }, el('label', { text: '备注（不发给模型）' }), note),
  );
  s.foot.append(
    onDelete ? el('button', {
      class: 'btn danger', style: { marginRight: 'auto' },
      onclick: async () => {
        if (!confirm(`删除模块「${m.name}」？`)) return;
        try { await onDelete(m); s.close(); } catch (e) { toast(e.message); }
      },
    }, '删除') : null,
    el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        m.name = name.value.trim(); m.text = text.value; m.note = note.value; m.mode = mode.value; m.keywords = kw.value.trim();
        if (!m.name) { toast('起个名字'); return; }
        try { await onSave(m); s.close(); } catch (e) { toast(e.message); }
      },
    }, '保存'));
}

