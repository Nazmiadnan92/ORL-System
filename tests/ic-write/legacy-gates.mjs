import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export async function runLegacyGateTests({t,sql,literal,json,users,payload,commit}) {
  const fixture=readFileSync(new URL('./legacy-gates.sql',import.meta.url),'utf8');
  const names=['orl_create_request','orl_edit_scheduled_request','orl_edit_scheduled_request_checked',
    'orl_move_postponed','orl_move_postponed_checked','orl_db_remove_patient','orl_delete_request',
    'orl_db_export','orl_db_import','orl_db_import_locked','orl_set_postpone_count','orl_swap_slots','orl_swap_slots_checked','orl_confirm_request','orl_assign_slot','orl_review_request','orl_clear_slot','orl_clear_slot_checked','orl_request_deletion','orl_resolve_deletion',
    'orl_set_session','orl_set_slot_closed','orl_save_holiday','orl_delete_holiday','orl_generate_public_holidays','orl_clear_all_holidays','orl_save_settings','orl_prepare_schedule','orl_db_repair','orl_postpone_slot','orl_update_slot_request'];
  await t.test('legacy gate rolls back all revokes if an unexpected callable overload remains',()=>{
    sql('create function public.orl_create_request(uuid) returns void language sql as $$select$$');
    try {
      assert.throws(()=>sql(fixture),/Legacy overload or inherited grant remains/);
      assert.equal(sql("select has_function_privilege('anon','public.orl_create_request(uuid,jsonb)','EXECUTE')"),'t');
    } finally {sql('drop function public.orl_create_request(uuid)')}
  });
  // Do not run the positive-path tests against an ungated database if setup fails.
  sql(fixture);
  await t.test('all thirty-one legacy entry points reject direct anon/authenticated/service calls before execution',()=>{
    const functions=JSON.parse(sql(`select jsonb_agg(jsonb_build_object('name',p.proname,'args',oidvectortypes(p.proargtypes)))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any(array[${names.map(literal).join(',')}])`));
    assert.equal(functions.length,31);
    const before=sql('select count(*) from public.orl_requests');
    for(const role of ['anon','authenticated','service_role']) for(const fn of functions){
      const args=fn.args.split(', ').map(type=>'null::'+type).join(',');
      assert.throws(()=>sql(`set role ${role}; select public.${fn.name}(${args})`),/permission denied for function/);
    }
    assert.equal(sql('select count(*) from public.orl_requests'),before);
  });
  await t.test('protected create/edit/move/export/restore/remove still work after legacy gates',async()=>{
    const v=JSON.parse(sql(`set role service_role;select public.orl_ic_c1_control_view(${literal(users.ADMIN)},'SETTINGS',null,null)`));
    assert.equal(JSON.parse(sql(`set role service_role;select public.orl_ic_c1_control(${literal(users.ADMIN)},'SETTINGS',null,
      ${json(v.data)},${literal(v.generation)},${literal(v.revision)})`)).action,'SETTINGS');
    // Masked schedule still generates capacity through the now-private lazy writer.
    sql(`set role anon;select count(*) from public.orl_get_schedule(${literal(users.STAFF)},2085,3)`);
    const uncounted=await payload('ADMIN');commit(uncounted);
    const uncountedVersion=sql(`select updated_at from public.orl_requests where id=${literal(uncounted.p_request_id)}`);
    assert.equal(sql(`set role service_role;select public.orl_ic_c1_unscheduled_count(${literal(users.WEBMASTER)},
      ${literal(uncounted.p_request_id)},3,${literal(uncountedVersion)},${literal(uncounted.p_generation)})`),'3');
    const cancellation=await payload('STAFF');commit(cancellation);
    for(const op of ['REQUEST','APPROVE']){
      const version=sql(`select updated_at from public.orl_requests where id=${literal(cancellation.p_request_id)}`);
      assert.equal(sql(`set role service_role; select public.orl_ic_c1_deletion(${literal(users[op==='REQUEST'?'STAFF':'ADMIN'])},
        ${literal(op)},${literal(cancellation.p_request_id)},null,${literal(version)},${literal(cancellation.p_generation)},'Synthetic reason')`),op==='REQUEST'?'REQUESTED':op);
    }
    for(const action of ['APPROVE','REJECT']){
      const pending=await payload('STAFF');commit(pending);
      sql(`set role service_role; select public.orl_ic_c1_confirm(${literal(users.STAFF)},${literal(pending.p_request_id)},${literal(pending.p_generation)})`);
      assert.equal(sql(`set role service_role; select public.orl_ic_c1_review(${literal(users.ADMIN)},${literal(pending.p_request_id)},
        ${literal(action)},'Synthetic review',null,${literal(pending.p_generation)})`),action);
    }
    const pw=crypto.randomUUID(),p=await payload('ADMIN');
    sql(`update public.orl_users set password_hash=extensions.crypt(${literal(pw)},extensions.gen_salt('bf',4)) where id=${literal(users.WEBMASTER)}`);
    assert.equal(commit(p),p.p_request_id);
    assert.equal(sql(`set role service_role; select public.orl_ic_c1_confirm(${literal(users.ADMIN)},${literal(p.p_request_id)},${literal(p.p_generation)})`),'APPROVED');
    const day=crypto.randomUUID(),from=crypto.randomUUID(),to=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2097-01-04','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values
      (${literal(from)},${literal(day)},'MAIN',1,'AVAILABLE'),(${literal(to)},${literal(day)},'SPECIAL',1,'AVAILABLE')`);
    assert.equal(sql(`set role service_role; select public.orl_ic_c1_assign(${literal(users.ADMIN)},${literal(p.p_request_id)},
      ${literal(from)},${literal(p.p_generation)},${literal(p.p_generation)})`),'CONFIRMED');
    const gen=()=>sql('select generation from orl_private.c1_restore_generation');
    assert.equal(sql(`set role service_role; select public.orl_ic_c1_clear(${literal(users.ADMIN)},${literal(from)},${literal(p.p_request_id)},${literal(gen())})`),'CLEARED');
    assert.equal(sql(`select status from public.orl_requests where id=${literal(p.p_request_id)}`),'APPROVED');
    assert.equal(sql(`set role service_role; select public.orl_ic_c1_assign(${literal(users.ADMIN)},${literal(p.p_request_id)},${literal(from)},${literal(gen())},${literal(gen())})`),'CONFIRMED');
    const mutate=(op,destination)=>{const version=sql(`select updated_at from public.orl_requests where id=${literal(p.p_request_id)}`);return sql(`set role service_role; select public.orl_ic_c1_mutate(
      ${literal(users.WEBMASTER)},${literal(op)},${literal(from)},${literal(destination)},${literal(p.p_request_id)},
      ${json({diagnosis:'GATED TEST',...(op==='EDIT'?{postpone_count:'4'}:{})})},'CONFIRM','Synthetic move','KEEP',null,null,${literal(gen())},
      ${literal(version)})`)};
    assert.equal(mutate('EDIT',null),'UPDATED');
    assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(p.p_request_id)}`),'4');
    mutate('MOVE',to);
    assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(p.p_request_id)}`),'5');
    assert.equal(sql(`select request_id from public.orl_ot_slots where id=${literal(to)}`),p.p_request_id);
    assert.equal(sql(`set role service_role; select public.orl_ic_c1_reassign(${literal(users.WEBMASTER)},
      ${literal(to)},${literal(from)},${literal(p.p_request_id)},null,${literal(gen())})`),'REASSIGNED');
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(p.p_request_id)}`),from);
    const exported=JSON.parse(sql(`set role service_role; select public.orl_ic_c1_export(${literal(users.WEBMASTER)},${literal(pw)})`));
    assert.equal(exported.version,2);
    assert.ok(exported.identities.some(i=>i.request_id===p.p_request_id));
    sql(`set role service_role; select public.orl_ic_c1_import(${literal(users.WEBMASTER)},${literal(pw)},${json(exported)})`);
    assert.equal(sql(`select diagnosis from public.orl_requests where id=${literal(p.p_request_id)}`),'GATED TEST');
    assert.equal(sql(`set role service_role; select public.orl_ic_c1_remove(${literal(users.WEBMASTER)},${literal(pw)},
      'REQUEST',${literal(p.p_request_id)},${literal(gen())},array[${literal(p.p_request_id)}]::uuid[])`),'1');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id=${literal(p.p_request_id)}`),'0');
    assert.equal(sql(`select outcome from orl_private.c1_creation_receipts where request_id=${literal(p.p_request_id)}`),'CREATED');
  });
}
