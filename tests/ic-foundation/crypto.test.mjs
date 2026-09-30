import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityCrypto, normalizeIdentity, syntheticSelfTest, toBase64 } from '../../supabase/functions/_shared/ic-crypto.mjs';
import { createReadinessHandler } from '../../supabase/functions/ic-readiness/handler.mjs';
import { execFileSync } from 'node:child_process';

const randomKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config = () => ({ context: 'orl-synthetic-test', activeEncryptionKey: 'enc-v1', activeSearchKey: 'search-v1',
  encryptionKeys: { 'enc-v1': randomKey() }, searchKeys: { 'search-v1': randomKey() } });
const requestId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const raw = '000101-00-0000';

test('round trip, randomized ciphertext, exact normalized search and authenticated binding', async () => {
  const engine = await createIdentityCrypto(config());
  assert.equal((await syntheticSelfTest(engine)).record_swap_rejected, true);
  for (const input of [raw, '  AB 0123 / 45  ', 'x', 'A'.repeat(128)]) {
    assert.equal(await engine.decrypt(await engine.encrypt(input, requestId), requestId), input);
  }
  const hashes = await Promise.all(['ab-123', 'AB 123', 'ab/123'].map(s => engine.searchHash(s)));
  assert.equal(new Set(hashes.map(x => x.hash)).size, 1);
});

test('reject invalid input, invalid key material, shared keys and absent keys', async () => {
  const engine = await createIdentityCrypto(config());
  for (const input of ['', null, 1234, '---', '\nABC', '名字', 'A'.repeat(129)]) {
    assert.throws(() => normalizeIdentity(input));
    await assert.rejects(engine.encrypt(input, requestId));
  }
  await assert.rejects(engine.encrypt(raw, 'not-a-uuid'));
  const shared = randomKey();
  await assert.rejects(createIdentityCrypto({ ...config(), searchKeys: { 'search-v1': shared }, encryptionKeys: { 'enc-v1': shared } }));
  await assert.rejects(createIdentityCrypto({ ...config(), encryptionKeys: { 'enc-v1': 'not-a-key' } }));
  await assert.rejects(createIdentityCrypto({ ...config(), activeEncryptionKey: 'missing' }));
  await assert.rejects(engine.searchHash(raw, 'missing'));
});

test('wrong key, context, record, envelope metadata, nonce and ciphertext fail closed', async () => {
  const original = config(), engine = await createIdentityCrypto(original);
  const envelope = await engine.encrypt(raw, requestId);
  const wrongKey = await createIdentityCrypto(config());
  const otherContext = await createIdentityCrypto({ ...original, context: 'another-project' });
  await assert.rejects(wrongKey.decrypt(envelope, requestId));
  await assert.rejects(otherContext.decrypt(envelope, requestId));
  await assert.rejects(engine.decrypt(envelope, otherId));
  for (const patch of [{ version: 2 }, { key_id: 'missing' }, { nonce: 'AAAA' },
    { ciphertext: '!!!!' }, { ciphertext: 'A'.repeat(260) }, { nonce: toBase64(new Uint8Array(12)) }]) {
    await assert.rejects(engine.decrypt({ ...envelope, ...patch }, requestId));
  }
});

test('key rotation preserves reads with retained old keys; loss of key cannot silently fall back', async () => {
  const oldConfig = config(), oldEngine = await createIdentityCrypto(oldConfig);
  const oldEnvelope = await oldEngine.encrypt(raw, requestId);
  const newConfig = { ...oldConfig, encryptionKeys: { ...oldConfig.encryptionKeys, 'enc-v2': randomKey() },
    searchKeys: { ...oldConfig.searchKeys, 'search-v2': randomKey() }, activeEncryptionKey: 'enc-v2', activeSearchKey: 'search-v2' };
  const rotated = await createIdentityCrypto(newConfig);
  assert.equal(await rotated.decrypt(oldEnvelope, requestId), raw);
  assert.equal((await rotated.encrypt(raw, requestId)).key_id, 'enc-v2');
  assert.deepEqual(await rotated.searchHash(raw, 'search-v1'), await oldEngine.searchHash(raw));
  assert.notEqual((await rotated.searchHash(raw)).hash, (await oldEngine.searchHash(raw)).hash);
  const lost = await createIdentityCrypto({ ...newConfig, encryptionKeys: { 'enc-v2': newConfig.encryptionKeys['enc-v2'] } });
  await assert.rejects(lost.decrypt(oldEnvelope, requestId));
});

