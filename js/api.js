// 墨游 · 接口层
// 支持两种格式：OpenAI 兼容（绝大多数中转站、DeepSeek、OpenRouter 等）和 Claude 原生。
// 设计要点（针对旧版的问题）：
//  - 不强塞参数：温度留空就不发；新模型自动改用 max_completion_tokens；不强制 JSON 输出
//  - 流式输出，可停止；中途断开时把已收到的部分交还给界面保存
//  - 回复内容为空、被拦截、被截断，和网络错误分开报告
//  - 所有错误都翻译成中文并附修法，原始返回保留在 detail 里方便排查

import { resolveVertex, parseServiceAccount, vertexBaseUrl, VERTEX_MODELS } from './vertex.js';
import { getRelay, relayFetch, RelayError } from './relay.js';
import { inspectReasoning, stripReasoning, extractFinalOutput, extractUnmarkedStory, FINAL_BOUNDARY_GUIDE } from './reasoning.js';
import { acquireVertexCache, vertexCacheTarget, forgetVertexCache, isCacheRejection } from './prompt-cache.js';
import { db } from './db.js';
import { recordRequest } from './cost.js';

export const FORMAT_LABEL = { auto: '自动识别', openai: 'OpenAI 兼容', anthropic: 'Claude 原生', vertex: 'Google Vertex AI（服务账号 JSON）' };

/** Vertex 连接：先用服务账号 JSON 换令牌，变成一条 OpenAI 兼容连接；其他连接原样返回 */
async function effectiveConn(conn) {
  if (conn?.format !== 'vertex') return conn;
  try { return await resolveVertex(conn); }
  catch (e) { throw new ApiError(e.kind === 'vertex' ? 'auth' : 'network', e.message, { hint: e.hint || '', detail: e.detail || '' }); }
}

export class ApiError extends Error {
  constructor(kind, message, { hint = '', status = 0, detail = '', url = '', partial = '' } = {}) {
    super(message);
    this.kind = kind;
    this.hint = hint;
    this.status = status;
    this.detail = detail;
    this.url = url;
    this.partial = partial;
  }
  toJSON() {
    return { kind: this.kind, message: this.message, hint: this.hint, status: this.status, detail: this.detail, url: this.url,
      ...(this.kind === 'output_format' && this.finish ? { finish: this.finish } : {}) };
  }
}

// ───────────── 地址 ─────────────

export function guessFormat(conn) {
  if (conn.format && conn.format !== 'auto') return conn.format;
  return /anthropic|claude/i.test(conn.baseUrl || '') && !/openai/i.test(conn.baseUrl || '') ? 'anthropic' : 'openai';
}

export function normalizeUrl(format, base, conn = null) {
  if (format === 'vertex') {
    try { return vertexBaseUrl(parseServiceAccount(conn?.apiKey), conn?.region) + '/chat/completions'; }
    catch (e) { throw new ApiError('bad_url', e.message, { hint: e.hint || '' }); }
  }
  let u = String(base || '').trim().replace(/\s+/g, '');
  if (!u) u = format === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(u); } catch {
    throw new ApiError('bad_url', '接口地址格式不对', { hint: '地址应该像 https://example.com/v1 这样。' });
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  if (format === 'anthropic') {
    if (/\/messages$/i.test(path)) return u;
    if (/\/v\d+$/i.test(path)) return u + '/messages';
    return u + '/v1/messages';
  }
  if (/\/chat\/completions$/i.test(path)) return u;
  if (!path) return u + '/v1/chat/completions';
  return u + '/chat/completions';
}

export function modelsUrl(format, base) {
  const u = normalizeUrl(format, base);
  return format === 'anthropic' ? u.replace(/\/messages$/i, '/models') : u.replace(/\/chat\/completions$/i, '/models');
}

function isOfficialAnthropic(url) {
  try { return new URL(url).hostname === 'api.anthropic.com'; } catch { return false; }
}

function headersFor(format, conn, url, json = true) {
  const h = {};
  if (json) h['Content-Type'] = 'application/json';
  if (format === 'anthropic') {
    h['x-api-key'] = conn.apiKey;
    h['anthropic-version'] = '2023-06-01';
    if (isOfficialAnthropic(url)) h['anthropic-dangerous-direct-browser-access'] = 'true';
    else h['Authorization'] = 'Bearer ' + conn.apiKey; // 有的中转只认这种
  } else {
    h['Authorization'] = 'Bearer ' + conn.apiKey;
  }
  return h;
}

// ───────────── 请求体 ─────────────

