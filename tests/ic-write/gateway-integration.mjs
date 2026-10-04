import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {runAssignmentTests} from './assignment-integration.mjs';
import {runReviewTests} from './review-integration.mjs';
import {runClearTests} from './clear-integration.mjs';
import {runDeletionTests} from './deletion-integration.mjs';
import {runControlTests,installControls} from './controls-integration.mjs';
import {installRepairExposure,runRepairExposureTests} from './repair-exposure.mjs';
import {installUx,runUxTests} from './ux.mjs';
import { createIcGateway } from '../../security/candidates/c1-create/gateway.mjs';
import { createIcTransport, createPendingCreation } from '../../security/candidates/c1-create/browser.mjs';
import { createIdentityCrypto } from '../../supabase/functions/_shared/ic-crypto.mjs';

export async function runGatewayTests({ t, sql, parallelSql, literal, json, users, keys, payload }) {
  sql(readFileSync(new URL('./gateway.sql', import.meta.url), 'utf8'));
  installControls(sql);
  installRepairExposure(sql);
  installUx(sql);
  const password = crypto.randomUUID();
  sql(`update public.orl_users set password_hash=extensions.crypt(${literal(password)},extensions.gen_salt('bf',4)) where id=${literal(users.WEBMASTER)}`);
  const argumentsByName = {
    orl_ic_c1_authorize: ['p_session_token'], orl_ic_c1_check_password: ['p_session_token', 'p_password'],
    orl_ic_c1_control_view:['p_session_token','p_scope','p_id','p_generation'],
    orl_ic_c1_control:['p_session_token','p_action','p_id','p_data','p_generation','p_revision'],
    orl_ic_c1_repair_view:['p_session_token','p_generation'],
    orl_ic_c1_repair:['p_session_token','p_password','p_generation','p_revision'],
    orl_ic_c1_unscheduled_count:['p_session_token','p_request_id','p_count','p_expected_version','p_generation'],
    orl_ic_c1_create: ['p_session_token', 'p_request_id', 'p_data', 'p_envelope', 'p_search', 'p_generation'],
    orl_ic_c1_prepare_create: ['p_session_token'],
    orl_ic_c1_confirm: ['p_session_token','p_request_id','p_generation'],
    orl_ic_c1_assign: ['p_session_token','p_request_id','p_slot_id','p_generation','p_slot_generation'],
    orl_ic_c1_review: ['p_session_token','p_request_id','p_action','p_note','p_expected_slot','p_generation'],
    orl_ic_c1_clear: ['p_session_token','p_slot_id','p_expected_request_id','p_generation'],
    orl_ic_c1_deletion: ['p_session_token','p_operation','p_request_id','p_expected_slot','p_expected_version','p_generation','p_reason'],
    orl_ic_c1_reassign: ['p_session_token','p_from','p_to','p_expected_from_request_id','p_expected_to_request_id','p_generation'],
    orl_ic_c1_remove: ['p_session_token', 'p_password', 'p_mode', 'p_value', 'p_generation', 'p_expected_ids'],
    orl_ic_c1_resolve_create: ['p_session_token', 'p_request_id'],
    orl_ic_c1_mutate: ['p_session_token', 'p_operation', 'p_from_slot', 'p_to_slot', 'p_expected_request', 'p_data', 'p_action', 'p_reason', 'p_ic_mode', 'p_envelope', 'p_search', 'p_generation', 'p_expected_version'],
    orl_ic_c1_export: ['p_session_token', 'p_password'], orl_ic_c1_import: ['p_session_token', 'p_password', 'p_backup'],
  };
  const rpc = async (name, args) => {
    assert.ok(Object.hasOwn(argumentsByName, name));
    const values = argumentsByName[name].map(k => k==='p_expected_ids'?`array[${args[k].map(literal).join(',')}]::uuid[]`:['p_data', 'p_envelope', 'p_search', 'p_backup'].includes(k) ? json(args[k]) : literal(args[k]));
    return JSON.parse(sql(`set role service_role; select to_jsonb(public.${name}(${values.join(',')}))`));
  };
  const gateway = createIcGateway({ enabled: true, origins: ['https://nazmiadnan92.github.io'], rpc, cryptoConfig: () => keys, rateLimit: async () => true });
  const client = who => createIcTransport({ baseUrl: 'https://synthetic.supabase.co', publishableKey: 'sb_publishable_SYNTHETIC',
    session: () => users[who], fetchImpl: async (url, init) => gateway(new Request(url, init)) });

  await runAssignmentTests({t,sql,parallelSql,literal,users,payload,client,password});
  await runReviewTests({t,sql,parallelSql,literal,users,payload,client,password});
  await runClearTests({t,sql,parallelSql,literal,users,payload,client,password});
  await runDeletionTests({t,sql,parallelSql,literal,users,payload,client,password});
  await runControlTests({t,sql,parallelSql,literal,json,users,payload,client,password});
  await runRepairExposureTests({t,sql,parallelSql,literal,users,password,payload});
  await runUxTests({t,sql,literal,users,payload,commit:p=>sql(`set role service_role;select public.orl_ic_c1_create(${literal(p.p_session_token)},${literal(p.p_request_id)},${json(p.p_data)},${json(p.p_envelope)},${json(p.p_search)},${literal(p.p_generation)})`)});
  await t.test('browser transport → gateway → actual SQL creates and edits using checked identity path', async () => {
    const input = await payload('ADMIN');
    const prepared=await client('ADMIN')('PREPARE_CREATE',{});
    assert.deepEqual(await client('ADMIN')('CREATE', { request_id: input.p_request_id, generation:prepared.generation, data: input.p_data }), { request_id: input.p_request_id });
    const recovered = await client('ADMIN')('RESOLVE_CREATE', { request_id: input.p_request_id });
    assert.deepEqual(recovered, { request_id: input.p_request_id, outcome: 'CREATED', status: 'DRAFT', assigned: false });
    await assert.rejects(client('STAFF')('RESOLVE_CREATE', { request_id: input.p_request_id }), /unconfirmed/);
    const session = crypto.randomUUID(), slot = crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(session)},'2096-04-05','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status)
        values(${literal(slot)},${literal(session)},'MAIN',1,${literal(input.p_request_id)},'CONFIRMED');
      update public.orl_requests set assigned_slot_id=${literal(slot)},status='SCHEDULED' where id=${literal(input.p_request_id)}`);
    const expected_version=sql(`select to_jsonb(updated_at)#>>'{}' from public.orl_requests where id=${literal(input.p_request_id)}`);
    assert.deepEqual(await client('ADMIN')('EDIT', { from_slot: slot, expected_request: input.p_request_id,
      expected_version,generation:input.p_generation, ic_mode: 'SET', data: { patient_ic: 'GATEWAY-SYNTHETIC-222' }, action: 'CONFIRM' }), { result: 'UPDATED' });
    assert.equal(sql(`select patient_ic from public.orl_requests where id=${literal(input.p_request_id)}`), 'GATEWAY-SYNTHETIC-222');
    await assert.rejects(client('STAFF')('EDIT', { from_slot: slot, expected_request: input.p_request_id,
      expected_version,generation:input.p_generation, ic_mode: 'SET', data: { patient_ic: 'DENIED' }, action: 'CONFIRM' }), /Admin or Webmaster/);
  });
  await t.test('protected Confirm preserves all-role status rules, ownership and rejects repeat/revoked confirmation without changing identities',async()=>{
    for(const who of ['STAFF','ADMIN','WEBMASTER']) {
      const p=await payload(who);await client(who)('CREATE',{request_id:p.p_request_id,generation:p.p_generation,data:p.p_data});
      const body={request_id:p.p_request_id,generation:p.p_generation};
      const before=sql('select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i');
      if(who!=='STAFF')await assert.rejects(client('STAFF')('CONFIRM',body),/Check Previous Save/);
      assert.equal((await client(who)('CONFIRM',body)).result,who==='STAFF'?'CONFIRMED':'APPROVED');
      await assert.rejects(client(who)('CONFIRM',body),/Check Previous Save/);
      assert.equal(sql(`select count(*) from public.orl_audit_log where action='REQUEST_CONFIRMED' and record_id=${literal(p.p_request_id)}`),'1');
      assert.equal(sql('select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i'),before);
    }
    for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_confirm(uuid,uuid,uuid)','EXECUTE')`),'f');
    const p=await payload('STAFF');await client('STAFF')('CREATE',{request_id:p.p_request_id,generation:p.p_generation,data:p.p_data});
    sql(`update public.orl_users set must_change_password=true where id=${literal(users.STAFF)}`);
    try{assert.throws(()=>sql(`set role service_role; select public.orl_ic_c1_confirm(${literal(users.STAFF)},${literal(p.p_request_id)},${literal(p.p_generation)})`))}
    finally{sql(`update public.orl_users set must_change_password=false where id=${literal(users.STAFF)}`)}
    assert.equal(sql(`select status from public.orl_requests where id=${literal(p.p_request_id)}`),'DRAFT');
    const attempts=await Promise.all([1,2].map(()=>parallelSql(`set role service_role; select public.orl_ic_c1_confirm(
      ${literal(users.STAFF)},${literal(p.p_request_id)},${literal(p.p_generation)})`)));
    assert.equal(attempts.filter(x=>!x.error).length,1);
    assert.equal(sql(`select count(*) from public.orl_audit_log where action='REQUEST_CONFIRMED' and record_id=${literal(p.p_request_id)}`),'1');
  });

  await t.test('Confirm uses original creation/recovery generation across Restore; final audit failure rolls back and lost response is recoverable',async()=>{
    const p=await payload('ADMIN'),store=new Map(),calls=[];
    let lost=false;
    const options={storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
      key:'synthetic-confirm',newId:()=>p.p_request_id,session:()=>users.ADMIN,withLock:fn=>fn(),send:async(op,data)=>{
        calls.push(op);const result=await client('ADMIN')(op,data);
        if(lost&&op==='CONFIRM')throw Error('Synthetic lost success');return result;
      }};
    const first=createPendingCreation(options);await first.create(p.p_data);
    const {backup}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    await assert.rejects(first.confirm(p.p_request_id),/Check Previous Save/);
    assert.equal(sql(`select status from public.orl_requests where id=${literal(p.p_request_id)}`),'DRAFT');
    const afterReload=createPendingCreation(options),reviewed=await afterReload.resolve();
    // A Restore after the recovery panel was reviewed must also invalidate Confirm.
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    await assert.rejects(afterReload.confirm(p.p_request_id,reviewed.generation),/Check Previous Save/);
    await afterReload.resolve();
    sql(`create function public.c1_test_confirm_audit_failure() returns trigger language plpgsql as $$begin
      if new.action='REQUEST_CONFIRMED' then raise exception 'Synthetic confirmation audit failure'; end if; return new; end $$;
      create trigger c1_test_confirm_audit_failure before insert on public.orl_audit_log
      for each row execute function public.c1_test_confirm_audit_failure()`);
    try{await assert.rejects(afterReload.confirm(p.p_request_id));assert.equal(sql(`select status from public.orl_requests where id=${literal(p.p_request_id)}`),'DRAFT')}
    finally{sql('drop trigger c1_test_confirm_audit_failure on public.orl_audit_log; drop function public.c1_test_confirm_audit_failure()')}
    await afterReload.resolve();lost=true;await assert.rejects(afterReload.confirm(p.p_request_id),/lost success/);
    assert.equal(afterReload.pending(),p.p_request_id);
    const attempts=calls.filter(op=>op==='CONFIRM').length;
    await assert.rejects(afterReload.confirm(p.p_request_id),/Check Previous Save/);
    assert.equal(calls.filter(op=>op==='CONFIRM').length,attempts);
    const recovered=await createPendingCreation(options).resolve();assert.equal(recovered.status,'APPROVED');
    assert.equal(sql(`select count(*) from public.orl_audit_log where action='REQUEST_CONFIRMED' and record_id=${literal(p.p_request_id)}`),'1');
    assert.equal(calls.filter(op=>op==='CREATE').length,1,'Recovery never creates another patient');
  });

  await t.test('full gateway backup/restore verifies real encrypted rows and rechecks Webmaster password', async () => {
    await assert.rejects(client('ADMIN')('BACKUP_EXPORT', { password }), /Webmaster/);
    await assert.rejects(client('WEBMASTER')('BACKUP_EXPORT', { password: 'wrong' }), /verification failed/);
    const { backup } = await client('WEBMASTER')('BACKUP_EXPORT', { password });
    assert.ok(backup.identities.length > 0);
    const corrupted = structuredClone(backup); corrupted.identities[0].envelope.ciphertext = 'AA==';
    await assert.rejects(client('WEBMASTER')('BACKUP_RESTORE', { password, backup: corrupted }), /No restore was started/);
    const result = await client('WEBMASTER')('BACKUP_RESTORE', { password, backup });
    assert.equal(result.result.status, 'COMPLETED'); assert.equal(result.result.identities, backup.identities.length);
    for (const fn of ['orl_ic_c1_authorize(uuid)', 'orl_ic_c1_check_password(uuid,text)'])
      for (const role of ['anon', 'authenticated']) assert.equal(sql(`select has_function_privilege('${role}','public.${fn}','EXECUTE')`), 'f');
  });
  await t.test('genuine SQL V1 export → authorized conversion → encrypted file → separate protected restore preserves records',async()=>{
    const backup=JSON.parse(sql(`select public.orl_db_export(${literal(users.WEBMASTER)},${literal(password)})`));
    assert.equal(backup.version,1);
    const original=structuredClone(backup);
    const snapshot=()=>sql(`select jsonb_build_object(
      'requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),
      'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),
      'receipts',(select jsonb_agg(to_jsonb(c) order by request_id) from orl_private.c1_creation_receipts c),
      'generation',(select generation from orl_private.c1_restore_generation))`);
    const before=snapshot();
    // Non-Webmasters also have a smaller upload cap. Use a small valid file here
    // to exercise the role denial instead of hitting that earlier size guard.
    const deniedBackup={format:'ORLOMS_BACKUP',version:1,requests:[],users:[],settings:[],holidays:[],ot_sessions:[],ot_slots:[],audit_log:[]};
    await assert.rejects(client('STAFF')('BACKUP_CONVERT',{password,backup:deniedBackup}),/Webmaster/);
    await assert.rejects(client('ADMIN')('BACKUP_CONVERT',{password,backup:deniedBackup}),/Webmaster/);
    await assert.rejects(client('WEBMASTER')('BACKUP_CONVERT',{password:'wrong',backup}),/verification failed/);
    const {backup:converted}=await client('WEBMASTER')('BACKUP_CONVERT',{password,backup});
    assert.equal(snapshot(),before,'Conversion must leave clinical/private database state unchanged');
    assert.deepEqual(backup,original);assert.deepEqual(converted.creation_receipts,[]);
    for(let i=0;i<backup.requests.length;i++){
      const {ic_protected,creation_tracked,...row}=converted.requests[i];
      assert.deepEqual(row,backup.requests[i]);assert.equal(creation_tracked,false);
    }
    const app=readFileSync(new URL('../../docs/app.js',import.meta.url),'utf8');
    const lines=app.split(/\r?\n/).filter(x=>/^async function (backupKey|streamBytes|decodeBackup|encodeBackup)\(/.test(x));
    assert.equal(lines.length,4);
    const codec=vm.createContext({crypto,TextEncoder,TextDecoder,Uint8Array,Blob,Response,CompressionStream,DecompressionStream});
    vm.runInContext(lines.join('\n'),codec);
    const phrase='SYNTHETIC-'+crypto.randomUUID(),file=await codec.encodeBackup(converted,phrase);
    await assert.rejects(codec.decodeBackup(file,'wrong'),/passphrase or damaged/);
    const opened=await codec.decodeBackup(file,phrase);
    assert.equal(snapshot(),before,'File creation/opening must not restore');
    const restored=await client('WEBMASTER')('BACKUP_RESTORE',{password,backup:opened});
    assert.equal(restored.result.status,'COMPLETED');
    const roundtrip=await rpc('orl_ic_c1_export',{p_session_token:users.WEBMASTER,p_password:password});
    const engine=await createIdentityCrypto(keys);
    for(const identity of roundtrip.identities){
      const record=roundtrip.requests.find(r=>r.id===identity.request_id);
      assert.ok(record?.ic_protected,'Re-export must link every restored identity');
      const raw=await engine.decrypt(identity.envelope,identity.request_id);
      assert.equal(raw===record.patient_ic,true,'Restored ciphertext must match the exact IC');
      assert.equal((await engine.searchHash(raw,identity.search.key_id)).hash===identity.search.hash,true,'Restored search hash must match');
    }
    for(const record of roundtrip.requests){
      assert.equal(record.ic_protected,roundtrip.identities.some(i=>i.request_id===record.id));
      assert.equal(record.creation_tracked,roundtrip.creation_receipts.some(c=>c.request_id===record.id));
    }
    const {backup:after}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    const fields=rows=>rows.map(r=>({id:r.id,ic:r.patient_ic,age:r.age,months:r.age_months,creator:r.created_by,booker:r.booked_by_name}))
      .sort((a,b)=>a.id.localeCompare(b.id));
    assert.deepEqual(fields(after.requests),fields(backup.requests));
    assert.equal(after.identities.length,backup.requests.filter(r=>r.patient_ic!=='').length);
    assert.ok(after.creation_receipts.length>0,'Existing local recovery receipts survive legacy conversion restore');
  });
  const makeRemovalRecord=async()=>{
    const input=await payload('ADMIN');
    await client('ADMIN')('CREATE',{request_id:input.p_request_id,generation:input.p_generation,data:input.p_data});
    return input.p_request_id;
  };
  const removalSnapshot=()=>sql(`select jsonb_build_object(
    'requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),
    'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),
    'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),
    'receipts',(select jsonb_agg(to_jsonb(c) order by request_id) from orl_private.c1_creation_receipts c),
    'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a))`);
  await t.test('browser → gateway → removal SQL deletes only selected request/MRN identities, releases slot and preserves recovery/audit',async()=>{
    const a=await makeRemovalRecord(),b=await makeRemovalRecord(),c=await makeRemovalRecord(),keep=await makeRemovalRecord();
    const ot=crypto.randomUUID(),slot=crypto.randomUUID(),mrn='SYNTHETIC-GROUP-'+crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(ot)},'2095-04-03','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status)
      values(${literal(slot)},${literal(ot)},'MAIN',1,${literal(a)},'CONFIRMED');
      update public.orl_requests set assigned_slot_id=${literal(slot)},status='SCHEDULED' where id=${literal(a)};
      update public.orl_requests set mrn=${literal(mrn)} where id in(${literal(b)},${literal(c)})`);
    const generation=sql('select generation from orl_private.c1_restore_generation');
    const body={password,mode:'REQUEST',value:a,generation,expected_ids:[a]},before=removalSnapshot();
    for(const role of ['STAFF','ADMIN'])await assert.rejects(client(role)('REMOVE',body),/Webmaster/);
    await assert.rejects(client('WEBMASTER')('REMOVE',{...body,password:'wrong'}),/verification failed/);
    assert.equal(removalSnapshot(),before);
    assert.deepEqual(await client('WEBMASTER')('REMOVE',body),{result:1});
    assert.equal(sql(`select status from public.orl_ot_slots where id=${literal(slot)}`),'AVAILABLE');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id=${literal(a)}`),'0');
    assert.ok(Number(sql(`select count(*) from public.orl_audit_log where record_id=${literal(a)} and action='REQUEST_CREATED'`))>0);
    assert.equal((await client('ADMIN')('RESOLVE_CREATE',{request_id:a})).outcome,'UNAVAILABLE');
    assert.deepEqual(await client('WEBMASTER')('REMOVE',{password,mode:'MRN',value:' '+mrn.toLowerCase()+' ',generation,expected_ids:[b,c]}),{result:2});
    assert.equal(sql(`select count(*) from public.orl_requests where id in(${literal(a)},${literal(b)},${literal(c)})`),'0');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id in(${literal(b)},${literal(c)})`),'0');
    assert.equal(sql(`select count(*) from orl_private.c1_creation_receipts where request_id in(${literal(a)},${literal(b)},${literal(c)})`),'3');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id=${literal(keep)}`),'1');
  });
  await t.test('gateway removal rollback/revocation preserves data; lost success response does not retry or resurrect deleted request',async()=>{
    const id=await makeRemovalRecord(),body={password,mode:'REQUEST',value:id,generation:sql('select generation from orl_private.c1_restore_generation'),expected_ids:[id]},before=removalSnapshot();
    sql(`create function orl_private.c1_http_delete_failure() returns trigger language plpgsql as $$ begin raise exception 'Synthetic failure'; end $$;
      create trigger c1_http_delete_failure before delete on public.orl_requests for each row execute function orl_private.c1_http_delete_failure()`);
    try{await assert.rejects(client('WEBMASTER')('REMOVE',body),/do not repeat blindly/);assert.equal(removalSnapshot(),before)}
    finally{sql('drop trigger c1_http_delete_failure on public.orl_requests; drop function orl_private.c1_http_delete_failure()')}
    let mode='revoke',attempts=0;
    const guarded=createIcGateway({enabled:true,origins:[],cryptoConfig:()=>assert.fail('No removal keys'),rateLimit:async()=>true,rpc:async(name,args)=>{
      if(name!=='orl_ic_c1_remove')return rpc(name,args);
      attempts++;
      if(mode==='revoke')sql(`update public.orl_users set must_change_password=true where id=${literal(users.WEBMASTER)}`);
      const result=await rpc(name,args);
      if(mode==='lost')throw Error('Synthetic lost response after committed deletion');
      return result;
    }});
    const send=createIcTransport({baseUrl:'https://synthetic.supabase.co',publishableKey:'sb_publishable_SYNTHETIC',
      session:()=>users.WEBMASTER,fetchImpl:(url,init)=>guarded(new Request(url,init))});
    try{await assert.rejects(send('REMOVE',body),/do not repeat blindly/);assert.equal(removalSnapshot(),before)}
    finally{sql(`update public.orl_users set must_change_password=false where id=${literal(users.WEBMASTER)}`)}
    mode='lost';attempts=0;await assert.rejects(send('REMOVE',body),/do not repeat blindly/);assert.equal(attempts,1);
    assert.equal(sql(`select count(*) from public.orl_requests where id=${literal(id)}`),'0');
    assert.equal(sql(`select count(*) from orl_private.request_identity where request_id=${literal(id)}`),'0');
    assert.equal((await client('ADMIN')('RESOLVE_CREATE',{request_id:id})).outcome,'UNAVAILABLE');
  });
  await t.test('protected Reassign swaps occupied Main/Special and empty slots without changing identities; stale selection cannot repeat',async()=>{
    const a=await makeRemovalRecord(),b=await makeRemovalRecord(),day=crypto.randomUUID(),from=crypto.randomUUID(),to=crypto.randomUUID(),empty=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2093-04-01','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status) values
      (${literal(from)},${literal(day)},'MAIN',1,${literal(a)},'CONFIRMED'),
      (${literal(to)},${literal(day)},'SPECIAL',1,${literal(b)},'CONFIRMED'),
      (${literal(empty)},${literal(day)},'SPECIAL',2,null,'AVAILABLE');
      update public.orl_requests set assigned_slot_id=case id when ${literal(a)} then ${literal(from)}::uuid else ${literal(to)}::uuid end,
      status='SCHEDULED' where id in(${literal(a)},${literal(b)})`);
    const identities=()=>sql('select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i');
    const encrypted=identities(),body={from_slot:from,to_slot:to,expected_from:a,expected_to:b,
      generation:sql('select generation from orl_private.c1_restore_generation')};
    const before=removalSnapshot();
    await assert.rejects(client('STAFF')('REASSIGN',body),/Admin access/);assert.equal(removalSnapshot(),before);
    for(const role of ['anon','authenticated'])
      assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE')`),'f');
    assert.deepEqual(await client('ADMIN')('REASSIGN',body),{result:'REASSIGNED'});
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(a)}`),to);
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(b)}`),from);
    const swapped=removalSnapshot();
    await assert.rejects(client('ADMIN')('REASSIGN',body),/do not repeat blindly/);
    assert.equal(removalSnapshot(),swapped,'No automatic swap back on stale submission');
    await client('WEBMASTER')('REASSIGN',{...body,from_slot:to,to_slot:empty,expected_to:null});
    assert.equal(sql(`select request_id is null and status='AVAILABLE' from public.orl_ot_slots where id=${literal(to)}`),'t');
    assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${literal(a)}`),empty);
    const attempts=await Promise.all([[to,null],[from,b]].map(([target,expected])=>parallelSql(
      `set role service_role; select public.orl_ic_c1_reassign(${literal(users.ADMIN)},${literal(empty)},${literal(target)},
      ${literal(a)},${literal(expected)},${literal(body.generation)})`)));
    assert.equal(attempts.filter(x=>!x.error).length,1,'Two competing reassignments of the same patient cannot both commit');
    assert.equal(sql(`select count(*) from public.orl_requests r where r.id in(${literal(a)},${literal(b)})
      and exists(select 1 from public.orl_ot_slots s where s.id=r.assigned_slot_id and s.request_id=r.id)`),'2');
    assert.equal(identities(),encrypted,'Reassign must not re-encrypt, detach or swap request identities');
  });

  await t.test('Reassign rejects old generation after real Restore and failure in final audit rolls back both slot links',async()=>{
    const id=await makeRemovalRecord(),day=crypto.randomUUID(),from=crypto.randomUUID(),to=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2093-04-02','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status) values
      (${literal(from)},${literal(day)},'MAIN',1,${literal(id)},'CONFIRMED'),
      (${literal(to)},${literal(day)},'SPECIAL',1,null,'AVAILABLE');
      update public.orl_requests set assigned_slot_id=${literal(from)},status='SCHEDULED' where id=${literal(id)}`);
    const body={from_slot:from,to_slot:to,expected_from:id,expected_to:null,generation:sql('select generation from orl_private.c1_restore_generation')};
    const {backup}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    const before=removalSnapshot();
    await assert.rejects(client('ADMIN')('REASSIGN',body),/do not repeat blindly/);assert.equal(removalSnapshot(),before);
    const fresh={...body,generation:sql('select generation from orl_private.c1_restore_generation')};
    sql(`create function public.c1_test_reassign_audit_failure() returns trigger language plpgsql as $$begin
      if new.action='OT_SLOT_REASSIGNED' then raise exception 'Synthetic final audit failure'; end if; return new; end $$;
      create trigger c1_test_reassign_audit_failure before insert on public.orl_audit_log
      for each row execute function public.c1_test_reassign_audit_failure()`);
    try{await assert.rejects(client('ADMIN')('REASSIGN',fresh),/do not repeat blindly/);assert.equal(removalSnapshot(),before)}
    finally{sql('drop trigger c1_test_reassign_audit_failure on public.orl_audit_log; drop function public.c1_test_reassign_audit_failure()')}
    sql(`update public.orl_ot_slots set status='CLOSED' where id=${literal(to)}`);
    const closed=removalSnapshot();
    await assert.rejects(client('ADMIN')('REASSIGN',fresh),/do not repeat blindly/);assert.equal(removalSnapshot(),closed);
    sql(`update public.orl_ot_slots set status='AVAILABLE' where id=${literal(to)}`);
    assert.equal((await client('ADMIN')('REASSIGN',fresh)).result,'REASSIGNED');
  });

  await t.test('actual Restore fences delayed EDIT, MOVE and both removal modes even when the same request/slot IDs return',async()=>{
    const id=await makeRemovalRecord(),ot=crypto.randomUUID(),from=crypto.randomUUID(),to=crypto.randomUUID();
    sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(ot)},'2094-05-02','Synthetic');
      insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status) values
      (${literal(from)},${literal(ot)},'MAIN',1,${literal(id)},'CONFIRMED'),
      (${literal(to)},${literal(ot)},'SPECIAL',1,null,'AVAILABLE');
      update public.orl_requests set assigned_slot_id=${literal(from)},status='SCHEDULED' where id=${literal(id)}`);
    const generation=sql('select generation from orl_private.c1_restore_generation');
    const expected_version=sql(`select to_jsonb(updated_at)#>>'{}' from public.orl_requests where id=${literal(id)}`);
    const edit={from_slot:from,expected_request:id,expected_version,ic_mode:'KEEP',data:{diagnosis:'DELAYED CHANGE'},action:'CONFIRM',generation};
    const move={from_slot:from,to_slot:to,expected_request:id,expected_version,ic_mode:'KEEP',data:{},reason:'Synthetic move',generation};
    const removal={password,mode:'REQUEST',value:id,generation,expected_ids:[id]};
    const mrn=sql(`select mrn from public.orl_requests where id=${literal(id)}`);
    const {backup}=await client('WEBMASTER')('BACKUP_EXPORT',{password});
    assert.equal((await client('WEBMASTER')('BACKUP_RESTORE',{password,backup})).result.status,'COMPLETED');
    const before=removalSnapshot();
    await assert.rejects(client('ADMIN')('EDIT',edit),/Reload the schedule/);
    await assert.rejects(client('WEBMASTER')('EDIT',{...edit,data:{...edit.data,postpone_count:'4'}}),/Reload the schedule/);
    await assert.rejects(client('ADMIN')('MOVE',move),/Reload the schedule/);
    await assert.rejects(client('WEBMASTER')('REMOVE',removal),/do not repeat blindly/);
    await assert.rejects(client('WEBMASTER')('REMOVE',{...removal,mode:'MRN',value:mrn}),/do not repeat blindly/);
    assert.equal(removalSnapshot(),before,'All stale attempts must leave records, slots, identity, receipts and audit unchanged');
    const fresh=(await client('ADMIN')('PREPARE_CREATE',{})).generation;
    assert.notEqual(fresh,generation);
    assert.equal((await client('ADMIN')('EDIT',{...edit,generation:fresh})).result,'UPDATED');
    const afterEdit=sql(`select to_jsonb(updated_at)#>>'{}' from public.orl_requests where id=${literal(id)}`);
    assert.equal((await client('WEBMASTER')('EDIT',{...edit,generation:fresh,expected_version:afterEdit,data:{...edit.data,postpone_count:'4'}})).result,'UPDATED');
    assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(id)}`),'4');
    const afterCount=sql(`select to_jsonb(updated_at)#>>'{}' from public.orl_requests where id=${literal(id)}`);
    assert.ok(['CONFIRMED','RESERVED'].includes((await client('ADMIN')('MOVE',{...move,generation:fresh,expected_version:afterCount})).result));
    assert.equal(sql(`select postpone_count from public.orl_requests where id=${literal(id)}`),'5');
    for(const old of ['orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb)',
      'orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid)','orl_ic_c1_remove(uuid,text,text,text)'])
      assert.equal(sql(`select to_regprocedure(${literal('public.'+old)}) is null`),'t','No unfenced overload may remain');
  });
  await t.test('removal refuses expanded or reduced MRN target set, null/duplicate snapshots, and accepts fresh exact targets',async()=>{
    const a=await makeRemovalRecord(),b=await makeRemovalRecord(),group='SYNTHETIC-TARGET-'+crypto.randomUUID();
    sql(`update public.orl_requests set mrn=${literal(group)} where id in(${literal(a)},${literal(b)})`);
    const body={password,mode:'MRN',value:group,generation:sql('select generation from orl_private.c1_restore_generation'),expected_ids:[a]};
    const before=removalSnapshot();
    await assert.rejects(client('WEBMASTER')('REMOVE',body),/not confirmed/);
    await assert.rejects(client('WEBMASTER')('REMOVE',{...body,expected_ids:[a,b,crypto.randomUUID()]}),/not confirmed/);
    await assert.rejects(client('WEBMASTER')('REMOVE',{...body,expected_ids:[a,a]}),/Invalid removal/);
    await assert.rejects(client('WEBMASTER')('REMOVE',{...body,expected_ids:null}),/Invalid removal/);
    assert.equal(removalSnapshot(),before);
    assert.deepEqual(await client('WEBMASTER')('REMOVE',{...body,expected_ids:[b,a]}),{result:2});
  });
}
