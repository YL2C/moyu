import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import 'fake-indexeddb/auto';
import { db, readMigrationDatabase, replaceMigrationDatabase, vaultLocal } from '../js/db.js';
import {
  activateVault, archiveLegacyVault, clearVaultSession, cloudVault, isVaultUnlocked,
  lockVault, previewVault, restoreFromVault, restoreVaultMaterial, rotateVaultPassword, uploadVaultBackup,
} from '../js/vault-backup.js';

test('encrypted snapshots are incremental, recover in a fresh profile and survive a password change', async t => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const tmp = await mkdtemp(tmpdir() + '/moyu-vault-test-');
  const config = { url: 'https://backup.test', token: 'integration-test-token-1234567890abcdef', enabled: true };
  const server = spawn('python3', ['-B', 'server/cloud-backup.py', '--db', tmp + '/backup.db', 'serve', '--port', String(port)],
    { env: { ...process.env, MOYU_BACKUP_TOKEN: config.token }, stdio: ['ignore', 'ignore', 'inherit'] });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const closed = once(server, 'close');
      server.kill();
      await closed;
    }
    await rm(tmp, { recursive: true, force: true });
  });
  const fetcher = globalThis.fetch;
  const base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    try { await fetcher(base + '/cloud-backup/v1/vault'); ready = true; }
    catch { await sleep(40); }
  }
  assert.equal(ready, true);

  const legacy = await fetcher(base + '/cloud-backup/v1/records', {
    method: 'POST', headers: { Authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ device: 'prior', records: [
      { store: 'stories', id: 'old-story', seq: 1, deleted: true, value: { id: 'old-story', title: 'old-recycle-bin' } },
    ] }),
  });
  assert.equal(legacy.status, 200);
  execFileSync('python3', ['-B', 'server/cloud-backup.py', '--db', tmp + '/backup.db', 'snapshot', '--directory', tmp + '/snapshots']);
  const uploads = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init.body) {
      const body = JSON.parse(init.body);
      for (const secret of ['/secret profile', '/secret story', '/secret discussion', 'private-api-key', 'relay-secret']) {
        assert.ok(!init.body.includes(secret));
      }
      if (url.endsWith('/vault/objects')) uploads.push(...body.objects);
    }
    return fetcher(url.replace(config.url, base), init);
  });

  await db.put('stories', { id: 'story', title: '/secret story', card: { name: '设定' } });
  await db.put('nodes', { id: 'chapter', storyId: 'story', text: 'chapter', status: 'done' });
  await db.put('extras', { id: 'fan', storyId: 'story', versions: [] });
  await db.put('connections', { id: 'model', name: 'Model', apiKey: 'private-api-key' });
  await db.kvSet('relay', { url: 'https://example.test', token: 'relay-secret', on: true });
  await db.kvSet('disc.test', { id: 'test', messages: [{ content: '/secret discussion' }] });
  await db.kvSet('deeptalk.v1.materials', { profile: { original: { text: '/secret profile' }, editions: [{ text: 'version' }] },
    fitness: { original: { text: 'fitness' }, editions: [] } });
  await db.kvSet('deeptalk.v1.memory', { items: [{ id: 'memory', text: 'memory' }] });
  await db.kvSet('deeptalk.v1.thread', ['turn']);
  await db.kvSet('deeptalk.v1.turn.turn', { id: 'turn', replies: [{ id: 'reply', text: 'reply' }] });
  await db.kvSet('font1', new Blob([new Uint8Array([0, 128, 255])], { type: 'font/woff2' }));
  await db.kvSet('prefs', { theme: 'paper' });
  const before = await readMigrationDatabase();
  const password = 'a long password saved in the phone';
  const profile = await activateVault(config, { password, remember: true, create: true });
  assert.equal(profile.key.extractable, false);
  clearVaultSession();
  assert.equal(isVaultUnlocked(config, await vaultLocal.get()), true);

  const first = await uploadVaultBackup(config, profile);
  assert.ok(uploads.length > 10);
  uploads.length = 0;
  assert.equal((await uploadVaultBackup(config, profile)).id, first.id);
  assert.equal(uploads.length, 0);
  const materials = await db.kvGet('deeptalk.v1.materials');
  await db.kvSet('deeptalk.v1.materials', { ...materials, fitness: { original: { text: 'edited' }, editions: [] } });
  const second = await uploadVaultBackup(config, profile);
  assert.notEqual(first.id, second.id);
  assert.equal(uploads.length, 2, 'one changed document plus the encrypted manifest');
  assert.equal(await archiveLegacyVault(config), 2);
  const encryptedHistory = (await cloudVault(config)).snapshots.filter(x => x.device.startsWith('legacy-moyu-'));
  assert.equal(encryptedHistory.length, 1);

  const rejectedPlaintext = await fetcher(base + '/cloud-backup/v1/records', {
    method: 'POST', headers: { Authorization: 'Bearer ' + config.token },
    body: JSON.stringify({ device: 'prior', records: [{ store: 'stories', id: 'must-block', seq: 2, deleted: true }] }),
  });
  assert.equal(rejectedPlaintext.status, 409);

  await rotateVaultPassword(config, password, 'the new long cloud backup password');
  await lockVault();
  assert.equal(isVaultUnlocked(config, await vaultLocal.get()), false);
  await vaultLocal.put(null);
  await replaceMigrationDatabase({ kv: [], connections: [], stories: [], nodes: [], extras: [] });
  await assert.rejects(activateVault(config, { password, remember: false, create: false }), /密码不正确/);
  await activateVault(config, { password: 'the new long cloud backup password', remember: false, create: false });
  const { snapshots } = await cloudVault(config);
  assert.equal((await previewVault(config, snapshots.find(x => x.device === 'legacy'))).count, 1);
  assert.equal((await previewVault(config, second)).materials, 2);
  await restoreFromVault(config, second, 'all');
  const after = await readMigrationDatabase();
  assert.deepEqual(after.stories, before.stories);
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.extras, before.extras);
  assert.equal(after.connections[0].apiKey, '');
  assert.equal((await db.kvGet('relay')).token, undefined);
  assert.equal((await db.kvGet('relay')).on, false);
  assert.equal((await db.kvGet('deeptalk.v1.materials')).profile.editions[0].text, 'version');
  assert.equal((await db.kvGet('deeptalk.v1.materials')).fitness.original.text, 'edited');
  assert.equal((await db.kvGet('deeptalk.v1.memory')).items[0].text, 'memory');
  assert.equal((await db.kvGet('disc.test')).messages[0].content, '/secret discussion');
  assert.equal((await db.kvGet('prefs')).theme, 'paper');
  assert.deepEqual([...new Uint8Array(await (await db.kvGet('font1')).arrayBuffer())], [0, 128, 255]);
  await restoreVaultMaterial(config, first, 'fitness');
  assert.equal((await db.kvGet('deeptalk.v1.materials')).fitness.original.text, 'fitness');
  assert.equal((await db.kvGet('deeptalk.v1.materials')).profile.editions[0].text, 'version');
  await restoreFromVault(config, first, 'chat');
  assert.equal((await db.kvGet('deeptalk.v1.materials')).fitness.original.text, 'fitness');
  assert.deepEqual(await db.all('stories'), before.stories);
});
