// 墨游 · 故事资料：设定 / 角色 / 规则

import { db } from '../db.js';
import { el, uid, toast, sheet } from '../util.js';
import { getConnections, connLabel, resolveConnection, getModules, MODULE_MODES, go } from '../state.js';
import { streamWithRetry } from '../api.js';
import { DEFAULT_RULES } from '../prompt.js';

function sw(checked, onchange) {
  const input = el('input', { type: 'checkbox', onchange: () => onchange(input.checked) });
  input.checked = !!checked;
  return el('label', { class: 'switch' }, input, el('span'));
}

export async function render(root, { id, tab = 'setting' }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); go(''); return; }
  story.cards = story.cards || [];
  story.modules = story.modules || {};

  let saveTimer = 0;
  const savedHint = el('span', { class: 'muted', style: { fontSize: '12px' } });
  const saveNow = async () => {
    story.updatedAt = Date.now();
    try { await db.put('stories', story); savedHint.textContent = '已保存'; setTimeout(() => { savedHint.textContent = ''; }, 1500); } catch {}
  };
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 500); };

  const body = el('div', { class: 'wrap' });
  const tabs = el('div', { class: 'seg', style: { display: 'flex', margin: '4px 0 14px' } });
  const TABS = [['setting', '设定'], ['cards', '角色'], ['rules', '规则']];
  for (const [k, label] of TABS) {
    tabs.append(el('button', { class: k === tab ? 'on' : '', style: { flex: 1 }, onclick: () => go(`story/${encodeURIComponent(id)}/${k}`) }, label));
  }

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: async () => { clearTimeout(saveTimer); await saveNow(); go('play/' + encodeURIComponent(id)); } }, '‹'),
      el('div', { class: 'title' }, '故事资料', el('div', { class: 'sub', text: story.title || '未命名故事' })),
      savedHint
    ),
    el('div', { class: 'scroll' }, el('div', { class: 'wrap', style: { paddingBottom: 0 } }, tabs), body)
  ));

  // ───── 设定 ─────
  async function drawSetting() {
    const conns = await getConnections();
    const title = el('input', { type: 'text', oninput: () => { story.title = title.value.trim() || '未命名故事'; saveSoon(); } });
    title.value = story.title || '';
    const connSel = el('select', { onchange: () => { story.connectionId = connSel.value || null; saveSoon(); } });
    connSel.append(el('option', { value: '' }, '跟随默认连接'));
    for (const c of conns) connSel.append(el('option', { value: c.id }, `${connLabel(c)}（${c.model || '未填模型'}）`));
    connSel.value = story.connectionId || '';
    const world = el('textarea', { class: 'tall', placeholder: '世界观、主角是谁、开局处境……角色的详细人设建议写进“角色”栏的角色卡。', oninput: () => { story.world = world.value; saveSoon(); } });
    world.value = story.world || '';
    world.style.minHeight = '40vh';
    const opening = el('textarea', { placeholder: '可以不填。例：从新婚夜他“醒过来”的那一刻开始。', oninput: () => { story.opening = opening.value; saveSoon(); } });
    opening.value = story.opening || '';
    body.append(
      el('div', { class: 'field' }, el('label', { text: '故事名' }), title),
      el('div', { class: 'field' }, el('label', { text: '使用的连接' }), connSel),
      el('div', { class: 'field' }, el('label', { text: '世界设定' }), world),
      el('div', { class: 'field' }, el('label', { text: '开场（可选）' }), opening),
      el('div', { class: 'card' },
        el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '弹幕', el('small', { text: '读者实况评论，显示在正文下面' })), sw(story.danmu !== false, (v) => { story.danmu = v; saveSoon(); })),
        el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '参考选项', el('small', { text: '每轮给 3 个方向不同的行动建议' })), sw(story.options !== false, (v) => { story.options = v; saveSoon(); }))),
      el('div', { class: 'hint', text: '改动会自动保存，下一轮生效。' })
    );
  }

  // ───── 角色 ─────
  function drawCards() {
    body.append(el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '12px' } },
      '“常驻”的角色每轮都发给模型；其他角色只在最近的剧情或你的输入里被提到时才发。在场角色的“禁止清单”会贴在每轮最后提醒模型。'));
    const list = el('div');
    if (!story.cards.length) list.append(el('div', { class: 'empty', style: { padding: '24px 8px' } }, '还没有角色卡。', el('br'), '可以手动建，也可以让 AI 先从设定里拆一版草稿。'));
    for (const c of story.cards) {
      const firstLine = (c.initial || c.base || '').split('\n').find((l) => l.trim()) || '还没填内容';
      list.append(el('div', { class: 'card story-card', onclick: () => editCard(c) },
        el('div', { class: 't' }, el('span', { text: c.name || '未命名' }), el('span', { class: 'badge', text: c.core ? '常驻' : '被提到才发' })),
        c.aliases?.trim() ? el('div', { class: 'd', text: '也叫：' + c.aliases.trim() }) : null,
        el('div', { class: 'm', text: firstLine }),
        c.forbid?.trim() ? el('div', { class: 'd', text: `禁止清单 ${c.forbid.split('\n').filter((l) => l.trim()).length} 条` }) : null));
    }
    body.append(list,
      el('div', { class: 'row', style: { marginTop: '6px' } },
        el('button', { class: 'btn primary', onclick: () => editCard(null) }, '＋ 新角色'),
        el('button', { class: 'btn', onclick: () => aiSplit() }, '让 AI 从设定里拆角色卡')));
  }

  function editCard(existing) {
    const isNew = !existing;
    const c = existing ? { ...existing } : { id: uid(), name: '', aliases: '', core: story.cards.length < 3, initial: '', base: '', voice: '', forbid: '', arc: '', now: '', relation: '' };
    const s = sheet({ title: isNew ? '新角色' : (c.name || '角色卡') });
    const f = {};
    const field = (key, label, { tall = false, hint = '', lock = false, ph = '' } = {}) => {
      const inp = tall ? el('textarea', { placeholder: ph }) : el('input', { type: 'text', placeholder: ph });
      if (tall) inp.style.minHeight = '96px';
      inp.value = c[key] || '';
      f[key] = inp;
      return el('div', { class: 'field' }, el('label', { text: (lock ? '🔒 ' : '') + label }), inp, hint ? el('div', { class: 'hint', text: hint }) : null);
    };
    const core = el('input', { type: 'checkbox' }); core.checked = !!c.core;
    s.body.append(
      el('div', { class: 'hint', style: { marginTop: 0, marginBottom: '12px' } }, '🔒 的几栏是这个人的底稿，以后的自动存档不会改它们，只有你能改。写成具体动作比形容词管用：不写“他很傲娇”，写“被夸时会岔开话题，过一会儿又绕回来问你是不是真心的”。'),
      field('name', '名字', { ph: '例：沈澜' }),
      field('aliases', '别名', { ph: '用顿号分开，例：沈总、阿澜', hint: '剧情里出现名字或别名，就算“被提到”。' }),
      el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '常驻', el('small', { text: '主要角色打开：每轮都发。配角关掉：被提到才发，省钱也省注意力。' })), el('label', { class: 'switch' }, core, el('span'))),
      field('initial', '一、初始设定', { tall: true, lock: true, ph: '开局给的设定：身份、外貌、和主角的起点关系、登场时的态度' }),
      field('base', '二、底色', { tall: true, ph: '遇事反应：被夸、被拒、吃醋、被冒犯时具体会做什么；说话的样子；身份与配套（谁伺候他、钱怎么花、什么事不会亲自动手）' }),
      field('voice', '原话锚（一行一句）', { tall: true, lock: true, ph: '他说过的、最像他的几句话。只用来校准口气，模型不会照抄。' }),
      field('forbid', '禁止清单（一行一条）', { tall: true, lock: true, ph: '例：不会当众道歉（第12章纠正）\n不会主动解释自己', hint: '游玩时在某一章点“⋯ → 这不像他”，会自动写进这里。' }),
      field('arc', '三、变化轨迹', { tall: true, ph: '第几章发生了什么、他因此哪里变了、哪里没变' }),
      field('now', '四、当前状态与称呼', { tall: true, ph: '现在走到哪一步、对主角的立场、彼此怎么称呼' }),
      field('relation', '关系档案', { tall: true, ph: '相处梗、称呼史、生效中的约定、亲密档案' }),
    );
    s.foot.append(...[
      isNew ? null : el('button', {
        class: 'btn danger', style: { marginRight: 'auto' },
        onclick: async () => {
          if (!confirm(`删除「${c.name || '这个角色'}」的角色卡？`)) return;
          story.cards = story.cards.filter((x) => x.id !== c.id);
          await saveNow(); s.close(); redraw();
        },
      }, '删除'),
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          for (const k of Object.keys(f)) c[k] = f[k].value;
          c.name = c.name.trim();
          if (!c.name) { toast('名字要填'); return; }
          c.core = core.checked;
          c.updatedAt = Date.now();
          const i = story.cards.findIndex((x) => x.id === c.id);
          if (i >= 0) story.cards[i] = c; else story.cards.push(c);
          await saveNow(); s.close(); toast('角色卡已保存'); redraw();
        },
      }, '保存'),
    ].filter(Boolean));
  }

  async function aiSplit() {
    if (!story.world?.trim()) { toast('先在“设定”里写好世界设定'); return; }
    const conn = await resolveConnection(story);
    if (!conn) { toast('先在设置里添加连接'); return; }
    const s = sheet({ title: '从设定里拆角色卡' });
    const status = el('div', { class: 'thinking', text: '正在整理' });
    s.body.append(el('div', { class: 'hint', style: { marginTop: 0 } }, `用「${connLabel(conn)}」读一遍世界设定，整理出角色卡草稿。只会整理设定里写了的内容，没写的栏留空。`), status);
    const ctrl = new AbortController();
    s.foot.append(el('button', { class: 'btn ghost', onclick: () => { ctrl.abort('user'); s.close(); } }, '取消'));
    const prompt = '下面是一个文字互动小说的世界设定。请把其中除主角（玩家扮演的人）以外、有名有姓、会反复出现的角色，整理成角色卡草稿。\n' +
      '要求：只根据设定原文，不要编造设定里没有的内容；没写到的栏留空字符串。只输出一个 JSON 数组，不要任何说明或代码块标记。\n' +
      '每个元素：{"name":"名字","aliases":"别名，用顿号分开","core":是否主要角色(true/false),"initial":"设定里关于这个人的要点：身份、外貌、和主角的关系、初始态度","base":"性格底色：设定里写到的遇事反应和说话方式","voice":"设定里出现过的他的原话，一行一句","forbid":"设定里明确写了他不会做的事，一行一条"}\n\n' +
      '【世界设定】\n' + story.world.trim();
    let raw = '';
    try {
      const r = await streamWithRetry(conn, {
        system: '你是资料整理助手，只输出 JSON。', messages: [{ role: 'user', content: prompt }], maxTokens: 8000, signal: ctrl.signal,
        onText: (_d, full) => { raw = full; status.textContent = `正在整理（已收到 ${full.length} 字）`; },
      });
      raw = r.text;
    } catch (e) {
      if (e.kind === 'aborted') return;
      status.className = 'err'; status.textContent = '整理失败：' + e.message + (e.hint ? '。' + e.hint : '');
      return;
    }
    let arr = null;
    try {
      const a = raw.indexOf('['), b = raw.lastIndexOf(']');
      arr = JSON.parse(raw.slice(a, b + 1));
      if (!Array.isArray(arr)) throw new Error('不是数组');
    } catch {
      status.className = 'err';
      status.replaceChildren('模型返回的格式看不懂，可以再试一次或换个模型。', el('pre', { class: 'raw', text: raw.slice(0, 1500) }));
      return;
    }
    const existing = new Set(story.cards.map((c) => c.name));
    const drafts = arr.filter((x) => x && x.name).map((x) => ({
      id: uid(), name: String(x.name).trim(), aliases: String(x.aliases || ''), core: !!x.core,
      initial: String(x.initial || ''), base: String(x.base || ''), voice: String(x.voice || ''), forbid: String(x.forbid || ''),
      arc: '', now: '', relation: '',
    }));
    status.remove();
    if (!drafts.length) { s.body.append(el('div', { class: 'hint', text: '设定里没找到可以建卡的角色。' })); return; }
    const checks = drafts.map((d) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !existing.has(d.name);
      s.body.append(el('label', { class: 'card', style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } }, cb,
        el('div', { style: { flex: 1 } },
          el('div', { style: { fontWeight: 600 } }, d.name, d.core ? el('span', { class: 'badge', text: '常驻' }) : null, existing.has(d.name) ? el('span', { class: 'badge', text: '已有同名' }) : null),
          el('div', { class: 'hint', style: { marginTop: '4px' }, text: (d.initial || d.base || '').slice(0, 120) }))));
      return cb;
    });
    s.foot.replaceChildren(
      el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          const picked = drafts.filter((_, i) => checks[i].checked);
          story.cards.push(...picked);
          await saveNow(); s.close(); toast(`加了 ${picked.length} 张角色卡，记得逐个过目`); redraw();
        },
      }, '添加选中的'));
  }

  // ───── 规则 ─────
  async function drawRules() {
    const rules = el('textarea', { class: 'tall', oninput: () => { story.rules = rules.value; saveSoon(); } });
    rules.value = story.rules ?? '';
    rules.style.minHeight = '36vh';
    body.append(
      el('div', { class: 'field' }, el('label', { text: '这个故事自己的规则' }), rules,
        el('div', { class: 'hint' }, '只对这个故事生效。',
          el('a', { href: 'javascript:void 0', onclick: () => { if (confirm('用内置的通用规则替换当前内容？')) { rules.value = DEFAULT_RULES; story.rules = DEFAULT_RULES; saveSoon(); } } }, '恢复内置规则'))),
    );
    const mods = await getModules();
    body.append(el('div', { class: 'section-title', text: '启用的规则模块' }));
    if (!mods.length) {
      body.append(el('div', { class: 'card hint', style: { marginTop: 0 } }, '还没有规则模块。模块是可以在多个故事之间复用的规则块，比如“文风”“弹幕写法”“成人场景”。',
        el('div', { class: 'row', style: { marginTop: '8px' } }, el('button', { class: 'btn small', onclick: () => go('settings/modules') }, '去添加模块'))));
      return;
    }
    const box = el('div', { class: 'card' });
    for (const m of mods) {
      box.append(el('div', { class: 'switch-row' },
        el('div', { class: 'lbl' }, m.name, el('small', { text: `${MODULE_MODES[m.mode] || MODULE_MODES.always}${m.mode === 'keyword' && m.keywords ? '：' + m.keywords : ''} · ${m.text.length} 字` })),
        sw(!!story.modules[m.id], (v) => { story.modules[m.id] = v; saveSoon(); })));
    }
    body.append(box,
      el('div', { class: 'hint' }, '“手动开关”的模块启用后，要在游玩页右上角“⋯”里打开才会发送，比如进入成人场景前再开。'),
      el('div', { class: 'row', style: { marginTop: '8px' } }, el('button', { class: 'btn small ghost', onclick: () => go('settings/modules') }, '管理规则模块')));
  }

  function redraw() {
    body.replaceChildren();
    if (tab === 'cards') drawCards();
    else if (tab === 'rules') drawRules();
    else drawSetting();
  }
  redraw();
  return () => { clearTimeout(saveTimer); saveNow(); };
}
