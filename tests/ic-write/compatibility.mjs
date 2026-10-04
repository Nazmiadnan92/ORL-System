import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { prepareIdentityChange, verifyIdentityBackup } from '../../security/candidates/c1-create/compatibility.mjs';

export async function runCompatibilityTests({ t, sql, parallelSql, literal, json, keys, engine, users, payload, commit }) {
  sql(readFileSync(new URL('./compatibility.sql', import.meta.url), 'utf8'));
  // Random test-only password for disposable accounts, never an operator credential.
  const password = crypto.randomUUID();
  sql(`update public.orl_users set password_hash=extensions.crypt(${literal(password)},extensions.gen_salt('bf',4)) where username like 'c1_%'`);
  let nextDate = 1;
  function slot(type = 'MAIN') {
    const session = crypto.randomUUID(), id = crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(session)},date '2098-01-01'+${nextDate++},'Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${literal(id)},${literal(session)},${literal(type)},1,'AVAILABLE');`);
    return id;
  }
  async function booked(role = 'ADMIN') {
    const p = await payload(role); commit(p); const s = slot();
    sql(`update public.orl_ot_slots set request_id=${literal(p.p_request_id)},status='CONFIRMED' where id=${literal(s)};
      update public.orl_requests set assigned_slot_id=${literal(s)},status='SCHEDULED' where id=${literal(p.p_request_id)}`);
    return { p, s };
  }
  const identity = id => JSON.parse(sql(`select jsonb_build_object('version',envelope_version,'key_id',encryption_key_id,
    'nonce',encode(nonce,'base64'),'ciphertext',replace(encode(ciphertext,'base64'),chr(10),'')) from orl_private.request_identity where request_id=${literal(id)}`) || 'null');
  const snapshot = () => sql(`select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),
    'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),
    'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),
    'receipts',(select jsonb_agg(to_jsonb(c) order by request_id) from orl_private.c1_creation_receipts c),
    'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a))`);
  function mutation({ who = 'ADMIN', operation = 'EDIT', from, to = null, id, data = {}, action = 'CONFIRM', reason = '', mode = 'KEEP', envelope = null, search = null, expectedVersion }) {
    expectedVersion??=sql(`select updated_at from public.orl_requests where id=${literal(id)}`);
    return `select public.orl_ic_c1_mutate(${literal(users[who])},${literal(operation)},${literal(from)},${literal(to)},${literal(id)},
      ${json(data)},${literal(action)},${literal(reason)},${literal(mode)},${json(envelope)},${json(search)},${literal(sql('select generation from orl_private.c1_restore_generation'))},${literal(expectedVersion)});`;
  }
  const mutate = p => sql('set role service_role; ' + mutation(p));
  const prepare = (id, raw) => prepareIdentityChange({ mode: 'SET', data: { patient_ic: raw }, requestId: id, cryptoConfig: keys });
  const exportSql = (who = 'WEBMASTER', pw = password) => `select public.orl_ic_c1_export(${literal(users[who])},${literal(pw)})`;
  const exportBackup = () => JSON.parse(sql('set role service_role; ' + exportSql()));
  const importSql = (backup, who = 'WEBMASTER', pw = password) => `select public.orl_ic_c1_import(${literal(users[who])},${literal(pw)},${json(backup)})`;

  await t.test('compatibility endpoints remain service-only; permit table has no client/service grants', () => {
    const signatures = ['orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)',
      'orl_ic_c1_remove(uuid,text,text,text,uuid,uuid[])', 'orl_ic_c1_export(uuid,text)', 'orl_ic_c1_import(uuid,text,jsonb)'];
    for (const fn of signatures) for (const role of ['anon', 'authenticated'])
      assert.equal(sql(`select has_function_privilege('${role}','public.${fn}','EXECUTE')`), 'f');
    for (const role of ['anon', 'authenticated', 'service_role'])
      assert.equal(sql(`select has_table_privilege('${role}','orl_private.c1_write_permit','SELECT,INSERT,UPDATE,DELETE')`), 'f');
  });

  await t.test('manual postpone count is Webmaster EDIT-only, range checked, atomic with clinical and identity writes', async () => {
    const {p,s}=await booked();
    const change=await prepare(p.p_request_id,'SYNTHETIC-COUNT-IC');
    for(const count of ['999','0']) {
      mutate({who:'WEBMASTER',from:s,id:p.p_request_id,data:{diagnosis:'COUNT TEST',postpone_count:count}});
      assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(p.p_request_id)}`),count);
    }
    const before=snapshot();
    for(const who of ['STAFF','ADMIN'])
      assert.throws(()=>mutate({who,from:s,id:p.p_request_id,data:{diagnosis:'DENIED',postpone_count:'2'}}),/Webmaster/);
    for(const count of ['',null,2,'-1','1.5','1000','1e2',' 2'])
      assert.throws(()=>mutate({who:'WEBMASTER',from:s,id:p.p_request_id,data:{diagnosis:'DENIED',postpone_count:count}}),/0-999/);
    assert.throws(()=>mutate({who:'WEBMASTER',operation:'MOVE',from:s,to:s,id:p.p_request_id,data:{postpone_count:'2'}}),/through Edit/);
    assert.equal(snapshot(),before);
    // Failure at the last write must roll back earlier clinical, IC and audit work.
    sql(`create function public.c1_test_count_failure() returns trigger language plpgsql as $$begin
      if new.id=${literal(p.p_request_id)}::uuid and new.postpone_count=7 then raise exception 'Synthetic count failure'; end if;
      return new; end $$;
      create trigger c1_test_count_failure before update of postpone_count on public.orl_requests
      for each row execute function public.c1_test_count_failure()`);
    try {
      assert.throws(()=>mutate({who:'WEBMASTER',from:s,id:p.p_request_id,mode:'SET',...change,
        data:{...change.data,diagnosis:'MUST ROLL BACK',postpone_count:'7'}}),/Synthetic count failure/);
      assert.equal(snapshot(),before);
    } finally {sql('drop trigger c1_test_count_failure on public.orl_requests; drop function public.c1_test_count_failure()')}
    mutate({who:'WEBMASTER',from:s,id:p.p_request_id,mode:'SET',...change,
      data:{...change.data,diagnosis:'COUNT SAVED',postpone_count:'7'}});
    assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(p.p_request_id)}`),'7');
    assert.equal(await engine.decrypt(identity(p.p_request_id),p.p_request_id),'SYNTHETIC-COUNT-IC');
    assert.equal(sql(`select count(*) from public.orl_audit_log where action='POSTPONE_COUNT_UPDATED' and record_id=${literal(p.p_request_id)}`),'3');
  });

  await t.test('KEEP omits IC; masked value rejected; SET re-encrypts bound to correct request', async () => {
    const { p, s } = await booked(); const before = identity(p.p_request_id);
    await assert.rejects(prepareIdentityChange({ mode: 'KEEP', data: { patient_ic: '******1234' }, requestId: p.p_request_id }));
    await assert.rejects(prepare(p.p_request_id, '******1234'));
    const keep = await prepareIdentityChange({ mode: 'KEEP', data: { diagnosis: 'CHANGED' }, requestId: p.p_request_id });
    mutate({ from: s, id: p.p_request_id, ...keep });
    assert.deepEqual(identity(p.p_request_id), before);
    const change = await prepare(p.p_request_id, 'SYNTHETIC-PASSPORT-222');
    mutate({ from: s, id: p.p_request_id, mode: 'SET', ...change });
    assert.equal(await engine.decrypt(identity(p.p_request_id), p.p_request_id), 'SYNTHETIC-PASSPORT-222');
    assert.equal(sql('select count(*) from orl_private.c1_write_permit'), '0');
    const search = await engine.searchHash('syntheticpassport222');
    assert.equal(sql(`select search_hash=decode(${literal(search.hash)},'base64') from orl_private.request_identity where request_id=${literal(p.p_request_id)}`), 't');
  });

  await t.test('same-record revision rejects stale Edit/Move and lets only one concurrent Edit commit',async()=>{
    const {p,s}=await booked(),dest=slot();
    const opened=sql(`select updated_at from public.orl_requests where id=${literal(p.p_request_id)}`);
    sql(`update public.orl_requests set diagnosis='INTERVENING CHANGE',updated_at=clock_timestamp() where id=${literal(p.p_request_id)}`);
    const before=snapshot();
    assert.throws(()=>mutate({from:s,id:p.p_request_id,expectedVersion:opened,data:{diagnosis:'STALE EDIT'}}),/record changed/);
    assert.throws(()=>mutate({operation:'MOVE',from:s,to:dest,id:p.p_request_id,expectedVersion:opened,reason:'Stale move'}),/record changed/);
    assert.equal(snapshot(),before);
    const current=sql(`select updated_at from public.orl_requests where id=${literal(p.p_request_id)}`);
    const attempts=await Promise.all(['FIRST','SECOND'].map(diagnosis=>parallelSql('set role service_role;'+mutation({
      from:s,id:p.p_request_id,expectedVersion:current,data:{diagnosis}}))));
    assert.equal(attempts.filter(x=>!x.error).length,1);
    assert.equal(['FIRST','SECOND'].includes(sql(`select diagnosis from public.orl_requests where id=${literal(p.p_request_id)}`)),true);
  });

  await t.test('legacy plaintext edit blocked on protected records; routine unchanged edit remains valid', async () => {
    const { p, s } = await booked(); const before = snapshot();
    assert.throws(() => sql(`set role anon; select public.orl_edit_scheduled_request_checked(${literal(users.ADMIN)},${literal(s)},
      '{"patient_ic":"ATTEMPT"}'::jsonb,'CONFIRM',${literal(p.p_request_id)})`));
    assert.equal(snapshot(), before);
    sql(`set role anon; select public.orl_edit_scheduled_request_checked(${literal(users.ADMIN)},${literal(s)},
      '{"diagnosis":"UNCHANGED IC"}'::jsonb,'CONFIRM',${literal(p.p_request_id)})`);
    assert.equal(await engine.decrypt(identity(p.p_request_id), p.p_request_id), p.p_data.patient_ic);
  });

  await t.test('stale patient, Staff IC changes and bad envelope roll back clinical/identity/audit changes', async () => {
    const { p, s } = await booked('STAFF'); const change = await prepare(p.p_request_id, 'NEW-IC-123'); const before = snapshot();
    for (const input of [
      { from: s, id: crypto.randomUUID(), mode: 'SET', ...change },
      { from: s, id: p.p_request_id, who: 'STAFF', mode: 'SET', ...change },
      { from: s, id: p.p_request_id, mode: 'SET', ...change, envelope: { ...change.envelope, nonce: 'AA==' } },
      { from: s, id: p.p_request_id, data: { patient_ic: '******1234' } },
    ]) { assert.throws(() => mutate(input)); assert.equal(snapshot(), before); }
    mutate({ from: s, id: p.p_request_id, who: 'STAFF', data: { diagnosis: 'STAFF CLINICAL EDIT', mrn: 'IGNORED' } });
    assert.equal(sql(`select mrn from public.orl_requests where id=${literal(p.p_request_id)}`), p.p_data.mrn);
    assert.equal(sql('select count(*) from orl_private.c1_write_permit'), '0');
  });

  await t.test('postpone to Special keeps permission rules and updates both slot links plus shadow atomically', async () => {
    const { p, s } = await booked('STAFF'), dest = slot('SPECIAL');
    const before = snapshot();
    assert.throws(() => mutate({ from: s, to: dest, id: p.p_request_id, who: 'STAFF', operation: 'MOVE' }));
    assert.equal(snapshot(), before);
    const change = await prepare(p.p_request_id, 'POSTPONED-IC-333');
    mutate({ from: s, to: dest, id: p.p_request_id, operation: 'MOVE', reason: 'Synthetic move', mode: 'SET', ...change });
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(p.p_request_id)}`), dest);
    assert.equal(sql(`select request_id from public.orl_ot_slots where id=${literal(dest)}`), p.p_request_id);
    assert.equal(await engine.decrypt(identity(p.p_request_id), p.p_request_id), 'POSTPONED-IC-333');
  });

  await t.test('two requests racing for same destination leave exactly one committed identity change', async () => {
    const a = await booked(), b = await booked(), dest = slot();
    const changes = await Promise.all([a, b].map(x => prepare(x.p.p_request_id, 'RACE-NEW-' + x.p.p_request_id)));
    const outcomes = await Promise.all([a, b].map((x, i) => parallelSql('set role service_role; ' + mutation({
      from: x.s, to: dest, id: x.p.p_request_id, operation: 'MOVE', mode: 'SET', ...changes[i] }))));
    assert.equal(outcomes.filter(x => !x.error).length, 1);
    for (const [i, x] of [a, b].entries()) assert.equal(await engine.decrypt(identity(x.p.p_request_id), x.p.p_request_id),
      outcomes[i].error ? x.p.p_data.patient_ic : changes[i].data.patient_ic);
    assert.equal(sql('select count(*) from orl_private.c1_write_permit'), '0');
  });

  await t.test('explicit optional IC clear removes shadow but preserves manual infant age', async () => {
    const { p, s } = await booked(); const change = await prepare(p.p_request_id, '');
    change.data.age = '0'; change.data.age_months = '6';
    mutate({ from: s, id: p.p_request_id, mode: 'SET', ...change });
    assert.equal(identity(p.p_request_id), null);
    assert.equal(sql(`select patient_ic||':'||age||':'||age_months from public.orl_requests where id=${literal(p.p_request_id)}`), ':0:6');
  });

  await t.test('permanent removal remains Webmaster/password only, removes shadow and releases slot', async () => {
    const { p, s } = await booked(); const before = snapshot();
    const remove = (who, pw) => sql(`set role service_role; select public.orl_ic_c1_remove(${literal(users[who])},${literal(pw)},'REQUEST',${literal(p.p_request_id)},${literal(sql('select generation from orl_private.c1_restore_generation'))},array[${literal(p.p_request_id)}]::uuid[])`);
    assert.throws(() => remove('ADMIN', password)); assert.throws(() => remove('WEBMASTER', 'wrong'));
    assert.equal(snapshot(), before);
    assert.equal(remove('WEBMASTER', password), '1');
    assert.equal(identity(p.p_request_id), null);
    assert.equal(sql(`select status from public.orl_ot_slots where id=${literal(s)}`), 'AVAILABLE');
    assert.equal(sql(`select count(*) from public.orl_requests where id=${literal(p.p_request_id)}`), '0');
  });

  await t.test('removal failure restores identity; MRN removal cleans exactly the selected records', async () => {
    const a = await booked(), b = await booked();
    const mrn = 'SYNTHETIC-REMOVE-' + crypto.randomUUID();
    sql(`update public.orl_requests set mrn=${literal(mrn)} where id in(${literal(a.p.p_request_id)},${literal(b.p.p_request_id)});
      create function orl_private.c1_test_delete_failure() returns trigger language plpgsql as $$ begin raise exception 'Synthetic deletion failure'; end $$;
      create trigger c1_test_delete_failure before delete on public.orl_requests for each row execute function orl_private.c1_test_delete_failure();`);
    const before = snapshot();
    const query = `set role service_role; select public.orl_ic_c1_remove(${literal(users.WEBMASTER)},${literal(password)},'MRN',${literal(mrn)},${literal(sql('select generation from orl_private.c1_restore_generation'))},array[${literal(a.p.p_request_id)},${literal(b.p.p_request_id)}]::uuid[])`;
    assert.throws(() => sql(query)); assert.equal(snapshot(), before);
    sql('drop trigger c1_test_delete_failure on public.orl_requests; drop function orl_private.c1_test_delete_failure()');
    assert.equal(sql(query), '2');
    assert.equal(identity(a.p.p_request_id), null); assert.equal(identity(b.p.p_request_id), null);
    assert.equal(sql(`select count(*) from public.orl_requests where mrn=${literal(mrn)}`), '0');
  });

  let backup;
  await t.test('version-2 backup covers all shadows, has no key material, and verifies with retained keys', async () => {
    assert.throws(() => sql('set role service_role; ' + exportSql('STAFF')));
    assert.throws(() => sql('set role service_role; ' + exportSql('WEBMASTER', 'wrong')));
    backup = exportBackup();
    assert.equal(backup.version, 2);
    assert.equal(backup.identities.length, Number(sql('select count(*) from orl_private.request_identity')));
    assert.ok(backup.identities.length > 0);
    for (const key of [...Object.values(keys.encryptionKeys), ...Object.values(keys.searchKeys)]) assert.equal(JSON.stringify(backup).includes(key), false);
    assert.deepEqual(await verifyIdentityBackup(backup, keys), backup);
    const rotated = { ...keys, activeEncryptionKey: 'enc-v2', activeSearchKey: 'search-v2',
      encryptionKeys: { ...keys.encryptionKeys, 'enc-v2': btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) },
      searchKeys: { ...keys.searchKeys, 'search-v2': btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))) } };
    assert.deepEqual(await verifyIdentityBackup(backup, rotated), backup);
  });

  await t.test('corruption, lost key, duplicate/orphan/omitted identity and version-1 backups fail before submission', async () => {
    const variants = [];
    function changed(fn) { const b = structuredClone(backup); fn(b); variants.push(b); }
    changed(b => b.identities[0].envelope.ciphertext = 'AA==');
    changed(b => b.identities[0].search.hash = btoa(String.fromCharCode(...new Uint8Array(32))));
    changed(b => b.identities[0].envelope.key_id = 'lost-key');
    changed(b => b.requests.find(r => r.id === b.identities[0].request_id).patient_ic = 'MISMATCH');
    changed(b => b.identities.push(b.identities[0]));
    changed(b => b.identities[0].request_id = crypto.randomUUID());
    changed(b => b.identities.shift());
    changed(b => b.version = 1);
    changed(b => delete b.audit_log);
    changed(b => delete b.creation_receipts);
    changed(b => b.creation_receipts.push(b.creation_receipts[0]));
    changed(b => b.creation_receipts[0].owner_id = 'invalid');
    changed(b => b.creation_receipts.find(c=>b.requests.some(r=>r.id===c.request_id)).outcome = 'CANCELLED');
    changed(b => b.creation_receipts = []);
    changed(b => b.requests[0].creation_tracked = 'true');
    for (const b of variants) await assert.rejects(verifyIdentityBackup(b, keys));
    await assert.rejects(verifyIdentityBackup(backup, { ...keys, encryptionKeys: {} }));
    const original = structuredClone(backup), inFlight = verifyIdentityBackup(original, keys);
    original.identities = []; original.requests = [];
    assert.deepEqual(await inFlight, backup);
  });

  await t.test('SQL import rejects bad sections/links/envelopes and rolls back deletions before restore', async () => {
    const before = snapshot();
    const variants = [];
    for (const mutateBackup of [b => b.version = 1, b => b.identities.shift(), b => delete b.settings,
      b => delete b.creation_receipts, b => b.creation_receipts = [], b => b.creation_receipts.push(b.creation_receipts[0]),
      b => b.identities[0].envelope.nonce = 'AA==', b => b.ot_slots.find(s => s.request_id).request_id = crypto.randomUUID()]) {
      const b = structuredClone(backup); mutateBackup(b); variants.push(b);
    }
    for (const b of variants) { assert.throws(() => sql('set role service_role; ' + importSql(b))); assert.equal(snapshot(), before); }
    assert.throws(() => sql('set role service_role; ' + importSql(backup, 'ADMIN')));
    assert.throws(() => sql('set role service_role; ' + importSql(backup, 'WEBMASTER', 'wrong')));
    assert.equal(snapshot(), before);
  });

  await t.test('backup/restore fail busy during a writer or maintenance lock, without partial changes', async () => {
    for(const lock of ['public.orl_requests in row exclusive mode','orl_private.request_identity in share update exclusive mode']){
    const child = spawn(process.env.ORL_IC_TEST_PSQL, ['-X', '-qAt', '-h', '127.0.0.1', '-p', '55461',
      '-U', 'orl_test_owner', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let timer;
    const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Synthetic lock holder failed'))); });
    // Attach rejection handler immediately, even if readiness fails first.
    closed.catch(() => {});
    try {
      const ready = new Promise((resolve, reject) => {
        let output = '';
        child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('C1_LOCK_HELD')) resolve(); });
        child.on('error', reject);
        timer = setTimeout(() => reject(new Error('Synthetic lock holder not ready')), 5000);
      });
      child.stdin.write("begin; lock table "+lock+"; select 'C1_LOCK_HELD';\n");
      await ready; clearTimeout(timer);
      const before = snapshot();
      assert.throws(() => exportBackup());
      assert.throws(() => sql('set role service_role; ' + importSql(backup)));
      assert.equal(snapshot(), before);
    } finally {
      clearTimeout(timer); child.stdin.end('rollback;\n'); await closed;
    }
    }
  });

  await t.test('verified backup restores records, infant months, booking names and every decrypted IC', async () => {
    const verified = await verifyIdentityBackup(backup, keys);
    const result = JSON.parse(sql('set role service_role; ' + importSql(verified)));
    assert.equal(result.identities, backup.identities.length);
    assert.equal(result.requests, backup.requests.length);
    const after = exportBackup();
    assert.deepEqual(after.requests.sort((a, b) => a.id.localeCompare(b.id)), backup.requests.sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(after.identities, backup.identities);
    assert.deepEqual(after.creation_receipts, backup.creation_receipts);
    assert.deepEqual(await verifyIdentityBackup(after, keys), after);
    assert.equal(sql('select count(*) from orl_private.c1_write_permit'), '0');
  });
}
