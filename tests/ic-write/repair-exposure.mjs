import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export function installRepairExposure(sql){
  sql(readFileSync(new URL('./repair-exposure.sql',import.meta.url),'utf8'));
}

export async function runRepairExposureTests({t,sql,parallelSql,literal,users,password,payload}){
  const gen=()=>sql('select generation from orl_private.c1_restore_generation');
  const view=()=>JSON.parse(sql(`set role service_role;select public.orl_ic_c1_repair_view(${literal(users.WEBMASTER)},${literal(gen())})`));
  await t.test('repair view/write are Webmaster service-only and require the exact reviewed snapshot',()=>{
    for(const fn of ['orl_ic_c1_repair_view(uuid,uuid)','orl_ic_c1_repair(uuid,text,uuid,text)']){
      for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.${fn}','EXECUTE')`),'f');
      assert.equal(sql(`select has_function_privilege('service_role','public.${fn}','EXECUTE')`),'t');
    }
    assert.throws(()=>sql(`set role service_role;select public.orl_ic_c1_repair_view(${literal(users.ADMIN)},${literal(gen())})`),/Webmaster/);
    const first=view(),slot=crypto.randomUUID(),day=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2096-02-04','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${literal(slot)},${literal(day)},'MAIN',1,'CLOSED')`);
    assert.throws(()=>sql(`set role service_role;select public.orl_ic_c1_repair(${literal(users.WEBMASTER)},${literal(password)},
      ${literal(first.generation)},${literal(first.revision)})`),/changed/);
    const current=view(),result=JSON.parse(sql(`set role service_role;select public.orl_ic_c1_repair(${literal(users.WEBMASTER)},${literal(password)},
      ${literal(current.generation)},${literal(current.revision)})`));
    assert.equal(result.status,'COMPLETED');assert.ok(result.fixed>=1);
    assert.equal(sql(`select status from public.orl_ot_slots where id=${literal(slot)}`),'AVAILABLE');
  });
  await t.test('repair is atomic on final audit failure and rejects pre-Restore generations',()=>{
    const broken=crypto.randomUUID(),day=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2096-02-11','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${literal(broken)},${literal(day)},'MAIN',1,'CLOSED')`);
    const current=view();
    sql(`create function public.c1_test_repair_fail() returns trigger language plpgsql as $$begin
      if new.action='DATABASE_REPAIR' then raise exception 'Synthetic repair audit failure'; end if; return new; end $$;
      create trigger c1_test_repair_fail before insert on public.orl_audit_log for each row execute function public.c1_test_repair_fail()`);
    try{assert.throws(()=>sql(`set role service_role;select public.orl_ic_c1_repair(${literal(users.WEBMASTER)},${literal(password)},
      ${literal(current.generation)},${literal(current.revision)})`),/Synthetic repair audit failure/);
      assert.equal(sql(`select status from public.orl_ot_slots where id=${literal(broken)}`),'CLOSED');
    }finally{sql('drop trigger c1_test_repair_fail on public.orl_audit_log;drop function public.c1_test_repair_fail()')}
    const stale=view();sql('update orl_private.c1_restore_generation set generation=gen_random_uuid()');
    assert.throws(()=>sql(`set role service_role;select public.orl_ic_c1_repair(${literal(users.WEBMASTER)},${literal(password)},
      ${literal(stale.generation)},${literal(stale.revision)})`),/generation/);
  });
  await t.test('history, audit and free-text fields redact exact passports and Malaysian IC forms',async()=>{
    const raw='C1-PASSPORT-SECRET',my='010203-04-5678',p=await payload('ADMIN',{patient_ic:raw,remark:`Escort ${raw} / ${my}`});
    // payload is committed by the caller's tested creation function.
    sql(`set role service_role;select public.orl_ic_c1_create(${literal(p.p_session_token)},${literal(p.p_request_id)},
      ${literal(JSON.stringify(p.p_data))}::jsonb,${literal(JSON.stringify(p.p_envelope))}::jsonb,
      ${literal(JSON.stringify(p.p_search))}::jsonb,${literal(p.p_generation)})`);
    sql(`update public.orl_requests set postpone_count=1,postpone_history=${literal(JSON.stringify([{date:'2026-01-01',reason:`Patient ${raw} ${my}`}]))}::jsonb where id=${literal(p.p_request_id)};
      insert into public.orl_audit_log(user_name,user_role,action,record_type,record_id,details)
      values('Synthetic','WEBMASTER','SYNTHETIC','REQUEST',${literal(`IC ${my}`)},${literal(`Passport ${raw}`)})`);
    for(const text of [
      sql(`set role anon;select public.orl_get_postponed(${literal(users.WEBMASTER)})`),
      sql(`set role anon;select public.orl_get_audit(${literal(users.WEBMASTER)},'SYNTHETIC')`),
      sql(`select orl_private.c1_mask_json(${literal(JSON.stringify({patient_ic:raw,remark:`${raw} ${my}`}))}::jsonb,null)`)
    ]){assert.equal(text.includes(raw),false);assert.equal(text.includes(my),false);assert.match(text,/5678|SECRET/)}
  });
  await t.test('all public SECURITY DEFINER functions fix search_path and all C1 functions remain explicitly classified',()=>{
    assert.equal(sql(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prosecdef and not exists(select 1 from unnest(coalesce(p.proconfig,array[]::text[])) x where x like 'search_path=%')`),'0');
    const unclassified=JSON.parse(sql(`select coalesce(jsonb_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text),'[]')
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'orl_ic_c1_%'
      and ((has_function_privilege('service_role',p.oid,'EXECUTE') and p.proname not in
        ('orl_ic_c1_authorize','orl_ic_c1_check_password','orl_ic_c1_create','orl_ic_c1_mutate','orl_ic_c1_confirm','orl_ic_c1_assign','orl_ic_c1_review','orl_ic_c1_clear','orl_ic_c1_deletion','orl_ic_c1_reassign','orl_ic_c1_remove','orl_ic_c1_export','orl_ic_c1_import','orl_ic_c1_resolve_create','orl_ic_c1_prepare_create','orl_ic_c1_control_view','orl_ic_c1_control','orl_ic_c1_repair_view','orl_ic_c1_repair','orl_ic_c1_unscheduled_count'))
      or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`));
    assert.deepEqual(unclassified,[]);
  });
}
