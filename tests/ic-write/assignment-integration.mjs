import assert from 'node:assert/strict';
import {createPendingCreation} from '../../docs/ic-client.mjs';

export async function runAssignmentTests({t,sql,parallelSql,literal,users,payload,client,password}) {
  let dayNumber=0;
  const gen=()=>sql('select generation from orl_private.c1_restore_generation');
  const day=()=>{
    const id=crypto.randomUUID(),date=`2092-01-${String(++dayNumber).padStart(2,'0')}`;
    const main=crypto.randomUUID(),second=crypto.randomUUID(),special=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(id)},${literal(date)},'Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values
      (${literal(main)},${literal(id)},'MAIN',1,'AVAILABLE'),(${literal(second)},${literal(id)},'MAIN',2,'AVAILABLE'),
      (${literal(special)},${literal(id)},'SPECIAL',1,'AVAILABLE')`);
    return {id,date,main,second,special};
  };
  const record=async(who='ADMIN',confirm=true)=>{
    const p=await payload(who);
    await client(who)('CREATE',{request_id:p.p_request_id,generation:p.p_generation,data:p.p_data});
    if(confirm)await client(who)('CONFIRM',{request_id:p.p_request_id,generation:p.p_generation});
    return p.p_request_id;
  };
  const body=(id,slot)=>({request_id:id,slot_id:slot,generation:gen(),slot_generation:gen()});
  const assignmentSql=(who,b)=>`set role service_role; select public.orl_ic_c1_assign(${literal(users[who])},
    ${literal(b.request_id)},${literal(b.slot_id)},${literal(b.generation)},${literal(b.slot_generation)})`;
  const identities=()=>sql('select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i');
  await t.test('Assign enforces role/ownership, ready status and Main/Special rules without changing encrypted identity',async()=>{
    for(const who of ['STAFF','ADMIN','WEBMASTER']) {
      const d=day(),id=await record(who),b=body(id,d.main),before=identities();
      if(who!=='STAFF')await assert.rejects(client('STAFF')('ASSIGN',b),/Check Previous Save/);
      if(who==='STAFF')await assert.rejects(client(who)('ASSIGN',{...b,slot_id:d.special}),/Check Previous Save/);
      assert.equal((await client(who)('ASSIGN',b)).result,who==='STAFF'?'RESERVED':'CONFIRMED');
      await assert.rejects(client(who)('ASSIGN',{...b,slot_id:d.second}),/Check Previous Save/);
      assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(id)}`),d.main);
      assert.equal(sql(`select request_id from public.orl_ot_slots where id=${literal(d.main)}`),id);
      assert.equal(identities(),before);
      if(who!=='STAFF')assert.equal((await client(who)('ASSIGN',body(await record(who),d.special))).result,'CONFIRMED');
    }
    const d=day(),id=await record('ADMIN',false);
    for(const status of ['DRAFT','REJECTED','CANCELLED']) {
      sql(`update public.orl_requests set status=${literal(status)} where id=${literal(id)}`);
      await assert.rejects(client('ADMIN')('ASSIGN',body(id,d.main)),/Check Previous Save/);
    }
    for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_assign(uuid,uuid,uuid,uuid,uuid)','EXECUTE')`),'f');
  });
  await t.test('Assign rejects blocked, occupied and holiday slots, revoked sessions, and rolls back on audit failure',async()=>{
    const d=day(),id=await record(),b=body(id,d.main);
    sql(`update public.orl_ot_slots set status='CLOSED' where id=${literal(d.main)}`);
    await assert.rejects(client('ADMIN')('ASSIGN',b));
    sql(`update public.orl_ot_slots set status='AVAILABLE' where id=${literal(d.main)};
      update public.orl_ot_sessions set status='CANCELLED' where id=${literal(d.id)}`);
    await assert.rejects(client('ADMIN')('ASSIGN',b));
    sql(`update public.orl_ot_sessions set status='ACTIVE' where id=${literal(d.id)};
      insert into public.orl_holidays(holiday_date,title) values(${literal(d.date)},'Synthetic holiday')`);
    await assert.rejects(client('ADMIN')('ASSIGN',b));
    sql(`update public.orl_holidays set is_active=false where holiday_date=${literal(d.date)};
      update public.orl_users set must_change_password=true where id=${literal(users.ADMIN)}`);
    try{await assert.rejects(client('ADMIN')('ASSIGN',b))}
    finally{sql(`update public.orl_users set must_change_password=false where id=${literal(users.ADMIN)}`)}
    const before=identities();
    sql(`create function public.c1_assign_audit_failure() returns trigger language plpgsql as $$begin
      if new.action='PATIENT_ASSIGNED_CONFIRMED' then raise exception 'Synthetic audit failure'; end if; return new; end $$;
      create trigger c1_assign_audit_failure before insert on public.orl_audit_log for each row execute function public.c1_assign_audit_failure()`);
    try{
      await assert.rejects(client('ADMIN')('ASSIGN',b));
      assert.equal(sql(`select assigned_slot_id is null from public.orl_requests where id=${literal(id)}`),'t');
      assert.equal(sql(`select status from public.orl_ot_slots where id=${literal(d.main)}`),'AVAILABLE');
      assert.equal(identities(),before);
    }finally{sql('drop trigger c1_assign_audit_failure on public.orl_audit_log; drop function public.c1_assign_audit_failure()')}
    await client('ADMIN')('ASSIGN',b);
    await assert.rejects(client('ADMIN')('ASSIGN',body(await record(),d.main)));
  });
  await t.test('simultaneous Assign cannot give one slot to two requests or one request to two slots',async()=>{
    const d=day(),a=await record(),b=await record();
    const sameSlot=await Promise.all([a,b].map(id=>parallelSql(assignmentSql('ADMIN',body(id,d.main)))));
    assert.equal(sameSlot.filter(x=>!x.error).length,1);
    const e=day(),c=await record();
    const sameRequest=await Promise.all([e.main,e.second].map(slot=>parallelSql(assignmentSql('ADMIN',body(c,slot)))));
    assert.equal(sameRequest.filter(x=>!x.error).length,1);
    assert.equal(sql(`select count(*) from public.orl_ot_slots where request_id=${literal(c)}`),'1');
    assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${literal(c)} and action='PATIENT_ASSIGNED_CONFIRMED'`),'1');
  });
  await t.test('Assign rejects old request or old slot generations after Restore and accepts only fresh reviewed references',async()=>{
    const d=day(),id=await record(),old=body(id,d.main);
    const {backup}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    const fresh=gen();assert.notEqual(fresh,old.generation);
    for(const b of [old,{...old,generation:fresh},{...old,slot_generation:fresh},{...old,slot_generation:null}])
      await assert.rejects(client('ADMIN')('ASSIGN',b));
    assert.equal(sql(`select assigned_slot_id is null from public.orl_requests where id=${literal(id)}`),'t');
    assert.equal((await client('ADMIN')('ASSIGN',body(id,d.main))).result,'CONFIRMED');
  });
  await t.test('lost successful ASSIGN keeps only UUID; reload resolves assigned record without retry or new CREATE',async()=>{
    const d=day(),p=await payload('STAFF'),store=new Map(),calls=[];
    const options={key:'synthetic-assign',newId:()=>p.p_request_id,session:()=>users.STAFF,withLock:fn=>fn(),
      storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
      send:async(op,data)=>{calls.push(op);const r=await client('STAFF')(op,data);if(op==='ASSIGN')throw Error('Lost success');return r}};
    const first=createPendingCreation(options);await first.create(p.p_data);await first.confirm(p.p_request_id);
    assert.equal(first.pending(),p.p_request_id);
    await assert.rejects(first.assign(p.p_request_id,d.main,gen()),/Lost success/);
    await assert.rejects(first.assign(p.p_request_id,d.main,gen()),/Check Previous Save/);
    const fresh=createPendingCreation(options),resolved=await fresh.resolve();
    assert.equal(resolved.assigned,true);assert.equal(resolved.status,'CONFIRMED');
    await assert.rejects(fresh.assign(p.p_request_id,d.second,gen()),/Check Previous Save/);
    await fresh.acknowledge(p.p_request_id);assert.equal(fresh.pending(),null);
    assert.equal(calls.filter(x=>x==='CREATE').length,1);assert.equal(calls.filter(x=>x==='ASSIGN').length,1);
  });
}
