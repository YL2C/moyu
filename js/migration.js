// 墨游完整迁移：浏览器端生成和解密迁移包。
import { MIGRATION_STORES, readMigrationDatabase, replaceMigrationDatabase } from './db.js';
import { DB_NAME } from './personal.js';
import { bytesToBase64, attachmentBytes } from './attachments.js';

export const MIGRATION_PASSWORD_LENGTH = 12;
export const MIGRATION_NOTICE_KEY = DB_NAME + '.migrationNotice';

const encoder = new TextEncoder();
const magic = encoder.encode('MOYU-MIGRATION-V1\n');
const saltSize = 16;
const ivSize = 12;
const headerSize = magic.length + saltSize + ivSize;
const iterations = 600_000;
const interrupted = '迁移前未完成生成，已保留当时存下的内容。';
const localKey = key => key === DB_NAME + '.curStory' || key === DB_NAME + '.playMode' ||
  key.startsWith('moyu-yl2c.settings.fold.') || key.startsWith('moyu-yl2c.protagonist.fold.');

async function migrationKey(password, salt, usage) {
  if (!globalThis.crypto?.subtle) throw new Error('完整迁移需要用 HTTPS 打开墨游');
  const subtle = crypto.subtle;
  const material = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, [usage]);
}

export function localEntries() {
  try {
    return Object.keys(localStorage).filter(localKey).map(key => [key, localStorage.getItem(key)]);
  } catch {
    return [];
  }
}

export async function exportMigration(password) {
  if ([...password].length < MIGRATION_PASSWORD_LENGTH || !password.trim()) {
    throw new Error(`请设置至少 ${MIGRATION_PASSWORD_LENGTH} 个字符的迁移密码`);
  }
  if (!globalThis.crypto?.subtle) throw new Error('完整迁移需要用 HTTPS 打开墨游');
  const local = localEntries();
  const stores = await readMigrationDatabase();
  const files = [];
  const kv = [];
  for (const [key, value] of stores.kv) {
    if (value instanceof Blob) {
      files.push([key, {
        name: typeof value.name === 'string' ? value.name : null,
        type: value.type,
        modified: value.lastModified ?? 0,
        original: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      }]);
    } else kv.push([key, value]);
  }
  stores.kv = kv;

  const header = new Uint8Array(headerSize);
  header.set(magic);
  const salt = crypto.getRandomValues(header.subarray(magic.length, magic.length + saltSize));
  const iv = crypto.getRandomValues(header.subarray(magic.length + saltSize));
  const key = await migrationKey(password, salt, 'encrypt');
  const payload = encoder.encode(JSON.stringify({ stores, local, files }));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, payload);
  return new Blob([header, encrypted], { type: 'application/octet-stream' });
}

function record(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateEntries(entries, validValue) {
  return Array.isArray(entries) && entries.every(entry =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && validValue(entry[1], entry[0]));
}

const hasMigrationHeader = bytes => magic.every((byte, index) => byte === bytes[index]);

export async function isMigrationFile(file) {
  if (/\.moyu$/i.test(file.name)) return true;
  const prefix = new Uint8Array(await file.slice(0, magic.length).arrayBuffer());
  return hasMigrationHeader(prefix);
}

export async function openMigration(file, password) {
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer());
  if (header.length !== headerSize || !hasMigrationHeader(header) ||
      file.size < headerSize + 16) {
    throw new Error('请选择这一版本墨游导出的 .moyu 完整迁移包');
  }
  const salt = header.subarray(magic.length, magic.length + saltSize);
  const iv = header.subarray(magic.length + saltSize);
  const key = await migrationKey(password, salt, 'decrypt');
  const ciphertext = await file.slice(headerSize).arrayBuffer();
  let snapshot;
  try {
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, ciphertext);
    snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear));
  } catch {
    throw new Error('密码不正确，或迁移包已损坏');
  }
  if (!record(snapshot?.stores) || !MIGRATION_STORES.every(name =>
    name === 'kv' ? validateEntries(snapshot.stores.kv, () => true) :
      Array.isArray(snapshot.stores[name]) && snapshot.stores[name].every(item => record(item) && typeof item.id === 'string')
  ) || !validateEntries(snapshot.local, (value, key) => localKey(key) && typeof value === 'string') ||
      !validateEntries(snapshot.files, file =>
        record(file) && (file.name === null || typeof file.name === 'string') &&
        typeof file.type === 'string' && typeof file.original === 'string' && Number.isFinite(file.modified))) {
    throw new Error('迁移包的数据格式不正确');
  }
  return snapshot;
}

export function portableChapter(chapter) {
  const { relayJob, relayContext, ...saved } = chapter;
  if (saved.status === 'streaming' || relayJob) {
    saved.status = saved.text?.trim() ? 'partial' : 'error';
    saved.error = { kind: 'interrupted', message: interrupted, hint: '可以续写或重新生成。' };
    saved.thinking = false;
  }
  return saved;
}

export function portableValue(key, value, values) {
  if (key.startsWith('deeptalk.v1.turn.') && Array.isArray(value?.replies)) {
    const replies = value.replies.map(reply => {
      if (reply?.status !== 'running' && !reply?.relayJob) return reply;
      const { relayJob, relayServer, ...saved } = reply;
      return { ...saved, status: saved.text?.trim() ? 'partial' : 'error', error: interrupted };
    });
    return { ...value, replies };
  }
  if (key.startsWith('background.') && ['running', 'pending'].includes(value?.state)) {
    const { job, server, ...saved } = value;
    return { ...saved, state: 'error', error: interrupted };
  }
  if (!key.startsWith('disc.') || !Array.isArray(value?.messages)) return value;
  const messages = value.messages.map(message => {
    if (!message.taskId && !message.streaming) return message;
    const { taskId, streaming, ...saved } = message;
    const task = values.get(`background.discussion.${value.id}.reply.${taskId}`);
    if (typeof task?.text === 'string' && (task.state === 'done' || task.text.length > (saved.content?.length || 0))) {
      saved.content = task.text;
    }
    if (task?.cost) saved.cost = task.cost;
    saved.error = task?.state === 'done' ? '' : interrupted;
    return saved;
  });
  return { ...value, messages };
}

export async function restoreMigration({ stores, local, files }) {
  const values = new Map(stores.kv);
  if (values.size !== stores.kv.length) throw new Error('迁移包包含重复的设置记录');
  for (const [key, file] of files) {
    if (values.has(key)) throw new Error('迁移包包含重复的文件记录');
    const bytes = attachmentBytes(file);
    const options = { type: file.type, lastModified: file.modified };
    values.set(key, file.name === null ? new Blob([bytes], options) : new File([bytes], file.name, options));
  }
  // 迁移已保存的内容。后台任务属于旧入口，避免新入口自动接回或重新请求。
  const nodes = stores.nodes.map(portableChapter);
  const extras = stores.extras.map(({ pending, ...extra }) => ({
    ...extra, versions: (extra.versions || []).map(portableChapter),
  }));
  const kv = [...values].map(([key, value]) => [key, portableValue(key, value, values)]);
  await replaceMigrationDatabase({ ...stores, kv, nodes, extras });

  try {
    for (const key of Object.keys(localStorage).filter(localKey)) localStorage.removeItem(key);
    for (const [key, value] of local) localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
