import { unzip } from './tavern.js';
import { modulesFromMarkdown, modulesToMarkdown } from './state.js';

const FILE_LIMIT = 5 * 1024 * 1024;
const XML_LIMIT = 16 * 1024 * 1024;
const ROOT = 'word/document.xml';
const tagLine = /^[ \t]*<(\/?)([\p{L}_][\p{L}\p{N}_:.-]*)(?:[ \t]+[\p{L}_][\p{L}\p{N}_:.-]*[ \t]*=[ \t]*(?:"[^"\r\n]*"|'[^'\r\n]*'))*[ \t]*\/?>[ \t]*$/mu;
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const pathFor = name => `word/${name}.xml`;
const WORD_NS = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main']);
const children = el => [...(el?.children || [])].filter(c => c.namespaceURI === el.namespaceURI);
const child = (el, name) => children(el).find(c => c.localName === name);
const attr = (el, key = 'val') => el?.getAttributeNS(el.namespaceURI, key);
const descendants = (el, name) => [...el.getElementsByTagNameNS('*', name)];

function parseWord(data, expected) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding).decode(bytes);
  if (/<!DOCTYPE/i.test(text)) throw new Error('这个 Word 文件包含不支持的文档结构');
  const root = new DOMParser().parseFromString(text, 'application/xml').documentElement;
  if (!WORD_NS.has(root?.namespaceURI) || root.localName !== expected) throw new Error('Word 文件的正文结构无效');
  return root;
}

function wordNumbering(root) {
  const definitions = new Map();
  const lists = new Map();
  const counts = new Map();
  for (const el of children(root)) {
    if (el.localName === 'abstractNum') {
      const levels = children(el).filter(x => x.localName === 'lvl');
      definitions.set(attr(el, 'abstractNumId'), new Map(levels.map(x => [attr(x, 'ilvl'), {
        format: attr(child(x, 'numFmt')), start: Number(attr(child(x, 'start')) ?? 1),
      }])));
    }
    if (el.localName === 'num') lists.set(attr(el, 'numId'), el);
  }
  return num => {
    const id = attr(child(num, 'numId'));
    if (!id || id === '0') return '';
    const level = attr(child(num, 'ilvl')) || '0';
    const list = lists.get(id);
    const override = children(list).find(x => x.localName === 'lvlOverride' && attr(x, 'ilvl') === level);
    const def = definitions.get(attr(child(list, 'abstractNumId')))?.get(level);
    const format = attr(child(child(override, 'lvl'), 'numFmt')) || def?.format;
    if (!format || format === 'bullet') return '- ';
    if (format === 'none') return '';
    const start = Number(attr(child(override, 'startOverride')) ?? attr(child(child(override, 'lvl'), 'start')) ?? def?.start ?? 1);
    const active = counts.get(id) || new Map();
    const next = (active.get(level) ?? start - 1) + 1;
    active.set(level, next);
    for (const key of active.keys()) if (Number(key) > Number(level)) active.delete(key);
    counts.set(id, active);
    return `${next}. `;
  };
}

function styleLevels(root) {
  const out = new Map();
  for (const el of children(root).filter(c => c.localName === 'style')) {
    const id = attr(el, 'styleId');
    const named = /^(?:heading|标题)\s*([1-9])$/i.exec(attr(child(el, 'name')) || '');
    const outline = attr(child(child(el, 'pPr'), 'outlineLvl'));
    out.set(id, { level: outline != null && /^[0-8]$/.test(outline) ? Number(outline) + 1 : Number(named?.[1]) || null,
      toc: /^toc\s*\d+$/i.test(attr(child(el, 'name')) || ''), base: attr(child(el, 'basedOn')), runs: child(el, 'rPr'), num: child(child(el, 'pPr'), 'numPr') });
  }
  return out;
}

