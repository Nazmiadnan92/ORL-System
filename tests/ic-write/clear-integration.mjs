import assert from 'node:assert/strict';

export async function runClearTests({t,sql,parallelSql,literal,users,payload,client,password}){
  let number=0;
  const gen=()=>sql('select generation from orl_private.c1_restore_generation');
  const record=async(who='ADMIN',type='MAIN')=>{
    const p=await payload(who),slot=crypto.randomUUID(),day=crypto.randomUUID(),other=crypto.randomUUID();
    await client(who)('CREATE',{request_id:p.p_request_id,generation:p.p_generation,data:p.p_data});
    await client(who)('CONFIRM',{request_id:p.p_request_id,generation:p.p_generation});
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2090-02-${String(++number).padStart(2,'0')}','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number) values
      (${literal(slot)},${literal(day)},${literal(type)},1),(${literal(other)},${literal(day)},'MAIN',2)`);
    await client(who)('ASSIGN',{request_id:p.p_request_id,slot_id:slot,generation:gen(),slot_generation:gen()});
    return {slot_id:slot,expected_request:p.p_request_id,generation:gen()};
  };
  const clearSql=(b,who='ADMIN')=>`set role service_role; select public.orl_ic_c1_clear(${literal(users[who])},
    ${literal(b.slot_id)},${literal(b.expected_request)},${literal(b.generation)})`;
  const snapshot=()=>sql(`select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),
    'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),
    'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),
    'audits',(select count(*) from public.orl_audit_log))`);
  const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${literal(id)}`);
  await t.test('Clear Main/Special and reserved slots preserves patient/identity/receipts and only releases selected slot',async()=>{
    for(const [booker,type,actor]of [['ADMIN','MAIN','ADMIN'],['WEBMASTER','SPECIAL','WEBMASTER'],['STAFF','MAIN','ADMIN']]){
      const b=await record(booker,type),before=identity(b.expected_request);
      const patient=sql(`select to_jsonb(r)-array['assigned_slot_id','status','updated_at'] from public.orl_requests r where id=${literal(b.expected_request)}`);
      const others=sql(`select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s where id<>${literal(b.slot_id)}`);
      assert.equal((await client(actor)('CLEAR',b)).result,'CLEARED');
      assert.equal(sql(`select status||':'||(assigned_slot_id is null)::text from public.orl_requests where id=${literal(b.expected_request)}`),'APPROVED:true');
      assert.equal(sql(`select status||':'||(request_id is null)::text from public.orl_ot_slots where id=${literal(b.slot_id)}`),'AVAILABLE:true');
      assert.equal(identity(b.expected_request),before);
      assert.equal(sql(`select to_jsonb(r)-array['assigned_slot_id','status','updated_at'] from public.orl_requests r where id=${literal(b.expected_request)}`),patient);
      assert.equal(sql(`select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s where id<>${literal(b.slot_id)}`),others);
      assert.equal((await client(booker)('RESOLVE_CREATE',{request_id:b.expected_request})).assigned,false);
      assert.equal(sql(`select outcome from orl_private.c1_creation_receipts where request_id=${literal(b.expected_request)}`),'CREATED');
      await assert.rejects(client(actor)('CLEAR',b));
    }
    for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_clear(uuid,uuid,uuid,uuid)','EXECUTE')`),'f');
  });
  await t.test('Clear rejects Staff, revoked session, wrong/missing patient, cancelled request and inconsistent links without mutation',async()=>{
    const b=await record(),before=snapshot();
    await assert.rejects(client('STAFF')('CLEAR',b),/Admin access/);
    assert.throws(()=>sql(clearSql(b,'STAFF')),/Admin access/);
    for(const expected_request of [null,crypto.randomUUID()])await assert.rejects(client('ADMIN')('CLEAR',{...b,expected_request}));
    await assert.rejects(client('ADMIN')('CLEAR',{...b,slot_id:crypto.randomUUID()}));
    assert.equal(snapshot(),before);
    sql(`update public.orl_users set must_change_password=true where id=${literal(users.ADMIN)}`);
    try{assert.throws(()=>sql(clearSql(b)))}finally{sql(`update public.orl_users set must_change_password=false where id=${literal(users.ADMIN)}`)}
    for(const change of ["status='CANCELLED'","assigned_slot_id=null"]){
      sql(`update public.orl_requests set ${change} where id=${literal(b.expected_request)}`);
      const invalid=snapshot();await assert.rejects(client('ADMIN')('CLEAR',b));assert.equal(snapshot(),invalid);
      sql(`update public.orl_requests set status='SCHEDULED',assigned_slot_id=${literal(b.slot_id)} where id=${literal(b.expected_request)}`);
    }
  });
  await t.test('Clear fences pre-Restore actions and audit failure rolls back patient, slot and identity',async()=>{
    const b=await record(),{backup}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    const before=snapshot();await assert.rejects(client('ADMIN')('CLEAR',b));assert.equal(snapshot(),before);
    const fresh={...b,generation:gen()};
    sql(`create function public.c1_clear_audit_failure() returns trigger language plpgsql as $$begin
      if new.action='OT_SLOT_CLEARED' then raise exception 'Synthetic Clear audit failure'; end if; return new; end $$;
      create trigger c1_clear_audit_failure before insert on public.orl_audit_log for each row execute function public.c1_clear_audit_failure()`);
    try{await assert.rejects(client('ADMIN')('CLEAR',fresh));assert.equal(snapshot(),before)}
    finally{sql('drop trigger c1_clear_audit_failure on public.orl_audit_log; drop function public.c1_clear_audit_failure()')}
    assert.equal((await client('ADMIN')('CLEAR',fresh)).result,'CLEARED');
  });
  await t.test('concurrent Clear commits once; lost response and reoccupied slot cannot clear another patient',async()=>{
    const b=await record();
    const attempts=await Promise.all([1,2].map(()=>parallelSql(clearSql(b))));
    assert.equal(attempts.filter(x=>!x.error).length,1);
    assert.equal(sql(`select count(*) from public.orl_audit_log where action='OT_SLOT_CLEARED' and record_id=${literal(b.slot_id)}`),'1');
    const a=await record(),lost=async()=>{await client('ADMIN')('CLEAR',a);throw Error('Synthetic lost success')};
    await assert.rejects(lost(),/lost success/);
    const result=await client('ADMIN')('RESOLVE_CREATE',{request_id:a.expected_request});
    assert.equal(result.assigned,false);assert.equal(result.status,'APPROVED');
    const p=await payload('ADMIN');await client('ADMIN')('CREATE',{request_id:p.p_request_id,generation:p.p_generation,data:p.p_data});
    await client('ADMIN')('CONFIRM',{request_id:p.p_request_id,generation:p.p_generation});
    await client('ADMIN')('ASSIGN',{request_id:p.p_request_id,slot_id:a.slot_id,generation:gen(),slot_generation:gen()});
    const before=snapshot();await assert.rejects(client('ADMIN')('CLEAR',a));assert.equal(snapshot(),before);
  });
}
