const TTL_SECONDS = 300;
const RETRY_AFTER_MS = 60_000;
const vertexEntries = new Map();
const explicitModels = new Map([
  ['gemini-2.5-flash', 2048], ['gemini-2.5-flash-lite', 2048], ['gemini-2.5-pro', 2048],
  ['gemini-3-flash-preview', 6144], ['gemini-3.1-pro-preview', 6144],
  ['gemini-3.1-flash-lite', 4096], ['gemini-3.5-flash-lite', 4096], ['gemini-3.5-flash', 4096], ['gemini-3.6-flash', 4096],
]);

export function vertexCacheTarget(url, model) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.port || target.username || target.password || target.search || target.hash ||
      !/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(target.hostname)) return null;
  const match = target.pathname.match(/^\/v1\/(projects\/[^/]+\/locations\/[^/]+)\/endpoints\/openapi\/chat\/completions$/);
  const gemini = model.match(/^(?:google\/)?(gemini-[a-z0-9.-]+)$/i);
  if (!match || !gemini) return null;
  const resource = decodeURI(match[1]);
  return {
    url: `${target.origin}/v1/${match[1]}/cachedContents`,
    project: resource.split('/')[1],
    region: resource.split('/')[3],
    model: `${resource}/publishers/google/models/${gemini[1]}`,
    minimum: explicitModels.get(gemini[1]),
  };
}

export function isCacheRejection(status, raw) {
  return [400, 403, 404].includes(status) && /cached.?content|cache_control|prompt.?caching/.test(String(raw).toLowerCase());
}

export function forgetVertexCache(cache) {
  if (vertexEntries.get(cache.key)?.value?.name === cache.name) {
    vertexEntries.set(cache.key, { expires: Date.now() + RETRY_AFTER_MS, value: null });
  }
}

export async function acquireVertexCache(target, { prefix, scope, signal, request }) {
  if (!scope || !target.minimum || prefix.length < target.minimum || !globalThis.crypto?.subtle || signal?.aborted) return null;
  const bytes = new TextEncoder().encode(JSON.stringify([target.model, scope, prefix]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const key = `${target.url}:${Array.from(hash, b => b.toString(16).padStart(2, '0')).join('')}`;
  if (signal?.aborted) return null;
  const now = Date.now();
  for (const [k, e] of vertexEntries) if (e.expires <= now && !e.pending) vertexEntries.delete(k);
  const existing = vertexEntries.get(key);
  if (existing) return { cache: await (existing.pending || existing.value) };
  const entry = {};
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  // A cache failure never blocks the ordinary request. Keep the maintenance call short.
  const timer = setTimeout(() => ctrl.abort('idle'), 6500);
  entry.pending = (async () => {
    try {
      const res = await request(target.url, {
        method: 'POST', signal: ctrl.signal,
        body: JSON.stringify({ model: target.model, ttl: `${TTL_SECONDS}s`, systemInstruction: { parts: [{ text: prefix }] } }),
      });
      if (!res.ok) { await res.body?.cancel(); return null; }
      const data = await res.json();
      const name = typeof data.name === 'string' && data.name.match(/^projects\/([\w-]+)\/locations\/([\w-]+)\/cachedContents\/[\w-]+$/);
      if (!name || (name[1] !== target.project && !/^\d+$/.test(name[1])) || name[2] !== target.region) return null;
      const expires = Date.parse(data.expireTime);
      if (!(expires > Date.now() + 15_000)) return null;
      return { key, name: data.name, expires, tokens: Number(data.usageMetadata?.totalTokenCount) || null,
        seconds: Math.max(0, Math.round((expires - (Date.parse(data.createTime) || Date.now())) / 1000)) };
    } catch { return null; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  })();
  vertexEntries.set(key, entry);
  const value = await entry.pending;
  Object.assign(entry, { value, expires: value ? value.expires - 15_000 : Date.now() + RETRY_AFTER_MS, pending: null });
  if (vertexEntries.size > 32) {
    const oldest = [...vertexEntries].find(([k, e]) => k !== key && !e.pending);
    if (oldest) vertexEntries.delete(oldest[0]);
  }
  return { cache: value, created: value };
}
