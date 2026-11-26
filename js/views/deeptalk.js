import { el, sheet, toast, menu, autoGrow } from '../util.js';
import { connLabel, getCurrentStory, go } from '../state.js';
import { supportsReasoningEffort } from '../api.js';
import { fmtMoney } from '../cost.js';
import { deepTalkSettings, deepTalkConnections, selectedReply, readDeepTalkThread, saveDeepTalkSettings, generateDeepTalk,
  chooseDeepTalkReply, rememberDeepTalkTurn, setTurnExcluded, stopPendingDeepTalk, deepTalkRequestPreview,
  deepTalkReplyTokens, deepTalkTokenTotals, EFFORT_LABELS, MAX_USER_CHARS } from '../deeptalk.js';
import { organizeDeepTalk } from '../deeptalk-memory.js';
import { openDeepTalkLibrary } from './deeptalk-library.js';

const button = (label, click, attrs = {}) => el('button', { type: 'button', class: 'btn small', onclick: click, ...attrs }, label);
const tokenNumbers = new Intl.NumberFormat('zh-CN');
const formatTokenAmount = ({ total, estimated }) => `${estimated ? '约 ' : ''}${tokenNumbers.format(total)}`;

export function playModeSwitch(mode, storyId) {
  const story = storyId ? `#/play/${encodeURIComponent(storyId)}` : '#/';
  return el('nav', { class: 'play-mode-switch', 'aria-label': '游玩模式' },
    el('a', { href: story, 'aria-current': mode === 'story' ? 'page' : null }, '跑团'),
    el('a', { href: '#/chat', 'aria-current': mode === 'chat' ? 'page' : null }, '日常聊天'));
}

