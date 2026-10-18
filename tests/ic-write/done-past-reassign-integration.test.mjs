import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('067: completed past reordering is Webmaster-only, atomic, closure-preserving and cannot change lifecycle, clinical data or identity',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const database=process.env.ORL_IC_TEST_DATABASE||'postgres';assert.match(database,/^(?:postgres|orl_past_test_[a-z0-9_]+)$/);
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d',database,'-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v==null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const call=(name,p,role='service_role')=>`set role ${role};select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}));`;
 const rpc=(name,p,role)=>JSON.parse(sql(call(name,p,role)));
 const run=p=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+p,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const asyncSql=(input,onOutput=()=>{})=>new Promise((resolve,reject)=>{const child=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',d=>{output+=d;onOutput(output)});child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('close',code=>resolve({code,output,error}));child.stdin.end(input)});
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet or inet_server_port()<>55461 then raise exception 'Disposable local fixture only'; end if; end $$;");
 const core='public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)',wrapper='public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)';
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const denied=async(fn,label,expected)=>{const before=snapshot();await assert.rejects(async()=>fn(),expected?error=>expected.test(String(error.stderr||error.message)):undefined,label);assert.equal(snapshot(),before,'Rejected operation is atomic: '+label)};
 const oldDefinition=sql(`select pg_get_functiondef(${lit(core)}::regprocedure)`),boundary=sql(`select jsonb_build_array(proacl,proowner,prosecdef,proconfig) from pg_proc where oid=${lit(core)}::regprocedure`);
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(core)}::regprocedure`),'777efc10480acfbbfb44688322a370f5');
 const audit066=JSON.parse(run('security/release/audit-closed-past-reassign.sql'));assert.equal(Object.keys(audit066).length,13);for(const [name,ok] of Object.entries(audit066))assert.equal(ok,true,'066 baseline '+name);
 sql(oldDefinition.replace('  historical_date date;','  historical_date date; -- synthetic unreviewed drift'));
 await denied(()=>run('supabase/067_done_past_reassign.sql'),'Baseline drift rejected');sql(oldDefinition);
 const beforeInstall=snapshot();run('supabase/067_done_past_reassign.sql');assert.equal(snapshot(),beforeInstall,'Installation changes no patients, slots, identities or settings');
 assert.equal(sql(`select jsonb_build_array(proacl,proowner,prosecdef,proconfig) from pg_proc where oid=${lit(core)}::regprocedure`),boundary);
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(core)}::regprocedure`),'b32dcd4c6ecda6bfd6e2adba0d2248e6');
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(wrapper)}::regprocedure`),'2b4d1a321a41bed78ff559b3ec542d19');
 await denied(()=>run('supabase/067_done_past_reassign.sql'),'Already installed rejected');
 for(const role of ['anon','authenticated','service_role'])assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(core)},'EXECUTE')`),'f');
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(wrapper)},'EXECUTE')`),'f');
 assert.equal(sql(`select has_function_privilege('service_role',${lit(wrapper)},'EXECUTE')`),'t');
 const actors={};
 for(const role of ['STAFF','ADMIN','WEBMASTER']){const id=actors[role]=crypto.randomUUID();sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('done_'+role.toLowerCase()+'_'+id.slice(0,8))},'synthetic-unused',${lit('Synthetic '+role)},${lit(role)});
  insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`)}
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const [past,past2,today,future]=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-5,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-6,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+5)"));
 const sessions=new Map();let n=Math.max(12000,Number(sql('select coalesce(max(slot_number),0) from public.orl_ot_slots')));
 const session=date=>{if(!sessions.has(date)){sql(`insert into public.orl_ot_sessions(ot_date,day_name,status,holiday_override) values(${lit(date)},'Synthetic','ACTIVE',true) on conflict(ot_date) do nothing`);sessions.set(date,sql(`select id from public.orl_ot_sessions where ot_date=${lit(date)}`))}return sessions.get(date)};
 const slot=(date=past,type='MAIN',status='AVAILABLE')=>{const id=crypto.randomUUID();sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${lit(id)},${lit(session(date))},${lit(type)},${++n},${lit(status)})`);return id};
 const request=id=>JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${lit(id)}`));
 const slotState=id=>JSON.parse(sql(`select to_jsonb(sl) from public.orl_ot_slots sl where id=${lit(id)}`));
 const dayState=id=>sql(`select to_jsonb(s) from public.orl_ot_sessions s where id=${lit(id)}`);
 const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(id)}`);
 const frozen=id=>sql(`select to_jsonb(r)-array['assigned_slot_id','updated_at'] from public.orl_requests r where id=${lit(id)}`);
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32))),raw='900101-01-1234';
 const engine=await createIdentityCrypto({context:'synthetic-done-past',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const create=async(target,status='COMPLETED',hold=false,legacyDone=false)=>{
  const id=crypto.randomUUID();rpc('orl_ic_c1_create',{p_session_token:actors.STAFF,p_request_id:id,p_data:{patient_name:'Synthetic completed case',mrn:'DONE-'+id,age:'36',age_months:'1',diagnosis:'Synthetic diagnosis',surgery:'Synthetic procedure',doctor:'Synthetic doctor',specialist:'Synthetic specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic completed remark',patient_ic:raw},p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation});
  sql(`update public.orl_requests set assigned_slot_id=${lit(target)},status=${lit(status)},postpone_count=7,postpone_history='[{"reason":"Synthetic historical delay"}]'::jsonb where id=${lit(id)};
   update public.orl_ot_slots set request_id=${lit(id)},status=${lit(status==='CONFIRMED'?'RESERVED':'CONFIRMED')} where id=${lit(target)}`);
  if(status==='COMPLETED'&&!legacyDone)sql(`update public.orl_requests set completed_at='2026-01-01T12:00:00+08',completed_by=${lit(actors.ADMIN)} where id=${lit(id)}`);
  if(hold)sql(`update public.orl_requests set ot_hold=true,ot_hold_reason='Synthetic awaiting new date',ot_hold_at=now(),ot_hold_by=${lit(actors.ADMIN)} where id=${lit(id)}`);return id;
 };
 const params=(from,to,role='WEBMASTER',extra={})=>({p_session_token:actors[role],p_from:from,p_to:to,p_expected_from_request_id:slotState(from).request_id,p_expected_to_request_id:slotState(to).request_id,p_generation:generation,...extra});
 const move=p=>rpc('orl_ic_c1_reassign',p);
 const source=slot(),target=slot(),done=await create(source),closed=slot(past,'SPECIAL','CLOSED'),activeSlot=slot(),active=await create(activeSlot,'SCHEDULED');
 for(const role of ['ADMIN','STAFF'])for(const p of [params(source,target,role),params(source,closed,role),params(activeSlot,source,role)])await denied(()=>move(p),role+' cannot reorder Done source or target');
 const selected=params(source,target);
 for(const extra of [{p_generation:crypto.randomUUID()},{p_generation:null},{p_expected_from_request_id:null},{p_expected_from_request_id:crypto.randomUUID()},{p_expected_to_request_id:crypto.randomUUID()},{p_to:source}])await denied(()=>move({...selected,...extra}),'Invalid or stale selection');
 const crossDate=slot(past2);await denied(()=>move(params(source,crossDate)),'Cross-date Done move denied');
 for(const date of [today,future]){const a=slot(date),b=slot(date),c=slot(date,'SPECIAL','CLOSED');await create(a);await denied(()=>move(params(a,b)),'Done today/future available target denied');await denied(()=>move(params(a,c)),'Done today/future closed target denied');await create(b,'SCHEDULED');await denied(()=>move(params(b,a)),'Done occupied target on today/future denied')}
 sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(activeSlot)}`);await denied(()=>move(params(source,activeSlot)),'Occupied CLOSED target denied');sql(`update public.orl_ot_slots set status='CONFIRMED' where id=${lit(activeSlot)}`);
 sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(source)}`);await denied(()=>move(params(source,target)),'Occupied CLOSED source denied');sql(`update public.orl_ot_slots set status='CONFIRMED' where id=${lit(source)}`);
 const emptyReserved=slot(past,'MAIN','RESERVED');await denied(()=>move(params(source,emptyReserved)),'Inconsistent empty RESERVED target denied');
 for(const [patient,patientSlot] of [[done,source],[active,activeSlot]]){
  sql(`update public.orl_requests set deletion_status='PENDING' where id=${lit(patient)}`);await denied(()=>move(params(source,activeSlot)),'Pending cancellation on either side denied');sql(`update public.orl_requests set deletion_status='',assigned_slot_id=null where id=${lit(patient)}`);
  await denied(()=>move(params(source,activeSlot)),'Broken reciprocal link on either side denied');sql(`update public.orl_requests set assigned_slot_id=${lit(patientSlot)} where id=${lit(patient)}`);
 }
 sql(`update public.orl_requests set status='CANCELLED' where id=${lit(active)}`);await denied(()=>move(params(source,activeSlot)),'Cancelled target denied');await denied(()=>move(params(activeSlot,source)),'Cancelled source denied');sql(`update public.orl_requests set status='SCHEDULED' where id=${lit(active)}`);
 sql("create function public.synthetic_067_audit_failure() returns trigger language plpgsql as $$begin if new.action='OT_SLOT_REASSIGNED' then raise exception 'Synthetic audit failure'; end if; return new; end $$;create trigger synthetic_067_audit_failure before insert on public.orl_audit_log for each row execute function public.synthetic_067_audit_failure();");
 await denied(()=>move(params(source,target)),'Audit failure rolls back Done move');sql('drop trigger synthetic_067_audit_failure on public.orl_audit_log;drop function public.synthetic_067_audit_failure();');
 // Done moves and both swap directions, including old Done records without metadata.
 for(const [fromStatus,toStatus,destStatus,legacy] of [
  ['COMPLETED',null,'AVAILABLE',false],['COMPLETED',null,'CLOSED',true],
  ['COMPLETED','SCHEDULED','AVAILABLE',false],['SCHEDULED','COMPLETED','AVAILABLE',false],
  ['COMPLETED','COMPLETED','AVAILABLE',true],['COMPLETED','CONFIRMED','AVAILABLE',false],['CONFIRMED','COMPLETED','AVAILABLE',false]
 ]){
  const a=slot(past,'MAIN'),b=slot(past,'SPECIAL',destStatus),first=await create(a,fromStatus,fromStatus==='SCHEDULED',legacy),second=toStatus?await create(b,toStatus,toStatus==='SCHEDULED',legacy):null;
  const frozenA=frozen(first),frozenB=second?frozen(second):null,icA=identity(first),icB=second?identity(second):null,aStatus=slotState(a).status,bStatus=slotState(b).status;
  sql(`update public.orl_ot_sessions set status='CANCELLED',note='Synthetic historical cancelled day' where id=${lit(session(past))}`);const beforeDay=dayState(session(past)),p=params(a,b);
  assert.equal(move(p),'REASSIGNED');assert.equal(frozen(first),frozenA);assert.equal(identity(first),icA);assert.equal(slotState(b).request_id,first);assert.equal(slotState(b).status,aStatus);assert.equal(request(first).assigned_slot_id,b);
  if(second){assert.equal(frozen(second),frozenB);assert.equal(identity(second),icB);assert.equal(slotState(a).request_id,second);assert.equal(slotState(a).status,bStatus);assert.equal(request(second).assigned_slot_id,a)}else{assert.equal(slotState(a).request_id,null);assert.equal(slotState(a).status,'CLOSED')}
  assert.equal(dayState(session(past)),beforeDay,'No parent day is reopened');
  const log=JSON.parse(sql(`select to_jsonb(a) from public.orl_audit_log a where action='OT_SLOT_REASSIGNED' and record_id=${lit(session(past))} order by id desc limit 1`)),detail=JSON.parse(log.details);
  assert.equal(log.user_id,actors.WEBMASTER);assert.equal(log.user_role,'WEBMASTER');assert.equal(detail.mode,'DONE_PAST_REASSIGN');assert.equal(detail.from_request_id,first);assert.equal(detail.to_request_id,second);assert.equal(detail.from_request_status,fromStatus);assert.equal(detail.to_request_status,toStatus);
  assert.equal(detail.from_slot_id,a);assert.equal(detail.to_slot_id,b);assert.equal(detail.source_status_after,second?bStatus:'CLOSED');assert.equal(detail.target_status_after,aStatus);assert.equal(log.details.includes(raw),false);assert.equal(log.details.includes('Synthetic completed case'),false);
  await denied(()=>move(p),'Old slot snapshot cannot replay a Done correction');
 }
 // Earlier066 unfinished exception and ordinary Admin/WM reassign keep their behavior.
 const unfinished=slot(),unfinishedTarget=slot(past,'SPECIAL','CLOSED'),unfinishedId=await create(unfinished,'SCHEDULED',true),unfinishedState=frozen(unfinishedId);
 await denied(()=>move(params(unfinished,unfinishedTarget,'ADMIN')),'066 Closed unfinished override remains WM-only');assert.equal(move(params(unfinished,unfinishedTarget)),'REASSIGNED');assert.equal(frozen(unfinishedId),unfinishedState);assert.equal(slotState(unfinished).status,'CLOSED');
 const oldAudit=JSON.parse(sql(`select details::jsonb from public.orl_audit_log where action='OT_SLOT_REASSIGNED' order by id desc limit 1`));assert.equal(oldAudit.mode,'CLOSED_PAST_REASSIGN');
 for(const [role,date] of [['ADMIN',past],['WEBMASTER',past],['ADMIN',future],['WEBMASTER',future]]){const a=slot(date),b=slot(date),r=await create(a,'SCHEDULED');assert.equal(move(params(a,b,role)),'REASSIGNED');assert.equal(request(r).assigned_slot_id,b);assert.equal(slotState(a).status,'AVAILABLE')}
 await denied(()=>rpc('orl_swap_slots_checked',{p_session_token:actors.WEBMASTER,p_from:source,p_to:target,p_expected_from_request_id:done,p_expected_to_request_id:null}),'Direct core access remains denied');
 const unassigned=await create(null,'APPROVED'),availablePast=slot();sql(`update public.orl_ot_sessions set status='ACTIVE',holiday_override=true where id=${lit(session(past))}`);
 await denied(()=>rpc('orl_ic_c1_assign',{p_session_token:actors.WEBMASTER,p_request_id:unassigned,p_slot_id:availablePast,p_generation:generation,p_slot_generation:generation}),'Normal past booking still rejected',/Past OT dates are closed to new bookings/);
 const staleSession=params(source,target);sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${lit(actors.WEBMASTER)}`);await denied(()=>move(staleSession),'Expired session denied');sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${lit(actors.WEBMASTER)}`);
 // Two submits cannot move the same Done patient twice or overwrite one destination.
 const raceSource=slot(),raceId=await create(raceSource),raceA=slot(),raceB=slot(past,'SPECIAL','CLOSED');
 const races=await Promise.all([asyncSql(call('orl_ic_c1_reassign',params(raceSource,raceA))),asyncSql(call('orl_ic_c1_reassign',params(raceSource,raceB)))]);assert.equal(races.filter(r=>r.code===0).length,1);assert.equal(races.filter(r=>r.code!==0).length,1);assert.equal(sql(`select count(*) from public.orl_ot_slots where request_id=${lit(raceId)}`),'1');assert.equal(request(raceId).status,'COMPLETED');assert.equal(slotState(raceSource).status,'CLOSED');
 const sharedDoneTarget=slot(),contenderA=slot(),contenderB=slot(),sharedDoneId=await create(sharedDoneTarget),contenderIdA=await create(contenderA,'SCHEDULED'),contenderIdB=await create(contenderB,'SCHEDULED');
 const beforeSharedDone=frozen(sharedDoneId),beforeSharedIdentity=identity(sharedDoneId);
 const targetRaces=await Promise.all([asyncSql(call('orl_ic_c1_reassign',params(contenderA,sharedDoneTarget))),asyncSql(call('orl_ic_c1_reassign',params(contenderB,sharedDoneTarget)))]);
 assert.equal(targetRaces.filter(r=>r.code===0).length,1);assert.equal(targetRaces.filter(r=>r.code!==0).length,1);assert.equal(frozen(sharedDoneId),beforeSharedDone);assert.equal(identity(sharedDoneId),beforeSharedIdentity);
 assert.equal(sql(`select count(*) from public.orl_ot_slots where request_id in(${lit(sharedDoneId)},${lit(contenderIdA)},${lit(contenderIdB)})`),'3','A contested Done swap cannot overwrite either patient');
 // Administrator saw an unfinished source, but concurrent completion commits first.
 const statusSource=slot(),statusTarget=slot(),statusId=await create(statusSource,'SCHEDULED'),oldSelection=params(statusSource,statusTarget,'ADMIN');
 let signal;const locked=new Promise(resolve=>signal=resolve);
 const changeStatus=asyncSql(`begin;update public.orl_requests set status='COMPLETED',completed_at=now(),completed_by=${lit(actors.WEBMASTER)} where id=${lit(statusId)};select 'STATUS_LOCKED';select pg_sleep(1);commit;`,output=>{if(output.includes('STATUS_LOCKED'))signal()});
 await Promise.race([locked,changeStatus.then(r=>assert.equal(r.code,0))]);const deniedStatus=await asyncSql(call('orl_ic_c1_reassign',oldSelection));assert.equal((await changeStatus).code,0);assert.notEqual(deniedStatus.code,0);assert.match(deniedStatus.error,/Only Webmaster/);assert.equal(request(statusId).assigned_slot_id,statusSource);assert.equal(slotState(statusTarget).request_id,null);
 const targetStatusSource=slot(),targetStatusTarget=slot(),targetStatusSourceId=await create(targetStatusSource,'SCHEDULED'),targetStatusTargetId=await create(targetStatusTarget,'SCHEDULED'),targetOldSelection=params(targetStatusSource,targetStatusTarget,'ADMIN');
 let targetSignal;const targetLocked=new Promise(resolve=>targetSignal=resolve);
 const completeTarget=asyncSql(`begin;update public.orl_requests set status='COMPLETED',completed_at=now(),completed_by=${lit(actors.WEBMASTER)} where id=${lit(targetStatusTargetId)};select 'TARGET_LOCKED';select pg_sleep(1);commit;`,output=>{if(output.includes('TARGET_LOCKED'))targetSignal()});
 await Promise.race([targetLocked,completeTarget.then(r=>assert.equal(r.code,0))]);const targetDenied=await asyncSql(call('orl_ic_c1_reassign',targetOldSelection));assert.equal((await completeTarget).code,0);assert.notEqual(targetDenied.code,0);assert.match(targetDenied.error,/Only Webmaster/);
 assert.equal(request(targetStatusSourceId).assigned_slot_id,targetStatusSource);assert.equal(request(targetStatusTargetId).assigned_slot_id,targetStatusTarget);assert.equal(request(targetStatusTargetId).status,'COMPLETED');
 // Parent-date changes are serialized and read after locking, not from a stale view.
 const [raceDate,nextDate]=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-3334,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+3334)"));
 const dateSource=slot(raceDate),dateTarget=slot(raceDate);await create(dateSource);const dateParams=params(dateSource,dateTarget),beforeDateRace=snapshot();let dateSignal;const dateLocked=new Promise(resolve=>dateSignal=resolve);
 const changeDate=asyncSql(`begin;update public.orl_ot_sessions set ot_date=${lit(nextDate)} where id=${lit(session(raceDate))};select 'DATE_LOCKED';select pg_sleep(1);commit;`,output=>{if(output.includes('DATE_LOCKED'))dateSignal()});
 await Promise.race([dateLocked,changeDate.then(r=>assert.equal(r.code,0))]);const dateResult=await asyncSql(call('orl_ic_c1_reassign',dateParams));assert.equal((await changeDate).code,0);assert.notEqual(dateResult.code,0);assert.match(dateResult.error,/restricted to a past OT date/);
 sql(`update public.orl_ot_sessions set ot_date=${lit(raceDate)} where id=${lit(session(raceDate))}`);assert.equal(snapshot(),beforeDateRace);
 const staleGeneration=params(source,target);sql('update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton');await denied(()=>move(staleGeneration),'Restore generation changed');
 assert.equal(sql('select count(*) from orl_private.c1_write_permit'),'0');assert.equal(sql("select (orl_private.c6_stats()->>'plaintext_rows')::int"),'0');assert.equal(sql("select (orl_private.c6_stats()->>'identity_mismatch')::int"),'0');
 const audit065=JSON.parse(run('security/release/audit-past-case.sql'));for(const [name,ok] of Object.entries(audit065))assert.equal(ok,true,'065 '+name);
 const audit067=JSON.parse(run('security/release/audit-done-past-reassign.sql'));assert.equal(Object.keys(audit067).length,13);for(const [name,ok] of Object.entries(audit067))assert.equal(ok,true,'067 '+name);
});
