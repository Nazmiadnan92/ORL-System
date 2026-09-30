import { createIdentityCrypto, syntheticSelfTest } from '../_shared/ic-crypto.mjs';

// Injectable dependencies allow tests of the exact HTTP handler without live secrets.
export function createReadinessHandler({ enabled, origins, authorize, cryptoConfig }) {
  return async request => {
    const origin = request.headers.get('origin');
    const allowed = !origin || origins.includes(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin' };
    if (origin && allowed) Object.assign(headers, { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-orl-session, apikey' });
    const reply = (status, value) => new Response(JSON.stringify(value), { status, headers });
    if (!allowed) return reply(403, { error: 'Not permitted.' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!enabled) return reply(503, { error: 'Readiness check disabled.' });
    if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    // This endpoint accepts no body or query (and therefore no patient identifiers).
    if (new URL(request.url).search) return reply(400, { error: 'No payload permitted.' });
    // Supabase's gateway may represent a zero-byte POST as a non-null stream.
    // Accept end-of-stream only; never parse/buffer a caller's payload.
    if (request.body !== null) {
      const reader = request.body.getReader();
      let timer;
      try {
        const first = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Body timeout')), 2000); }),
        ]);
        if (!first.done) return reply(400, { error: 'No payload permitted.' });
      } catch { return reply(400, { error: 'No payload permitted.' }); }
      finally {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const token = request.headers.get('x-orl-session') || '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token))
      return reply(401, { error: 'Valid Webmaster session required.' });
    try {
      // The database checks active account, expiry, role and password-change flag.
      const status = await authorize(token);
      if (!status || status.phase !== 'B' || status.schema_version !== 1 || status.patient_encryption_active !== false)
        return reply(403, { error: 'Readiness access denied.' });
    } catch { return reply(403, { error: 'Readiness access denied.' }); }
    try {
      const engine = await createIdentityCrypto(cryptoConfig());
      const checks = await syntheticSelfTest(engine);
      return reply(200, { phase: 'B', ready: true, patient_encryption_active: false, checks });
    } catch { return reply(503, { error: 'Readiness unavailable. Check private configuration.' }); }
  };
}
