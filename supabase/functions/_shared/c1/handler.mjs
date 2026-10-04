// C1 shared request handler. Serving remains controlled by ORL_IC_C1_ENABLED.
import { createIdentityCrypto, normalizeIdentity } from '../ic-crypto.mjs';
import { C1_BODY_TIMEOUT_MS } from './runtime-policy.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fields = new Set(['patient_ic', 'age', 'age_months', 'mrn', 'patient_name', 'surgery',
  'diagnosis', 'doctor', 'specialist', 'sub_specialty', 'phone', 'remark', 'allow_duplicate', 'duplicate_reason']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readPayload(request, limit = 16384) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim() !== 'application/json'
      || request.headers.has('content-encoding') || !request.body) throw new Error('Invalid input');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('Invalid input');
  const reader = request.body.getReader();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let size = 0;
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new Error('Invalid input');
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Body timeout')), C1_BODY_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
    // A timed-out pending read settles on cancel; do not release its lock here.
  }
}

export function createIcRequestHandler({ enabled = false, origins, authorize, commit, cryptoConfig }) {
  return async request => {
    const origin = request.headers.get('origin');
    const allowed = !origin || origins.includes(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (origin && allowed) Object.assign(headers, { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-orl-session, apikey' });
    const reply = (status, value) => new Response(JSON.stringify(value), { status, headers });
    if (!allowed) return reply(403, { error: 'Not permitted.' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!enabled) return reply(503, { error: 'IC creation is not enabled.' });
    if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    if (new URL(request.url).search) return reply(400, { error: 'Query parameters are not permitted.' });
    const token = request.headers.get('x-orl-session') || '';
    if (!uuid.test(token)) return reply(401, { error: 'Valid session required.' });
    try {
      // Return a boolean only. The database must revalidate session in the write transaction.
      if (await authorize(token) !== true) return reply(403, { error: 'Access denied.' });
    } catch { return reply(403, { error: 'Access denied.' }); }
    let data, requestId, raw, generation;
    try {
      const body = await readPayload(request);
      if (!object(body) || Object.keys(body).sort().join(',') !== 'data,generation,request_id'
          || typeof body.generation !== 'string' || !uuid.test(body.generation)
          || typeof body.request_id !== 'string' || !uuid.test(body.request_id) || !object(body.data))
        throw new Error('Invalid input');
      for (const [key, value] of Object.entries(body.data)) {
        if (!fields.has(key) || (typeof value !== 'string' && !(key === 'allow_duplicate' && typeof value === 'boolean')))
          throw new Error('Invalid input');
      }
      requestId = body.request_id.toLowerCase();
      generation = body.generation.toLowerCase();
      // Match PostgreSQL trim(text); reject unsupported identifiers, never silently erase them.
      raw = (body.data.patient_ic || '').replace(/^ +| +$/g, '');
      if (raw) normalizeIdentity(raw);
      data = { ...body.data, patient_ic: raw };
    } catch { return reply(400, { error: 'Invalid request or unsupported IC / Passport format.' }); }
    let envelope = null, search = null;
    try {
      const engine = await createIdentityCrypto(cryptoConfig());
      if (raw) {
        envelope = await engine.encrypt(raw, requestId);
        search = await engine.searchHash(raw);
        if (await engine.decrypt(envelope, requestId) !== raw) throw new Error('Verification failed');
      }
    } catch { return reply(503, { error: 'Identity protection unavailable. Nothing was submitted.' }); }
    try {
      // One SQL transaction: existing clinical validation, request, identity and audit.
      // C1 shadow phase still sends plaintext to the database. This is NOT plaintext removal.
      const result = await commit({ p_session_token: token, p_request_id: requestId,
        p_data: data, p_envelope: envelope, p_search: search, p_generation: generation });
      if (result !== requestId) throw new Error('Unexpected result');
      return reply(200, { request_id: requestId });
    } catch {
      // A network timeout can mean committed-but-response-lost. Never auto-submit again.
      return reply(503, { error: 'Save could not be confirmed. Use Check Previous Save before submitting again.' });
    }
  };
}