function usesCompletionTokens(model) {
  return /^(o\d|gpt-5)/i.test(String(model || '').replace(/^.*\//, ''));
}

function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 合并相邻同角色消息，保证第一条是 user（部分接口要求） */
export function tidyMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !m.content) continue;
    const content=m.role==='assistant'?stripReasoning(m.content):m.content;
    if(!content)continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + content;
    else out.push({ role: m.role, content });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '（故事从这里继续）' });
  return out;
}

export function supportsReasoningEffort(conn) {
  return !!conn && guessFormat(conn) === 'openai' && /^gpt-5\.6-sol(?::flex)?$/i.test(String(conn.model || '').split('/').at(-1));
}

function buildBody(format, conn, { system, messages, stream, maxTokens, reasoningEffort }) {
  const mt = num(maxTokens) || num(conn.maxTokens) || 8000;
  const temp = num(conn.temperature);
  const msgs = tidyMessages(messages);
  if (format === 'anthropic') {
    const b = { model: conn.model, max_tokens: mt, messages: msgs };
    if (system) b.system = system;
    if (temp != null) b.temperature = temp;
    if (stream) b.stream = true;
    return b;
  }
  const b = { model: conn.model, messages: system ? [{ role: 'system', content: system }, ...msgs] : msgs };
  b[usesCompletionTokens(conn.model) ? 'max_completion_tokens' : 'max_tokens'] = mt;
  if (reasoningEffort != null && supportsReasoningEffort(conn)) {
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) b.reasoning_effort = reasoningEffort;
  } else if (temp != null) b.temperature = temp;
  if (stream) {
    b.stream = true;
    // 让流式也返回用量（算花费用）；个别接口不认这个参数，会自动退回
    if (conn.usageOpt !== false) b.stream_options = { include_usage: true };
  }
  return b;
}

// ───────────── 错误翻译 ─────────────

function errText(raw) {
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const e = j.error ?? j;
    if (typeof e === 'string') return e;
    return e.message || e.msg || j.message || raw;
  } catch { return raw; }
}

const QUOTA_RE = /(insufficient|quota|balance|credit|billing|余额|额度|欠费|用尽)/i;
const CAPACITY_RE = /\bresource[_ -]exhausted\b|\brate[_ -]limit(?:ed|[_ -]error|[_ -]exceeded)\b/i;
const rateLimit = (details) => new ApiError('ratelimit', '模型容量紧张，请稍后手动重试或换模型', details);

function httpError(status, raw, url) {
  const msg = errText(raw);
  const detail = `HTTP ${status}\n${String(raw || '').slice(0, 1500)}`;
  const o = { status, detail, url };
  if (status === 429 || CAPACITY_RE.test(raw)) return rateLimit(o);
  if (status === 401 || status === 403) {
    if (QUOTA_RE.test(msg)) return new ApiError('quota', '余额或额度不足', { ...o, hint: '去中转站或官方后台看看余额。有的中转站会按“输入长度＋输出上限”先预扣额度，余额还剩一些也可能报这个：可以把连接的“输出上限”调小（比如 4000）再试。' });
    return new ApiError('auth', '密钥无效或没有权限', { ...o, hint: '检查密钥有没有复制完整、有没有过期。中转站的密钥只能配它自己的地址。' });
  }
  if (status === 402 || QUOTA_RE.test(msg)) return new ApiError('quota', '余额或额度不足', { ...o, hint: '去中转站或官方后台看看余额。有的中转站会按“输入长度＋输出上限”先预扣额度，余额还剩一些也可能报这个：可以把连接的“输出上限”调小（比如 4000）再试。' });
  if (status === 404) {
    if (/model/i.test(msg)) return new ApiError('model', '找不到这个模型', { ...o, hint: /aiplatform\.googleapis\.com/.test(url || '') ? '这个模型在 Vertex 上找不到：可能已经下线（gemini-2.5 系列 2026 年 10 月下线了），或者这个地区没有。点“获取模型列表”换一个，比如 gemini-3.8-flash。' : '模型名可能拼错了，或者这个接口没有这个模型。可以在连接设置里点“获取模型列表”。' });
    return new ApiError('notfound', '地址不对（404）', { ...o, hint: `实际请求的地址是 ${url} 。检查地址结尾（中转站一般是 /v1），或者把接口格式改成“自动识别”。` });
  }
  if (status === 405) return new ApiError('notfound', '地址不对（这个地址不接受这种请求）', { ...o, hint: '可能选错了接口格式，试试“自动识别”。' });
  if (status === 408) return new ApiError('timeout', '接口请求超时', o);
  if (status === 413) return new ApiError('toolong', '内容太长，接口拒收', { ...o, hint: '故事太长了，超出了接口能接收的大小。' });
  if (status === 529) return new ApiError('overloaded', '模型服务繁忙', { ...o, hint: '官方服务器忙，过一会儿再试。' });
  if (status >= 500) {
    const hint = status === 502 || status === 503 || status === 504
      ? '上游服务暂时不可用或超时，通常过一会儿就好。'
      : '通常是对方临时故障，稍后重试。';
    return new ApiError('server', `接口那边出错了（${status}）`, { ...o, hint });
  }
  // 400 / 422 等：尽量猜出是哪个参数
  if (/stream_options|include_usage/i.test(msg)) return new ApiError('no_stream_options', '这个接口不支持返回用量', { ...o, hint: '已记住这条连接的兼容方式。后续会省略用量参数，花费按字数估算。' });
  if (/model/i.test(msg) && /(not ?found|not exist|does not exist|invalid|unknown|not supported|无可用渠道|不存在|不支持)/i.test(msg)) {
    return new ApiError('model', '模型名不对，或这个接口没有这个模型', { ...o, hint: '在连接设置里点“获取模型列表”核对一下。' });
  }
  if (/temperature/i.test(msg)) return new ApiError('badreq', '这个模型不接受自定义温度', { ...o, hint: '在连接设置里把“温度”留空。' });
  if (/reasoning_effort/i.test(msg)) return new ApiError('badreq', '这条接口不接受所选思考强度', { ...o, hint: '把思考强度设为「接口默认」后重试。' });
  if (/max_tokens|max_completion_tokens|max_output/i.test(msg)) return new ApiError('badreq', '输出上限设置不被接受', { ...o, hint: '把连接设置里的“输出上限”调小一点（例如 4000）再试。' });
  if (/(context|prompt is too long|too many tokens|maximum.*tokens|上下文|超出)/i.test(msg)) return new ApiError('toolong', '内容超出模型能接收的长度', { ...o, hint: '故事太长了。之后的版本会自动整理前情；现在可以先换个上下文更长的模型。' });
  if (/stream/i.test(msg)) return new ApiError('badreq', '这个接口不支持流式输出', { ...o, hint: '在连接设置里关掉“流式输出”。' });
  return new ApiError('badreq', `请求被拒绝（${status}）`, { ...o, hint: '下面是接口返回的原文。看不懂可以复制给我。' });
}

