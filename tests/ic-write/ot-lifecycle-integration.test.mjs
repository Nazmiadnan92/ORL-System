import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';

test('064: held and completed bookings preserve history, enforce checked transitions, exclude held exports and survive encrypted restore',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',maxBuffer:16*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const lit=value=>value==null?'NULL':"'"+String(typeof value==='object'?JSON.stringify(value):value).replaceAll("'","''")+"'";
 const rpc=(name,p)=>JSON.parse(sql(`set role service_role;select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}))`));
 const publicCall=(name,p)=>JSON.parse(sql(`set role anon;select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}))`));
 const run=path=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+path,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const [past,today,tomorrow]=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-1,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+1)"));
 const password='SYNTHETIC-LIFECYCLE-PASSWORD',raw='900101-01-1234',actors={};
 for(const who of ['STAFF_A','STAFF_B','ADMIN','WEBMASTER']){
  const id=actors[who]=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('lifecycle_'+who)},extensions.crypt(${lit(password)},extensions.gen_salt('bf',4)),${lit('Synthetic '+who)},${lit(who.startsWith('STAFF')?'STAFF':who)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const config={context:'synthetic-ot-lifecycle',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}};
 const engine=await createIdentityCrypto(config),created=new Map();
 const create=async(who='ADMIN',overrides={})=>{
  const id=crypto.randomUUID(),data={patient_ic:raw,age:'36',age_months:'0',patient_name:'Synthetic lifecycle patient',mrn:'LIFE-'+id,surgery:'Synthetic procedure',diagnosis:'Synthetic diagnosis',doctor:'Synthetic doctor',specialist:'Synthetic specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic remark',...overrides};
  rpc('orl_ic_c1_create',{p_session_token:actors[who],p_request_id:id,p_data:data,p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation});created.set(id,data);return id;
 };
 const sessions=new Map();
 const session=date=>{
  if(!sessions.has(date)){
   sql(`insert into public.orl_ot_sessions(ot_date,day_name,status,holiday_override) values(${lit(date)},'Synthetic','ACTIVE',true) on conflict(ot_date) do update set status='ACTIVE',holiday_override=true`);
   sessions.set(date,sql(`select id from public.orl_ot_sessions where ot_date=${lit(date)}`));
  }return sessions.get(date);
 };
 const slot=(date,number,type='MAIN')=>{
  const id=crypto.randomUUID();sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${lit(id)},${lit(session(date))},${lit(type)},${number},'AVAILABLE')`);return id;
 };
 const occupy=(id,target,status='SCHEDULED')=>sql(`update public.orl_requests set status=${lit(status)},assigned_slot_id=${lit(target)},postpone_count=2,postpone_history='[{"reason":"Synthetic prior postponement"}]'::jsonb where id=${lit(id)};
  update public.orl_ot_slots set request_id=${lit(id)},status=${lit(status==='CONFIRMED'?'RESERVED':'CONFIRMED')} where id=${lit(target)}`);
 const source=slot('2093-09-01',1),neighborSlot=slot('2093-09-01',2),destination=slot('2093-09-02',1);
 const held=await create('STAFF_B'),neighbor=await create('ADMIN');occupy(held,source);occupy(neighbor,neighborSlot);
 const todaySlot=slot(today,9401,'SPECIAL'),pastSlot=slot(past,9401,'SPECIAL'),futureSlot=slot(tomorrow,9401,'SPECIAL');
 const todayCase=await create(),pastCase=await create('WEBMASTER'),futureCase=await create();occupy(todayCase,todaySlot);occupy(pastCase,pastSlot);occupy(futureCase,futureSlot);
 const state=id=>JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${lit(id)}`));
 const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(id)}`);
 const slotState=id=>sql(`select to_jsonb(s) from public.orl_ot_slots s where id=${lit(id)}`);
 const frozenRequest=id=>sql(`select to_jsonb(r)-array['updated_at','ot_hold','ot_hold_reason','ot_hold_at','ot_hold_by','completed_at','completed_by'] from public.orl_requests r where id=${lit(id)}`);
 const beforeRequests=sql('select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r');
 const beforeSlots=sql('select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s');
 run('supabase/064_ot_hold_completion.sql');
 assert.equal(sql("select jsonb_agg(to_jsonb(r)-array['ot_hold','ot_hold_reason','ot_hold_at','ot_hold_by','completed_at','completed_by'] order by id) from public.orl_requests r"),beforeRequests,'Install adds lifecycle defaults without changing existing records');
 assert.equal(sql('select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s'),beforeSlots);
 assert.throws(()=>run('supabase/064_ot_hold_completion.sql'),'A repeated installation must fail closed');
 const releaseAudit=JSON.parse(run('security/release/audit-ot-lifecycle.sql'));assert.equal(Object.keys(releaseAudit).length,12);for(const [name,ok] of Object.entries(releaseAudit))assert.equal(ok,true,name);
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const denied=async(fn,label)=>{const before=snapshot();await assert.rejects(async()=>fn(),label);assert.equal(snapshot(),before,'Denied lifecycle action is atomic: '+(label||''))};
 const origin='https://synthetic.invalid',gateway=createIcGateway({enabled:true,origins:[origin],rpc:async(name,p)=>rpc(name,p),cryptoConfig:()=>config,rateLimit:async()=>true});
 const send=async(who,p)=>{
  const response=await gateway(new Request(origin+'/ic-requests',{method:'POST',headers:{origin,'Content-Type':'application/json','x-orl-session':actors[who]},body:JSON.stringify({operation:'OT_LIFECYCLE',...p})}));
  const body=await response.json();if(!response.ok)throw Error(body.error);return body.result;
 };
 const payload=(id,action,reason='Synthetic lifecycle reason',extra={})=>({request_id:id,slot_id:state(id).assigned_slot_id,action,reason:action==='COMPLETE'?'':reason,generation,expected_version:state(id).updated_at,...extra});
 const change=(who,id,action,reason,extra)=>send(who,payload(id,action,reason,extra));
 const clinical=id=>sql(`select to_jsonb(r)-array['assigned_slot_id','status','updated_at','postpone_count','postpone_history','ot_hold','ot_hold_reason','ot_hold_at','ot_hold_by','completed_at','completed_by'] from public.orl_requests r where id=${lit(id)}`);
 const mutate=(who,id,operation,extra={})=>rpc('orl_ic_c1_mutate',{p_session_token:actors[who],p_operation:operation,p_from_slot:state(id).assigned_slot_id,p_to_slot:null,p_expected_request:id,p_data:{},p_action:'CONFIRM',p_reason:'Synthetic postpone',p_ic_mode:'KEEP',p_envelope:null,p_search:null,p_generation:generation,p_expected_version:state(id).updated_at,...extra});
 const clear=id=>rpc('orl_ic_c1_clear',{p_session_token:actors.ADMIN,p_slot_id:state(id).assigned_slot_id,p_expected_request_id:id,p_generation:generation});
 const cancel=(id,operation='REQUEST')=>rpc('orl_ic_c1_deletion',{p_session_token:actors.ADMIN,p_operation:operation,p_request_id:id,p_expected_slot:state(id).assigned_slot_id,p_expected_version:state(id).updated_at,p_generation:generation,p_reason:'Synthetic cancellation'});
 const reassign=(from,to)=>rpc('orl_ic_c1_reassign',{p_session_token:actors.ADMIN,p_from:state(from).assigned_slot_id,p_to:state(to).assigned_slot_id,p_expected_from_request_id:from,p_expected_to_request_id:to,p_generation:generation});
 const propose=id=>publicCall('orl_booking_move_request',{p_session_token:actors.ADMIN,p_request_id:id,p_target_date:'2093-09-03',p_reason:'Synthetic proposal',p_expected_from_slot:state(id).assigned_slot_id,p_expected_version:state(id).updated_at,p_generation:generation});
 const review=m=>publicCall('orl_booking_move_review',{p_session_token:actors.ADMIN,p_move_id:m.id,p_action:'APPROVE',p_target_slot:proposalTarget,p_expected_move_version:m.move_version,p_expected_request_version:state(m.request_id).updated_at,p_generation:generation});
 const proposalTarget=slot('2093-09-03',1),beforeHoldProposal=propose(held),beforeCompletionProposal=propose(todayCase);
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege(${lit(role)},'public.orl_ic_ot_lifecycle(uuid,uuid,uuid,text,text,uuid,timestamptz)','EXECUTE')`),'f');
 for(const action of ['HOLD','RELEASE_HOLD','COMPLETE'])await denied(()=>change('STAFF_A',held,action),'Staff cannot '+action);
 for(const reason of ['', '   ', 'x'.repeat(4097)])await denied(()=>change('ADMIN',held,'HOLD',reason),'Hold reason required and bounded');
 for(const extra of [{patient_ic:raw},{action:'UNRECOGNIZED'},{expected_version:'not-a-date'}])await denied(()=>change('ADMIN',held,'HOLD','Synthetic reason',extra),'Gateway rejects unsupported fields and invalid action/version');
 await denied(()=>change('ADMIN',held,'HOLD','Synthetic reason',{generation:crypto.randomUUID()}),'Wrong restore generation');
 await denied(()=>change('ADMIN',held,'HOLD','Synthetic reason',{slot_id:neighborSlot}),'Wrong occupied slot');
 await denied(()=>change('ADMIN',held,'HOLD','Synthetic reason',{expected_version:'2000-01-01T00:00:00Z'}),'Stale record version');
 sql('update orl_private.site_maintenance set enabled=true where singleton');
 try{await denied(()=>change('ADMIN',held,'HOLD'),'Maintenance blocks lifecycle writes')}finally{sql('update orl_private.site_maintenance set enabled=false where singleton')}
 const exportView=()=>rpc('orl_ic_ot_export_view',{p_session_token:actors.ADMIN,p_password:password,p_ot_session_id:session('2093-09-01'),p_generation:generation});
 const exportCommit=v=>rpc('orl_ic_ot_export_commit',{p_session_token:actors.ADMIN,p_password:password,p_lease_id:v.lease_id,p_ot_session_id:session('2093-09-01'),p_generation:generation});
 const prepared=exportView(),old=frozenRequest(held),oldSlot=slotState(source),oldIdentity=identity(held),versionBeforeHold=state(held).updated_at;
 assert.ok(prepared.snapshot.patients.some(p=>p.request_id===held));
 await change('ADMIN',held,'HOLD','Synthetic '+raw+' reason');
 assert.equal(state(held).ot_hold,true);assert.equal(state(held).ot_hold_by,actors.ADMIN);assert.ok(state(held).ot_hold_at);
 assert.doesNotMatch(state(held).ot_hold_reason,/900101-01-1234/);assert.match(state(held).ot_hold_reason,/900101-\*\*-\*\*\*/);
 assert.notEqual(state(held).updated_at,versionBeforeHold);assert.equal(frozenRequest(held),old);assert.equal(slotState(source),oldSlot);assert.equal(identity(held),oldIdentity);
 await denied(()=>exportCommit(prepared),'Previously issued export lease cannot include a newly held patient');
 const freshExport=exportView();assert.deepEqual(freshExport.snapshot.patients.map(p=>p.request_id),[neighbor]);assert.equal(exportCommit(freshExport).patient_count,1);
 await denied(()=>change('ADMIN',held,'HOLD'),'Cannot hold twice');
 await denied(()=>change('ADMIN',held,'COMPLETE'),'Held request cannot complete');
 await denied(()=>clear(held),'Held cannot be cleared');await denied(()=>cancel(held),'Held cannot be cancelled');
 await denied(()=>propose(held),'Held cannot use alternate Booking Move request');await denied(()=>review(beforeHoldProposal),'Pre-hold proposal cannot bypass hold');
 const listed=publicCall('orl_get_ot_hold_requests',{p_session_token:actors.ADMIN});assert.equal(listed.generation,generation);
 const listedHeld=listed.requests.find(r=>r.id===held);assert.ok(listedHeld);assert.equal(listedHeld.ot_hold,true);assert.doesNotMatch(JSON.stringify(listedHeld),/900101-01-1234/);
 await denied(()=>publicCall('orl_get_ot_hold_requests',{p_session_token:actors.STAFF_A}),'Hold management list requires Admin or Webmaster');
 await denied(()=>change('ADMIN',held,'RELEASE_HOLD',''),'Release reason required');
 const beforeRelease=frozenRequest(held);await change('WEBMASTER',held,'RELEASE_HOLD');
 assert.equal(state(held).ot_hold,false);assert.equal(frozenRequest(held),beforeRelease);assert.equal(slotState(source),oldSlot);assert.equal(identity(held),oldIdentity);
 await denied(()=>change('WEBMASTER',held,'RELEASE_HOLD'),'Cannot release twice');
 await change('WEBMASTER',held,'HOLD');
 const beforeMove=state(held),beforeClinical=clinical(held);assert.equal(mutate('STAFF_A',held,'MOVE',{p_to_slot:destination,p_data:{surgery:'Forbidden cross-owner edit'}}),'RESERVED');
 assert.equal(state(held).ot_hold,false);assert.equal(state(held).assigned_slot_id,destination);assert.equal(state(held).created_by,actors.STAFF_B);
 assert.equal(state(held).postpone_count,beforeMove.postpone_count+1);assert.equal(state(held).postpone_history.length,beforeMove.postpone_history.length+1);
 assert.equal(state(held).status,'CONFIRMED');assert.equal(sql(`select status from public.orl_ot_slots where id=${lit(destination)}`),'RESERVED');
 assert.equal(clinical(held),beforeClinical);assert.equal(identity(held),oldIdentity);
 mutate('ADMIN',held,'EDIT');assert.equal(state(held).status,'SCHEDULED');assert.equal(state(held).postpone_count,beforeMove.postpone_count+1);
 await denied(()=>change('ADMIN',futureCase,'COMPLETE'),'Future OT cannot complete');
 for(const [who,id,target] of [['ADMIN',todayCase,todaySlot],['WEBMASTER',pastCase,pastSlot]]){
  const before=state(id),beforeClinical=clinical(id),beforeIdentity=identity(id),beforeSlot=slotState(target);
  const stale=payload(id,'COMPLETE');await change(who,id,'COMPLETE');
  const done=state(id);assert.equal(done.status,'COMPLETED');assert.equal(done.completed_by,actors[who]);assert.ok(done.completed_at);
  assert.equal(done.assigned_slot_id,target);assert.equal(done.created_by,before.created_by);assert.deepEqual(done.postpone_history,before.postpone_history);assert.equal(done.postpone_count,before.postpone_count);
  assert.equal(slotState(target),beforeSlot);assert.equal(clinical(id),beforeClinical);assert.equal(identity(id),beforeIdentity);
  await denied(()=>send(who,stale),'Completed version cannot be replayed');
  await denied(()=>change(who,id,'HOLD'),'Completed cannot be held');
  await denied(()=>mutate(who,id,'EDIT'),'Completed cannot be edited/reopened');
  await denied(()=>mutate(who,id,'MOVE',{p_to_slot:source}),'Completed cannot be postponed');
  await denied(()=>clear(id),'Completed cannot be cleared');await denied(()=>cancel(id),'Completed cannot request cancellation');await denied(()=>cancel(id,'APPROVE'),'Completed cannot approve cancellation');
  await denied(()=>reassign(id,futureCase),'Completed cannot be reassigned');await denied(()=>reassign(futureCase,id),'Completed cannot be an occupied reassignment target');
 }
 await denied(()=>review(beforeCompletionProposal),'Pre-completion Booking Move proposal cannot reopen history');
 const audit=JSON.parse(sql(`select jsonb_agg(to_jsonb(a) order by occurred_at,id) from public.orl_audit_log a where record_id in(${[held,todayCase,pastCase].map(lit).join(',')}) and action in('OT_HOLD_PLACED','OT_HOLD_REMOVED','OT_HOLD_MOVED','OT_MARKED_DONE')`));
 assert.equal(audit.filter(a=>a.action==='OT_HOLD_PLACED').length,2);assert.equal(audit.filter(a=>a.action==='OT_HOLD_REMOVED').length,1);assert.equal(audit.filter(a=>a.action==='OT_HOLD_MOVED').length,1);assert.equal(audit.filter(a=>a.action==='OT_MARKED_DONE').length,2);
 assert.doesNotMatch(JSON.stringify(audit),/900101-01-1234/);for(const a of audit){assert.ok(a.user_id);assert.ok(a.occurred_at);assert.ok(a.details)}
 // Other patients still compact into free Main slots around the retained history.
 const compactDate='1995-11-01',compactSlots=[1,2,3,4].map(n=>slot(compactDate,n));
 const compactCases=[];for(const target of compactSlots){const id=await create();compactCases.push(id);occupy(id,target)}
 await change('ADMIN',compactCases[0],'COMPLETE');await change('ADMIN',compactCases[1],'HOLD');
 const pinnedSlots=compactSlots.slice(0,2).map(slotState),pinnedRows=compactCases.slice(0,2).map(state);
 const compactDestination=slot('2093-09-04',1);assert.equal(mutate('ADMIN',compactCases[2],'MOVE',{p_to_slot:compactDestination}),'CONFIRMED');
 assert.deepEqual(compactSlots.slice(0,2).map(slotState),pinnedSlots);assert.deepEqual(compactCases.slice(0,2).map(state),pinnedRows);
 assert.equal(state(compactCases[3]).assigned_slot_id,compactSlots[2]);assert.equal(sql(`select request_id is null and status='AVAILABLE' from public.orl_ot_slots where id=${lit(compactSlots[3])}`),'t');
 const completedData=created.get(todayCase);
 const duplicates=JSON.parse(sql(`set role anon;select public.orl_check_duplicate_request(${lit(actors.ADMIN)},${lit(completedData.mrn)},${lit(completedData.surgery)})`));
 assert.equal(duplicates.exact_count,0,'Completed record no longer blocks a fresh request');
 const newCase=await create('STAFF_A',{mrn:completedData.mrn,surgery:completedData.surgery});assert.notEqual(newCase,todayCase);assert.equal(state(todayCase).status,'COMPLETED');
 // Preserve held and completed rows together across the supported encrypted v3 restore.
 await change('ADMIN',futureCase,'HOLD');
 const preserved=[held,todayCase,pastCase,futureCase].map(id=>({id,request:state(id),identity:identity(id),slot:slotState(state(id).assigned_slot_id)}));
 const backup=rpc('orl_ic_c1_export',{p_session_token:actors.WEBMASTER,p_password:password});
 assert.equal(backup.version,3);assert.equal(JSON.stringify(backup.requests.filter(r=>created.has(r.id))).includes(raw),false,'Lifecycle fixtures remain masked in the portable export');
 // Earlier prerequisite suites deliberately retain inconsistent legacy rows.
 // Restore only this suite's linked synthetic episodes, keeping the actual v3 envelope.
 const lifecycleSessions=new Set(sessions.values());
 backup.requests=backup.requests.filter(r=>created.has(r.id));
 backup.identities=backup.identities.filter(r=>created.has(r.request_id));
 backup.creation_receipts=backup.creation_receipts.filter(r=>created.has(r.request_id));
 backup.ot_sessions=backup.ot_sessions.filter(s=>lifecycleSessions.has(s.id));
 backup.ot_slots=backup.ot_slots.filter(s=>lifecycleSessions.has(s.session_id)&&(!s.request_id||created.has(s.request_id)));
 rpc('orl_ic_c1_import',{p_session_token:actors.WEBMASTER,p_password:password,p_backup:backup});
 assert.notEqual(sql('select generation from orl_private.c1_restore_generation where singleton'),generation);
 for(const saved of preserved){
  assert.deepEqual(state(saved.id),saved.request);
  const comparableIdentity=value=>{const copy=JSON.parse(value);delete copy.created_at;delete copy.updated_at;return copy};
  assert.deepEqual(comparableIdentity(identity(saved.id)),comparableIdentity(saved.identity),'Restore preserves the encrypted identity envelope and search hash');
  assert.equal(slotState(saved.request.assigned_slot_id),saved.slot);
 }
 // Portable lifecycle actor references follow the existing username mapping.
 const portableActor=crypto.randomUUID(),portable=JSON.parse(JSON.stringify(backup).replaceAll(actors.ADMIN,portableActor));
 rpc('orl_ic_c1_import',{p_session_token:actors.WEBMASTER,p_password:password,p_backup:portable});
 assert.equal(state(futureCase).ot_hold_by,actors.ADMIN);assert.equal(state(todayCase).completed_by,actors.ADMIN);
 const legacy=structuredClone(backup);
 for(const row of legacy.requests)for(const key of ['ot_hold','ot_hold_reason','ot_hold_at','ot_hold_by','completed_at','completed_by'])delete row[key];
 rpc('orl_ic_c1_import',{p_session_token:actors.WEBMASTER,p_password:password,p_backup:legacy});
 assert.equal(state(futureCase).ot_hold,false);assert.equal(state(futureCase).ot_hold_reason,'');assert.equal(state(futureCase).ot_hold_at,null);assert.equal(state(futureCase).ot_hold_by,null);
 assert.equal(state(todayCase).status,'COMPLETED');assert.equal(state(todayCase).completed_at,null);assert.equal(state(todayCase).completed_by,null);
 assert.equal(state(todayCase).assigned_slot_id,todaySlot,'Legacy completed history still retains its occupied slot');
 assert.equal(sql("select (orl_private.c6_stats()->>'plaintext_rows')::int"),'0');assert.equal(sql("select (orl_private.c6_stats()->>'identity_mismatch')::int"),'0');
});
