import { db } from './db.js';
import { getConnections, canUseMemoryConnection } from './state.js';
import { streamWithRetry, supportsReasoningEffort, guessFormat } from './api.js';
import { cancelRelayJob } from './relay.js';
import { normalizeUsage, computeCost, recordUsage } from './cost.js';
import { uid } from './util.js';
import { buildDeepTalkContext, isRecallFeedback } from './deeptalk-context.js';
import { editMaterial, mergeMaterials } from './deeptalk-materials.js';

const PREFIX = 'deeptalk.v1.';
const SETTINGS_KEY = PREFIX + 'settings';
const MATERIALS_KEY = PREFIX + 'materials';
const THREAD_KEY = PREFIX + 'thread';
export const MEMORY_KEY = PREFIX + 'memory';
export const EFFORT_LABELS = Object.freeze({ default: '接口默认', low: '轻松', medium: '标准', high: '深入', xhigh: '极深', max: '最大' });
export const CHAT_KIND = '日常聊天';
export const MEMORY_KIND = '日常记忆整理';
export const MAX_USER_CHARS = 24_000;
const turnKey = id => PREFIX + 'turn.' + id;
const defaultSettings = { connectionId: '', efforts: {}, memoryConnectionId: '', autoMemory: false };

export const deepTalkSettings = async () => ({ ...defaultSettings, ...await db.kvGet(SETTINGS_KEY, {}) });
export const deepTalkMaterials = () => db.kvGet(MATERIALS_KEY, {});
export const deepTalkMemory = () => db.kvGet(MEMORY_KEY, { entries: [], snapshot: [], processed: [], omitted: [], mutedContexts: [] });
export const deepTalkConnections = async () => (await getConnections()).filter(canUseMemoryConnection);
export const selectedReply = turn => turn?.replies.find(reply => reply.id === turn.selectedId);

export async function saveDeepTalkSettings(patch) {
  return db.kvUpdate([SETTINGS_KEY], stored => {
    const before = { ...defaultSettings, ...stored[SETTINGS_KEY] };
    const settings = { ...before, ...patch, efforts: { ...before.efforts, ...patch.efforts } };
    return { values: { [SETTINGS_KEY]: settings }, result: settings };
  });
}

export async function saveDeepTalkMaterials(documents) {
  return db.kvUpdate([MATERIALS_KEY], stored => {
    const result = mergeMaterials(stored[MATERIALS_KEY] || {}, documents);
    return { values: result.changed ? { [MATERIALS_KEY]: result.materials } : {}, result };
  });
}

export async function updateDeepTalkMaterial(slot, update) {
  return db.kvUpdate([MATERIALS_KEY], stored => {
    const materials = { ...stored[MATERIALS_KEY] };
    if (!materials[slot]) throw new Error('请先导入资料');
    materials[slot] = update(materials[slot]);
    return { values: { [MATERIALS_KEY]: materials }, result: materials };
  });
}

export const saveMaterialEdit = (slot, baseId, sectionId, text, manualOnly) =>
  updateDeepTalkMaterial(slot, record => editMaterial(record, baseId, sectionId, text, manualOnly, uid()));

export const restoreMaterialEdition = (slot, id) => updateDeepTalkMaterial(slot, record => {
  if (record.original.id !== id && !record.editions.some(edition => edition.id === id)) throw new Error('找不到这个版本');
  return { ...record, currentId: record.original.id === id ? null : id };
});

export async function readDeepTalkThread({ count = 30, before } = {}) {
  const ids = await db.kvGet(THREAD_KEY, []);
  const end = Number.isInteger(before) ? Math.min(before, ids.length) : ids.length;
  const start = Math.max(0, end - count);
  const turns = await Promise.all(ids.slice(start, end).map(id => db.kvGet(turnKey(id), null)));
  return { turns: turns.filter(Boolean), start, total: ids.length };
}

export async function readDeepTalkTurn(id) { return db.kvGet(turnKey(id), null); }

function obsoleteDerivedMemory(memory, id, nextVersion) {
  if (!memory) return memory;
  return { ...memory, processed: memory.processed.filter(turnId => turnId !== id),
    snapshot: memory.snapshot.filter(item => item.turnId !== id || item.replyId === nextVersion),
    entries: memory.entries.map(item => {
      if (item.turnId !== id) return item;
      if (item.origin === 'organized' && item.replyId !== nextVersion && item.status !== 'deleted') return { ...item, status: 'superseded' };
      return { ...item, excludedSource: nextVersion == null };
    }) };
}

