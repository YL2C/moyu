import { db } from './db.js';
import { getConnections, canUseMemoryConnection } from './state.js';
import { streamWithRetry, supportsReasoningEffort, guessFormat } from './api.js';
import { cancelRelayJob } from './relay.js';
import { normalizeUsage, computeCost, recordUsage, getRequestLog, CUR } from './cost.js';
import { uid } from './util.js';
import { buildDeepTalkContext, isRecallFeedback, sensitiveTopics } from './deeptalk-context.js';
import { editMaterial, mergeMaterials } from './deeptalk-materials.js';
import { TOPIC_RECALL_KIND, canSelectTopic, readTopicChoice, topicSelectionInput } from './deeptalk-topics.js';
import { chatStoryReference, findChatStoryReferences } from './deeptalk-story-recall.js';

const PREFIX = 'deeptalk.v1.';
const SETTINGS_KEY = PREFIX + 'settings';
const MATERIALS_KEY = PREFIX + 'materials';
const THREAD_KEY = PREFIX + 'thread';
const MEMORY_USAGE_KEY = PREFIX + 'memoryUsage';
export const MEMORY_KEY = PREFIX + 'memory';
export const EFFORT_LABELS = Object.freeze({ default: '接口默认', low: '轻松', medium: '标准', high: '深入', xhigh: '极深', max: '最大' });
const CHAT_KIND = '日常聊天';
export const MEMORY_KIND = '日常记忆整理';
const REWRITE_KIND = '重写日常回复';
const RETRY_KIND = '重试日常回复';
const RESUME_KIND = '接回日常回复';
const CHAT_LABEL = '聊天回复';
const REPEAT_LABEL = '重写 / 重试';
const MEMORY_LABEL = '整理记忆';
const AUXILIARY_LABELS = { [MEMORY_KIND]: MEMORY_LABEL, [TOPIC_RECALL_KIND]: TOPIC_RECALL_KIND };
const REQUEST_LABELS = {
  [CHAT_KIND]: CHAT_LABEL, [REWRITE_KIND]: '重写回复', [RETRY_KIND]: '重试回复',
  [RESUME_KIND]: '接回回复', ...AUXILIARY_LABELS,
};
export const MAX_USER_CHARS = 24_000;
const turnKey = id => PREFIX + 'turn.' + id;
const defaultSettings = { connectionId: '', efforts: {}, memoryConnectionId: '', autoMemory: false, autoTopics: false,
  autoStoryRecall: false, storyRecallScope: 'all', storyRecallIds: [] };

export const deepTalkSettings = async () => ({ ...defaultSettings, ...await db.kvGet(SETTINGS_KEY, {}) });
export const deepTalkMaterials = () => db.kvGet(MATERIALS_KEY, {});
export const deepTalkMemory = () => db.kvGet(MEMORY_KEY, { entries: [], snapshot: [], processed: [], omitted: [], mutedContexts: [] });
export const deepTalkConnections = async () => (await getConnections()).filter(canUseMemoryConnection);
export const selectedReply = turn => turn?.replies.find(reply => reply.id === turn.selectedId);
export const usedStoryRecall = turn => selectedReply(turn)?.refs?.some(ref => ref.story === true);

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

const validTokenCount = value => Number.isSafeInteger(value) && value >= 0;

export function deepTalkUsageSplit(usage) {
  const input = Number(usage?.input ?? NaN);
  const output = Number(usage?.output ?? NaN);
  return validTokenCount(input) && validTokenCount(output) ? { input, output, est: !!usage.est } : null;
}

export function deepTalkReplyTokens(reply) {
  const usage = reply?.usage;
  if (!usage) return null;
  if (validTokenCount(usage.total)) return { total: usage.total, estimated: !!usage.totalEstimated };
  const split = deepTalkUsageSplit(usage);
  return split ? { total: split.input + split.output, estimated: split.est } : null;
}

