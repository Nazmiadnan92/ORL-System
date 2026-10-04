import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createIcRequestHandler } from '../../security/candidates/c1-create/handler.mjs';
import { createIdentityCrypto, toBase64 } from '../../supabase/functions/_shared/ic-crypto.mjs';
import { runCompatibilityTests } from './compatibility.mjs';
import { runReadTests } from './reads.mjs';
import { runGatewayTests } from './gateway-integration.mjs';
import { runRecoveryTests } from './recovery.mjs';
import { runReceiptBackupTests } from './receipt-backup.mjs';
import { runGenerationTests } from './generation.mjs';
import { runLegacyGateTests } from './legacy-gates.mjs';
import { runFullDumpRecoveryTests } from './full-dump-recovery.mjs';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const randomKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config = () => ({ context: 'c1-synthetic-only', activeEncryptionKey: 'enc-v1', activeSearchKey: 'search-v1',
  encryptionKeys: { 'enc-v1': randomKey() }, searchKeys: { 'search-v1': randomKey() } });
const data = overrides => ({ patient_ic: '000101-00-0000', age: '26', age_months: '6',
  patient_name: 'Synthetic Person', mrn: 'SYNTHETIC-' + crypto.randomUUID(), surgery: 'TEST PROCEDURE',
  diagnosis: 'TEST', doctor: 'test doctor', specialist: 'test specialist', sub_specialty: 'Gen ORL',
  phone: '0', remark: '', ...overrides });
const request = (body = { request_id: crypto.randomUUID(), data: data() }, overrides = {}) => {
  if(body && typeof body==='object' && !Array.isArray(body) && !Object.hasOwn(body,'generation'))
    body={...body,generation:token};
  const { query = '', ...options } = overrides;
  return new Request('https://example.invalid/ic-create' + query, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-orl-session': token, origin: 'https://nazmiadnan92.github.io' },
    body: JSON.stringify(body), ...options });
};
const handler = overrides => createIcRequestHandler({ enabled: true, origins: ['https://nazmiadnan92.github.io'],
  authorize: async () => true, cryptoConfig: config, commit: async p => p.p_request_id, ...overrides });

