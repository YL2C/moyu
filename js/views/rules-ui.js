import { el } from '../util.js';

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
    const title = el('summary', {}, el('span', { text: name }), el('span', { class: 'badge', text: `${members.length} 条` }));
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
      current.append(el('summary', { text: child.textContent }));
      current.addEventListener('toggle', () => { try { localStorage.setItem(key, currentForEvent.open ? 'open' : 'closed'); } catch {} });
      const currentForEvent = current;
      child.replaceWith(current); groups.push(current);
    } else if (current) current.append(child);
  }
  wrap.prepend(el('div', { class: 'row fold-tools' },
    el('button', { class: 'btn small', onclick: () => groups.forEach(g => g.open = true) }, '全部展开'),
    el('button', { class: 'btn small', onclick: () => groups.forEach(g => g.open = false) }, '全部收起')));
}