function memoryUsageReceipts(receipt) {
  // 旧整理用量从全站最近调用记录迁入，后续整理的用量独立保留。
  return db.kvUpdate([MEMORY_USAGE_KEY, 'usageLog'], values => {
    const saved = values[MEMORY_USAGE_KEY];
    const receipts = saved ?? (values.usageLog || []).filter(row => row.kind === MEMORY_KIND).map(row => ({
      at: row.at, model: row.model, usage: row, cost: row.cost,
    }));
    if (receipt) receipts.push(receipt);
    return { values: receipt || (!saved && receipts.length) ? { [MEMORY_USAGE_KEY]: receipts } : {}, result: receipts };
  });
}

function spendBucket() {
  return { count: 0, total: 0, counted: 0, estimated: false, input: 0, output: 0, splitCount: 0,
    splitEstimated: false, cached: 0, written: 0, cacheCount: 0, priced: 0, costs: {} };
}

function addReceipt(bucket, receipt) {
  const { usage, cost } = receipt;
  const tokens = deepTalkReplyTokens(receipt);
  bucket.count++;
  if (tokens) {
    bucket.total += tokens.total;
    bucket.counted++;
    bucket.estimated ||= tokens.estimated;
  }
  const split = deepTalkUsageSplit(usage);
  if (split) {
    bucket.splitCount++;
    bucket.input += split.input;
    bucket.output += split.output;
    bucket.splitEstimated ||= split.est;
  }
  if (usage?.cacheReported || usage?.cached > 0 || usage?.written > 0) {
    bucket.cacheCount++;
    bucket.cached += Number(usage.cached) || 0;
    bucket.written += Number(usage.written) || 0;
  }
  if (Object.hasOwn(CUR, cost?.currency) && Number.isFinite(cost.amount)) {
    bucket.priced++;
    bucket.costs[cost.currency] = (bucket.costs[cost.currency] || 0) + cost.amount;
  }
}

function summarizeSpend(receipts, requests) {
  const total = spendBucket();
  const byKind = { [CHAT_LABEL]: spendBucket(), [REPEAT_LABEL]: spendBucket(), [MEMORY_LABEL]: spendBucket(), [TOPIC_RECALL_KIND]: spendBucket() };
  for (const receipt of receipts) {
    addReceipt(total, receipt);
    addReceipt(byKind[receipt.group], receipt);
  }
  const chat = byKind[CHAT_LABEL];
  return { total, byKind, averageInput: chat.splitCount ? Math.round(chat.input / chat.splitCount) : null,
    recent: receipts.filter(row => row.usage || row.cost).slice(0, 30), requests: requests.slice(0, 30) };
}

export async function getDeepTalkSpend(now = Date.now()) {
  const date = new Date(now);
  const year = date.getFullYear(), month = date.getMonth(), day = date.getDate();
  const todayStart = +new Date(year, month, day);
  const todayEnd = +new Date(year, month, day + 1);
  const monthStart = +new Date(year, month, 1);
  const monthEnd = +new Date(year, month + 1, 1);
  const [ids, memoryReceipts, requestLog] = await Promise.all([db.kvGet(THREAD_KEY, []), memoryUsageReceipts(), getRequestLog()]);
  const receipts = memoryReceipts.map(row => {
    const kind = AUXILIARY_LABELS[row.kind] || MEMORY_LABEL;
    return { ...row, kind, group: kind };
  });
  const latestFirst = (a, b) => b.at - a.at;
  const requests = requestLog.filter(row => !row.storyId && Object.hasOwn(REQUEST_LABELS, row.kind))
    .map(row => ({ ...row, kind: REQUEST_LABELS[row.kind] })).sort(latestFirst);

  // 每个回复版本保留自己的用量，换版本显示和最近用量日志的上限不影响统计。
  for (let start = 0; start < ids.length; start += 80) {
    const turns = await Promise.all(ids.slice(start, start + 80).map(readDeepTalkTurn));
    for (const turn of turns) {
      turn?.replies?.forEach((reply, index) => {
        if (reply.status === 'running' && !reply.usage) return;
        const group = index ? REPEAT_LABEL : CHAT_LABEL;
        receipts.push({ at: reply.at ?? turn.at, kind: REQUEST_LABELS[reply.kind] || group, group,
          model: reply.model, usage: reply.usage, cost: reply.cost });
      });
    }
  }
  receipts.sort(latestFirst);
  const today = row => row.at >= todayStart && row.at < todayEnd;
  const thisMonth = row => row.at >= monthStart && row.at < monthEnd;
  return { today: summarizeSpend(receipts.filter(today), requests.filter(today)),
    month: summarizeSpend(receipts.filter(thisMonth), requests.filter(thisMonth)), all: summarizeSpend(receipts, requests) };
}

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

