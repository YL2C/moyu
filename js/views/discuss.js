// 墨游 · 讨论页：列表 + 单个讨论

import { db } from '../db.js';
import { el, toast, sheet, menu, promptText, autoGrow, ago, pickRawFile } from '../util.js';
import { go, getConnections, resolveConnection, connLabel, getGlobalMemo, setGlobalMemo, getPrefs } from '../state.js';
import { inlineText } from '../inline.js';
import { stripReasoning } from '../reasoning.js';
import { clearTask, getTask, resumeTask, startTask, stopTask, taskId, taskPending } from '../background.js';
import { fmtMoney } from '../cost.js';
import { openStoryEditor } from './story-edit.js';
import { readAttachment } from '../attachments.js';
import { attachmentCard } from './attachment-ui.js';
import {
  listDiscussions, getDiscussion, saveDiscussion, deleteDiscussion, newDiscussion,
  buildDiscussContext, chatMessages, changesPrompt, parseChanges, describeChange, applyChanges,
  loadStoryState, getUndo, undoLast, NEWSTORY_PROMPT, parseNewStory,
} from '../discuss.js';

export async function render(root, { id }) {
  if (id) return renderChat(root, id);
  return renderList(root);
}

// ───────────── 列表 ─────────────
async function renderList(root) {
  const [list, stories, memo] = await Promise.all([listDiscussions(), db.all('stories'), getGlobalMemo()]);
  const titleOf = new Map(stories.map((s) => [s.id, s.title || '未命名故事']));
  const wrap = el('div', { class: 'wrap' });

  const start = async () => {
    const items = [{ key: '', label: '🌐 全局', hint: '所有故事通用的写法、规则、偏好；也能聊出新故事' }];
    stories.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).forEach((s) => items.push({ key: s.id, label: '📖 ' + (s.title || '未命名故事'), hint: '读这个故事的设定、角色卡和前情档案' }));
    const k = await menu('讨论什么？', items);
    if (k === null) return;
    const d = newDiscussion(k, k ? titleOf.get(k) : '全局');
    await saveDiscussion(d);
    go('discuss/' + encodeURIComponent(d.id));
  };

  wrap.append(
    el('button', { class: 'btn primary block', style: { margin: '4px 0 12px' }, onclick: start }, '＋ 新讨论'),
    el('div', { class: 'card', style: { cursor: 'pointer' }, onclick: async () => {
      const v = await promptText({ title: '全局备忘', value: memo, hint: '所有故事每一轮都会带上这里的内容，越短越省钱。讨论里“整理成修改”选了“全局”的规则会追加到这里。', okText: '保存' });
      if (v === null) return;
      await setGlobalMemo(v.trim());
      toast('已保存');
      go('discuss');
    } },
      el('div', { style: { fontWeight: '600' } }, '🌐 全局备忘'),
      el('div', { class: 'hint', style: { marginTop: '4px' }, text: memo ? `${memo.length} 字 · 每个故事每轮都会带上 · 点开修改` : '空的。所有故事每一轮都会带上这里的内容。' })),
  );

  if (!list.length) wrap.append(el('div', { class: 'empty' }, '还没有讨论。', el('br'), '可以选一个故事，聊人设、纠正剧情，聊完一键写回。'));
  for (const x of list) {
    const scope = x.storyId ? (titleOf.get(x.storyId) || '（故事已删除）') : '全局';
    wrap.append(el('div', { class: 'card story-card', onclick: () => go('discuss/' + encodeURIComponent(x.id)) },
      el('div', { class: 't' }, el('span', { text: x.title || scope }),
        el('button', { class: 'icon-btn', 'aria-label': '更多', onclick: async (e) => {
          e.stopPropagation();
          const k = await menu(x.title || scope, [{ key: 'rename', label: '重命名' }, { key: 'del', label: '删除', danger: true }]);
          if (k === 'rename') {
            const d = await getDiscussion(x.id);
            const v = await promptText({ title: '重命名', value: d.title, multiline: false });
            if (v?.trim()) { d.title = v.trim(); await saveDiscussion(d); go('discuss'); }
          } else if (k === 'del') await removeDiscussion(x.id);
        } }, '⋯')),
      el('div', { class: 'm', text: (x.storyId ? '📖 ' : '🌐 ') + scope + ` · ${x.count || 0} 条` }),
      el('div', { class: 'd', text: ago(x.updatedAt) })));
  }

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' }, el('div', { class: 'title', style: { paddingLeft: '6px', minHeight: '36px', display: 'flex', alignItems: 'center' } }, '讨论')),
    el('div', { class: 'scroll' }, wrap)));
}

