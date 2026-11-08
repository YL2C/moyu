// 墨游 · 导出游玩记录：当前这条线的正文，给人看、给别的工具用（不是备份，导不回墨游）

import { db } from './db.js';
import { parseReply } from './parse.js';
import { extraBlocks } from './fanwai.js';
import { latestCheckpoint, memoryText, applyCardState } from './prompt.js';
import { el, sheet, toast, saveFile } from './util.js';

function pathTo(nodes, id) {
  const out = [];
  let cur = id ? nodes.get(id) : null;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : null; }
  return out;
}

function youText(u) {
  if (!u) return '';
  if (u.kind === 'start') return u.text?.trim() ? '（开场）' + u.text.trim() : '（开始游戏）';
  if (u.kind === 'continue') return '（继续）';
  return (u.text || '').trim();
}

/**
 * opts: { danmu, options, extras, setting, memory, ooc }
 * 返回一个普通对象，可以直接 JSON.stringify
 */
export async function buildTranscript(storyId, opts = {}) {
  const o = { danmu: false, options: false, extras: true, setting: true, memory: false, ooc: false, ...opts };
  const story = await db.get('stories', storyId);
  if (!story) throw new Error('找不到这个故事');
  const nodes = new Map((await db.byStory(storyId)).map((n) => [n.id, n]));
  const path = pathTo(nodes, story.headId);
  const cp = latestCheckpoint(path);
  const chapters = [];
  let lastUser = null;
  let no = 0;
  for (const n of path) {
    if (n.role === 'user') { lastUser = n; continue; }
    if (!n.text?.trim()) continue;
    if (n.kind === 'ooc') {
      if (o.ooc) chapters.push({ type: 'ooc', you: (lastUser?.text || '').trim(), text: n.text.trim() });
      continue;
    }
    no++;
    const p = parseReply(n.text);
    const ch = { no, title: p.title || '', you: youText(lastUser), text: (p.body || '').trim() };
    if (lastUser?.director?.trim()) ch.director = lastUser.director.trim();
    if (o.danmu && p.danmu.length) ch.danmu = p.danmu.map((d) => ({ name: d.name, text: d.text }));
    if (o.options && p.options.length) ch.options = p.options;
    chapters.push(ch);
  }
  const out = {
    app: 'moyu-transcript', version: 1, exportedAt: new Date().toISOString(),
    title: story.title || '未命名故事', chapterCount: no,
  };
  if (o.setting) {
    out.setting = {
      world: story.world || '', opening: story.opening || '', protagonist: story.protagonist || null,
      cards: (story.cards || []).filter((c) => c.name?.trim()).map((c0) => {
        const c = applyCardState(c0, cp?.mem);
        return { name: c.name, aliases: c.aliases || '', core: !!c.core, initial: c.initial || '', base: c.base || '', voice: c.voice || '', forbid: c.forbid || '', arc: c.arc || '', now: c.now || '', relation: c.relation || '' };
      }),
    };
  }
  if (o.memory && cp) out.memory = { upTo: cp.mem.upTo, text: memoryText(cp.mem) };
  out.chapters = chapters;
  if (o.extras) {
    const xs = (await db.extrasOf(storyId)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    out.extras = xs.map((x) => {
      const v = x.versions?.[x.cur ?? 0];
      const text = (v?.text || '').trim();
      const b = extraBlocks(text);
      return { title: b.title || x.tplName || '番外', form: x.tplName || '自定义', request: x.request || '', afterChapter: x.anchorNo ?? null, pov: x.pov || '', text };
    }).filter((x) => x.text);
  }
  return out;
}

/** 纯文本版：方便直接看 */
export function transcriptToText(t) {
  const L = [`《${t.title}》`, ''];
  if (t.setting) {
    if (t.setting.world) L.push('【世界与角色设定】', t.setting.world, '');
    for (const c of t.setting.cards || []) {
      L.push(`【角色 · ${c.name}${c.aliases ? '（' + c.aliases + '）' : ''}】`);
      for (const [k, label] of [['initial', '初始设定'], ['base', '底色'], ['now', '当前状态'], ['relation', '关系']]) if (c[k]) L.push(`${label}：${c[k]}`);
      L.push('');
    }
  }
  if (t.memory) L.push(`【前情档案 · 整理到第 ${t.memory.upTo} 章】`, t.memory.text, '');
  for (const ch of t.chapters) {
    if (ch.type === 'ooc') { L.push('〔出戏〕', '我：' + ch.you, ch.text, ''); continue; }
    L.push(`第 ${ch.no} 章${ch.title ? ' · ' + ch.title : ''}`);
    if (ch.you) L.push('> ' + ch.you.replace(/\n/g, '\n> '));
    L.push('', ch.text);
    if (ch.danmu?.length) L.push('', '【弹幕】', ...ch.danmu.map((d) => (d.name ? d.name + '：' : '') + d.text));
    if (ch.options?.length) L.push('', '【选项】', ...ch.options.map((x, i) => `${'ABCDEF'[i] || i + 1}. ${x}`));
    L.push('', '');
  }
  if (t.extras?.length) {
    L.push('════ 番外 ════', '');
    for (const x of t.extras) L.push(`【${x.title}】（${x.form}${x.afterChapter ? ` · 第 ${x.afterChapter} 章之后` : ''}）`, x.text, '', '');
  }
  return L.join('\n').replace(/\n{4,}/g, '\n\n\n');
}

/** 导出对话框：选带哪些内容、什么格式 */
export async function openExportDialog(storyId, title) {
  const s = sheet({ title: '导出游玩记录' });
  const opt = { danmu: false, options: false, extras: true, setting: true, memory: false, ooc: false };
  const row = (key, label, sub) => {
    const input = el('input', { type: 'checkbox', onchange: () => { opt[key] = input.checked; } });
    input.checked = opt[key];
    return el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, label, sub ? el('small', { text: sub }) : null), el('label', { class: 'switch' }, input, el('span')));
  };
  let fmt = 'json';
  const fmtBox = el('div', { class: 'seg' });
  for (const [v, label] of [['json', 'JSON'], ['txt', '纯文本']]) {
    const b = el('button', { class: v === fmt ? 'on' : '', onclick: () => { fmt = v; fmtBox.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); } }, label);
    fmtBox.append(b);
  }
  s.body.append(
    el('div', { class: 'hint', style: { marginTop: 0 } }, '导出当前这条线的正文（你的输入和每一章），给自己看或者丢给别的工具用。要换设备或备份，用“备份这个故事”。'),
    el('div', { class: 'card', style: { padding: '4px 14px' } },
      row('danmu', '带弹幕'),
      row('options', '带选项'),
      row('extras', '带番外', '每篇番外的当前版本'),
      row('setting', '带设定和角色卡', '角色卡的当前状态以前情档案为准'),
      row('memory', '带前情档案'),
      row('ooc', '带出戏对话')),
    el('div', { class: 'field' }, el('label', { text: '格式' }), fmtBox));
  s.foot.append(
    el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
    el('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          const t = await buildTranscript(storyId, opt);
          const d = new Date();
          const name = `墨游_${title || t.title}_游玩记录_${d.getMonth() + 1}月${d.getDate()}日`;
          if (fmt === 'txt') await saveFile(name + '.txt', transcriptToText(t), 'text/plain');
          else await saveFile(name + '.json', JSON.stringify(t, null, 1));
          s.close();
        } catch (e) { toast('导出失败：' + (e?.message || e), 3500); }
      },
    }, '导出'));
}
