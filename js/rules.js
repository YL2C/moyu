import { db } from './db.js';
import { uid } from './util.js';
import { getModules, saveModules, modulesFromMarkdown } from './state.js';

export const WORD_IMPORT_UNDO = 'modules.wordImportUndo';

export function markdownPack(text, filename, { groupName, verbatim = false } = {}) {
  const name = groupName || filename.replace(/\.(md|txt|docx)$/i, '');
  const pack = { id: uid(), name, kind: 'preset', file: filename, importedAt: Date.now() };
  const mods = modulesFromMarkdown(text, name, { verbatim }).map(m => ({ ...m, id: uid(), pack: pack.id, note: '来自预设「' + name + '」', mode: 'always', keywords: '', defaultOn: true }));
  pack.count = mods.length;
  return { pack, mods };
}

export async function importMarkdownPack(text, filename, { story, undo = false, ...options } = {}) {
  const { pack, mods } = markdownPack(text, filename, options);
  if (!mods.length) throw new Error('文件里没有内容');
  if (story) {
    const next = {
      ...story, updatedAt: Date.now(),
      localModules: [...(story.localModules || []), ...mods], packs: [...(story.packs || []), pack],
      modules: { ...story.modules, ...Object.fromEntries(mods.map(m => [m.id, m.defaultOn])) },
      ...(undo ? { wordImportUndo: pack.id } : {}),
    };
    await db.put('stories', next);
    Object.assign(story, next);
    return { pack, mods };
  }
  return db.kvUpdate(['modules', 'packs', WORD_IMPORT_UNDO], ({ modules, packs }) => ({
    values: {
      modules: [...(Array.isArray(modules) ? modules : []), ...mods], packs: [...(packs || []), pack],
      ...(undo ? { [WORD_IMPORT_UNDO]: pack.id } : {}),
    },
    result: { pack, mods },
  }));
}

export async function undoWordImport(story) {
  if (story) {
    const packId = story.wordImportUndo;
    if (!packId) return false;
    const gone = new Set((story.localModules || []).filter(m => m.pack === packId).map(m => m.id));
    const next = {
      ...story, updatedAt: Date.now(), wordImportUndo: null,
      localModules: (story.localModules || []).filter(m => m.pack !== packId),
      packs: (story.packs || []).filter(p => p.id !== packId),
      modules: Object.fromEntries(Object.entries(story.modules || {}).filter(([id]) => !gone.has(id))),
    };
    const undo = story.moduleDeleteUndo;
    if (undo?.mods.some(m => m.pack === packId)) {
      next.moduleDeleteUndo = { ...undo, mods: undo.mods.filter(m => m.pack !== packId), enabled: { ...undo.enabled } };
      undo.mods.filter(m => m.pack === packId).forEach(m => delete next.moduleDeleteUndo.enabled[m.id]);
    }
    await db.put('stories', next);
    Object.assign(story, next);
    return true;
  }
  return db.kvUpdate(['modules', 'packs', WORD_IMPORT_UNDO, 'modules.undo'], values => {
    const id = values[WORD_IMPORT_UNDO];
    if (!id) return { values: {}, result: false };
    const undo = values['modules.undo'];
    return {
      values: {
        [WORD_IMPORT_UNDO]: null,
        modules: (values.modules || []).filter(m => m.pack !== id), packs: (values.packs || []).filter(p => p.id !== id),
        ...(undo ? { 'modules.undo': { ...undo, mods: undo.mods.filter(m => m.pack !== id), packs: undo.packs.filter(p => p.id !== id) } } : {}),
      },
      result: true,
    };
  });
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
