// 墨游 · 新建 / 编辑故事设定

import { db } from '../db.js';
import { el, sheet, toast, uid } from '../util.js';
import { getConnections, getDefaultRules, connLabel } from '../state.js';
import { CARD_FIELDS } from '../discuss.js';
import { DEFAULT_RULES } from '../prompt.js';

function switchRow(label, sub, checked) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  const row = el('div', { class: 'switch-row' },
    el('div', { class: 'lbl' }, label, sub ? el('small', { text: sub }) : null),
    el('label', { class: 'switch' }, input, el('span'))
  );
  return { row, input };
}

function cardDraftEditor(card) {
  const name = el('input', { type: 'text', 'aria-label': '角色名' });
  const aliases = el('input', { type: 'text', 'aria-label': '别名' });
  name.value = card.name;
  aliases.value = card.aliases;
  const summary = el('summary', { text: card.name || '未命名角色' });
  name.addEventListener('input', () => { summary.textContent = name.value.trim() || '未命名角色'; });
  const core = switchRow('常驻', '主要角色每轮带上，其他角色在被提到时带上。', card.core);
  const include = el('input', { type: 'checkbox', checked: true });
  const fields = Object.entries(CARD_FIELDS).map(([key, label]) => {
    const input = el('textarea', { 'aria-label': label });
    input.value = card[key] || '';
    return [key, label, input];
  });
  const field = (label, input) => el('div', { class: 'field' }, el('label', { text: label }), input);
  const node = el('details', { class: 'card' }, summary,
    el('label', { class: 'row', style: { margin: '10px 0' } }, include, '随故事创建这张卡'),
    field('角色名', name), field('别名', aliases), core.row,
    ...fields.map(([, label, input]) => field(label, input)));
  const id = uid();
  const read = () => include.checked ? {
    id, name: name.value.trim(), aliases: aliases.value.trim(), core: core.input.checked,
    ...Object.fromEntries(fields.map(([key, , input]) => [key, input.value.trim()])),
  } : null;
  return { node, read };
}

