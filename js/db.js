// 墨游 · 本机存储（IndexedDB）
// 和旧版不同：保存失败会直接提示，不会悄悄丢进度。

import { toast, uid } from './util.js';
import { DB_NAME } from './personal.js';
import { BACKUP_STORES, BACKUP_META, BACKUP_QUEUE, upgradeBackup, backupChanged, queueChange, trackBackup, CHAT_THREAD, CHAT_TURN, isChatBackupKey, queueChatChange, portableChatValue } from './backup-store.js';

const DB_VER = 3;
export const SCHEMA = 1; // 存档格式版本，以后升级格式时据此迁移

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      upgradeBackup(db);
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('connections')) db.createObjectStore('connections', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stories')) db.createObjectStore('stories', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('nodes')) {
        const s = db.createObjectStore('nodes', { keyPath: 'id' });
        s.createIndex('storyId', 'storyId', { unique: false });
      }
      if (!db.objectStoreNames.contains('extras')) {
        const s = db.createObjectStore('extras', { keyPath: 'id' }); // 番外，不进正史
        s.createIndex('storyId', 'storyId', { unique: false });
      }
    };
    req.onsuccess = () => {
      const connection = req.result;
      connection.onversionchange = () => { connection.close(); dbPromise = null; };
      resolve(connection);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => toast('请关闭其他打开着墨游的页面后再试');
  });
  return dbPromise;
}

function run(store, mode, fn, key) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tracked = mode === 'readwrite' && (BACKUP_STORES.includes(store) || (store === 'kv' && isChatBackupKey(key)));
    const tx = db.transaction(tracked ? [store, BACKUP_META, BACKUP_QUEUE] : store, mode);
    const os = tx.objectStore(store);
    let result;
    const r = fn(os, tx);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    tx.oncomplete = () => {
      resolve(result);
      if (mode === 'readwrite' && MIGRATION_STORES.includes(store)) backupChanged();
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中止'));
  }));
}

let lastWarn = 0;
function reportWriteError(e) {
  const now = Date.now();
  if (now - lastWarn < 4000) return;
  lastWarn = now;
  const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
  toast(quota ? '保存失败：设备存储空间不足。请先导出备份。' : '保存失败：' + (e?.message || e), 5000);
  console.error('[墨游] 保存失败', e);
}

// Local revisions for the chat search cache. They are independent of backup settings.
const STORY_LOOKUP_RESET = 'storyLookupReset';
const storyLookupKey = id => ['storyLookup', id];
function touchStoryLookup(tx, ids) {
  const revision = uid();
  for (const id of new Set(ids)) {
    if (typeof id === 'string' && id) tx.objectStore(BACKUP_META).put(revision, storyLookupKey(id));
  }
}

