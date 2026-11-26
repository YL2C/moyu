// 墨游 · 游玩页

import { db, exportStory } from '../db.js';
import { el, uid, toast, menu, promptText, sheet, saveFile, autoGrow, insertAtCursor, approxTokens } from '../util.js';
import { resolveConnection, resolveMemoryConnection, canUseMemoryConnection, MEMORY_CONNECTION_HINT, getConnections, connLabel, getPrefs, go, getModules, setCurrentStory, getGlobalMemo, watchStory, usesPatentTheme } from '../state.js';
import { streamWithRetry, ApiError, holdStoryJob, releaseStoryJob } from '../api.js';
import { cancelRelayJob } from '../relay.js';
import { buildContext, CONTINUE_MSG, rewriteMsg, directorBlock, splitNames, latestCheckpoint } from '../prompt.js';
import { runStoryRecall } from '../story-recall.js';
import { pendingChapters, runArchivist, archivingNow } from '../memory.js';
import { DEFAULT_EVERY } from './memory.js';
import { getPacks } from '../tavern.js';
import { parseReply, paragraphs, optionsForReply, replyForContext } from '../parse.js';
import { recoverableOutput, stripReasoning } from '../reasoning.js';
import { CHOICE_LABELS, expandOptionInput, choiceInput, toggleChoice } from '../personal.js';
import { inlineText } from '../inline.js';
import { openExportDialog } from '../exporter.js';
import { documentLines, documentStatus } from './document-reader.js';
import { playModeSwitch } from './deeptalk.js';
import { normalizeUsage, computeCost, fmtMoney, fmtTokens, recordUsage, getMonthSpend, getBudget, hasPrice, priceMode, CUR, getUsageLog, getRequestLog } from '../cost.js';