function contextLength(context) {
  return (context.system?.length || 0) + (context.messages || []).reduce((sum, message) => sum + message.content.length, 0);
}

function reportedTokenTotal(raw) {
  const total = Number(raw?.total_tokens ?? raw?.totalTokenCount);
  return validTokenCount(total) && total > 0 ? total : null;
}

function errorTokenUsage(raw) {
  const total = reportedTokenTotal(raw);
  const hasBreakdown = [[raw?.prompt_tokens, raw?.completion_tokens], [raw?.input_tokens, raw?.output_tokens],
    [raw?.promptTokenCount, raw?.candidatesTokenCount]].some(pair => pair.every(validTokenCount));
  if (total != null) return { ...(hasBreakdown ? normalizeUsage(raw) : {}), total, totalEstimated: false };
  return hasBreakdown ? normalizeUsage(raw) : null;
}

async function recordDeepTalkUsage(conn, result, context, replyId, elapsed, kind, savedInputChars = null) {
  const inChars = context ? contextLength(context) : savedInputChars;
  const normalized = normalizeUsage(result.usage, { inChars: inChars ?? 0, outChars: result.text?.length || 0 });
  const total = reportedTokenTotal(result.usage);
  const usage = result.failed ? errorTokenUsage(result.usage) : total != null ? { ...normalized, total, totalEstimated: false }
    : normalized.est && inChars == null ? null : normalized;
  const cost = deepTalkUsageSplit(usage) ? computeCost(usage, conn) : null;
  if (Object.hasOwn(AUXILIARY_LABELS, kind)) await memoryUsageReceipts({ at: Date.now(), kind, model: conn.model, usage, cost }).catch(() => {});
  if (!result.failed || usage) await recordUsage({ kind, requestId: replyId, model: conn.model, usage, cost });
  return { usage, cost, elapsed, reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens ?? null };
}

async function selectTopic(connection, selection, signal) {
  const { context, keys } = selection;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) return null;
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort('timeout'), 4500);
  const requestId = uid();
  const started = Date.now();
  let response;
  try {
    response = await streamWithRetry({ ...connection, stream: false }, { ...context,
      signal: controller.signal, maxTokens: 128, reasoningEffort: supportsReasoningEffort(connection) ? 'low' : undefined,
      retainErrorUsage: true,
    }, { retries: 0, requestKind: TOPIC_RECALL_KIND });
  } catch (error) {
    response = { failed: true, usage: error.usage };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
  await recordDeepTalkUsage(connection, response, context, requestId, Date.now() - started, TOPIC_RECALL_KIND);
  return response.text && !response.flagged && !response.truncated ? readTopicChoice(keys, response.text) : null;
}