function networkError(url, e) {
  if (typeof location !== 'undefined' && location.protocol === 'https:' && /^http:/i.test(url)) {
    return new ApiError('mixed', '这个页面是 https，浏览器不允许它调用 http 地址', {
      url, detail: String(e?.message || e || ''),
      hint: '给接口配上 https（域名 + 证书），或者换成 https 的地址。',
    });
  }
  return new ApiError('network', '连不上接口', {
    url, detail: String(e?.message || e || ''),
    hint: '可能是：① 网络或代理问题；② 这个接口不允许网页直接调用（跨域限制）——酒馆能连不代表这里能连，因为酒馆是服务器去连的；③ 域名写错了。连接测试一直这样的话多半是②，可以用自己的服务器转发。',
  });
}

function streamError(errObj, partial) {
  const e = errObj?.error ?? errObj ?? {};
  const msg = typeof e === 'string' ? e : (e.message || JSON.stringify(e));
  const type = (e && e.type) || '';
  const status = Number(e.statusCode || e.status || e.code || errObj?.status) || 0;
  if (status === 429 || CAPACITY_RE.test(JSON.stringify(e))) return rateLimit({ status, detail: msg, partial });
  if (/stream_options|include_usage/i.test(msg) && !partial) return httpError(status || 400, msg, '');
  if (/overloaded/i.test(type + msg)) return new ApiError('overloaded', '模型服务繁忙', { hint: '过一会儿再试。已收到的部分会保留。', detail: msg, partial });
  if (QUOTA_RE.test(msg)) return new ApiError('quota', '余额或额度不足', { hint: '去中转站或官方后台看看余额。有的中转站会按“输入长度＋输出上限”先预扣额度，余额还剩一些也可能报这个：可以把连接的“输出上限”调小（比如 4000）再试。', detail: msg, partial });
  return new ApiError('server', '生成到一半出错了', { hint: '可以点“续写”接着写，或者重试。', detail: msg, partial });
}

const BLOCKED_FINISH = /content_filter|safety|blocked|prohibited/i;

