import { el, sheet, toast, menu, autoGrow } from '../util.js';
import { connLabel, getCurrentStory, go } from '../state.js';
import { supportsReasoningEffort } from '../api.js';
import { fmtMoney, fmtTokens } from '../cost.js';
import { deepTalkSettings, deepTalkConnections, selectedReply, readDeepTalkThread, saveDeepTalkSettings, generateDeepTalk,
  chooseDeepTalkReply, rememberDeepTalkTurn, setTurnExcluded, stopPendingDeepTalk, deepTalkRequestPreview,
  deepTalkReplyTokens, deepTalkUsageSplit, getDeepTalkSpend, EFFORT_LABELS, MAX_USER_CHARS } from '../deeptalk.js';
import { organizeDeepTalk } from '../deeptalk-memory.js';
import { openDeepTalkLibrary } from './deeptalk-library.js';

const button = (label, click, attrs = {}) => el('button', { type: 'button', class: 'btn small', onclick: click, ...attrs }, label);
const tokenNumbers = new Intl.NumberFormat('zh-CN');
const formatTokenAmount = ({ total, estimated }) => `${estimated ? '约 ' : ''}${tokenNumbers.format(total)}`;
const spendPeriods = [['today', '今天'], ['month', '本月'], ['all', '累计']];
const spendTimestamp = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const usageSplit = (input, output, estimated) => `${estimated ? '约 ' : ''}入 ${fmtTokens(input)} · 出 ${fmtTokens(output)}`;
const spendAmount = costs => Object.entries(costs).map(([currency, amount]) => fmtMoney({ currency, amount })).join(' + ');

