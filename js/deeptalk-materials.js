export const MATERIAL_FORMAT = 'moyu.deeptalk.materials';
export const MATERIAL_SLOTS = Object.freeze({ core_card: '核心名片', long_term_profile: '长期档案', sensitive_memory: '敏感记忆' });
export const TOPIC_FORMAT = 'moyu.deeptalk.topics';
export const TOPIC_SLOTS = Object.freeze({ fitness: '健身与运动', shengweian: '兰瓷×颜令' });
export const MATERIAL_LABELS = Object.freeze({ ...MATERIAL_SLOTS, ...TOPIC_SLOTS });
export const MATERIAL_MAX_BYTES = 4 * 1024 * 1024;
export const RECALL_LABELS = Object.freeze({ always: '常驻', on_topic: '按话题', explicit_topic: '明确提及时', view_only: '仅查看', soft_recall: '专题联想' });

const shortText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

async function checksum(text) {
  if (!globalThis.crypto?.subtle) throw new Error('请通过 HTTPS 打开墨游以校验资料包');
  const bytes = new TextEncoder().encode(text);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function checkSections(sections, text, slot) {
  if (!Array.isArray(sections) || !sections.length || sections.length > 600) throw new Error('资料缺少有效的段落索引');
  let end = 0;
  const ids = new Set();
  const sensitive = slot === 'sensitive_memory';
  const isTopic = Object.hasOwn(TOPIC_SLOTS, slot);
  const checked = sections.map(part => {
    if (!part || !shortText(part.id, 100) || ids.has(part.id) || !shortText(part.title, 150) || !Object.hasOwn(RECALL_LABELS, part.recall) ||
        !Number.isInteger(part.start) || !Number.isInteger(part.end) || part.start < end || part.end <= part.start || part.end > text.length ||
        text.slice(end, part.start).trim() || !text.slice(part.start, part.end).trim()) {
      throw new Error('资料段落索引不完整或范围错误');
    }
    const topical = ['on_topic', 'explicit_topic'].includes(part.recall);
    if ((topical && !shortText(part.topic, 70)) || (sensitive && !['view_only', 'explicit_topic'].includes(part.recall))) {
      throw new Error('资料的调用范围设置无效');
    }
    if (isTopic ? !['soft_recall', 'view_only'].includes(part.recall) || !shortText(part.hint, 120) : part.recall === 'soft_recall') {
      throw new Error('专题缺少有效的目录说明');
    }
    ids.add(part.id);
    end = part.end;
    const { id, title, start, recall } = part;
    return { id, title, start, end, recall, ...(topical ? { topic: part.topic } : {}),
      ...(isTopic ? { hint: part.hint, ...(part.overview === true ? { overview: true } : {}) } : {}),
      ...(recall === 'view_only' && part.duplicateOf === 'core_card' ? { duplicateOf: 'core_card' } : {}) };
  });
  if (text.slice(end).trim()) throw new Error('资料末尾缺少段落索引');
  return checked;
}

export async function parseMaterialPackage(source, { topicsOnly = false } = {}) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MATERIAL_MAX_BYTES) throw new Error('资料包过大或无法读取');
  let pack;
  try { pack = JSON.parse(source); } catch { throw new Error('资料包不是有效的 JSON 文件'); }
  if (![MATERIAL_FORMAT, TOPIC_FORMAT].includes(pack?.format) || pack.version !== 1 || pack.offsetUnit !== 'utf16') {
    throw new Error('请选择墨游的日常聊天资料包或专题资料包');
  }
  if (topicsOnly && pack.format !== TOPIC_FORMAT) throw new Error('请选择墨游的专题资料包');
  const isTopic = pack.format === TOPIC_FORMAT;
  const expectedSlots = Object.keys(isTopic ? TOPIC_SLOTS : MATERIAL_SLOTS);
  if (!Array.isArray(pack.documents) || pack.documents.length !== expectedSlots.length) throw new Error(`资料包需要完整的${isTopic ? '两份专题' : '三份资料'}`);
  const documents = {};
  for (const entry of pack.documents) {
    const { slot, text, sha256, sourceName } = entry || {};
    if (!expectedSlots.includes(slot) || Object.hasOwn(documents, slot)) throw new Error('资料包中的位置未知或重复');
    if (!shortText(text, MATERIAL_MAX_BYTES) || !shortText(sourceName, 250) || sha256 !== await checksum(text)) {
      throw new Error(`${MATERIAL_LABELS[slot]}校验失败，请重新下载资料包`);
    }
    documents[slot] = { slot, text, sha256, sourceName, sections: checkSections(entry.sections, text, slot),
      ...(isTopic ? { curatedIndex: true } : {}) };
  }
  return documents;
}

