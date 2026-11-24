import { el } from '../util.js';
import { readingDimension, READING_DIMENSIONS, readingTheme, setPrefs, usesPatentTheme } from '../state.js';

export function documentStatus(label) {
  const theme = readingTheme('patent');
  const size = READING_DIMENSIONS.find(dimension => dimension.key === 'size');
  const position = el('span', { 'aria-label': label });
  const value = el('output', { 'aria-label': '当前正文字号' });
  const decrease = sizeButton(-1, '−', '缩小正文字号');
  const increase = sizeButton(1, '+', '放大正文字号');
  const refresh = () => {
    const current = readingDimension(theme, size);
    value.textContent = current + ' px';
    decrease.disabled = current <= size.min;
    increase.disabled = current >= size.max;
  };
  function sizeButton(step, text, label) {
    return el('button', { class: 'btn small', 'aria-label': label, onclick: async () => {
      const current = readingDimension(theme, size);
      const next = Math.max(size.min, Math.min(size.max, current + step));
      const saved = setPrefs({ [theme.sizeKey]: next });
      refresh();
      await saved;
    } }, text);
  }
  const bar = el('div', { class: 'document-status', hidden: true },
    position, el('div', { class: 'document-zoom' }, decrease, value, increase));
  refresh();
  return { bar, position, refresh };
}

export function documentLines(container) {
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    const chapters = new Set(entries.map(({ target }) => target.parentElement));
    for (const chapter of chapters) {
      if (chapter?.isConnected) numberLines(chapter);
    }
  }) : null;
  const lineBlocks = ':is(p, .extra-raw)';
  const paragraphs = scope => scope.querySelectorAll('.gm:not(.ooc) > ' + lineBlocks);

  function numberLines(chapter) {
    if (!usesPatentTheme()) return;
    // Measure the rendered line boxes after wrapping, including after a font or zoom change.
    let line = 0;
    for (const paragraph of chapter.querySelectorAll(':scope > ' + lineBlocks)) {
      const height = parseFloat(getComputedStyle(paragraph).lineHeight);
      if (!height || !paragraph.clientHeight) continue;
      const count = Math.round(paragraph.clientHeight / height);
      const numbers = document.createDocumentFragment();
      for (let index = 1; index <= count; index++) {
        if ((line + index) % 5 !== 0) continue;
        numbers.append(el('span', {
          'data-line': line + index,
          style: { top: (index - 1) * height + 'px' },
        }));
      }
      line += count;
      paragraph.querySelector(':scope > .document-line-numbers')?.replaceChildren(numbers);
    }
  }

  return {
    observe(scope = container) {
      if (!observer || !usesPatentTheme()) return;
      for (const paragraph of paragraphs(scope)) {
        if (!paragraph.querySelector(':scope > .document-line-numbers')) {
          paragraph.append(el('span', { class: 'document-line-numbers', 'aria-hidden': 'true' }));
        }
        observer.observe(paragraph);
      }
    },
    unobserve(scope) {
      if (observer) for (const paragraph of paragraphs(scope)) observer.unobserve(paragraph);
    },
    disconnect() { observer?.disconnect(); },
  };
}