function emptyError(finish, sawThinking) {
  const f = String(finish || '');
  if (/refusal/i.test(f)) return new ApiError('refusal', '模型拒绝了这次请求', { hint: '这轮内容被模型拒绝了。可以换个说法、换个模型，或者重试。', detail: `结束原因：${f}` });
  if (BLOCKED_FINISH.test(f)) return new ApiError('blocked', '内容被安全策略拦截', { hint: '这家接口拦下了这轮内容。可以换个说法或换个模型。', detail: `结束原因：${f}` });
  if (/length|max_tokens/i.test(f) && sawThinking) return new ApiError('empty', '输出上限被思考过程用完了', { hint: '在连接设置里把“输出上限”调大（例如 8000 以上）。', detail: `结束原因：${f}` });
  if(sawThinking)return new ApiError('empty','模型只返回了思考内容，没有正文',{hint:'思考内容已隐藏。请检查接口的思考输出配置，或重新生成。',detail:f?`结束原因：${f}`:'没有收到最终回答'});
  return new ApiError('empty', '模型返回了空内容', {
    hint: '常见原因：内容被安全策略拦截；或者开了思考的模型把输出上限用完了（把“输出上限”调大）。',
    detail: f ? `结束原因：${f}` : '没有收到任何正文',
  });
}

// ───────────── 解析回复 ─────────────

function partsText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p=>!['thinking','reasoning','analysis','reasoning_content'].includes(p?.type) && p?.channel!=='analysis').map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  return '';
}

function parseNonStream(format, j) {
  const errorEvent = Array.isArray(j) ? j.find((item) => item?.error) : j;
  if (errorEvent?.error || errorEvent?.type === 'error') throw streamError(errorEvent, '');
  if (format === 'anthropic') {
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const thinking = (j.content || []).some((b) => b.type === 'thinking');
    return { text, finish: j.stop_reason, usage: j.usage || null, thinking };
  }
  const ch = j.choices?.[0];
  const internal=['analysis','reasoning','thinking'].includes(ch?.message?.channel);
  const text = internal?'':partsText(ch?.message?.content);
  return { text, finish: ch?.finish_reason, usage: j.usage || j.usageMetadata || null, thinking: internal || !!(ch?.message?.reasoning_content || ch?.message?.reasoning) };
}

// ───────────── 发请求 ─────────────

function linkAbort(signal) {
  const ctrl = new AbortController();
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return ctrl;
}

function checkConn(conn) {
  if (!conn) throw new ApiError('no_conn', '这个故事还没有选择连接', { hint: '在设置里添加一个 API 连接。' });
  if (!conn.apiKey) throw new ApiError('no_key', '还没有填 API 密钥', { hint: '在设置 → 连接里填写密钥。' });
  if (!conn.model) throw new ApiError('no_model', '还没有填模型名', { hint: '在设置 → 连接里填写模型名，或点“获取模型列表”。' });
}

/**
 * 流式生成。
 * onText(delta, full) 每收到一段正文调用；onThinking() 收到思考内容时调用。
 * 返回 { text, finish, usage, truncated, flagged }。
 * 出错时抛 ApiError，已收到的正文在 err.partial 里。
 */