export async function generateDeepTalk({ text, turnId = '', resume = false, deeper = false, manualKeys = [], signal,
  onSearching = () => {}, onStart = () => {}, onText = () => {}, onThinking = () => {} }) {
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
    const selector = (settings.autoTopics || settings.autoStoryRecall) && connections.find(conn => conn.id === settings.memoryConnectionId);
    const previous = history.at(-1);
    let automaticTopic = '';
    let automaticStory = null;
    let storyClarification;
    if (!pending && selector && !manualKeys.length && canSelectTopic(prompt) &&
        !isRecallFeedback(prompt) && !sensitiveTopics(prompt, previous).length) {
      const recent = previous && !previous.excludeContext && !previous.sensitiveTopics?.length ? previous.text : '';
      if (settings.autoStoryRecall) onSearching();
      const storyLookup = settings.autoStoryRecall
        ? await findChatStoryReferences({ text: prompt, recent, settings, signal }).catch(() => ({ rows: [] }))
        : { rows: [] };
      if (signal?.aborted) return null;
      storyClarification = storyLookup.clarify;
      const selection = storyClarification ? null
        : topicSelectionInput({ text: prompt, materials: settings.autoTopics ? materials : {}, recent, storyRows: storyLookup.rows });
      if (selection) {
        if (!settings.autoStoryRecall) onSearching();
        const choice = await selectTopic(selector, selection, signal).catch(() => null);
        if (signal?.aborted) return null;
        if (choice?.key.startsWith('story/'))
          automaticStory = await chatStoryReference(storyLookup.rows, choice, prompt, recent).catch(() => null);
        else if (choice) automaticTopic = choice.key;
      }
    }
    if (signal?.aborted) return null;
    const context = pending ? null : buildDeepTalkContext({
      text: prompt, turns: history, materials, memory, manualKeys, automaticTopic, automaticStory, storyClarification,
    });
    const storedEffort = settings.efforts[conn.id];
    const effort = supportsReasoningEffort(conn) ? (deeper ? 'high' : Object.hasOwn(EFFORT_LABELS, storedEffort) ? storedEffort : 'medium') : null;
    const kind = !previousTurn ? CHAT_KIND : selectedReply(previousTurn)?.status === 'done' ? REWRITE_KIND : RETRY_KIND;
    const reply = pending || { id: uid(), kind, connectionId: conn.id, model: conn.model, format: guessFormat(conn), stream: conn.stream !== false,
      effort, status: 'running', text: '', at: Date.now(), inputChars: contextLength(context),
      refs: context.used, always: context.always, contextKey: context.contextKey };
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
        cachePrefix: context?.cachePrefix, cacheScope: 'deeptalk', signal, retainErrorUsage: true,
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
      }, { retries: 0, requestKind: resume ? RESUME_KIND : kind });
      const receipt = await recordDeepTalkUsage(conn, result, context, reply.id, Date.now() - started, CHAT_KIND, reply.inputChars);
      turn = await putReply(turn.id, reply.id, { status: result.truncated ? 'partial' : 'done', text: result.text,
        error: result.truncated ? '回复达到输出上限' : '', relayJob: '', relayServer: '', ...receipt });
    } catch (error) {
      const stopped = signal?.aborted || error.kind === 'aborted';
      const canResume = relayJob && (!stopped || ['leave', 'reconnect'].includes(signal?.reason)) &&
        /^(?:relay_network|relay_throttled|network|timeout|aborted)$/.test(error.kind || '');
      const usage = errorTokenUsage(error.usage);
      turn = await putReply(turn.id, reply.id, { status: stopped ? 'stopped' : visible ? 'partial' : 'error',
        text: visible, relayJob: canResume ? relayJob : '', relayServer: canResume ? relayServer : '',
        error: stopped ? '已停止' : [error.message || '日常聊天请求失败', error.hint].filter(Boolean).join('。'),
        elapsed: Date.now() - started, ...(usage ? { usage, cost: deepTalkUsageSplit(usage) ? computeCost(usage, conn) : null } : {}) });
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
      return current?.selectedId === turn.selectedId && !current.excludeContext && !current.sensitiveTopics?.length && !usedStoryRecall(current) &&
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