// ───────────── 单个讨论 ─────────────
async function canDeleteDiscussion(id) {
  const d = await getDiscussion(id);
  if (d?.messages.some(m => m.taskId) || (await Promise.all(['changes', 'story']
    .map(k => getTask('discussion.' + id + '.' + k)))).some(taskPending)) {
    toast('请先回到讨论，接回或停止生成。');
    return false;
  }
  return true;
}

async function removeDiscussion(id) {
  if (!await canDeleteDiscussion(id)) return;
  if (!confirm('删除这个讨论？已经写回的修改不受影响。')) return;
  await deleteDiscussion(id);
  await Promise.all(['changes', 'story'].map(k => clearTask('discussion.' + id + '.' + k)));
  go('discuss');
}

async function renderChat(root, id) {
  const d = await getDiscussion(id);
  if (!d) { toast('找不到这个讨论'); go('discuss'); return; }
  const storyTitle = d.storyId ? ((await db.get('stories', d.storyId))?.title || '（故事已删除）') : '全局';
  let conn = null;
  const pickConn = async () => {
    const list = await getConnections();
    conn = (d.connId && list.find((c) => c.id === d.connId)) || (d.storyId ? await resolveConnection(await db.get('stories', d.storyId)) : await resolveConnection(null));
  };
  await pickConn();
  const tasks = { changes: null, story: null };
  const keyFor = kind => 'discussion.' + d.id + '.' + kind;
  const replyKey = m => keyFor('reply.' + m.taskId);
  let replyBusy = false;
  let jobs = 0;
  const idleCbs = new Set();
  let destroyed = false;
  d.pendingAttachments = d.pendingAttachments || [];
  const pendingFiles = el('div', { class: 'pending-attachments' });
  const drawPending = () => pendingFiles.replaceChildren(...d.pendingAttachments.map(a => attachmentCard(a, {
    storyId: d.storyId, onChange: () => saveDiscussion(d).catch(e => toast('附件保存失败：' + e.message)),
    onRemove: async () => { d.pendingAttachments = d.pendingAttachments.filter(x => x.id !== a.id); await saveDiscussion(d); drawPending(); },
  })));
  const attachBtn = el('button', { class: 'chip', onclick: async () => {
    const file = await pickRawFile('.png,.json,.txt,.md'); if (!file) return;
    attachBtn.disabled = true;
    try {
      const attachment = await readAttachment(file);
      d.pendingAttachments.push(attachment);
      try { await saveDiscussion(d); } catch (e) { d.pendingAttachments.pop(); throw e; }
      drawPending(); toast('已在本机拆解，未调用API');
    } catch (e) { toast('附件读取失败：' + e.message, 5000); }
    finally { attachBtn.disabled = false; }
  } }, '📎 上传并拆卡');

  const titleEl = el('div', { class: 'title' });
  const chip = el('button', { class: 'model-chip', onclick: () => chooseConn() });
  const feed = el('div', { class: 'feed disc-feed' });
  const scroller = el('div', { class: 'scroll' }, feed);
  const ta = el('textarea', { rows: 1, placeholder: '自由输入…' });
  const sendBtn = el('button', { class: 'send', onclick: () => replyBusy ? stopReply() : onSend() }, '发送');
  const chipChanges = el('button', { class: 'chip', onclick: () => makeChanges() }, '✍️ 整理成修改');
  const chipNew = el('button', { class: 'chip', onclick: () => makeNewStory() }, '＋ 生成新故事');
  const chipCh = el('button', { class: 'chip', onclick: () => chooseChapters() });
  const draftStatus = el('div', { class: 'status-row' });
  const composer = el('div', { class: 'composer' }, draftStatus,
    pendingFiles,
    el('div', { class: 'bar' }, attachBtn, chipChanges, d.storyId ? chipCh : null, chipNew),
    el('div', { class: 'inrow' }, ta, sendBtn));
  autoGrow(ta);
  drawPending();
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); } });

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: () => go('discuss') }, '‹'),
      titleEl, chip,
      el('button', { class: 'icon-btn', 'aria-label': '更多', onclick: () => moreMenu() }, '⋯')),
    scroller, composer));

  async function header() {
    let chars = 0;
    try { chars = (await buildDiscussContext(d)).system.length; } catch {}
    titleEl.replaceChildren(d.title || storyTitle, el('div', { class: 'sub', text: `${d.storyId ? '📖 ' + storyTitle : '🌐 全局'} · 资料约 ${chars} 字` }));
    chip.textContent = conn ? connLabel(conn) : '未连接';
    chip.classList.toggle('warn', !conn);
    chipCh.textContent = d.chapters ? `带原文 ${d.chapters} 章` : '不带原文';
    chipCh.classList.toggle('on', !!d.chapters);
  }

  function bubble(m) {
    if (m.role === 'note') {
      return el('div', { class: 'disc-note' }, el('div', { text: m.content }),
        m.undo ? el('button', { class: 'btn small ghost', style: { marginTop: '6px' }, onclick: async () => {
          const u = await getUndo();
          if (!u || u.at !== m.undo) { toast('只能撤销最近一次写回'); return; }
          if (!confirm('撤销这次写回？设定、角色卡、前情档案和全局备忘会回到写回之前。')) return;
          await undoLast();
          m.content += '\n（已撤销）';
          delete m.undo;
          await saveDiscussion(d);
          draw();
          toast('已撤销');
        } }, '撤销这次写回') : null);
    }
    const body = el('div', { class: 'disc-text' }, inlineText((m.role==='assistant'?stripReasoning(m.content,{streaming:true}):m.content) || (m.streaming ? '…' : ''), getPrefs().emphasis !== false, getPrefs().dialogueColor !== false));
    const meta = [m.cost ? fmtMoney(m.cost) : '', m.error || ''].filter(Boolean).join(' · ');
    return el('div', { class: 'disc-msg ' + (m.role === 'user' ? 'me' : 'ai') + (m.error ? ' err' : '') }, body,
      ...(m.attachments || []).map(a => attachmentCard(a, { storyId: d.storyId, onChange: () => saveDiscussion(d).catch(e => toast(e.message)) })),
      meta ? el('div', { class: 'disc-meta', text: meta }) : null);
  }

  function draw(stick = true) {
    updateTasks();
    if (!d.messages.length) {
      feed.replaceChildren(el('div', { class: 'empty' },
        d.storyId ? `会带上「${storyTitle}」的设定、角色卡和前情档案。` : '会带上全局备忘、默认规则和规则模块库。',
        el('br'), '聊完点下面的“整理成修改”，确认后写回。'));
      return;
    }
    feed.replaceChildren(...d.messages.map(bubble));
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  function pendingReply() {
    return d.messages.findLast(m => m.role === 'assistant' && m.taskId);
  }

  function updateTasks() {
    sendBtn.textContent = replyBusy ? '停止' : '发送';
    sendBtn.classList.toggle('stop', replyBusy);
    const pending = pendingReply();
    sendBtn.disabled = !!pending && !replyBusy;
    draftStatus.replaceChildren();
    if (pending && !replyBusy) {
      draftStatus.append(el('div', { class: 'status' }, pending.error || '讨论回复待接回',
        el('button', { class: 'chip', onclick: () => collectReply(pending) }, '接回后台生成'),
        el('button', { class: 'chip', onclick: () => stopReply() }, '停止后台生成')));
    }
    for (const [kind, label, button] of [
      ['changes', '整理成修改', chipChanges], ['story', '生成新故事', chipNew],
    ]) {
      const task = tasks[kind];
      button.textContent = task?.state === 'done' ? (kind === 'changes' ? '查看待写回的修改' : '查看新故事草稿') : label;
      if (!taskPending(task) && task?.state !== 'error') continue;
      const key = keyFor(kind);
      draftStatus.append(el('div', { class: 'status' }, label + ' · ' + (task.error || (task.job ? '服务器生成中' : '生成中')),
        taskPending(task)
          ? el('button', { class: 'chip', onclick: () => resumeTask(key).then(t => setDraft(kind, t)).catch(report) }, '接回')
          : el('button', { class: 'chip', onclick: () => discardDraft(kind).catch(report) }, '关闭'),
        taskPending(task) ? el('button', { class: 'chip', onclick: () => stopTask(key).then(t => setDraft(kind, t)).catch(report) }, '停止') : null));
    }
  }

  const report = e => { if (!destroyed) toast(e?.message || String(e), 4000); };
  function setDraft(kind, task) {
    const prior = tasks[kind];
    tasks[kind] = task;
    if (!destroyed && (prior?.state !== task?.state || prior?.error !== task?.error || prior?.job !== task?.job)) updateTasks();
  }
  async function discardDraft(kind) {
    if (await clearTask(keyFor(kind))) setDraft(kind, null);
  }

  async function stopReply() {
    const m = pendingReply();
    if (!m) return;
    try { await collectReply(m, () => stopTask(replyKey(m))); }
    catch (e) { report(e); }
  }

  async function collectReply(a, action = () => resumeTask(replyKey(a))) {
    const wasBusy = replyBusy;
    replyBusy = true;
    if (!destroyed) updateTasks();
    try {
      const task = await action();
      if (!a.taskId) return;
      if (task && task.id !== a.taskId) return;
      if (task?.text) a.content = task.text;
      delete a.streaming;
      if (taskPending(task)) a.error = task.error || '后台生成待接回';
      else {
        a.error = task?.state === 'done' ? '' : (task?.error || '生成被中断');
        if (task?.cost) a.cost = task.cost;
        const storedKey = replyKey(a);
        delete a.taskId;
        try { await saveDiscussion(d); }
        catch (e) { a.taskId = task?.id || storedKey.split('.').at(-1); throw e; }
        await clearTask(storedKey);
      }
    } catch (e) { a.error = e?.message || String(e); report(e); }
    finally {
      if (!wasBusy) replyBusy = false;
      if (!destroyed) draw();
      if (!replyBusy && !jobs) idleCbs.forEach(f => f());
    }
  }

  async function onSend() {
    if (replyBusy || jobs || pendingReply()) return;
    jobs++;
    try { await onSendInner(); }
    catch (e) { report(e); }
    finally { jobs--; if (!jobs) idleCbs.forEach(f => f()); }
  }
  async function onSendInner() {
    const text = ta.value.trim() || (d.pendingAttachments.length ? '请根据我勾选的附件内容进行讨论。' : '');
    if (!text) return;
    if (!conn) { toast('先在设置里添加一个连接'); return; }
    const user = { role: 'user', content: text, attachments: d.pendingAttachments };
    if (chatMessages({ messages: [...d.messages, user] }).reduce((n,m) => n + m.content.length, 0) > 200000) {
      toast('讨论资料超过20万字，请少选附件内容或关闭旧附件携带', 5000); return;
    }
    const previous = d.pendingAttachments;
    d.messages.push(user); d.pendingAttachments = [];
    try { await saveDiscussion(d); } catch (e) { d.messages.pop(); d.pendingAttachments = previous; toast('保存失败，请重试', 4000); return; }
    ta.value = '';
    ta.dispatchEvent(new Event('input'));
    drawPending();
    if (d.messages.filter((m) => m.role === 'user').length === 1 && (!d.title || d.title === storyTitle)) d.title = text.slice(0, 18);
    const a = { role: 'assistant', content: '', streaming: true, taskId: taskId() };
    d.messages.push(a);
    try {
      await saveDiscussion(d);
      draw();
      const { system } = await buildDiscussContext(d);
      const messages = chatMessages({ messages: d.messages.slice(0, -1) });
      await collectReply(a, () => startTask(replyKey(a), {
        id: a.taskId, conn, system, messages, maxTokens: Number(conn.maxTokens) || 8000,
        kind: '讨论', storyId: d.storyId,
      }));
    } catch (e) {
      a.error = e?.message || String(e);
      delete a.streaming;
      delete a.taskId;
      await saveDiscussion(d).catch(() => {});
      draw();
      report(e);
    }
  }

  async function draftFor(kind) {
    const key = keyFor(kind);
    const saved = await getTask(key);
    if (saved?.state === 'done') return saved;
    if (taskPending(saved)) {
      await resumeTask(key).then(t => setDraft(kind, t));
      return await getTask(key);
    }
    if (!conn) { toast('先在设置里添加一个连接'); return null; }
    if (replyBusy || pendingReply()) { toast('等这条回复写完再整理'); return null; }
    if (!d.messages.some(m => m.role === 'assistant' && m.content?.trim())) { toast('先聊几句再整理'); return null; }
    const { system } = await buildDiscussContext(d);
    const messages = chatMessages(d);
    if (messages.at(-1)?.role === 'user') messages.push({ role: 'assistant', content: '（继续）' });
    messages.push({ role: 'user', content: kind === 'changes' ? changesPrompt(d) : NEWSTORY_PROMPT });
    const task = await startTask(key, {
      conn, system, messages, maxTokens: kind === 'changes' ? 4000 : 6000,
      kind: kind === 'changes' ? '整理修改' : '生成新故事', storyId: d.storyId,
    });
    setDraft(kind, task);
    return task;
  }

  async function makeChanges() {
    let task, changes, state;
    try {
      task = await draftFor('changes');
      if (destroyed || !root.isConnected || root.classList.contains('parked') || task?.state !== 'done') return;
      try { changes = parseChanges(task.text, !!d.storyId); }
      catch (e) { await discardDraft('changes'); throw e; }
      state = d.storyId ? await loadStoryState(d.storyId) : null;
    } catch (e) { report(e); return; }
    const s = sheet({ title: '整理成修改' });
    s.body.append(el('p', { class: 'hint', text: changes.length
      ? changes.length + ' 条修改，可以取消勾选或编辑文字。'
      : '讨论里没有找到可以写回的结论。' }));
    const discard = el('button', { class: 'btn ghost', onclick: async () => {
      await discardDraft('changes'); s.close();
    } }, '清除草稿');
    if (!changes.length) { s.foot.append(discard); return; }
    const list = el('div');
    const applyBtn = el('button', { class: 'btn primary' });
    const count = () => { const n = changes.filter((c) => c.on).length; applyBtn.textContent = n ? `写回 ${n} 条` : '写回'; applyBtn.disabled = !n; };
    for (const c of changes) {
      const lbl = el('span', { class: 'chg-lbl', text: describeChange(c, state) });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = true;
      cb.addEventListener('change', () => { c.on = cb.checked; item.classList.toggle('off', !c.on); count(); });
      const txt = el('textarea', { class: 'chg-text' });
      txt.value = c.text;
      txt.addEventListener('input', () => { c.text = txt.value; });
      let dest = null;
      if (c.target === 'rules' && d.storyId) {
        const b1 = el('button', { class: 'seg' }, '本故事规则');
        const b2 = el('button', { class: 'seg' }, '全局');
        const set = (v) => { c.dest = v; b1.classList.toggle('on', v === 'story'); b2.classList.toggle('on', v === 'global'); lbl.textContent = describeChange(c, state); };
        b1.onclick = () => set('story');
        b2.onclick = () => set('global');
        set(c.dest || 'story');
        dest = el('div', { class: 'segs' }, b1, b2);
      }
      const item = el('div', { class: 'card chg' },
        el('label', { class: 'chg-head' }, cb, lbl),
        dest,
        c.target === 'world' && c.op === 'replace' && c.old ? el('div', { class: 'chg-old', text: '原文：' + c.old }) : null,
        txt,
        c.why ? el('div', { class: 'hint', text: c.why }) : null);
      list.append(item);
      setTimeout(() => autoGrow(txt, 0.3), 0);
    }
    s.body.append(list);
    s.foot.replaceChildren(discard, el('button', { class: 'btn ghost', onclick: () => s.close() }, '关闭'), applyBtn);
    count();
    applyBtn.onclick = async () => {
      applyBtn.disabled = true;
      try {
        const { done, newStory } = await applyChanges(d, changes);
        const u = await getUndo();
        if (done.length) d.messages.push({ role: 'note', content: '已写回：\n' + done.map((x) => '· ' + x).join('\n'), undo: u?.at });
        await saveDiscussion(d);
        await discardDraft('changes');
        s.close();
        draw();
        header();
        toast('已写回');
        if (newStory) {
          const st = await openStoryEditor(null, newStory);
          if (st) go('play/' + encodeURIComponent(st.id));
        }
      } catch (e) { toast('写回失败：' + (e?.message || e), 4000); applyBtn.disabled = false; }
    };
  }

  async function makeNewStory() {
    try {
      const task = await draftFor('story');
      if (destroyed || !root.isConnected || root.classList.contains('parked') || task?.state !== 'done') return;
      let prefill;
      try { prefill = parseNewStory(task.text); }
      catch (e) { await discardDraft('story'); throw e; }
      const st = await openStoryEditor(null, prefill);
      if (st) { await discardDraft('story'); go('play/' + encodeURIComponent(st.id)); }
      else if (await menu('新故事草稿', [
        { key: 'keep', label: '保留，稍后继续编辑' },
        { key: 'discard', label: '清除草稿' },
      ]) === 'discard') await discardDraft('story');
    } catch (e) { report(e); }
  }

  async function chooseChapters() {
    const k = await menu('讨论时带上最近几章原文？', [
      { key: '0', label: '不带', hint: '只带设定、角色卡和前情档案，最省' },
      { key: '3', label: '最近 3 章' }, { key: '5', label: '最近 5 章' }, { key: '10', label: '最近 10 章', hint: '每条消息都会多发这些字，费用明显增加' },
    ]);
    if (k === null) return;
    d.chapters = Number(k);
    await saveDiscussion(d);
    header();
  }

  async function chooseConn() {
    const list = await getConnections();
    if (!list.length) { go('settings/new'); return; }
    const k = await menu('这个讨论用哪个连接', list.map((c) => ({ key: c.id, label: connLabel(c), hint: c.model })));
    if (k === null) return;
    d.connId = k;
    await saveDiscussion(d);
    await pickConn();
    header();
  }

  async function moreMenu() {
    const busy = !!pendingReply() || Object.values(tasks).some(taskPending);
    const k = await menu(d.title || storyTitle, [
      { key: 'ctx', label: '查看发给模型的资料' },
      d.storyId ? { key: 'go', label: '去这个故事' } : null,
      busy ? null : { key: 'pop', label: '删掉最后一轮' },
      { key: 'rename', label: '重命名' },
      busy ? null : { key: 'del', label: '删除这个讨论', danger: true },
    ]);
    if (k === 'ctx') {
      const { parts } = await buildDiscussContext(d);
      const s = sheet({ title: '每条消息都会带上的资料' });
      for (const p of parts) s.body.append(el('details', { class: 'card', style: { padding: '10px 12px' } }, el('summary', { style: { cursor: 'pointer', fontSize: '14px' }, text: `${p.label} · ${p.chars} 字` }), el('pre', { class: 'raw', text: p.text })));
      s.foot.remove();
    } else if (k === 'go') go('play/' + encodeURIComponent(d.storyId));
    else if (k === 'pop') {
      while (d.messages.length && d.messages[d.messages.length - 1].role !== 'user') d.messages.pop();
      const u = d.messages.pop();
      if (u) { ta.value = u.content; ta.dispatchEvent(new Event('input')); }
      await saveDiscussion(d);
      draw();
    } else if (k === 'rename') {
      const v = await promptText({ title: '重命名', value: d.title, multiline: false });
      if (v?.trim()) { d.title = v.trim(); await saveDiscussion(d); header(); }
    } else if (k === 'del') await removeDiscussion(d.id);
  }

  const refreshTasks = async () => {
    if (destroyed) return;
    const a = pendingReply();
    if (a && !replyBusy && !jobs) void collectReply(a, () => resumeTask(replyKey(a), { manual: false }));
    for (const kind of Object.keys(tasks)) {
      const saved = await getTask(keyFor(kind));
      if (destroyed) return;
      setDraft(kind, saved);
      if (taskPending(saved)) void resumeTask(keyFor(kind), { manual: false }).then(t => setDraft(kind, t)).catch(report);
    }
  };
  const onTask = ({detail: { key, task }}) => {
    const a = pendingReply();
    if (a && key === replyKey(a) && task.id === a.taskId && task.text) {
      const node = feed.lastChild?.querySelector('.disc-text');
      if (node) node.replaceChildren(inlineText(task.text, getPrefs().emphasis !== false, getPrefs().dialogueColor !== false));
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120) scroller.scrollTop = scroller.scrollHeight;
    }
    for (const kind of Object.keys(tasks)) if (key === keyFor(kind)) setDraft(kind, task);
  };
  const reconnect = () => { if (document.visibilityState !== 'hidden') void refreshTasks().catch(report); };
  for (const m of d.messages) if (m.streaming && !m.taskId) { delete m.streaming; m.error ||= '生成被中断了'; }
  window.addEventListener('moyu:background', onTask);
  window.addEventListener('online', reconnect);
  document.addEventListener('visibilitychange', reconnect);
  header();
  draw();
  reconnect();
  const destroy = () => {
    destroyed = true;
    window.removeEventListener('moyu:background', onTask);
    window.removeEventListener('online', reconnect);
    document.removeEventListener('visibilitychange', reconnect);
  };
  destroy.busy = () => jobs > 0 || replyBusy;
  destroy.onIdle = fn => { idleCbs.add(fn); return () => idleCbs.delete(fn); };
  destroy.show = () => { header(); draw(false); reconnect(); };
  return destroy;
}