async function changeTurn(id, update, { invalidate = false } = {}) {
  const key = turnKey(id);
  return db.kvUpdate(invalidate ? [key, MEMORY_KEY] : [key], stored => {
    const before = stored[key];
    if (!before) throw new Error('找不到这条聊天');
    const next = update(before);
    const values = { [key]: next };
    if (invalidate && stored[MEMORY_KEY]) values[MEMORY_KEY] = obsoleteDerivedMemory(stored[MEMORY_KEY], id, next.excludeContext ? null : next.selectedId);
    return { values, result: next };
  });
}

export const chooseDeepTalkReply = (id, replyId) => changeTurn(id, turn => {
  if (!turn.replies.some(reply => reply.id === replyId)) throw new Error('找不到这个版本');
  return { ...turn, selectedId: replyId };
}, { invalidate: true });

export const setTurnExcluded = (id, excludeContext) => changeTurn(id, turn => ({ ...turn, excludeContext: !!excludeContext }), { invalidate: true });

async function putReply(id, replyId, patch, runningOnly = false) {
  return changeTurn(id, turn => ({ ...turn, replies: turn.replies.map(reply => reply.id === replyId && (!runningOnly || reply.status === 'running')
    ? { ...reply, ...patch } : reply) }));
}

async function startTurn(turn, reply, rewriting) {
  const key = turnKey(turn.id);
  return db.kvUpdate([THREAD_KEY, key, MEMORY_KEY], stored => {
    const ids = stored[THREAD_KEY] || [];
    if (rewriting && ids.at(-1) !== turn.id) throw new Error('请先回到最后一条回复再重写');
    const old = stored[key];
    const value = { ...(old || turn), selectedId: reply.id,
      sensitiveTopics: [...new Set([...(old?.sensitiveTopics || []), ...turn.sensitiveTopics])],
      replies: [...(old?.replies || []), reply] };
    const values = { [key]: value };
    if (!rewriting) values[THREAD_KEY] = [...ids, turn.id];
    if (rewriting && stored[MEMORY_KEY]) values[MEMORY_KEY] = obsoleteDerivedMemory(stored[MEMORY_KEY], turn.id, reply.id);
    return { values, result: value };
  });
}

let generatingHere = false;
async function generationLock(callback) {
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request('moyu-deeptalk-chat', { ifAvailable: true }, lock => {
      if (!lock) throw new Error('另一个墨游窗口正在聊天，请等它写完');
      return callback();
    });
  }
  if (generatingHere) throw new Error('正在等待日常聊天的回复');
  generatingHere = true;
  try { return await callback(); } finally { generatingHere = false; }
}

async function recordDeepTalkUsage(conn, result, context, replyId, elapsed, kind, usageId = replyId) {
  const inChars = (context?.system?.length || 0) + (context?.messages || []).reduce((sum, message) => sum + message.content.length, 0);
  const usage = normalizeUsage(result.usage, { inChars, outChars: result.text?.length || 0 });
  const cost = computeCost(usage, conn);
  await recordUsage({ kind, requestId: usageId, model: conn.model, usage, cost }).catch(() => {});
  return { usage, cost, elapsed, reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens ?? null };
}