async function readStoryLookup(storyId) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['stories', BACKUP_META], 'readonly');
    const stories = tx.objectStore('stories');
    const meta = tx.objectStore(BACKUP_META);
    const reset = meta.get(STORY_LOOKUP_RESET);
    const entries = [];
    const request = storyId === undefined ? stories.getAll() : stories.get(storyId);
    request.onsuccess = () => {
      const records = storyId === undefined ? request.result : [request.result].filter(Boolean);
      for (const story of records) entries.push({ story, revision: meta.get(storyLookupKey(story.id)) });
    };
    tx.oncomplete = () => resolve(entries.map(({ story, revision }) => ({
      story, stamp: (reset.result || '') + '/' + (revision.result || ''),
    })));
    tx.onabort = () => reject(tx.error || new Error('无法读取跑团存档'));
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', (os) => os.get(key)),
  all: (store) => run(store, 'readonly', (os) => os.getAll()),
  byStory: (storyId) => run('nodes', 'readonly', (os) => os.index('storyId').getAll(storyId)),
  storyLookupCatalog: () => readStoryLookup(),
  storyLookupStamp: async id => (await readStoryLookup(id))[0]?.stamp,
  extrasOf: (storyId) => run('extras', 'readonly', (os) => os.index('storyId').getAll(storyId)),
  async put(store, value, key) {
    let r;
    try {
      r = await run(store, 'readwrite', (os, tx) => {
        const request = key === undefined ? os.put(value) : os.put(value, key);
        if (store === 'stories' || store === 'nodes') touchStoryLookup(tx, [store === 'stories' ? value.id : value.storyId]);
        if (BACKUP_STORES.includes(store) && !(store === 'nodes' && value.status === 'streaming')) {
          trackBackup(tx, () => queueChange(tx, store, value.id, value));
        }
        if (store === 'kv' && isChatBackupKey(key)) trackBackup(tx, () => queueChatChange(tx, key, value));
        return request;
      }, key);
    } catch (e) { reportWriteError(e); throw e; }
    // 告诉其他还开着的页面（比如在后台继续生成的游玩页）：这条数据变了
    if (store !== 'kv') { try { window.dispatchEvent(new CustomEvent('moyu:put', { detail: { store, obj: value } })); } catch {} }
    return r;
  },
  async updateStory(id, update) {
    let saved, failure;
    try {
      await run('stories', 'readwrite', (store, tx) => {
        const request = store.get(id);
        request.onsuccess = () => {
          try {
            saved = update(request.result);
            store.put(saved);
            touchStoryLookup(tx, [id]);
            trackBackup(tx, () => queueChange(tx, 'stories', id, saved));
          } catch (error) {
            failure = error;
            store.transaction.abort();
          }
        };
      });
    } catch (error) {
      if (failure) throw failure;
      reportWriteError(error);
      throw error;
    }
    try { window.dispatchEvent(new CustomEvent('moyu:put', { detail: { store: 'stories', obj: saved } })); } catch {}
    return saved;
  },
  async putMany(store, values) {
    try {
      return await run(store, 'readwrite', (os, tx) => {
        for (const v of values) os.put(v);
        if (store === 'stories' || store === 'nodes')
          touchStoryLookup(tx, values.map(value => store === 'stories' ? value.id : value.storyId));
        if (BACKUP_STORES.includes(store)) trackBackup(tx, () => {
          for (const v of new Map(values.map(value => [value.id, value])).values()) queueChange(tx, store, v.id, v);
        });
      });
    } catch (e) { reportWriteError(e); throw e; }
  },
  async del(store, key) {
    try { return await run(store, 'readwrite', (os, tx) => {
      if (store === 'stories') touchStoryLookup(tx, [key]);
      if (store === 'nodes') {
        const node = os.get(key);
        node.onsuccess = () => touchStoryLookup(tx, [node.result?.storyId]);
      }
      if (BACKUP_STORES.includes(store)) trackBackup(tx, () => queueChange(tx, store, key));
      if (store === 'kv' && isChatBackupKey(key)) trackBackup(tx, () => queueChatChange(tx, key));
      return os.delete(key);
    }, key); }
    catch (e) { reportWriteError(e); throw e; }
  },
  async delStory(storyId) {
    try {
      await storyBackupTransaction((tx) => {
        // Whole-story deletion preserves its chapters and extras in the cloud recycle bin.
        tx.objectStore('stories').delete(storyId);
        touchStoryLookup(tx, [storyId]);
        for (const name of ['nodes', 'extras']) {
          const request = tx.objectStore(name).index('storyId').openKeyCursor(storyId);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            tx.objectStore(name).delete(cursor.primaryKey);
            cursor.continue();
          };
        }
        trackBackup(tx, () => queueChange(tx, 'stories', storyId));
      });
    } catch (e) { reportWriteError(e); throw e; }
  },
  async kvGet(key, fallback) {
    const v = await run('kv', 'readonly', (os) => os.get(key));
    return v === undefined ? fallback : v;
  },
  kvSet: (key, value) => db.put('kv', value, key),
  // 同一个事务内读改写多个键（记账去重），避免重放或多页并发重复累加。
  async kvUpdate(keys, update) {
    try {
      return await open().then((database) => new Promise((resolve, reject) => {
        const trackChat = keys.some(isChatBackupKey);
        const tx = database.transaction(trackChat ? ['kv', BACKUP_META, BACKUP_QUEUE] : 'kv', 'readwrite');
        const os = tx.objectStore('kv');
        const values = {}; let pending = keys.length; let result; let failure;
        for (const key of keys) {
          const req = os.get(key);
          req.onsuccess = () => {
            values[key] = req.result;
            if (--pending) return;
            try {
              const change = update(values);
              result = change.result;
              const entries = Object.entries(change.values);
              for (const [k, v] of entries) os.put(v, k);
              if (trackChat) trackBackup(tx, () => {
                for (const [k, v] of entries) queueChatChange(tx, k, v, values[k]);
              });
            } catch (e) { failure = e; tx.abort(); }
          };
        }
        tx.oncomplete = () => { resolve(result); backupChanged(); };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(failure || tx.error || new Error('事务被中止'));
      }));
    } catch (e) { reportWriteError(e); throw e; }
  },
};

export const MIGRATION_STORES = Object.freeze(['kv', 'connections', 'stories', 'nodes', 'extras']);