const present = (p, k) => { const el = child(p, k); return el ? !['0', 'false', 'off'].includes(attr(el)) : null; };
const fieldKind = text => /^\s*(PAGE|NUMPAGES|SECTIONPAGES|PAGEREF)\b/i.test(text) ? '页码' : /^\s*TOC\b/i.test(text) ? '目录' : '';

function readBody(body, styles, numbering) {
  const stats = new Map();
  const unique = new Map();
  const fields = [];
  const ignore = (label, count = 1) => { if (count) stats.set(label, (stats.get(label) || 0) + count); };
  const distinct = (label, id) => {
    const ids = unique.get(label) || new Set();
    if (id == null || !ids.has(id)) ignore(label);
    ids.add(id); unique.set(label, ids);
  };
  const inherited = (id, property) => {
    const seen = new Set();
    while (id && !seen.has(id)) {
      const style = styles.get(id);
      if (!style) break;
      const val = property(style);
      if (val != null) return val;
      seen.add(id); id = style.base;
    }
    return null;
  };
  const propsStyle = props => attr(child(props, 'pStyle')) || '';
  const fieldHidden = () => fields.some(f => f.hidden);
  function bodyChildren(parent) {
    return [...(parent?.children || [])].flatMap(el => {
      if (el.namespaceURI === body.namespaceURI) return [el];
      if (el.namespaceURI !== MC_NS || el.localName !== 'AlternateContent') return [];
      const choices = children(el);
      return bodyChildren(choices.find(x => x.localName === 'Choice') || choices.find(x => x.localName === 'Fallback'));
    });
  }
  const labelByKind = { footnoteReference:'脚注', endnoteReference:'尾注', commentRangeStart:'批注', commentReference:'批注' };
  function skip(el) {
    const kind = el.localName;
    if (kind === 'del' || kind === 'moveFrom') { ignore('已删除的修订'); return true; }
    if (Object.hasOwn(labelByKind, kind)) { distinct(labelByKind[kind], attr(el, 'id')); return true; }
    if (kind === 'drawing' || kind === 'pict' || kind === 'object' || kind === 'txbxContent') {
      const charts = descendants(el, 'chart').length;
      const boxes = kind === 'txbxContent' ? 1 : descendants(el, 'txbxContent').length;
      const pictures = descendants(el, 'pic').length || descendants(el, 'imagedata').length;
      ignore('图表', charts); ignore('文本框', boxes); ignore('图片', pictures || (!charts && !boxes ? 1 : 0));
      return true;
    }
    if (kind === 'sdt' && descendants(el, 'docPartGallery').some(x => /table of contents|目录/i.test(attr(x) || ''))) {
      ignore('目录'); return true;
    }
    if (kind === 'headerReference' || kind === 'footerReference') {
      distinct(kind === 'headerReference' ? '页眉' : '页脚', [...el.attributes].find(a => a.localName === 'id')?.value);
      return true;
    }
    return false;
  }
  function para(p) {
    const props = child(p, 'pPr');
    const id = propsStyle(props);
    if (/^TOC\d+$/i.test(id) || inherited(id, s => s.toc || null)) { ignore('目录段落'); return null; }
    const outline = attr(child(props, 'outlineLvl'));
    const conventional = /^(?:Heading|标题)([1-9])$/i.exec(id);
    const level = outline != null ? (/^[0-8]$/.test(outline) ? Number(outline) + 1 : null)
      : inherited(id, s => s.level) ?? (conventional ? Number(conventional[1]) : null);
    const pieces = [];
    const append = (s, marker) => {
      if (!s) return;
      const last = pieces.at(-1);
      if (last?.marker === marker) last.text += s;
      else pieces.push({ marker, text: s });
    };
    function walk(el, marker = '') {
      if (el.namespaceURI !== body.namespaceURI || skip(el)) return;
      const kind = el.localName;
      if (kind === 'pPr') { for (const c of children(child(el, 'sectPr'))) skip(c); return; }
      if (kind === 'rPr') return;
      if (kind === 'fldSimple') {
        const label = fieldKind(attr(el, 'instr') || '');
        if (label) { ignore(label); return; }
      }
      if (kind === 'fldChar') {
        const type = attr(el, 'fldCharType');
        if (type === 'begin') fields.push({ code:'', hidden:false });
        if (type === 'end') fields.pop();
        return;
      }
      if (kind === 'instrText') {
        const field = fields.at(-1);
        if (field && !field.hidden) {
          field.code += el.textContent;
          const label = fieldKind(field.code);
          if (label) { ignore(label); field.hidden = true; }
        }
        return;
      }
      if (['t', 'tab', 'br', 'cr', 'noBreakHyphen', 'softHyphen'].includes(kind)) {
        if (!fieldHidden()) {
          if (kind === 'br' && attr(el, 'type') === 'page') return;
          append(kind === 't' ? el.textContent : ({tab:'\t', br:'\n', cr:'\n', noBreakHyphen:'‑', softHyphen:'\u00ad'})[kind], marker);
        }
        return;
      }
      if (kind === 'r') {
        const rp = child(el, 'rPr');
        const runId = attr(child(rp, 'rStyle'));
        const bold = present(rp, 'b') ?? inherited(runId, s => present(s.runs,'b')) ?? inherited(id, s => present(s.runs,'b'));
        const italic = present(rp, 'i') ?? inherited(runId, s => present(s.runs,'i')) ?? inherited(id, s => present(s.runs,'i'));
        marker = (bold ? '**' : '') + (italic ? '*' : '');
      }
      for (const c of bodyChildren(el)) walk(c, marker);
    }
    walk(p);
    const raw = pieces.map(x => x.text).join('');
    if (!raw.trim()) return null;
    const prefix = numbering(child(props, 'numPr') || inherited(id, s => s.num));
    const formattedLines = [''];
    for (const { text, marker } of pieces) {
      text.split('\n').forEach((line, index) => {
        if (index) formattedLines.push('');
        formattedLines[formattedLines.length - 1] += marker ? line.replace(/^(\s*)(\S.*?)(\s*)$/, `$1${marker}$2${marker}$3`) : line;
      });
    }
    raw.split('\n').forEach((line, i) => {
      if (tagLine.test(line)) formattedLines[i] = line;
    });
    return { text: prefix + raw, formatted: prefix + formattedLines.join('\n'), level, list:!!prefix };
  }
  function table(t) {
    const rows = children(t).filter(r => r.localName === 'tr').map(r => children(r).filter(c => c.localName === 'tc').map(c => blocks(c)));
    if (!rows.length || !rows.some(row => row.some(cell => cell.length))) return null;
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const toMarkdown = key => {
      const cell = items => items.map(p => p[key].replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join('<br>');
      const lines = rows.map(row => '| ' + Array.from({ length:width }, (_, i) => cell(row[i] || [])).join(' | ') + ' |');
      lines.splice(1, 0, '| ' + Array(width).fill('---').join(' | ') + ' |');
      return lines.join('\n');
    };
    return { text:toMarkdown('text'), formatted:toMarkdown('formatted'), level:null, table:true };
  }
  function blocks(container) {
    const out = [];
    for (const el of bodyChildren(container)) {
      if (skip(el)) continue;
      if (el.localName === 'p') { const p = para(el); if (p) out.push(p); }
      else if (el.localName === 'tbl') { const t = table(el); if (t) out.push(t); }
      else out.push(...blocks(el));
    }
    return out;
  }
  const paragraphs = blocks(body);
  return { paragraphs, ignored: [...stats].map(([name,count]) => ({ name,count })) };
}

export async function readWordPreset(file) {
  if (!/\.docx$/i.test(file.name || '')) throw new Error('请在 Word 里另存为 .docx，再导入墨游');
  if (file.size > FILE_LIMIT) throw new Error('Word 文件最多 5 MB');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > FILE_LIMIT) throw new Error('Word 文件最多 5 MB');
  const entries = await unzip(bytes, { names: new Set([ROOT, pathFor('styles'), pathFor('numbering')]), maxEntryBytes: XML_LIMIT });
  const read = (path, expected) => {
    const entry = entries.find(e => e.name === path);
    if (entry?.error) throw new Error(entry.error);
    return entry?.data ? parseWord(entry.data,expected) : null;
  };
  const body = child(read(ROOT,'document'), 'body');
  if (!body) throw new Error('找不到 Word 正文，请确认这是 .docx 文件');
  const result = readBody(body, styleLevels(read(pathFor('styles'),'styles')), wordNumbering(read(pathFor('numbering'),'numbering')));
  if (!result.paragraphs.length) throw new Error('Word 文件里没有可导入的正文文字');
  return { filename:file.name, ...result };
}

