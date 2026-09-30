// Server-only Web Crypto primitives. Never import this module into docs/.
// No logging, persistence, patient authorization, or patient HTTP endpoints here.
const utf8 = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idPattern = /^[a-z0-9-]{1,40}$/;
const fail = () => { throw new Error('Identity operation failed.'); };
export const toBase64 = bytes => btoa(String.fromCharCode(...bytes));
function fromBase64(value) {
  if (typeof value !== 'string' || value.length > 256 || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return fail();
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  if (toBase64(bytes) !== value) return fail();
  return bytes;
}
export function normalizeIdentity(raw) {
  // ASCII-only, versioned normalization matches current exact search behavior.
  // Unsupported legacy values must be inventoried before migration, not coerced.
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 128
      || !/^[\x20-\x7E]+$/.test(raw)) return fail();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return fail();
  return normalized;
}
export async function createIdentityCrypto(config) {
  if (!config || !/^[a-z0-9-]{1,80}$/.test(config.context || '')) return fail();
  const encryption = new Map(), search = new Map(), allMaterial = new Set();
  for (const [ring, target, algorithm, usages] of [
    [config.encryptionKeys, encryption, { name: 'AES-GCM' }, ['encrypt', 'decrypt']],
    [config.searchKeys, search, { name: 'HMAC', hash: 'SHA-256' }, ['sign']],
  ]) {
    if (!ring || Array.isArray(ring) || typeof ring !== 'object'
        || Object.keys(ring).length < 1 || Object.keys(ring).length > 10) return fail();
    for (const [id, encoded] of Object.entries(ring)) {
      const bytes = fromBase64(encoded);
      if (!idPattern.test(id) || bytes.length !== 32 || allMaterial.has(encoded)) return fail();
      allMaterial.add(encoded);
      target.set(id, await crypto.subtle.importKey('raw', bytes, algorithm, false, usages));
      bytes.fill(0);
    }
  }
  if (!encryption.has(config.activeEncryptionKey) || !search.has(config.activeSearchKey)) return fail();
  const aad = (requestId, keyId) => {
    if (typeof requestId !== 'string' || !uuid.test(requestId)) return fail();
    return utf8.encode(JSON.stringify(['ORL_IC', 1, config.context, requestId.toLowerCase(), keyId]));
  };
  return Object.freeze({
    async encrypt(raw, requestId) {
      normalizeIdentity(raw);
      const keyId = config.activeEncryptionKey;
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const bytes = utf8.encode(raw);
      try {
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: aad(requestId, keyId), tagLength: 128 },
          encryption.get(keyId), bytes);
        return { version: 1, key_id: keyId, nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(ciphertext)) };
      } finally { bytes.fill(0); }
    },
    async decrypt(envelope, requestId) {
      try {
        if (!envelope || envelope.version !== 1 || !encryption.has(envelope.key_id)) return fail();
        const nonce = fromBase64(envelope.nonce), ciphertext = fromBase64(envelope.ciphertext);
        if (nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > 144) return fail();
        const bytes = new Uint8Array(await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: aad(requestId, envelope.key_id), tagLength: 128 },
          encryption.get(envelope.key_id), ciphertext));
        try {
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          normalizeIdentity(raw);
          return raw;
        } finally { bytes.fill(0); }
      } catch { return fail(); }
    },
    async searchHash(raw, keyId = config.activeSearchKey) {
      if (!search.has(keyId)) return fail();
      const message = utf8.encode(JSON.stringify(['ORL_IC_SEARCH', 1, config.context, normalizeIdentity(raw)]));
      const hash = await crypto.subtle.sign('HMAC', search.get(keyId), message);
      return { key_id: keyId, normalization_version: 1, hash: toBase64(new Uint8Array(hash)) };
    },
  });
}

export async function syntheticSelfTest(engine) {
  // Fixed fabricated identifiers only. Never accept patient values from HTTP.
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  const raw = '000101-00-0000';
  const a = await engine.encrypt(raw, firstId), b = await engine.encrypt(raw, firstId);
  const h1 = await engine.searchHash(raw), h2 = await engine.searchHash('000101000000');
  const h3 = await engine.searchHash('000101000001');
  let swapRejected = false, tamperRejected = false;
  try { await engine.decrypt(a, secondId); } catch { swapRejected = true; }
  const changed = fromBase64(a.ciphertext); changed[0] ^= 1;
  try { await engine.decrypt({ ...a, ciphertext: toBase64(changed) }, firstId); } catch { tamperRejected = true; }
  const ok = (await engine.decrypt(a, firstId)) === raw && a.nonce !== b.nonce
    && a.ciphertext !== b.ciphertext && h1.hash === h2.hash && h1.hash !== h3.hash
    && swapRejected && tamperRejected;
  if (!ok) return fail();
  return { round_trip: true, randomized_ciphertext: true, exact_search: true, tamper_rejected: true, record_swap_rejected: true };
}
