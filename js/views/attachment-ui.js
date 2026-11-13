import { el, menu, toast, saveFile } from '../util.js';
import { db } from '../db.js';
import { attachmentBytes, selectedImport } from '../attachments.js';
import { detectKind, importGlobal, importToStory } from '../tavern.js';

export function attachmentCard(a, { onChange = () => {}, onRemove, storyId = '' } = {}) {
  const count = el('span', { class: 'badge' });
  const updateCount = () => { count.textContent = `${a.sections.filter(s => s.selected !== false).length}/${a.sections.length} 项 · ${a.sections.filter(s => s.selected !== false).reduce((n,s) => n + s.text.length,0)} 字`; };
  const details = el('details', { class: 'attachment-card' },
    el('summary', {}, el('span', { text: '📎 ' + a.name }), count));
  details.append(el('div', { class: 'hint', text: `原文件已保留 · ${(a.size / 1024).toFixed(1)} KB${a.mime === 'image/png' ? ' · PNG格式未改变' : ''} · 仅解析文字，不识别图片画面` }));
  if (a.config?.regex) details.append(el('div', { class: 'hint', text: `原卡含 ${a.config.regex} 条正则美化，原文件中保留，墨游暂不运行。` }));
  if (a.config?.extensions?.length) details.append(el('details', { class: 'attachment-field' },
    el('summary', { text: '查看附加配置（不运行）' }),
    el('pre', { class: 'raw', text: JSON.stringify((a.items[0].json.data || a.items[0].json).extensions, null, 2) })));
  const include = el('input', { type: 'checkbox', 'aria-label': '讨论携带附件 ' + a.name, onchange: () => { a.include = include.checked; onChange(); } });
  include.checked = a.include !== false;
  details.append(el('label', { class: 'attachment-include' }, include, '讨论时携带勾选的内容'));
  const boxes = [];
  details.append(el('div', { class: 'row' }, ...[['全选内容', true], ['取消全选', false]].map(([label,value]) => el('button', { class: 'btn small', onclick: () => {
    a.sections.forEach(s => s.selected = value); boxes.forEach(box => box.checked = value); updateCount(); onChange();
  } }, label))));
  for (const section of a.sections) {
    const box = el('input', { type: 'checkbox', 'aria-label': '携带 ' + section.name, onchange: () => { section.selected = box.checked; updateCount(); onChange(); } });
    box.checked = section.selected !== false; boxes.push(box);
    details.append(el('details', { class: 'attachment-field' },
      el('summary', {}, el('label', { onclick: e => e.stopPropagation() }, box, section.name), el('span', { class: 'muted', text: `${section.text.length} 字` })),
      el('pre', { class: 'raw', text: section.text })));
  }
  details.append(el('div', { class: 'row', style: { marginTop: '8px' } },
    el('button', { class: 'btn small', onclick: () => saveFile(a.name, attachmentBytes(a), a.mime) }, '下载原文件'),
    a.items?.length ? el('button', { class: 'btn small', onclick: () => importAttachment(a, storyId).catch(e => toast(e.message, 4000)) }, '导入勾选内容') : null,
    onRemove ? el('button', { class: 'btn small danger-text', onclick: onRemove }, '移除附件') : null));
  updateCount(); return details;
}

async function importAttachment(a, storyId) {
  const json = selectedImport(a), kind = detectKind(json);
  const stories = await db.all('stories');
  const choices = [{ key: 'global', label: kind === 'card' ? '新建故事' : '导入全局规则库' }];
  stories.sort((x,y) => Number(y.id === storyId) - Number(x.id === storyId));
  for (const story of stories) choices.push({ key: story.id, label: (story.id === storyId ? '当前故事 · ' : '') + (story.title || '未命名故事') });
  const target = await menu('导入到哪里？', choices);
  if (target === null) return;
  const items = [{ file: a.name, json }];
  if (target === 'global') {
    const result = await importGlobal(items); toast(result.lines.join('\n'), 5000);
  } else {
    const story = await db.get('stories', target);
    if (!story) throw new Error('目标故事已删除');
    const lines = importToStory(story, items); story.updatedAt = Date.now();
    await db.put('stories', story); toast(lines.join('\n'), 5000);
  }
}
