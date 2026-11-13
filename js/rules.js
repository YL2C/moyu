import { db } from './db.js';
import { uid } from './util.js';
import { getModules, saveModules, modulesFromMarkdown } from './state.js';

export function markdownPack(text, filename) {
  const name = filename.replace(/\.(md|txt)$/i, '');
  const pack = { id: uid(), name, kind: 'preset', file: filename, importedAt: Date.now() };
  const mods = modulesFromMarkdown(text, name).map(m => ({ ...m, id: uid(), pack: pack.id, note: '来自预设「' + name + '」', mode: 'always', keywords: '', defaultOn: true }));
  pack.count = mods.length;
  return { pack, mods };
}

export async function importMarkdownPack(text, filename) {
  const { pack, mods } = markdownPack(text, filename);
  if (!mods.length) throw new Error('文件里没有内容');
  await saveModules([...(await getModules()), ...mods]);
  await db.kvSet('packs', [...((await db.kvGet('packs', null)) || []), pack]);
  return { pack, mods };
}

export async function groupModules(ids, name) {
  const selected = new Set(ids), mods = await getModules();
  const found = mods.filter(m => selected.has(m.id));
  if (!found.length) return;
  const pack = { id: uid(), name: name.trim() || '我的预设', kind: 'preset', count: found.length, importedAt: Date.now() };
  for (const m of found) m.pack = pack.id;
  await saveModules(mods);
  const packs = ((await db.kvGet('packs', null)) || []).filter(p => mods.some(m => m.pack === p.id));
  await db.kvSet('packs', [...packs, pack]);
}

export async function deleteModules(ids) {
  const selected = new Set(ids), mods = await getModules();
  const removed = mods.filter(m => selected.has(m.id));
  if (!removed.length) return 0;
  const packs = (await db.kvGet('packs', null)) || [];
  const remaining = mods.filter(m => !selected.has(m.id));
  const removedPacks = packs.filter(p => removed.some(m => m.pack === p.id) && !remaining.some(m => m.pack === p.id));
  await db.kvSet('modules.undo', { mods: removed, packs: removedPacks, at: Date.now() });
  await saveModules(remaining);
  await db.kvSet('packs', packs.filter(p => !removedPacks.some(x => x.id === p.id)));
  return removed.length;
}

export async function undoModuleDelete() {
  const undo = await db.kvGet('modules.undo', null);
  if (!undo) return 0;
  const mods = await getModules(), packs = (await db.kvGet('packs', null)) || [];
  await saveModules([...mods, ...undo.mods.filter(m => !mods.some(x => x.id === m.id))]);
  await db.kvSet('packs', [...packs, ...undo.packs.filter(p => !packs.some(x => x.id === p.id))]);
  await db.del('kv', 'modules.undo');
  return undo.mods.length;
}
