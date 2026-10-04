import assert from 'node:assert/strict';

export async function runReviewTests({t,sql,parallelSql,literal,users,payload,client,password}){
  let number=0;
  const gen=()=>sql('select generation from orl_private.c1_restore_generation');
  const record=async(assigned=true)=>{
    const p=await payload('STAFF'),id=p.p_request_id;
    await client('STAFF')('CREATE',{request_id:id,generation:p.p_generation,data:p.p_data});
    await client('STAFF')('CONFIRM',{request_id:id,generation:p.p_generation});
    let slot=null;
    if(assigned){
      const day=crypto.randomUUID();slot=crypto.randomUUID();
      sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2091-02-${String(++number).padStart(2,'0')}','Synthetic');
        insert into public.orl_ot_slots(id,session_id,slot_type,slot_number) values(${literal(slot)},${literal(day)},'MAIN',1)`);
      await client('STAFF')('ASSIGN',{request_id:id,slot_id:slot,generation:gen(),slot_generation:gen()});
    }
    return {request_id:id,expected_slot:slot,generation:gen(),action:'APPROVE',note:'Synthetic review'};
  };
  const reviewSql=(b,who='ADMIN')=>`set role service_role; select public.orl_ic_c1_review(${literal(users[who])},
    ${literal(b.request_id)},${literal(b.action)},${literal(b.note)},${literal(b.expected_slot)},${literal(b.generation)})`;
  const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${literal(id)}`);
  const state=id=>JSON.parse(sql(`select jsonb_build_object('status',r.status,'slot',r.assigned_slot_id,
    'slot_status',s.status,'linked',s.request_id) from public.orl_requests r left join public.orl_ot_slots s on s.id=r.assigned_slot_id where r.id=${literal(id)}`));

  await t.test('Review preserves Admin/WM approve/reject results for reserved and unscheduled requests, identity and audit',async()=>{
    for(const who of ['ADMIN','WEBMASTER'])for(const assigned of [false,true])for(const action of ['APPROVE','REJECT']){
      const b={...await record(assigned),action},before=identity(b.request_id);
      await assert.rejects(client('STAFF')('REVIEW',b),/Admin access/);
      assert.throws(()=>sql(reviewSql(b,'STAFF')),/Admin access/);
      assert.equal((await client(who)('REVIEW',b)).result,action);
      const current=state(b.request_id);
      assert.equal(current.status,action==='REJECT'?'REJECTED':assigned?'SCHEDULED':'APPROVED');
      assert.equal(current.slot,action==='REJECT'?null:b.expected_slot);
      if(assigned){
        const s=JSON.parse(sql(`select jsonb_build_object('status',status,'request',request_id) from public.orl_ot_slots where id=${literal(b.expected_slot)}`));
        assert.equal(s.status,action==='REJECT'?'AVAILABLE':'CONFIRMED');
        assert.equal(s.request,action==='REJECT'?null:b.request_id);
      }
      assert.equal(identity(b.request_id),before);
      await assert.rejects(client(who)('REVIEW',b),/not confirmed/);
      assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${literal(b.request_id)} and action in ('REQUEST_APPROVE','REQUEST_REJECT')`),'1');
    }
    for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_review(uuid,uuid,text,text,uuid,uuid)','EXECUTE')`),'f');
  });
  await t.test('Review refuses stale slot/null selection, inconsistent links, invalid status and revoked session',async()=>{
    const b=await record(),before=state(b.request_id);
    for(const expected_slot of [null,crypto.randomUUID()])await assert.rejects(client('ADMIN')('REVIEW',{...b,expected_slot}));
    sql(`update public.orl_ot_slots set status='AVAILABLE' where id=${literal(b.expected_slot)}`);
    await assert.rejects(client('ADMIN')('REVIEW',b));
    sql(`update public.orl_ot_slots set status='RESERVED' where id=${literal(b.expected_slot)};
      update public.orl_users set must_change_password=true where id=${literal(users.ADMIN)}`);
    try{assert.throws(()=>sql(reviewSql(b)))}finally{sql(`update public.orl_users set must_change_password=false where id=${literal(users.ADMIN)}`)}
    assert.deepEqual(state(b.request_id),before);
    const a=await record(false),sl=crypto.randomUUID(),day=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2091-03-01','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number) values(${literal(sl)},${literal(day)},'MAIN',1)`);
    await client('STAFF')('ASSIGN',{request_id:a.request_id,slot_id:sl,generation:gen(),slot_generation:gen()});
    await assert.rejects(client('ADMIN')('REVIEW',a),'Old unassigned selection cannot approve a newly assigned slot');
    for(const status of ['DRAFT','REJECTED','CANCELLED','COMPLETED']){
      sql(`update public.orl_requests set status=${literal(status)} where id=${literal(a.request_id)}`);
      await assert.rejects(client('ADMIN')('REVIEW',{...a,expected_slot:sl}));
    }
    sql(`update public.orl_requests set status='CONFIRMED' where id=${literal(a.request_id)}`);
  });
  await t.test('Review generation rejects pre-Restore decisions; audit failure rolls back both approval and rejection',async()=>{
    const b=await record(),{backup}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    await assert.rejects(client('ADMIN')('REVIEW',b));
    const fresh={...b,generation:gen()},before=state(b.request_id),ic=identity(b.request_id);
    sql(`create function public.c1_review_audit_failure() returns trigger language plpgsql as $$begin
      if new.action in ('REQUEST_APPROVE','REQUEST_REJECT') then raise exception 'Synthetic review audit failure'; end if; return new; end $$;
      create trigger c1_review_audit_failure before insert on public.orl_audit_log for each row execute function public.c1_review_audit_failure()`);
    try{for(const action of ['APPROVE','REJECT']){
      await assert.rejects(client('ADMIN')('REVIEW',{...fresh,action}));
      assert.deepEqual(state(b.request_id),before);assert.equal(identity(b.request_id),ic);
    }}finally{sql('drop trigger c1_review_audit_failure on public.orl_audit_log; drop function public.c1_review_audit_failure()')}
    assert.equal((await client('ADMIN')('REVIEW',fresh)).result,'APPROVE');
  });
  await t.test('simultaneous opposite reviews commit once; lost success is read back and cannot be blindly repeated',async()=>{
    const b=await record();
    const results=await Promise.all(['APPROVE','REJECT'].map(action=>parallelSql(reviewSql({...b,action}))));
    assert.equal(results.filter(x=>!x.error).length,1);
    assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${literal(b.request_id)} and action in ('REQUEST_APPROVE','REQUEST_REJECT')`),'1');
    const a=await record(),lost=async()=>{await client('ADMIN')('REVIEW',a);throw Error('Synthetic lost success')};
    await assert.rejects(lost(),/lost success/);
    const rows=JSON.parse(sql(`select public.orl_get_requests(${literal(users.ADMIN)})`));
    assert.equal(rows.find(r=>r.id===a.request_id).status,'SCHEDULED');
    await assert.rejects(client('ADMIN')('REVIEW',a));
    assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${literal(a.request_id)} and action='REQUEST_APPROVE'`),'1');
  });
}