test('C1 is disabled by default; no authentication or write work starts', async () => {
  const run = createIcRequestHandler({ origins: [], authorize() { assert.fail('not called'); } });
  const response = await run(request(undefined, { headers: {} }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('creation encrypts before atomic commit, preserves data and returns UUID only', async () => {
  const keys = config(), body = { request_id: crypto.randomUUID(), data: data({ patient_ic: '  AB-123  ' }) };
  let captured;
  const run = handler({ cryptoConfig: () => keys, commit: async p => { captured = p; return p.p_request_id; } });
  const response = await run(request(body));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { request_id: body.request_id });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const engine = await createIdentityCrypto(keys);
  assert.equal(await engine.decrypt(captured.p_envelope, body.request_id), 'AB-123');
  assert.deepEqual(captured.p_search, await engine.searchHash('ab123'));
  assert.equal(captured.p_data.patient_ic, 'AB-123');
  assert.equal(captured.p_data.mrn, body.data.mrn);
  assert.equal(captured.p_session_token, token);
});

test('optional IC absent has no identity, with manual years/months intact', async () => {
  let captured;
  const response = await handler({ commit: async p => { captured = p; return p.p_request_id; } })(
    request({ request_id: crypto.randomUUID(), data: data({ patient_ic: '', age: '0', age_months: '6' }) }));
  assert.equal(response.status, 200);
  assert.equal(captured.p_envelope, null);
  assert.equal(captured.p_search, null);
  assert.equal(captured.p_data.age_months, '6');
});

test('origin, session, method, query and authorization checks fail closed without crypto', async () => {
  let auth = 0, crypt = 0, writes = 0;
  const run = handler({ authorize: async () => { auth++; return false; },
    cryptoConfig: () => { crypt++; return config(); }, commit: () => { writes++; } });
  for (const [req, status] of [
    [request(undefined, { headers: { origin: 'https://evil.invalid' } }), 403],
    [request(undefined, { headers: {} }), 401],
    [request(undefined, { query: '?ic=not-allowed' }), 400],
    [request(undefined, { method: 'GET', body: undefined }), 405],
    [request(undefined, { headers: { 'x-orl-session': 'bad' } }), 401],
  ]) assert.equal((await run(req)).status, status);
  assert.equal(auth, 0);
  assert.equal((await run(request())).status, 403);
  assert.equal(auth, 1); assert.equal(crypt, 0); assert.equal(writes, 0);
  const hidden = await handler({ authorize: async () => { throw new Error('private details'); } })(request());
  assert.equal(hidden.status, 403); assert.equal((await hidden.text()).includes('private details'), false);
});

test('strict input, size and IC validation reject tampered identity/role/status fields', async () => {
  let writes = 0;
  const run = handler({ commit: () => { writes++; assert.fail('invalid input must not write'); } });
  const base = { request_id: crypto.randomUUID(), data: data() };
  for (const body of [null, [], {}, { ...base, request_id: 'bad' }, { ...base, generation: null },
    { ...base, generation: 'bad' }, { ...base, role: 'WEBMASTER' },
    { ...base, envelope: {} }, { ...base, data: [] },
    ...['status', 'id', 'created_by', 'assigned_slot_id', 'booked_by_name', 'patient_ic_hash', '__proto__']
      .map(key => ({ ...base, data: { ...base.data, [key]: 'injected' } })),
    ...[null, 123, '---', '\nABC', '名字', 'A'.repeat(129)]
      .map(patient_ic => ({ ...base, data: { ...base.data, patient_ic } })),
  ]) assert.equal((await run(request(body))).status, 400);
  assert.equal((await run(request(base, { body: '{' }))).status, 400);
  assert.equal((await run(request(base, { body: ' '.repeat(17000) }))).status, 400);
  assert.equal((await run(request(base, { headers: { 'x-orl-session': token, 'Content-Type': 'text/plain' } }))).status, 400);
  const stalled = new Request('https://example.invalid/ic-create', { method: 'POST',
    headers: { 'x-orl-session': token, 'content-type': 'application/json' },
    body: new ReadableStream({ start() {} }), duplex: 'half' });
  assert.equal((await run(stalled)).status, 400);
  assert.equal(writes, 0);
});

test('missing keys never cause plaintext fallback, including optional blank IC', async () => {
  let writes = 0;
  const run = handler({ cryptoConfig: () => { throw new Error('PRIVATE SECRET'); }, commit: () => { writes++; } });
  for (const patient_ic of ['', 'TEST123']) {
    const response = await run(request({ request_id: crypto.randomUUID(), data: data({ patient_ic }) }));
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('PRIVATE SECRET'), false);
  }
  assert.equal(writes, 0);
});

test('unknown commit outcome never retries and does not leak database errors', async () => {
  let calls = 0;
  const response = await handler({ commit: async () => { calls++; throw new Error('PRIVATE DATABASE VALUE'); } })(request());
  assert.equal(response.status, 503); assert.equal(calls, 1);
  const text = await response.text();
  assert.match(text, /Check Previous Save/); assert.equal(text.includes('PRIVATE DATABASE VALUE'), false);
  assert.equal((await handler({ commit: async () => 'wrong-id' })(request())).status, 503);
});

test('local PostgreSQL: roles, clinical parity, atomic rollback, duplicate race and remaining rollout blockers', {
  skip: !process.env.ORL_IC_TEST_PSQL,
}, async t => {
  assert.equal(process.env.ORL_IC_TEST_PORT, '55461');
  const args = ['-X', '-qAt', '-h', '127.0.0.1', '-p', '55461', '-U', 'orl_test_owner', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
  const sql = query => execFileSync(process.env.ORL_IC_TEST_PSQL, args, { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const parallelSql = query => new Promise(resolve => {
    const child = execFile(process.env.ORL_IC_TEST_PSQL, args, { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end(query);
  });
  const literal = value => value == null ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
  const json = value => value == null ? 'NULL' : literal(JSON.stringify(value)) + '::jsonb';
  const migration = readFileSync(new URL('../../supabase/040_age_months_doctor_names.sql', import.meta.url), 'utf8').replaceAll('\r', '');
  const original = migration.split('create or replace function public.orl_create_request(p_session_token uuid,p_data jsonb)')[1].split('as $$')[1].split('end $$;')[0] + 'end ';
  const previousFunctions = sql("select jsonb_object_agg(oid::text,jsonb_build_array(prosrc,proacl,proconfig)) from pg_proc where pronamespace='public'::regnamespace");
  const previousRequests = sql('select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r');
  // candidate.sql itself refuses non-local environments; no production connections.
  sql('create temp table c1_test_baseline(body text); insert into c1_test_baseline values(' + literal(original) + ');\n'
    + readFileSync(new URL('./candidate.sql', import.meta.url), 'utf8'));
  const afterFunctions = JSON.parse(sql("select jsonb_object_agg(oid::text,jsonb_build_array(prosrc,proacl,proconfig)) from pg_proc where pronamespace='public'::regnamespace"));
  for (const [oid, value] of Object.entries(JSON.parse(previousFunctions))) assert.deepEqual(afterFunctions[oid], value);
  assert.equal(sql('select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r'), previousRequests);
  assert.equal(sql('select count(*) from orl_private.request_identity'), '0');
  const users = { WEBMASTER: crypto.randomUUID(), ADMIN: crypto.randomUUID(), STAFF: crypto.randomUUID() };
  for (const [role, id] of Object.entries(users)) sql(`insert into public.orl_users(id,username,password_hash,display_name,role)
    values(${literal(id)},${literal('c1_' + role.toLowerCase())},'unused-synthetic-hash','Synthetic Booker',${literal(role)});
    insert into public.orl_sessions(user_id,token_hash,expires_at) values(${literal(id)},encode(extensions.digest(${literal(id)},'sha256'),'hex'),now()+interval '1 hour');`);
  const keys = config(), engine = await createIdentityCrypto(keys);
  const payload = async (role = 'STAFF', overrides = {}) => {
    const id = crypto.randomUUID(), d = data(overrides), raw = d.patient_ic.trim();
    return { p_session_token: users[role], p_request_id: id, p_data: d,
      p_generation:sql('select generation from orl_private.c1_restore_generation'),
      p_envelope: raw ? await engine.encrypt(raw, id) : null, p_search: raw ? await engine.searchHash(raw) : null };
  };
  const call = p => `select public.orl_ic_c1_create(${literal(p.p_session_token)},${literal(p.p_request_id)},${json(p.p_data)},${json(p.p_envelope)},${json(p.p_search)},${literal(p.p_generation)});`;
  const commit = p => sql('set role service_role; ' + call(p));
  const count = () => sql('select (select count(*) from public.orl_requests)||\',\'||(select count(*) from orl_private.request_identity)||\',\'||(select count(*) from public.orl_audit_log)');

  await t.test('ordinary users cannot call backend RPC or read identities; service has no direct table rights', () => {
    for (const role of ['anon', 'authenticated']) assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_create(uuid,uuid,jsonb,jsonb,jsonb,uuid)','EXECUTE')`), 'f');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(sql(`select has_schema_privilege('${role}','orl_private','USAGE') or has_table_privilege('${role}','orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE')`), 'f');
      assert.throws(() => sql(`set role ${role}; select * from orl_private.request_identity`));
    }
  });
  const saved = [];
  await t.test('Staff/Admin/Webmaster can create with clinical validation, age and booking name preserved', async () => {
    for (const role of Object.keys(users)) {
      const p = await payload(role); assert.equal(commit(p), p.p_request_id); saved.push(p);
      const record = JSON.parse(sql(`select jsonb_build_object('version',envelope_version,'key_id',encryption_key_id,
        'nonce',encode(nonce,'base64'),'ciphertext',replace(encode(ciphertext,'base64'),chr(10),'')) from orl_private.request_identity where request_id=${literal(p.p_request_id)}`));
      assert.equal(await engine.decrypt(record, p.p_request_id), p.p_data.patient_ic);
      const patient = JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${literal(p.p_request_id)}`));
      assert.equal(patient.doctor, 'Test Doctor'); assert.equal(patient.specialist, 'Test Specialist');
      assert.equal(patient.booked_by_name, 'Synthetic Booker'); assert.equal(patient.created_by, users[role]);
      assert.equal(patient.age, JSON.parse(sql("select public.orl_age_parts('000101-00-0000',current_date)")).years);
      assert.equal(patient.status, 'DRAFT');
      assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${literal(p.p_request_id)} and details like '%000101%'`), '0');
    }
    const h = await engine.searchHash('000101000000');
    assert.equal(sql(`select count(*) from orl_private.request_identity where search_hash=decode(${literal(h.hash)},'base64')`), '3');
  });
  await t.test('blank IC supports six-month infant without creating an identity', async () => {
    const p = await payload('STAFF', { patient_ic: '', age: '0', age_months: '6' });
    commit(p);
    assert.equal(sql(`select age||','||age_months from public.orl_requests where id=${literal(p.p_request_id)}`), '0,6');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id=${literal(p.p_request_id)}`), '0');
  });
  await t.test('bad envelope, nonce collision, missing fields and duplicate ID roll back request AND audits', async () => {
    const before = count();
    const p = await payload();
    for (const broken of [
      { ...p, p_envelope: null }, { ...p, p_envelope: { ...p.p_envelope, nonce: 'AA==' } },
      { ...p, p_search: { ...p.p_search, hash: 'AA==' } },
      { ...p, p_envelope: { ...p.p_envelope, nonce: saved[0].p_envelope.nonce } },
      { ...p, p_data: { ...p.p_data, mrn: '' } },
      { ...p, p_data: { ...p.p_data, patient_ic: '', age: '0', age_months: '12' }, p_envelope: null, p_search: null },
      { ...p, p_request_id: saved[0].p_request_id },
    ]) { assert.throws(() => commit(broken)); assert.equal(count(), before); }
  });
  await t.test('invalid, expired, disabled and required-password-change sessions rejected at commit', async () => {
    const p = await payload(), before = count();
    for (const bad of [null, crypto.randomUUID()]) assert.throws(() => commit({ ...p, p_session_token: bad }));
    for (const [change, restore] of [
      ['must_change_password=true', 'must_change_password=false'], ['is_active=false', 'is_active=true'],
    ]) {
      sql(`update public.orl_users set ${change} where id=${literal(users.STAFF)}`);
      assert.throws(() => commit(p));
      sql(`update public.orl_users set ${restore} where id=${literal(users.STAFF)}`);
    }
    sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${literal(users.STAFF)}`);
    assert.throws(() => commit(p));
    sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${literal(users.STAFF)}`);
    assert.equal(count(), before);
  });
  await t.test('MRN/procedure duplicate race allows only one request; WM override needs reason', async () => {
    const mrn = 'RACE-' + crypto.randomUUID();
    const a = await payload('STAFF', { mrn }), b = await payload('STAFF', { mrn });
    const result = await Promise.all([a, b].map(p => parallelSql('set role service_role; ' + call(p))));
    assert.equal(result.filter(r => !r.error).length, 1);
    assert.equal(sql(`select count(*) from public.orl_requests where mrn=${literal(mrn)}`), '1');
    assert.throws(() => commit({ ...b, p_data: { ...b.p_data, allow_duplicate: true, duplicate_reason: 'TEST' } }));
    const override = await payload('WEBMASTER', { mrn, allow_duplicate: true });
    assert.throws(() => commit(override));
    override.p_data.duplicate_reason = 'Synthetic override';
    assert.equal(commit(override), override.p_request_id);
  });
  await t.test('HTTP to real SQL saves a bound identity; revocation between authorization and commit blocks', async () => {
    const run = handler({ cryptoConfig: () => keys, commit: async p => commit(p) });
    const body = { request_id: crypto.randomUUID(), generation:sql('select generation from orl_private.c1_restore_generation'), data: data() };
    const options = { headers: { 'x-orl-session': users.STAFF, 'Content-Type': 'application/json' } };
    assert.equal((await run(request(body, options))).status, 200);
    const before = count();
    const revoked = handler({ cryptoConfig: () => keys, authorize: async () => {
      sql(`update public.orl_users set must_change_password=true where id=${literal(users.STAFF)}`); return true;
    }, commit: async p => commit(p) });
    assert.equal((await revoked(request({ ...body, request_id: crypto.randomUUID(), data: data() }, options))).status, 503);
    assert.equal(count(), before);
    sql(`update public.orl_users set must_change_password=false where id=${literal(users.STAFF)}`);
  });
  await t.test('rollout blockers demonstrated: legacy edit can stale shadow; FK prevents legacy deletion', async () => {
    const p = saved[0];
    // Deliberately prove why this local candidate must NOT be activated in production.
    const unchanged = sql(`select encode(ciphertext,'hex') from orl_private.request_identity where request_id=${literal(p.p_request_id)}`);
    const otId = crypto.randomUUID(), slotId = crypto.randomUUID();
    sql(`begin;
      insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(otId)},'2099-01-04','Sunday');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status)
        values(${literal(slotId)},${literal(otId)},'MAIN',1,${literal(p.p_request_id)},'CONFIRMED');
      update public.orl_requests set assigned_slot_id=${literal(slotId)},status='SCHEDULED' where id=${literal(p.p_request_id)};
      set local role anon;
      select public.orl_edit_scheduled_request_checked(${literal(users.WEBMASTER)},${literal(slotId)},
        '{"patient_ic":"SYNTHETIC-CHANGED","age":"26","age_months":"6"}'::jsonb,'CONFIRM',${literal(p.p_request_id)});
      reset role;
      do $$ begin if (select encode(ciphertext,'hex') from orl_private.request_identity where request_id=${literal(p.p_request_id)}) <> ${literal(unchanged)}
        then raise exception 'Unexpected existing IC hook'; end if;
        if (select patient_ic from public.orl_requests where id=${literal(p.p_request_id)}) <> 'SYNTHETIC-CHANGED'
          then raise exception 'Legacy edit did not run'; end if;
        end $$; rollback;`);
    assert.throws(() => sql(`delete from public.orl_requests where id=${literal(p.p_request_id)}`));
    const exporter = sql("select prosrc from pg_proc where oid='public.orl_db_export(uuid,text)'::regprocedure");
    assert.equal(exporter.includes('request_identity'), false);
  });
  await runCompatibilityTests({ t, sql, parallelSql, literal, json, keys, engine, users, payload, commit });
  await runReadTests({ t, sql, literal, users, payload, commit });
  await runGatewayTests({ t, sql, parallelSql, literal, json, users, keys, payload });
  await runRecoveryTests({ t, sql, parallelSql, literal, json, users, payload, commit });
  await runReceiptBackupTests({ t, sql, literal, json, users, keys, payload, commit });
  await runGenerationTests({ t, sql, literal, json, users, payload, commit });
  await runLegacyGateTests({ t, sql, literal, json, users, payload, commit });
  await runFullDumpRecoveryTests({ t, sql, literal, json, users, payload, commit });
});
