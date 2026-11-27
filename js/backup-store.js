// The outbox and the save share an IndexedDB transaction.
export const BACKUP_STORES = ['stories', 'nodes', 'extras'];
export const BACKUP_META = 'cloudBackupMeta';
export const BACKUP_QUEUE = 'cloudBackupQueue';
export const CHAT_THREAD = 'deeptalk.v1.thread';
export const CHAT_TURN = 'deeptalk.v1.turn.';
export const isChatBackupKey = key => typeof key === 'string' &&
  (key === CHAT_THREAD || (key.startsWith(CHAT_TURN) && key.length > CHAT_TURN.length));

export function upgradeBackup(database) {
  if (!database.objectStoreNames.contains(BACKUP_META)) database.createObjectStore(BACKUP_META);
  if (!database.objectStoreNames.contains(BACKUP_QUEUE)) {
    const queue = database.createObjectStore(BACKUP_QUEUE, { keyPath: 'seq', autoIncrement: true });
    queue.createIndex('record', ['store', 'id'], { unique: true });
  }
}

export function backupChanged() {
  if (typeof window !== 'undefined' && typeof window.Event === 'function') window.dispatchEvent(new window.Event('moyu:backup-changed'));
}

function cleanNode({ relayJob, relayContext, ...node }) {
  if (node.status === 'streaming') {
    node.status = 'partial';
    node.thinking = false;
  }
  return node;
}

export function queueChange(tx, store, id, value, { includeStreaming = false } = {}) {
  if (store === 'nodes' && value?.status === 'streaming' && !includeStreaming) return;
  const queue = tx.objectStore(BACKUP_QUEUE);
  const prior = queue.index('record').get([store, id]);
  const record = { store, id, deleted: value === undefined, value };
  if (store === 'nodes' && value) record.value = cleanNode(value);
  if (store === 'extras' && value) record.value = { ...value, versions: (value.versions || []).map(cleanNode) };
  prior.onsuccess = () => {
    if (prior.result) {
      queue.delete(prior.result.seq);
      if (record.deleted) record.value = prior.result.value;
    }
    queue.add(record);
  };
}

export function portableChatValue(key, value) {
  if (!key.startsWith(CHAT_TURN) || !Array.isArray(value?.replies)) return value;
  return { ...value, replies: value.replies.map(({ relayJob, relayServer, ...reply }) => {
    if (reply.status === 'running' || relayJob) {
      reply.status = reply.text?.trim() ? 'partial' : 'error';
      reply.error = '备份时回复尚未完成，可以重试。';
    }
    return reply;
  }) };
}

export function queueChatChange(tx, key, value, previous) {
  if (!isChatBackupKey(key)) return;
  if (value === undefined) { queueChange(tx, 'chat', key); return; }
  if (key.startsWith(CHAT_TURN) && Array.isArray(value?.replies)) {
    const reply = value.replies.find(item => item.id === value.selectedId);
    const earlier = previous?.replies?.find(item => item.id === value.selectedId);
    if (reply?.status === 'running' && earlier?.status === 'running') return;
  }
  queueChange(tx, 'chat', key, { id: key, data: portableChatValue(key, value) });
}

export function trackBackup(tx, callback) {
  const request = tx.objectStore(BACKUP_META).get('config');
  request.onsuccess = () => {
    if (request.result?.device) callback();
  };
}