export async function readMigrationDatabase() {
  const database = await open();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MIGRATION_STORES, 'readonly');
    const requests = MIGRATION_STORES.map(name => [name, tx.objectStore(name).getAll()]);
    const keys = tx.objectStore('kv').getAllKeys();
    tx.oncomplete = () => {
      const stores = Object.fromEntries(requests.map(([name, request]) => [name, request.result]));
      stores.kv = keys.result.map((key, index) => [key, stores.kv[index]]);
      resolve(stores);
    };
    tx.onabort = () => reject(tx.error || new Error('读取本地存档失败'));
  });
}

export async function replaceMigrationDatabase(stores) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([...MIGRATION_STORES, BACKUP_META, BACKUP_QUEUE], 'readwrite');
    const incomingStoryIds = new Set(stores.stories.map(story => story.id));
    let enqueueError;
    tx.oncomplete = () => { resolve(); backupChanged(); };
    tx.onabort = () => reject(enqueueError || tx.error || new Error('迁移写入失败'));
    try {
      tx.objectStore(BACKUP_META).put(uid(), STORY_LOOKUP_RESET);
      for (const name of MIGRATION_STORES) {
        const store = tx.objectStore(name);
        if (BACKUP_STORES.includes(name)) {
          const incoming = new Set(stores[name].map(value => value.id));
          const previous = store.getAll();
          previous.onsuccess = () => trackBackup(tx, () => {
            for (const value of previous.result) {
              if (incoming.has(value.id)) continue;
              if (name === 'stories' || incomingStoryIds.has(value.storyId)) {
                queueChange(tx, name, value.id);
              }
            }
            for (const value of stores[name]) queueChange(tx, name, value.id, value, { includeStreaming: true });
          });
        }
        if (name === 'kv') {
          const previous = store.getAllKeys();
          previous.onsuccess = () => queueChatReplacement(tx, previous.result, stores.kv);
        }
        store.clear();
        if (name === 'kv') {
          for (const [key, value] of stores.kv) store.add(value, key);
        } else {
          for (const value of stores[name]) store.add(value);
        }
      }
    } catch (error) {
      enqueueError = error;
      tx.abort();
    }
  });
}

/** 向系统申请“持久存储”，降低被系统清理的可能 */
export async function ensurePersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

export async function storageInfo() {
  const info = { persisted: null, usage: null, quota: null };
  try {
    if (navigator.storage?.persisted) info.persisted = await navigator.storage.persisted();
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      info.usage = e.usage; info.quota = e.quota;
    }
  } catch {}
  return info;
}

/** 导出：默认不含 API 密钥 */
function backupNodes(nodes) {
  return nodes.map(({ relayJob, relayContext, ...node }) => node);
}

function backupExtras(extras) {
  return extras.map((x) => ({ ...x, versions: backupNodes(x.versions || []) }));
}

export async function exportAll({ includeKeys = false } = {}) {
  const [stories, nodes, extras, connections, defaultRules, prefs, modules, fwTemplates, fwBase, globalMemo, packs] = await Promise.all([
    db.all('stories'), db.all('nodes'), db.all('extras'), db.all('connections'),
    db.kvGet('defaultRules', null), db.kvGet('prefs', null),
    db.kvGet('modules', null), db.kvGet('fwTemplates', null), db.kvGet('fwBase', null), db.kvGet('globalMemo', null),
    db.kvGet('packs', null),
  ]);
  let discussions = [];
  try { discussions = await (await import('./discuss.js')).exportDiscussions(); } catch {}
  return {
    app: 'moyu', schema: SCHEMA, exportedAt: Date.now(),
    stories, nodes: backupNodes(nodes), extras: backupExtras(extras), modules, packs, fwTemplates, fwBase, globalMemo, discussions,
    connections: connections.map((c) => (includeKeys ? c : { ...c, apiKey: '' })),
    defaultRules, prefs,
  };
}

export async function exportStory(storyId) {
  const story = await db.get('stories', storyId);
  const nodes = await db.byStory(storyId);
  const extras = await db.extrasOf(storyId);
  return { app: 'moyu', schema: SCHEMA, exportedAt: Date.now(), stories: [story], nodes: backupNodes(nodes), extras: backupExtras(extras), connections: [] };
}