export async function parseTopicDocument(slot, file) {
  if (!Object.hasOwn(TOPIC_SLOTS, slot) || file.size > MATERIAL_MAX_BYTES) throw new Error('专题文档不能超过 4 MB');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('请选择 UTF-8 编码的 Markdown 或 TXT 文件'); }
  if (!text.trim()) throw new Error('这份专题文档是空的');
  // 标题及说明是目录数据，原文保留导入时的字节顺序。
  const headings = [...text.matchAll(/^[ \t\uFEFF]{0,3}\\?#{1,6}[ \t]+([^\r\n]+)/gm)].map(match => ({
    start: match.index, body: match.index + match[0].length,
    title: match[1].trim().replace(/^\*\*|\*\*$/g, '').slice(0, 150) || '正文',
  }));
  if (!headings.length || text.slice(0, headings[0].start).trim()) headings.unshift({ start: 0, body: 0, title: '正文' });
  if (headings.length > 600) throw new Error('专题文档最多支持 600 个章节');
  const sections = headings.map(({ title, start, body }, index) => {
    const end = headings[index + 1]?.start ?? text.length;
    const hasBody = text.slice(body, end).split(/\r?\n/).some(line => line.trim() && !/^\s*\\?-{3,}\s*$/.test(line));
    return { id: `${slot}-${index + 1}`, title, start, end, recall: hasBody ? 'soft_recall' : 'view_only', hint: title.slice(0, 48) };
  });
  return { slot, text, sourceName: file.name, sha256: await checksum(text), sections };
}

export function currentMaterial(record) {
  return record?.editions.find(edition => edition.id === record.currentId) ?? record?.original ?? null;
}

export function mergeMaterials(current, incoming) {
  const materials = { ...current };
  let changed = 0;
  for (const [slot, original] of Object.entries(incoming)) {
    const previous = materials[slot];
    if (previous?.original.sha256 === original.sha256) {
      if (original.curatedIndex && JSON.stringify(previous.original.sections) !== JSON.stringify(original.sections)) {
        materials[slot] = { ...previous, original: { ...previous.original, sections: original.sections, curatedIndex: true } };
        changed++;
      }
      continue;
    }
    const editions = previous ? [...new Map([previous.original, ...previous.editions]
      .filter(edition => edition.id !== original.sha256).map(edition => [edition.id, edition])).values()] : [];
    materials[slot] = { original: { ...original, id: original.sha256, at: Date.now() }, editions, currentId: null };
    changed++;
  }
  return { materials, changed };
}

export function editMaterial(record, baseId, id, text, manualOnly, editionId) {
  const active = currentMaterial(record);
  if (active?.id !== baseId) throw new Error('这份资料刚被更新，请重新打开后编辑');
  const index = active.sections.findIndex(part => part.id === id);
  if (index < 0 || !shortText(text, 100_000)) throw new Error('该段落不能为空，长度最多十万字');
  const part = active.sections[index];
  const end = part.start + text.length;
  const delta = end - part.end;
  const sections = active.sections.map((entry, i) => {
    if (i === index) return { ...entry, end, manualOnly: !!manualOnly };
    if (i > index) return { ...entry, start: entry.start + delta, end: entry.end + delta };
    return entry;
  });
  const edition = { ...active, id: editionId, at: Date.now(), sections,
    text: active.text.slice(0, part.start) + text + active.text.slice(part.end) };
  return { ...record, editions: [edition, ...record.editions], currentId: editionId };
}