export async function generateDeepTalk({ text, turnId = '', resume = false, deeper = false, manualKeys = [], signal,
  onStart = () => {}, onText = () => {}, onThinking = () => {} }) {
  return generationLock(async () => {
    const [settings, connections, thread, materials, memory] = await Promise.all([
      deepTalkSettings(), deepTalkConnections(), readDeepTalkThread(), deepTalkMaterials(), deepTalkMemory(),
    ]);
    const previousTurn = turnId ? thread.turns.at(-1) : null;
    if (turnId && previousTurn?.id !== turnId) throw new Error('只能重写或接回最后一条回复');
    const pending = resume ? selectedReply(previousTurn) : null;
    if (resume && !pending?.relayJob) throw new Error('这条回复没有可接回的后台任务');
    const configured = connections.find(conn => conn.id === (pending?.connectionId ?? settings.connectionId));
    if (!configured) throw new Error('请先为日常聊天选择一条有效的 API 连接');
    const conn = pending ? { ...configured, model: pending.model, format: pending.format, stream: pending.stream } : configured;
    const prompt = previousTurn?.text ?? String(text ?? '').trim();
    if (!prompt || prompt.length > MAX_USER_CHARS) throw new Error('请输入 1 至 24000 字');
    if (!turnId && isRecallFeedback(prompt)) await muteLastRecall(thread.turns.at(-1));
    const history = previousTurn ? thread.turns.slice(0, -1) : thread.turns;
    const context = pending ? null : buildDeepTalkContext({ text: prompt, turns: history, materials, memory, manualKeys });
    const storedEffort = settings.efforts[conn.id];
    const effort = supportsReasoningEffort(conn) ? (deeper ? 'high' : Object.hasOwn(EFFORT_LABELS, storedEffort) ? storedEffort : 'medium') : null;
    const reply = pending || { id: uid(), connectionId: conn.id, model: conn.model, format: guessFormat(conn), stream: conn.stream !== false,
      effort, status: 'running', text: '', at: Date.now(), refs: context.used, always: context.always, contextKey: context.contextKey };
    const draft = pending ? null : { id: turnId || uid(), at: Date.now(), text: prompt, sensitiveTopics: context.activeSensitive };
    let turn = pending ? await putReply(turnId, reply.id, { status: 'running', error: '' }) : await startTurn(draft, reply, !!turnId);
    onStart(turn);
    let visible = pending?.text || '';
    let relayJob = pending?.relayJob ?? '';
    let relayServer = pending?.relayServer ?? '';
    let lastCheckpoint = 0;
    const started = Date.now();
    try {
      const result = await streamWithRetry(conn, {
        system: context?.system, messages: context?.messages, reasoningEffort: pending?.effort ?? effort,
        cachePrefix: context?.cachePrefix, cacheScope: 'deeptalk', signal,
        resumeJob: relayJob || null, relayServer,
        firstByteMs: /:flex$/i.test(conn.model) ? 270_000 : 180_000,
        onJob: async (id, server) => {
          relayJob = id;
          relayServer = server;
          await putReply(turn.id, reply.id, { relayJob: id, relayServer: server }, true);
        },
        onText: (_delta, full) => {
          visible = full;
          onText(full);
          if (Date.now() - lastCheckpoint < 1600) return;
          lastCheckpoint = Date.now();
          void putReply(turn.id, reply.id, { text: full }, true).catch(() => {});
        },
        onThinking,
      }, { retries: 0, requestKind: CHAT_KIND });
      const receipt = await recordDeepTalkUsage(conn, result, context, reply.id, Date.now() - started, CHAT_KIND);
      turn = await putReply(turn.id, reply.id, { status: result.truncated ? 'partial' : 'done', text: result.text,
        error: result.truncated ? '回复达到输出上限' : '', relayJob: '', relayServer: '', ...receipt });
    } catch (error) {
      const stopped = signal?.aborted || error.kind === 'aborted';
      const canResume = relayJob && (!stopped || ['leave', 'reconnect'].includes(signal?.reason)) &&
        /^(?:relay_network|relay_throttled|network|timeout|aborted)$/.test(error.kind || '');
      turn = await putReply(turn.id, reply.id, { status: stopped ? 'stopped' : visible ? 'partial' : 'error',
        text: visible, relayJob: canResume ? relayJob : '', relayServer: canResume ? relayServer : '',
        error: stopped ? '已停止' : [error.message || '日常聊天请求失败', error.hint].filter(Boolean).join('。'),
        elapsed: Date.now() - started });
    }
    return turn;
  });
}

export async function stopPendingDeepTalk(turn) {
  const reply = selectedReply(turn);
  if (!reply?.relayJob) return;
  await cancelRelayJob(reply.relayJob, reply.relayServer);
  return putReply(turn.id, reply.id, { status: 'stopped', relayJob: '', relayServer: '', error: '已停止' });
}

export async function deepTalkRequestPreview(text, manualKeys = []) {
  const [{ turns }, materials, memory] = await Promise.all([readDeepTalkThread(), deepTalkMaterials(), deepTalkMemory()]);
  return buildDeepTalkContext({ text: text.trim(), turns, materials, memory, manualKeys });
}

