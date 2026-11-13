// 墨游 · 故事设定：世界设定 / 规则（角色在底部菜单的“角色”里）

import { db } from '../db.js';
import { el, toast } from '../util.js';
import { getConnections, connLabel, getModules, MODULE_MODES, go, setCurrentStory, watchStory, PLAY_KEYS } from '../state.js';
import { DEFAULT_RULES } from '../prompt.js';
import { getPacks, deleteStoryPack, KIND_LABEL } from '../tavern.js';
import { packToggle, importFlow } from './packs-ui.js';
import { rulePanel } from './rules-ui.js';

function sw(checked, onchange) {
  const input = el('input', { type: 'checkbox', onchange: () => onchange(input.checked) });
  input.checked = !!checked;
  return el('label', { class: 'switch' }, input, el('span'));
}

export async function render(root, { id, tab = 'setting' }) {
  const story = await db.get('stories', id);
  if (!story) { toast('找不到这个故事'); setCurrentStory(null); go(''); return; }
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
  const TABS = [['setting', '世界设定'], ['rules', '规则']];
  for (const [k, label] of TABS) {
    tabs.append(el('button', { class: k === tab ? 'on' : '', style: { flex: 1 }, onclick: () => go(`story/${encodeURIComponent(id)}/${k}`) }, label));
  }

  root.append(el('div', { class: 'view' },
    el('div', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': '返回', onclick: async () => { clearTimeout(saveTimer); await saveNow(); go('play/' + encodeURIComponent(id)); } }, '‹'),
      el('div', { class: 'title' }, '故事设定', el('div', { class: 'sub', text: story.title || '未命名故事' })),
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
    const world = el('textarea', { class: 'tall', placeholder: '世界观、主角是谁、开局处境……角色的详细人设建议写进底部“角色”里的角色卡。', oninput: () => { story.world = world.value; saveSoon(); } });
    world.value = story.world || '';
    world.style.minHeight = '40vh';
    const opening = el('textarea', { placeholder: '可以不填。描述开场的时间、地点和正在发生的事。', oninput: () => { story.opening = opening.value; saveSoon(); } });
    opening.value = story.opening || '';
    body.append(
      el('div', { class: 'field' }, el('label', { text: '故事名' }), title),
      el('div', { class: 'field' }, el('label', { text: '使用的连接' }), connSel),
      el('div', { class: 'field' }, el('label', { text: '世界设定' }), world),
      el('div', { class: 'field' }, el('label', { text: '开场（可选）' }), opening),
      el('div', { class: 'card' },
        el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '弹幕', el('small', { text: '读者实况评论，显示在正文下面' })), sw(story.danmu !== false, (v) => { story.danmu = v; saveSoon(); })),
        el('div', { class: 'switch-row' }, el('div', { class: 'lbl' }, '参考选项', el('small', { text: '每轮给 A/B/C/D 四个方向不同的行动建议' })), sw(story.options !== false, (v) => { story.options = v; saveSoon(); }))),
      el('div', { class: 'hint', text: '改动会自动保存，下一轮生效。' })
    );
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
    const all = await getModules();
    const mods = all.filter((m) => !m.pack);
    const globalPacks = (await getPacks()).filter((p) => all.some((m) => m.pack === p.id));
    story.localModules = story.localModules || [];
    story.packs = story.packs || [];
    body.append(el('div', { class: 'section-title', text: '启用的规则模块' }));
    const globalBox = rulePanel({ mods: all, packs: globalPacks, enabled: story.modules, onChange: saveSoon });
    body.append(globalBox,
      el('div', { class: 'hint', text: '开关只对当前故事生效。情境模块仍需在游玩页菜单中打开。' }),
      el('button', { class: 'btn small', onclick: () => go('settings/modules') }, '管理分组和批量删除'));

    // 只给这个故事导入的（酒馆预设、世界书、角色卡）
    body.append(el('div', { class: 'section-title', text: '这个故事自己导入的' }));
    const own = el('div', { class: 'card' });
    if (!story.packs.length) own.append(el('div', { class: 'hint', style: { marginTop: 0 } }, '可以导入酒馆的预设、世界书、角色卡（JSON、PNG 角色卡，或者打包的 ZIP），只对这个故事生效。'));
    for (const p of story.packs) {
      const pm = story.localModules.filter((m) => m.pack === p.id);
      const del = () => {
        const cards = (p.cardIds || []).map((cid) => story.cards.find((c) => c.id === cid)?.name).filter(Boolean);
        if (!confirm(`删除「${p.name}」？会删掉它带来的 ${pm.length} 条规则${cards.length ? '和角色卡：' + cards.join('、') : ''}。`)) return;
        deleteStoryPack(story, p.id);
        saveNow().then(() => { body.replaceChildren(); drawRules(); });
        toast('已删除');
      };
      if (pm.length) own.append(packToggle(p, pm, story.modules, saveSoon, del));
      else own.append(el('div', { class: 'switch-row' },
        el('div', { class: 'lbl' }, '📦 ' + p.name, el('small', { text: `${KIND_LABEL[p.kind] || '导入'}${p.cardIds?.length ? ' · 加了角色卡' : ''}` })),
        el('button', { class: 'btn small ghost danger-text', onclick: del }, '删除')));
    }
    own.append(el('div', { class: 'row', style: { marginTop: '8px' } },
      el('button', { class: 'btn small primary', onclick: async () => { if (await importFlow(story)) { await saveNow(); body.replaceChildren(); drawRules(); } } }, '导入酒馆文件')));
    body.append(own);
    if (story.localModules.length) body.append(rulePanel({ mods: story.localModules, packs: story.packs, enabled: story.modules, onChange: saveSoon, onDelete: async (ids) => {
      if (!confirm(`删除本故事所选 ${ids.length} 条局部规则？角色卡保留。`)) return;
      story.moduleDeleteUndo = { mods: story.localModules.filter(m => ids.includes(m.id)), enabled: Object.fromEntries(ids.map(id => [id, story.modules[id]])) };
      story.localModules = story.localModules.filter(m => !ids.includes(m.id));
      ids.forEach(id => delete story.modules[id]); await saveNow(); redraw();
    }, onUndo: async () => {
      const undo = story.moduleDeleteUndo; if (!undo) { toast('没有可以撤销的删除'); return; }
      story.localModules.push(...undo.mods.filter(m => !story.localModules.some(x => x.id === m.id)));
      Object.assign(story.modules, undo.enabled); delete story.moduleDeleteUndo; await saveNow(); redraw();
    } }));
  }

  function redraw() {
    body.replaceChildren();
    if (tab === 'rules') drawRules();
    else drawSetting();
  }
  redraw();
  const unwatch = watchStory(story, null, PLAY_KEYS);
  return () => { unwatch(); clearTimeout(saveTimer); saveNow(); };
}
