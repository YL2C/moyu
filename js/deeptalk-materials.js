export const MATERIAL_FORMAT = 'moyu.deeptalk.materials';
export const MATERIAL_SLOTS = Object.freeze({ core_card: '核心名片', long_term_profile: '长期档案', sensitive_memory: '敏感记忆' });
export const MATERIAL_MAX_BYTES = 4 * 1024 * 1024;
export const RECALL_LABELS = Object.freeze({ always: '常驻', on_topic: '按话题', explicit_topic: '明确提及时', view_only: '仅查看' });

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
    ids.add(part.id);
    end = part.end;
    const { id, title, start, recall } = part;
    return { id, title, start, end, recall, ...(topical ? { topic: part.topic } : {}),
      ...(recall === 'view_only' && part.duplicateOf === 'core_card' ? { duplicateOf: 'core_card' } : {}) };
  });
  if (text.slice(end).trim()) throw new Error('资料末尾缺少段落索引');
  return checked;
}

export async function parseMaterialPackage(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > MATERIAL_MAX_BYTES) throw new Error('资料包过大或无法读取');
  let pack;
  try { pack = JSON.parse(source); } catch { throw new Error('资料包不是有效的 JSON 文件'); }
  if (pack?.format !== MATERIAL_FORMAT || pack.version !== 1 || pack.offsetUnit !== 'utf16') {
    throw new Error('请选择「墨游_日常聊天资料包.json」');
  }
  const expectedSlots = Object.keys(MATERIAL_SLOTS);
  if (!Array.isArray(pack.documents) || pack.documents.length !== expectedSlots.length) throw new Error('资料包需要完整的三份资料');
  const documents = {};
  for (const entry of pack.documents) {
    const { slot, text, sha256, sourceName } = entry || {};
    if (!expectedSlots.includes(slot) || Object.hasOwn(documents, slot)) throw new Error('资料包中的位置未知或重复');
    if (!shortText(text, MATERIAL_MAX_BYTES) || !shortText(sourceName, 250) || sha256 !== await checksum(text)) {
      throw new Error(`${MATERIAL_SLOTS[slot]}校验失败，请重新下载资料包`);
    }
    documents[slot] = { slot, text, sha256, sourceName, sections: checkSections(entry.sections, text, slot) };
  }
  return documents;
}

export function currentMaterial(record) {
  return record?.editions.find(edition => edition.id === record.currentId) ?? record?.original ?? null;
}

export function mergeMaterials(current, incoming) {
  const materials = { ...current };
  let changed = 0;
  for (const [slot, original] of Object.entries(incoming)) {
    const previous = materials[slot];
    if (previous?.original.sha256 === original.sha256) continue;
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
