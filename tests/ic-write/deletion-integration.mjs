import assert from 'node:assert/strict';

export async function runDeletionTests({t,sql,parallelSql,literal,users,payload,client,password}){
  let dayNumber=0;
  const gen=()=>sql('select generation from orl_private.c1_restore_generation');
  const make=async(who='STAFF')=>{
    const p=await payload(who);await client(who)('CREATE',{request_id:p.p_request_id,generation:p.p_generation,data:p.p_data});
    await client(who)('CONFIRM',{request_id:p.p_request_id,generation:p.p_generation});return p.p_request_id;
  };
  const slots=()=>{
    const day=crypto.randomUUID(),ids=Array.from({length:4},()=>crypto.randomUUID());
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2089-02-${String(++dayNumber).padStart(2,'0')}','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values
      (${literal(ids[0])},${literal(day)},'MAIN',1,'AVAILABLE'),(${literal(ids[1])},${literal(day)},'MAIN',2,'CLOSED'),
      (${literal(ids[2])},${literal(day)},'MAIN',3,'AVAILABLE'),(${literal(ids[3])},${literal(day)},'SPECIAL',1,'AVAILABLE')`);
    return ids;
  };
  const assign=(id,slot,who='STAFF')=>client(who)('ASSIGN',{request_id:id,slot_id:slot,generation:gen(),slot_generation:gen()});
  const snapshot=(id,resolve=false,who='ADMIN')=>{
    const rows=JSON.parse(sql(`select public.${resolve?'orl_get_deletions':'orl_get_requests'}(${literal(users[who])})`));
    const row=rows.find(r=>r.id===id);assert.ok(row);
    return {request_id:id,expected_slot:row.assigned_slot_id,expected_version:row._ic_delete_version,generation:gen()};
  };
  const request=async(id,who='STAFF')=>client(who)('DELETE_REQUEST',{...snapshot(id,false,who),reason:'Synthetic cancellation'});
  const resolve=async(id,action='APPROVE',who='ADMIN')=>client(who)('DELETE_RESOLVE',{...snapshot(id,true),action});
  const rpcSql=(b,operation='REQUEST',who='STAFF')=>`set role service_role; select public.orl_ic_c1_deletion(${literal(users[who])},
    ${literal(operation)},${literal(b.request_id)},${literal(b.expected_slot)},${literal(b.expected_version)},${literal(b.generation)},'Synthetic cancellation')`;
  const identities=()=>sql('select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i');
  const state=()=>sql(`select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),
    'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'audits',(select count(*) from public.orl_audit_log))`);

  await t.test('cancellation request enforces Staff ownership including null owner, closed/pending rules and role-scoped versioned reads',async()=>{
    const id=await make('ADMIN'),own=await make(),before=state();
    await assert.rejects(client('STAFF')('DELETE_REQUEST',{...snapshot(id),reason:'Synthetic'}));assert.equal(state(),before);
    sql(`update public.orl_requests set created_by=null where id=${literal(id)}`);
    await assert.rejects(client('STAFF')('DELETE_REQUEST',{...snapshot(id),reason:'Synthetic'}));
    sql(`update public.orl_requests set created_by=${literal(users.ADMIN)} where id=${literal(id)}`);
    const staffRows=JSON.parse(sql(`select public.orl_get_requests(${literal(users.STAFF)})`));
    assert.equal(staffRows.some(r=>r.id===id),false);assert.ok(staffRows.find(r=>r.id===own)._ic_delete_version);
    assert.throws(()=>sql(`select public.orl_get_deletions(${literal(users.STAFF)})`),/Admin/);
    for(const reason of ['', ' ', 'x'.repeat(4097)])await assert.rejects(client('STAFF')('DELETE_REQUEST',{...snapshot(own),reason}));
    assert.equal((await request(own)).result,'REQUESTED');await assert.rejects(request(own));
    await assert.rejects(client('STAFF')('DELETE_RESOLVE',{...snapshot(own,true),action:'APPROVE'}),/Admin/);
    assert.throws(()=>sql(rpcSql(snapshot(own,true),'APPROVE','STAFF')),/Admin/);
    await resolve(own,'REJECT');
    for(const status of ['CANCELLED','COMPLETED']){
      sql(`update public.orl_requests set status=${literal(status)} where id=${literal(own)}`);await assert.rejects(request(own));
    }
    sql(`update public.orl_requests set status='CONFIRMED' where id=${literal(own)}`);
    for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_deletion(uuid,text,uuid,uuid,timestamptz,uuid,text)','EXECUTE')`),'f');
  });
  await t.test('approval retains identities/history, releases Special and compacts Main around CLOSED slots; rejection keeps booking',async()=>{
    const s=slots(),a=await make(),b=await make(),special=await make('ADMIN');
    await assign(a,s[0]);await assign(b,s[2]);await assign(special,s[3],'ADMIN');
    const before=identities();await request(a);await resolve(a);
    assert.equal(sql(`select status||':'||deletion_status||':'||(assigned_slot_id is null)::text from public.orl_requests where id=${literal(a)}`),'CANCELLED:APPROVED:true');
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(b)}`),s[0]);
    assert.equal(sql(`select status from public.orl_ot_slots where id=${literal(s[1])}`),'CLOSED');
    assert.equal(sql(`select request_id from public.orl_ot_slots where id=${literal(s[3])}`),special);
    assert.equal(identities(),before);
    await request(b);await resolve(b,'REJECT','WEBMASTER');
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(b)}`),s[0]);
    assert.equal(sql(`select deletion_status='' and deletion_requested_at is null from public.orl_requests where id=${literal(b)}`),'t');
    await request(special,'ADMIN');await resolve(special,'APPROVE','WEBMASTER');
    assert.equal(sql(`select request_id is null from public.orl_ot_slots where id=${literal(s[3])}`),'t');
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(b)}`),s[0]);
    const unscheduled=await make();await request(unscheduled);await resolve(unscheduled);
    assert.equal(sql(`select status from public.orl_requests where id=${literal(unscheduled)}`),'CANCELLED');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id in (${[a,b,special,unscheduled].map(literal).join(',')})`),'4');
  });
  await t.test('Staff cancellation through protected Edit remains compatible with the deletion approval queue',async()=>{
    const id=await make(),s=slots();await assign(id,s[0]);const before=identities();
    await client('STAFF')('EDIT',{from_slot:s[0],expected_request:id,
      expected_version:sql(`select to_jsonb(updated_at)#>>'{}' from public.orl_requests where id=${literal(id)}`),generation:gen(),ic_mode:'KEEP',
      data:{cancel_reason:'Synthetic Staff cancellation'},action:'CANCEL'});
    assert.equal(sql(`select deletion_status from public.orl_requests where id=${literal(id)}`),'PENDING');
    assert.equal((await resolve(id)).result,'APPROVE');assert.equal(identities(),before);
  });
  await t.test('deletion snapshots reject changed slot, reject/re-request cycle and pre-Restore decisions; revoked sessions fail',async()=>{
    const id=await make(),s=slots(),oldRequest=snapshot(id);await assign(id,s[0]);
    await assert.rejects(client('STAFF')('DELETE_REQUEST',{...oldRequest,reason:'Synthetic'}));
    await request(id);const oldDecision=snapshot(id,true);await resolve(id,'REJECT');await request(id);
    const before=state();await assert.rejects(client('ADMIN')('DELETE_RESOLVE',{...oldDecision,action:'APPROVE'}));assert.equal(state(),before);
    const fresh=snapshot(id,true),{backup}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    await assert.rejects(client('ADMIN')('DELETE_RESOLVE',{...fresh,action:'APPROVE'}));
    sql(`update public.orl_users set must_change_password=true where id=${literal(users.ADMIN)}`);
    try{assert.throws(()=>sql(rpcSql({...fresh,generation:gen()},'APPROVE','ADMIN')))}
    finally{sql(`update public.orl_users set must_change_password=false where id=${literal(users.ADMIN)}`)}
    assert.equal((await resolve(id)).result,'APPROVE');
  });
  await t.test('deletion audit failures roll back request and compaction; concurrent/lost decisions commit once with records retained',async()=>{
    const s=slots(),a=await make(),b=await make();await assign(a,s[0]);await assign(b,s[2]);
    sql(`create function public.c1_delete_audit_failure() returns trigger language plpgsql as $$begin
      if new.action in ('DELETION_REQUESTED','DELETION_APPROVE','DELETION_REJECT') then raise exception 'Synthetic audit failure'; end if; return new; end $$;
      create trigger c1_delete_audit_failure before insert on public.orl_audit_log for each row execute function public.c1_delete_audit_failure()`);
    try{const before=state();await assert.rejects(request(a));assert.equal(state(),before)}
    finally{sql('drop trigger c1_delete_audit_failure on public.orl_audit_log')}
    const req=snapshot(a),attempts=await Promise.all([1,2].map(()=>parallelSql(rpcSql(req))));assert.equal(attempts.filter(x=>!x.error).length,1);
    sql('create trigger c1_delete_audit_failure before insert on public.orl_audit_log for each row execute function public.c1_delete_audit_failure()');
    try{const before=state(),ic=identities();for(const action of ['APPROVE','REJECT']){await assert.rejects(resolve(a,action));assert.equal(state(),before);assert.equal(identities(),ic)}}
    finally{sql('drop trigger c1_delete_audit_failure on public.orl_audit_log; drop function public.c1_delete_audit_failure()')}
    const pending=snapshot(a,true),results=await Promise.all(['APPROVE','REJECT'].map(op=>parallelSql(rpcSql(pending,op,'ADMIN'))));
    assert.equal(results.filter(x=>!x.error).length,1);
    await request(b);const lost=snapshot(b,true);
    await assert.rejects((async()=>{await client('ADMIN')('DELETE_RESOLVE',{...lost,action:'APPROVE'});throw Error('Synthetic lost success')})(),/lost success/);
    await assert.rejects(client('ADMIN')('DELETE_RESOLVE',{...lost,action:'APPROVE'}));
    assert.equal(sql(`select count(*) from public.orl_audit_log where action='DELETION_APPROVE' and record_id=${literal(b)}`),'1');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id=${literal(b)}`),'1');
  });
}
