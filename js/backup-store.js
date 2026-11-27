// The outbox and the save share an IndexedDB transaction.
export const BACKUP_STORES = ['stories', 'nodes', 'extras'];
export const BACKUP_META = 'cloudBackupMeta';
export const BACKUP_QUEUE = 'cloudBackupQueue';

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

export function trackBackup(tx, callback) {
  const request = tx.objectStore(BACKUP_META).get('config');
  request.onsuccess = () => {
    if (request.result?.device) callback();
  };
}
