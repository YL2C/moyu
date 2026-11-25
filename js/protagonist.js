export const PROTAGONIST_FIELDS = { identity: '当前身份', abilities: '能力与资源', status: '当前状态', relations: '关系变化' };

export function protagonistState(protagonist = {}, path = []) {
  const allowed = new Set(path.map(n => n.id));
  const state = {};
  for (const entry of protagonist.stateEntries || []) {
    if (allowed.has(entry.sourceNodeId) && PROTAGONIST_FIELDS[entry.field]) state[entry.field] = entry;
  }
  return state;
}

const compact = s => s.normalize('NFKC').replace(/\*\*|__|==|\s/g, '');

export function reviewProtagonistChanges(raw, sources, current = {}) {
  const entries = Array.isArray(raw?.changes) ? raw.changes : [];
  const prepared = sources.map(s => ({ ...s, normalized: compact(s.text || '') }));
  const verify = e => {
    const quote = typeof e === 'string' ? e : e?.quote;
    if (typeof quote !== 'string') return null;
    const needle = compact(quote.trim().replace(/^[“‘「『"']|[”’」』"']$/g, ''));
    if (needle.length < 4) return null;
    const matches = prepared.filter(s => s.normalized.includes(needle));
    const source = matches.find(s => s.id === e?.source) || (matches.length === 1 ? matches[0] : null);
    return source ? { source: source.id, label: source.label, quote } : null;
  };
  return entries.filter(c => Object.hasOwn(PROTAGONIST_FIELDS, c?.field) && typeof c.value === 'string' && c.value.trim()).slice(0, 12).map(c => {
    const evidence = (Array.isArray(c.evidence) ? c.evidence : [c.evidence]).map(verify).filter(Boolean);
    return { field: c.field, value: c.value.trim().slice(0, 2000), previous: current[c.field]?.value || '',
      evidence, conflict: c.conflict === true, valid: evidence.length > 0 };
  }).filter(c => c.value !== c.previous);
}

// A later draft supersedes the older suggestion for the same field on this path.
export function pendingProtagonistChanges(protagonist = {}, path = []) {
  const current = protagonistState(protagonist, path);
  const pathIds = new Set(path.map(node => node.id));
  const accepted = new Set((protagonist.stateEntries || [])
    .filter(entry => entry.archiveDraftId && pathIds.has(entry.sourceNodeId))
    .map(entry => entry.archiveDraftId + ':' + entry.field));
  const seen = new Set();
  const pending = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    const draft = node.checkpoint?.protagonistDraft;
    if (!draft?.id || !Array.isArray(draft.changes)) continue;
    for (const change of draft.changes) {
      if (!Object.hasOwn(PROTAGONIST_FIELDS, change?.field) || seen.has(change.field)) continue;
      seen.add(change.field);
      const previous = current[change.field]?.value || '';
      const archiveDraftId = draft.id;
      if (change.value === previous || accepted.has(archiveDraftId + ':' + change.field)) continue;
      const changedSinceDraft = change.previous !== previous;
      pending.push({ ...change, previous, changedSinceDraft, conflict: change.conflict || changedSinceDraft,
        archiveNodeId: node.id, archiveDraftId });
    }
  }
  return pending;
}

export function applyProtagonistChanges(protagonist, changes, sourceNodeId) {
  const selected = changes.filter(c => (c.valid || c.manualConfirmed === true) && Object.hasOwn(PROTAGONIST_FIELDS, c.field));
  if (!selected.length) throw new Error('请先勾选要保存的变化');
  const entries = protagonist.stateEntries || [];
  return { ...protagonist, updateUndo: { entries: structuredClone(entries), sourceNodeId, at: Date.now() },
    stateEntries: [...entries, ...selected.map(c => ({ field: c.field, value: c.value, evidence: c.evidence, sourceNodeId, updatedAt: Date.now(),
      ...(c.archiveDraftId ? { archiveDraftId: c.archiveDraftId } : {}),
      ...(!c.valid ? { manualConfirmed: true } : {}) }))] };
}