const part = (title, text) => ({ title, text, included:true });
const prefixTitle = '使用说明';
const joined = blocks => blocks.join('\n\n');

// Read matched XML tags as text. Start offsets are in the normalized Word text.
function taggedSections(text, unwrap, allowWrapper = true) {
  const tags = [...text.matchAll(new RegExp(tagLine.source, 'gmu'))].filter(tag => !/\/>[ \t]*$/.test(tag[0]));
  const stack = [];
  const ranges = [];
  for (const tag of tags) {
    if (tag[1]) {
      const open = stack.pop();
      if (!open || open[2] !== tag[2]) return null;
      if (!stack.length) ranges.push({ title: tag[2], start:open.index, end:tag.index + tag[0].length, openEnd:open.index + open[0].length, closeStart:tag.index });
    } else stack.push(tag);
  }
  if (!ranges.length || stack.length) return null;
  const [first] = ranges;
  if (allowWrapper && ranges.length === 1 && !text.slice(0, first.start).trim() && !text.slice(first.end).trim()) {
    const inside = text.slice(first.openEnd, first.closeStart);
    const prefix = inside.match(/^\n{1,2}/)?.[0] || '';
    const suffix = inside.match(/\n{1,2}$/)?.[0] || '';
    const inner = inside.slice(prefix.length, inside.length - suffix.length);
    const nested = taggedSections(inner, unwrap, false);
    const rows = nested?.rows || [part(first.title, inner)];
    if (!inner.trim()) return null;
    if (!unwrap) {
      rows[0].text = text.slice(0, first.openEnd) + prefix + rows[0].text;
      rows.at(-1).text += suffix + text.slice(first.closeStart);
    }
    return { rows, source: unwrap ? inner : text, wrapper: true };
  }
  const rows = [];
  let introEnd = first.start;
  const hasUsage = /^(?:usage|usage[_-]?(?:notes|guide)|intro(?:duction)?|scope|instructions)$/i.test(first.title);
  if (hasUsage) introEnd = ranges[1]?.start ?? text.length;
  function add(title, from, to) {
    const chunk = text.slice(from, to);
    const separator = to < text.length ? chunk.match(/\n{1,2}$/)?.[0] || '' : '';
    rows.push({ ...part(title, chunk.slice(0, chunk.length - separator.length)), separator });
  }
  if (introEnd) add(prefixTitle, 0, introEnd);
  for (let i = hasUsage ? 1 : 0; i < ranges.length; i++) {
    const r = ranges[i];
    add(r.title, r.start, ranges[i + 1]?.start ?? text.length);
  }
  return { rows, source:text, wrapper:false };
}