export async function updateDeepTalkMemory(update) {
  return db.kvUpdate([MEMORY_KEY], stored => {
    const memory = { entries: [], snapshot: [], processed: [], omitted: [], mutedContexts: [], ...stored[MEMORY_KEY] };
    const next = update(memory);
    return { values: { [MEMORY_KEY]: next }, result: next };
  });
}

async function muteLastRecall(turn) {
  const reply = selectedReply(turn);
  if (!reply?.refs?.length || !reply.contextKey) return;
  await updateDeepTalkMemory(memory => {
    const old = memory.mutedContexts.find(item => item.context === reply.contextKey);
    const muted = { context: reply.contextKey, keys: [...new Set([...(old?.keys || []), ...reply.refs.map(part => part.key)])] };
    return { ...memory, mutedContexts: [...memory.mutedContexts.filter(item => item.context !== reply.contextKey), muted] };
  });
}

export async function rememberDeepTalkTurn(turn, reply = null) {
  const quote = (reply?.text ?? turn.text).trim();
  if (!quote) throw new Error('这一条还没有可记的文字');
  return updateDeepTalkMemory(memory => {
    if (memory.entries.some(entry => entry.status === 'active' && entry.quote === quote && entry.turnId === turn.id)) return memory;
    const item = { id: uid(), at: Date.now(), text: quote, quote, origin: 'manual', status: 'active', turnId: turn.id,
      replyId: reply?.id || '', sensitiveTopics: turn.sensitiveTopics || [], manualOnly: false, pinned: false };
    return { ...memory, entries: [...memory.entries, item] };
  });
}

export async function reviseDeepTalkMemory(id, patch) {
  return updateDeepTalkMemory(memory => {
    const entry = memory.entries.find(item => item.id === id);
    if (!entry) throw new Error('找不到这条记忆');
    const edited = typeof patch.text === 'string' && patch.text !== entry.text;
    const removed = patch.status === 'deleted';
    const omit = removed || edited ? [...memory.omitted, { turnId: entry.turnId, quote: entry.quote }] : memory.omitted;
    const next = { ...entry, ...patch, ...(edited ? { origin: 'manual', quote: patch.text } : {}) };
    return { ...memory, omitted: omit, entries: memory.entries.map(item => item.id === id ? next : item),
      snapshot: removed || edited ? memory.snapshot.filter(item => item.turnId !== entry.turnId || item.quote !== entry.quote) : memory.snapshot };
  });
}

export async function saveOrganizedDeepTalk(batch, snapshot, candidates) {
  const keys = [MEMORY_KEY, ...new Set(batch.map(turn => turnKey(turn.id)))];
  return db.kvUpdate(keys, stored => {
    const memory = { entries: [], snapshot: [], processed: [], omitted: [], mutedContexts: [], ...stored[MEMORY_KEY] };
    const stable = new Set(batch.filter(turn => {
      const current = stored[turnKey(turn.id)];
      return current?.selectedId === turn.selectedId && !current.excludeContext && !current.sensitiveTopics?.length &&
        selectedReply(current)?.status === 'done';
    }).map(turn => turn.id));
    const hasOmission = item => memory.omitted.some(rule => {
      if (rule.turnId !== item.turnId) return false;
      const a = rule.quote.replace(/\s+/g, '');
      const b = item.quote.replace(/\s+/g, '');
      return a.includes(b) || b.includes(a);
    });
    const eligible = item => stable.has(item.turnId) && !hasOmission(item);
    const seen = new Set(memory.entries.filter(entry => entry.status !== 'superseded').map(entry => entry.quote.trim()));
    const additions = [];
    for (const entry of candidates.filter(eligible)) {
      if (seen.has(entry.quote.trim())) continue;
      seen.add(entry.quote.trim());
      additions.push(entry);
    }
    const next = { ...memory,
      snapshot: stable.size ? snapshot.filter(eligible) : memory.snapshot,
      entries: [...memory.entries, ...additions],
      processed: [...new Set([...memory.processed, ...stable])],
    };
    return { values: { [MEMORY_KEY]: next }, result: additions.length };
  });
}

export { recordDeepTalkUsage };
