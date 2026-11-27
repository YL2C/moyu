import { backupDatabase } from './db.js';
import { DB_NAME } from './personal.js';

const CONFIG_EVENT = DB_NAME + '.cloudBackupChanged';
const STATUS_EVENT = 'moyu:cloud-backup-status';
let timer;
let running;
let controller;
let requested = false;
let lastError = '';
let epoch = 0;

function announce() {
  if (typeof window !== 'undefined' && typeof window.Event === 'function') window.dispatchEvent(new window.Event(STATUS_EVENT));
}

function cancelRequests() {
  epoch++;
  clearTimeout(timer);
  requested = false;
  controller?.abort();
  lastError = '';
}

export async function cloudBackupStatus() {
  const [config, pending, lastBackup] = await Promise.all([
    backupDatabase.config(), backupDatabase.pending(), backupDatabase.lastBackup(),
  ]);
  return { config, pending, lastBackup, lastError, running: !!running };
}

export async function setCloudBackup(input) {
  const current = await backupDatabase.config();
  let url = current?.url || '';
  let token = current?.token || '';
  if (input.enabled) {
    let parsed;
    try { parsed = new URL((input.url || url).trim()); } catch {}
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('请填写有效的 HTTPS 备份地址。');
    }
    url = parsed.href.replace(/\/+$/, '');
    token = (input.token || token).trim();
    if (!/^[!-~]{32,256}$/.test(token)) throw new Error('请填写服务器生成的备份口令。');
  }
  cancelRequests();
  await backupDatabase.configure({ enabled: input.enabled, url, token });
  try { localStorage.setItem(CONFIG_EVENT, crypto.randomUUID()); } catch {}
  if (input.enabled) scheduleCloudBackup(0);
  announce();
}

async function request(config, path, options = {}) {
  const response = await fetch(config.url + '/cloud-backup/v1/' + path, {
    ...options,
    cache: 'no-store', redirect: 'error',
    headers: {
      Authorization: 'Bearer ' + config.token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('备份口令有误。');
    if (response.status === 404) throw new Error('备份地址尚未部署或填写有误。');
    if (response.status === 413) throw new Error('存档超过服务器单次上传上限。');
    throw new Error('备份服务器暂时不可用（' + response.status + '）。');
  }
  return response.json();
}

async function upload(signal) {
  await backupDatabase.prepareChat();
  let consecutive = 0;
  while (!signal.aborted) {
    const [config, batch] = await Promise.all([backupDatabase.config(), backupDatabase.batch()]);
    if (signal.aborted || !config?.enabled || !batch.length) return;
    const records = [];
    let bytes = 0;
    for (const record of batch) {
      const item = JSON.stringify(record);
      bytes += new TextEncoder().encode(item).length + 1;
      if (records.length && bytes > 512 * 1024) break;
      records.push(item);
    }
    const sent = batch.slice(0, records.length).map(record => record.seq);
    const wait = setTimeout(() => controller?.abort('timeout'), 30000);
    try {
      const body = '{"device":' + JSON.stringify(config.device) + ',"records":[' + records.join(',') + ']}';
      const reply = await request(config, 'records', { method: 'POST', body, signal });
      if (!Array.isArray(reply.ack) || sent.length !== reply.ack.length || sent.some((seq, i) => seq !== reply.ack[i])) {
        throw new Error('服务器没有确认这批存档。');
      }
      if (signal.aborted) return;
      await backupDatabase.ack(sent, Date.now());
      announce();
    } finally { clearTimeout(wait); }
    if (++consecutive >= 20) { requested = true; return; }
  }
}

export function syncCloudBackupNow() {
  clearTimeout(timer);
  if (running) { requested = true; return running; }
  const currentEpoch = epoch;
  controller = new AbortController();
  const { signal } = controller;
  lastError = '';
  running = upload(signal).catch(error => {
    if (currentEpoch !== epoch) return;
    requested = false;
    lastError = signal.reason === 'timeout' ? '上传超时，待下次补传。'
      : error instanceof TypeError ? '暂时连不上服务器，待下次补传。' : error.message;
  }).finally(() => {
    controller = null;
    running = null;
    if (requested) { requested = false; scheduleCloudBackup(100); }
    announce();
  });
  announce();
  return running;
}

export function scheduleCloudBackup(delay = 1500) {
  if (running) { requested = true; return; }
  clearTimeout(timer);
  timer = setTimeout(() => void syncCloudBackupNow(), delay);
}

export function startCloudBackup() {
  window.addEventListener('moyu:backup-changed', () => scheduleCloudBackup());
  window.addEventListener('online', () => scheduleCloudBackup(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleCloudBackup(0);
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== CONFIG_EVENT) return;
    cancelRequests();
    scheduleCloudBackup(0);
  });
  scheduleCloudBackup(0);
}

export function watchCloudBackup(callback, signal) {
  if (signal.aborted) return;
  window.addEventListener(STATUS_EVENT, callback);
  signal.addEventListener('abort', () => window.removeEventListener(STATUS_EVENT, callback), { once: true });
}

export async function listCloudStories() {
  const config = await backupDatabase.config();
  return (await request(config, 'stories')).stories;
}

export async function downloadCloudStory(device, id) {
  const config = await backupDatabase.config();
  return request(config, 'story?' + new URLSearchParams({ device, id }));
}


export async function listCloudChats() {
  const config = await backupDatabase.config();
  return (await request(config, 'chat/backups')).backups;
}

export async function downloadCloudChat(device) {
  const config = await backupDatabase.config();
  return request(config, 'chat/archive?' + new URLSearchParams({ device }));
}