/** 导入：同 id 的故事会被覆盖；连接只补充不存在的（不覆盖本机已有密钥） */
export async function importData(data) {
  if (!data || (data.app !== 'moyu' && data.app !== 'yl2c')) throw new Error('这不是墨游的备份文件');
  if ((data.schema || 1) > SCHEMA) throw new Error('这个备份来自更新版本的墨游，请先更新');
  const stories = Array.isArray(data.stories) ? data.stories.filter(Boolean) : [];
  const nodes = Array.isArray(data.nodes) ? data.nodes.filter(Boolean) : [];
  for (const s of stories) {
    const old = await db.byStory(s.id);
    const incoming = new Set(nodes.filter(node => node.storyId === s.id).map(node => node.id));
    if (old.length) await run('nodes', 'readwrite', (os, tx) => {
      for (const n of old) os.delete(n.id);
      touchStoryLookup(tx, [s.id]);
      trackBackup(tx, () => {
        for (const n of old) if (!incoming.has(n.id)) queueChange(tx, 'nodes', n.id);
      });
    });
  }
  if (stories.length) await db.putMany('stories', stories);
  if (nodes.length) await db.putMany('nodes', nodes);
  const extras = Array.isArray(data.extras) ? data.extras.filter(Boolean) : [];
  if (extras.length) await db.putMany('extras', extras);
  // 模块和番外模板：本机还没有的时候才用备份里的（不覆盖本机已经改过的）
  if (Array.isArray(data.modules) && !(await db.kvGet('modules', null))) {
    await db.kvSet('modules', data.modules);
    if (Array.isArray(data.packs)) await db.kvSet('packs', data.packs);
  }
  if (Array.isArray(data.fwTemplates) && !(await db.kvGet('fwTemplates', null))) await db.kvSet('fwTemplates', data.fwTemplates);
  if (data.fwBase && !(await db.kvGet('fwBase', null))) await db.kvSet('fwBase', data.fwBase);
  if (data.globalMemo && !(await db.kvGet('globalMemo', null))) await db.kvSet('globalMemo', data.globalMemo);
  if (Array.isArray(data.discussions)) { try { await (await import('./discuss.js')).importDiscussions(data.discussions); } catch {} }
  let addedConn = 0;
  if (Array.isArray(data.connections)) {
    const existing = new Set((await db.all('connections')).map((c) => c.id));
    const fresh = data.connections.filter((c) => c && !existing.has(c.id));
    if (fresh.length) { await db.putMany('connections', fresh); addedConn = fresh.length; }
  }
  if (data.defaultRules && !(await db.kvGet('defaultRules', null))) await db.kvSet('defaultRules', data.defaultRules);
  return { stories: stories.length, nodes: nodes.length, extras: extras.length, connections: addedConn };
}

function storyBackupTransaction(callback, includeChat = false) {
  return open().then(database => new Promise((resolve, reject) => {
    const tx = database.transaction([...BACKUP_STORES, BACKUP_META, BACKUP_QUEUE, ...(includeChat ? ['kv'] : [])], 'readwrite');
    tx.oncomplete = () => { resolve(); backupChanged(); };
    tx.onabort = () => reject(tx.error || new Error('备份事务未完成'));
    callback(tx);
  }));
}

function queueChatReplacement(tx, previousKeys, entries) {
  trackBackup(tx, () => {
    const incoming = new Map(entries.filter(([key]) => isChatBackupKey(key)));
    for (const key of previousKeys) {
      if (isChatBackupKey(key) && !incoming.has(key)) queueChatChange(tx, key);
    }
    for (const [key, value] of incoming) queueChatChange(tx, key, value);
  });
}

function seedChatBackup(tx, device) {
  const metadata = tx.objectStore(BACKUP_META);
  const seeded = metadata.get('chatSeedDevice');
  seeded.onsuccess = () => {
    if (seeded.result === device) return;
    const store = tx.objectStore('kv');
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      for (const key of keys.result.filter(isChatBackupKey)) {
        const request = store.get(key);
        request.onsuccess = () => queueChatChange(tx, key, request.result);
      }
      metadata.put(device, 'chatSeedDevice');
    };
  };
}

