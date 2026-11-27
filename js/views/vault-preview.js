import { readVaultItems, restoreVaultMaterial } from '../vault-backup.js';
import { currentMaterial, MATERIAL_LABELS } from '../deeptalk-materials.js';
import { parseReply } from '../parse.js';
import { el, toast } from '../util.js';

const CHAT_THREAD = 'deeptalk.v1.thread';
const TURN_PREFIX = 'deeptalk.v1.turn.';
const dateLabel = at => at ? new Date(at).toLocaleString() : '';
const shortText = text => String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, 55);
const prose = text => el('div', { text: text ?? '', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } });
const hint = text => el('p', { class: 'hint', text });
const textRecord = (label, text, open = false) => el('details', { class: 'card', open },
  el('summary', { text: label }), prose(text));

function pagedList(items, render, size = 20) {
  const list = el('div');
  let offset = 0;
  const next = el('button', { class: 'btn small', onclick: append }, '显示更多');
  function append() {
    list.append(...items.slice(offset, offset + size).map(render));
    offset += size;
    list.append(next);
    next.hidden = offset >= items.length;
  }
  append();
  return list;
}

function lazyDetail(label, load) {
  const body = el('div');
  const detail = el('details', { class: 'card' }, el('summary', { text: label }), body);
  let loaded = false;
  detail.addEventListener('toggle', async () => {
    if (!detail.open || loaded) return;
    loaded = true;
    body.replaceChildren(hint('正在读取…'));
    try { body.replaceChildren(await load()); }
    catch (error) {
      body.replaceChildren(hint(error.message + '。重新展开可重试。'));
      loaded = false;
    }
  });
  return detail;
}

