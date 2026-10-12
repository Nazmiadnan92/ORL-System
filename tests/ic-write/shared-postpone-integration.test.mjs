import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';
import {createIcRpcRouter,bindProtectedIcField} from '../../docs/ic-client.mjs';

test('063: actual Staff Postpone form/router/gateway moves any creator to Main with immutable cross-owner clinical data and unchanged safeguards',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=x=>x==null?'NULL':"'"+String(typeof x==='object'?JSON.stringify(x):x).replaceAll("'","''")+"'";
 const run=path=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+path,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 const calls=[],sends=[];
 const rpc=async(name,p)=>{calls.push({name,p});return JSON.parse(sql(`set role service_role;select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}))`))};
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const today=sql("select (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date"),raw='900101-01-1234';
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32))),config={context:'synthetic-shared-postpone',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}};
 const engine=await createIdentityCrypto(config),actors={};
 for(const who of ['STAFF_A','STAFF_B','ADMIN','WEBMASTER']){
  const id=crypto.randomUUID();actors[who]=id;
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('shared_postpone_'+who)},'unused',${lit('Synthetic '+who)},${lit(who.startsWith('STAFF')?'STAFF':who)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const origin='https://synthetic.invalid';let token=actors.STAFF_A;
 // Authentication, generation and mutations use real SQL. Rate accounting is
 // outside this migration and is injected as a pass so denial snapshots are exact.
 const gateway=createIcGateway({enabled:true,origins:[origin],rpc,cryptoConfig:()=>config,rateLimit:async()=>true});
 const router=createIcRpcRouter({session:()=>token,send:async(operation,p)=>{
  sends.push({operation,p});const response=await gateway(new Request(origin+'/ic-requests',{method:'POST',headers:{origin,'Content-Type':'application/json','x-orl-session':token},body:JSON.stringify({operation,...p})}));
  const body=await response.json();if(!response.ok)throw Error(body.error);return body;
 },legacy:async(name,p)=>{assert.equal(name,'orl_get_schedule');return JSON.parse(sql(`set role anon;select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.orl_get_schedule(${lit(p.p_session_token)},${p.p_year},${p.p_month}) s`))}});
 const read=async()=>router('orl_get_schedule',{p_session_token:token,p_year:2094,p_month:6});
 const session=date=>{sql(`insert into public.orl_ot_sessions(ot_date,day_name,holiday_override) values(${lit(date)},'Synthetic',true) on conflict(ot_date) do nothing`);return sql(`select id from public.orl_ot_sessions where ot_date=${lit(date)}`)};
 const fixtureDates=Array.from({length:10},(_,i)=>'2094-06-'+String(i+1).padStart(2,'0'));
 for(const date of fixtureDates)session(date);await read();
 const slot=(date,type,n)=>sql(`select sl.id from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where s.ot_date=${lit(date)} and sl.slot_type=${lit(type)} and sl.slot_number=${n}`);
 const create=async who=>{
  const id=crypto.randomUUID(),data={patient_ic:raw,age:'30',age_months:'0',patient_name:'Synthetic shared postpone '+who,mrn:'SHPOST-'+id,surgery:'Original procedure',diagnosis:'Original diagnosis',doctor:'Original doctor',specialist:'Original specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Original remark'};
  await rpc('orl_ic_c1_create',{p_session_token:actors[who],p_request_id:id,p_data:data,p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation});
  sql(`update public.orl_requests set status='CONFIRMED' where id=${lit(id)}`);return id;
 };
 const book=async(request,target)=>rpc('orl_ic_c1_assign',{p_session_token:actors.ADMIN,p_request_id:request,p_slot_id:target,p_generation:generation,p_slot_generation:generation});
 const fixtures=[];
 for(const [i,who]of ['STAFF_B','ADMIN','WEBMASTER','STAFF_A'].entries()){
  const request=await create(who),neighbor=await create('ADMIN'),date=fixtureDates[i*2],targetDate=fixtureDates[i*2+1];
  const source=slot(date,'MAIN',1),next=slot(date,'MAIN',2),target=slot(targetDate,'MAIN',1);
  await book(request,source);await book(neighbor,next);
  sql(`update public.orl_requests set postpone_count=2,updated_at='2094-01-01T12:00:00.123456Z' where id=${lit(request)}`);
  fixtures.push({who,request,neighbor,date,targetDate,source,next,target});
 }
 const otherWaiting=await create('ADMIN'),occupied=await create('ADMIN'),first=fixtures[0],occupiedTarget=slot(first.targetDate,'MAIN',2);
 await book(occupied,occupiedTarget);
 const special=slot(first.targetDate,'SPECIAL',1),closed=slot(first.targetDate,'MAIN',3);
 sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(closed)}`);
 const holidaySession=session('2094-07-15'),holiday=crypto.randomUUID(),past=crypto.randomUUID();
 sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${lit(holiday)},${lit(holidaySession)},'MAIN',1,'AVAILABLE');
  insert into public.orl_holidays(holiday_date,title,is_active) values('2094-07-15','Synthetic shared postponement holiday',true);`);
 const pastDate=sql("select (clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-1"),pastSession=session(pastDate);
 sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${lit(past)},${lit(pastSession)},'MAIN',9100,'AVAILABLE')`);

 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const unrelated=()=>sql("select md5(string_agg(pg_get_functiondef(p.oid),E'\\n' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.prokind='f' and p.oid<>'public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)'::regprocedure");
 const access=()=>sql("select md5(jsonb_build_object('functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private')),'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','orl_private')),'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in('public','orl_private')))::text)");
 const state=id=>JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${lit(id)}`));
 const clinical=id=>sql(`select to_jsonb(r)-array['assigned_slot_id','status','postpone_count','postpone_history','updated_at'] from public.orl_requests r where id=${lit(id)}`);
 const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(id)}`);
 const rowFor=async request=>(await read()).flatMap(s=>s.slots).find(s=>s.request_id===request);
 const moveArgs=(row,target,extra={})=>({p_session_token:token,p_from_slot_id:row.id,p_to_slot_id:target,p_expected_request_id:row.request_id,p_expected_version:row._ic_edit_version,p_generation:row._ic_generation,p_ic_mode:'KEEP',p_data:{},p_reason:'Synthetic shared postponement',...extra});
 const firstRow=await rowFor(first.request);
 await assert.rejects(()=>router('orl_move_postponed_checked',moveArgs(firstRow,first.target)));
 const before=snapshot(),beforeFunctions=unrelated(),beforeAccess=access();
 run('supabase/063_staff_shared_postpone.sql');
 assert.equal(snapshot(),before,'Migration mutates no application data');assert.equal(unrelated(),beforeFunctions,'Only checked Move changes');assert.equal(access(),beforeAccess);
 assert.throws(()=>run('supabase/063_staff_shared_postpone.sql'));assert.equal(snapshot(),before,'Rejected reinstall is atomic');
 const audit=JSON.parse(run('security/release/audit-shared-postpone.sql'));assert.equal(Object.keys(audit).length,13);for(const [name,ok]of Object.entries(audit))assert.equal(ok,true,name);
 const denied=async fn=>{const frozen=snapshot();await assert.rejects(fn);assert.equal(snapshot(),frozen,'Failed action changes no application data or audit')};
 for(const target of [special,occupiedTarget,closed,holiday,past])await denied(()=>router('orl_move_postponed_checked',moveArgs(firstRow,target)));
 for(const reason of ['', '   ', 'x'.repeat(4097)])await denied(()=>router('orl_move_postponed_checked',moveArgs(firstRow,first.target,{p_reason:reason})));
 await denied(()=>router('orl_move_postponed_checked',moveArgs(firstRow,first.target,{p_generation:crypto.randomUUID()})));
 await denied(()=>router('orl_move_postponed_checked',moveArgs(firstRow,first.target,{p_ic_mode:'SET',p_data:{patient_ic:'OTHER-IDENTITY'}})));
 await denied(()=>router('orl_edit_scheduled_request_checked',{p_session_token:token,p_slot_id:firstRow.id,p_expected_request_id:first.request,p_expected_version:firstRow._ic_edit_version,p_generation:generation,p_ic_mode:'KEEP',p_data:{surgery:'Forbidden'},p_action:'CONFIRM'}));
 await denied(()=>rpc('orl_ic_c1_assign',{p_session_token:token,p_request_id:otherWaiting,p_slot_id:first.target,p_generation:generation,p_slot_generation:generation}));
 await denied(()=>rpc('orl_ic_c1_review',{p_session_token:token,p_request_id:first.request,p_action:'APPROVE',p_note:'Forbidden',p_expected_slot:first.source,p_generation:generation}));
 await denied(async()=>sql(`set role anon;select public.orl_booking_move_view(${lit(token)},${lit(first.request)})`));
 for(const dbRole of ['anon','authenticated','service_role'])assert.equal(sql(`select has_function_privilege(${lit(dbRole)},'public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)','EXECUTE')`),'f');
 sql(`update public.orl_requests set updated_at=updated_at+interval '1 microsecond' where id=${lit(first.request)}`);
 await denied(()=>router('orl_move_postponed_checked',moveArgs(firstRow,first.target)));
 const freshFirst=await rowFor(first.request);
 sql('update orl_private.site_maintenance set enabled=true where singleton');
 try{await denied(()=>router('orl_move_postponed_checked',moveArgs(freshFirst,first.target)))}finally{sql('update orl_private.site_maintenance set enabled=false where singleton')}

 // Exercise the actual app form, including disabled IC field, captured record
 // revision/generation and the cross-owner Staff move-only payload.
 const app=readFileSync(new URL('../../docs/app.js',import.meta.url),'utf8');
 const active=name=>app.split(/\r?\n/).filter(line=>line.startsWith('function '+name+'(')||line.startsWith('async function '+name+'(')).at(-1);
 const protectedHelpers=app.slice(app.indexOf('function configureProtectedIcForm('),app.indexOf('async function carryProtectedIcChoice('));
 const formHarness=rows=>{
  let form;const messages=[],controls={'#postMonth':{},'#postYear':{}},doc={createTextNode:text=>({text}),createElement:tag=>({tag,children:[],append(...items){this.children.push(...items)},addEventListener(type,fn){this[type]=fn}})};
  const ctx=vm.createContext({token,user:{role:'STAFF',user_id:actors.STAFF_A},window:{_schedule:rows,_scheduleYM:{year:2094,month:6}},postponeBusy:false,
   $:selector=>{const match=selector.match(/^#postponeForm \[name="(\w+)"\]$/);return match?form.elements[match[1]]:selector==='#postponeForm'?form:controls[selector]},
   modal:()=>{const elements={};for(const name of ['patient_ic','age','age_months','mrn','patient_name','surgery','diagnosis','doctor','specialist','sub_specialty','phone','remark','reason'])elements[name]={value:'',dataset:{},parentElement:{after(){}},dispatchEvent(){}};form={elements}},
   protectedIcEnabled:()=>true,protectedIcClient:async()=>({bindProtectedIcField:(f,options)=>bindProtectedIcField(f,{...options,document:doc})}),
   maskPatientIc:value=>value,field:()=>'',editSlotField:()=>'',editSubspecialtyField:()=>'',ageFields:()=>'',months:[],esc:value=>String(value),formatSystemDate:value=>value,patientNameCase:value=>value,
   bindAgeToIc:()=>{},bindClinicalFormatting:()=>{},normalizeClinicalFields:()=>{},isPastOtDate:date=>typeof date==='string'&&date<today,
   loadPostponeSlots:()=>{},closeModal:()=>{},reloadSchedule:async()=>{},toast:message=>messages.push(message),rpc:router,Event,
   FormData:class{constructor(f){this.rows=Object.entries(f.elements).filter(([,el])=>!el.disabled).map(([name,el])=>[name,String(el.value)])}[Symbol.iterator](){return this.rows[Symbol.iterator]()}}
  });
  vm.runInContext(protectedHelpers+'\n'+active('postponeSlot')+'\n'+active('completePostpone'),ctx);
  return {ctx,messages,get form(){return form}};
 };
 for(const f of fixtures){
  token=actors.STAFF_A;const rows=await read(),row=rows.flatMap(s=>s.slots).find(s=>s.request_id===f.request);
  assert.equal(row.patient_ic,'900101-**-****');assert.equal(row.patient_ic_masked,true);assert.ok(!JSON.stringify(row).includes(raw));
  const old=state(f.request),oldClinical=clinical(f.request),oldIdentity=identity(f.request),neighborClinical=clinical(f.neighbor);
  const h=formHarness(rows);h.ctx.postponeSlot(f.source);await h.form._icReady;
  assert.equal(h.form._postponeMoveOnly,f.who!=='STAFF_A');
  assert.equal(h.form.elements.patient_ic.disabled,true);assert.equal(h.form._icGeneration,generation);assert.equal(h.form._icEditVersion,row._ic_edit_version);
  h.form.elements.reason.value='Synthetic postponed '+f.who;
  h.form.elements.surgery.value='Updated own procedure';h.form.elements.diagnosis.value='Updated own diagnosis';
  h.form.elements.patient_name.value='Forbidden name';h.form.elements.mrn.value='Forbidden MRN';h.form.elements.doctor.value='Forbidden doctor';h.form.elements.remark.value='Forbidden remark';
  await h.ctx.completePostpone(f.target);
  assert.ok(h.messages.includes('New slot reserved for Admin confirmation.'),h.messages.join('; '));
  const sent=sends.filter(x=>x.operation==='MOVE').at(-1),mutation=calls.filter(x=>x.name==='orl_ic_c1_mutate').at(-1);
  assert.equal(sent.p.ic_mode,'KEEP');assert.equal(sent.p.generation,generation);assert.equal(sent.p.expected_version,row._ic_edit_version);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.p.data)),f.who==='STAFF_A'?{surgery:'Updated own procedure',diagnosis:'Updated own diagnosis'}:{});
  assert.deepEqual(mutation.p.p_data,JSON.parse(JSON.stringify(sent.p.data)));
  const after=state(f.request);assert.equal(after.assigned_slot_id,f.target);assert.equal(after.status,'CONFIRMED');assert.equal(after.created_by,actors[f.who]);
  assert.equal(after.postpone_count,old.postpone_count+1);assert.equal(after.postpone_history.length,old.postpone_history.length+1);assert.equal(after.postpone_history.at(-1).reason,'Synthetic postponed '+f.who);
  assert.equal(sql(`select status from public.orl_ot_slots where id=${lit(f.target)}`),'RESERVED');
  assert.equal(sql(`select request_id from public.orl_ot_slots where id=${lit(f.source)}`),f.neighbor,'Source released and next Main patient compacted into it');
  assert.equal(sql(`select request_id is null and status='AVAILABLE' from public.orl_ot_slots where id=${lit(f.next)}`),'t');
  assert.equal(state(f.neighbor).assigned_slot_id,f.source);assert.equal(clinical(f.neighbor),neighborClinical);assert.equal(identity(f.request),oldIdentity);
  if(f.who!=='STAFF_A')assert.equal(clinical(f.request),oldClinical,'Cross-owner clinical fields and creator remain exact');
  else{assert.equal(after.surgery,'Updated own procedure');assert.equal(after.diagnosis,'Updated own diagnosis');const previous=JSON.parse(oldClinical),current=JSON.parse(clinical(f.request));delete previous.surgery;delete previous.diagnosis;delete current.surgery;delete current.diagnosis;assert.deepEqual(current,previous)}
  assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${lit(f.request)} and action='PATIENT_POSTPONED'`),'1');
  await denied(()=>router('orl_move_postponed_checked',moveArgs(row,f.target)));
  token=actors.ADMIN;const moved=await rowFor(f.request),beforeConfirmIdentity=identity(f.request);
  assert.equal(await router('orl_edit_scheduled_request_checked',{p_session_token:token,p_slot_id:moved.id,p_expected_request_id:f.request,p_expected_version:moved._ic_edit_version,p_generation:moved._ic_generation,p_ic_mode:'KEEP',p_data:{},p_action:'CONFIRM'}),'UPDATED');
  assert.equal(state(f.request).status,'SCHEDULED');assert.equal(state(f.request).postpone_count,old.postpone_count+1);assert.equal(identity(f.request),beforeConfirmIdentity);
  assert.equal(sql(`select status from public.orl_ot_slots where id=${lit(f.target)}`),'CONFIRMED');
 }

 // The database independently discards hostile clinical fields for cross-owner
 // moves, even when a caller bypasses the app's move-only form payload.
 token=actors.STAFF_A;const victim=fixtures[1],row=await rowFor(victim.request),frozenClinical=clinical(victim.request),frozenIdentity=identity(victim.request);
 const tampered={patient_name:'HACKED',mrn:'HACKED',surgery:'HACKED',diagnosis:'HACKED',doctor:'HACKED',specialist:'HACKED',phone:'HACKED',sub_specialty:'HACKED',remark:'HACKED',age:'99',age_months:'11'};
 const target=slot('2094-06-10','MAIN',1);
 assert.equal(await router('orl_move_postponed_checked',moveArgs(row,target,{p_data:tampered,p_reason:'  Synthetic '+raw+'  '})),'RESERVED');
 assert.equal(clinical(victim.request),frozenClinical);assert.equal(identity(victim.request),frozenIdentity);
 assert.equal(state(victim.request).postpone_history.at(-1).reason,'Synthetic 900101-**-****');
 assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${lit(victim.request)} and action='PATIENT_POSTPONED'`),'2');
 assert.equal(unrelated(),beforeFunctions);assert.equal(access(),beforeAccess);
 const finalAudit=JSON.parse(run('security/release/audit-shared-postpone.sql'));for(const [name,ok]of Object.entries(finalAudit))assert.equal(ok,true,name);
});
