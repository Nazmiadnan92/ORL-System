import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('057: existing approved assignment, atomic reviewed case moves, duplicate boundary, exact versions, private identity and restore fencing',async(t)=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v===null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const call=(name,p,role='anon')=>JSON.parse(sql(`set role ${role};select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}))`));
 const install=()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../supabase/057_booking_move_requests.sql',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 const before=sql("select md5(jsonb_build_object('r',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'i',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),'s',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'a',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a))::text)");
 const legacy=sql("select md5(prosrc) from pg_proc where oid='public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)'::regprocedure");
 install();assert.throws(install);
 assert.equal(sql("select md5(jsonb_build_object('r',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'i',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),'s',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'a',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a))::text)"),before);
 assert.equal(sql("select md5(prosrc) from pg_proc where oid='public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)'::regprocedure"),legacy);
 const signatures=['orl_booking_assign_view(uuid,uuid)','orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)',
  'orl_booking_move_view(uuid,uuid)','orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)',
  'orl_booking_move_list(uuid)','orl_booking_move_dates(uuid,integer,integer)','orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)'];
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(sql(`select has_table_privilege('${role}','orl_private.booking_move_requests','SELECT,INSERT,UPDATE,DELETE')`),'f');
  for(const helper of ['booking_move_summary(uuid)','booking_same_date_guard()'])assert.equal(sql(`select has_function_privilege('${role}','orl_private.${helper}','EXECUTE')`),'f');
  for(const signature of signatures)assert.equal(sql(`select has_function_privilege('${role}','public.${signature}','EXECUTE')`),role==='service_role'?'f':'t');
 }
 assert.equal(sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='orl_private.booking_move_requests'::regclass"),'t');
 // Deterministic 12-digit UUID suffixes previously collided with the general
 // free-text IC redactor. Protocol identifiers must round-trip byte-for-byte.
 let fixtureSequence=1;
 const fixtureId=()=>`${(fixtureSequence++).toString(16).padStart(8,'0')}-beef-4abc-8def-123456789012`;
 const actors={};
 for(const role of ['STAFF','OTHER','ADMIN','WEBMASTER']){
  const id=fixtureId();actors[role]=id;
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('moves_'+role)},'unused','Synthetic ${role}',${lit(role==='OTHER'?'STAFF':role)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const originalGeneration=sql('select generation from orl_private.c1_restore_generation where singleton');
 const generation=fixtureId();
 sql(`update orl_private.c1_restore_generation set generation=${lit(generation)} where singleton`);
 t.after(()=>sql(`update orl_private.c1_restore_generation set generation=${lit(originalGeneration)} where singleton`));
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const engine=await createIdentityCrypto({context:'synthetic-booking-moves',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const createRequest=async({actor=actors.STAFF,mrn,surgery='Synthetic Procedure',approved=false,count=3,override=false}={})=>{
  const id=fixtureId(),raw='010203-04-5678';
  const data={patient_ic:raw,age:'20',age_months:'0',patient_name:'Synthetic Booking',mrn:mrn??'MOVE-'+id,surgery,
   diagnosis:'Synthetic diagnosis',doctor:'Synthetic',specialist:'Synthetic',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic',allow_duplicate:override,duplicate_reason:override?'Separate synthetic episode':''};
  call('orl_ic_c1_create',{p_session_token:actor,p_request_id:id,p_data:data,p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation},'service_role');
  sql(`update public.orl_requests set status=${lit(approved?'APPROVED':'SCHEDULED')},postpone_count=${count},updated_at='2090-01-01T00:00:00.123456Z' where id=${lit(id)}`);
  return id;
 };
 const addSession=(date,types=['MAIN','SPECIAL'])=>{
  const session=fixtureId(),slots=types.map(()=>fixtureId());
  sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${lit(session)},${lit(date)},'Synthetic');
   insert into public.orl_ot_slots(id,session_id,slot_type,slot_number) values ${slots.map((id,i)=>`(${lit(id)},${lit(session)},${lit(types[i])},${i+1})`).join(',')}`);
  return {session,slots,date};
 };
 const book=(request,slot)=>sql(`update public.orl_ot_slots set request_id=${lit(request)},status='CONFIRMED' where id=${lit(slot)};
  update public.orl_requests set assigned_slot_id=${lit(slot)} where id=${lit(request)}`);
 const view=(request,actor=actors.STAFF)=>call('orl_booking_move_view',{p_session_token:actor,p_request_id:request});
 const proposalArgs=(v,date,actor=actors.STAFF,reason='Synthetic move 010203-04-5678')=>({p_session_token:actor,p_request_id:v.request_id,p_target_date:date,p_reason:reason,p_expected_from_slot:v.from_slot_id,p_expected_version:v.request_version,p_generation:v.generation});
 const propose=(v,date,actor=actors.STAFF,reason)=>call('orl_booking_move_request',proposalArgs(v,date,actor,reason));
 const reviewArgs=(m,target,actor=actors.ADMIN,action='APPROVE')=>({p_session_token:actor,p_move_id:m.id,p_action:action,p_target_slot:target,p_expected_move_version:m.move_version,p_expected_request_version:m.request_version,p_generation:m.generation});
 const review=(m,target,actor=actors.ADMIN,action='APPROVE')=>call('orl_booking_move_review',reviewArgs(m,target,actor,action));
 const list=(actor=actors.ADMIN)=>call('orl_booking_move_list',{p_session_token:actor});
 const state=id=>JSON.parse(sql(`select jsonb_build_object('slot',assigned_slot_id,'status',status,'count',postpone_count,'history',postpone_history,'version',updated_at) from public.orl_requests where id=${lit(id)}`));
 const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(id)}`);
 const clinical=id=>sql(`select to_jsonb(r)-array['assigned_slot_id','status','postpone_count','postpone_history','updated_at'] from public.orl_requests r where id=${lit(id)}`);
 const frozen=id=>({state:state(id),identity:identity(id),clinical:clinical(id)});
 const mutationSnapshot=()=>sql("select md5(jsonb_build_object('slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'queue',(select jsonb_agg(to_jsonb(m) order by id) from orl_private.booking_move_requests m),'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a))::text)");
 const failUnchanged=(id,fn)=>{const before=frozen(id),mutations=mutationSnapshot();assert.throws(fn);assert.deepEqual(frozen(id),before);assert.equal(mutationSnapshot(),mutations)};

 // Existing approved cases retain identity, approval fields and postponement count.
 const assignment=addSession('2091-01-01');
 for(const [i,actor]of [actors.ADMIN,actors.WEBMASTER].entries()){
  const id=await createRequest({approved:true}),baseline=frozen(id);
  assert.throws(()=>call('orl_booking_assign_view',{p_session_token:actors.STAFF,p_request_id:id}));
  const v=call('orl_booking_assign_view',{p_session_token:actor,p_request_id:id});assert.match(v.request_version,/\.123456[+-]/);
  assert.equal(v.request_id,id);assert.equal(v.generation,generation);assert.equal(v.request_version,state(id).version);
  const p={p_session_token:actor,p_request_id:id,p_target_slot:assignment.slots[i],p_expected_version:v.request_version,p_generation:v.generation};
  failUnchanged(id,()=>call('orl_booking_assign_existing',{...p,p_session_token:actors.STAFF}));
  failUnchanged(id,()=>call('orl_booking_assign_existing',{...p,p_expected_version:'2090-01-01T00:00:00.123457Z'}));
  failUnchanged(id,()=>call('orl_booking_assign_existing',{...p,p_generation:crypto.randomUUID()}));
  assert.equal(call('orl_booking_assign_existing',p),'CONFIRMED');
  assert.equal(state(id).count,baseline.state.count);assert.equal(clinical(id),baseline.clinical);assert.equal(identity(id),baseline.identity);
  assert.equal(state(id).slot,assignment.slots[i]);assert.throws(()=>call('orl_booking_assign_existing',p));
 }
 const unassigned=await createRequest({approved:true});const unassignedView=call('orl_booking_assign_view',{p_session_token:actors.ADMIN,p_request_id:unassigned});
 failUnchanged(unassigned,()=>call('orl_booking_assign_existing',{p_session_token:actors.ADMIN,p_request_id:unassigned,p_target_slot:assignment.slots[0],p_expected_version:unassignedView.request_version,p_generation:generation}));

 const source=addSession('2091-02-10'),later=addSession('2091-02-20',['SPECIAL']),earlier=addSession('2091-02-01'),wrongDate=addSession('2091-02-22');
 const id=await createRequest();book(id,source.slots[0]);const v=view(id),baseline=frozen(id);
 assert.equal(v.request_id,id);assert.equal(v.from_slot_id,source.slots[0]);assert.equal(v.generation,generation);assert.equal(v.request_version,state(id).version);
 assert.throws(()=>view(id,actors.OTHER));assert.ok(!JSON.stringify(v).includes('010203-04-5678'));assert.equal(v.patient_ic,undefined);
 failUnchanged(id,()=>propose(v,source.date));assert.equal(list().length,0);
 failUnchanged(id,()=>propose(v,later.date,actors.OTHER));
 failUnchanged(id,()=>propose({...v,request_version:'2090-01-01T00:00:00.123457Z'},later.date));
 // Override only this synthetic default, then immediately restore it, so the
 // server-generated proposal ID also deterministically has a numeric suffix.
 const numericMoveId=fixtureId();let m;
 sql(`alter table orl_private.booking_move_requests alter column id set default ${lit(numericMoveId)}::uuid`);
 try{m=propose(v,later.date)}finally{sql('alter table orl_private.booking_move_requests alter column id set default gen_random_uuid()')}
 assert.equal(m.id,numericMoveId);assert.equal(m.request_id,id);assert.equal(m.from_slot_id,source.slots[0]);
 assert.equal(m.requested_by,actors.STAFF);assert.equal(m.generation,generation);assert.equal(m.request_version,v.request_version);
 assert.equal(m.action,'POSTPONE');assert.equal(m.status,'PENDING');assert.deepEqual(frozen(id),baseline);assert.ok(!JSON.stringify(m).includes('010203-04-5678'));
 assert.equal(propose(v,later.date).id,m.id);assert.equal(list().length,1);assert.equal(list(actors.OTHER).length,0);
 assert.equal(list()[0].id,numericMoveId);assert.equal(list()[0].request_id,id);assert.equal(list()[0].generation,generation);
 assert.equal(list()[0].move_version,m.move_version);assert.equal(list()[0].request_version,v.request_version);
 assert.equal(view(id).pending_move_id,m.id);assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${lit(id)} and action='BOOKING_MOVE_REQUESTED'`),'1');
 failUnchanged(id,()=>propose(v,earlier.date));failUnchanged(id,()=>review(m,later.slots[0],actors.STAFF));
 failUnchanged(id,()=>review(m,wrongDate.slots[0]));
 failUnchanged(id,()=>review({...m,move_version:'2090-01-01T00:00:00.123457Z'},later.slots[0]));
 sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(later.slots[0])}`);
 failUnchanged(id,()=>review(m,later.slots[0]));sql(`update public.orl_ot_slots set status='AVAILABLE' where id=${lit(later.slots[0])}`);
 const result=review(m,later.slots[0]);assert.equal(result.status,'APPROVED');assert.equal(result.action,'POSTPONE');
 assert.equal(result.id,numericMoveId);assert.equal(result.target_slot_id,later.slots[0]);assert.equal(result.request_id,id);assert.equal(result.generation,generation);
 assert.equal(state(id).slot,later.slots[0]);assert.equal(state(id).count,baseline.state.count+1);assert.equal(state(id).history.length,1);
 assert.equal(identity(id),baseline.identity);assert.equal(clinical(id),baseline.clinical);assert.equal(sql(`select request_id is null from public.orl_ot_slots where id=${lit(source.slots[0])}`),'t');
 failUnchanged(id,()=>review(m,later.slots[0]));assert.equal(list().find(x=>x.id===m.id).status,'APPROVED');
 assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${lit(id)} and action='PATIENT_POSTPONED'`),'1');
 const reverse=propose(view(id),earlier.date);const countBefore=state(id).count,historyBefore=state(id).history;
 assert.equal(review(reverse,earlier.slots[1],actors.WEBMASTER).action,'REASSIGN');assert.equal(state(id).count,countBefore);assert.deepEqual(state(id).history,historyBefore);
 assert.equal(identity(id),baseline.identity);assert.equal(clinical(id),baseline.clinical);
 assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${lit(id)} and action='PATIENT_REASSIGNED'`),'1');
 const rejected=propose(view(id),source.date);const beforeReject=frozen(id);
 assert.equal(review(rejected,null,actors.ADMIN,'REJECT').status,'REJECTED');assert.deepEqual(frozen(id),beforeReject);

 // Pending proposals fail after a clinical revision; a fresh proposal supersedes
 // the stale pending row without changing the original booking.
 const stale=propose(view(id),source.date);
 sql(`update public.orl_requests set updated_at=updated_at+interval '1 microsecond' where id=${lit(id)}`);
 assert.equal(list().find(x=>x.id===stale.id).status,'INVALIDATED');failUnchanged(id,()=>review(stale,source.slots[0]));
 const fresh=propose(view(id),source.date);assert.notEqual(fresh.id,stale.id);assert.equal(list().find(x=>x.id===stale.id).status,'INVALIDATED');
 sql(`insert into public.orl_holidays(holiday_date,title,is_active) values(${lit(source.date)},'Synthetic holiday',true)`);
 failUnchanged(id,()=>review(fresh,source.slots[0]));sql(`delete from public.orl_holidays where holiday_date=${lit(source.date)}`);
 review(fresh,null,actors.ADMIN,'REJECT');

 // Same MRN does not imply same surgery. A separate identical-procedure override
 // may exist, but every scheduling path rejects occupying the same date twice.
 const dupSession=addSession('2091-03-01',['MAIN','MAIN','SPECIAL']),caseMrn='SYNTHETIC-DUP-MOVE';
 const original=await createRequest({actor:actors.ADMIN,mrn:caseMrn,surgery:'Case  Procedure'});book(original,dupSession.slots[0]);
 const duplicate=await createRequest({actor:actors.ADMIN,mrn:' synthetic-dup-move ',surgery:'case procedure',approved:true,override:true});
 const dupView=call('orl_booking_assign_view',{p_session_token:actors.ADMIN,p_request_id:duplicate});
 failUnchanged(duplicate,()=>call('orl_booking_assign_existing',{p_session_token:actors.ADMIN,p_request_id:duplicate,p_target_slot:dupSession.slots[1],p_expected_version:dupView.request_version,p_generation:generation}));
 assert.equal(state(original).slot,dupSession.slots[0]);
 const different=await createRequest({actor:actors.ADMIN,mrn:caseMrn,surgery:'Different Procedure',approved:true});
 const diffView=call('orl_booking_assign_view',{p_session_token:actors.ADMIN,p_request_id:different});
 assert.equal(call('orl_booking_assign_existing',{p_session_token:actors.ADMIN,p_request_id:different,p_target_slot:dupSession.slots[2],p_expected_version:diffView.request_version,p_generation:generation}),'CONFIRMED');

 // Two approvals contend for one target. The losing transaction cannot release
 // its source, and retrying after the winner commits still cannot take the slot.
 const raceSource=addSession('2091-04-01',['MAIN']),raceSourceB=addSession('2091-04-03',['MAIN']),raceTarget=addSession('2091-04-02',['MAIN']);
 const raceA=await createRequest(),raceB=await createRequest();book(raceA,raceSource.slots[0]);book(raceB,raceSourceB.slots[0]);
 const moveA=propose(view(raceA),raceTarget.date),moveB=propose(view(raceB),raceTarget.date);
 const p=reviewArgs(moveA,raceTarget.slots[0]);const query=`select public.orl_booking_move_review(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')});`;
 const holder=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let holderError='';holder.stderr.on('data',d=>holderError+=d);
 let holderPid;
 const held=new Promise((resolve,reject)=>{holder.stdout.on('data',d=>{const match=String(d).match(/(\d+):LOCKED/);if(match){holderPid=Number(match[1]);resolve()}});holder.on('error',reject);holder.on('exit',code=>{if(code!==0)reject(Error(holderError))})});
 const ended=new Promise(resolve=>holder.on('exit',resolve));holder.stdin.write(`begin;set role anon;${query}select pg_backend_pid()||':LOCKED';\n`);await held;
 try{
  assert.equal(sql(`select count(distinct relation) from pg_locks where pid=${holderPid} and granted and mode='RowExclusiveLock'
   and relation in('public.orl_settings'::regclass,'public.orl_holidays'::regclass,'public.orl_ot_sessions'::regclass,'public.orl_ot_slots'::regclass)`),'4');
  const losing=reviewArgs(moveB,raceTarget.slots[0]);const losingSql=`set lock_timeout='200ms';set role anon;select public.orl_booking_move_review(${Object.entries(losing).map(([k,v])=>`${k}=>${lit(v)}`).join(',')})`;
  failUnchanged(raceB,()=>sql(losingSql));
 }finally{holder.stdin.end('commit;\n');assert.equal(await ended,0,holderError)}
 failUnchanged(raceB,()=>review(moveB,raceTarget.slots[0]));assert.equal(state(raceA).count,4);assert.equal(state(raceB).count,3);
 assert.equal(state(raceB).slot,raceSourceB.slots[0]);
 review(moveB,null,actors.ADMIN,'REJECT');

 const maximum=await createRequest({count:999});book(maximum,source.slots[1]);const maxMove=propose(view(maximum),wrongDate.date);
 failUnchanged(maximum,()=>review(maxMove,wrongDate.slots[0]));review(maxMove,null,actors.ADMIN,'REJECT');

 // Staff sees date-only combined availability, including Special-only dates,
 // without receiving slot UUIDs, slot objects or any patient identity fields.
 const dateOnly=addSession('2093-06-03',['SPECIAL']),holidayDate=addSession('2093-06-04'),cancelledDate=addSession('2093-06-05');
 const dateArgs={p_session_token:actors.STAFF,p_year:2093,p_month:6};call('orl_booking_move_dates',dateArgs);
 sql(`update public.orl_ot_slots set status='CLOSED' where session_id=${lit(dateOnly.session)} and slot_type='MAIN';
  update public.orl_ot_sessions set special_title='Synthetic Special OT Day' where id=${lit(dateOnly.session)};
  update public.orl_ot_sessions set status='CANCELLED' where id=${lit(cancelledDate.session)};
  insert into public.orl_holidays(holiday_date,title,is_active) values(${lit(holidayDate.date)},'Synthetic holiday',true)`);
 const dates=call('orl_booking_move_dates',dateArgs),specialDate=dates.find(x=>x.ot_date===dateOnly.date);
 assert.equal(specialDate.special_title,'Synthetic Special OT Day');assert.equal(specialDate.generation,generation);
 assert.equal(specialDate.available_slots,Number(sql(`select count(*) from public.orl_ot_slots where session_id=${lit(dateOnly.session)} and slot_type='SPECIAL' and status='AVAILABLE' and request_id is null`)));
 assert.ok(specialDate.available_slots>0);assert.ok(!dates.some(x=>x.ot_date===holidayDate.date||x.ot_date===cancelledDate.date));
 for(const day of dates)assert.deepEqual(Object.keys(day).sort(),['available_slots','day_name','generation','ot_date','special_title','status'].sort());
 assert.throws(()=>call('orl_booking_move_dates',{...dateArgs,p_month:13}));assert.throws(()=>call('orl_booking_move_dates',{...dateArgs,p_session_token:crypto.randomUUID()}));

 // Maintenance and password/recovery guards are inherited through the existing
 // session helper. Generation rotation invalidates proposals without rewriting
 // backup payloads and prevents joining restored patient data onto old proposals.
 const restoreMove=propose(view(raceB),wrongDate.date);const rotated=crypto.randomUUID();
 sql(`update orl_private.c1_restore_generation set generation=${lit(rotated)} where singleton`);
 try{
  const invalid=list().find(x=>x.id===restoreMove.id);assert.equal(invalid.status,'INVALIDATED');assert.equal(invalid.patient_name,null);
  assert.equal(list(actors.STAFF).length,0); // old-generation submitter UUIDs must not grant access after Restore
  failUnchanged(raceB,()=>review(restoreMove,wrongDate.slots[0]));
  failUnchanged(raceB,()=>review({...restoreMove,generation:rotated},wrongDate.slots[0]));
 }finally{sql(`update orl_private.c1_restore_generation set generation=${lit(generation)} where singleton`)}
 sql('update orl_private.site_maintenance set enabled=true where singleton');
 try{
  for(const actor of [actors.STAFF,actors.ADMIN]){
   assert.throws(()=>list(actor),e=>String(e.stderr).includes('ORL_MAINTENANCE'));
   assert.throws(()=>view(raceB,actor),e=>String(e.stderr).includes('ORL_MAINTENANCE'));
   assert.throws(()=>call('orl_booking_move_dates',{...dateArgs,p_session_token:actor}),e=>String(e.stderr).includes('ORL_MAINTENANCE'));
  }
  assert.doesNotThrow(()=>list(actors.WEBMASTER));
 }finally{sql('update orl_private.site_maintenance set enabled=false where singleton')}
 sql(`update public.orl_users set must_change_password=true where id=${lit(actors.STAFF)}`);
 try{assert.throws(()=>view(raceB));assert.throws(()=>list(actors.STAFF))}finally{sql(`update public.orl_users set must_change_password=false where id=${lit(actors.STAFF)}`)}
 assert.throws(()=>list(crypto.randomUUID()));
 assert.equal(sql(`select count(*) from public.orl_requests r where r.id in(${lit(id)},${lit(raceA)},${lit(raceB)})`),'3');
 assert.equal(identity(id),baseline.identity);
});
