import assert from 'node:assert/strict';

export async function runRecoveryTests({ t, sql, parallelSql, literal, json, users, payload, commit }) {
  const resolveCall = (token,id) => 'select public.orl_ic_c1_resolve_create('+literal(token)+','+literal(id)+');';
  const resolve = (token,id) => JSON.parse(sql('set role service_role; '+resolveCall(token,id)));
  const createCall = p => 'select public.orl_ic_c1_create('+
    [literal(p.p_session_token),literal(p.p_request_id),json(p.p_data),json(p.p_envelope),json(p.p_search),literal(p.p_generation)].join(',')+');';

  await t.test('recovery receipts are private; stale/other-user sessions cannot inspect a saved DRAFT', async () => {
    const p = await payload('STAFF'); commit(p);
    assert.deepEqual(resolve(users.STAFF,p.p_request_id),
      {request_id:p.p_request_id,outcome:'CREATED',status:'DRAFT',assigned:false});
    for(const token of [users.ADMIN,users.WEBMASTER,crypto.randomUUID()])
      assert.throws(()=>resolve(token,p.p_request_id));
    for(const role of ['anon','authenticated','service_role']) {
      assert.equal(sql("select has_table_privilege('"+role+"','orl_private.c1_creation_receipts','SELECT,INSERT,UPDATE,DELETE')"),'f');
      if(role!=='service_role')assert.equal(sql("select has_function_privilege('"+role+"','public.orl_ic_c1_resolve_create(uuid,uuid)','EXECUTE')"),'f');
    }
  });
  await t.test('not-yet-arrived creation is permanently fenced; checking twice is safe and cannot create a patient', async () => {
    const p = await payload('ADMIN');
    const expected={request_id:p.p_request_id,outcome:'CANCELLED'};
    assert.deepEqual(resolve(users.ADMIN,p.p_request_id),expected);
    assert.deepEqual(resolve(users.ADMIN,p.p_request_id),expected);
    assert.throws(()=>commit(p),'Delayed create must fail');
    assert.equal(sql('select count(*) from public.orl_requests where id='+literal(p.p_request_id)),'0');
    assert.equal(sql('select count(*) from orl_private.request_identity where request_id='+literal(p.p_request_id)),'0');
  });
  await t.test('CREATE versus recovery race yields either one complete save or a fenced zero-save, never a late duplicate', async () => {
    for(let i=0;i<3;i++){
      const p=await payload('ADMIN');
      const [created,recovered]=await Promise.all([
        parallelSql('set role service_role; '+createCall(p)),
        parallelSql('set role service_role; '+resolveCall(users.ADMIN,p.p_request_id))
      ]);
      assert.equal(recovered.error,null);
      const result=JSON.parse(recovered.stdout.trim());
      const n=sql('select count(*) from public.orl_requests where id='+literal(p.p_request_id));
      assert.equal(n,result.outcome==='CREATED'?'1':'0');
      assert.equal(sql('select count(*) from orl_private.request_identity where request_id='+literal(p.p_request_id)),n);
      if(result.outcome==='CREATED')assert.equal(created.error,null);else assert.ok(created.error);
      assert.throws(()=>commit(p));
    }
  });
  await t.test('clinical failure rolls back receipt; deleted saved record is UNAVAILABLE and never recreated', async () => {
    const p=await payload('ADMIN',{patient_ic:'',age:'0',age_months:'6',patient_name:''});
    assert.throws(()=>commit(p));
    assert.equal(sql('select count(*) from orl_private.c1_creation_receipts where request_id='+literal(p.p_request_id)),'0');
    const valid=await payload('ADMIN',{patient_ic:'',age:'0',age_months:'6'});commit(valid);
    sql('delete from public.orl_requests where id='+literal(valid.p_request_id));
    assert.deepEqual(resolve(users.ADMIN,valid.p_request_id),{request_id:valid.p_request_id,outcome:'UNAVAILABLE'});
    assert.throws(()=>commit(valid));
  });
}
