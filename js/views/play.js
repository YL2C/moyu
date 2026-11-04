// 墨游 · 游玩页

import { db, exportStory } from '../db.js';
import { el, uid, toast, menu, promptText, sheet, saveFile, autoGrow, insertAtCursor, approxTokens } from '../util.js';
import { resolveConnection, getConnections, connLabel, getPrefs, go } from '../state.js';
import { streamWithRetry, ApiError } from '../api.js';
import { buildContext, CONTINUE_MSG } from '../prompt.js';
import { parseReply, paragraphs } from '../parse.js';
import { openStoryEditor } from './story-edit.js';

export async function render(root, { id }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); go(''); return; }
  const nodes = new Map((await db.byStory(id)).map((n) => [n.id, n]));

  // 上次没写完就被打断的（切走应用、刷新页面），标成“中断”保留下来
  for (const n of nodes.values()) {
    if (n.status === 'streaming') {
      n.status = n.text?.trim() ? 'partial' : 'error';
      n.error = { kind: 'interrupted', message: '生成被中断了', hint: n.text?.trim() ? '可能是切走了应用或刷新了页面。已收到的部分保留着，可以点“续写”。' : '可能是切走了应用或刷新了页面，可以点“重试”。' };
      db.put('nodes', n).catch(() => {});
    }
  }

  const st = { streaming: null, director: '', ooc: false, conn: await resolveConnection(story), lastCtx: null, pendingFrame: 0 };
  const prefs = getPrefs();

  // ───── 树结构工具 ─────
  const pathTo = (nodeId) => {
    const out = [];
    let cur = nodeId ? nodes.get(nodeId) : null;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parentId ? nodes.get(cur.parentId) : null; }
    return out;
  };
  const headPath = () => pathTo(story.headId);
  const childrenOf = (id) => [...nodes.values()].filter((n) => n.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
  const siblingsOf = (n) => [...nodes.values()].filter((m) => m.parentId === n.parentId && m.role === n.role).sort((a, b) => a.createdAt - b.createdAt);
  const leafOf = (n) => { let cur = n; for (;;) { const ch = childrenOf(cur.id); if (!ch.length) return cur; cur = ch[ch.length - 1]; } };
  const chapterCount = (path) => path.filter((n) => n.role === 'assistant' && n.kind !== 'ooc' && n.text?.trim()).length;
  const saveStory = () => db.put('stories', story).catch(() => {});

  // ───── 页面骨架 ─────
  const titleEl = el('div', { class: 'title' });
  const chip = el('button', { class: 'model-chip', onclick: () => pickConnection() });
  const feed = el('div', { class: 'feed' });
  const scroller = el('div', { class: 'scroll' }, feed);
  const ta = el('textarea', { rows: '1', enterkeyhint: 'enter' });
  const sendBtn = el('button', { class: 'send', onclick: () => onSend() });
  const chipQuote = el('button', { class: 'chip', onclick: () => insertAtCursor(ta, '“', '”') }, '“ ”');
  const chipOoc = el('button', { class: 'chip', onclick: () => { st.ooc = !st.ooc; updateComposer(); ta.focus(); } }, '出戏');
  const chipDir = el('button', { class: 'chip', onclick: () => editDirector() }, '导演');
  const chipCont = el('button', { class: 'chip', onclick: () => send('continue', '') }, '继续');
  const composer = el('div', { class: 'composer' },
    el('div', { class: 'bar' }, chipQuote, chipOoc, chipDir, chipCont),
    el('div', { class: 'inrow' }, ta, sendBtn)
  );
  const fit = autoGrow(ta);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(); } });

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: () => go('') }, '‹'),
      titleEl, chip,
      el('button', { class: 'icon-btn', 'aria-label': '更多', onclick: () => storyMenu() }, '⋯')
    ),
    scroller, composer
  ));

  function updateHeader() {
    const n = chapterCount(headPath());
    titleEl.replaceChildren(story.title || '未命名故事', n ? el('div', { class: 'sub', text: `第 ${n} 章` }) : '');
    chip.textContent = st.conn ? connLabel(st.conn) : '未连接';
    chip.classList.toggle('warn', !st.conn);
  }

  function updateComposer() {
    const started = headPath().length > 0;
    const busy = !!st.streaming;
    sendBtn.textContent = busy ? '停止' : (started ? '发送' : '开始');
    sendBtn.classList.toggle('stop', busy);
    chipOoc.classList.toggle('on', st.ooc);
    chipDir.classList.toggle('on', !!st.director.trim());
    chipDir.textContent = st.director.trim() ? '导演 ✓' : '导演';
    ta.classList.toggle('ooc', st.ooc);
    ta.placeholder = !started
      ? '开场要求（可以不填）'
      : st.ooc ? '出戏：和 GM 场外说话，不推进剧情' : '台词放在“”里，动作和心里想的直接写';
    chipOoc.style.display = started ? '' : 'none';
    chipCont.style.display = started ? '' : 'none';
    chipCont.disabled = busy;
    chipCont.style.opacity = busy ? .45 : 1;
  }

  // ───── 渲染 ─────
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  const toBottom = () => { scroller.scrollTop = scroller.scrollHeight; };

  function renderUser(n) {
    if (n.kind === 'start') {
      return el('div', { class: 'turn' },
        el('div', { class: 'start-mark', text: '— 开 场 —' }),
        n.text?.trim() ? el('div', { class: 'you' }, el('span', { class: 'tag', text: '开场' }), n.text.trim()) : null);
    }
    const tag = n.kind === 'ooc' ? '出戏' : n.kind === 'continue' ? '继续' : '你';
    return el('div', { class: 'turn' },
      el('div', { class: 'you' + (n.kind === 'ooc' ? ' ooc' : '') },
        el('span', { class: 'tag', text: tag }),
        n.kind === 'continue' ? el('span', { class: 'muted', text: '让剧情往前走' }) : (n.text || ''),
        n.director?.trim() ? el('span', { class: 'dir', text: '导演：' + n.director.trim() }) : null
      ));
  }

  function errorBox(err) {
    if (!err) return null;
    const box = el('div', { class: 'err' }, el('div', { class: 'h', text: '⚠ ' + (err.message || '出错了') }));
    if (err.hint) box.append(el('div', { class: 'hint', text: err.hint }));
    if (err.detail || err.url) {
      const raw = [err.url ? '请求地址：' + err.url : '', err.detail || ''].filter(Boolean).join('\n');
      const pre = el('pre', { text: raw, style: { display: 'none' } });
      box.append(el('div', { class: 'row', style: { marginTop: '6px' } },
        el('button', { class: 'btn small ghost', onclick: () => { pre.style.display = pre.style.display === 'none' ? 'block' : 'none'; } }, '原始信息'),
        el('button', { class: 'btn small ghost', onclick: () => { navigator.clipboard?.writeText(`${err.message}\n${raw}`).then(() => toast('已复制'), () => toast('复制失败')); } }, '复制')
      ), pre);
    }
    return box;
  }

  function renderAssistant(n, { isLast, chapter }) {
    const live = st.streaming?.id === n.id;
    const wrap = el('div', { class: 'turn', 'data-id': n.id });
    if (n.kind === 'ooc') {
      const box = el('div', { class: 'gm ooc' });
      for (const p of paragraphs(n.text)) box.append(el('p', { text: p }));
      if (live && !n.text) box.append(el('div', { class: 'thinking', text: n.thinking ? '思考中' : '回复中' }));
      wrap.append(box);
    } else {
      const g = el('div', { class: 'gm' });
      const p = parseReply(n.text || '');
      if (n.text?.trim() || live) g.append(el('div', { class: 'chapter', text: `第 ${chapter} 章` }));
      if (p.title) g.append(el('h2', { text: p.title }));
      const paras = paragraphs(p.body);
      paras.forEach((t, i) => g.append(el('p', { text: t, class: live && i === paras.length - 1 ? 'cursor' : null })));
      if (live && !n.text) g.append(el('div', { class: 'thinking', text: n.thinking ? '模型思考中' : '正在构思' }));
      if (p.danmu.length) {
        const d = el('details', { class: 'danmu' }, el('summary', { text: `弹幕 · ${p.danmu.length}` }));
        if (prefs.danmuOpen) d.open = true;
        for (const m of p.danmu) d.append(el('div', { class: 'dm' }, m.name ? el('b', { text: m.name }) : null, m.text));
        g.append(d);
      }
      if (isLast && !live && p.options.length) {
        const box = el('div', { class: 'options' });
        p.options.forEach((o, i) => box.append(el('button', {
          onclick: () => { st.ooc = false; ta.value = o; fit(); updateComposer(); ta.focus(); },
        }, el('span', { class: 'k', text: 'ABCDEF'[i] }), o)));
        g.append(box);
      }
      wrap.append(g);
    }
    if (!live) {
      if (n.stopped && n.text?.trim()) wrap.append(el('div', { class: 'note', text: '已停止，这一轮没写完。' }));
      else if (n.status === 'partial' && !n.error) wrap.append(el('div', { class: 'note', text: '这一轮达到输出上限，没写完。可以点“续写”，或在连接设置里调大“输出上限”。' }));
      if (n.flagged) wrap.append(el('div', { class: 'note', text: '这一轮被接口中途截停了（内容审核）。' }));
      if (n.error && n.error.kind !== 'aborted') wrap.append(errorBox(n.error));
      if (isLast) wrap.append(toolsFor(n));
    }
    return wrap;
  }

  function toolsFor(n) {
    const tools = el('div', { class: 'tools' });
    const sibs = siblingsOf(n);
    if (sibs.length > 1) {
      const i = sibs.findIndex((s) => s.id === n.id);
      const prev = el('button', { 'aria-label': '上一个版本', onclick: () => switchVersion(sibs[i - 1]) }, '‹');
      const next = el('button', { 'aria-label': '下一个版本', onclick: () => switchVersion(sibs[i + 1]) }, '›');
      prev.disabled = i <= 0; next.disabled = i >= sibs.length - 1;
      tools.append(el('span', { class: 'ver' }, prev, `${i + 1}/${sibs.length}`, next));
    }
    const hasText = !!n.text?.trim();
    if (!hasText && n.status === 'error') {
      tools.append(el('button', { class: 'btn small primary', onclick: () => retry(n) }, '重试'));
    } else {
      tools.append(el('button', { class: 'btn small', onclick: () => regenerate(n) }, '重写这轮'));
      if (n.status === 'partial' || (n.error && hasText)) tools.append(el('button', { class: 'btn small primary', onclick: () => cont(n) }, '续写'));
    }
    if (n.model) tools.append(el('span', { class: 'meta', text: n.model }));
    return tools;
  }

  function renderFeed({ keepScroll = false } = {}) {
    const stick = !keepScroll || nearBottom();
    const path = headPath();
    feed.replaceChildren();
    if (!path.length) {
      feed.append(el('div', { class: 'empty' },
        el('div', { style: { fontSize: '17px', color: 'var(--text)', marginBottom: '8px' }, text: story.title || '未命名故事' }),
        story.world?.trim() ? '设定已就绪。' : '还没写设定，GM 会自由发挥。可以点右上角“⋯”补上。',
        el('br'), '在下面写开场要求（可以不写），然后点“开始”。'));
      if (story.opening?.trim() && !ta.value) { ta.value = story.opening; fit(); }
    }
    let chapter = 0;
    path.forEach((n, i) => {
      const isLast = i === path.length - 1;
      if (n.role === 'user') {
        feed.append(renderUser(n));
        if (isLast && !st.streaming) {
          feed.append(el('div', { class: 'tools' }, el('button', { class: 'btn small primary', onclick: () => generate(n) }, '生成回复')));
        }
      } else {
        if (n.kind !== 'ooc' && (n.text?.trim() || st.streaming?.id === n.id)) chapter++;
        feed.append(renderAssistant(n, { isLast, chapter: chapter || 1 }));
      }
    });
    updateHeader();
    updateComposer();
    if (stick) requestAnimationFrame(toBottom);
  }

  function updateLive(n) {
    if (st.pendingFrame) return;
    st.pendingFrame = requestAnimationFrame(() => {
      st.pendingFrame = 0;
      const old = feed.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
      if (!old) return;
      const stick = nearBottom();
      const chapter = chapterCount(headPath().filter((x) => x.id !== n.id)) + 1;
      old.replaceWith(renderAssistant(n, { isLast: true, chapter }));
      if (stick) toBottom();
    });
  }

  // ───── 动作 ─────
  async function onSend() {
    if (st.streaming) { stop(); return; }
    const started = headPath().length > 0;
    if (!started) { await send('start', ta.value); return; }
    const text = ta.value;
    if (!text.trim()) { toast(st.ooc ? '写点要说的话' : '写点什么，或者点“继续”'); return; }
    await send(st.ooc ? 'ooc' : 'play', text);
  }

  async function send(kind, text) {
    if (st.streaming) return;
    const head = story.headId ? nodes.get(story.headId) : null;
    const u = {
      id: uid(), storyId: story.id, parentId: head ? head.id : null, role: 'user', kind,
      text: String(text || '').trim(), director: st.director.trim(), createdAt: Date.now(),
    };
    nodes.set(u.id, u);
    try { await db.put('nodes', u); } catch { nodes.delete(u.id); return; }
    story.headId = u.id;
    await saveStory();
    ta.value = ''; fit();
    st.director = '';
    st.ooc = false;
    await generate(u);
  }

  async function generate(userNode, { reuse = null, continueNode = null } = {}) {
    if (st.streaming) return;
    st.conn = await resolveConnection(story);
    const conn = st.conn;
    let a;
    if (continueNode) a = continueNode;
    else if (reuse) { a = reuse; a.text = ''; }
    else a = { id: uid(), storyId: story.id, parentId: userNode.id, role: 'assistant', kind: userNode.kind === 'ooc' ? 'ooc' : 'play', text: '', createdAt: Date.now() };
    const base = continueNode ? (a.text || '') : '';
    a.status = 'streaming';
    a.error = null; a.stopped = false; a.flagged = false; a.thinking = false;
    a.model = conn?.model || a.model || '';
    nodes.set(a.id, a);
    story.headId = a.id;
    try { await db.put('nodes', a); } catch {}
    await saveStory();

    const ctx = buildContext(story, pathTo(a.parentId));
    if (continueNode && base.trim()) ctx.messages.push({ role: 'assistant', content: base }, { role: 'user', content: CONTINUE_MSG });
    st.lastCtx = ctx;
    if (ctx.info.trimmed) toast(`剧情太长，最早的 ${ctx.info.trimmed} 条没有发给模型`);

    const ctrl = new AbortController();
    st.streaming = { id: a.id, ctrl };
    renderFeed();

    let lastSave = 0;
    const persist = () => db.put('nodes', a).catch(() => {});
    const onHide = () => { if (document.visibilityState === 'hidden') persist(); };
    document.addEventListener('visibilitychange', onHide);
    try {
      const r = await streamWithRetry(conn, {
        system: ctx.system, messages: ctx.messages, signal: ctrl.signal,
        onText: (_d, full) => {
          a.text = base + full; a.thinking = false;
          updateLive(a);
          const now = Date.now();
          if (now - lastSave > 1500) { lastSave = now; persist(); }
        },
        onThinking: () => { if (!a.thinking && !a.text) { a.thinking = true; updateLive(a); } },
      }, { onRetry: (e) => toast(`${e.message}，自动重试中…`) });
      a.text = base + r.text;
      a.status = r.truncated ? 'partial' : 'done';
      a.finish = r.finish || null;
      a.usage = r.usage || null;
      a.flagged = !!r.flagged;
    } catch (e) {
      const err = e instanceof ApiError ? e.toJSON() : { kind: 'unknown', message: String(e?.message || e) };
      a.text = base + (e?.partial || '');
      const hasText = !!a.text.trim();
      if (err.kind === 'aborted') {
        a.stopped = hasText;
        a.status = hasText ? 'partial' : 'error';
        a.error = hasText ? null : { kind: 'stopped', message: '已停止', hint: '还没写出内容就停下了，可以点“重试”。' };
      } else {
        a.status = hasText ? 'partial' : 'error';
        a.error = err;
      }
    } finally {
      document.removeEventListener('visibilitychange', onHide);
      if (st.pendingFrame) { cancelAnimationFrame(st.pendingFrame); st.pendingFrame = 0; }
      a.thinking = false;
      st.streaming = null;
      await persist();
      if (a.kind !== 'ooc' && a.text?.trim()) {
        const p = parseReply(a.text);
        if (p.title) story.lastTitle = p.title;
      }
      story.chapters = chapterCount(headPath());
      story.updatedAt = Date.now();
      await saveStory();
      if (!destroyed) renderFeed({ keepScroll: true });
    }
  }

  function stop() { st.streaming?.ctrl.abort('user'); }

  async function regenerate(n) {
    const u = nodes.get(n.parentId);
    if (!u) return;
    await generate(u); // 新版本，旧版本保留，可左右切换
  }
  async function retry(n) {
    const u = nodes.get(n.parentId);
    if (u) await generate(u, { reuse: n });
  }
  async function cont(n) {
    const u = nodes.get(n.parentId);
    if (u) await generate(u, { continueNode: n });
  }
  async function switchVersion(target) {
    if (!target || st.streaming) return;
    story.headId = leafOf(target).id;
    await saveStory();
    renderFeed();
  }

  async function editDirector() {
    const v = await promptText({
      title: '导演指令', value: st.director,
      placeholder: '例：这一轮让他主动出手；节奏放慢一点；这轮写短些',
      hint: '只对下一轮生效，不会写进规则，也不会出现在正文里。',
      okText: '好',
    });
    if (v != null) { st.director = v; updateComposer(); }
  }

  async function pickConnection() {
    const conns = await getConnections();
    if (!conns.length) { go('settings/new'); return; }
    const items = conns.map((c) => ({ key: c.id, label: connLabel(c) + (story.connectionId === c.id ? '  ✓' : ''), hint: c.model }));
    items.push({ key: '__default', label: '跟随默认连接' + (!story.connectionId ? '  ✓' : '') });
    items.push({ key: '__manage', label: '管理连接…' });
    const k = await menu('这个故事用哪个连接', items);
    if (!k) return;
    if (k === '__manage') { go('settings'); return; }
    story.connectionId = k === '__default' ? null : k;
    await saveStory();
    st.conn = await resolveConnection(story);
    updateHeader();
    toast('之后的回复用「' + connLabel(st.conn) + '」');
  }

  async function storyMenu() {
    const k = await menu(story.title || '故事', [
      { key: 'edit', label: '编辑设定', hint: '世界、角色、规则、弹幕和选项开关' },
      { key: 'ctx', label: '查看发给模型的内容', hint: '排查“为什么他又不像他了”' },
      { key: 'export', label: '导出这个故事', hint: '不含密钥' },
    ]);
    if (k === 'edit') {
      const s = await openStoryEditor(story);
      if (s) { Object.assign(story, s); st.conn = await resolveConnection(story); renderFeed(); }
    } else if (k === 'ctx') showContext();
    else if (k === 'export') {
      const data = await exportStory(story.id);
      const d = new Date();
      await saveFile(`墨游_${story.title}_${d.getMonth() + 1}月${d.getDate()}日.json`, JSON.stringify(data, null, 1));
    }
  }

  function showContext() {
    const ctx = st.lastCtx || buildContext(story, headPath());
    const s = sheet({ title: st.lastCtx ? '上一轮发给模型的内容' : '下一轮会发给模型的内容' });
    const i = ctx.info;
    s.body.append(
      el('div', { class: 'hint', style: { marginTop: 0 } },
        `共约 ${i.totalChars.toLocaleString()} 字（粗估约 ${approxTokens(i.totalChars).toLocaleString()} token）：规则与设定 ${i.systemChars.toLocaleString()} 字，剧情 ${i.historyChars.toLocaleString()} 字，${i.count} 条消息。` +
        (i.trimmed ? ` 最早的 ${i.trimmed} 条因为太长没有发送。` : '') + ' 较早轮次的弹幕和选项已去掉，只留正文。'),
      el('div', { class: 'section-title', text: '系统提示' }),
      el('pre', { class: 'raw', text: ctx.system }),
      el('div', { class: 'section-title', text: '对话' }),
      el('pre', { class: 'raw', style: { maxHeight: '50vh' }, text: ctx.messages.map((m) => `【${m.role === 'user' ? '玩家' : 'GM'}】\n${m.content}`).join('\n\n') })
    );
    s.foot.append(el('button', {
      class: 'btn', onclick: () => navigator.clipboard?.writeText(`${ctx.system}\n\n${ctx.messages.map((m) => `【${m.role}】\n${m.content}`).join('\n\n')}`).then(() => toast('已复制'), () => toast('复制失败')),
    }, '复制全部'), el('button', { class: 'btn primary', onclick: () => s.close() }, '关闭'));
  }

  let destroyed = false;
  renderFeed();
  requestAnimationFrame(fit);
  return () => { destroyed = true; if (st.streaming) st.streaming.ctrl.abort('leave'); };
}