function handler(overrides = {}) {
  return createReadinessHandler({ enabled: true, origins: ['https://nazmiadnan92.github.io'],
    authorize: async () => ({ phase: 'B', schema_version: 1, patient_encryption_active: false }),
    cryptoConfig: config, ...overrides });
}
function req({ method = 'POST', body, origin = 'https://nazmiadnan92.github.io', session = token, query = '' } = {}) {
  const headers = { origin };
  if (session) headers['x-orl-session'] = session;
  return new Request(`https://example.invalid/ic-readiness${query}`, { method, headers, body });
}
test('HTTP readiness returns boolean checks only, no keys, identifiers, ciphertext or hash', async () => {
  const response = await handler()(req());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const value = await response.json();
  assert.equal(value.patient_encryption_active, false);
  assert.deepEqual(Object.keys(value).sort(), ['checks', 'patient_encryption_active', 'phase', 'ready']);
  assert.equal(Object.values(value.checks).every(x => x === true), true);
  for (const sensitive of [raw, token, '"ciphertext":', '"search_hash":']) assert.equal(JSON.stringify(value).includes(sensitive), false);
});
test('HTTP rejects untrusted origins, patient payloads, query strings and invalid sessions before crypto', async () => {
  let authCalls = 0, cryptoCalls = 0;
  const run = handler({ authorize: async () => { authCalls++; throw new Error('private backend error'); },
    cryptoConfig: () => { cryptoCalls++; return config(); } });
  for (const [input, expected] of [[{ origin: 'https://evil.invalid' }, 403], [{ body: JSON.stringify({ patient_ic: raw }) }, 400],
    [{ query: '?patient_ic=abc' }, 400], [{ session: '' }, 401], [{ session: 'bad' }, 401], [{ method: 'GET' }, 405]]) {
    assert.equal((await run(req(input))).status, expected);
  }
  assert.equal(authCalls, 0);
  const denied = await run(req());
  assert.equal(denied.status, 403);
  assert.equal((await denied.text()).includes('private backend error'), false);
  assert.equal(cryptoCalls, 0);
  assert.equal((await handler({ enabled: false })(req())).status, 503);
  assert.equal((await handler({ authorize: async () => ({ phase: 'C' }) })(req())).status, 403);
  const badConfig = await handler({ cryptoConfig: () => { throw new Error('secret-value'); } })(req());
  assert.equal(badConfig.status, 503);
  assert.equal((await badConfig.text()).includes('secret-value'), false);
  assert.equal((await run(req({ method: 'OPTIONS' }))).status, 204);
});

