import { uid } from './util.js';
import { readTavernFile, detectKind } from './tavern.js';

const LIMIT = 20 * 1024 * 1024;
export function bytesToBase64(bytes) {
  let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
export function attachmentBytes(attachment) {
  return Uint8Array.from(atob(attachment.original), c => c.charCodeAt(0));
}
const valueText = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const entriesOf = value => Array.isArray(value) ? value : Object.values(value || {});
export function cardSections(json) {
  const kind = detectKind(json), d = json.data || json, sections = [];
  const add = (key, name, value) => { const text = valueText(value).trim(); if (text) sections.push({ key, name, text, selected: true }); };
  if (kind === 'card') {
    const values = { ...d, description: d.description || d.char_persona, first_mes: d.first_mes || d.char_greeting, mes_example: d.mes_example || d.example_dialogue };
    for (const [key, name] of [['description','人物设定'],['personality','性格'],['scenario','场景'],['first_mes','开场白'],['mes_example','示例对白'],['system_prompt','系统提示'],['post_history_instructions','后置提示'],['creator_notes','作者备注']]) add(key, name, values[key]);
    add('alternate_greetings', '其他开场', d.alternate_greetings?.length ? d.alternate_greetings : null);
    add('depth_prompt', '深度提示', d.extensions?.depth_prompt?.prompt);
  }
  const entries = entriesOf(kind === 'worldbook' ? d.entries : d.character_book?.entries);
  entries.forEach((entry, i) => add('book:' + i, '世界书 · ' + (entry.comment || entry.name || (entry.keys || entry.key || []).join('、') || `条目${i + 1}`), entry.content));
  if (kind === 'preset') (json.prompts || []).forEach((p, i) => { if (!p.marker) add('prompt:' + i, p.name || `提示${i + 1}`, p.content); });
  return sections;
}

export async function readAttachment(file) {
  if (file.size > LIMIT) throw new Error('单个附件最多20MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > LIMIT) throw new Error('单个附件最多20MB');
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v);
  const name = file.name || '附件', lower = name.toLowerCase();
  if (lower.endsWith('.png') && !png) throw new Error('文件实际不是PNG，不能恢复已丢失的角色卡数据');
  const out = { id: uid(), name, size: bytes.length, mime: png ? 'image/png' : 'application/octet-stream', original: bytesToBase64(bytes), sections: [], items: [] };
  if (png || lower.endsWith('.json')) {
    if (!png && lower.endsWith('.png')) throw new Error('文件实际不是PNG，不能恢复已丢失的角色卡数据');
    const parsed = await readTavernFile({ name: png ? name.replace(/\.[^.]+$/, '') + '.png' : name, arrayBuffer: async () => bytes });
    if (!parsed.items.length) throw new Error(parsed.skipped[0]?.why || '没有找到角色卡数据');
    out.items = parsed.items;
    out.kind = detectKind(out.items[0].json);
    if (!['card','worldbook','preset'].includes(out.kind)) throw new Error('暂支持角色卡、世界书和预设JSON');
    out.sections = cardSections(out.items[0].json);
    if (!out.sections.length) throw new Error('文件中没有可用的文字内容');
    const d = out.items[0].json.data || out.items[0].json;
    out.cardName = d.name || name;
    out.config = { regex: (d.extensions?.regex_scripts || []).length, extensions: Object.keys(d.extensions || {}) };
  } else if (/\.(md|txt)$/i.test(name)) {
    out.kind = 'text'; out.mime = lower.endsWith('.md') ? 'text/markdown' : 'text/plain';
    out.sections = [{ key: 'text', name: '文件正文', text: new TextDecoder().decode(bytes), selected: true }];
  } else throw new Error('请选择原始PNG角色卡、JSON、TXT或MD文件；暂不识别普通图片');
  return out;
}

export function attachmentContext(attachment) {
  if (attachment.include === false) return '';
  const sections = attachment.sections.filter(s => s.selected !== false);
  return sections.length ? `【附件资料 · ${attachment.name}】\n` + sections.map(s => `〔${s.name}〕\n${s.text}`).join('\n\n') : '';
}

export function selectedImport(attachment) {
  if (!attachment.items?.length) throw new Error('此附件不含酒馆卡结构');
  const json = structuredClone(attachment.items[0].json), d = json.data || json;
  const selected = new Set(attachment.sections.filter(s => s.selected !== false).map(s => s.key));
  if (!selected.size) throw new Error('请先选择要导入的内容');
  if (attachment.kind === 'preset') { json.prompts = (json.prompts || []).filter((p,i) => selected.has('prompt:' + i)); return json; }
  const sourceEntries = entriesOf(attachment.kind === 'worldbook' ? d.entries : d.character_book?.entries);
  const entries = sourceEntries.filter((e,i) => selected.has('book:' + i));
  const characterSelected = [...selected].some(key => !key.startsWith('book:'));
  if (attachment.kind === 'worldbook' || !characterSelected) return { name: (d.name || attachment.name) + ' 的世界书', entries };
  const result = { name: d.name || attachment.cardName || '未命名角色' };
  for (const key of ['description','personality','scenario','first_mes','mes_example','system_prompt','post_history_instructions','alternate_greetings','creator_notes']) {
    if (selected.has(key)) result[key] = key === 'alternate_greetings' ? d[key] : attachment.sections.find(s => s.key === key)?.text || '';
  }
  result.character_book = entries.length ? { ...(d.character_book || {}), entries } : undefined;
  // 原文件保留全部配置。导入时仅传递用户选中的文字，脚本永不执行。
  result.extensions = selected.has('depth_prompt') ? { depth_prompt: d.extensions?.depth_prompt } : {};
  return { spec: 'chara_card_v3', spec_version: '3.0', data: result };
}