function splitAtHeadings(blocks, heading) {
  const rows = [];
  let row = { title:prefixTitle, body:[], heading:null };
  for (const block of blocks) {
    const title = heading(block);
    if (title != null) {
      if (row.body.length || row.heading) rows.push(row);
      row = { title:title || '未命名条目', body:[], heading:block };
    } else row.body.push(block);
  }
  if (row.body.length || row.heading) rows.push(row);
  return rows;
}

function joinBlocks(blocks) {
  return blocks.map((b, i) => b.chosen + (i < blocks.length - 1 ? b.separator ?? '\n\n' : '')).join('');
}

function headingResult(group, source, sections) {
  return { group, wrapper:false,
    rows:sections.map(({ title, body, heading }) => ({
      ...part(title, joinBlocks(body)), sourceHeading:heading?.chosen,
      headingSeparator:heading?.separator, separator:(body.at(-1) || heading)?.separator,
    })),
    audit:{ source, reconstruction:joinBlocks(sections.flatMap(r => [r.heading, ...r.body].filter(Boolean))) },
  };
}

export function splitWordPreset(doc, { unwrap = true, emphasis = false } = {}) {
  const blocks = doc.paragraphs.map(p => ({ ...p, chosen:emphasis ? p.formatted : p.text }));
  const fallback = doc.filename.replace(/\.docx$/i, '');
  const h1 = blocks.find(p => p.level === 1);
  const group = h1?.text.trim() || fallback;
  const source = joined(blocks.map(p => p.chosen));
  const all = blocks.filter(p => p !== h1);
  if (blocks.some(p => p.level)) {
    const sections = splitAtHeadings(all, b => b.level === 2 ? b.text.trim().replace(/\s+/g, ' ') : null);
    return headingResult(group, joinBlocks(all), sections);
  }
  const tagged = taggedSections(source, unwrap);
  if (tagged) {
    return { ...tagged, group, audit:{
      source:tagged.source, reconstruction:tagged.rows.map(r => r.text + (r.separator || '')).join(''),
    } };
  }
  const markdown = /^##[ \t]+(.+)$/;
  const numbered = /^(?:[一二三四五六七八九十百]+、|\d+[.．、])\s*(\S.*)$/;
  const heading = (b, re) => !b.table && !b.list ? re.exec(b.text)?.[1]?.trim() ?? null : null;
  const lines = all.flatMap(b => {
    if (b.table || b.list || !b.text.includes('\n')) return [b];
    const marked = b.chosen.split('\n');
    const plain = b.text.split('\n');
    const expanded = plain.map((text, i) => ({ text, chosen:marked[i], separator:i < plain.length - 1 ? '\n' : '\n\n' }));
    return expanded.some(line => heading(line, markdown) || heading(line, numbered)) ? expanded : [b];
  });
  const isMarkdown = lines.some(b => heading(b, markdown));
  if (isMarkdown || lines.some(b => heading(b, numbered))) {
    const sections = splitAtHeadings(lines, b => heading(b, isMarkdown ? markdown : numbered));
    return headingResult(group, source, sections);
  }
  return { group, rows:[part(group, source)], wrapper:false, audit:{ source, reconstruction:source } };
}

export function wordImportMarkdown(rows) {
  const modules = rows.filter(r => r.included).map((r, i) => ({
    name:`${i}. ${r.title.trim().replace(/\s+/g, ' ') || '未命名条目'}`, text:r.text,
  }));
  const markdown = modulesToMarkdown(modules, { verbatim:true });
  const decoded = modulesFromMarkdown(markdown, '', { verbatim:true });
  for (let i = 0; i < modules.length; i++) {
    if (decoded[i]?.name !== modules[i].name || decoded[i]?.text !== modules[i].text) {
      const paragraph = firstDifferentParagraph(modules[i].text, decoded[i]?.text || '');
      throw new Error(`完整性校验未通过：第 ${i} 条「${modules[i].name}」，第 ${paragraph || 1} 段不一致`);
    }
  }
  if (decoded.length !== modules.length) throw new Error('完整性校验未通过：条目数不一致');
  return markdown;
}

export function firstDifferentParagraph(a, b) {
  if (a === b) return 0;
  const expected = a.split('\n\n'), actual = b.split('\n\n');
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) if (expected[i] !== actual[i]) return i + 1;
  return 1;
}