export function vaultContents(config, snapshot, preview, button) {
  const read = selector => readVaultItems(config, snapshot, selector);
  const readKey = async key => (await read({ store: 'kv', keys: [key] }))[0]?.value;

  async function stories() {
    const items = (await read({ store: 'stories' })).map(({ value }) => value);
    items.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    if (!items.length) return hint('这份快照里没有跑团故事。');
    return pagedList(items, story => {
      const storyLabel = story.title || '未命名故事';
      return el('div', { class: 'card' }, el('strong', { text: storyLabel }),
        lazyDetail('查看章节及分支', async () => {
          const nodes = (await read({ store: 'nodes', storyId: story.id })).map(({ value }) => value);
          nodes.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
          if (!nodes.length) return hint('这份故事还没有章节。');
          return pagedList(nodes, node => {
            const title = node.role === 'assistant' ? parseReply(node.text || '').title : '';
            const label = [node.role === 'user' ? '玩家' : '剧情', title || shortText(node.text), dateLabel(node.createdAt)]
              .filter(Boolean).join(' · ');
            return textRecord(label, node.text);
          });
        }),
        lazyDetail('查看番外', async () => {
          const extras = (await read({ store: 'extras', storyId: story.id })).map(({ value }) => value);
          if (!extras.length) return hint('这份故事没有番外。');
          return pagedList(extras, extra => {
            const versions = extra.versions || [];
            return el('details', { class: 'card' },
              el('summary', { text: extra.title || extra.type || '番外' }),
              ...versions.map((version, index) =>
                textRecord('版本 ' + (index + 1), version.text, index === (extra.cur ?? versions.length - 1))));
          });
        }));
    });
  }

  async function chats() {
    const ids = await readKey(CHAT_THREAD);
    let end = Array.isArray(ids) ? ids.length : 0;
    if (!end) return hint('这份快照里没有日常聊天。');
    const list = el('div');
    const older = el('button', { class: 'btn small', text: '加载更早的聊天' });
    const info = hint('');
    async function page() {
      older.disabled = true;
      try {
        const from = Math.max(0, end - 20);
        const keys = ids.slice(from, end).map(id => TURN_PREFIX + id);
        const turns = new Map((await read({ store: 'kv', keys })).map(({ key, value }) => [key, value]));
        const blocks = keys.map(key => turns.get(key)).filter(Boolean).map(turn =>
          el('details', { class: 'card' },
            el('summary', { text: [dateLabel(turn.at), shortText(turn.text) || '聊天记录'].filter(Boolean).join(' · ') }),
            prose(turn.text),
            ...(turn.replies || []).map((reply, index) =>
              textRecord('回复 ' + (index + 1) + (reply.id === turn.selectedId ? ' · 当前版本' : ''),
                reply.text, reply.id === turn.selectedId))));
        list.prepend(...blocks);
        end = from;
        older.hidden = end === 0;
        info.textContent = '已加载最近 ' + (ids.length - end) + ' / ' + ids.length + ' 轮';
      } finally { older.disabled = false; }
    }
    older.addEventListener('click', () => void page().catch(error => toast(error.message, 4500)));
    await page();
    return el('div', {}, info, older, list);
  }

  function materials() {
    if (!preview.materialKeys.length) return hint('这份快照里没有资料包。');
    return el('div', {}, ...preview.materialKeys.map(slot => lazyDetail(MATERIAL_LABELS[slot] || slot, async () => {
      const material = (await read({ store: 'material', keys: [slot] }))[0]?.value;
      if (!material) return hint('这份资料无法读取。');
      const active = currentMaterial({ ...material, editions: material.editions || [] });
      const versions = [material.original, ...(material.editions || [])].filter(Boolean);
      if (!versions.length) return hint('这份资料没有正文。');
      const selection = el('select', { 'aria-label': '资料版本' }, ...versions.map((version, index) =>
        el('option', { value: index,
          text: [version.sourceName || (version === material.original ? '原稿' : '版本 ' + index),
            version === active ? '当前版本' : ''].filter(Boolean).join(' · ') })));
      selection.value = String(Math.max(0, versions.indexOf(active)));
      const body = prose(versions[Number(selection.value)].text);
      selection.addEventListener('change', () => { body.textContent = versions[Number(selection.value)].text || ''; });
      return el('div', {}, el('div', { class: 'row' }, selection, button('恢复这一份资料', async () => {
        if (!window.dispatchEvent(new Event('moyu:before-migration', { cancelable: true })))
          throw new Error('请等生成完成后再恢复');
        if (!confirm('恢复会替换本机这一份资料及其版本。确认恢复？')) return;
        await restoreVaultMaterial(config, snapshot, slot);
        toast('资料已恢复');
      })), body);
    })));
  }

  async function memory() {
    const saved = await readKey('deeptalk.v1.memory');
    const entries = saved?.entries || saved?.items || [];
    if (!entries.length) return hint('这份快照里没有整理后的聊天记忆。');
    return pagedList([...entries].reverse(), entry => textRecord(
      [entry.status === 'deleted' ? '已删除' : '', shortText(entry.text) || '记忆条目', dateLabel(entry.at)].filter(Boolean).join(' · '),
      entry.text));
  }

  async function discussions() {
    const threads = (await read({ store: 'kv', prefix: 'disc.' })).map(({ value }) => value)
      .filter(thread => Array.isArray(thread?.messages));
    threads.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    if (!threads.length) return hint('这份快照里没有独立讨论。');
    return pagedList(threads, thread => lazyDetail(thread.title || '未命名讨论', () =>
      pagedList(thread.messages, message => textRecord(
        (message.role === 'user' ? '你' : '回复') + ' · ' + shortText(message.content), message.content))));
  }

  return el('div', {},
    lazyDetail('跑团故事和章节（' + preview.stories + ' 个故事）', stories),
    lazyDetail('日常聊天（' + preview.turns + ' 轮）', chats),
    lazyDetail('资料包全文（' + preview.materials + ' 份）', materials),
    lazyDetail('聊天记忆', memory),
    lazyDetail('独立讨论', discussions));
}