test('Edge adapter forwards custom session only to fixed RPC; supports secret and legacy server keys', async () => {
  const oldDeno = globalThis.Deno, oldFetch = globalThis.fetch;
  const keys = config();
  const env = {
    ORL_IC_READINESS_ENABLED: 'true', SUPABASE_URL: 'https://synthetic-project.supabase.co',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_SYNTHETIC_TEST_ONLY' }),
    ORL_IC_CONTEXT: keys.context, ORL_IC_ACTIVE_ENCRYPTION_KEY: keys.activeEncryptionKey,
    ORL_IC_ACTIVE_SEARCH_KEY: keys.activeSearchKey, ORL_IC_ENCRYPTION_KEYS: JSON.stringify(keys.encryptionKeys),
    ORL_IC_SEARCH_KEYS: JSON.stringify(keys.searchKeys),
  };
  let serve, captured;
  try {
    globalThis.Deno = { env: { get: name => env[name] }, serve: fn => { serve = fn; } };
    globalThis.fetch = async (url, options) => {
      captured = { url: url.toString(), options };
      return Response.json({ phase: 'B', schema_version: 1, patient_encryption_active: false });
    };
    // Node 24 executes the same TypeScript adapter with native type stripping.
    await import('../../supabase/functions/ic-readiness/index.ts');
    assert.equal((await serve(req())).status, 200);
    assert.equal(captured.url, 'https://synthetic-project.supabase.co/rest/v1/rpc/orl_ic_foundation_probe');
    assert.deepEqual(JSON.parse(captured.options.body), { p_session_token: token });
    assert.equal(captured.options.headers.apikey, 'sb_secret_SYNTHETIC_TEST_ONLY');
    assert.equal(captured.options.headers.Authorization, undefined);
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.signal instanceof AbortSignal, true);
    delete env.SUPABASE_SECRET_KEYS;
    env.SUPABASE_SERVICE_ROLE_KEY = 'SYNTHETIC_LEGACY_KEY';
    assert.equal((await serve(req())).status, 200);
    assert.equal(captured.options.headers.Authorization, 'Bearer SYNTHETIC_LEGACY_KEY');
    globalThis.fetch = async () => new Response('Sensitive backend error', { status: 401 });
    const denied = await serve(req());
    assert.equal(denied.status, 403);
    assert.equal((await denied.text()).includes('Sensitive backend error'), false);
    env.SUPABASE_URL = 'http://synthetic-project.supabase.co';
    assert.equal((await serve(req())).status, 403);
  } finally { globalThis.Deno = oldDeno; globalThis.fetch = oldFetch; }
});

test('real PostgreSQL ciphertext round trip and HMAC lookup using synthetic values', {
  skip: !process.env.ORL_IC_TEST_PSQL,
}, async () => {
  // Only the disposable local runner may enable this test. Never read PGHOST.
  const port = process.env.ORL_IC_TEST_PORT;
  assert.equal(port, '55461');
  const sql = query => execFileSync(process.env.ORL_IC_TEST_PSQL,
    ['-X', '-h', '127.0.0.1', '-p', port, '-U', 'orl_test_owner', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
    { input: query, encoding: 'utf8' });
  const engine = await createIdentityCrypto(config()), encrypted = await engine.encrypt(raw, requestId);
  const search = await engine.searchHash(raw), query = await engine.searchHash('000101000000');
  // Values interpolated below are generated UUID/base64 only, not user input.
  const output = sql(`BEGIN;
    INSERT INTO public.orl_requests(id,request_number,patient_ic,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone)
    VALUES('${requestId}','SYNTHETIC-IC-TEST','000101000000','SYNTHETIC','Synthetic','TEST','TEST','Test','Test','Gen ORL','0');
    INSERT INTO orl_private.request_identity(request_id,envelope_version,encryption_key_id,nonce,ciphertext,search_key_id,search_hash,normalization_version)
    VALUES('${requestId}',1,'enc-v1',decode('${encrypted.nonce}','base64'),decode('${encrypted.ciphertext}','base64'),'search-v1',decode('${search.hash}','base64'),1);
    SELECT json_build_object('version',envelope_version,'key_id',encryption_key_id,'nonce',encode(nonce,'base64'),'ciphertext',encode(ciphertext,'base64'))
    FROM orl_private.request_identity WHERE search_key_id='search-v1' AND normalization_version=1 AND search_hash=decode('${query.hash}','base64');
    ROLLBACK;`);
  const record = JSON.parse(output.split('\n').find(line => line.startsWith('{')));
  assert.equal(await engine.decrypt(record, requestId), raw);
  assert.equal(sql('select count(*) from orl_private.request_identity;').trim(), '0');
});
