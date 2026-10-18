import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('065: Webmaster-only historical corrections and atomic missing cases retain encryption, lifecycle, closure and stale-write fences',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const database=process.env.ORL_IC_TEST_DATABASE||'postgres';assert.match(database,/^(?:postgres|orl_past_test_[a-z0-9_]+)$/);
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d',database,'-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const lit=value=>value==null?'NULL':"'"+String(typeof value==='object'?JSON.stringify(value):value).replaceAll("'","''")+"'";
 const callSql=(name,p,role='service_role')=>`set role ${role};select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}))`;
 const rpc=(name,p,role='service_role')=>JSON.parse(sql(callSql(name,p,role)));
 const run=path=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+path,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 const password='SYNTHETIC-PAST-CASE-PASSWORD',raw='900101-01-1234',actors={};
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const id=actors[role]=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('past_case_'+role)},extensions.crypt(${lit(password)},extensions.gen_salt('bf',4)),${lit('Synthetic '+role)},${lit(role)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const [past,past2,today,future]=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-1,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-2,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+1)"));
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const engine=await createIdentityCrypto({context:'synthetic-past-case',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const sessions=new Map();
 const session=date=>{
  if(!sessions.has(date)){
   sql(`insert into public.orl_ot_sessions(ot_date,day_name,status,holiday_override) values(${lit(date)},'Synthetic','ACTIVE',true) on conflict(ot_date) do update set status='ACTIVE',holiday_override=true`);
   sessions.set(date,sql(`select id from public.orl_ot_sessions where ot_date=${lit(date)}`));
  }return sessions.get(date);
 };
 let slotNumber=9600;
 const slot=(date= past,type='MAIN',status='AVAILABLE')=>{
  const id=crypto.randomUUID();sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${lit(id)},${lit(session(date))},${lit(type)},${++slotNumber},${lit(status)})`);return id;
 };
 const data=(extra={})=>({patient_name:'Synthetic historical patient',mrn:'PAST-'+crypto.randomUUID(),age:'36',age_months:'1',diagnosis:'Synthetic diagnosis',surgery:'Synthetic procedure',doctor:'Synthetic doctor',specialist:'Synthetic specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic historical remark',...extra});
 const state=id=>JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${lit(id)}`));
 const slotState=id=>JSON.parse(sql(`select to_jsonb(sl) from public.orl_ot_slots sl where id=${lit(id)}`));
 const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(id)}`);
 const create=async(target,role='ADMIN',extra={})=>{
  const id=crypto.randomUUID(),payload=data(extra);
  rpc('orl_ic_c1_create',{p_session_token:actors[role],p_request_id:id,p_data:{...payload,patient_ic:raw},p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation});
  sql(`update public.orl_requests set assigned_slot_id=${lit(target)},status='SCHEDULED',postpone_count=2,postpone_history='[{"reason":"Synthetic prior delay"}]'::jsonb where id=${lit(id)};
   update public.orl_ot_slots set request_id=${lit(id)},status='CONFIRMED' where id=${lit(target)}`);return id;
 };
 const oldSlot=slot(),heldSlot=slot(past,'SPECIAL'),doneSlot=slot(past,'MAIN'),cancelledSlot=slot(past2,'SPECIAL'),futureSlot=slot(future),todaySlot=slot(today);
 const original=await create(oldSlot,'STAFF'),held=await create(heldSlot),done=await create(doneSlot),cancelled=await create(cancelledSlot),futureCase=await create(futureSlot);
 sql(`update public.orl_requests set ot_hold=true,ot_hold_reason='Synthetic hold',ot_hold_at=now(),ot_hold_by=${lit(actors.ADMIN)} where id=${lit(held)};
  update public.orl_requests set status='COMPLETED',completed_at=now(),completed_by=${lit(actors.ADMIN)} where id=${lit(done)};
  update public.orl_requests set status='CANCELLED',deletion_status='APPROVED',deletion_reason='Synthetic cancel' where id=${lit(cancelled)};`);
 const beforeRequests=sql('select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r');
 const beforeSlots=sql('select jsonb_agg(to_jsonb(sl) order by id) from public.orl_ot_slots sl');
 const oldMutate=sql("select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)'::regprocedure");
 assert.equal(oldMutate,'9369627b09c1739c304e1c7256b3eaa7');
 run('supabase/065_past_case_correction.sql');
 assert.equal(sql('select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r'),beforeRequests,'Installing 065 does not mutate patients');
 assert.equal(sql('select jsonb_agg(to_jsonb(sl) order by id) from public.orl_ot_slots sl'),beforeSlots,'Installing 065 does not alter slots');
 assert.throws(()=>run('supabase/065_past_case_correction.sql'),'Repeated installation must fail closed');
 const view=(id,role='WEBMASTER')=>rpc('orl_ic_past_case_view',{p_session_token:actors[role],p_slot_id:id});
 const saveParams=(v,extra={})=>({p_session_token:actors.WEBMASTER,p_password:password,p_mode:v.mode,p_slot_id:v.slot_id,p_request_id:v.request_id||crypto.randomUUID(),p_data:{remark:'Corrected synthetic detail'},p_reason:'Synthetic retrospective correction',p_ic_mode:'KEEP',p_envelope:null,p_search:null,p_generation:v.generation,p_snapshot:v.snapshot,p_expected_version:v.expected_version,...extra});
 const save=p=>rpc('orl_ic_past_case_save',p);
 const addParams=async(target,extra={})=>{
  const v=view(target),id=crypto.randomUUID(),payload=data(extra);
  return saveParams(v,{p_request_id:id,p_data:{...payload,patient_ic:raw},p_ic_mode:'SET',p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw)});
 };
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const denied=async(fn,label)=>{const before=snapshot();await assert.rejects(async()=>fn(),label);assert.equal(snapshot(),before,'Rejected action is atomic: '+label)};
 const frozen=id=>sql(`select to_jsonb(r)-array['patient_name','mrn','age','age_months','diagnosis','surgery','doctor','specialist','sub_specialty','phone','remark','patient_ic','updated_at'] from public.orl_requests r where id=${lit(id)}`);
 const sqlSignatures=['public.orl_ic_past_case_view(uuid,uuid)','public.orl_ic_past_case_save(uuid,text,text,uuid,uuid,jsonb,text,text,jsonb,jsonb,uuid,text,timestamptz)'];
 for(const signature of sqlSignatures){
  for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(signature)},'EXECUTE')`),'f');
  assert.equal(sql(`select has_function_privilege('service_role',${lit(signature)},'EXECUTE')`),'t');
 }
 for(const signature of ['orl_private.past_case_snapshot(uuid)','orl_private.past_case_record(uuid)'])for(const role of ['anon','authenticated','service_role'])assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(signature)},'EXECUTE')`),'f');
 const initial=view(oldSlot);assert.equal(initial.mode,'EDIT');assert.equal(initial.request_id,original);assert.match(initial.snapshot,/^[a-f0-9]{64}$/);assert.equal(initial.patient.patient_ic,'900101-**-****');assert.equal(JSON.stringify(initial).includes(raw),false);
 assert.equal(initial.patient.age,state(original).age);assert.equal(initial.patient.age_months,state(original).age_months,'Correction form presents the actual stored age');
 for(const role of ['STAFF','ADMIN']){
  await denied(()=>view(oldSlot,role),role+' cannot view protected historical form');
  await denied(()=>save(saveParams(initial,{p_session_token:actors[role]})),role+' cannot correct a historical case');
 }
 for(const target of [todaySlot,futureSlot])await denied(()=>view(target),'Today/future not historical');
 await denied(()=>view(crypto.randomUUID()),'Missing slot denied');
 for(const extra of [{p_password:'wrong'},{p_generation:crypto.randomUUID()},{p_snapshot:'0'.repeat(64)},{p_expected_version:'2000-01-01T00:00:00Z'},{p_expected_version:null},{p_request_id:crypto.randomUUID()},{p_mode:'ADD'}])await denied(()=>save(saveParams(initial,extra)),'Invalid authorization or stale review');
 for(const reason of ['', '  ', 'x'.repeat(2001)])await denied(()=>save(saveParams(initial,{p_reason:reason})),'Reason required/bounded');
 for(const forbidden of ['status','assigned_slot_id','created_by','postpone_count','ot_hold','completed_at','deletion_status','allow_duplicate'])await denied(()=>save(saveParams(initial,{p_data:{[forbidden]:'changed'}})),'Cannot alter '+forbidden);
 await denied(()=>save(saveParams(initial,{p_data:{patient_ic:'900101-**-****'}})),'KEEP cannot replace masked IC');
 await denied(()=>save(saveParams(initial,{p_ic_mode:'SET',p_data:{patient_ic:'900101-**-****'}})),'SET rejects masked IC');
 for(const age of ['-1','131','1.5','junk',null])await denied(()=>save(saveParams(initial,{p_data:{age}})),'Invalid age');
 await denied(()=>save(saveParams(initial,{p_data:{age_months:'12'}})),'Invalid months');
 // Historical display may derive age from DOB, but audit must retain the exact stored values.
 sql(`update public.orl_requests set age=77,age_months=11 where id=${lit(original)}`);
 assert.equal(view(oldSlot).patient.age,77);assert.equal(view(oldSlot).patient.age_months,11,'Known DOB must not hide a stored manual age in the correction form');
 save(saveParams(view(oldSlot),{p_data:{age:'76',age_months:'10'},p_reason:'Synthetic exact stored age correction'}));
 const exactAgeAudit=JSON.parse(sql(`select details::jsonb from public.orl_audit_log where record_id=${lit(original)} and action='PAST_CASE_CORRECTED' order by id desc limit 1`));
 assert.equal(exactAgeAudit.before.age,77);assert.equal(exactAgeAudit.before.age_months,11);assert.equal(exactAgeAudit.after.age,76);assert.equal(exactAgeAudit.after.age_months,10);
 sql(`update public.orl_requests set age=null,age_months=null where id=${lit(held)}`);
 assert.equal(view(heldSlot).patient.age,null);
 save(saveParams(view(heldSlot),{p_data:{diagnosis:'Corrected diagnosis with unknown historical age'}}));
 assert.equal(state(held).age,null);assert.equal(state(held).age_months,null);
 const unknownAgeAudit=JSON.parse(sql(`select details::jsonb from public.orl_audit_log where record_id=${lit(held)} and action='PAST_CASE_CORRECTED' order by id desc limit 1`));
 assert.equal(unknownAgeAudit.before.age,null);assert.equal(unknownAgeAudit.after.age,null);assert.equal(unknownAgeAudit.before.age_months,null);assert.equal(unknownAgeAudit.after.age_months,null);
 for(const [target,id] of [[oldSlot,original],[heldSlot,held],[doneSlot,done],[cancelledSlot,cancelled]]){
  const before=frozen(id),priorSlot=slotState(target),priorIdentity=identity(id),priorAge=state(id),v=view(target);
  const result=save(saveParams(v,{p_data:{remark:'Historical correction '+target,diagnosis:'Corrected synthetic diagnosis'}}));
  assert.equal(result.request_id,id);assert.equal(result.status,state(id).status);assert.equal(frozen(id),before,'Status, lifecycle, actor and count preserved');
  assert.deepEqual(slotState(target),priorSlot,'Edit does not open, move or reorder slots');assert.equal(identity(id),priorIdentity,'KEEP does not modify encrypted identity');
  assert.equal(state(id).age,priorAge.age);assert.equal(state(id).age_months,priorAge.age_months,'Partial diagnosis/remark edit never changes age');
  assert.notEqual(state(id).updated_at,v.expected_version);await denied(()=>save(saveParams(v)),'Replay of old correction denied');
 }
 // The ordinary Edit route must not bypass the Webmaster-only reasoned path.
 const oldEdit=(role,id)=>rpc('orl_ic_c1_mutate',{p_session_token:actors[role],p_operation:'EDIT',p_from_slot:state(id).assigned_slot_id,p_to_slot:null,p_expected_request:id,p_data:{remark:'Normal edit'},p_action:'CONFIRM',p_reason:'',p_ic_mode:'KEEP',p_envelope:null,p_search:null,p_generation:generation,p_expected_version:state(id).updated_at});
 for(const role of ['STAFF','ADMIN','WEBMASTER'])await denied(()=>oldEdit(role,original),'Ordinary past edit is denied even through old clients');
 assert.equal(oldEdit('ADMIN',futureCase),'UPDATED','Future ordinary edit is unchanged');
 // Explicit encrypted replacement/clear retain historical age and fail atomically.
 const newRaw='910202-02-1234',idView=view(oldSlot),beforeIdentityChange=frozen(original);
 save(saveParams(idView,{p_ic_mode:'SET',p_data:{patient_ic:newRaw,remark:'Corrected IC '+newRaw},p_reason:'Corrected '+newRaw,p_envelope:await engine.encrypt(newRaw,original),p_search:await engine.searchHash(newRaw)}));
 assert.equal(state(original).patient_ic,'910202-**-****');assert.equal(state(original).remark.includes(newRaw),false);assert.equal(frozen(original),beforeIdentityChange);
 const expectedAge=JSON.parse(sql(`select public.orl_age_parts(${lit(newRaw)},${lit(past)})`));assert.equal(state(original).age,expectedAge.years);assert.equal(state(original).age_months,expectedAge.months);
 const current=view(oldSlot);await denied(()=>save(saveParams(current,{p_ic_mode:'SET',p_data:{patient_ic:raw},p_envelope:{version:1},p_search:{normalization_version:1}})),'Bad encryption rolls back clinical edit');
 save(saveParams(current,{p_ic_mode:'SET',p_data:{patient_ic:''}}));assert.equal(state(original).patient_ic,'');assert.equal(identity(original),'');
 // Add missing cases to both types, including CLOSED slots and CANCELLED parent day.
 const addMain=slot(past),addSpecial=slot(past2,'SPECIAL','CLOSED');
 const unauthorizedAdd=await addParams(addMain);
 for(const role of ['STAFF','ADMIN'])await denied(()=>save({...unauthorizedAdd,p_session_token:actors[role]}),role+' cannot add a missing historical case');
 sql(`update public.orl_ot_sessions set status='CANCELLED',note='Synthetic closed historical date' where id=${lit(session(past2))}`);
 for(const target of [addMain,addSpecial]){
  const beforeSession=sql(`select to_jsonb(s) from public.orl_ot_sessions s where id=${lit(slotState(target).session_id)}`),p=await addParams(target);
  const result=save(p),record=state(p.p_request_id);
  assert.equal(result.mode,'ADD');assert.equal(record.status,'SCHEDULED');assert.equal(record.ot_hold,false);assert.equal(record.completed_at,null);assert.equal(record.completed_by,null);
  assert.equal(record.created_by,actors.WEBMASTER);assert.equal(record.postpone_count,0);assert.equal(record.assigned_slot_id,target);assert.equal(slotState(target).status,'CONFIRMED');
  assert.equal(record.patient_ic,'900101-**-****');assert.ok(identity(record.id));assert.equal(sql(`select to_jsonb(s) from public.orl_ot_sessions s where id=${lit(slotState(target).session_id)}`),beforeSession,'Past day closure/status unchanged');
  await denied(()=>save(p),'Double-click cannot duplicate past creation');
 }
 const blankTarget=slot(past),blank=await addParams(blankTarget);blank.p_data.patient_ic='';blank.p_envelope=null;blank.p_search=null;save(blank);assert.equal(identity(blank.p_request_id),'');
 const unoccupied=slot(past),reused=await addParams(unoccupied);reused.p_request_id=blank.p_request_id;
 await denied(()=>save(reused),'An old request ID cannot resurrect a case');
 const malformed=await addParams(unoccupied);malformed.p_envelope={version:1};await denied(()=>save(malformed),'Malformed identity rolls back new request, receipt, slot and audit');
 assert.equal(slotState(unoccupied).request_id,null);
 // Same-date duplicate rejected, but a different-date episode is legitimate.
 const duplicateTarget=slot(past),duplicate=await addParams(duplicateTarget,{mrn:state(done).mrn,surgery:state(done).surgery});
 await denied(()=>save(duplicate),'Same-day duplicate against a completed episode is rejected');
 const alternateTarget=slot(past2),alternate=await addParams(alternateTarget,{mrn:state(done).mrn,surgery:state(done).surgery});save(alternate);
 const futureEpisodeTarget=slot(past),futureEpisode=await addParams(futureEpisodeTarget,{mrn:state(futureCase).mrn,surgery:state(futureCase).surgery});save(futureEpisode);
 await denied(()=>save(saveParams(view(oldSlot),{p_data:{mrn:state(done).mrn,surgery:state(done).surgery}})),'Edit cannot create same-date duplicate');
 // Date, slot and external lifecycle changes invalidate the reviewed fingerprint.
 const staleTarget=slot(past),stale=await addParams(staleTarget);sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(staleTarget)}`);
 await denied(()=>save(stale),'Slot closure changed');
 const staleSession=saveParams(view(heldSlot));sql(`update public.orl_ot_sessions set note=note||' changed' where id=${lit(session(past))}`);
 await denied(()=>save(staleSession),'Parent date snapshot changed');
 const staleIdentity=saveParams(view(heldSlot));sql(`update orl_private.request_identity set updated_at=clock_timestamp() where request_id=${lit(held)}`);
 await denied(()=>save(staleIdentity),'Identity snapshot changed');
 const activeToken=actors.WEBMASTER;sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${lit(activeToken)}`);
 await denied(()=>view(oldSlot),'Expired session denied');sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${lit(activeToken)}`);
 // Normal booking still cannot target a historical empty slot for any role.
 const ordinary=crypto.randomUUID(),ordinaryData=data({patient_ic:''});rpc('orl_ic_c1_create',{p_session_token:actors.WEBMASTER,p_request_id:ordinary,p_data:ordinaryData,p_envelope:null,p_search:null,p_generation:generation});
 sql(`update public.orl_requests set status='APPROVED' where id=${lit(ordinary)}`);
 await denied(()=>rpc('orl_ic_c1_assign',{p_session_token:actors.WEBMASTER,p_request_id:ordinary,p_slot_id:unoccupied,p_generation:generation,p_slot_generation:generation}),'Ordinary assign still rejects past');
 // Serialize two simultaneous submissions: exactly one claims an empty slot.
 const concurrentTarget=slot(past),left=await addParams(concurrentTarget),right=await addParams(concurrentTarget);
 const asyncSql=input=>new Promise(resolve=>{const child=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);child.on('close',code=>resolve({code,output,error}));child.stdin.end(input)});
 const race=await Promise.all([asyncSql(callSql('orl_ic_past_case_save',left)),asyncSql(callSql('orl_ic_past_case_save',right))]);assert.equal(race.filter(x=>x.code===0).length,1);assert.equal(race.filter(x=>x.code!==0).length,1);
 assert.equal(sql(`select count(*) from public.orl_requests where id in(${lit(left.p_request_id)},${lit(right.p_request_id)})`),'1');
 assert.equal(sql(`select count(*) from orl_private.c1_creation_receipts where request_id in(${lit(left.p_request_id)},${lit(right.p_request_id)})`),'1');
 const duplicateRaceMrn='PAST-RACE-'+crypto.randomUUID(),raceA=await addParams(slot(past),{mrn:duplicateRaceMrn}),raceB=await addParams(slot(past),{mrn:duplicateRaceMrn});
 const duplicateRace=await Promise.all([asyncSql(callSql('orl_ic_past_case_save',raceA)),asyncSql(callSql('orl_ic_past_case_save',raceB))]);
 assert.equal(duplicateRace.filter(x=>x.code===0).length,1,'Only one same-date case wins even in different slots');
 assert.equal(sql(`select count(*) from public.orl_requests where mrn=${lit(duplicateRaceMrn)}`),'1');
 // Generation invalidation blocks a delayed reviewed save even if rows match.
 const staleGeneration=saveParams(view(oldSlot));sql('update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton');
 await denied(()=>save(staleGeneration),'Restore generation mismatch');
 const audits=JSON.parse(sql("select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a where action in('PAST_CASE_ADDED','PAST_CASE_CORRECTED')"));
 for(const a of audits){assert.equal(a.user_role,'WEBMASTER');assert.equal(a.user_id,actors.WEBMASTER);assert.ok(a.occurred_at);const detail=JSON.parse(a.details);assert.ok(detail.reason);assert.ok(detail.after);assert.equal(detail.after.patient_ic===raw,false);if(a.action==='PAST_CASE_CORRECTED')assert.ok(detail.before)}
 assert.equal(JSON.stringify(audits).includes(raw),false);assert.equal(JSON.stringify(audits).includes(newRaw),false);
 assert.equal(sql("select count(*) from orl_private.c1_write_permit"),'0');assert.equal(sql("select (orl_private.c6_stats()->>'plaintext_rows')::int"),'0');assert.equal(sql("select (orl_private.c6_stats()->>'identity_mismatch')::int"),'0');
 const releaseAudit=JSON.parse(run('security/release/audit-past-case.sql'));assert.equal(Object.keys(releaseAudit).length,12);for(const [name,ok] of Object.entries(releaseAudit))assert.equal(ok,true,name);
});
