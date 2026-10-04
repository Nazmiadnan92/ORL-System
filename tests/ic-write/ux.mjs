import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export function installUx(sql){sql(readFileSync(new URL('./ux.sql',import.meta.url),'utf8'))}

export async function runUxTests({t,sql,literal,users,payload,commit}){
  const generation=()=>sql('select generation from orl_private.c1_restore_generation');
  const call=(who,id,count,version,gen=generation())=>sql(`set role service_role;select public.orl_ic_c1_unscheduled_count(
    ${literal(users[who])},${literal(id)},${count},${literal(version)},${literal(gen)})`);
  await t.test('unscheduled count is Webmaster-only, versioned, audited and preserves identity',async()=>{
    const p=await payload('ADMIN');commit(p);const id=p.p_request_id,version=sql(`select updated_at from public.orl_requests where id=${literal(id)}`);
    const shadow=sql(`select encode(ciphertext,'hex') from orl_private.request_identity where request_id=${literal(id)}`);
    assert.throws(()=>call('ADMIN',id,4,version),/Webmaster/);assert.equal(call('WEBMASTER',id,4,version),'4');
    assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(id)}`),'4');
    assert.equal(sql(`select encode(ciphertext,'hex') from orl_private.request_identity where request_id=${literal(id)}`),shadow);
    assert.equal(sql(`select count(*) from public.orl_audit_log where action='POSTPONE_COUNT_UPDATED' and record_id=${literal(id)}`),'1');
  });
  await t.test('unscheduled count rejects stale, assigned, closed, malformed and pre-Restore selections',async()=>{
    const p=await payload('ADMIN');commit(p);const id=p.p_request_id,version=sql(`select updated_at from public.orl_requests where id=${literal(id)}`),old=generation();
    assert.throws(()=>call('WEBMASTER',id,1000,version),/Invalid/);
    sql(`update public.orl_requests set diagnosis='CHANGED',updated_at=clock_timestamp() where id=${literal(id)}`);assert.throws(()=>call('WEBMASTER',id,2,version),/changed/i);
    let current=sql(`select updated_at from public.orl_requests where id=${literal(id)}`),day=crypto.randomUUID(),slot=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2096-03-01','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status,request_id) values(${literal(slot)},${literal(day)},'MAIN',1,'CONFIRMED',${literal(id)});
      update public.orl_requests set assigned_slot_id=${literal(slot)} where id=${literal(id)}`);
    current=sql(`select updated_at from public.orl_requests where id=${literal(id)}`);assert.throws(()=>call('WEBMASTER',id,2,current),/scheduled-patient/);
    sql(`delete from public.orl_ot_slots where id=${literal(slot)};
      update public.orl_requests set assigned_slot_id=null,status='CANCELLED' where id=${literal(id)}`);
    current=sql(`select updated_at from public.orl_requests where id=${literal(id)}`);assert.throws(()=>call('WEBMASTER',id,2,current),/Closed/);
    sql('update orl_private.c1_restore_generation set generation=gen_random_uuid()');assert.throws(()=>call('WEBMASTER',id,2,current,old),/generation|Records changed/);
  });
  await t.test('final audit failure rolls back an unscheduled count',async()=>{
    const p=await payload('ADMIN');commit(p);const id=p.p_request_id,version=sql(`select updated_at from public.orl_requests where id=${literal(id)}`);
    sql(`create function public.c1_test_count_audit_fail() returns trigger language plpgsql as $$begin
      if new.action='POSTPONE_COUNT_UPDATED' then raise exception 'Synthetic count audit failure'; end if;return new;end $$;
      create trigger c1_test_count_audit_fail before insert on public.orl_audit_log for each row execute function public.c1_test_count_audit_fail()`);
    try{assert.throws(()=>call('WEBMASTER',id,7,version),/Synthetic count audit failure/);
      assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(id)}`),'0');
    }finally{sql('drop trigger c1_test_count_audit_fail on public.orl_audit_log;drop function public.c1_test_count_audit_fail()')}
  });
}
