import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { db, backupDatabase, readMigrationDatabase } from '../js/db.js';
import { setCloudBackup, syncCloudBackupNow } from '../js/cloud-backup.js';

test('initial scan, paused writes, racing acknowledgements, offline deletion and restore', async (t) => {
  const sent = [];
  let rejectNext = true;
  let onSend;
  const fetchBackup = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const { records } = JSON.parse(options.body);
    sent.push(records);
    if (rejectNext) { rejectNext = false; throw new TypeError('network'); }
    if (onSend) {
      const change = onSend;
      onSend = null;
      await change(options.signal);
    }
    return { ok: true, json: async () => ({ ack: records.map(record => record.seq) }) };
  });
  const url = 'https://backup.invalid';
  const token = 'example-token-for-test-only-1234567890';
  await db.put('stories', { id: 'first', title: 'old' });
  await db.put('connections', { id: 'secret', apiKey: 'local' });
  await setCloudBackup({ enabled: true, url, token });
  await syncCloudBackupNow();
  assert.equal(await backupDatabase.pending(), 1);
  assert.equal(sent.flat().some(record => record.store === 'connections'), false);

  onSend = () => db.updateStory('first', story => ({ ...story, title: 'new' }));
  await syncCloudBackupNow();
  assert.deepEqual(sent.flat().map(record => record.value.title), ['old', 'old', 'new']);
  assert.equal(await backupDatabase.pending(), 0);
  assert.ok(await backupDatabase.lastBackup());

  await setCloudBackup({ enabled: false });
  await db.put('stories', { id: 'second', title: 'offline' });
  await db.put('nodes', { id: 'chapter', storyId: 'second', text: '', status: 'streaming', relayJob: 'job' });
  await db.put('nodes', { id: 'chapter', storyId: 'second', text: 'saved', status: 'done', relayContext: { transient: true } });
  await db.put('extras', { id: 'extra', storyId: 'second', versions: [{ text: 'extra', relayJob: 'job' }] });
  await db.delStory('second');
  await syncCloudBackupNow();
  assert.equal(fetchBackup.mock.callCount(), 3);
  assert.equal(await db.get('stories', 'second'), undefined);
  const queued = await backupDatabase.batch();
  const tombstone = queued.find(record => record.id === 'second');
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.value.title, 'offline');
  assert.equal(queued.find(record => record.id === 'chapter').value.relayContext, undefined);
  assert.equal(queued.find(record => record.id === 'extra').value.versions[0].relayJob, undefined);

  await setCloudBackup({ enabled: true });
  await syncCloudBackupNow();
  assert.equal(await backupDatabase.pending(), 0);
  assert.equal(fetchBackup.mock.callCount(), 4);
  await backupDatabase.restore({ story: tombstone.value, nodes: [queued.find(r => r.id === 'chapter').value], extras: [] });
  assert.equal((await db.get('stories', 'second')).title, 'offline');
  await assert.rejects(backupDatabase.restore({ story: tombstone.value, nodes: [], extras: [] }), /本机已有/);
  assert.equal((await readMigrationDatabase()).kv.some(([key]) => key.includes('Backup')), false);
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  onSend = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    markStarted();
  });
  const uploading = syncCloudBackupNow();
  await started;
  await setCloudBackup({ enabled: false });
  await uploading;
  assert.equal(await backupDatabase.pending(), 2);
  await setCloudBackup({ enabled: true });
  await syncCloudBackupNow();
  assert.equal(await backupDatabase.pending(), 0);
  await setCloudBackup({ enabled: false });
});
