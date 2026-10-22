import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('071: pending approval and assignment are atomic, privileged, fenced and preserve existing approved cases',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const database=process.env.ORL_IC_TEST_DATABASE;assert.match(database,/^orl_pending_assign_test_[a-z0-9_]+$/);
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d',database,'-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v==null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const call=(name,p,role='anon')=>`set role ${role};select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}));`;
 const rpc=(name,p,role)=>JSON.parse(sql(call(name,p,role)));
 const run=p=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+p,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet or inet_server_port()<>55461 or current_database() !~ '^orl_pending_assign_test_' then raise exception 'Disposable local fixture only'; end if; end $$;");
 const wrappers=['public.orl_booking_assign_view(uuid,uuid)','public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)'];
 const dependencies=['public.orl_review_request(uuid,uuid,text,text)','public.orl_assign_slot(uuid,uuid,uuid)','public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)','orl_private.c1_redact_text(text)','orl_private.booking_same_date_guard()'];
 const wrapperMetadata=()=>sql(`select jsonb_agg(to_jsonb(p)-'prosrc' order by oid) from pg_proc p where oid in(${wrappers.map(f=>lit(f)+'::regprocedure').join(',')})`);
 const untouchedFunctions=()=>sql(`select md5(jsonb_agg(to_jsonb(p) order by p.oid)::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.oid not in(${wrappers.map(f=>lit(f)+'::regprocedure').join(',')})`);
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const allRows=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const migration=readFileSync(new URL('../../supabase/071_pending_request_assignment.sql',import.meta.url),'utf8').replace(/^begin;\r?$/m,'-- outer transaction').replace(/^commit;\r?$/m,'-- outer transaction');
 const install=()=>run('supabase/071_pending_request_assignment.sql');
 const beforeRows=allRows(),beforeFunctions=untouchedFunctions(),beforeMetadata=wrapperMetadata();
 // Reject changed definitions, changed security, broader grants and disabled guards
 // before installing either wrapper. Every attempted alteration rolls back.
 for(const signature of [...wrappers,...dependencies]){
  const definition=sql(`select pg_get_functiondef(${lit(signature)}::regprocedure)`);
  const drift=definition.replace('AS $function$','AS $function$\n/* unreviewed synthetic variant */');
  assert.notEqual(drift,definition);
  assert.throws(()=>sql('begin;'+drift+';'+migration+'rollback;'),e=>/baseline differs/.test(String(e.stderr)));
 }
 for(const altered of [
  `alter function ${wrappers[0]} security invoker;`,
  `alter function ${wrappers[1]} set search_path=pg_catalog;`,
  `grant execute on function ${dependencies[0]} to anon;`,
  `grant execute on function ${wrappers[0]} to public;`,
  `grant execute on function ${wrappers[0]} to service_role;`,
  `grant execute on function ${wrappers[0]} to authenticated with grant option;`,
  'alter table public.orl_ot_slots disable trigger orl_booking_same_date_guard;',
  'grant select on public.orl_requests to anon;',
  'grant select on public.orl_holidays to authenticated;'
 ])assert.throws(()=>sql('begin;'+altered+migration+'rollback;'),e=>/differs|differ/.test(String(e.stderr)));
 assert.equal(allRows(),beforeRows);assert.equal(untouchedFunctions(),beforeFunctions);assert.equal(wrapperMetadata(),beforeMetadata);
 install();assert.throws(install,e=>/baseline differs/.test(String(e.stderr)));
 assert.equal(allRows(),beforeRows,'Installation changes no existing data');
 assert.equal(untouchedFunctions(),beforeFunctions,'Only the two wrapper definitions change');
 assert.equal(wrapperMetadata(),beforeMetadata,'Signatures, owner, configuration and ACLs stay exact');
 for(const role of ['anon','authenticated','service_role']){
  for(const signature of wrappers)assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(signature)},'EXECUTE')`),role==='service_role'?'f':'t');
  for(const signature of dependencies)assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(signature)},'EXECUTE')`),'f');
 }

 const actors={};
 for(const role of ['STAFF','OTHER','ADMIN','WEBMASTER']){
  const id=actors[role]=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('pending_assign_'+role+'_'+id.slice(0,8))},'unused',${lit('Synthetic '+role)},${lit(role==='OTHER'?'STAFF':role)});insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour')`);
 }
 sql('update orl_private.site_maintenance set enabled=false where singleton');
 const generation=()=>sql('select generation from orl_private.c1_restore_generation where singleton');
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const engine=await createIdentityCrypto({context:'synthetic-pending-assignment-071',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const makeRequest=async({creator='STAFF',status='CONFIRMED',mrn,override=false}={})=>{
  const id=crypto.randomUUID(),raw='010203-04-5678';
  const data={patient_ic:raw,age:'20',age_months:'0',patient_name:'Synthetic assignment',mrn:mrn??'ASSIGN-'+id,surgery:'Synthetic Procedure',diagnosis:'Synthetic diagnosis',doctor:'Synthetic',specialist:'Synthetic',sub_specialty:'Gen ORL',phone:'0',remark:'Preserve clinical text',allow_duplicate:override,duplicate_reason:override?'Separate synthetic episode':''};
  rpc('orl_ic_c1_create',{p_session_token:actors[creator],p_request_id:id,p_data:data,p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation()},'service_role');
  sql(`update public.orl_requests set status=${lit(status)},postpone_count=3,updated_at='2080-01-01T00:00:00.123456Z' where id=${lit(id)}`);
  return id;
 };
 let dateOffset=0;
 const makeDay=(types=['MAIN','SPECIAL'],date)=>{
  const id=crypto.randomUUID(),slots=types.map(()=>crypto.randomUUID());
  date??=sql(`select ('2087-01-01'::date+${dateOffset++})::text`);
  sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${lit(id)},${lit(date)},'Synthetic');insert into public.orl_ot_slots(id,session_id,slot_type,slot_number) values ${slots.map((slot,i)=>`(${lit(slot)},${lit(id)},${lit(types[i])},${i+1})`).join(',')}`);
  return {id,slots,date};
 };
 const view=(id,actor='ADMIN',dbRole)=>rpc('orl_booking_assign_view',{p_session_token:actors[actor],p_request_id:id},dbRole);
 const params=(v,slot,actor='ADMIN',extra={})=>({p_session_token:actors[actor],p_request_id:v.request_id,p_target_slot:slot,p_expected_version:v.request_version,p_generation:v.generation,...extra});
 const assign=p=>rpc('orl_booking_assign_existing',p);
 const row=id=>JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${lit(id)}`));
 const clinical=id=>sql(`select md5((to_jsonb(r)-array['assigned_slot_id','status','updated_at','reviewed_by','reviewed_at','review_note'])::text) from public.orl_requests r where id=${lit(id)}`);
 const identity=id=>sql(`select md5(to_jsonb(i)::text) from orl_private.request_identity i where request_id=${lit(id)}`);
 const events=id=>JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]'::jsonb) from public.orl_audit_log a where record_id=${lit(id)}`));
 const changes=()=>sql("select md5(jsonb_build_object('r',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'i',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),'s',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'a',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a))::text)");
 const denied=(fn,pattern=/./)=>{const before=changes();assert.throws(fn,e=>pattern.test(String(e.stderr||e.message)));assert.equal(changes(),before,'Denied action leaves approval, slot, identity and audit unchanged');};
 const review=(id,actor='ADMIN',slot=null)=>rpc('orl_ic_c1_review',{p_session_token:actors[actor],p_request_id:id,p_action:'APPROVE',p_note:'Existing separate review',p_expected_slot:slot,p_generation:generation()},'service_role');
 const staffAssign=(id,slot,actor='STAFF')=>rpc('orl_ic_c1_assign',{p_session_token:actors[actor],p_request_id:id,p_slot_id:slot,p_generation:generation(),p_slot_generation:generation()},'service_role');
 // Both privileged roles can assign all request creators to Main or Special.
 for(const creator of ['STAFF','ADMIN','WEBMASTER'])for(const actor of ['ADMIN','WEBMASTER']){
  const id=await makeRequest({creator}),day=makeDay(),v=view(id,actor),beforeClinical=clinical(id),beforeIdentity=identity(id);
  assert.equal(v.status,'CONFIRMED');assert.match(v.request_version,/\.123456[+-]/);assert.equal(v.generation,generation());
  assert.ok(!JSON.stringify(v).includes('010203'));assert.equal(v.patient_ic,undefined);
  assert.deepEqual(view(id,actor,'authenticated'),v);
  for(const staff of ['STAFF','OTHER']){
   denied(()=>view(id,staff),/Admin or Webmaster/);
   for(const slot of day.slots)denied(()=>assign(params(v,slot,staff)),/Admin or Webmaster/);
  }
  assert.equal(assign(params(v,day.slots[actor==='ADMIN'?0:1],actor)),'CONFIRMED');
  const saved=row(id);assert.equal(saved.status,'SCHEDULED');assert.equal(saved.reviewed_by,actors[actor]);assert.ok(saved.reviewed_at);assert.equal(saved.review_note,'Approved while assigning an OT slot');
  assert.equal(clinical(id),beforeClinical);assert.equal(identity(id),beforeIdentity);
  assert.equal(events(id).filter(e=>e.action==='REQUEST_APPROVE').length,1);assert.equal(events(id).filter(e=>e.action==='PATIENT_ASSIGNED_CONFIRMED').length,1);
  for(const e of events(id).filter(e=>['REQUEST_APPROVE','PATIENT_ASSIGNED_CONFIRMED'].includes(e.action))){assert.equal(e.user_id,actors[actor]);assert.equal(e.user_role,actor);}
  denied(()=>assign(params(v,day.slots[0],actor)),/changed|already/);
 }
 // APPROVED legacy path preserves the original review, never reviews twice.
 for(const actor of ['ADMIN','WEBMASTER']){
  const id=await makeRequest(),day=makeDay();review(id,'WEBMASTER');
  const previous=row(id),approvalEvents=events(id).filter(e=>e.action==='REQUEST_APPROVE').length,v=view(id,actor),beforeClinical=clinical(id),beforeIdentity=identity(id);
  assert.equal(v.status,'APPROVED');assert.equal(assign(params(v,day.slots[0],actor)),'CONFIRMED');
  for(const k of ['reviewed_by','reviewed_at','review_note'])assert.equal(row(id)[k],previous[k]);
  assert.equal(events(id).filter(e=>e.action==='REQUEST_APPROVE').length,approvalEvents);assert.equal(clinical(id),beforeClinical);assert.equal(identity(id),beforeIdentity);
 }
 const pending=await makeRequest(),day=makeDay(),v=view(pending),p=params(v,day.slots[0]);
 for(const extra of [{p_session_token:null},{p_session_token:crypto.randomUUID()},{p_request_id:null},{p_request_id:crypto.randomUUID()},{p_expected_version:null},{p_expected_version:'2080-01-01T00:00:00.123457Z'},{p_generation:null},{p_generation:crypto.randomUUID()},{p_target_slot:null},{p_target_slot:crypto.randomUUID()}])denied(()=>assign({...p,...extra}),/expired|changed|Restore|unavailable/);
 // Changing reviewer status after the picker opens must invalidate its snapshot.
 review(pending,'WEBMASTER');denied(()=>assign(p),/changed/);assert.equal(row(pending).status,'APPROVED');
 assert.equal(assign(params(view(pending),day.slots[0])),'CONFIRMED');
 for(const status of ['DRAFT','PENDING REVIEW','REJECTED','SCHEDULED','COMPLETED','CANCELLED']){
  const id=await makeRequest({status}),target=makeDay();
  denied(()=>view(id),/Only a pending/);denied(()=>assign({...p,p_request_id:id,p_expected_version:row(id).updated_at,p_target_slot:target.slots[0]}),/changed/);
 }
 for(const change of ["deletion_status='PENDING'","deletion_status='APPROVED'"]){
  const id=await makeRequest(),target=makeDay(),old=view(id);sql(`update public.orl_requests set ${change} where id=${lit(id)}`);
  denied(()=>view(id),/Only a pending/);denied(()=>assign(params(old,target.slots[0])),/changed/);
 }
 // An unassigned hold is normally prohibited by the schema. Exercise the extra
 // fail-closed check against synthetic corruption inside a rollback-only txn.
 const held=await makeRequest(),heldDay=makeDay(),heldView=view(held);
 for(const request of [call('orl_booking_assign_view',{p_session_token:actors.ADMIN,p_request_id:held}),call('orl_booking_assign_existing',params(heldView,heldDay.slots[0]))]){
  denied(()=>sql(`begin;alter table public.orl_requests drop constraint orl_requests_ot_hold_state;update public.orl_requests set ot_hold=true where id=${lit(held)};${request}rollback;`),/Only a pending|changed/);
  assert.equal(sql("select count(*) from pg_constraint where conrelid='public.orl_requests'::regclass and conname='orl_requests_ot_hold_state' and convalidated"),'1');
 }
 // Fail closed when the stored reverse link disagrees; do not repair silently.
 const reverse=await makeRequest(),reverseDay=makeDay(),reverseView=view(reverse);
 sql(`update public.orl_ot_slots set request_id=${lit(reverse)},status='RESERVED' where id=${lit(reverseDay.slots[0])}`);
 denied(()=>view(reverse),/Only a pending/);denied(()=>assign(params(reverseView,reverseDay.slots[1])),/changed/);
 // Pending requests that already reserved a slot keep the existing Confirm path.
 const reserved=await makeRequest(),reservedDay=makeDay();assert.equal(staffAssign(reserved,reservedDay.slots[0]),'RESERVED');
 denied(()=>view(reserved),/Only a pending/);denied(()=>assign({...p,p_request_id:reserved,p_expected_version:row(reserved).updated_at,p_target_slot:reservedDay.slots[1]}),/changed/);
 assert.equal(review(reserved,'ADMIN',reservedDay.slots[0]),'APPROVE');assert.equal(row(reserved).status,'SCHEDULED');
 // Existing staff direct booking rules remain intact (own Main only).
 const own=await makeRequest(),other=await makeRequest({creator:'OTHER'}),staffDay=makeDay();
 denied(()=>staffAssign(own,staffDay.slots[1]),/Special slots/);denied(()=>staffAssign(other,staffDay.slots[0]),/own request/);
 assert.equal(staffAssign(own,staffDay.slots[0]),'RESERVED');assert.equal(events(own).filter(e=>e.action==='REQUEST_APPROVE').length,0);
 // Rejected destinations must roll back the preliminary approval and its audit.
 for(const type of ['closed','occupied','cancelled','holiday','past']){
  const id=await makeRequest(),target=makeDay(['MAIN'],type==='past'?'2001-01-01':undefined),snapshot=view(id);
  if(type==='closed')sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(target.slots[0])}`);
  if(type==='occupied'){const occupant=await makeRequest();assign(params(view(occupant),target.slots[0]));}
  if(type==='cancelled')sql(`update public.orl_ot_sessions set status='CANCELLED' where id=${lit(target.id)}`);
  if(type==='holiday')sql(`insert into public.orl_holidays(holiday_date,title,is_active) values(${lit(target.date)},'Synthetic holiday',true)`);
  denied(()=>assign(params(snapshot,target.slots[0])),/unavailable|Past OT/);
  assert.equal(row(id).status,'CONFIRMED');assert.equal(row(id).reviewed_by,null);assert.equal(events(id).filter(e=>e.action==='REQUEST_APPROVE').length,0);
  if(type==='holiday'){sql(`update public.orl_ot_sessions set holiday_override=true where id=${lit(target.id)}`);assert.equal(assign(params(snapshot,target.slots[0])),'CONFIRMED');}
 }
 // Exact same-date clinical duplicate guard still rolls back the whole action.
 const duplicateDay=makeDay(['MAIN','MAIN']),mrn='SYNTHETIC-071-DUPLICATE';
 const first=await makeRequest({creator:'ADMIN',mrn});assign(params(view(first),duplicateDay.slots[0]));
 const duplicate=await makeRequest({creator:'ADMIN',mrn,override:true});denied(()=>assign(params(view(duplicate),duplicateDay.slots[1])),/same OT date|same date|already/i);
 // Failing either audit write cannot leave a partial approval or assignment.
 for(const event of ['REQUEST_APPROVE','PATIENT_ASSIGNED_CONFIRMED']){
  const id=await makeRequest(),target=makeDay(),snapshot=view(id);
  sql(`create function public.synthetic_071_audit_fail() returns trigger language plpgsql as $$begin if new.action=${lit(event)} then raise exception 'Synthetic audit unavailable'; end if;return new;end$$;create trigger synthetic_071_audit_fail before insert on public.orl_audit_log for each row execute function public.synthetic_071_audit_fail()`);
  try{denied(()=>assign(params(snapshot,target.slots[0])),/Synthetic audit unavailable/);}finally{sql('drop trigger synthetic_071_audit_fail on public.orl_audit_log;drop function public.synthetic_071_audit_fail()');}
 }
 // Session and maintenance policy stays authoritative; Webmaster retains access.
 const gated=await makeRequest(),gatedDay=makeDay(),gatedView=view(gated);
 sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${lit(actors.ADMIN)}`);
 denied(()=>view(gated),/expired/);denied(()=>assign(params(gatedView,gatedDay.slots[0])),/expired/);
 sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${lit(actors.ADMIN)}`);
 sql('update orl_private.site_maintenance set enabled=true where singleton');
 denied(()=>view(gated),/ORL_MAINTENANCE/);denied(()=>assign(params(gatedView,gatedDay.slots[0])),/ORL_MAINTENANCE/);
 assert.equal(assign(params(view(gated,'WEBMASTER'),gatedDay.slots[0],'WEBMASTER')),'CONFIRMED');sql('update orl_private.site_maintenance set enabled=false where singleton');
 async function holder(statement){
  const proc=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let output='',error='';
  const done=new Promise(resolve=>proc.on('close',code=>resolve(code)));
  const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Local lock fixture timeout')),8000);proc.stdout.on('data',d=>{output+=d;if(output.includes('ASSIGN_LOCKED')){clearTimeout(timeout);resolve();}});proc.stderr.on('data',d=>error+=d);proc.on('error',reject);});
  proc.stdin.write(`begin;${statement};select 'ASSIGN_LOCKED';\n`);await ready;
  return {finish:async(commit=false)=>{proc.stdin.end(commit?'commit;\n':'rollback;\n');assert.equal(await done,0,error);}};
 }
 const concurrent=await makeRequest(),concurrentDay=makeDay(),concurrentView=view(concurrent);
 for(const fence of ["select pg_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0))",'lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in share row exclusive mode']){
  const lock=await holder(fence);try{denied(()=>assign(params(concurrentView,concurrentDay.slots[0])),/Restore is running|lock|obtain/i);}finally{await lock.finish();}
 }
 // A changed restore epoch invalidates an unchanged request/version snapshot.
 const previousGeneration=generation();sql(`update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton`);
 denied(()=>assign(params(concurrentView,concurrentDay.slots[0])),/Restore/);sql(`update orl_private.c1_restore_generation set generation=${lit(previousGeneration)} where singleton`);
 // One slot, two Pending cases: the winner commits once; the losing request
 // remains Pending with no approval/reviewer/audit mutation.
 const winner=await makeRequest(),loser=await makeRequest(),raceDay=makeDay(),winnerParams=params(view(winner),raceDay.slots[0]),loserParams=params(view(loser),raceDay.slots[0]);
 const winnerLock=await holder(call('orl_booking_assign_existing',winnerParams));
 const loserBefore=JSON.stringify(row(loser)),loserEvents=JSON.stringify(events(loser));
 const losing=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let losingError='';losing.stderr.on('data',d=>losingError+=d);
 const losingDone=new Promise(resolve=>losing.on('close',code=>resolve(code)));losing.stdin.end(call('orl_booking_assign_existing',loserParams));
 await winnerLock.finish(true);assert.notEqual(await losingDone,0);assert.match(losingError,/unavailable/);
 assert.equal(JSON.stringify(row(loser)),loserBefore);assert.equal(JSON.stringify(events(loser)),loserEvents);assert.equal(events(winner).filter(e=>e.action==='REQUEST_APPROVE').length,1);
 // One Pending request, two destinations: a stale second admin cannot assign it
 // again after waiting for the winning transaction's request lock.
 const same=await makeRequest(),twoSlots=makeDay(['MAIN','MAIN']),sameView=view(same);
 const sameLock=await holder(call('orl_booking_assign_existing',params(sameView,twoSlots.slots[0])));
 const second=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let secondError='';second.stderr.on('data',d=>secondError+=d);
 const secondDone=new Promise(resolve=>second.on('close',code=>resolve(code)));second.stdin.end(call('orl_booking_assign_existing',params(sameView,twoSlots.slots[1],'WEBMASTER')));
 await sameLock.finish(true);assert.notEqual(await secondDone,0);assert.match(secondError,/changed|already/);
 assert.equal(row(same).assigned_slot_id,twoSlots.slots[0]);assert.equal(sql(`select request_id is null and status='AVAILABLE' from public.orl_ot_slots where id=${lit(twoSlots.slots[1])}`),'t');assert.equal(events(same).filter(e=>e.action==='REQUEST_APPROVE').length,1);
 assert.equal(untouchedFunctions(),beforeFunctions,'No core, identity, recovery, export or other function changed');
});