export async function streamChat(conn, opts = {}) {
  let visible='',received=false,thinking=false,rawOutput='';
  const thinkingOnce=()=>{received=true;if(!thinking){thinking=true;opts.onThinking?.();}};
  const publishText = (text) => {
    if (text === visible) return;
    const delta = text.slice(visible.length);
    visible = text;
    opts.onText?.(delta, visible);
  };
  const publish=(full,streaming)=>{
    const cleaned=inspectReasoning(full,{streaming});
    rawOutput=cleaned.text;
    if(cleaned.hidden)thinkingOnce();
    const text=opts.outputBoundary?extractFinalOutput(cleaned.text,{streaming}).text:cleaned.text;
    if(opts.outputBoundary&&!text&&full)thinkingOnce();
    publishText(text);
  };
  try {
    let cachePrefix = opts.cachePrefix && opts.system?.startsWith(opts.cachePrefix) ? opts.cachePrefix : '';
    let system = opts.system;
    if (opts.outputBoundary) {
      if (cachePrefix) {
        system = [FINAL_BOUNDARY_GUIDE, system].join('\n\n');
        cachePrefix = [FINAL_BOUNDARY_GUIDE, cachePrefix].join('\n\n');
      } else system = [system, FINAL_BOUNDARY_GUIDE].filter(Boolean).join('\n\n');
    }
    const result=await streamChatRaw(conn,{...opts,system,cachePrefix,onText:(_delta,full)=>{received=true;publish(full,true);},onThinking:thinkingOnce});
    publish(result.text,false);
    if (opts.outputBoundary && !extractFinalOutput(rawOutput).found) {
      const fallback = !result.flagged && !result.truncated ? extractUnmarkedStory(rawOutput) : '';
      if (fallback) publishText(fallback);
      else {
        const error = result.flagged || !rawOutput.trim()
          ? emptyError(result.finish, thinking)
          : new ApiError('output_format', '回复缺少正文标记', {
            hint: '模型返回了文字。你可以先核对内容，再决定是否接回本次回复，或者重新生成。',
            detail: rawOutput,
          });
        error.usage = result.usage;
        error.finish = result.finish;
        throw error;
      }
    }
    if (!visible.trim()) {
      const error = emptyError(result.finish, thinking);
      if (opts.retainErrorUsage) error.usage = result.usage;
      throw error;
    }
    return {...result,text:visible};
  } catch(e) {
    if(e instanceof ApiError){const text=stripReasoning(e.partial||visible,{streaming:true});e.partial=opts.outputBoundary?(e.partial?extractFinalOutput(text,{streaming:true}).text:visible):text;e.receivedOutput=received;}
    throw e;
  }
}
async function streamChatRaw(conn, { system, messages = [], maxTokens, reasoningEffort, signal, onText = () => {}, onThinking = () => {}, onJob, resumeJob = null, relayServer = '', direct = false, firstByteMs = 150000, idleMs = 90000, cachePrefix = '', cacheScope = '', onCache = () => {}, requestStats = null, retainErrorUsage = false }) {
  const vertex = conn?.format === 'vertex';
  if (!resumeJob) { checkConn(conn); conn = await effectiveConn(conn); }
  const format = guessFormat(conn);
  const url = resumeJob ? '' : normalizeUrl(format, conn.baseUrl);
  const wantStream = conn.stream !== false;
  const body = buildBody(format, conn, { system, messages, stream: wantStream, maxTokens, reasoningEffort });
  const ctrl = linkAbort(signal);
  const config = resumeJob || (conn.viaRelay && !direct) ? await getRelay() : null;
  const viaRelay = !!resumeJob || !!(config?.on && conn.viaRelay && !direct);
  const request = (target, init, relayOptions = {}, type = 'generation') => {
    const onSubmit = () => {
      if (!requestStats) return;
      requestStats.posts++;
      if (type === 'cache') requestStats.cachePosts++;
      if (viaRelay) requestStats.relayPosts++;
    };
    if (viaRelay) return relayFetch(target, init, { config, ...relayOptions, onSubmit });
    onSubmit();
    return fetch(target, init);
  };
  let useBody = body;
  let vertexCache = null;
  let cacheMode = '';
  if (!resumeJob && cachePrefix) {
    const suffix = system.slice(cachePrefix.length).trim();
    const target = vertex ? vertexCacheTarget(url, conn.model) : null;
    if (target) {
      cacheMode = 'vertex-implicit';
      if (conn.promptCache === true && (!requestStats || requestStats.posts === 0)) {
        let cacheLimit;
        const acquired = await acquireVertexCache(target, {
          prefix: cachePrefix, scope: cacheScope, signal: ctrl.signal,
          request: async (endpoint, init) => {
            const res = await request(endpoint, { ...init, headers: headersFor(format, conn, endpoint) }, {}, 'cache').catch((error) => {
              if (error.status === 429) cacheLimit = rateLimit({ status: 429, detail: error.message });
              throw error;
            });
            if (!res.ok && requestStats) {
              const error = httpError(res.status, await res.clone().text().catch(() => ''), endpoint);
              if (error.kind === 'ratelimit') cacheLimit = error;
            }
            return res;
          },
        }).catch(() => null);
        if (cacheLimit) throw cacheLimit;
        vertexCache = acquired?.cache;
        if (acquired?.created) onCache({ created: acquired.created });
        if (vertexCache) {
          useBody = { ...body,
            messages: tidyMessages([...(suffix ? [{ role: 'user', content: suffix }] : []), ...body.messages.slice(1)]),
            extra_body: { google: { cached_content: vertexCache.name } },
          };
          cacheMode = 'vertex-explicit';
        }
      }
    } else if (conn.promptCache === true && format === 'anthropic' && isOfficialAnthropic(url) &&
        /^claude-(?:3-(?:haiku|sonnet|opus)|(?:haiku|sonnet|opus|fable|mythos)-[345])(?:-|\.|$)/.test(conn.model)) {
      useBody = { ...body, system: [{ type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
        ...(suffix ? [{ type: 'text', text: suffix }] : [])] };
      cacheMode = 'claude';
    }
    if (cacheMode) onCache({ mode: cacheMode });
  }
  let timer = null;
  let timedOut = false;
  const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ctrl.abort('idle'); }, ms); };

  let text = '';
  let finish = null;
  let usage = null;
  let sawThinking = false;
  const fail = (error) => {
    if (!error.partial) error.partial = text;
    if (retainErrorUsage && usage) error.usage = usage;
    return error;
  };
  const abortedErr = () => (timedOut
    ? new ApiError(viaRelay ? 'relay_network' : 'timeout', '长时间没有响应', { hint: viaRelay ? '服务器仍会继续生成，回到前台或点“接回后台生成”可重新获取。' : '网络太慢或接口卡住了。已收到的部分会保留，可以续写或重试。', partial: text, url })
    : new ApiError('aborted', '已停止', { partial: text, url }));

  arm(firstByteMs);
  let res;
  try {
    const send = b => request(url, { method: 'POST', headers: headersFor(format, conn, url), body: JSON.stringify(b), signal: ctrl.signal }, { onJob, resumeJob, relayServer });
    if (ctrl.signal.aborted) throw abortedErr();
    res = await send(useBody);
    if (useBody !== body && [400, 403, 404].includes(res.status)) {
      const raw = await res.text().catch(() => '');
      const error = httpError(res.status, raw, url);
      if (error.kind === 'ratelimit' || !isCacheRejection(res.status, raw)) throw error;
      if (vertexCache) forgetVertexCache(vertexCache);
      onCache({ mode: vertexCache ? 'vertex-implicit' : '' });
      if (resumeJob || requestStats?.posts >= 2) throw error;
      arm(firstByteMs);
      res = await send(body);
    }
  } catch (e) {
    clearTimeout(timer);
    if (ctrl.signal.aborted) throw abortedErr();
    if (e instanceof RelayError) {
      if (e.status === 429 && e.kind !== 'relay_throttled') throw rateLimit({ status: 429, detail: e.message });
      throw new ApiError(e.kind, e.message, e);
    }
    if (e instanceof ApiError) throw e;
    if (viaRelay) throw new ApiError('relay_network', '连不上转发服务器', { hint: '任务可能已创建。请先检查网络和转发设置，避免重复请求模型。' });
    throw networkError(url, e);
  }

  try {
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw httpError(res.status, raw, url);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) {
      const raw = await res.text().catch(() => '');
      throw new ApiError('html', '接口返回了网页，而不是数据', { url, detail: raw.slice(0, 800), hint: '地址可能填成了中转站的网页地址。API 地址通常以 /v1 结尾。' });
    }
    if (!wantStream || (ct.includes('json') && !ct.includes('event-stream'))) {
      const raw = await res.text();
      let j;
      try { j = JSON.parse(raw); } catch { throw new ApiError('badresp', '接口返回的内容看不懂', { url, detail: raw.slice(0, 800), hint: '可能是地址填错了，或者中转站出了问题。' }); }
      const r = parseNonStream(format, j);
      text = r.text || '';
      finish = r.finish; usage = r.usage; sawThinking = r.thinking;
      if (text) onText(text, text);
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let rawHead = '';
      let sawData = false;
      const handle = (line) => {
        if (!line.startsWith('data:')) return;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') return;
        sawData = true;
        let j;
        try { j = JSON.parse(d); } catch { return; }
        const errorEvent = Array.isArray(j) ? j.find((item) => item?.error) : j;
        if (errorEvent?.error || errorEvent?.type === 'error') throw streamError(errorEvent, text);
        if (format === 'anthropic') {
          if (j.type === 'content_block_delta') {
            if (j.delta?.type === 'text_delta' && j.delta.text) { text += j.delta.text; onText(j.delta.text, text); }
            else if (j.delta?.type === 'thinking_delta') { sawThinking = true; onThinking(); }
          } else if (j.type === 'content_block_start' && j.content_block?.type === 'thinking') {
            sawThinking = true; onThinking();
          } else if (j.type === 'message_delta') {
            if (j.delta?.stop_reason) finish = j.delta.stop_reason;
            if (j.usage) usage = { ...(usage || {}), ...j.usage };
          } else if (j.type === 'message_start' && j.message?.usage) {
            usage = { ...j.message.usage };
          }
          // 也兼容少数把 Claude 格式转成 OpenAI 块的中转
          if (j.choices) handleOpenAI(j);
        } else {
          handleOpenAI(j);
        }
      };
      const handleOpenAI = (j) => {
        const ch = j.choices?.[0];
        if (ch) {
          const delta = ch.delta || ch.message || {};
          const internal=['analysis','reasoning','thinking'].includes(delta.channel);
          const piece = internal?'':partsText(delta.content);
          if (piece) { text += piece; onText(piece, text); }
          if (internal || delta.reasoning_content || delta.reasoning) { sawThinking = true; onThinking(); }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
        if (j.usage || j.usageMetadata) usage = j.usage || j.usageMetadata;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm(idleMs);
        const chunk = dec.decode(value, { stream: true });
        if (rawHead.length < 2000) rawHead += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          handle(line);
        }
      }
      if (buf.trim()) handle(buf.trim());
      if (!sawData && rawHead.trim()) {
        // 声称流式、实际一次性返回 JSON 的接口
        try {
          const r = parseNonStream(format, JSON.parse(rawHead));
          text = r.text || ''; finish = r.finish; usage = r.usage; sawThinking = r.thinking;
          if (text) onText(text, text);
        } catch (e) {
          if (e instanceof ApiError) throw e;
          throw new ApiError('badresp', '接口返回的内容看不懂', { url, detail: rawHead.slice(0, 800), hint: '可能是地址填错了，或者中转站的流式输出有问题，可以在连接设置里关掉“流式输出”。' });
        }
      }
    }
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof RelayError) throw fail(new ApiError(e.kind, e.message, { ...e, partial: text }));
    if (e instanceof ApiError) throw fail(e);
    if (ctrl.signal.aborted) throw fail(abortedErr());
    const ne = new ApiError(viaRelay ? 'relay_network' : 'network', '连接中途断开了', { url, detail: String(e?.message || e), partial: text, hint: viaRelay ? '后台仍在生成，回到前台或点“接回后台生成”可重新获取。' : '常见于切走应用、网络切换。已收到的部分已保留，可以点“续写”。' });
    throw fail(ne);
  }
  clearTimeout(timer);

  if (!text.trim()) throw fail(emptyError(finish, sawThinking));
  const f = String(finish || '');
  return {
    text,
    finish,
    usage,
    truncated: /^(length|max_tokens)$/i.test(f),
    flagged: /refusal/i.test(f) || BLOCKED_FINISH.test(f),
  };
}


