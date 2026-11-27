import { MIGRATION_STORES, readMigrationDatabase } from './db.js';
import { localEntries, portableChapter, portableValue, restoreMigration } from './migration.js';
import { jsonBytes, readJson, toBase64 } from './vault-crypto.js';

const MATERIALS = 'deeptalk.v1.materials';
const scopeOf = (store, key) => {
  if (['stories', 'nodes', 'extras'].includes(store) ||
      store === 'kv' && (key.startsWith('disc.') || key.startsWith('background.discussion.'))) return 'story';
  if (store === 'kv' && key.startsWith('deeptalk.v1.')) return 'chat';
  return 'shared';
};

function withoutCredentials(key, value) {
  if (key !== 'relay' || !value || typeof value !== 'object') return value;
  const { token, ...settings } = value;
  return settings;
}

export async function captureVaultRecords() {
  const stores = await readMigrationDatabase();
  const rows = [];
  const settings = new Map(stores.kv);
  for (const [key, original] of stores.kv) {
    const value = withoutCredentials(key, portableValue(key, original, settings));
    if (key === MATERIALS && value && typeof value === 'object' && !Array.isArray(value)) {
      rows.push({ store: 'kv', key, bytes: jsonBytes({ type: 'material-index' }) });
      for (const [slot, material] of Object.entries(value))
        rows.push({ store: 'material', key: slot, bytes: jsonBytes({ type: 'json', value: material }) });
    } else if (value instanceof Blob) {
      const metadata = jsonBytes({ type: 'blob', mime: value.type, name: value.name ?? null, modified: value.lastModified ?? 0 });
      const file = new Uint8Array(await value.arrayBuffer());
      const bytes = new Uint8Array(4 + metadata.length + file.length);
      new DataView(bytes.buffer).setUint32(0, metadata.length);
      bytes.set(metadata, 4);
      bytes.set(file, metadata.length + 4);
      rows.push({ store: 'file', key, bytes });
    } else {
      rows.push({ store: 'kv', key, bytes: jsonBytes({ type: 'json', value }) });
    }
  }
  for (const store of MIGRATION_STORES.filter(name => name !== 'kv')) {
    for (const original of stores[store]) {
      let value = original;
      if (store === 'connections') { const { apiKey, ...rest } = original; value = rest; }
      if (store === 'nodes') value = portableChapter(original);
      if (store === 'extras') value = { ...original, versions: (original.versions || []).map(portableChapter) };
      rows.push({ store, key: original.id, bytes: jsonBytes({ type: 'json', value }) });
    }
  }
  for (const [key, value] of localEntries())
    rows.push({ store: 'local', key, bytes: jsonBytes({ type: 'json', value }) });
  return rows;
}

export function validateManifest(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.rows)) throw new Error('加密备份目录格式不正确');
  const keys = new Set();
  for (const row of manifest.rows) {
    if (!row || ![...MIGRATION_STORES, 'file', 'local', 'material', 'legacy'].includes(row.store) ||
        typeof row.key !== 'string' || !Array.isArray(row.parts) || !row.parts.length ||
        !row.parts.every(part => typeof part?.hash === 'string' && /^[a-f0-9]{64}$/.test(part.hash) &&
          typeof part.id === 'string' && /^[a-f0-9]{64}$/.test(part.id))) throw new Error('加密备份目录格式不正确');
    const id = JSON.stringify([row.store, row.key]);
    if (keys.has(id)) throw new Error('加密备份目录有重复记录');
    keys.add(id);
  }
  return manifest;
}

export function matchesVaultScope(row, scope) {
  if (row.store === 'legacy') return false;
  if (scope === 'all') return true;
  if (row.store === 'material') return scope === 'chat';
  if (row.store === 'local') return scope === 'story' && !row.key.endsWith('.playMode') && !row.key.includes('.settings.fold.');
  return scopeOf(row.store === 'file' ? 'kv' : row.store, row.key) === scope;
}

export async function restoreVaultRecords(rows, scope) {
  const localStores = await readMigrationDatabase();
  const current = new Map(localStores.kv);
  const secrets = new Map(localStores.connections.map(({ id, apiKey }) => [id, apiKey]));
  const stores = Object.fromEntries(MIGRATION_STORES.map(store => [store, []]));
  const local = [];
  const files = [];
  const materials = [];
  let hasMaterialIndex = false;
  for (const row of rows) {
    const { store, key, bytes } = row;
    if (!matchesVaultScope(row, scope)) continue;
    if (store === 'file') {
      if (bytes.length < 4) throw new Error('备份附件不完整');
      const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      if (length > bytes.length - 4) throw new Error('备份附件不完整');
      const meta = readJson(bytes.subarray(4, 4 + length));
      if (meta.type !== 'blob') throw new Error('备份附件格式不正确');
      files.push([key, { type: meta.mime, name: meta.name, modified: meta.modified, original: toBase64(bytes.subarray(4 + length)) }]);
      continue;
    }
    const entry = readJson(bytes);
    if (store === 'kv' && key === MATERIALS && entry.type === 'material-index') { hasMaterialIndex = true; continue; }
    if (entry.type !== 'json') throw new Error('备份记录格式不正确');
    const { value } = entry;
    if (store === 'material') materials.push([key, value]);
    else if (store === 'local') local.push([key, value]);
    else if (store === 'kv') stores.kv.push([key, value]);
    else {
      if (value?.id !== key) throw new Error('备份记录编号不匹配');
      stores[store].push(store === 'connections' ? { ...value, apiKey: secrets.get(key) ?? '' } : value);
    }
  }
  if (hasMaterialIndex) stores.kv.push([MATERIALS, Object.fromEntries(materials)]);
  if (scope !== 'all') {
    const shared = new Map(current);
    if (scope === 'story') {
      // Restore missing global references without replacing shared settings or unrelated chat.
      for (const row of rows) if (row.store === 'kv' && scopeOf(row.store, row.key) === 'shared' &&
          ['modules', 'packs', 'defaultRules', 'globalMemo', 'fwTemplates', 'fwBase'].includes(row.key) &&
          !shared.has(row.key)) {
        const saved = readJson(row.bytes);
        if (saved.type === 'json') shared.set(row.key, saved.value);
      }
    }
    stores.kv.push(...[...shared].filter(([key]) => scopeOf('kv', key) !== scope));
    for (const store of MIGRATION_STORES.filter(name => name !== 'kv'))
      if (scopeOf(store, '') !== scope) stores[store] = localStores[store];
    local.push(...localEntries().filter(([key]) => !matchesVaultScope({ store: 'local', key }, scope)));
  } else {
    const token = current.get('relay')?.token;
    const relay = stores.kv.find(([key]) => key === 'relay');
    if (relay && relay[1]) {
      if (token && current.get('relay')?.url === relay[1].url) relay[1].token = token;
      else relay[1].on = false;
    }
  }
  await restoreMigration({ stores, local, files });
}
