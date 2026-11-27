// Backup encryption only. The server never receives either decrypting key.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const VAULT_PASSWORD_LENGTH = 16;
export const CHUNK_SIZE = 512 * 1024;

const aad = purpose => encoder.encode('moyu-vault-v1:' + purpose);
const random = size => crypto.getRandomValues(new Uint8Array(size));

export function toBase64(bytes) {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}

export const fromBase64 = text => Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
export const jsonBytes = value => encoder.encode(JSON.stringify(value));
export const readJson = bytes => JSON.parse(decoder.decode(bytes));
export const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  b => b.toString(16).padStart(2, '0')).join('');

async function passwordKey(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key, bytes, purpose) {
  const iv = random(12);
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(purpose) }, key, bytes));
  const packed = new Uint8Array(iv.length + result.length);
  packed.set(iv);
  packed.set(result, iv.length);
  return packed;
}

export async function unseal(key, packed, purpose) {
  if (packed.length < 28) throw new Error('加密数据不完整');
  return new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: packed.subarray(0, 12), additionalData: aad(purpose),
  }, key, packed.subarray(12)));
}

async function wrap(raw, password, keyId) {
  if (typeof password !== 'string' || [...password].length < VAULT_PASSWORD_LENGTH || !password.trim())
    throw new Error('请设置至少 16 个字符的备份密码');
  const salt = random(16);
  const rev = crypto.randomUUID();
  const key = await passwordKey(password, salt);
  return { version: 1, rev, keyId, salt: toBase64(salt), wrapped: toBase64(await seal(key, raw, 'key:' + rev + ':' + keyId)) };
}

const dataKey = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function unwrap(envelope, password) {
  try {
    if (envelope.version !== 1 || typeof envelope.rev !== 'string' || typeof envelope.keyId !== 'string') throw new Error();
    const key = await passwordKey(password, fromBase64(envelope.salt));
    const raw = await unseal(key, fromBase64(envelope.wrapped), 'key:' + envelope.rev + ':' + envelope.keyId);
    if (raw.length !== 32) throw new Error();
    return raw;
  } catch {
    throw new Error('备份密码不正确，或云端密钥已损坏');
  }
}

export async function createVaultKey(password) {
  const raw = random(32);
  try { return { key: await dataKey(raw), envelope: await wrap(raw, password, crypto.randomUUID()) }; }
  finally { raw.fill(0); }
}

export async function unlockVaultKey(envelope, password) {
  const raw = await unwrap(envelope, password);
  try { return await dataKey(raw); }
  finally { raw.fill(0); }
}

export async function changeVaultPassword(envelope, oldPassword, newPassword) {
  const raw = await unwrap(envelope, oldPassword);
  try { return await wrap(raw, newPassword, envelope.keyId); }
  finally { raw.fill(0); }
}

export async function sealObject(key, bytes, purpose) {
  const packed = await seal(key, bytes, purpose);
  return { id: await digest(packed), ciphertext: toBase64(packed) };
}

export async function openObject(key, id, ciphertext, purpose) {
  const packed = fromBase64(ciphertext);
  if (await digest(packed) !== id) throw new Error('备份文件校验失败');
  return unseal(key, packed, purpose);
}
