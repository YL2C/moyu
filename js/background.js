import { guessFormat, streamWithRetry } from './api.js';
import { db } from './db.js';
import { cancelRelayJob } from './relay.js';
import { computeCost, normalizeUsage, recordUsage } from './cost.js';
import { uid } from './util.js';

// A task belongs to one discussion or story action. Store only the relay
// address, task number and parsing/pricing metadata, never model credentials.
const active = new Map();
const storageKey = key => 'background.' + key;
export const taskPending = t => t?.state === 'running' || t?.state === 'pending';
export const taskId = uid;
export const getTask = key => db.kvGet(storageKey(key), null);
export async function clearTask(key) {
  if (active.has(key) || taskPending(await getTask(key))) return false;
  await db.del('kv', storageKey(key));
  return true;
}

function publish(key, task) {
  window.dispatchEvent(new CustomEvent('moyu:background', { detail: { key, task: { ...task } } }));
}

async function save(key, task) {
  await db.kvSet(storageKey(key), task);
  publish(key, task);
}

function exclusive(key, work) {
  if (active.has(key)) return active.get(key).promise;
  const ctrl = new AbortController();
  const run = () => work(ctrl.signal);
  const promise = Promise.resolve().then(() => navigator.locks
    ? navigator.locks.request(storageKey(key), { ifAvailable: true }, lock => lock ? run() : getTask(key))
    : run()).finally(() => active.delete(key));
  active.set(key, { ctrl, promise });
  return promise;
}

async function collect(key, task, signal, start = null) {
  let lastWrite = 0;
  let queued = Promise.resolve();
  task.state = 'running';
  delete task.error;
  delete task.errorKind;
  await save(key, task);
  try {
    const previous = task.text.length;
    const r = await streamWithRetry(start?.conn || task.connection, {
      ...start?.request,
      signal, resumeJob: start ? null : task.job, relayServer: task.server,
      onJob: async (job, server) => {
        task.job = job;
        task.server = server;
        await save(key, task);
      },
      onText: (_, text) => {
        if (!start && text.length < previous) return;
        task.text = text;
        publish(key, task);
        if (Date.now() - lastWrite > 1200) {
          lastWrite = Date.now();
          const snapshot = { ...task };
          queued = queued.then(() => db.kvSet(storageKey(key), snapshot)).catch(() => {});
        }
      },
    }, { requestKind: start ? task.account?.kind : '接回后台生成', storyId: task.account?.storyId });
    task.text = r.text;
    const usage = normalizeUsage(r.usage, { inChars: task.inChars, outChars: r.text.length });
    task.cost = computeCost(usage, task.connection);
    await recordUsage({ ...task.account, model: task.connection.model, usage, cost: task.cost, requestId: task.id });
    task.state = 'done';
  } catch (error) {
    if (error.partial?.length > task.text.length) task.text = error.partial;
    const canReconnect = task.job && !signal.aborted &&
      ['relay_network', 'relay_auth', 'relay_config', 'relay_throttled'].includes(error.kind);
    task.state = canReconnect ? 'pending' : 'error';
    task.error = error.message || String(error);
    task.errorKind = error.kind;
  }
  if (!taskPending(task)) { delete task.job; delete task.server; }
  await queued;
  await save(key, task);
  return task;
}

export function startTask(key, { id = uid(), conn, system, messages, maxTokens, kind, storyId, meta = null }) {
  return exclusive(key, async signal => {
    const existing = await getTask(key);
    if (taskPending(existing) || existing?.state === 'done') return existing;
    const { model, stream, priceMode, pricePerCall, priceIn, priceOut, priceCache, currency } = conn;
    const format = conn.format === 'vertex' ? 'openai' : guessFormat(conn);
    const task = {
      id, state: 'running', text: '', meta, account: { kind, storyId },
      connection: { model, format, stream, priceMode, pricePerCall, priceIn, priceOut, priceCache, currency },
      inChars: (system?.length || 0) + messages.reduce((n, m) => n + m.content.length, 0),
    };
    return collect(key, task, signal, { conn, request: { system, messages, maxTokens } });
  });
}

export function resumeTask(key, { manual = true } = {}) {
  return exclusive(key, async signal => {
    const task = await getTask(key);
    if (!taskPending(task)) return task;
    if (!manual && task.errorKind === 'relay_throttled') return task;
    if (task.job) return collect(key, task, signal);
    // Without a job number the creation result is unknown. Never resend it automatically.
    task.state = 'error';
    task.error = '生成被中断，未能取得后台任务编号。';
    await save(key, task);
    return task;
  });
}

export async function stopTask(key) {
  const current = active.get(key);
  if (current) { current.ctrl.abort('user'); return current.promise; }
  return exclusive(key, async () => {
    const task = await getTask(key);
    if (!taskPending(task)) return task;
    if (task.job) await cancelRelayJob(task.job, task.server);
    delete task.job;
    delete task.server;
    task.state = 'error';
    task.error = '已停止';
    await save(key, task);
    return task;
  });
}
