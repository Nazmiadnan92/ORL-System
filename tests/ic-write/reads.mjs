import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export async function runReadTests({ t, sql, literal, users, payload, commit }) {
  sql(readFileSync(new URL('./reads.sql', import.meta.url), 'utf8'));
  // Distinct invented identifier so absence tests cannot match unrelated test fields.
  const raw = '010203-04-5678', p = await payload('STAFF', { patient_ic: raw, mrn: 'C1-READ-SYNTHETIC', patient_name: 'Read Fixture' });
  commit(p);
  const id = p.p_request_id, sessionId = crypto.randomUUID(), slotId = crypto.randomUUID();
  sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(sessionId)},'2097-02-06','Synthetic');
    insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status)
      values(${literal(slotId)},${literal(sessionId)},'MAIN',1,${literal(id)},'CONFIRMED');
    update public.orl_requests set assigned_slot_id=${literal(slotId)},status='SCHEDULED',postpone_count=1,
      postpone_history='[{"date":"2026-01-01","reason":"Synthetic"}]',deletion_status='PENDING' where id=${literal(id)};`);
  const query = (name, extra = '', who = 'WEBMASTER') => sql(`set role anon; select public.${name}(${literal(users[who])}${extra})`);
  const noRaw = text => { assert.equal(text.includes(raw), false); assert.equal(text.includes(raw.replaceAll('-', '')), false); };

  await t.test('direct public schedule RPC masks IC for every role and preserves age at OT date', () => {
    const expected = JSON.parse(sql(`select public.orl_age_parts(${literal(raw)},'2097-02-06')`));
    for (const role of ['STAFF', 'ADMIN', 'WEBMASTER']) {
      const text = sql(`set role anon; select jsonb_agg(to_jsonb(s)) from public.orl_get_schedule(${literal(users[role])},2097,2) s`);
      noRaw(text);
      const row = JSON.parse(text).flatMap(x => x.slots).find(x => x.request_id === id);
      assert.equal(row.patient_ic, '******-**-5678'); assert.equal(row.patient_ic_masked, true);
      assert.equal(row.age, expected.years); assert.equal(row.age_months, expected.months);
      assert.equal(row._ic_edit_version,sql(`select to_jsonb(updated_at)#>>'{}' from public.orl_requests where id=${literal(id)}`));
    }
  });
  await t.test('IC/MRN/name search remains role scoped; old MRN API cannot bypass Staff ownership', () => {
    for (const search of [raw, raw.replaceAll('-', ''), p.p_data.mrn, 'Read Fixture']) {
      const text = query('orl_find_patient_search', ',' + literal(search), 'STAFF'); noRaw(text);
      assert.ok(JSON.parse(text).some(x => x.id === id));
    }
    const other = sql("select id from public.orl_users where username='c1_admin'");
    sql(`update public.orl_requests set created_by=${literal(other)} where id=${literal(id)}`);
    assert.deepEqual(JSON.parse(query('orl_find_patient_search', ',' + literal(raw), 'STAFF')), []);
    assert.deepEqual(JSON.parse(query('orl_find_patient', ',' + literal(p.p_data.mrn), 'STAFF')), []);
    assert.ok(JSON.parse(query('orl_find_patient', ',' + literal(p.p_data.mrn), 'WEBMASTER')).some(x => x.id === id));
    sql(`update public.orl_requests set created_by=${literal(users.STAFF)} where id=${literal(id)}`);
  });
  await t.test('postponed, deletion, statistics and database tools mask structured IC fields', () => {
    for (const [fn, extra] of [['orl_get_postponed', ''], ['orl_get_deletions', ''],
      ['orl_subspecialty_statistics', ''], ['orl_db_find_patient', ',' + literal(p.p_data.mrn)],
      ['orl_get_requests', ''], ['orl_get_dashboard', '']]) noRaw(query(fn, extra));
    const extra = crypto.randomUUID();
    sql(`insert into public.orl_requests(id,request_number,patient_ic,mrn,patient_name,surgery,diagnosis,doctor,specialist,sub_specialty,phone,status)
      values(${literal(extra)},'C1-DUP-READ',${literal(raw)},'READ-SECOND','Synthetic','TEST','TEST','Test','Test','Gen ORL','0','CANCELLED')`);
    noRaw(query('orl_db_cancelled'));
    const duplicates = query('orl_db_duplicates'); noRaw(duplicates);
    assert.ok(JSON.parse(duplicates).some(x => x.match_type === 'PATIENT IC' && x.match_value === '******-**-5678'));
  });
  await t.test('raw private cores are inaccessible; revoked/unknown sessions still fail', () => {
    const fns = JSON.parse(sql("select jsonb_agg(oid::text) from pg_proc where pronamespace='orl_private'::regnamespace and proname like 'c1_read_%'"));
    for (const role of ['anon', 'authenticated', 'service_role']) for (const oid of fns)
      assert.equal(sql(`select has_function_privilege('${role}',${Number(oid)}::oid,'EXECUTE')`), 'f');
    assert.throws(() => sql(`set role anon; select public.orl_find_patient_search('${crypto.randomUUID()}','Read')`));
    assert.throws(() => query('orl_get_deletions', '', 'STAFF'));
    assert.throws(() => query('orl_db_duplicates', '', 'ADMIN'));
  });
  await t.test('short/blank identifiers do not leak; manual infant age survives recursive masking', () => {
    assert.equal(sql("select orl_private.c1_mask_ic('AB')"), '****');
    assert.equal(sql("select orl_private.c1_mask_ic('')"), '');
    const row = JSON.parse(sql(`select orl_private.c1_mask_json('{"patient_ic":"","age":0,"age_months":6}',null)`));
    assert.equal(row.age, 0); assert.equal(row.age_months, 6); assert.equal(row.patient_ic_present, false);
    const once = sql(`select orl_private.c1_mask_json('{"patient_ic":"${raw}"}',null)`);
    assert.equal(sql(`select orl_private.c1_mask_json(${literal(once)}::jsonb,null)`), once);
  });
}
