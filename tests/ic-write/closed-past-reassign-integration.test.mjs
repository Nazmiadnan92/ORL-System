import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('066: only Webmaster may reorder an unfinished past booking into an empty closed slot, atomically retaining closure, lifecycle and protected identity',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const database=process.env.ORL_IC_TEST_DATABASE||'postgres';assert.match(database,/^(?:postgres|orl_past_test_[a-z0-9_]+)$/);
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d',database,'-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v==null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const call=(name,p,role='service_role')=>`set role ${role};select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}));`;
 const rpc=(name,p,role)=>JSON.parse(sql(call(name,p,role)));
 const run=p=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+p,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const asyncSql=(input,onOutput=()=>{})=>new Promise((resolve,reject)=>{const child=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',d=>{output+=d;onOutput(output)});child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('close',code=>resolve({code,output,error}));child.stdin.end(input)});
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 const signature='public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)',wrapper='public.orl_ic_c1_reassign(uuid,uuid,uuid,uuid,uuid,uuid)';
 const definition=sql(`select pg_get_functiondef(${lit(signature)}::regprocedure)`);
 const beforeDefinition=sql(`select to_jsonb(p) from pg_proc p where oid=${lit(signature)}::regprocedure`);
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const denied=async(fn,label,expected)=>{const before=snapshot();await assert.rejects(async()=>fn(),expected?error=>expected.test(String(error.stderr||error.message)):undefined,label);assert.equal(snapshot(),before,'Rejected operation is atomic: '+label)};
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(signature)}::regprocedure`),'f3d2b7af8df7434acaf2d53985a5e589');
 // Drift must abort before any change. Restore the exact synthetic baseline afterwards.
 sql(definition.replace('  b_label text;','  b_label text; -- synthetic baseline drift'));
 await denied(()=>run('supabase/066_closed_past_reassign.sql'),'Unreviewed baseline fails closed');
 sql(definition);assert.equal(sql(`select to_jsonb(p) from pg_proc p where oid=${lit(signature)}::regprocedure`),beforeDefinition);
 const preInstall=snapshot(),boundary=sql(`select jsonb_build_array(proacl,proowner,prosecdef,proconfig) from pg_proc where oid=${lit(signature)}::regprocedure`);
 run('supabase/066_closed_past_reassign.sql');assert.equal(snapshot(),preInstall,'Installation does not move or modify patients, slots, identities or settings');
 assert.equal(sql(`select jsonb_build_array(proacl,proowner,prosecdef,proconfig) from pg_proc where oid=${lit(signature)}::regprocedure`),boundary);
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(signature)}::regprocedure`),'777efc10480acfbbfb44688322a370f5');
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(wrapper)}::regprocedure`),'2b4d1a321a41bed78ff559b3ec542d19');
 await denied(()=>run('supabase/066_closed_past_reassign.sql'),'Repeated installation fails closed');
 for(const role of ['anon','authenticated','service_role'])assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(signature)},'EXECUTE')`),'f');
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(wrapper)},'EXECUTE')`),'f');
 assert.equal(sql(`select has_function_privilege('service_role',${lit(wrapper)},'EXECUTE')`),'t');
 const actors={};
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const id=actors[role]=crypto.randomUUID();sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('closed_'+role.toLowerCase()+'_'+id.slice(0,8))},'synthetic-unused',${lit('Synthetic '+role)},${lit(role)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const [past,past2,today,future]=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-3,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-4,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+3)"));
 const sessions=new Map();let n=Math.max(11000,Number(sql('select coalesce(max(slot_number),0) from public.orl_ot_slots')));
 const session=date=>{if(!sessions.has(date)){sql(`insert into public.orl_ot_sessions(ot_date,day_name,status,holiday_override) values(${lit(date)},'Synthetic','ACTIVE',true) on conflict(ot_date) do nothing`);sessions.set(date,sql(`select id from public.orl_ot_sessions where ot_date=${lit(date)}`))}return sessions.get(date)};
 const slot=(date=past,type='MAIN',status='CLOSED')=>{const id=crypto.randomUUID();sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${lit(id)},${lit(session(date))},${lit(type)},${++n},${lit(status)})`);return id};
 const request=id=>JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${lit(id)}`));
 const slotState=id=>JSON.parse(sql(`select to_jsonb(sl) from public.orl_ot_slots sl where id=${lit(id)}`));
 const dayState=id=>sql(`select to_jsonb(s) from public.orl_ot_sessions s where id=${lit(id)}`);
 const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(id)}`);
 const frozen=id=>sql(`select to_jsonb(r)-array['assigned_slot_id','updated_at'] from public.orl_requests r where id=${lit(id)}`);
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32))),raw='900101-01-1234';
 const engine=await createIdentityCrypto({context:'synthetic-closed-past',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const create=async(target,role='STAFF',status='SCHEDULED',hold=false)=>{
  const id=crypto.randomUUID();rpc('orl_ic_c1_create',{p_session_token:actors[role],p_request_id:id,p_data:{patient_name:'Synthetic historical case',mrn:'CLOSED-'+id,age:'36',age_months:'1',diagnosis:'Synthetic diagnosis',surgery:'Synthetic procedure',doctor:'Synthetic doctor',specialist:'Synthetic specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic remark',patient_ic:raw},p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation});
  sql(`update public.orl_requests set assigned_slot_id=${lit(target)},status=${lit(status)},postpone_count=4,postpone_history='[{"reason":"Synthetic prior delay"}]'::jsonb where id=${lit(id)};
   update public.orl_ot_slots set request_id=${lit(id)},status=${lit(status==='CONFIRMED'?'RESERVED':'CONFIRMED')} where id=${lit(target)}`);
  if(status==='COMPLETED')sql(`update public.orl_requests set completed_at=now(),completed_by=${lit(actors.WEBMASTER)} where id=${lit(id)}`);
  if(hold)sql(`update public.orl_requests set ot_hold=true,ot_hold_reason='Synthetic awaiting new date',ot_hold_at=now(),ot_hold_by=${lit(actors.ADMIN)} where id=${lit(id)}`);
  return id;
 };
 const params=(from,to,role='WEBMASTER',extra={})=>({p_session_token:actors[role],p_from:from,p_to:to,p_expected_from_request_id:slotState(from).request_id,p_expected_to_request_id:slotState(to).request_id,p_generation:generation,...extra});
 const move=p=>rpc('orl_ic_c1_reassign',p);
 const source=slot(),target=slot(),id=await create(source,'STAFF');const selected=params(source,target);
 for(const role of ['STAFF','ADMIN'])await denied(()=>move({...selected,p_session_token:actors[role]}),role+' cannot use closed past exception');
 for(const extra of [{p_generation:crypto.randomUUID()},{p_generation:null},{p_expected_from_request_id:null},{p_expected_from_request_id:crypto.randomUUID()},{p_expected_to_request_id:crypto.randomUUID()},{p_to:source}])await denied(()=>move({...selected,...extra}),'Invalid/stale reviewed selection');
 const otherDayTarget=slot(past2);await denied(()=>move(params(source,otherDayTarget)),'Cross-date closed destination denied');
 for(const date of [today,future]){const s=slot(date),t=slot(date);await create(s);await denied(()=>move(params(s,t)),'Today/future closed destination denied')}
 const occupiedClosed=slot();await create(occupiedClosed);sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(occupiedClosed)}`);
 await denied(()=>move(params(source,occupiedClosed)),'Occupied closed destination is never eligible');
 const doneSlot=slot(),done=await create(doneSlot,'ADMIN','COMPLETED');
 await denied(()=>move(params(doneSlot,target)),'Completed source cannot move to closed slot');
 await denied(()=>move(params(source,doneSlot)),'Completed occupied destination cannot swap');
 // A closed source, cancelled/pending-cancellation episode or broken reciprocal link is unsafe.
 sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(source)}`);await denied(()=>move(params(source,target)),'Closed occupied source denied');sql(`update public.orl_ot_slots set status='CONFIRMED' where id=${lit(source)}`);
 sql(`update public.orl_requests set status='CANCELLED' where id=${lit(id)}`);await denied(()=>move(params(source,target)),'Cancelled source denied');sql(`update public.orl_requests set status='SCHEDULED',deletion_status='PENDING' where id=${lit(id)}`);
 await denied(()=>move(params(source,target)),'Pending cancellation denied');sql(`update public.orl_requests set deletion_status='',assigned_slot_id=null where id=${lit(id)}`);
 await denied(()=>move(params(source,target)),'Broken reciprocal source denied');sql(`update public.orl_requests set assigned_slot_id=${lit(source)} where id=${lit(id)}`);
 // Late audit failure must undo every link/status update; never leave a half-move.
 sql("create function public.synthetic_066_audit_failure() returns trigger language plpgsql as $$begin if new.action='OT_SLOT_REASSIGNED' then raise exception 'Synthetic audit failure'; end if; return new; end $$;create trigger synthetic_066_audit_failure before insert on public.orl_audit_log for each row execute function public.synthetic_066_audit_failure();");
 await denied(()=>move(params(source,target)),'Audit failure rolls back move');sql('drop trigger synthetic_066_audit_failure on public.orl_audit_log;drop function public.synthetic_066_audit_failure();');
 for(const [origin,destination,patient] of [[source,target,id],[slot(past,'SPECIAL'),slot(past,'MAIN'),null],[slot(past2,'MAIN'),slot(past2,'SPECIAL'),null]]){
  const current=patient||await create(origin,'ADMIN','CONFIRMED',true),before=frozen(current),beforeIdentity=identity(current),parentId=slotState(origin).session_id;
  if(!patient)sql(`update public.orl_ot_sessions set status='CANCELLED',note='Synthetic historical day remains cancelled' where id=${lit(parentId)}`);
  const beforeDay=dayState(parentId),p=params(origin,destination),originStatus=slotState(origin).status;
  assert.equal(move(p),'REASSIGNED');assert.equal(frozen(current),before,'All patient fields, creator, status, Hold, history, age and postpone count preserved');
  assert.equal(identity(current),beforeIdentity,'Encrypted identity not read, decrypted or modified');assert.equal(dayState(parentId),beforeDay,'Parent day and closure never reopened');
  assert.equal(slotState(origin).status,'CLOSED');assert.equal(slotState(origin).request_id,null);assert.equal(slotState(destination).request_id,current);assert.equal(slotState(destination).status,originStatus);
  assert.equal(request(current).assigned_slot_id,destination);assert.equal(slotState(origin).updated_by,actors.WEBMASTER);assert.equal(slotState(destination).updated_by,actors.WEBMASTER);
  const audit=JSON.parse(sql(`select to_jsonb(a) from public.orl_audit_log a where action='OT_SLOT_REASSIGNED' and record_id=${lit(parentId)} order by id desc limit 1`)),details=JSON.parse(audit.details);
  assert.equal(audit.user_role,'WEBMASTER');assert.equal(audit.user_id,actors.WEBMASTER);assert.equal(details.mode,'CLOSED_PAST_REASSIGN');assert.equal(details.request_id,current);
  assert.equal(details.from_slot_id,origin);assert.equal(details.to_slot_id,destination);assert.equal(details.source_status_after,'CLOSED');assert.equal(details.target_status_after,originStatus);
  assert.equal(audit.details.includes(raw),false);assert.equal(audit.details.includes('Synthetic historical case'),false);
  await denied(()=>move(p),'Old source snapshot cannot be replayed');
 }
 // Ordinary reassignment remains available to Admin/WM, preserving its existing audit text.
 for(const [role,date] of [['ADMIN',past],['WEBMASTER',past],['ADMIN',future],['WEBMASTER',future]]){
  const a=slot(date,'MAIN','AVAILABLE'),b=slot(date,'SPECIAL','AVAILABLE'),c=slot(date,'MAIN','AVAILABLE'),first=await create(a),second=await create(b,'ADMIN','CONFIRMED');
  const frozenA=frozen(first),frozenB=frozen(second);assert.equal(move(params(a,b,role)),'REASSIGNED');assert.equal(slotState(a).request_id,second);assert.equal(slotState(b).request_id,first);
  assert.equal(frozen(first),frozenA);assert.equal(frozen(second),frozenB);assert.equal(slotState(a).status,'RESERVED');assert.equal(slotState(b).status,'CONFIRMED');
  assert.equal(move(params(b,c,role)),'REASSIGNED');assert.equal(slotState(b).status,'AVAILABLE');assert.equal(request(first).assigned_slot_id,c);
 }
 // The exception cannot bypass either direct-function permissions or normal past booking guard.
 await denied(()=>rpc('orl_swap_slots_checked',{p_session_token:actors.WEBMASTER,p_from:target,p_to:source,p_expected_from_request_id:id,p_expected_to_request_id:null}),'Direct service-role helper denied');
 const unassigned=await create(null,'WEBMASTER','APPROVED'),pastAvailable=slot(past,'MAIN','AVAILABLE');
 sql(`update public.orl_ot_sessions set status='ACTIVE',holiday_override=true where id=${lit(session(past))}`);
 assert.equal(request(unassigned).assigned_slot_id,null);
 await denied(()=>rpc('orl_ic_c1_assign',{p_session_token:actors.WEBMASTER,p_request_id:unassigned,p_slot_id:source,p_generation:generation,p_slot_generation:generation}),'Ordinary assignment cannot open vacated CLOSED source',/This OT slot is unavailable or blocked by a holiday/);
 await denied(()=>rpc('orl_ic_c1_assign',{p_session_token:actors.WEBMASTER,p_request_id:unassigned,p_slot_id:pastAvailable,p_generation:generation,p_slot_generation:generation}),'Ordinary assignment cannot book AVAILABLE past slot',/Past OT dates are closed to new bookings/);
 const stale=params(target,source);sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${lit(actors.WEBMASTER)}`);
 await denied(()=>move(stale),'Expired Webmaster session denied');sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${lit(actors.WEBMASTER)}`);
 // Competing calls cannot place two patients in one slot or clone a source booking.
 const raceSource=slot(),racePatient=await create(raceSource),raceA=slot(),raceB=slot();
 const results=await Promise.all([asyncSql(call('orl_ic_c1_reassign',params(raceSource,raceA))),asyncSql(call('orl_ic_c1_reassign',params(raceSource,raceB)))]);
 assert.equal(results.filter(r=>r.code===0).length,1);assert.equal(results.filter(r=>r.code!==0).length,1);assert.equal(sql(`select count(*) from public.orl_ot_slots where request_id=${lit(racePatient)}`),'1');assert.equal(slotState(raceSource).status,'CLOSED');
 const raceSource1=slot(),raceSource2=slot(),raceTarget=slot();await create(raceSource1);await create(raceSource2);
 const contested=await Promise.all([asyncSql(call('orl_ic_c1_reassign',params(raceSource1,raceTarget))),asyncSql(call('orl_ic_c1_reassign',params(raceSource2,raceTarget)))]);
 assert.equal(contested.filter(r=>r.code===0).length,1);assert.equal(contested.filter(r=>r.code!==0).length,1);
 // Hold a parent-date update open: reassignment must wait, then reject its new
 // non-past date rather than validating an unlocked stale value.
 const [raceDate,nextDate]=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-3333,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+3333)"));
 const dateSource=slot(raceDate),dateTarget=slot(raceDate);await create(dateSource);const dateParams=params(dateSource,dateTarget),beforeDateRace=snapshot();
 let signal;const dateLocked=new Promise(resolve=>signal=resolve);
 const changeDate=asyncSql(`begin;update public.orl_ot_sessions set ot_date=${lit(nextDate)} where id=${lit(session(raceDate))};select 'DATE_LOCKED';select pg_sleep(1);commit;`,output=>{if(output.includes('DATE_LOCKED'))signal()});
 await Promise.race([dateLocked,changeDate.then(result=>{assert.equal(result.code,0,'Synthetic date-change transaction must start');assert.match(result.output,/DATE_LOCKED/)})]);
 const dateResult=await asyncSql(call('orl_ic_c1_reassign',dateParams));assert.equal((await changeDate).code,0);assert.notEqual(dateResult.code,0);assert.match(dateResult.error,/restricted to a past OT date/);
 sql(`update public.orl_ot_sessions set ot_date=${lit(raceDate)} where id=${lit(session(raceDate))}`);assert.equal(snapshot(),beforeDateRace,'Concurrent date change cannot leave a partial reassignment or audit');
 const heldSelection=params(target,source);sql('update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton');
 await denied(()=>move(heldSelection),'Generation changed after selection');
 assert.equal(request(done).status,'COMPLETED');assert.equal(request(done).assigned_slot_id,doneSlot);
 assert.equal(sql("select count(*) from orl_private.c1_write_permit"),'0');assert.equal(sql("select (orl_private.c6_stats()->>'plaintext_rows')::int"),'0');assert.equal(sql("select (orl_private.c6_stats()->>'identity_mismatch')::int"),'0');
 // Original065 safety surface remains intact after the narrow patch.
 const audit065=JSON.parse(run('security/release/audit-past-case.sql'));for(const [name,ok] of Object.entries(audit065))assert.equal(ok,true,'065 '+name);
 const audit066=JSON.parse(run('security/release/audit-closed-past-reassign.sql'));assert.equal(Object.keys(audit066).length,13);for(const [name,ok] of Object.entries(audit066))assert.equal(ok,true,'066 '+name);
});