const transientErrors = new Set(['network', 'timeout', 'server', 'overloaded']);
let storyQueue = Promise.resolve();
const detachedStoryJobs = new Map();

export function holdStoryJob(id) {
  if (detachedStoryJobs.has(id)) return;
  let release;
  const done = new Promise((resolve) => { release = resolve; });
  const timer = setTimeout(() => releaseStoryJob(id), 15 * 60 * 1000);
  detachedStoryJobs.set(id, { done, release, timer });
}

export function releaseStoryJob(id) {
  const job = detachedStoryJobs.get(id);
  if (!job) return;
  clearTimeout(job.timer);
  detachedStoryJobs.delete(id);
  job.release();
}

function retryDelay(signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, 4000);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

function waitForStoryJobs(signal) {
  const pending = Promise.all([...detachedStoryJobs.values()].map((job) => job.done));
  if (!signal) return pending;
  return new Promise((resolve) => {
    const done = () => { signal.removeEventListener('abort', done); resolve(); };
    signal.addEventListener('abort', done, { once: true });
    pending.then(done);
    if (signal.aborted) done();
  });
}

export function streamWithRetry(conn, opts, settings = {}) {
  const run = async () => {
    if (settings.queueStory === 'archive') {
      while (!opts.signal?.aborted && detachedStoryJobs.size) {
        await waitForStoryJobs(opts.signal);
      }
    }
    return runRequest(conn, opts, settings);
  };
  if (!settings.queueStory || opts.resumeJob) return run();
  const queued = storyQueue.then(run);
  storyQueue = queued.catch(() => {});
  return queued;
}