export async function render(root) {
  let [{ turns, start }, settings, connections] = await Promise.all([readDeepTalkThread(), deepTalkSettings(), deepTalkConnections()]);
  let running = null;
  let organizing = false;
  let organizingVisible = false;
  let disposed = false;
  let changing = false;
  let lastMessage = '';
  let oneShot = false;
  let drawer = null;
  let refreshTokenUsage = null;
  const carry = new Map();
  const idleListeners = new Set();

  const status = el('p', { class: 'deeptalk-status', role: 'status', hidden: true });
  const models = el('select', { 'aria-label': '日常聊天模型' });
  const effort = el('select', { 'aria-label': '思考强度' },
    ...['medium', 'low', 'high'].map(value => el('option', { value }, EFFORT_LABELS[value])),
    el('optgroup', { label: '高级' }, ...['xhigh', 'max', 'default'].map(value => el('option', { value }, EFFORT_LABELS[value]))));
  const effortField = el('label', { class: 'deeptalk-field' }, '思考强度', effort);
  const addConnection = el('a', { class: 'btn small', href: '#/settings' }, '配置 API');
  const empty = el('div', { class: 'deeptalk-empty' }, el('h2', {}, '日常聊天'), el('p', {}, '准备好以后，随便说点什么。'));
  const feed = el('div', { class: 'deeptalk-feed', role: 'log', 'aria-label': '日常聊天记录', 'aria-live': 'off' });
  const viewport = el('div', { class: 'deeptalk-scroll' }, feed);
  const earlier = button('更早的消息', () => void older());
  const draft = el('textarea', { rows: '1', maxlength: MAX_USER_CHARS, placeholder: '说点什么…', 'aria-label': '日常聊天输入' });
  const send = button('发送', () => void run(), { class: 'btn primary deeptalk-send' });
  const deepen = button('本条深入想想', () => { oneShot = !oneShot; sync(); }, { 'aria-pressed': 'false' });
  const carried = el('div', { class: 'deeptalk-carry', hidden: true });
  const composer = el('div', { class: 'composer deeptalk-composer' },
    carried,
    el('div', { class: 'deeptalk-composer-tools' }, deepen, button('本轮资料', () => void openPreview())),
    el('div', { class: 'inrow' }, draft, send));

  function showLibrary() {
    drawer?.close();
    drawer = openDeepTalkLibrary({
      onCarry: (key, title) => {
        if (!carry.has(key) && carry.size >= 3) { toast('一次最多带入三条资料'); return; }
        carry.set(key, title); sync();
      },
      onOrganize: () => organize(false),
      onClose: () => { drawer = null; },
    });
  }

  root.append(el('section', { class: 'view deeptalk-view' },
    el('div', { class: 'topbar' }, el('div', { class: 'title' }, '日常聊天'),
      button('Token 用量', openTokenUsage, { 'aria-haspopup': 'dialog' }), button('资料与记忆', showLibrary)),
    playModeSwitch('chat', getCurrentStory()),
    el('div', { class: 'deeptalk-controls' }, el('label', { class: 'deeptalk-field deeptalk-model' }, '模型', models), effortField, addConnection),
    status, viewport, composer));
  autoGrow(draft, .28);

  const conn = () => connections.find(item => item.id === settings.connectionId);
  const atBottom = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 125;
  const scrollBottom = () => { viewport.scrollTop = viewport.scrollHeight; };
  const busy = () => !!running || organizing;
  function notifyIdle() { if (!busy()) { for (const callback of [...idleListeners]) callback(); } }

  function updateModels() {
    models.replaceChildren(el('option', { value: '' }, '选择聊天连接'), ...connections.map(c => el('option', { value: c.id },
      c.name && c.name !== c.model ? `${connLabel(c)} · ${c.model}` : c.model)));
    models.value = conn()?.id || '';
    sync();
  }

  function sync() {
    const connection = conn();
    const supported = !!connection && supportsReasoningEffort(connection);
    effortField.hidden = !supported;
    effort.value = supported ? settings.efforts[connection.id] || 'medium' : 'medium';
    deepen.hidden = !supported;
    deepen.disabled = changing || !!running;
    deepen.setAttribute('aria-pressed', String(oneShot));
    models.disabled = changing || !connections.length;
    effort.disabled = changing;
    addConnection.hidden = !!connections.length;
    send.textContent = running ? '停止' : '发送';
    send.disabled = !running && (!connection || !draft.value.trim() || changing);
    carried.hidden = !carry.size;
    carried.replaceChildren(...[...carry].map(([key, title]) => button(`${title} · 移除`, () => { carry.delete(key); sync(); })));
    const message = running?.message || (organizingVisible ? '正在整理记忆…' : lastMessage);
    status.textContent = message;
    status.hidden = !message;
  }

  async function selectSetting(patch) {
    changing = true; sync();
    try { settings = await saveDeepTalkSettings(patch); }
    catch (error) { toast(error.message); }
    finally { changing = false; updateModels(); }
  }
  models.addEventListener('change', () => { oneShot = false; void selectSetting({ connectionId: models.value }); });
  effort.addEventListener('change', () => { if (conn()) void selectSetting({ efforts: { [conn().id]: effort.value } }); });
  draft.addEventListener('input', sync);
  draft.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!running) void run(); }
  });

  function renderConversation({ follow = false } = {}) {
    const previous = viewport.scrollTop;
    feed.replaceChildren(...(start > 0 ? [el('div', { class: 'deeptalk-earlier' }, earlier)] : []),
      ...(turns.length ? turns.map(turnCard) : [empty]));
    if (follow) scrollBottom(); else viewport.scrollTop = previous;
  }

  function turnCard(turn) {
    const reply = selectedReply(turn);
    const active = running?.id === turn.id;
    const last = turns.at(-1)?.id === turn.id;
    const position = turn.replies.findIndex(item => item.id === reply?.id);
    const shown = active ? (running.text || '') : (reply?.text || '');
    const time = new Date(turn.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const details = [reply?.model, reply?.effort && EFFORT_LABELS[reply.effort],
      reply?.elapsed && `${(reply.elapsed / 1000).toFixed(1)} 秒`, reply?.cost && fmtMoney(reply.cost)].filter(Boolean).join(' · ');
    const tokens = deepTalkReplyTokens(reply);
    const user = el('div', { class: 'deeptalk-message user' },
      el('div', { class: 'deeptalk-bubble', text: turn.text }),
      el('div', { class: 'deeptalk-message-tools' }, el('span', {}, time), button('⋯', () => void turnMenu(turn), { 'aria-label': '你的消息操作' })));
    const output = el('div', { class: 'deeptalk-bubble', 'data-chat-reply': turn.id, text: shown || (active ? '正在等回复…' : '') });
    const error = !active && (reply?.error || (reply?.status === 'running' ? '上次生成中断' : ''));
    const assistant = el('div', { class: 'deeptalk-message assistant' },
      output,
      error && el('div', { class: 'deeptalk-reply-status' }, error),
      !active && el('div', { class: 'deeptalk-message-tools' },
        reply && el('span', { class: 'deeptalk-turn-tokens' }, tokens ? `本轮 ${formatTokenAmount(tokens)} Token` : '本轮用量未返回'),
        details && el('span', { class: 'deeptalk-receipt' }, details),
        turn.replies.length > 1 && button('上一版', () => void switchReply(turn, position - 1), { disabled: position <= 0 || busy() }),
        turn.replies.length > 1 && el('span', {}, `${position + 1}/${turn.replies.length}`),
        turn.replies.length > 1 && button('下一版', () => void switchReply(turn, position + 1), { disabled: position >= turn.replies.length - 1 || busy() }),
        last && !reply?.relayJob && button(reply?.status === 'done' ? '重写' : '重试', () => void run(turn.id), { disabled: busy() }),
        last && reply?.relayJob && button('接回回复', () => void run(turn.id, true), { disabled: busy() }),
        last && reply?.relayJob && button('停止后台', () => void endPending(turn), { disabled: busy() }),
        shown && button('⋯', () => void turnMenu(turn, reply), { 'aria-label': '回复操作' })));
    return el('article', { class: 'deeptalk-turn' }, user, assistant);
  }

  async function older() {
    earlier.disabled = true;
    try {
      const oldHeight = viewport.scrollHeight;
      const page = await readDeepTalkThread({ count: 30, before: start });
      turns = [...page.turns, ...turns]; start = page.start;
      renderConversation(); viewport.scrollTop += viewport.scrollHeight - oldHeight;
    } catch (error) { toast(error.message); }
    finally { earlier.disabled = false; }
  }

  function replaceTurn(turn) {
    const index = turns.findIndex(existing => existing.id === turn.id);
    if (index < 0) turns.push(turn); else turns[index] = turn;
  }

  async function switchReply(turn, index) {
    if (busy() || !turn.replies[index]) return;
    try { replaceTurn(await chooseDeepTalkReply(turn.id, turn.replies[index].id)); renderConversation(); }
    catch (error) { toast(error.message); }
  }

  async function endPending(turn) {
    try { const updated = await stopPendingDeepTalk(turn); if (updated) replaceTurn(updated); renderConversation(); }
    catch (error) { toast(error.message); }
  }

  async function turnMenu(turn, reply = null) {
    const action = await menu('消息操作', [
      { key: 'remember', label: '记住这条' },
      { key: 'exclude', label: turn.excludeContext ? '恢复未来上下文' : '从未来上下文排除' },
    ]);
    try {
      if (action === 'remember') { await rememberDeepTalkTurn(turn, reply); toast('已保存到聊天记忆'); }
      if (action === 'exclude') {
        const updated = await setTurnExcluded(turn.id, !turn.excludeContext);
        replaceTurn(updated); renderConversation(); toast(updated.excludeContext ? '此轮不再进入未来上下文' : '已恢复此轮上下文');
      }
    } catch (error) { toast(error.message); }
  }

  function openTokenUsage() {
    drawer?.close();
    const panel = sheet({ title: 'Token 用量', onClose: () => { drawer = null; refreshTokenUsage = null; } });
    panel.panel.classList.add('deeptalk-sheet');
    drawer = panel;
    const results = el('div', { 'aria-live': 'polite' }, el('p', { class: 'deeptalk-subtle' }, '正在读取用量…'));
    panel.body.append(results);
    panel.foot.append(button('关闭', panel.close));
    let newestRequest = 0;
    refreshTokenUsage = async () => {
      const request = ++newestRequest;
      try {
        const totals = await deepTalkTokenTotals();
        if (drawer !== panel || request !== newestRequest) return;
        const cards = [['今天', totals.today], ['本月', totals.month], ['累计', totals.all]].map(([label, entry]) =>
          el('div', { class: 'deeptalk-token-stat' },
            el('dt', {}, label),
            el('dd', { class: 'deeptalk-token-amount' }, entry.counted || !entry.missing ? formatTokenAmount(entry) : '—'),
            entry.missing > 0 && el('dd', { class: 'deeptalk-token-missing' }, `${tokenNumbers.format(entry.missing)} 次未返回用量`)));
        results.replaceChildren(el('dl', { class: 'deeptalk-token-grid', 'aria-label': '日常聊天 Token 用量' }, cards),
          el('p', { class: 'deeptalk-subtle' }, '统计日常聊天回复用量，包含输入和输出。重写与重试按次计入，以设备日期为准。'),
          ...(totals.all.estimated ? [el('p', { class: 'deeptalk-subtle' }, '带「约」的数字包含接口未回传时的估算。')] : []));
      } catch {
        if (drawer === panel && request === newestRequest) results.replaceChildren(el('p', { class: 'deeptalk-subtle' }, '暂时读不到用量，请关闭后重开。'));
      }
    };
    void refreshTokenUsage();
  }

  async function openPreview() {
    try {
      const previous = selectedReply(turns.at(-1));
      const preview = draft.value.trim() ? await deepTalkRequestPreview(draft.value, [...carry.keys()]) : previous;
      const panel = sheet({ title: draft.value.trim() ? '下一条会读取的资料' : '上一条使用的资料', onClose: () => { drawer = null; } });
      drawer = panel;
      const groups = [['常驻原文', preview?.always], ['当轮选读', preview?.used || preview?.refs]];
      for (const [label, parts] of groups) {
        panel.body.append(el('h3', {}, label), el('p', { class: 'deeptalk-quote' }, parts?.length ? parts.map(part => part.title).join('\n') : '无'));
      }
      panel.foot.append(button('关闭', panel.close));
    } catch (error) { toast(error.message); }
  }

  async function organize(automatic) {
    if (organizing || running || disposed) return;
    organizing = true; sync();
    try {
      const finished = await organizeDeepTalk({ automatic, onStart: () => { organizingVisible = true; sync(); } });
      if (finished) lastMessage = finished.added ? `已整理，${finished.added} 条记忆待确认` : '近期脉络已更新';
      else if (!automatic) lastMessage = '暂时没有可整理的稳定发言';
    } catch (error) { lastMessage = error.message || '整理失败，聊天原文已保留'; }
    finally { organizing = false; organizingVisible = false; sync(); notifyIdle(); }
  }

  async function run(turnId = '', resume = false) {
    if (running) { running.controller.abort('stop'); return; }
    if (changing) return;
    const text = draft.value.trim();
    if (!turnId && !text) return;
    if (!resume && turns.some(turn => selectedReply(turn)?.relayJob)) {
      toast('请先接回或停止上一条后台回复'); return;
    }
    if (!resume && !conn()) { toast('先选择日常聊天模型'); return; }
    const controller = new AbortController();
    running = { controller, message: '正在连接…', id: '', text: '' };
    lastMessage = ''; sync();
    let completed = false;
    try {
      const result = await generateDeepTalk({ text, turnId, resume, deeper: oneShot, manualKeys: [...carry.keys()], signal: controller.signal,
        onStart: turn => {
          replaceTurn(turn); running.id = turn.id; running.text = selectedReply(turn).text;
          if (!turnId) { draft.value = ''; draft.dispatchEvent(new Event('input')); }
          carry.clear(); oneShot = false;
          renderConversation({ follow: true }); sync();
        },
        onText: value => {
          const follow = atBottom();
          running.text = value; running.message = '正在回复…';
          const bubble = feed.querySelector(`[data-chat-reply="${running.id}"]`);
          if (bubble) bubble.textContent = value;
          if (follow) scrollBottom();
          sync();
        },
        onThinking: () => { if (!running.text) { running.message = '正在思考…'; sync(); } },
      });
      replaceTurn(result);
      completed = selectedReply(result)?.status === 'done';
    } catch (error) { lastMessage = error.message || '聊天暂时不可用'; }
    finally {
      running = null; sync(); renderConversation({ follow: atBottom() });
      void refreshTokenUsage?.();
      if (completed) void organize(true);
      notifyIdle();
    }
  }

  async function refresh() {
    try {
      const [newSettings, newConnections] = await Promise.all([deepTalkSettings(), deepTalkConnections()]);
      if (disposed) return;
      settings = newSettings; connections = newConnections; updateModels();
    } catch (error) { toast(error.message); }
  }

  updateModels(); renderConversation();
  const close = () => { disposed = true; drawer?.close(); };
  close.mounted = scrollBottom;
  close.show = refresh;
  close.busy = busy;
  close.background = () => drawer?.close();
  close.onIdle = callback => { idleListeners.add(callback); return () => idleListeners.delete(callback); };
  return close;
}