/** 打开设定编辑。返回保存后的故事；取消返回 null */
export function openStoryEditor(existing, prefill = null) {
  return new Promise(async (resolve) => {
    let saved = null;
    const isNew = !existing;
    const reviewDraft = isNew && prefill?.protagonist && Array.isArray(prefill.cards);
    const story = existing ? { ...existing } : {
      id: uid(), title: '', world: '', rules: await getDefaultRules(), opening: '',
      danmu: true, options: true, connectionId: null, headId: null,
      createdAt: Date.now(), updatedAt: Date.now(), schema: 1,
    };
    if (!existing && prefill) {
      for (const k of ['title', 'world', 'opening']) if (prefill[k]) story[k] = prefill[k];
      if (prefill.rulesExtra?.trim()) story.rules = (story.rules || '').trim() + '\n\n' + prefill.rulesExtra.trim();
      if (reviewDraft) story.protagonist = { ...prefill.protagonist };
    }
    const conns = await getConnections();
    const s = sheet({ title: isNew ? '新故事' : '故事设定', onClose: () => resolve(saved) });

    const title = el('input', { type: 'text', placeholder: '填写故事名' });
    title.value = story.title || '';

    const connSel = el('select');
    connSel.append(el('option', { value: '' }, '跟随默认连接'));
    for (const c of conns) connSel.append(el('option', { value: c.id }, `${connLabel(c)}（${c.model || '未填模型'}）`));
    connSel.value = story.connectionId || '';

    const world = el('textarea', { class: 'tall', 'aria-label': '世界设定', placeholder: '时代、地点、势力、社会规则和开局前的大事。' });
    world.value = story.world || '';
    const worldField = el('div', { class: 'field' }, el('label', { text: '世界设定' }), world);

    const rules = el('textarea', { class: 'tall' });
    rules.value = story.rules ?? '';

    const opening = el('textarea', { placeholder: '可以不填。描述开场的时间、地点和正在发生的事。' });
    opening.value = story.opening || '';

    const pro = story.protagonist || {};
    const pName = el('input', { type: 'text', placeholder: '填写主角名字' }); pName.value = pro.name || '';
    const pGender = el('select');
    for (const g of ['', '女', '男', '其他']) pGender.append(el('option', { value: g }, g || '不指定'));
    pGender.value = pro.gender || '';
    const pNote = reviewDraft ? el('textarea', { 'aria-label': '主角设定', placeholder: '身份、外貌、说话习惯和开局时知道的事' }) : null;
    if (pNote) pNote.value = pro.note || '';
    const cardEditors = reviewDraft ? prefill.cards.map(cardDraftEditor) : [];

    const dm = switchRow('弹幕', '读者实况评论，显示在正文下面', story.danmu !== false);
    const op = switchRow('参考选项', '每轮给 A/B/C/D 四个方向不同的行动建议', story.options !== false);

    s.body.append(
      el('div', { class: 'field' }, el('label', { text: '故事名' }), title),
      el('div', { class: 'field' }, el('label', { text: '使用的连接' }), connSel,
        conns.length ? null : el('div', { class: 'hint', text: '还没有连接，先去设置里添加一个。' })),
      reviewDraft ? worldField : null,
      reviewDraft ? el('h3', { class: 'section-title' }, '主角卡（你）') : null,
      el('div', { class: 'row', style: { alignItems: 'flex-start', flexWrap: 'nowrap' } },
        el('div', { class: 'field', style: { flex: 2 } }, el('label', { text: '主角（你）的名字' }), pName),
        el('div', { class: 'field', style: { flex: 1 } }, el('label', { text: '性别' }), pGender)),
      reviewDraft ? el('div', { class: 'field' }, el('label', { text: '主角设定' }), pNote) :
        el('div', { class: 'hint', style: { marginTop: '-6px', marginBottom: '10px' } }, '番外使用这里指定的姓名和性别。更多设定可以在底部“角色”里补。'),
      reviewDraft ? null : worldField,
      reviewDraft ? el('section', { 'aria-label': '角色卡草稿' },
        el('h3', { class: 'section-title' }, `角色卡（${cardEditors.length} 张）`),
        cardEditors.length ? cardEditors.map(c => c.node) : el('p', { class: 'hint' }, '草稿里没有其他角色。')) : null,
      el('div', { class: 'field' }, el('label', { text: '开场（可选）' }), opening),
      el('div', { class: 'field' },
        el('label', { text: '规则' }), rules,
        el('div', { class: 'hint' },
          '这份规则只属于这个故事；新故事会复制设置里的“默认规则”。',
          el('br'),
          el('a', { href: 'javascript:void 0', onclick: () => { if (confirm('用内置的通用规则替换当前内容？')) rules.value = DEFAULT_RULES; } }, '恢复内置规则')
        )
      ),
      el('div', { class: 'card' }, dm.row, op.row),
    );
    const saveButton = el('button', {
      class: 'btn primary',
      onclick: async () => {
        if (reviewDraft) {
          const cards = cardEditors.map(c => c.read()).filter(Boolean);
          const names = new Set([pName.value.trim().normalize('NFKC').toLowerCase()]);
          for (const card of cards) {
            if (!card.name) { toast('请填写角色名，或取消勾选这张卡'); return; }
            const name = card.name.normalize('NFKC').toLowerCase();
            if (names.has(name)) { toast('角色名重复：' + card.name); return; }
            names.add(name);
          }
          story.cards = cards;
          story.protagonist.note = pNote.value.trim();
        }
        story.protagonist = { ...(story.protagonist || {}), name: pName.value.trim(), gender: pGender.value };
        story.title = title.value.trim() || '未命名故事';
        story.connectionId = connSel.value || null;
        story.world = world.value;
        story.rules = rules.value;
        story.opening = opening.value;
        story.danmu = dm.input.checked;
        story.options = op.input.checked;
        story.updatedAt = Date.now();
        saveButton.disabled = true;
        try {
          await db.put('stories', story);
          saved = story;
          toast(isNew ? '故事已创建' : '设定已保存');
          s.close();
        } catch { saveButton.disabled = false; }
      },
    }, isNew ? '创建' : '保存');
    s.foot.append(el('button', { class: 'btn ghost', onclick: () => s.close() }, '取消'), saveButton);
    if (isNew) setTimeout(() => title.focus(), 80);
  });
}
