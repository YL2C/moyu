import { db } from './db.js';
import { uid } from './util.js';

const FONT_LIST = 'readingFonts';
export const FONT_ACCEPT = '.ttf,.otf,.woff2,font/ttf,font/otf,font/woff2';
export const isLocalReadingFont = (id) => typeof id === 'string' && /^local-font-[a-z0-9-]+$/i.test(id);
export const listReadingFonts = () => db.kvGet(FONT_LIST, []);

async function readFace(id, file) {
  if (typeof FontFace !== 'function' || !document.fonts) throw new Error('当前浏览器无法加载自定义字体');
  try {
    return await new FontFace(id, await file.arrayBuffer()).load();
  } catch {
    throw new Error('无法读取这个字体，请选用有效的 TTF、OTF 或 WOFF2 文件');
  }
}

export async function importReadingFont(file) {
  if (!file.size || !/\.(ttf|otf|woff2)$/i.test(file.name)) throw new Error('请选择 TTF、OTF 或 WOFF2 字体');
  const id = 'local-font-' + uid();
  const name = file.name.replace(/\.[^.]+$/, '').trim() || '未命名字体';
  const face = await readFace(id, file);
  const item = { id, name };
  await db.kvUpdate([FONT_LIST], (values) => ({
    values: { [FONT_LIST]: [...(values[FONT_LIST] || []), item], [id]: file },
  }));
  preparedFace = face;
  return item;
}

export async function deleteReadingFont(id) {
  if (!isLocalReadingFont(id)) return;
  await db.kvUpdate([FONT_LIST], (values) => ({
    values: { [FONT_LIST]: (values[FONT_LIST] || []).filter(font => font.id !== id), [id]: null },
  }));
  if (preparedFace?.family === id) preparedFace = null;
}

let requested = null;
let activeFace = null;
let preparedFace = null;
let generation = 0;

export async function showReadingFont(id) {
  const next = isLocalReadingFont(id) ? id : null;
  if (next === requested) return;
  requested = next;
  const token = ++generation;
  const root = document.documentElement;
  root.style.removeProperty('--local-read-font');
  if (activeFace) document.fonts.delete(activeFace);
  activeFace = null;
  if (!next) return;
  try {
    const face = preparedFace?.family === next
      ? preparedFace
      : await readFace(next, await db.kvGet(next, null));
    if (preparedFace === face) preparedFace = null;
    if (token !== generation) return;
    document.fonts.add(face);
    activeFace = face;
    root.style.setProperty('--local-read-font', next);
  } catch {
    // 本机字体不可用时由 CSS 使用宋体。
    if (token === generation) requested = null;
  }
}