export async function render(root, { id }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); setCurrentStory(null); go(''); return; }
  const nodes = new Map((await db.byStory(id)).map((n) => [n.id, n]));

  // 上次没写完就被打断的（切走应用、刷新页面），标成“中断”保留下来
  for (const n of nodes.values()) {
    if (n.status === 'streaming' && !n.relayJob) {
      n.status = n.text?.trim() ? 'partial' : 'error';
      n.error = { kind: 'interrupted', message: '生成被中断了', hint: n.text?.trim() ? '可能是切走了应用或刷新了页面。已收到的部分保留着，可以点“续写”。' : '可能是切走了应用或刷新了页面，可以点“重试”。' };
      db.put('nodes', n).catch(() => {});
    }
  }

  const st = {
    streaming: null, director: '', ooc: false, conn: await resolveConnection(story), lastCtx: null, pendingFrame: 0,
    pick: null,      // 正在“选一段往后重写”的回复 id
    undoHead: null,  // 回退前的位置，用来撤销
    modules: await getModules(),
    packs: await getPacks(),
    globalMemo: await getGlobalMemo(),
    archiving: null,   // 后台整理前情 { ctrl, text }
    archiveError: null,
    archiveNeedsConnection: false,
    choiceSource: null,
  };
  story.manualOn = story.manualOn || {};
  const manualMods = () => [...st.modules, ...(story.localModules || [])].filter((m) => m.mode === 'manual' && story.modules?.[m.id]);
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
  const isOoc = (n) => n.kind === 'ooc';
  const siblingsOf = (n) => [...nodes.values()]
    .filter((m) => m.parentId === n.parentId && m.role === n.role && isOoc(m) === isOoc(n))
    .sort((a, b) => a.createdAt - b.createdAt);
  const leafOf = (n) => {
    let cur = n;
    for (;;) {
      const ch = childrenOf(cur.id);
      if (!ch.length) return cur;
      cur = ch.reduce((a, b) => ((b.updatedAt || b.createdAt) > (a.updatedAt || a.createdAt) ? b : a));
    }
  };
  const isPlayReply = (n) => n.role === 'assistant' && !isOoc(n) && !!n.text?.trim();
  const playAnchor = () => headPath().findLast(n => !isOoc(n));
  const oocPath = (path = headPath()) => path.slice(path.findLastIndex(n => !isOoc(n)) + 1);
  const branchDirector = () => story.oocHandoff && story.oocHandoff.anchorId === playAnchor()?.id ? story.oocHandoff.text : '';
  const currentDirector = () => st.director || branchDirector();
  const optionsFor = (n, parsed) => optionsForReply(n, parsed).slice(0, CHOICE_LABELS.length);
  const chapterCount = (path) => path.filter(isPlayReply).length;
  const saveStory = () => db.put('stories', story).catch(() => {});
  const touch = (n) => { n.updatedAt = Date.now(); };

  // ───── 页面骨架 ─────
  const titleEl = el('div', { class: 'title' });
  const chip = el('button', { class: 'model-chip', onclick: () => pickConnection() });
  const feed = el('div', { class: 'feed' });
  const scroller = el('div', { class: 'scroll' }, feed);
  const documentFooter = documentStatus('章节进度');
  const lineNumbers = documentLines(feed);
  const chapterIndex = el('button', { class: 'btn small', 'aria-haspopup': 'dialog', onclick: () => chooseChapter() }, '章节');
  const documentTools = el('div', { class: 'document-toolbar', hidden: true },
    chapterIndex,
    el('button', { class: 'btn small', 'aria-haspopup': 'dialog', onclick: () => openAnnotations() }, '批注'),
    el('button', { class: 'btn small', onclick: () => go(`memory/${encodeURIComponent(story.id)}`) }, '前情档案'));
  const ta = el('textarea', { rows: '1', enterkeyhint: 'enter', placeholder: '自由输入…' });
  const sendBtn = el('button', { class: 'send', onclick: () => onSend() });
  const chipQuote = el('button', { class: 'bracket-btn', 'aria-label': '插入动作或心理括号', onmousedown: (e) => e.preventDefault(), onclick: () => insertAtCursor(ta, '（', '）') }, '（ ）');
  const chipDanmu = el('button', { class: 'chip', role: 'switch', 'aria-label': '弹幕', onclick: async () => {
    const before = story.danmu;
    chipDanmu.disabled = true;
    story.danmu = story.danmu === false;
    try {
      await db.put('stories', story);
      renderFeed({ keepScroll: true });
      toast(story.danmu ? '已打开弹幕' : '已关闭弹幕，之后生成也不写弹幕');
    } catch { story.danmu = before; }
    finally { chipDanmu.disabled = false; updateComposer(); }
  } });
  const chipCont = el('button', { class: 'chip continue-chip', onclick: () => send('continue', '') }, '继续');
  const chipStyle = el('button', { class: 'chip', 'aria-haspopup': 'dialog', onclick: () => openStylePresets().catch(e => toast(e.message)) });
  const oocId = 'ooc-' + uid();
  const chipOoc = el('button', { class: 'chip', role: 'switch', 'aria-label': '出戏', 'aria-controls': oocId, onclick: () => setOoc(!st.ooc) }, '出戏');
  const statusRow = el('div', { class: 'status-row' });
  const oocFeed = el('div', { class: 'ooc-feed' });
  const oocInput = el('textarea', { rows: '1', enterkeyhint: 'enter', placeholder: '场外讨论…', 'aria-label': '场外讨论输入' });
  const oocSend = el('button', { class: 'send', onclick: () => onSend('ooc') });
  const carryBtn = el('button', { class: 'chip', onclick: () => carryConclusion() }, '带结论回正文');
  const oocPanel = el('section', { class: 'ooc-panel', id: oocId, hidden: true, 'aria-label': '场外讨论' },
    el('div', { class: 'ooc-head' }, el('strong', {}, '场外讨论'), carryBtn),
    oocFeed, el('div', { class: 'inrow' }, oocInput, oocSend));
  const playInputRow = el('div', { class: 'inrow' }, el('div', { class: 'input-shell' }, ta, chipQuote), sendBtn);
  const composerTitle = el('button', { class: 'document-composer-title', hidden: true,
    'aria-expanded': 'true', onclick: () => setComposerCollapsed(!composer.classList.contains('document-collapsed')) },
    el('span', {}, '续写'), el('span', { 'aria-hidden': 'true', class: 'document-fold' }));
  const pickedChoices = el('div', { class: 'document-picks', hidden: true });
  const composerTools = el('div', { class: 'bar' }, chipDanmu, chipStyle, chipOoc, el('span', { class: 'spacer' }), chipCont);
  const composer = el('div', { class: 'composer' },
    composerTitle, statusRow, pickedChoices, composerTools,
    playInputRow, oocPanel
  );
  const fit = autoGrow(ta);
  const fitOoc = autoGrow(oocInput, .14);
  const syncChoices = () => {
    const selected = choiceInput(ta.value).labels;
    const current = [...feed.querySelectorAll('.options button[data-choice]')];
    current.forEach((button) => {
      const on = selected.includes(button.dataset.choice);
      button.classList.toggle('selected', on); button.setAttribute('aria-pressed', String(on));
    });
    if (!usesPatentTheme()) return;
    const labels = selected.filter(label => current.some(button => button.dataset.choice === label));
    pickedChoices.textContent = labels.length ? '已选 ' + labels.map(label => {
      const option = current.find(button => button.dataset.choice === label);
      return label + ' · ' + option.lastChild.textContent;
    }).join('　/　') : '';
  };
  ta.addEventListener('input', syncChoices);
  for (const [input, kind] of [[ta, 'play'], [oocInput, 'ooc']]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSend(kind); } });
  }

  root.append(el('div', { class: 'view document-play' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: () => go('') }, '‹'),
      titleEl, chip,
      el('button', { class: 'icon-btn', 'aria-label': '更多', onclick: () => storyMenu() }, '⋯')
    ),
    playModeSwitch('story', story.id), documentTools, scroller, composer, documentFooter.bar
  ));
  scroller.addEventListener('scroll', syncDocumentPosition, { passive: true });

  function syncDocumentPosition() {
    if (!usesPatentTheme()) return;
    const chapters = [...feed.querySelectorAll('[data-document-chapter]')];
    const threshold = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
    const current = nearBottom(scroller) ? chapters.at(-1) :
      chapters.findLast(chapter => chapter.getBoundingClientRect().top <= threshold) || chapters[0];
    documentFooter.position.textContent = current ? `第 ${current.dataset.documentChapter} / ${chapters.length} 章` : '尚未开篇';
  }

  function setComposerCollapsed(collapsed) {
    composer.classList.toggle('document-collapsed', collapsed);
    composerTitle.setAttribute('aria-expanded', String(!collapsed));
  }

  async function chooseChapter() {
    const chapters = headPath().filter(isPlayReply);
    const target = await menu('章节', chapters.map((node, index) => ({
      key: node.id, label: `第 ${index + 1} 章`, hint: parseReply(node.text).title || '',
    })), { anchor: chapterIndex });
    if (target) feed.querySelector(`[data-id="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'start' });
  }

  async function openAnnotations() {
    const clicked = await menu('批注', [
      { key: 'danmu', label: chipDanmu.textContent },
      { key: 'style', label: chipStyle.textContent },
      !chipOoc.hidden && !chipOoc.disabled ? { key: 'ooc', label: st.ooc ? '回到正文' : '场外讨论' } : null,
      { key: 'director', label: '导演指令' },
    ]);
    if (clicked === 'danmu') chipDanmu.click();
    if (clicked === 'style') chipStyle.click();
    if (clicked === 'ooc') chipOoc.click();
    if (clicked === 'director') editDirector();
  }

  function updateHeader() {
    const n = chapterCount(headPath());
    titleEl.replaceChildren(story.title || '未命名故事', n ? el('div', { class: 'sub', text: `第 ${n} 章` }) : '');
    chapterIndex.disabled = !n;
    chip.textContent = st.conn ? connLabel(st.conn) : '未连接';
    chip.classList.toggle('warn', !st.conn);
  }

  function updateComposer() {
    chipDanmu.textContent = story.danmu !== false ? '弹幕：开' : '弹幕：关';
    chipDanmu.setAttribute('aria-checked', String(story.danmu !== false));
    const styleOn = styleModules().some(m => story.modules?.[m.id]);
    chipStyle.textContent = `文风预设：${styleOn ? '开' : '关'}`;
    const started = headPath().length > 0;
    const busy = !!st.streaming;
    composerTitle.disabled = busy || st.ooc;
    if (composerTitle.disabled) setComposerCollapsed(false);
    pickedChoices.classList.toggle('out-of-scene', st.ooc);
    chipOoc.setAttribute('aria-checked', String(st.ooc));
    chipOoc.classList.toggle('on', st.ooc);
    chipOoc.hidden = !started;
    chipOoc.disabled = busy;
    oocPanel.hidden = !st.ooc;
    playInputRow.hidden = st.ooc;
    carryBtn.disabled = busy || oocPath().some(n => n.relayJob);
    oocSend.textContent = busy ? '停止' : '发送';
    oocSend.classList.toggle('stop', busy);
    oocSend.setAttribute('aria-label', busy ? '停止场外回复' : '发送场外消息');
    sendBtn.textContent = busy ? '停止' : (started ? '发送' : '开始');
    sendBtn.classList.toggle('stop', busy);
    statusRow.replaceChildren(...[
      !st.ooc && currentDirector().trim() ? el('div', { class: 'status' },
        el('span', { class: 'lbl', onclick: () => editDirector(), text: '下一轮导演：' + currentDirector().trim() }),
        el('button', { 'aria-label': '清除导演指令', onclick: () => saveDirector('') }, '✕')) : null,
      (() => {
        const a = st.archiving || archivingNow(story.id);
        st.extShown = !st.archiving && !!a;
        if (!a) return null;
        return el('div', { class: 'status ooc' },
          el('span', { class: 'lbl', onclick: () => go(`memory/${encodeURIComponent(story.id)}`), text: a.text + '（后台进行，可以继续玩）' }),
          el('button', { 'aria-label': '停止整理', onclick: () => a.ctrl?.abort('user') }, '✕'));
      })(),
      st.archiveNeedsConnection ? el('div', { class: 'status' },
        el('span', { class: 'lbl', onclick: () => go('settings/connections'), text: '前情待整理 · 点这里设置记忆整理 API' }),
        el('button', { 'aria-label': '关掉整理提醒', onclick: () => { st.archiveNeedsConnection = false; updateComposer(); } }, '✕')) : null,
      st.archiveError ? el('div', { class: 'status' },
        el('span', { class: 'lbl', onclick: () => autoArchive(true), text: '整理前情失败：' + st.archiveError + '（点这里重试）' }),
        el('button', { 'aria-label': '关掉', onclick: () => { st.archiveError = null; updateComposer(); } }, '✕')) : null,
      ...manualMods().filter((m) => story.manualOn[m.id]).map((m) => el('div', { class: 'status' },
        el('span', { class: 'lbl', text: `情境：${m.name}（每轮都会带上，直到关掉）` }),
        el('button', { 'aria-label': '关掉情境', onclick: () => { story.manualOn[m.id] = false; saveStory(); updateComposer(); } }, '✕'))),
    ].filter(Boolean));
    composerTools.classList.toggle('document-no-continue', !started || st.ooc);
    chipCont.style.display = started && !st.ooc ? '' : 'none';
    chipCont.disabled = busy;
    chipCont.style.opacity = busy ? .45 : 1;
  }

  function setOoc(on) {
    if (st.streaming || st.sending || jobs || st.ooc === on) return;
    const stick = nearBottom(scroller);
    st.ooc = on;
    updateComposer();
    if (on) { fitOoc(); renderOocFeed({ stick: true }); }
    else fit();
    if (stick) toBottom(scroller);
  }

  async function saveDirector(value, persist = false) {
    if (persist || branchDirector()) {
      const old = story.oocHandoff;
      if (value.trim()) story.oocHandoff = { anchorId: playAnchor()?.id, text: value.trim() };
      else delete story.oocHandoff;
      try { await db.put('stories', story); }
      catch { story.oocHandoff = old; return false; }
      st.director = '';
    } else st.director = value;
    updateComposer();
    return true;
  }

  async function carryConclusion() {
    if (!st.ooc || st.streaming || jobs) return;
    const anchorId = playAnchor()?.id;
    const discussion = oocPath().findLast(n => n.role === 'assistant');
    const value = await promptText({
      title: '带结论回正文',
      value: [currentDirector(), stripReasoning(discussion?.text || '')].filter(Boolean).join('\n\n'),
      hint: '只保留你确认的结论。回正文后，点继续、选择选项或发送时生效。',
      okText: '确认并回正文',
    });
    if (value == null || !st.ooc || anchorId !== playAnchor()?.id) return;
    if (!value.trim()) { toast('请填写要带回正文的结论'); return; }
    if (await saveDirector(value, true)) setOoc(false);
  }

  function stylePacks() {
    return [...st.packs, ...(story.packs || [])].filter(p => p.kind === 'preset');
  }

  function styleModules() {
    const packs = new Set(stylePacks().map(p => p.id));
    return [...st.modules, ...(story.localModules || [])].filter(m => packs.has(m.pack));
  }

  function styleSnapshot(ids) {
    const sent = styleModules().filter(m => ids.includes(m.id));
    const packs = stylePacks().filter(p => p.id === story.stylePreset || sent.some(m => m.pack === p.id));
    return { name: packs.map(p => p.name).join('、'), names: sent.map(m => m.name) };
  }

  async function openStylePresets() {
    [st.packs, st.modules] = await Promise.all([getPacks(), getModules()]);
    updateComposer();
    const all = styleModules();
    const packs = stylePacks().filter(p => all.some(m => m.pack === p.id));
    const active = packs.filter(p => all.some(m => m.pack === p.id && story.modules?.[m.id]));
    const keep = '__keep_story_styles';
    const select = el('select', { 'aria-label': '主文风' },
      el('option', { value: '' }, '关闭文风预设'),
      active.length > 1 ? el('option', { value: keep }, '沿用故事中的多套文风') : null,
      ...packs.map(p => el('option', { value: p.id }, p.name)));
    select.value = active.length > 1 ? keep : (active[0]?.id || '');
    const lastSent = headPath().findLast(n => isPlayReply(n) && (n.status === 'done' || n.status === 'partial' || !n.status))?.styleSent;
    const s = sheet({ title: '文风预设' });
    const receipt = lastSent?.name ? `${lastSent.name} · ${lastSent.names?.length || 0} 项` : '未发送文风';
    s.body.append(el('div', { class: 'field style-select' }, select),
      packs.length ? el('div', { class: 'hint style-receipt', title: receipt }, lastSent ? `上一轮实发 · ${receipt}` : '暂无上一轮发送记录')
        : el('div', { class: 'hint' }, '可以在设置或故事规则中导入文风预设。'));
    const save = el('button', { class: 'btn primary', onclick: async () => {
      const selected = select.value;
      if (selected === keep) { s.close(); return; }
      save.disabled = true;
      try {
        const current = await db.get('stories', story.id);
        if (!current) throw new Error('故事已不存在');
        const enabled = { ...current.modules };
        const remembered = { ...current.styleSelections };
        for (const p of packs) {
          const checked = all.filter(m => m.pack === p.id && enabled[m.id]).map(m => m.id);
          if (checked.length) remembered[p.id] = checked;
        }
        for (const m of all) {
          enabled[m.id] = m.pack === selected && (!remembered[selected]?.length || remembered[selected].includes(m.id));
        }
        const patch = { stylePreset: selected, styleSelections: remembered, modules: enabled };
        await db.put('stories', { ...current, ...patch });
        Object.assign(story, patch);
        updateComposer();
        s.close();
        toast('文风预设已保存，下一轮正文生效');
      } catch (e) { toast(e.message); save.disabled = false; }
    } }, '保存');
    s.foot.append(el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'), save);
  }

  async function editOption(n, index, text) {
    const label = CHOICE_LABELS[index];
    const value = await promptText({
      title: '修改选项 ' + label, value: text, okText: '保存',
      hint: '下次选择这个选项时会使用修改后的文字。',
    });
    if (value == null) return;
    if (!value.trim()) { toast('选项不能为空'); return; }
    if (st.streaming || nodes.get(n.id) !== n || playAnchor()?.id !== n.id) {
      toast('章节已变化，请重新打开选项'); return;
    }
    const current = await db.get('nodes', n.id);
    if (!current || current.text !== n.text) { toast('章节已变化，请重新打开选项'); return; }
    const next = { ...current, optionEdits: { ...current.optionEdits, [label]: value.trim() } };
    await db.put('nodes', next);
    nodes.set(n.id, next);
    renderFeed({ keepScroll: true });
  }

  // ───── 渲染 ─────
  const nearBottom = (pane) => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 96;
  const toBottom = (pane) => { pane.scrollTop = pane.scrollHeight; };

  function versionCtl(n) {
    const sibs = siblingsOf(n);
    if (sibs.length < 2) return null;
    const i = sibs.findIndex((s) => s.id === n.id);
    const prev = el('button', { 'aria-label': '上一个版本', onclick: (e) => { e.stopPropagation(); switchVersion(sibs[i - 1]); } }, '‹');
    const next = el('button', { 'aria-label': '下一个版本', onclick: (e) => { e.stopPropagation(); switchVersion(sibs[i + 1]); } }, '›');
    prev.disabled = i <= 0 || !!st.streaming;
    next.disabled = i >= sibs.length - 1 || !!st.streaming;
    return el('span', { class: 'ver' }, prev, `${i + 1}/${sibs.length}`, next);
  }

  function moreBtn(onclick) {
    return el('button', { class: 'more', 'aria-label': '这一轮的操作', onclick: (e) => { e.stopPropagation(); if (!st.streaming) onclick(); } }, '⋯');
  }

  function renderUser(n, { isLast }) {
    if (n.kind === 'start') {
      return el('div', { class: 'turn', 'data-id': n.id },
        el('div', { class: 'start-mark', text: '— 开 场 —' }),
        n.text?.trim() ? el('div', { class: 'you' }, el('span', { class: 'tag', text: '开场' }), n.text.trim(), moreBtn(() => userMenu(n))) : null);
    }
    const tag = n.kind === 'ooc' ? '出戏' : n.kind === 'continue' ? '继续' : '你';
    return el('div', { class: 'turn', 'data-id': n.id },
      el('div', { class: 'you' + (n.kind === 'ooc' ? ' ooc' : '') },
        el('span', { class: 'tag', text: tag }),
        n.kind === 'continue' ? el('span', { class: 'muted', text: '让剧情往前走' }) : (n.text || ''),
        n.director?.trim() ? el('span', { class: 'dir', text: '导演：' + n.director.trim() }) : null,
        n.kind === 'continue' ? null : moreBtn(() => userMenu(n)),
      ),
      siblingsOf(n).length > 1 ? el('div', { class: 'tools', style: { justifyContent: 'flex-end', marginTop: '2px' } }, versionCtl(n)) : null,
      isLast && !st.streaming ? el('div', { class: 'tools' }, el('button', { class: 'btn small primary', onclick: () => generate(n) }, '生成回复')) : null
    );
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
    const picking = st.pick === n.id;
    const wrap = el('div', { class: 'turn', 'data-id': n.id });
    if (n.kind === 'ooc') {
      const box = el('div', { class: 'gm ooc' });
      for (const p of paragraphs(n.text)) box.append(el('p', {}, inlineText(p, getPrefs().emphasis !== false, getPrefs().dialogueColor !== false)));
      if (live && !n.text) box.append(el('div', { class: 'thinking', text: n.thinking ? '思考中' : '回复中' }));
      if (!live && n.text?.trim()) box.append(el('div', { class: 'row end' }, versionCtl(n), moreBtn(() => replyMenu(n, { isLast }))));
      wrap.append(box);
    } else {
      const g = el('div', { class: 'gm' + (picking ? ' picking' : '') });
      const p = parseReply(n.text || '');
      if (n.text?.trim() || live) {
        wrap.dataset.documentChapter = chapter;
        g.append(el('div', { class: 'chapter-row' },
          el('div', { class: 'chapter', text: `第 ${chapter} 章${n.edited ? ' · 已修改' : ''}` }),
          el('span', { class: 'document-chapter-number', hidden: true, 'aria-hidden': 'true', text: chapter }),
          live ? null : versionCtl(n),
          live || !n.text?.trim() ? null : moreBtn(() => replyMenu(n, { isLast }))
        ));
      }
      if (picking) {
        g.append(el('div', { class: 'pick-bar' },
          el('span', { text: '点一下要从哪一段开始重写（这一段和后面的都会重写）' }),
          el('button', { class: 'btn small ghost', onclick: () => { st.pick = null; renderFeed({ keepScroll: true }); } }, '取消')));
      }
      if (p.title) g.append(el('h2', { text: p.title }));
      const paras = paragraphs(p.body);
      paras.forEach((t, i) => g.append(el('p', {
        class: [live && i === paras.length - 1 ? 'cursor' : '', picking ? 'pick' : ''].filter(Boolean).join(' ') || null,
        onclick: picking ? () => rewriteFrom(n, i) : null,
      }, inlineText(t, getPrefs().emphasis !== false, getPrefs().dialogueColor !== false))));
      if (live && !n.text) g.append(el('div', { class: 'thinking', text: n.thinking ? '模型思考中' : '正在构思' }));
      if (story.danmu !== false && p.danmu.length && !picking) {
        const label = usesPatentTheme() ? '批注' : '弹幕';
        const d = el('details', { class: 'danmu' }, el('summary', { text: `${label} · ${p.danmu.length}` }));
        if (prefs.danmuOpen) d.open = true;
        for (const m of p.danmu) d.append(el('div', { class: 'dm' }, m.name ? el('b', { text: m.name + ':' }) : null, m.text));
        g.append(d);
      }
      if (isLast && !live && !picking && story.options !== false && p.options.length) {
        const box = el('div', { class: 'options' });
        optionsFor(n, p).forEach((text, i) => {
          const label = CHOICE_LABELS[i];
          const selected = choiceInput(ta.value).labels.includes(label);
          box.append(el('div', { class: 'option-row' },
            el('button', {
              'data-choice': label, 'aria-pressed': String(selected), class: selected ? 'selected' : '',
              onclick: () => {
                const documentMode = usesPatentTheme();
                const stick = documentMode && nearBottom(scroller);
                if (documentMode) setComposerCollapsed(false);
                st.choiceSource = n.id;
                ta.value = toggleChoice(ta.value, label);
                fit();
                syncChoices();
                if (stick) toBottom(scroller);
              },
            }, el('span', { class: 'k', text: label }), text),
            el('button', {
              class: 'option-edit', 'aria-label': '修改选项 ' + label,
              onclick: () => editOption(n, i, text).catch(e => toast(e.message)),
            }, '✎')));
        });
        g.append(box);
      }
      // 模型没写选项（或格式认不出）：一键补四个，只发这一章，花费很小
      if (isLast && !live && !picking && !p.options.length && story.options !== false && n.kind !== 'ooc' && n.text?.trim() && n.status !== 'partial') {
        g.append(el('div', { class: 'no-opts' },
          st.addingOpts === n.id
            ? el('span', { class: 'thinking', text: '正在补选项' })
            : el('button', { class: 'btn small ghost', onclick: () => addOptions(n) }, '这一章没写选项 · 补四个')));
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

  async function addOptions(n) {
    if (st.streaming || st.addingOpts) return;
    const conn = await resolveConnection(story);
    if (!conn) { toast('先在设置里添加连接'); return; }
    st.addingOpts = n.id;
    renderFeed({ keepScroll: true });
    const p = parseReply(n.text);
    const system = '你在主持一场文字互动小说，玩家扮演“你”。' + (story.world?.trim() ? '\n【世界与角色设定（节选）】\n' + story.world.trim().slice(0, 2000) : '');
    const user = '下面是刚写完的一章：\n\n' + (p.title ? '# ' + p.title + '\n' : '') + p.body +
      '\n\n请只为这一章的结尾写 4 个参考选项，格式：\n【选项】\nA. ……\nB. ……\nC. ……\nD. ……\n' +
      '要求：四个方向明显不同的具体行动（可以带一个马上会发生的事件），写行动不写结果，不泄露隐藏信息。只输出这五行。';
    try {
      const r = await streamWithRetry(conn, { system, messages: [{ role: 'user', content: user }], maxTokens: 3000 },
        { queueStory: 'play', requestKind: '补选项', storyId: story.id });
      const u = normalizeUsage(r.usage, { inChars: system.length + user.length, outChars: r.text.length });
      recordUsage({ kind: '补选项', storyId: story.id, model: conn.model, usage: u, cost: computeCost(u, conn) });
      let opts = parseReply(r.text).options;
      if (!opts.length) opts = r.text.split('\n').map((l) => l.trim()).filter((l) => l && !/选\s*项/.test(l)).slice(0, CHOICE_LABELS.length);
      if (!opts.length) { toast('没补上，可以再试一次'); return; }
      n.text = n.text.trimEnd() + '\n\n【选项】\n' + opts.slice(0, CHOICE_LABELS.length).map((o, i) => `${CHOICE_LABELS[i]}. ${o}`).join('\n');
      await db.put('nodes', n).catch(() => {});
    } catch (e) {
      if (e?.kind !== 'aborted') toast('补选项失败：' + (e?.message || e), 3500);
    } finally {
      st.addingOpts = null;
      if (!destroyed) renderFeed({ keepScroll: true });
    }
  }

  function toolsFor(n) {
    const tools = el('div', { class: 'tools' });
    if (n.relayJob) {
      tools.append(el('button', { class: 'btn small primary', onclick: () => resumePending() }, '接回后台生成'),
        el('button', { class: 'btn small', onclick: async () => {
          if (st.streaming) { stop(); return; }
          if (jobs || st.sending) return;
          try {
            await cancelRelayJob(n.relayJob, n.relayContext?.server);
            releaseStoryJob(n.relayJob);
            delete n.relayJob; delete n.relayContext;
            n.stopped = !!n.text?.trim(); n.status = n.stopped ? 'partial' : 'error';
            n.error = n.stopped ? null : { kind: 'stopped', message: '已停止', hint: '可以点“重试”。' };
            await db.put('nodes', n); renderFeed({ keepScroll: true });
          } catch (e) { toast(e.message, 4000); }
        } }, '停止后台生成'));
      return tools;
    }
    const hasText = !!n.text?.trim();
    const recoverable = recoverableOutput(n.error);
    if (recoverable) tools.append(el('button', { class: 'btn small primary', onclick: () => recoverReply(n, recoverable) }, '接回本次回复'));
    if (!hasText && n.status === 'error') {
      const wait = retryWait(n.retryAfter);
      const button = el('button', { class: 'btn small' + (recoverable ? '' : ' primary'), onclick: () => retry(n) }, wait ? `重试（${wait} 秒）` : '重试');
      button.disabled = wait > 0;
      if (wait && !retryTimer) retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!destroyed && !st.streaming) renderFeed({ keepScroll: true });
      }, Math.min(1000, n.retryAfter - Date.now() + 10));
      tools.append(button);
    } else {
      tools.append(el('button', { class: 'btn small', onclick: () => regenerate(n) }, '重写这轮'));
      if (n.status === 'partial' || (n.error && hasText)) tools.append(el('button', { class: 'btn small primary', onclick: () => cont(n) }, '续写'));
    }
    const metaText = [n.model, n.cost ? fmtMoney(n.cost) : (n.usageN ? fmtTokens(n.usageN.input + n.usageN.output) + ' token' : '')].filter(Boolean).join(' · ');
    if (metaText) {
      tools.append(el('button', {
        class: 'meta', style: { border: 0, background: 'transparent', cursor: 'pointer', padding: '4px 0' },
        onclick: () => {
          const u = n.usageN;
          if (!u) return;
          toast(`${u.est ? '粗估' : ''}输入 ${fmtTokens(u.input)}${u.cached ? `（缓存命中 ${fmtTokens(u.cached)}）` : ''} · 输出 ${fmtTokens(u.output)}${n.cost ? ' · ' + fmtMoney(n.cost) : ''}`, 4000);
        },
      }, metaText));
    }
    return tools;
  }

  async function recoverReply(n, value) {
    const available = () => !destroyed && !jobs && !st.streaming && !st.sending && story.headId === n.id && !n.relayJob;
    if (!available()) return;
    const error = n.error;
    const draft = await promptText({
      title: '接回本次回复', value, focus: false, okText: '保存为本章',
      hint: '核对并删去任何写作说明。保存后，这段文字会加入当前章节。',
    });
    if (draft == null || !available() || n.error !== error) return;
    const accepted = stripReasoning(draft).trim();
    if (!accepted) { toast('请保留要接回的正文'); return; }
    const text = [n.text?.trimEnd(), accepted].filter(Boolean).join('\n\n');
    const next = { ...n, text, status: /^(length|max_tokens)$/i.test(error.finish || '') ? 'partial' : 'done',
      error: null, finish: error.finish || null, stopped: false, updatedAt: Date.now() };
    jobs++;
    try {
      await db.put('nodes', next);
      Object.assign(n, next);
      const { title } = parseReply(text);
      if (title) story.lastTitle = title;
      story.chapters = chapterCount(headPath());
      story.updatedAt = Date.now();
      await saveStory();
      if (!destroyed) toast('本次回复已接回');
    } catch { toast('没能保存，可以再点一次接回'); }
    finally {
      jobs--;
      if (!destroyed) renderFeed({ keepScroll: true });
      if (!jobs) idleCbs.forEach((fn) => { try { fn(); } catch {} });
    }
  }

  function renderFeed({ keepScroll = false, focusId = null } = {}) {
    if (st.choiceSource && st.choiceSource !== playAnchor()?.id) {
      ta.value = choiceInput(ta.value).extra; st.choiceSource = null; fit();
    }
    const stick = !focusId && (!keepScroll || nearBottom(scroller));
    const path = headPath().filter(n => !isOoc(n));
    lineNumbers.disconnect();
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
      if (n.role === 'user') feed.append(renderUser(n, { isLast }));
      else {
        if (n.kind !== 'ooc' && (n.text?.trim() || st.streaming?.id === n.id)) chapter++;
        feed.append(renderAssistant(n, { isLast, chapter: chapter || 1 }));
        if (n.checkpoint) {
          feed.append(el('button', { class: 'cp-mark', onclick: () => go(`memory/${encodeURIComponent(story.id)}`) },
            `— 前情已整理到这里（第 ${chapter} 章）· 记忆 —`));
        }
      }
    });
    if (st.undoHead && !st.streaming) {
      const later = chapterCount(pathTo(leafOf(nodes.get(st.undoHead) || { id: '' })?.id)) - chapterCount(path);
      feed.append(el('div', { class: 'card notice', style: { fontFamily: 'var(--ui-font)', fontSize: '14px', marginTop: '10px' } },
        `已回到第 ${chapterCount(path)} 章。` + (later > 0 ? `原来后面的 ${later} 章保留在“⋯ → 分支”里。` : '') + '接着写就会开出一条新分支。',
        el('div', { class: 'row', style: { marginTop: '8px' } },
          el('button', { class: 'btn small', onclick: undoBack }, '撤销，回到原来的位置'))));
    }
    updateHeader();
    updateComposer();
    syncChoices();
    lineNumbers.observe();
    syncDocumentPosition();
    if (st.ooc) renderOocFeed({ focusId });
    if (focusId) {
      requestAnimationFrame(() => feed.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'start' }));
    } else if (stick) requestAnimationFrame(() => toBottom(scroller));
  }

  function renderOocFeed({ stick = nearBottom(oocFeed), focusId = null } = {}) {
    const path = oocPath();
    oocFeed.replaceChildren(...path.map((n, i) => {
      const opts = { isLast: i === path.length - 1 };
      return n.role === 'user' ? renderUser(n, opts) : renderAssistant(n, opts);
    }));
    oocFeed.hidden = !path.length;
    if (focusId) {
      oocFeed.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (stick) toBottom(oocFeed);
  }

  function updateLive(n) {
    if (st.pendingFrame) return;
    st.pendingFrame = requestAnimationFrame(() => {
      st.pendingFrame = 0;
      const pane = isOoc(n) ? oocFeed : feed;
      const scroll = isOoc(n) ? oocFeed : scroller;
      const old = pane.querySelector(`[data-id="${CSS.escape(n.id)}"]`);
      if (!old) return;
      const stick = nearBottom(scroll);
      const chapter = chapterCount(headPath().filter((x) => x.id !== n.id)) + 1;
      const updated = renderAssistant(n, { isLast: true, chapter });
      if (!isOoc(n)) lineNumbers.unobserve(old);
      old.replaceWith(updated);
      if (!isOoc(n)) lineNumbers.observe(updated);
      if (stick) toBottom(scroll);
    });
  }

  // ───── 发送与生成 ─────
  async function onSend(kind = 'play') {
    const ooc = kind === 'ooc';
    if (ooc !== st.ooc) return;
    if (st.streaming) { stop(); return; }
    if (ooc) {
      if (!oocInput.value.trim()) { toast('写点要说的话'); return; }
      await send('ooc', oocInput.value);
      return;
    }
    const started = headPath().length > 0;
    if (!started) { await send('start', ta.value); return; }
    const head = playAnchor();
    const options = story.options !== false && head?.role === 'assistant' ? optionsFor(head) : [];
    const text = expandOptionInput(ta.value, options);
    if (!text.trim()) { toast('写点什么，或者点“继续”'); return; }
    await send('play', text);
  }

  async function send(kind, text, { parentId, director } = {}) {
    if (st.streaming || jobs || st.sending) return;
    if (headPath().some((n) => n.relayJob)) { toast('先接回后台生成，或在章节下方停止它'); return; }
    st.sending = true;
    const head = story.headId ? nodes.get(story.headId) : null;
    const u = {
      id: uid(), storyId: story.id, parentId: parentId !== undefined ? parentId : (head ? head.id : null), role: 'user', kind,
      text: String(text || '').trim(), director: kind === 'ooc' ? '' : (director ?? currentDirector()).trim(), createdAt: Date.now(),
    };
    touch(u);
    nodes.set(u.id, u);
    try { await db.put('nodes', u); } catch { nodes.delete(u.id); st.sending = false; return; }
    if (kind !== 'ooc' && parentId === undefined && branchDirector()) delete story.oocHandoff;
    story.headId = u.id;
    st.undoHead = null;
    await saveStory();
    if (parentId === undefined) {
      if (kind === 'ooc') { oocInput.value = ''; fitOoc(); }
      else { ta.value = ''; fit(); st.director = ''; }
    }
    try { await generate(u); } finally { st.sending = false; }
  }

  /**
   * 生成一条回复。
   * reuse：重试时复用失败的那条；continueNode：续写（已有的接着写）或“从某段重写”（新建的带前文）
   * extraDirector：这次额外的要求；rewriteNote：从某段重写时的要求
   */
  // 正在进行的生成数：切到别的页面时，有生成在跑就把这一页留在后台接着写
  let jobs = 0;
  let reconnectRequested = false;
  // 后台任务断线后的自动接回：次数有上限，接上并有新内容就清零
  let relayRetry = 0;
  let relayTimer = null;
  let retryTimer = null;
  const retryWait = (until) => Math.max(0, Math.ceil(((until || 0) - Date.now()) / 1000));
  const scheduleResume = () => {
    clearTimeout(relayTimer);
    if (destroyed || relayRetry >= 40) return;
    const wait = Math.min(10000, 1500 * 2 ** Math.min(relayRetry, 3));
    relayRetry++;
    relayTimer = setTimeout(() => { if (!destroyed && document.visibilityState === 'visible') void resumePending(false); }, wait);
  };
  const idleCbs = new Set();
  async function generate(...args) {
    if (jobs) return;
    jobs++;
    try { return await generateInner(...args); }
    finally {
      jobs--;
      if (reconnectRequested && !destroyed) { reconnectRequested = false; void resumePending(false); }
      if (!jobs) idleCbs.forEach((f) => { try { f(); } catch {} });
    }
  }
  async function generateInner(userNode, { reuse = null, continueNode = null, extraDirector = '', rewriteNote = null, resumeJob = null } = {}) {
    if (st.streaming) return;
    st.conn = await resolveConnection(story);
    const saved = resumeJob && reuse?.relayContext;
    const original = saved ? (await getConnections()).find((c) => c.id === saved.connectionId) : st.conn;
    const conn = saved ? { ...original, ...saved.connection } : st.conn;
    let a;
    if (continueNode) a = continueNode;
    else if (reuse) { a = reuse; if (!resumeJob) a.text = ''; }
    else a = { id: uid(), storyId: story.id, parentId: userNode.id, role: 'assistant', kind: userNode.kind === 'ooc' ? 'ooc' : 'play', text: '', createdAt: Date.now() };
    const base = stripReasoning(saved ? saved.base || '' : continueNode ? (a.text || '') : '',{streaming:true});
    const previousText = stripReasoning(a.text,{streaming:true});
    const continuation = saved ? saved.continuation : !!continueNode;
    const outputBoundary=saved?!!saved.outputBoundary:a.kind!=='ooc';
    const usageKind = saved?.usageKind || (a.kind === 'ooc' ? '出戏' : continueNode ? '续写' : '正文');
    a.status = 'streaming';
    a.error = null; a.stopped = false; a.flagged = false; a.thinking = false;
    delete a.retryAfter;
    a.model = conn?.model || a.model || '';
    touch(a);
    nodes.set(a.id, a);
    story.headId = a.id;
    st.pick = null;
    try { await db.put('nodes', a); } catch {}
    await saveStory();

    const ctxPath = pathTo(a.parentId);
    const ctx = buildContext(story, ctxPath, { modules: st.modules, extra: extraDirector || '', globalMemo: st.globalMemo });
    if (extraDirector?.trim()) {
      const last = ctx.messages[ctx.messages.length - 1];
      if (last && last.role === 'user') last.content += directorBlock(extraDirector);
    }
    if (continueNode && base.trim()) {
      ctx.messages.push({ role: 'assistant', content: base }, { role: 'user', content: rewriteNote != null ? rewriteMsg(rewriteNote) : CONTINUE_MSG });
    }
    st.lastCtx = ctx;
    const styleSent = saved?.styleSent || (!resumeJob && !isOoc(a) ? styleSnapshot(ctx.info.moduleIds) : null);
    if (ctx.info.trimmed) toast(`剧情太长，最早的 ${ctx.info.trimmed} 条没有发给模型`);

    const ctrl = new AbortController();
    st.streaming = { id: a.id, ctrl };
    st.ooc = isOoc(a);
    renderFeed({ keepScroll: st.ooc });
    if (st.ooc) { fitOoc(); toBottom(oocFeed); }

    let lastSave = 0;
    let usageRaw = null;
    let cacheMode = saved?.cacheMode || '';
    let pendingRelay = false;
    let autoResume = false;
    const persist = () => db.put('nodes', a).catch(() => {});
    const onHide = () => { if (document.visibilityState === 'hidden') persist(); };
    document.addEventListener('visibilitychange', onHide);
    try {
      if (story.recallEnabled === true && story.recallConnectionId && conn?.model && !isOoc(a) &&
          !resumeJob && !reuse && !continueNode && story.recallConnectionId !== conn.id) {
        const recallId = story.recallConnectionId;
        const excerpt = await (async () => {
          const recallConn = (await getConnections()).find(item => item.id === recallId);
          if (!canUseMemoryConnection(recallConn)) return '';
          return runStoryRecall({ story, path: ctxPath, context: ctx, extra: extraDirector, conn: recallConn, signal: ctrl.signal });
        })().catch(() => '');
        if (excerpt && !ctrl.signal.aborted && story.recallEnabled === true && story.recallConnectionId === recallId && story.headId === a.id) {
          ctx.system += '\n\n' + excerpt;
          ctx.info.systemChars += excerpt.length + 2;
          ctx.info.totalChars += excerpt.length + 2;
          ctx.info.parts.push({ label: '旧剧情摘录', chars: excerpt.length, text: excerpt, kind: 'recall' });
        }
      }
      const r = await streamWithRetry(conn, {
        system: ctx.system, messages: ctx.messages, signal: ctrl.signal,
        cachePrefix: ctx.cachePrefix,
        cacheScope: JSON.stringify([story.id, ctxPath[0]?.id, latestCheckpoint(ctxPath)?.node.id]),
        resumeJob, relayServer: saved?.server || '',
        outputBoundary,
        onCache: ({ mode, created }) => {
          if (mode !== undefined) cacheMode = mode;
          if (!created) return;
          const input = created.tokens ?? approxTokens(ctx.cachePrefix.length);
          const usage = { input, output: 0, storageSeconds: created.seconds, est: created.tokens == null };
          void recordUsage({ kind: '创建 Gemini 缓存', storyId: story.id, model: conn.model, usage,
            cost: computeCost(usage, conn), cacheMode: 'vertex-explicit' });
        },
        onJob: async (jobId, server) => {
          if (a.relayJob && a.relayJob !== jobId) releaseStoryJob(a.relayJob);
          holdStoryJob(jobId);
          a.relayJob = jobId;
          a.relayContext = { server, styleSent, connectionId: conn.id, base, continuation, usageKind, outputBoundary, cacheMode,
            inChars: ctx.info.totalChars + (continueNode ? base.length : 0),
            connection: Object.fromEntries(['format', 'model', 'stream', 'priceMode', 'pricePerCall', 'priceIn', 'priceOut', 'priceCache', 'priceCacheWrite', 'currency'].map((k) => [k, conn[k]])) };
          try { await db.put('nodes', a); }
          catch { throw new ApiError('storage', '无法保存后台任务', { hint: '请先检查设备存储空间，再重试。' }); }
        },
        onText: (_d, full) => {
          // 接回时服务器从头重放：没追上之前不动画面，免得正文倒回去再长出来
          if (resumeJob && base.length + full.length < previousText.length) return;
          a.text = base + full; a.thinking = false;
          updateLive(a);
          const now = Date.now();
          if (now - lastSave > 1500) { lastSave = now; persist(); }
        },
        onThinking: () => { if (!a.thinking && !a.text) { a.thinking = true; updateLive(a); } },
      }, {
        queueStory: 'play', requestKind: resumeJob ? '接回正文' : reuse ? '重试正文' : usageKind, storyId: story.id,
        onRetry: (e) => toast(`${e.message}，自动重试中…`),
      });
      a.text = base + r.text;
      a.status = r.truncated ? 'partial' : 'done';
      a.finish = r.finish || null;
      usageRaw = r.usage || null;
      a.flagged = !!r.flagged;
    } catch (e) {
      const err = e instanceof ApiError ? e.toJSON() : { kind: 'unknown', message: String(e?.message || e) };
      usageRaw=e?.usage || usageRaw;
      const received = base + (e?.partial || '');
      a.text = a.relayJob && previousText.length > received.length ? previousText : received;
      const hasText = !!a.text.trim();
      pendingRelay = !!a.relayJob && (['relay_network', 'relay_auth', 'relay_config', 'relay_throttled'].includes(err.kind) || (err.kind === 'aborted' && ['leave', 'reconnect'].includes(ctrl.signal.reason)));
      if (pendingRelay) {
        a.status = 'streaming';
        autoResume = err.kind === 'relay_network';
        a.error = err.kind === 'relay_throttled'
          ? { ...err, hint: '请稍等再手动接回，原任务仍可取回。' }
          : { ...err, message: autoResume && relayRetry < 40 ? '连接断了，正在自动接回…' : '后台生成待接回', hint: '服务器仍会继续生成。恢复网络后会自动接回，也可以点“接回后台生成”；完成后 30 分钟内可以取回。' };
      } else if (err.kind === 'aborted') {
        a.stopped = hasText;
        a.status = hasText ? 'partial' : 'error';
        a.error = hasText ? null : { kind: 'stopped', message: '已停止', hint: '还没写出内容就停下了，可以点“重试”。' };
      } else {
        a.status = hasText ? 'partial' : 'error';
        a.error = err;
        if (!resumeJob || err.kind === 'ratelimit') a.retryAfter = Date.now() + 10000;
      }
    } finally {
      document.removeEventListener('visibilitychange', onHide);
      if (styleSent && (a.text?.trim() || a.error?.kind === 'output_format')) a.styleSent = styleSent;
      if (st.pendingFrame) { cancelAnimationFrame(st.pendingFrame); st.pendingFrame = 0; }
      a.thinking = false;
      st.streaming = null;
      // 用量与花费：这一次请求写出了内容才记账
      const outChars = Math.max(0, (a.text || '').length - base.length) + recoverableOutput(a.error).length;
      if (!pendingRelay && (outChars > 0 || usageRaw)) {
        const inChars = a.relayContext?.inChars ?? ctx.info.totalChars + (continueNode ? base.length : 0);
        const u = normalizeUsage(usageRaw, { inChars, outChars });
        const c = computeCost(u, conn);
        // 续写/从某段重写：把这次的花费累加到同一条上
        if (continuation && a.usageN) {
          a.usageN = { input: a.usageN.input + u.input, cached: (a.usageN.cached || 0) + u.cached, written: (a.usageN.written || 0) + (u.written || 0),
            cacheReported: a.usageN.cacheReported || u.cacheReported, output: a.usageN.output + u.output, est: a.usageN.est || u.est };
          a.cost = c && a.cost && a.cost.currency === c.currency ? { ...c, amount: a.cost.amount + c.amount, est: a.cost.est || c.est } : (c || a.cost || null);
        } else { a.usageN = u; a.cost = c; }
        await recordUsage({ kind: usageKind, storyId: story.id, model: conn?.model || a.model, usage: u, cost: c, cacheMode,
          requestId: a.relayJob ? (a.relayContext?.server || '') + '/' + a.relayJob : null });
      }
      if (!pendingRelay) { releaseStoryJob(a.relayJob); delete a.relayJob; delete a.relayContext; relayRetry = 0; clearTimeout(relayTimer); }
      else if ((a.text || '').length > previousText.length) relayRetry = 0;
      if (autoResume) scheduleResume();
      touch(a);
      await persist();
      if (a.kind !== 'ooc' && a.text?.trim()) {
        const p = parseReply(a.text);
        if (p.title) story.lastTitle = p.title;
      }
      story.chapters = chapterCount(headPath());
      story.updatedAt = Date.now();
      await saveStory();
      if (!destroyed) renderFeed({ keepScroll: true });
      if (!pendingRelay && a.kind !== 'ooc' && a.text?.trim() && a.status !== 'error') autoArchive(false);
    }
  }

  /** 到了该整理的章数就在后台整理；force：手动触发，有一章没整理就整理 */
  async function autoArchive(force) {
    if (st.archiving || destroyed || archivingNow(story.id)) return;
    const every = story.memEvery ?? DEFAULT_EVERY;
    const { pending } = pendingChapters(headPath());
    if (!pending.length) { if (force) toast('没有需要整理的章节'); return; }
    if (!force && (!every || pending.length < every)) return;
    const conn = await resolveMemoryConnection();
    if (st.archiving || destroyed || archivingNow(story.id)) return;
    st.archiveNeedsConnection = !conn;
    if (!conn) {
      st.archiveError = null;
      updateComposer();
      if (force) toast(MEMORY_CONNECTION_HINT);
      return;
    }
    const ctrl = new AbortController();
    st.archiving = { ctrl, text: `正在整理第 ${pending[0].no}–${pending[pending.length - 1].no} 章的前情` };
    st.archiveError = null;
    updateComposer();
    try {
      const r = await runArchivist(story, nodes, headPath(), conn, {
        signal: ctrl.signal, ctrl,
        onProgress: (t) => { if (st.archiving) { st.archiving.text = t; updateComposer(); } },
      });
      if (r.newCards?.length) toast(`前情已整理到第 ${r.to} 章，新登场的 ${r.newCards.join('、')} 已经建了角色卡（底部“角色”里过目）`, 5000);
      else if (r.written.length) toast(`前情已整理到第 ${r.to} 章，点“⋯ → 记忆”可以查看和修改`, 3500);
    } catch (e) {
      if (e?.kind !== 'aborted' && e?.kind !== 'busy') st.archiveError = e?.message || String(e);
    } finally {
      st.archiving = null;
      if (!destroyed) { renderFeed({ keepScroll: true }); }
    }
  }

  function stop() { st.streaming?.ctrl.abort('user'); }

  function resumePending(manual = true) {
    if (destroyed || jobs || st.streaming) return;
    const node = headPath().findLast((n) => n.relayJob);
    if (node) holdStoryJob(node.relayJob);
    if (!manual && node?.error?.kind === 'relay_throttled') return;
    const user = node && nodes.get(node.parentId);
    if (node && user) return generate(user, { reuse: node, resumeJob: node.relayJob });
  }

  const laterChapters = (n) => chapterCount(pathTo(leafOf(n).id)) - chapterCount(pathTo(n.id));

  async function regenerate(n, extraDirector = '') {
    const u = nodes.get(n.parentId);
    if (!u) return;
    const later = laterChapters(n);
    await generate(u, { extraDirector }); // 新版本，旧版本保留，可左右切换
    if (later > 0) toast(`原来后面的 ${later} 章留在旧版本那条分支里`);
  }
  async function retry(n) {
    if (retryWait(n.retryAfter)) return;
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
    st.undoHead = null;
    await saveStory();
    renderFeed();
  }

  // ───── 每一轮的操作 ─────
  async function replyMenu(n, { isLast }) {
    if (n.kind === 'ooc') {
      const k = await menu('场外回复', [
        { key: 'copy', label: '复制' },
        isLast ? null : { key: 'back', label: '回到这里', hint: '从这里接着往下，后面的内容保留在分支里' },
      ]);
      if (k === 'copy') copyText(n.text);
      else if (k === 'back') backTo(n);
      return;
    }
    const later = laterChapters(n);
    const branchHint = !isLast && later > 0 ? `，后面的 ${later} 章留在原来的分支里` : '';
    const k = await menu('这一章', [
      { key: 'edit', label: '修改这一章', hint: '改完直接算数，之后模型看到的就是改过的版本' },
      { key: 'cut', label: '从某一段往后重写', hint: '前面的段落保留，选一段从那里重新写' + branchHint },
      { key: 'redo', label: '按要求重写这一章', hint: '写一句要求，整章重写；原版本保留，可以左右切换' + branchHint },
      { key: 'fix', label: '这不像他（纠正人设）', hint: '写进角色卡的禁止清单，以后每轮都会提醒；可以顺手重写这一章' },
      isLast ? null : { key: 'back', label: '回到这里', hint: `从这一章重新往后玩${later > 0 ? `，后面的 ${later} 章放进分支` : ''}` },
      { key: 'copy', label: '复制正文' },
    ]);
    if (k === 'fix') correctChar(n);
    else if (k === 'edit') editReply(n);
    else if (k === 'cut') { st.pick = n.id; renderFeed({ focusId: n.id }); }
    else if (k === 'redo') {
      const note = await promptText({ title: '按要求重写这一章', placeholder: '例：他别这么快服软；多写一点环境；对话再短一些', hint: '只对这次重写生效。', okText: '重写' });
      if (note != null) regenerate(n, note);
    } else if (k === 'back') backTo(n);
    else if (k === 'copy') {
      const p = parseReply(n.text);
      copyText([p.title, ...paragraphs(p.body)].filter(Boolean).join('\n\n'));
    }
  }

  async function userMenu(n) {
    const k = await menu(n.kind === 'start' ? '开场' : '你的输入', [
      { key: 'edit', label: '修改', hint: '可以只改文字，也可以改完从这里重新生成' },
      { key: 'copy', label: '复制' },
    ]);
    if (k === 'copy') copyText(n.text);
    else if (k === 'edit') editUser(n);
  }

  function copyText(t) {
    navigator.clipboard?.writeText(t || '').then(() => toast('已复制'), () => toast('复制失败'));
  }

  function editReply(n) {
    const s = sheet({ title: '修改这一章' });
    const area = el('textarea', { style: { minHeight: '46vh' } });
    area.value = replyForContext(n);
    s.body.append(el('div', { class: 'field' }, area,
      el('div', { class: 'hint', text: '第一行“# ”后面是标题。【弹幕】下面可用“网名｜弹幕内容”补写昵称，【选项】下面照常写选项。改完下一轮模型看到的就是这个版本。' })));
    s.foot.append(
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!area.value.trim()) { toast('内容不能为空'); return; }
          n.text = area.value;
          delete n.optionEdits;
          n.edited = true;
          if (n.status === 'error') { n.status = 'done'; n.error = null; }
          touch(n);
          await db.put('nodes', n).catch(() => {});
          const p = parseReply(n.text);
          if (n.id === story.headId && p.title) story.lastTitle = p.title;
          await saveStory();
          s.close();
          toast('已修改');
          renderFeed({ focusId: n.id });
          // 这一章已经整理进记忆了：改的是事实的话，补一条勘误
          const cp = latestCheckpoint(headPath());
          const covered = cp && pathTo(cp.node.id).some((x) => x.id === n.id);
          if (covered) {
            const fix = await promptText({
              title: '要不要补一条勘误？',
              placeholder: '例：第12章他其实没有收下那支表',
              hint: '这一章已经整理进记忆了。如果你改的是事实（不只是措辞），写一句更正，记忆里会以它为准。只改措辞就点取消。',
              okText: '记下',
            });
            if (fix?.trim()) {
              cp.mem.corrections = [...(cp.mem.corrections || []), fix.trim()];
              await db.put('nodes', cp.node).catch(() => {});
              toast('已记进勘误');
            }
          }
        },
      }, '保存')
    );
  }

  function editUser(n) {
    const hasReply = childrenOf(n.id).length > 0;
    const s = sheet({ title: n.kind === 'start' ? '修改开场' : '修改你的输入' });
    const area = el('textarea', { style: { minHeight: '30vh' } });
    area.value = n.text || '';
    s.body.append(el('div', { class: 'field' }, area,
      el('div', { class: 'hint', text: hasReply
        ? '“只改文字”：保留后面的回复，只是之后模型看到的是改过的话。“改完重新生成”：从这里开一条新分支重写回复，原来的保留。'
        : '改完会用新的内容重新生成回复。' })));
    const saveOnly = async () => {
      n.text = area.value.trim(); n.edited = true; touch(n);
      await db.put('nodes', n).catch(() => {});
      s.close(); toast('已修改'); renderFeed({ keepScroll: true });
    };
    const saveAndRegen = async () => {
      const text = area.value.trim();
      if (!text && n.kind !== 'start') { toast('内容不能为空'); return; }
      s.close();
      if (hasReply) {
        const later = chapterCount(pathTo(leafOf(n).id)) - chapterCount(pathTo(n.parentId));
        await send(n.kind, text, { parentId: n.parentId ?? null, director: n.director || '' });
        if (later > 0) toast(`原来的 ${later} 章留在旧分支里，可以左右切换`);
      } else {
        n.text = text; touch(n);
        await db.put('nodes', n).catch(() => {});
        story.headId = n.id;
        await saveStory();
        await generate(n);
      }
    };
    s.foot.append(...[
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      hasReply ? el('button', { class: 'btn', onclick: saveOnly }, '只改文字') : null,
      el('button', { class: 'btn primary', onclick: saveAndRegen }, '改完重新生成'),
    ].filter(Boolean));
  }

  async function rewriteFrom(n, idx) {
    const p = parseReply(n.text);
    const paras = paragraphs(p.body);
    const keep = paras.slice(0, idx);
    const prefix = keep.length ? (p.title ? `# ${p.title}\n\n` : '') + keep.join('\n\n') : '';
    const note = await promptText({
      title: idx === 0 ? '整章重写' : `从第 ${idx + 1} 段往后重写`,
      placeholder: '想往哪个方向改？可以不填',
      hint: idx === 0 ? '从第一段开始重写，相当于整章重写。原来的版本会保留，可以左右切换。' : `前面 ${idx} 段保留，从这一段开始重新写。原来的版本会保留，可以左右切换。`,
      okText: '开始重写',
    });
    if (note == null) return;
    st.pick = null;
    const u = nodes.get(n.parentId);
    if (!u) return;
    if (!prefix) { await regenerate(n, note); return; }
    const later = laterChapters(n);
    const a = { id: uid(), storyId: story.id, parentId: u.id, role: 'assistant', kind: 'play', text: prefix, createdAt: Date.now() };
    await generate(u, { continueNode: a, rewriteNote: note });
    if (later > 0) toast(`原来后面的 ${later} 章留在旧版本那条分支里`);
  }

  // ───── 回退与分支 ─────
  async function backTo(n) {
    st.undoHead = story.headId;
    story.headId = n.id;
    await saveStory();
    renderFeed();
  }
  async function undoBack() {
    if (!st.undoHead || !nodes.get(st.undoHead)) { st.undoHead = null; renderFeed(); return; }
    story.headId = st.undoHead;
    st.undoHead = null;
    await saveStory();
    renderFeed();
  }

  function branchList() {
    const leaves = [...nodes.values()].filter((n) => !childrenOf(n.id).length);
    const headSet = new Set(headPath().map((n) => n.id));
    return leaves.map((leaf) => {
      const path = pathTo(leaf.id);
      const lastReply = [...path].reverse().find(isPlayReply);
      const lastUser = [...path].reverse().find((n) => n.role === 'user' && n.kind !== 'ooc');
      const said = !lastUser ? '' : lastUser.kind === 'start' ? '开场' : lastUser.kind === 'continue' ? '你：继续' : '你：' + (lastUser.text || '').replace(/\s+/g, ' ').slice(0, 40);
      const body = lastReply ? paragraphs(parseReply(lastReply.text).body)[0] || '' : '';
      return {
        leaf, path, said, snippet: body.slice(0, 36) + (body.length > 36 ? '…' : ''),
        chapters: chapterCount(path),
        title: lastReply ? parseReply(lastReply.text).title : '',
        current: leaf.id === story.headId,
        containsHead: headSet.has(leaf.id) || path.some((x) => x.id === story.headId),
        time: leaf.updatedAt || leaf.createdAt,
      };
    }).sort((a, b) => b.time - a.time);
  }

  async function showBranches() {
    const s = sheet({ title: '分支' });
    const draw = () => {
      s.body.replaceChildren();
      const list = branchList();
      const head = nodes.get(story.headId);
      if (head && childrenOf(head.id).length) {
        s.body.append(el('div', { class: 'card notice', style: { fontSize: '14px' } },
          `你现在停在第 ${chapterCount(headPath())} 章（回退后还没往下写）。`));
      }
      if (list.length <= 1 && !(head && childrenOf(head.id).length)) {
        s.body.append(el('div', { class: 'hint', style: { marginTop: 0 } }, '现在只有一条线。重写某一章、回到中间某一章再往下写，都会自动开出新分支，旧的会留在这里。'));
      }
      for (const b of list) {
        const delBtn = b.current || b.containsHead ? null : el('button', {
          class: 'btn small danger',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm('删除这条分支？只删它独有的部分，和当前这条线共用的章节不受影响。')) return;
            await deleteBranch(b.leaf);
            draw();
            renderFeed({ keepScroll: true });
          },
        }, '删除');
        s.body.append(el('div', {
          class: 'card story-card',
          onclick: async () => { story.headId = b.leaf.id; st.undoHead = null; await saveStory(); s.close(); renderFeed(); },
        },
          el('div', { class: 't' }, el('span', { text: `第 ${b.chapters} 章${b.title ? ' · ' + b.title : ''}` }), b.current ? el('span', { class: 'badge', text: '当前' }) : null),
          b.said ? el('div', { class: 'm', text: b.said }) : null,
          b.snippet ? el('div', { class: 'm', style: { color: 'var(--text3)' }, text: b.snippet }) : null,
          el('div', { class: 'row', style: { marginTop: '6px' } },
            el('div', { class: 'd', style: { marginTop: 0, flex: 1 }, text: new Date(b.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
            delBtn)
        ));
      }
    };
    draw();
    s.foot.append(el('button', { class: 'btn primary', onclick: () => s.close() }, '关闭'));
  }

  async function deleteBranch(leaf) {
    const keep = new Set(headPath().map((n) => n.id));
    const doomed = [];
    let cur = leaf;
    while (cur && !keep.has(cur.id)) {
      const parent = cur.parentId ? nodes.get(cur.parentId) : null;
      doomed.push(cur);
      if (!parent || childrenOf(parent.id).filter((c) => !doomed.includes(c)).length > 0) break;
      cur = parent;
    }
    for (const n of doomed) { nodes.delete(n.id); await db.del('nodes', n.id).catch(() => {}); }
    toast(`已删除 ${doomed.length} 条记录`);
  }

  // ───── 其他 ─────
  async function editDirector() {
    const v = await promptText({
      title: '导演指令', value: currentDirector(),
      placeholder: '例：这一轮让他主动出手；节奏放慢一点；这轮写短些',
      hint: '只对下一轮生效，不会写进规则，也不会出现在正文里。',
      okText: '好',
    });
    if (v != null) await saveDirector(v);
  }

  async function pickConnection() {
    const conns = await getConnections();
    if (!conns.length) { go('settings/new'); return; }
    const items = conns.map((c) => ({ key: c.id, label: connLabel(c) + (story.connectionId === c.id ? '  ✓' : ''), hint: c.model }));
    items.push({ key: '__default', label: '跟随默认连接' + (!story.connectionId ? '  ✓' : '') });
    items.push({ key: '__manage', label: '管理连接…' });
    const k = await menu('这个故事用哪个连接', items, { anchor: chip, selected: st.conn?.id });
    if (!k) return;
    if (k === '__manage') { go('settings'); return; }
    story.connectionId = k === '__default' ? null : k;
    await saveStory();
    st.conn = await resolveConnection(story);
    updateHeader();
    toast('之后的回复用「' + connLabel(st.conn) + '」');
  }

  async function storyMenu() {
    const leaves = branchList().length;
    const started = headPath().length > 0;
    const k = await menu(story.title || '故事', [
      started ? { key: 'ooc', label: st.ooc ? '退出出戏' : '出戏', hint: '问设定、商量走向，不推进剧情' } : null,
      { key: 'dir', label: st.director.trim() ? '修改导演指令' : '导演指令', hint: '只对下一轮生效的要求，不写进规则' },
      ...manualMods().map((m) => ({ key: 'mod:' + m.id, label: `情境：${m.name}${story.manualOn[m.id] ? '  ✓ 开着' : '（关着）'}`, hint: story.manualOn[m.id] ? '点一下关掉' : '点一下打开，之后每轮都带上这个模块' })),
      { key: 'edit', label: '世界设定与规则', hint: '世界设定、开场、弹幕/选项开关、规则和模块；角色在底部“角色”里' },
      { key: 'memory', label: '记忆（前情档案）', hint: (() => { const pc = pendingChapters(headPath()); return pc.cp ? `整理到第 ${pc.upTo} 章${pc.pending.length ? `，还有 ${pc.pending.length} 章没整理` : ''}` : '还没整理过；也在这里设每几章整理一次'; })() },
      { key: 'branch', label: `分支${leaves > 1 ? `（${leaves} 条）` : ''}`, hint: '重写或回退后留下的其他走向' },
      { key: 'cost', label: '花费', hint: '这个故事和本月花了多少' },
      { key: 'ctx', label: '查看发给模型的内容', hint: '排查“为什么他又不像他了”' },
      { key: 'transcript', label: '导出游玩记录', hint: 'JSON 或纯文本；可选带弹幕、选项、番外' },
      { key: 'export', label: '备份这个故事', hint: '完整存档（含所有分支），可以导回墨游；不含密钥' },
      { key: 'refresh', label: '检查更新并刷新' },
    ]);
    if (!k) return;
    if (k.startsWith('mod:')) {
      const mid = k.slice(4);
      story.manualOn[mid] = !story.manualOn[mid];
      await saveStory();
      updateComposer();
      toast(story.manualOn[mid] ? '已打开，下一轮起带上' : '已关掉');
    } else if (k === 'ooc') setOoc(!st.ooc);
    else if (k === 'dir') editDirector();
    else if (k === 'edit') go(`story/${encodeURIComponent(story.id)}`);
    else if (k === 'memory') go(`memory/${encodeURIComponent(story.id)}`);
    else if (k === 'branch') showBranches();
    else if (k === 'cost') showCost();
    else if (k === 'ctx') showContext();
    else if (k === 'transcript') openExportDialog(story.id, story.title);
    else if (k === 'refresh') window.dispatchEvent(new Event('moyu:refresh'));
    else if (k === 'export') {
      const data = await exportStory(story.id);
      const d = new Date();
      await saveFile(`墨游_${story.title}_备份_${d.getMonth() + 1}月${d.getDate()}日.json`, JSON.stringify(data, null, 1));
    }
  }

  async function showCost() {
    const s = sheet({ title: '花费' });
    const [logged, requests] = await Promise.all([getUsageLog(story.id), getRequestLog(story.id)]);
    // 记账清单是新加的：更早的几章从章节上记的用量补进来
    // （记账发生在一章写完时，章节是开始写时建的，所以留 10 分钟余量，免得第一笔重复算）
    const cutoff = logged.length ? logged[0].at - 600000 : Infinity;
    const older = [...nodes.values()]
      .filter((n) => n.role === 'assistant' && n.usageN && (n.createdAt || 0) < cutoff)
      .map((n) => ({ input: 0, output: 0, ...n.usageN, at: n.createdAt || 0, kind: n.kind === 'ooc' ? '出戏' : '正文', model: n.model || '', cost: n.cost || null }));
    const log = [...older, ...logged].sort((a, b) => a.at - b.at);
    const month = await getMonthSpend();
    const budget = await getBudget();
    const money = (o) => ['CNY', 'USD'].filter((c) => o[c] > 0).map((c) => CUR[c] + (o[c] < 0.01 ? Number(o[c].toPrecision(2)) : o[c].toFixed(2))).join(' + ');
    // 这个故事：按用途汇总（正文 / 整理前情 / 拆角色卡 / 补选项 / 番外…）
    const by = new Map();
    const tot = { CNY: 0, USD: 0, input: 0, output: 0, count: 0, est: false, unpriced: 0 };
    for (const x of log) {
      const g = by.get(x.kind) || { CNY: 0, USD: 0, input: 0, output: 0, count: 0 };
      for (const o of [g, tot]) {
        o.input += x.input; o.output += x.output; o.count++;
        if (x.cost) o[x.cost.currency] = (o[x.cost.currency] || 0) + x.cost.amount;
      }
      if (x.est) tot.est = true;
      if (!x.cost) tot.unpriced++;
      by.set(x.kind, g);
    }
    const play = by.get('正文');
    const avgIn = play?.count ? Math.round(play.input / play.count) : 0;
    const noPrice = !hasPrice(st.conn);
    const usageText = (x) => {
      const input = `${x.est ? '约' : ''}入 ${fmtTokens(x.input)}`;
      if (x.storageSeconds) return `${input} · 保留 ${x.storageSeconds} 秒`;
      const mode = { claude: 'Claude 缓存', 'vertex-explicit': 'Gemini 显式', 'vertex-implicit': 'Gemini 隐式' }[x.cacheMode];
      const cache = x.cacheReported || x.cached || x.written
        ? `命中 ${fmtTokens(x.cached || 0)} · 写入 ${fmtTokens(x.written || 0)} · 未缓存 ${fmtTokens(Math.max(0, x.input - (x.cached || 0) - (x.written || 0)))}`
        : mode ? '接口未报告缓存用量' : '';
      return [input, mode, cache, `出 ${fmtTokens(x.output)}`].filter(Boolean).join(' · ');
    };
    // 按次计价：没记上金额的早期调用，按现在的单价补算一个参考数
    const callMode = priceMode(st.conn) === 'call';
    const perCall = callMode ? Number(st.conn.pricePerCall) || 0 : 0;
    const callEst = callMode ? `按次：${tot.count} 次 × ${CUR[st.conn.currency || 'CNY']}${perCall} ≈ ${CUR[st.conn.currency || 'CNY']}${(tot.count * perCall).toFixed(2)}${tot.unpriced ? `（其中 ${tot.unpriced} 次是设单价之前的，按现在的单价补算）` : ''}` : '';
    s.body.append(
      el('div', { class: 'section-title', style: { marginTop: 0 }, text: '这个故事' }),
      el('div', { class: 'card' },
        el('div', { style: { fontSize: '22px', fontWeight: '600' } }, callMode ? `${CUR[st.conn.currency || 'CNY']}${(tot.count * perCall).toFixed(2)}` : money(tot) ? (tot.est ? '约 ' : '') + money(tot) : (noPrice ? '没设计价方式，算不出金额' : '—')),
        el('div', { class: 'hint', style: { whiteSpace: 'pre-wrap' } }, (callEst ? callEst + '\n' : '') + `共 ${tot.count} 次调用 · 输入 ${fmtTokens(tot.input)} · 输出 ${fmtTokens(tot.output)} token` +
          (avgIn ? `\n正文平均每轮 ${fmtTokens(avgIn)} 输入 token（含缓存命中）` : ''))),
      ...(by.size ? [el('div', { class: 'card' }, ...[...by.entries()].map(([k, g]) => el('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'nowrap', fontSize: '14px', padding: '3px 0' } },
        el('span', { text: `${k} × ${g.count}` }),
        el('span', { style: { color: 'var(--text2)' }, text: `入 ${fmtTokens(g.input)} · 出 ${fmtTokens(g.output)}${money(g) ? ' · ' + money(g) : ''}` }))))] : []),
      requests.length ? el('div', { class: 'section-title', text: '最近操作的请求次数' }) : null,
      requests.length ? el('div', { class: 'card' }, ...requests.slice(-30).reverse().map((x) =>
        el('div', { class: 'hint', text: [
          new Date(x.at).toTimeString().slice(0, 5), x.kind, x.model, `${x.posts} 次请求`,
          x.cachePosts ? `含 ${x.cachePosts} 次缓存请求` : '', x.relayPosts ? '经转发' : '',
          x.status ? `HTTP ${x.status}` : ({ ok: '完成', ratelimit: '限流', aborted: '已停止' }[x.outcome] || '失败'),
        ].filter(Boolean).join(' · ') }))) : null,
      log.length ? el('div', { class: 'section-title', text: '最近的调用' }) : null,
      log.length ? el('div', { class: 'card', style: { padding: '8px 14px' } }, ...log.slice(-30).reverse().map((x) => el('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'nowrap', fontSize: '13px', padding: '4px 0', borderBottom: '1px solid var(--line)' } },
        el('span', { style: { whiteSpace: 'nowrap' }, text: `${new Date(x.at).toTimeString().slice(0, 5)} ${x.kind}` }),
        el('span', { style: { color: 'var(--text2)', textAlign: 'right' }, text: `${usageText(x)}${x.cost ? ' · ' + fmtMoney(x.cost) : ''}` })))) : null,
      el('div', { class: 'section-title', text: '本月（所有故事）' }),
      el('div', { class: 'card' },
        el('div', { style: { fontSize: '22px', fontWeight: '600' } }, money(month) || (month.count ? '没设计价方式，算不出金额' : '—')),
        el('div', { class: 'hint' }, `共 ${month.count} 次调用 · 输入 ${fmtTokens(month.input)} · 输出 ${fmtTokens(month.output)} token` +
          (budget.amount ? ` · 提醒线 ${CUR[budget.currency]}${budget.amount}` : ''))),
      el('div', { class: 'hint', style: { whiteSpace: 'pre-wrap' } },
        [noPrice ? '金额要在“设置 → 连接 → 编辑”里选计价方式：按次（每次多少钱）或按 token（每百万 token 多少钱）。不设就只统计次数和 token。' : '',
          tot.est ? '带“约”的是按字数粗估的：这个接口没有返回真实用量。' : '',
          log.some(x => x.storageSeconds) ? 'Gemini 缓存存储费按保留时间和你填的存储价估算，留空时只估缓存创建用的输入费。' : '',
          '金额按你设的价格估算，实际扣费以中转站或官方后台的日志为准。'].filter(Boolean).join('\n'))
    );
    s.foot.append(el('button', { class: 'btn ghost', onclick: () => { s.close(); go('settings'); } }, '去设价格 / 提醒线'), el('button', { class: 'btn primary', onclick: () => s.close() }, '关闭'));
  }

  async function correctChar(n) {
    const cards = (story.cards || []).filter((c) => c.name?.trim());
    if (!cards.length) {
      if (confirm('这个故事还没有角色卡。现在去建？')) go(`story/${encodeURIComponent(story.id)}/cards`);
      return;
    }
    const chapterNo = chapterCount(pathTo(n.id));
    const s = sheet({ title: '这不像他' });
    const sel = el('select');
    cards.forEach((c) => sel.append(el('option', { value: c.id }, c.name)));
    const hit = cards.find((c) => splitNames(c).some((x) => x.length >= 2 && (n.text || '').includes(x)));
    if (hit) sel.value = hit.id;
    const area = el('textarea', { placeholder: '他不会……（写成具体动作）\n例：不会当众道歉；不会一被拒绝就退回去' });
    const regen = el('input', { type: 'checkbox' }); regen.checked = true;
    s.body.append(
      el('div', { class: 'field' }, el('label', { text: '是谁' }), sel),
      el('div', { class: 'field' }, el('label', { text: '哪里不像' }), area,
        el('div', { class: 'hint', text: `会写进他的禁止清单，标上“第 ${chapterNo} 章纠正”。以后他在场时，每轮都会提醒模型。` })),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '记下后重写这一章', el('small', { text: '原版本保留，可以左右切换' })), el('label', { class: 'switch' }, regen, el('span'))),
    );
    s.foot.append(
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const text = area.value.trim().replace(/\n+/g, '；');
          if (!text) { toast('写一下哪里不像'); return; }
          const card = story.cards.find((c) => c.id === sel.value);
          if (!card) return;
          card.forbid = (card.forbid?.trim() ? card.forbid.trim() + '\n' : '') + `${text}（第${chapterNo}章纠正）`;
          card.updatedAt = Date.now();
          await saveStory();
          s.close();
          toast(`已写进「${card.name}」的禁止清单`);
          if (regen.checked) regenerate(n, `上一版里${card.name}不像他自己：${text}。按他的角色卡重写这一章。`);
        },
      }, '记下'));
    setTimeout(() => area.focus(), 80);
  }

  function showContext() {
    const ctx = st.lastCtx || buildContext(story, headPath(), { modules: st.modules, globalMemo: st.globalMemo });
    const s = sheet({ title: st.lastCtx ? '上一轮发给模型的内容' : '下一轮会发给模型的内容' });
    const i = ctx.info;
    const block = (label, text, open = false) => {
      const d = el('details', { class: 'card', style: { padding: '10px 12px' } }, el('summary', { style: { cursor: 'pointer', fontSize: '14px' }, text: label }), el('pre', { class: 'raw', text }));
      if (open) d.open = true;
      return d;
    };
    s.body.append(...[
      el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '10px' } },
        `共约 ${i.totalChars.toLocaleString()} 字（粗估约 ${approxTokens(i.totalChars).toLocaleString()} token），${i.count} 条消息。` +
        (i.trimmed ? `最早的 ${i.trimmed} 条因为太长没有发送。` : '') + '较早轮次的弹幕和选项已去掉，只留正文。'),
      el('div', { class: 'card', style: { fontSize: '14px', lineHeight: 1.7 } },
        el('div', {}, '角色卡：', i.cards?.length ? i.cards.join('、') : '无'),
        el('div', {}, '在场（会提醒禁止清单）：', i.present?.length ? i.present.join('、') : '无'),
        el('div', {}, '规则模块：', i.modules?.length ? i.modules.join('、') : '无')),
      ...(i.parts || []).map((p) => block(`${p.label} · ${p.chars.toLocaleString()} 字`, p.text)),
      block(`剧情对话 · ${i.historyChars.toLocaleString()} 字`, ctx.messages.map((m) => `【${m.role === 'user' ? '玩家' : 'GM'}】\n${m.content}`).join('\n\n')),
      i.tail ? block('末尾提醒（贴在最后一条玩家消息里）', i.tail.trim(), true) : null,
    ].filter(Boolean));
    s.foot.append(el('button', {
      class: 'btn', onclick: () => navigator.clipboard?.writeText(`${ctx.system}\n\n${ctx.messages.map((m) => `【${m.role}】\n${m.content}`).join('\n\n')}`).then(() => toast('已复制'), () => toast('复制失败')),
    }, '复制全部'), el('button', { class: 'btn primary', onclick: () => s.close() }, '关闭'));
  }

  let destroyed = false;
  // 别处（记忆页）开始的整理：每秒刷新一下状态行，直到它结束
  const archTimer = setInterval(() => { if (!st.archiving && (st.extShown || archivingNow(story.id))) updateComposer(); }, 1000);
  const onCheckpoint = (e) => {
    const d = e.detail || {};
    if (d.storyId !== story.id) return;
    const n = nodes.get(d.nodeId);
    if (n && n.checkpoint !== d.mem) { n.checkpoint = d.mem; if (!destroyed && !st.archiving) renderFeed({ keepScroll: true }); }
  };
  window.addEventListener('moyu:checkpoint', onCheckpoint);
  // 存档员新建了角色卡（可能是别的页面发起的）：换成最新的卡，免得之后保存故事时把新卡覆盖掉
  const onCards = (e) => { if (e.detail?.storyId === story.id && Array.isArray(e.detail.cards)) story.cards = e.detail.cards; };
  window.addEventListener('moyu:cards', onCards);
  // 别的页面改了这个故事或某一章（角色卡、记忆、设定……）：换成最新的，免得后台写完时把别人的改动盖掉
  const unwatch = watchStory(story, () => { if (!destroyed) renderFeed({ keepScroll: true }); });
  let nodesDirty = false;
  const onPut = (e) => {
    const { store, obj } = e.detail || {};
    if (store !== 'nodes' || !obj || obj.storyId !== story.id) return;
    const mine = nodes.get(obj.id);
    if (mine === obj || obj.id === st.streaming?.id) return;
    nodes.set(obj.id, JSON.parse(JSON.stringify(obj)));
    nodesDirty = true;
  };
  window.addEventListener('moyu:put', onPut);
  const onVisible = () => {
    if (document.visibilityState !== 'visible' || destroyed) return;
    const node = st.streaming && nodes.get(st.streaming.id);
    relayRetry = 0;
    if (node?.relayJob) { reconnectRequested = true; st.streaming.ctrl.abort('reconnect'); }
    else if (jobs) reconnectRequested = true; // 上一次正在收尾，收完马上接回
    else void resumePending(false);
  };
  const onOnline = () => { relayRetry = 0; if (!destroyed && !jobs && document.visibilityState === 'visible') void resumePending(false); };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  st.ooc = oocPath().some(n => n.relayJob);
  renderFeed();
  if (usesPatentTheme() && !st.ooc && feed.querySelector('.options') && !ta.value.trim()) {
    setComposerCollapsed(true);
  }
  requestAnimationFrame(fit);
  void resumePending(false);
  const destroy = () => {
    destroyed = true;
    lineNumbers.disconnect();
    clearInterval(archTimer);
    window.removeEventListener('moyu:checkpoint', onCheckpoint);
    window.removeEventListener('moyu:cards', onCards);
    window.removeEventListener('moyu:put', onPut);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    clearTimeout(relayTimer);
    clearTimeout(retryTimer);
    unwatch();
    if (st.streaming) st.streaming.ctrl.abort('leave');
  };
  destroy.busy = () => jobs > 0;
  destroy.onIdle = (fn) => { idleCbs.add(fn); return () => idleCbs.delete(fn); };
  // 转发任务切页时只脱离前台订阅，服务器继续生成；回来后按已保存编号接回。
  destroy.background = () => {
    const node = st.streaming && nodes.get(st.streaming.id);
    if (node?.relayJob && !st.streaming.ctrl.signal.aborted) st.streaming.ctrl.abort('leave');
  };
  // 从后台切回来：连接、模块可能在设置里改过，重新拿一下；别处改过的章节重新画
  destroy.show = async () => {
    try { [st.packs, st.modules] = await Promise.all([getPacks(), getModules()]); } catch {}
    try { st.globalMemo = await getGlobalMemo(); } catch {}
    if (!st.streaming) { try { st.conn = await resolveConnection(story); } catch {} }
    if (nodesDirty || !st.streaming) { nodesDirty = false; renderFeed({ keepScroll: true }); }
    updateComposer();
    lineNumbers.observe();
    documentFooter.refresh();
    syncChoices();
    syncDocumentPosition();
    requestAnimationFrame(fit);
    if (st.ooc) requestAnimationFrame(fitOoc);
    void resumePending(false);
  };
  return destroy;
}