export const backupDatabase = {
  config: () => run(BACKUP_META, 'readonly', store => store.get('config')),
  pending: () => run(BACKUP_QUEUE, 'readonly', store => store.count()),
  batch: () => run(BACKUP_QUEUE, 'readonly', store => store.getAll(null, 32)),
  lastBackup: () => run(BACKUP_META, 'readonly', store => store.get('lastBackup')),
  async ack(sequences, time) {
    const database = await open();
    await new Promise((resolve, reject) => {
      const tx = database.transaction([BACKUP_QUEUE, BACKUP_META], 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('确认备份失败'));
      for (const seq of sequences) tx.objectStore(BACKUP_QUEUE).delete(seq);
      tx.objectStore(BACKUP_META).put(time, 'lastBackup');
    });
  },
  async prepareChat() {
    const database = await open();
    await new Promise((resolve, reject) => {
      const tx = database.transaction(['kv', BACKUP_META, BACKUP_QUEUE], 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error('扫描聊天记录失败'));
      const current = tx.objectStore(BACKUP_META).get('config');
      current.onsuccess = () => {
        if (current.result?.enabled && current.result.device) seedChatBackup(tx, current.result.device);
      };
    });
  },
  async configure({ enabled, url, token }) {
    await storyBackupTransaction(tx => {
      const meta = tx.objectStore(BACKUP_META);
      const request = meta.get('config');
      request.onsuccess = () => {
        const current = request.result;
        const sameServer = current?.device && current.url === url;
        const device = sameServer ? current.device : (enabled ? crypto.randomUUID() : null);
        meta.put({ enabled, url, token, device }, 'config');
        if (!enabled) return;
        seedChatBackup(tx, device);
        if (sameServer) return;
        meta.delete('lastBackup');
        for (const name of BACKUP_STORES) {
          const records = tx.objectStore(name).openCursor();
          records.onsuccess = () => {
            const cursor = records.result;
            if (!cursor) return;
            queueChange(tx, name, cursor.primaryKey, cursor.value, { includeStreaming: true });
            cursor.continue();
          };
        }
      };
    }, true);
  },
  async restore({ story, nodes, extras }) {
    let exists = false;
    try {
      await storyBackupTransaction(tx => {
        const request = tx.objectStore('stories').get(story.id);
        request.onsuccess = () => {
          if (request.result) { exists = true; tx.abort(); return; }
          const records = { stories: [story], nodes, extras };
          touchStoryLookup(tx, [story.id]);
          for (const name of BACKUP_STORES) {
            const store = tx.objectStore(name);
            for (const value of records[name]) store.add(value);
          }
          trackBackup(tx, () => {
            for (const name of BACKUP_STORES) {
              for (const value of records[name]) queueChange(tx, name, value.id, value);
            }
          });
        };
      });
    } catch (error) {
      if (exists) throw new Error('本机已有同一故事，请下载备份 JSON。');
      throw error;
    }
  },
};


export async function readChatBackup() {
  const database = await open();
  const tx = database.transaction('kv', 'readonly');
  const store = tx.objectStore('kv');
  const entries = [];
  return new Promise((resolve, reject) => {
    const keys = store.getAllKeys();
    keys.onsuccess = () => {
      for (const key of keys.result.filter(isChatBackupKey)) {
        const value = store.get(key);
        value.onsuccess = () => entries.push([key, portableChatValue(key, value.result)]);
      }
    };
    tx.oncomplete = () => resolve({ app: 'moyu-chat-backup', schema: 1, entries });
    tx.onabort = () => reject(tx.error || new Error('读取本机聊天失败'));
  });
}

export async function restoreChatBackup(archive, { replace = false } = {}) {
  const entries = archive?.entries;
  const valid = archive?.app === 'moyu-chat-backup' && archive.schema === 1 && Array.isArray(entries) && entries.length &&
    entries.every(entry => Array.isArray(entry) && entry.length === 2 && isChatBackupKey(entry[0])) &&
    new Set(entries.map(([key]) => key)).size === entries.length;
  if (!valid) throw new Error('这不是有效的日常聊天备份。');
  const rows = new Map(entries);
  const thread = rows.get(CHAT_THREAD);
  if (!Array.isArray(thread) || thread.some(id => typeof id !== 'string') ||
      entries.some(([key, value]) => key.startsWith(CHAT_TURN) &&
        (value?.id !== key.slice(CHAT_TURN.length) || !Array.isArray(value.replies) ||
          value.replies.some(reply => !reply || typeof reply.id !== 'string')))) {
    throw new Error('聊天备份格式有误。');
  }
  for (const [key, value] of rows) rows.set(key, portableChatValue(key, value));
  rows.set(CHAT_THREAD, thread.filter(id => rows.has(CHAT_TURN + id)));
  let exists = false;
  try {
    await storyBackupTransaction(tx => {
      const store = tx.objectStore('kv');
      const request = store.getAllKeys();
      request.onsuccess = () => {
        const previousKeys = request.result.filter(isChatBackupKey);
        if (!replace && previousKeys.length) { exists = true; tx.abort(); return; }
        for (const key of previousKeys) store.delete(key);
        for (const [key, value] of rows) store.put(value, key);
        queueChatReplacement(tx, previousKeys, [...rows]);
      };
    }, true);
  } catch (error) {
    if (exists) throw new Error('本机已有日常聊天。请先导出本机聊天，再选择替换恢复。');
    throw error;
  }
}


export const vaultLocal = {
  get: () => run(BACKUP_META, 'readonly', store => store.get('encryptedBackup')),
  put: value => run(BACKUP_META, 'readwrite', store => store.put(value, 'encryptedBackup')),
};