function spendDetails({ total, byKind, averageInput, requests, recent }) {
  const amount = spendAmount(total.costs);
  const headline = amount ? `约 ${amount}` : total.splitCount ? '没设计价方式，算不出金额' : total.count ? '暂无可计价用量' : '暂无花费记录';
  const notes = [
    `共 ${total.count} 次调用${total.splitCount ? ` · ${total.splitEstimated ? '约 ' : ''}输入 ${fmtTokens(total.input)} · 输出 ${fmtTokens(total.output)} token` : ''}`,
    averageInput != null ? `聊天回复平均每轮 ${byKind['聊天回复'].splitEstimated ? '约 ' : ''}${fmtTokens(averageInput)} 输入 token` : '',
    total.cacheCount ? `缓存命中 ${fmtTokens(total.cached)}${total.written ? ` · 写入 ${fmtTokens(total.written)}` : ''}${total.cacheCount < total.count ? `（${total.cacheCount} 次有缓存用量）` : ''}`
      : total.count ? '接口未回传缓存用量' : '',
    total.count > total.counted ? `${total.count - total.counted} 次未回传用量` : '',
    total.counted > total.splitCount ? `${total.counted - total.splitCount} 次仅有用量合计` : '',
    amount && total.priced < total.count ? `金额合计自 ${total.priced} 次有价格记录的调用` : '',
  ].filter(Boolean);
  const groups = Object.entries(byKind).filter(([, entry]) => entry.count).map(([kind, entry]) => {
    const money = spendAmount(entry.costs);
    const usage = entry.splitCount ? usageSplit(entry.input, entry.output, entry.splitEstimated)
      : entry.counted ? `${formatTokenAmount(entry)} Token` : '用量未回传';
    return el('div', { class: 'deeptalk-spend-row' }, el('span', {}, `${kind} × ${entry.count}`),
      el('span', { class: 'deeptalk-spend-value' }, [usage, money && `约 ${money}`].filter(Boolean).join(' · ')));
  });
  const requestRows = requests.map(row => el('div', { class: 'hint', text: [
    spendTimestamp.format(row.at), row.kind, row.model, `${row.posts} 次请求`,
    row.cachePosts ? `含 ${row.cachePosts} 次缓存请求` : '', row.relayPosts ? '经转发' : '',
    row.status ? `HTTP ${row.status}` : ({ ok: '完成', ratelimit: '限流', aborted: '已停止', timeout: '超时' }[row.outcome] || '失败'),
  ].filter(Boolean).join(' · ') }));
  const usageRows = recent.map(row => {
    const usage = row.usage;
    const tokens = deepTalkReplyTokens(row);
    const split = deepTalkUsageSplit(usage);
    return el('div', { class: 'deeptalk-spend-call' },
      el('div', {}, [spendTimestamp.format(row.at), row.kind, row.model].filter(Boolean).join(' · ')),
      el('div', { class: 'hint' }, [
        tokens && `${formatTokenAmount(tokens)} Token`,
        split && usageSplit(split.input, split.output, split.est),
        (usage?.cacheReported || usage?.cached > 0 || usage?.written > 0) && `命中 ${fmtTokens(usage.cached)}`,
        usage?.written > 0 && `写入 ${fmtTokens(usage.written)}`,
        row.cost && `约 ${fmtMoney({ ...row.cost, est: false })}`,
      ].filter(Boolean).join(' · ')));
  });
  return [
    el('div', { class: 'card' }, el('div', { class: 'deeptalk-spend-amount' }, headline),
      ...notes.map(text => el('div', { class: 'hint', text }))),
    groups.length && el('div', { class: 'card' }, groups),
    requestRows.length && el('div', { class: 'section-title' }, '最近操作的请求次数'),
    requestRows.length && el('div', { class: 'card deeptalk-spend-requests' }, requestRows),
    usageRows.length && el('div', { class: 'section-title' }, '最近的调用'),
    usageRows.length && el('div', { class: 'card' }, usageRows),
    el('p', { class: 'hint' }, '今天、本月以设备日期为准。金额按调用时的连接价格估算，实际扣费以服务商账单为准。'),
  ].filter(Boolean);
}

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
  let refreshSpend = null;
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
      onClose: () => { drawer = null; void refresh(); },
    });
  }

  root.append(el('section', { class: 'view deeptalk-view' },
    el('div', { class: 'topbar' }, el('div', { class: 'title' }, '日常聊天'),
      button('花费', openSpend, { 'aria-haspopup': 'dialog' }), button('资料与记忆', showLibrary)),
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

  function openSpend() {
    drawer?.close();
    const panel = sheet({ title: '花费', onClose: () => { drawer = null; refreshSpend = null; } });
    panel.panel.classList.add('deeptalk-sheet', 'deeptalk-spend');
    panel.panel.setAttribute('aria-label', '日常聊天花费');
    drawer = panel;
    let period = 'all';
    let spend = null;
    const periodButtons = spendPeriods.map(([key, label]) => button(label, () => { period = key; update(); }, { 'aria-pressed': String(key === period) }));
    const periods = el('div', { class: 'deeptalk-spend-periods', role: 'group', 'aria-label': '统计时段', hidden: true }, periodButtons);
    const results = el('div', { 'aria-live': 'polite' }, el('p', { class: 'hint' }, '正在读取用量…'));
    panel.body.append(el('div', { class: 'section-title', text: '这个聊天' }), periods, results);
    panel.foot.append(button('去设价格 / 提醒线', () => { panel.close(); go('settings'); }, { class: 'btn ghost' }),
      button('关闭', panel.close, { class: 'btn primary' }));
    function update() {
      spendPeriods.forEach(([key, label], i) => {
        const entry = spend[key].total;
        const tokens = entry.counted || !entry.count ? `${formatTokenAmount(entry)} Token` : '—';
        periodButtons[i].setAttribute('aria-pressed', String(period === key));
        periodButtons[i].setAttribute('aria-label', `${label} ${tokens}`);
        periodButtons[i].replaceChildren(el('span', {}, label), el('strong', {}, tokens));
      });
      periods.hidden = false;
      results.replaceChildren(...spendDetails(spend[period]));
    }
    let newestRequest = 0;
    refreshSpend = async () => {
      const request = ++newestRequest;
      try {
        const next = await getDeepTalkSpend();
        if (drawer !== panel || request !== newestRequest) return;
        spend = next;
        update();
      } catch {
        if (drawer === panel && request === newestRequest) results.replaceChildren(el('p', { class: 'hint' }, '暂时读不到用量，请关闭后重开。'));
      }
    };
    void refreshSpend();
  }

  async function openPreview() {
    try {
      const previous = selectedReply(turns.at(-1));
      const preview = draft.value.trim() ? await deepTalkRequestPreview(draft.value, [...carry.keys()]) : previous;
      const panel = sheet({ title: draft.value.trim() ? '下一条会读取的资料' : '上一条使用的资料', onClose: () => { drawer = null; } });
      drawer = panel;
      const used = preview?.used || preview?.refs || [];
      const groups = [['常驻原文', preview?.always], ['当轮选读', used.filter(part => part.topic !== 'automatic')]];
      if (!draft.value.trim()) {
        groups.push(['专题联想', used.filter(part => part.topic === 'automatic' && !part.story)]);
        if (settings.autoStoryRecall || used.some(part => part.story)) groups.push(['跑团联想', used.filter(part => part.story)]);
      }
      for (const [label, parts] of groups) {
        panel.body.append(el('h3', {}, label), el('p', { class: 'deeptalk-quote' }, parts?.length ? parts.map(part => part.title).join('\n') : '无'));
      }
      if (draft.value.trim() && (settings.autoTopics || settings.autoStoryRecall))
        panel.body.append(el('p', { class: 'deeptalk-subtle' }, '联想资料在发送时挑选，回复后可在这里查看出处。'));
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
    finally {
      if (organizingVisible) void refreshSpend?.();
      organizing = false; organizingVisible = false; sync(); notifyIdle();
    }
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
        onSearching: () => { running.message = '正在查找相关资料…'; sync(); },
        onStart: turn => {
          replaceTurn(turn); running.id = turn.id; running.text = selectedReply(turn).text;
          running.message = '正在连接…';
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
      if (!result) return;
      replaceTurn(result);
      completed = selectedReply(result)?.status === 'done';
    } catch (error) { lastMessage = error.message || '聊天暂时不可用'; }
    finally {
      running = null; sync(); renderConversation({ follow: atBottom() });
      void refreshSpend?.();
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