async function runRequest(conn, opts, { retries = 1, onRetry = () => {}, onConnPatch = () => {}, requestKind = '', storyId = '' }) {
  const stats = { posts: 0, cachePosts: 0, relayPosts: 0 };
  const memoKey = !opts.resumeJob && conn?.id != null ? 'usageOptUnsupported.' + JSON.stringify([conn.id, conn.baseUrl || '']) : '';
  let outcome;
  try {
    if (memoKey && conn.usageOpt !== false && await db.kvGet(memoKey, false).catch(() => false)) {
      conn = { ...conn, usageOpt: false };
      onConnPatch({ usageOpt: false });
    }
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new ApiError('aborted', '已停止');
      try {
        return await streamChat(conn, { ...opts, requestStats: stats });
      } catch (error) {
        const cleanFailure = !opts.signal?.aborted && !opts.resumeJob && !error.partial && !error.receivedOutput;
        const available = cleanFailure && attempt === 0 && stats.posts < 2;
        if (cleanFailure && error.kind === 'no_stream_options' && conn.usageOpt !== false) {
          conn = { ...conn, usageOpt: false };
          if (memoKey) await db.kvSet(memoKey, true).catch(() => {});
          onConnPatch({ usageOpt: false });
          if (available) continue;
        }
        if (!available || retries < 1 || !transientErrors.has(error.kind)) throw error;
        onRetry(error, 1);
        await retryDelay(opts.signal);
      }
    }
  } catch (error) {
    outcome = error;
    throw error;
  } finally {
    if (requestKind) await recordRequest({ ...stats, kind: requestKind, storyId, model: conn?.model || '',
      outcome: outcome?.kind || (outcome ? 'error' : 'ok'), status: outcome?.status || 0 });
  }
}

