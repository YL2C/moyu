// 墨游 · 酒馆导入的界面：选文件 → 导入 → 结果；整包开关、逐条开关、删除

import { el, sheet, toast, pickRawFile } from '../util.js';
import { MODULE_MODES, go } from '../state.js';
import { readTavernFile, importGlobal, importToStory, KIND_LABEL } from '../tavern.js';

const ACCEPT = '.json,.png,.zip,application/json,image/png,application/zip';

function fmtChars(n) { return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万字' : `${n} 字`; }

/** 选文件并导入。story 为空 = 导入到全局。返回 true 表示有改动 */
export async function importFlow(story = null) {
  const f = await pickRawFile(ACCEPT);
  if (!f) return false;
  toast('正在读取…', 1500);
  let read;
  try { read = await readTavernFile(f); }
  catch (e) { toast('读不了这个文件：' + (e?.message || e), 4000); return false; }
  if (!read.items.length) {
    showResult([], read.skipped, [], story);
    return false;
  }
  let lines = [];
  let newStories = [];
  try {
    if (story) lines = importToStory(story, read.items);
    else ({ lines, newStories } = await importGlobal(read.items));
  } catch (e) { toast('导入失败：' + (e?.message || e), 4000); return false; }
  showResult(lines, read.skipped, newStories, story);
  return true;
}

function showResult(lines, skipped, newStories, story) {
  const s = sheet({ title: '导入结果' });
  if (lines.length) s.body.append(el('div', { class: 'card' }, ...lines.map((l) => el('div', { style: { padding: '3px 0', fontSize: '14px' }, text: '· ' + l }))));
  if (skipped.length) {
    s.body.append(el('details', { class: 'card', style: { padding: '10px 14px' } },
      el('summary', { style: { cursor: 'pointer', fontSize: '14px', color: 'var(--text2)' }, text: `跳过了 ${skipped.length} 个文件` }),
      ...skipped.slice(0, 60).map((x) => el('div', { class: 'hint', text: `${x.file}：${x.why}` }))));
  }
  if (!lines.length && !skipped.length) s.body.append(el('div', { class: 'hint', text: '文件里没有能用的内容。' }));
  s.body.append(el('div', { class: 'hint' }, story
    ? '预设和世界书的条目变成这个故事自己的规则模块，在“规则”里可以整包或逐条开关。每开一条，每轮都会多发这些字。'
    : '预设和世界书的条目进了规则模块库，每个故事在“⋯ → 世界设定与规则 → 规则”里自己决定开哪些。'));
  for (const st of newStories) s.foot.append(el('button', { class: 'btn', onclick: () => { s.close(); go('play/' + encodeURIComponent(st.id)); } }, `去玩「${st.title}」`));
  s.foot.append(el('button', { class: 'btn primary', onclick: () => s.close() }, '好'));
}

function sw(checked, onchange) {
  const input = el('input', { type: 'checkbox', onchange: () => onchange(input.checked) });
  input.checked = !!checked;
  return { input, el: el('label', { class: 'switch' }, input, el('span')) };
}

/**
 * 一个包在故事里的开关：整包开关 + 展开逐条开关。
 * mods：这个包的模块；enabled：story.modules；onChange：存盘；onDelete：可选，删整包
 */
export function packToggle(pack, mods, enabled, onChange, onDelete) {
  const box = el('div', { class: 'pack' });
  let open = false;
  const draw = () => {
    const on = mods.filter((m) => enabled[m.id]);
    const chars = on.reduce((a, m) => a + (m.text?.length || 0), 0);
    const master = sw(on.length > 0, (v) => {
      for (const m of mods) {
        if (v) { if (m.defaultOn !== false) enabled[m.id] = true; }
        else delete enabled[m.id];
      }
      // 原本一条都没开的包：整包打开就全开
      if (v && !mods.some((m) => enabled[m.id])) mods.forEach((m) => { enabled[m.id] = true; });
      onChange(); draw();
    });
    box.replaceChildren(
      el('div', { class: 'switch-row' },
        el('div', { class: 'lbl' }, '📦 ' + pack.name,
          el('small', { text: `${KIND_LABEL[pack.kind] || '导入'} · 开了 ${on.length}/${mods.length} 条${on.length ? ' · 每轮多发约 ' + fmtChars(chars) : ''}` })),
        master.el),
      el('div', { class: 'row', style: { gap: '6px', margin: '-2px 0 6px' } },
        el('button', { class: 'btn small ghost', onclick: () => { open = !open; draw(); } }, open ? '收起' : '逐条开关'),
        onDelete ? el('button', { class: 'btn small ghost danger-text', onclick: () => onDelete() }, '删除这个包') : null),
      ...(open ? mods.map((m) => {
        const one = sw(!!enabled[m.id], (v) => { if (v) enabled[m.id] = true; else delete enabled[m.id]; onChange(); draw(); });
        return el('div', { class: 'switch-row sub' },
          el('div', { class: 'lbl' }, m.name, el('small', { text: `${MODULE_MODES[m.mode] || ''}${m.mode === 'keyword' && m.keywords ? '：' + m.keywords.slice(0, 40) : ''} · ${m.text.length} 字` })),
          one.el);
      }) : []));
  };
  draw();
  return box;
}
