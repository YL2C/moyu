import { backupDatabase, db, restoreChatBackup, vaultLocal } from './db.js';
import { captureVaultRecords, matchesVaultScope, restoreVaultRecords, validateManifest } from './vault-data.js';
import {
  CHUNK_SIZE, createVaultKey, unlockVaultKey, changeVaultPassword,
  digest, jsonBytes, readJson, sealObject, openObject,
} from './vault-crypto.js';

const keySessions = new Map();
const manifests = new Map();
const rowId = row => JSON.stringify([row.store, row.key]);

async function request(config, route, { body, signal } = {}) {
  if (!config?.url || !config?.token) throw new Error('请先填写备份服务器地址与服务器口令');
  let path;
  try { path = new URL(config.url); } catch { throw new Error('备份服务器地址格式不正确'); }
  if (path.protocol !== 'https:' || path.username || path.password || path.search || path.hash)
    throw new Error('加密备份需要有效的 HTTPS 地址');
  const response = await fetch(config.url + '/cloud-backup/v1/' + route, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error', signal,
    headers: { Authorization: 'Bearer ' + config.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('备份服务器口令有误');
    if (response.status === 404) throw new Error('未找到加密备份接口或文件，请确认服务器已更新');
    if (response.status === 409) throw new Error('云端备份发生更新，请重试');
    if (response.status === 422) throw new Error('部分备份文件尚未到达服务器，请重试');
    throw new Error('备份服务器暂时不可用（' + response.status + '）');
  }
  return response.json();
}

export const cloudVault = (config, signal) => request(config, 'vault', { signal });
export const vaultProfile = () => vaultLocal.get();

function sessionKey(config, profile) {
  return profile?.url === config.url ? keySessions.get(config.url) ?? profile.key : null;
}

export const isVaultUnlocked = (config, profile) => !!(config && sessionKey(config, profile));

export async function activateVault(config, { password, remember, create }) {
  const remote = await cloudVault(config);
  let key, envelope = remote.envelope;
  if (envelope) key = await unlockVaultKey(envelope, password);
  else {
    if (!create) throw new Error('服务器还没有加密备份，请先在原设备上创建');
    ({ key, envelope } = await createVaultKey(password));
    const confirmed = await request(config, 'vault/key', { body: { expected: null, envelope } });
    if (confirmed.envelope?.rev !== envelope.rev) throw new Error('服务器没有确认加密密钥');
  }
  const current = await vaultLocal.get();
  const profile = { url: config.url, keyId: envelope.keyId, device: current?.url === config.url ? current.device : crypto.randomUUID(),
    key: remember ? key : null, enabled: true };
  await vaultLocal.put(profile);
  keySessions.set(config.url, key);
  return profile;
}

export function clearVaultSession() { keySessions.clear(); manifests.clear(); }

export async function lockVault() {
  const profile = await vaultLocal.get();
  if (!profile) return;
  clearVaultSession();
  await vaultLocal.put({ ...profile, key: null });
}

export async function rotateVaultPassword(config, oldPassword, newPassword) {
  const { envelope } = await cloudVault(config);
  if (!envelope) throw new Error('还没有可修改密码的加密备份');
  const next = await changeVaultPassword(envelope, oldPassword, newPassword);
  const result = await request(config, 'vault/key', { body: { expected: envelope.rev, envelope: next } });
  if (result.envelope?.rev !== next.rev) throw new Error('服务器没有确认密码变更');
}

async function downloadObject(config, key, id, purpose, signal) {
  const response = await request(config, 'vault/object?id=' + encodeURIComponent(id), { signal });
  return openObject(key, id, response.ciphertext, purpose);
}

function requireMatchingKey(envelope, profile) {
  if (!envelope || envelope.keyId !== profile.keyId)
    throw new Error('此设备的密钥与云端不一致，请重新解锁');
}

async function readManifest(config, key, snapshot, signal) {
  const cached = manifests.get(snapshot.manifest);
  if (cached) return cached;
  const bytes = await downloadObject(config, key, snapshot.manifest, 'manifest:' + snapshot.id, signal);
  const document = validateManifest(readJson(bytes));
  if (manifests.size >= 4) manifests.delete(manifests.keys().next().value);
  manifests.set(snapshot.manifest, document);
  return document;
}

async function uploadChunks(config, batch, signal) {
  if (!batch.length) return;
  const response = await request(config, 'vault/objects', { body: { objects: batch }, signal });
  if (JSON.stringify(response.ack) !== JSON.stringify(batch.map(item => item[0])))
    throw new Error('服务器没有确认备份片段');
}

export async function publishVaultRecords(config, key, { rows, head, base = head, device, keyRev, signal, kind = 'complete', source }) {
  const old = base ? await readManifest(config, key, base, signal) : { rows: [] };
  const previous = new Map(old.rows.map(row => [rowId(row), row]));
  const records = [];
  let changed = rows.length !== old.rows.length;
  let batch = [];
  for (const row of rows) {
    signal?.throwIfAborted();
    const prior = previous.get(rowId(row));
    const parts = [];
    for (let offset = 0; offset < row.bytes.length; offset += CHUNK_SIZE) {
      const bytes = row.bytes.subarray(offset, offset + CHUNK_SIZE);
      const hash = await digest(bytes);
      const part = prior?.parts[parts.length];
      if (part?.hash === hash) parts.push(part);
      else {
        const object = await sealObject(key, bytes, 'chunk');
        parts.push({ hash, id: object.id });
        batch.push([object.id, object.ciphertext]);
        changed = true;
        if (batch.length >= 7) { await uploadChunks(config, batch, signal); batch = []; }
      }
    }
    if (prior?.parts.length !== parts.length) changed = true;
    records.push({ store: row.store, key: row.key, parts });
  }
  if (head && !changed) return head;
  await uploadChunks(config, batch, signal);
  const id = crypto.randomUUID();
  const document = { version: 1, kind, source, rows: records };
  const manifest = await sealObject(key, jsonBytes(document), 'manifest:' + id);
  await uploadChunks(config, [[manifest.id, manifest.ciphertext]], signal);
  const result = await request(config, 'vault/commit', { body: {
    id, device, manifest: manifest.id, parent: head?.id ?? null, keyRev,
    objects: [...new Set(records.flatMap(row => row.parts.map(part => part.id)))],
  }, signal });
  if (result.id !== id || !Number.isFinite(result.createdAt)) throw new Error('服务器没有确认加密备份');
  return { ...result, device, manifest: manifest.id };
}

export async function uploadVaultBackup(config, profile, signal) {
  const key = sessionKey(config, profile);
  if (!key) return null;
  const { envelope, snapshots } = await cloudVault(config, signal);
  requireMatchingKey(envelope, profile);
  return publishVaultRecords(config, key, { rows: await captureVaultRecords(), keyRev: envelope.rev, device: profile.device,
    head: snapshots.find(snapshot => snapshot.device === profile.device), signal });
}

export async function archiveLegacyVault(config, { onProgress = () => {} } = {}) {
  const profile = await vaultLocal.get();
  const key = sessionKey(config, profile);
  if (!key) throw new Error('请先解锁加密备份');
  const { envelope, snapshots } = await cloudVault(config);
  requireMatchingKey(envelope, profile);
  if (!snapshots.some(snapshot => snapshot.device === profile.device)) throw new Error('请先完成本机加密备份');
  const { snapshots: daily } = await request(config, 'vault/legacy-history');
  let previous;
  let total = 0;
  for (const [i, source] of [...daily, null].entries()) {
    const device = source ? 'legacy-' + source.replace(/[.]/g, '-') : 'legacy';
    const head = snapshots.find(snapshot => snapshot.device === device);
    if (head && source) { previous = head; continue; }
    onProgress(i + 1, daily.length + 1);
    const rows = [];
    let after = 0;
    while (true) {
      const query = new URLSearchParams({ after: String(after), ...(source ? { history: source } : {}) });
      const page = await request(config, 'vault/legacy?' + query);
      for (const record of page.records) {
        const { cursor, ...saved } = record;
        rows.push({ store: 'legacy', key: JSON.stringify([saved.device, saved.kind, saved.id]), bytes: jsonBytes(saved) });
      }
      if (page.next === null) break;
      if (page.next <= after) throw new Error('旧存档分页有误');
      after = page.next;
    }
    if (!rows.length) continue;
    previous = await publishVaultRecords(config, key, { rows, keyRev: envelope.rev, device,
      head, base: head ?? previous, source: source ?? '当前旧云端备份', kind: 'legacy' });
    total += rows.length;
  }
  return total;
}

export async function previewVault(config, snapshot) {
  const key = sessionKey(config, await vaultLocal.get());
  if (!key) throw new Error('请先解锁加密备份');
  const document = await readManifest(config, key, snapshot);
  return {
    kind: document.kind,
    source: document.source,
    count: document.rows.length,
    stories: document.rows.filter(row => row.store === 'stories').length,
    turns: document.rows.filter(row => row.store === 'kv' && row.key.startsWith('deeptalk.v1.turn.')).length,
    materials: document.rows.filter(row => row.store === 'material').length,
    materialKeys: document.rows.filter(row => row.store === 'material').map(row => row.key),
  };
}

async function retrieveRows(config, snapshot, scope, materialKey) {
  const key = sessionKey(config, await vaultLocal.get());
  if (!key) throw new Error('请先解锁加密备份');
  const document = await readManifest(config, key, snapshot);
  const selected = document.rows.filter(row => {
    if (scope === 'legacy') return row.store === 'legacy';
    if (scope === 'material') return row.store === 'material' && row.key === materialKey;
    return matchesVaultScope(row, scope) || scope === 'story' && row.store === 'kv' &&
      ['modules', 'packs', 'defaultRules', 'globalMemo', 'fwTemplates', 'fwBase'].includes(row.key);
  });
  const ids = [...new Set(selected.flatMap(row => row.parts.map(part => part.id)))];
  const blocks = new Map();
  const pending = [];
  for (let i = 0; i < ids.length; i += 7) pending.push(ids.slice(i, i + 7));
  async function downloadBatches() {
    while (pending.length) {
      const batch = pending.shift();
      const result = await request(config, 'vault/objects?ids=' + batch.join(','));
      if (!Array.isArray(result.objects) || result.objects.length !== batch.length)
        throw new Error('备份文件不完整');
      await Promise.all(result.objects.map(async ([id, ciphertext]) => {
        if (!batch.includes(id) || blocks.has(id)) throw new Error('备份文件编号不匹配');
        blocks.set(id, await openObject(key, id, ciphertext, 'chunk'));
      }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, downloadBatches));
  const rows = [];
  for (const row of selected) {
    const chunks = [];
    let size = 0;
    for (const { id, hash } of row.parts) {
      const bytes = blocks.get(id);
      if (!bytes || await digest(bytes) !== hash) throw new Error('备份片段校验失败');
      chunks.push(bytes);
      size += bytes.length;
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
    rows.push({ ...row, bytes });
  }
  return rows;
}

export async function restoreFromVault(config, snapshot, scope) {
  const rows = await retrieveRows(config, snapshot, scope);
  if (!rows.length) throw new Error('这个备份没有选定的内容');
  return restoreVaultRecords(rows, scope);
}

export async function downloadLegacyArchive(config, snapshot) {
  const rows = await retrieveRows(config, snapshot, 'legacy');
  return rows.map(row => readJson(row.bytes));
}


export async function restoreLegacyStory(archive, device, storyId) {
  const records = archive.filter(record => record.device === device && record.value);
  const match = records.find(record => record.kind === 'stories' && record.id === storyId);
  if (!match) throw new Error('找不到这份旧故事');
  const children = kind => records.filter(row => row.kind === kind && row.storyId === storyId && !row.deleted).map(row => row.value);
  return backupDatabase.restore({ story: match.value, nodes: children('nodes'), extras: children('extras') });
}

export async function restoreLegacyChat(archive, device) {
  const entries = archive.filter(record => record.device === device && record.kind === 'chat' && record.value && !record.deleted)
    .map(record => [record.id, record.value.data]);
  return restoreChatBackup({ app: 'moyu-chat-backup', schema: 1, entries });
}


export async function restoreVaultMaterial(config, snapshot, slot) {
  const [row] = await retrieveRows(config, snapshot, 'material', slot);
  if (!row) throw new Error('这个备份没有选定的资料');
  const { type, value } = readJson(row.bytes);
  if (type !== 'json' || !value || typeof value !== 'object') throw new Error('资料备份格式不正确');
  const materials = 'deeptalk.v1.materials';
  return db.kvUpdate([materials], values => ({
    values: { [materials]: { ...values[materials], [slot]: value } },
  }));
}