export async function listModels(conn) {
  if (conn?.format === 'vertex') return [...VERTEX_MODELS];
  const format = guessFormat(conn);
  const url = modelsUrl(format, conn.baseUrl);
  let res;
  try {
    res = await fetch(url, { headers: headersFor(format, conn, url, false) });
  } catch (e) { throw networkError(url, e); }
  const raw = await res.text().catch(() => '');
  if (!res.ok) throw httpError(res.status, raw, url);
  let j;
  try { j = JSON.parse(raw); } catch { throw new ApiError('badresp', '模型列表看不懂', { url, detail: raw.slice(0, 500) }); }
  const arr = Array.isArray(j) ? j : (j.data || j.models || []);
  return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean).sort();
}

// ───────────── 连接测试 ─────────────

const PING = [{ role: 'user', content: '请只回复四个字：连接成功' }];

/**
 * 逐步测试连接。onStep({id, state:'wait'|'ok'|'bad'|'info', text, detail})
 * 返回 { ok, format, models }
 */
export async function testConnection(conn, onStep = () => {}) {
  conn = { ...conn, viaRelay: false }; // 连接测试继续验证手机直连；转发在设置里单独测试。
  const step = (id, state, text, detail = '') => onStep({ id, state, text, detail });
  if (!conn.apiKey) { step('pre', 'bad', conn.format === 'vertex' ? '还没有粘贴服务账号 JSON' : '还没有填 API 密钥'); return { ok: false }; }
  if (!conn.model) { step('pre', 'bad', '还没有填模型名'); return { ok: false }; }

  const candidates = conn.format && conn.format !== 'auto'
    ? [conn.format]
    : (guessFormat(conn) === 'anthropic' ? ['anthropic', 'openai'] : ['openai', 'anthropic']);

  let chosen = null;
  let patch = {};
  for (const fmt of candidates) {
    let url;
    try { url = normalizeUrl(fmt, conn.baseUrl, conn); } catch (e) { step('url', 'bad', e.message, e.hint); return { ok: false }; }
    const c = { ...conn, format: fmt, stream: false };
    const sid = 'req-' + fmt;
    step(sid, 'wait', `用「${FORMAT_LABEL[fmt]}」格式请求：${url}`);
    const t0 = performance.now();
    try {
      const r = await streamChat(c, { messages: PING, maxTokens: fmt === 'vertex' ? 2000 : 400, firstByteMs: 60000 });
      const ms = Math.round(performance.now() - t0);
      step(sid, 'ok', `「${FORMAT_LABEL[fmt]}」格式可用，普通请求成功（${(ms / 1000).toFixed(1)} 秒）：模型回复「${r.text.trim().slice(0, 40)}」`);
      chosen = fmt;
      break;
    } catch (e) {
      const tryNext = candidates.length > 1 && fmt === candidates[0] && ['notfound', 'html', 'badresp'].includes(e.kind);
      step(sid, 'bad', `${e.message}${tryNext ? '，换另一种格式再试' : ''}`, [e.hint, e.detail].filter(Boolean).join('\n'));
      if (!tryNext) return { ok: false };
    }
  }
  if (!chosen) return { ok: false };

  // 流式
  if (conn.stream !== false) {
    step('stream', 'wait', '测试流式输出…');
    const t0 = performance.now();
    let first = 0;
    let pieces = 0;
    try {
      let gotUsage = false;
      await streamWithRetry({ ...conn, format: chosen, stream: true }, {
        messages: PING, maxTokens: 400, firstByteMs: 60000,
        onText: () => { pieces++; if (!first) first = performance.now() - t0; },
      }, { retries: 0, onConnPatch: (p) => { patch = { ...patch, ...p }; } }).then((r) => { gotUsage = !!r.usage; });
      step('stream', 'ok', `流式正常：收到 ${pieces} 段，首字 ${(first / 1000).toFixed(1)} 秒`);
      step('usage', gotUsage ? 'ok' : 'info', gotUsage ? '接口会返回用量，花费按真实数字算' : '接口不返回用量，花费会按字数粗估');
    } catch (e) {
      step('stream', 'bad', `流式失败：${e.message}`, `普通请求是通的，说明是这个接口的流式输出有问题。可以在下面关掉“流式输出”再用。\n${e.detail || ''}`);
    }
  } else {
    step('stream', 'info', '流式输出已关闭，跳过');
  }

  // 模型列表（不影响结果）
  let models = [];
  try {
    models = await listModels({ ...conn, format: chosen });
    const has = models.includes(conn.model);
    step('models', has ? 'ok' : 'info', has ? `模型列表里有「${conn.model}」（共 ${models.length} 个）` : `获取到 ${models.length} 个模型，但列表里没有「${conn.model}」——如果上面能用就不用管`);
  } catch (e) {
    step('models', 'info', `模型列表获取失败（不影响使用）：${e.message}`);
  }
  return { ok: true, format: chosen, models, patch };
}
