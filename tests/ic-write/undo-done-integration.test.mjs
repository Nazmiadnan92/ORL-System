import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('068: password-confirmed Webmaster Undo Done is atomic, audited, duplicate-safe and preserves the occupied episode',async()=>{
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
 const core='public.orl_swap_slots_checked(uuid,uuid,uuid,uuid,uuid)',undo='public.orl_ic_undo_done(uuid,text,uuid,uuid,text,uuid,timestamptz)';
 const audit067=JSON.parse(run('security/release/audit-done-past-reassign.sql'));assert.equal(Object.keys(audit067).length,13);for(const [name,ok] of Object.entries(audit067))assert.equal(ok,true,'067 baseline '+name);
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const denied=async(fn,label,expected)=>{const before=snapshot();await assert.rejects(async()=>fn(),expected?error=>expected.test(String(error.stderr||error.message)):undefined,label);assert.equal(snapshot(),before,'Rejected operation is atomic: '+label)};
 const oldDefinition=sql(`select pg_get_functiondef(${lit(core)}::regprocedure)`),oldFunctions=sql("select md5(jsonb_agg(to_jsonb(p) order by p.oid)::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private')");
 sql(oldDefinition.replace('  done_past_correction boolean := false;','  done_past_correction boolean := false; -- synthetic drift'));
 await denied(()=>run('supabase/068_undo_done.sql'),'Drifted baseline rejected');sql(oldDefinition);
 const beforeInstall=snapshot();run('supabase/068_undo_done.sql');assert.equal(snapshot(),beforeInstall,'Install changes no patient or settings data');
 assert.equal(sql(`select md5(jsonb_agg(to_jsonb(p) order by p.oid)::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.oid<>${lit(undo)}::regprocedure`),oldFunctions,'All existing function bodies and boundaries unchanged');
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(undo)}::regprocedure`),'d67883946a35daad215fa8b29eb6f762');
 await denied(()=>run('supabase/068_undo_done.sql'),'Already installed rejected');
 for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(undo)},'EXECUTE')`),'f');
 assert.equal(sql(`select has_function_privilege('service_role',${lit(undo)},'EXECUTE')`),'t');
 const actors={},password='Synthetic-068-password';
 for(const role of ['STAFF','ADMIN','WEBMASTER']){const id=actors[role]=crypto.randomUUID();sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('undo_'+role.toLowerCase()+'_'+id.slice(0,8))},extensions.crypt(${lit(password)},extensions.gen_salt('bf',4)),${lit('Synthetic '+role)},${lit(role)});insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour')`)}
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const [past,today,future]=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-7,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+7)"));
 let n=Math.max(15000,Number(sql('select coalesce(max(slot_number),0) from public.orl_ot_slots')));const sessions=new Map();
 const session=date=>{if(!sessions.has(date)){sql(`insert into public.orl_ot_sessions(ot_date,day_name,status,holiday_override) values(${lit(date)},'Synthetic','ACTIVE',true) on conflict(ot_date) do nothing`);sessions.set(date,sql(`select id from public.orl_ot_sessions where ot_date=${lit(date)}`))}return sessions.get(date)};
 const slot=(date=past)=>{const id=crypto.randomUUID();sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values(${lit(id)},${lit(session(date))},'SPECIAL',${++n},'AVAILABLE')`);return id};
 const request=id=>JSON.parse(sql(`select to_jsonb(r) from public.orl_requests r where id=${lit(id)}`));
 const identity=id=>sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(id)}`);
 const frozen=id=>sql(`select to_jsonb(r)-array['status','updated_at','completed_at','completed_by'] from public.orl_requests r where id=${lit(id)}`);
 const slotState=id=>sql(`select to_jsonb(sl) from public.orl_ot_slots sl where id=${lit(id)}`);
 const dayState=id=>sql(`select to_jsonb(s) from public.orl_ot_sessions s where id=${lit(id)}`);
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32))),raw='900101-01-1234';
 const engine=await createIdentityCrypto({context:'synthetic-undo-done',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const newData=id=>({patient_name:'Synthetic undo case',mrn:'UNDO-'+id,age:'36',age_months:'1',diagnosis:'Synthetic diagnosis',surgery:'Synthetic procedure',doctor:'Synthetic doctor',specialist:'Synthetic specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic remark',patient_ic:raw});
 const createArgs=async(data)=>{const id=crypto.randomUUID();return{p_session_token:actors.STAFF,p_request_id:id,p_data:data||newData(id),p_envelope:await engine.encrypt(raw,id),p_search:await engine.searchHash(raw),p_generation:generation}};
 const create=async(target,status='COMPLETED',legacy=false)=>{const p=await createArgs(),id=p.p_request_id;rpc('orl_ic_c1_create',p);
  sql(`update public.orl_requests set assigned_slot_id=${lit(target)},status='SCHEDULED',postpone_count=7,postpone_history='[{"reason":"Synthetic previous delay"}]'::jsonb where id=${lit(id)};update public.orl_ot_slots set request_id=${lit(id)},status='CONFIRMED' where id=${lit(target)}`);
  if(status==='COMPLETED'&&!legacy)rpc('orl_ic_ot_lifecycle',{p_session_token:actors.ADMIN,p_request_id:id,p_slot_id:target,p_action:'COMPLETE',p_reason:'',p_generation:generation,p_expected_version:request(id).updated_at});
  else sql(`update public.orl_requests set status=${lit(status)} where id=${lit(id)}`);return id;
 };
 const params=(id,target,role='WEBMASTER',extra={})=>({p_session_token:actors[role],p_password:password,p_request_id:id,p_slot_id:target,p_reason:'Incorrect Done selection',p_generation:generation,p_expected_version:request(id).updated_at,...extra});
 const revert=p=>rpc('orl_ic_undo_done',p);
 const a=slot(),r=await create(a),p=params(r,a);
 for(const role of ['STAFF','ADMIN'])await denied(()=>revert({...p,p_session_token:actors[role]}),role+' denied',/Webmaster access required/);
 for(const role of ['anon','authenticated'])await denied(()=>rpc('orl_ic_undo_done',p,role),'Browser direct RPC denied',/permission denied/);
 for(const extra of [{p_password:''},{p_password:null},{p_password:'wrong'},{p_password:'x'.repeat(1025)},{p_reason:''},{p_reason:' \n\t '},{p_reason:null},{p_reason:'x'.repeat(4097)},{p_expected_version:null},{p_expected_version:'infinity'},{p_expected_version:'2000-01-01'},{p_slot_id:crypto.randomUUID()},{p_slot_id:null},{p_request_id:crypto.randomUUID()},{p_request_id:null},{p_generation:null},{p_generation:crypto.randomUUID()},{p_session_token:crypto.randomUUID()}])await denied(()=>revert({...p,...extra}),'Invalid credentials/reason/selection/generation');
 sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${lit(actors.WEBMASTER)}`);await denied(()=>revert(p),'Expired session rejected');sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${lit(actors.WEBMASTER)}`);
 sql(`update public.orl_users set password_hash=extensions.crypt('changed-password',extensions.gen_salt('bf',4)) where id=${lit(actors.WEBMASTER)}`);await denied(()=>revert(p),'Old password cannot authorize Undo',/Incorrect Webmaster password/);sql(`update public.orl_users set password_hash=extensions.crypt(${lit(password)},extensions.gen_salt('bf',4)) where id=${lit(actors.WEBMASTER)}`);
 for(const status of ['CLOSED','RESERVED','AVAILABLE']){sql(`update public.orl_ot_slots set status=${lit(status)} where id=${lit(a)}`);await denied(()=>revert(p),'Nonconfirmed slot rejected');}sql(`update public.orl_ot_slots set status='CONFIRMED' where id=${lit(a)}`);
 sql(`update public.orl_requests set deletion_status='PENDING' where id=${lit(r)}`);await denied(()=>revert(p),'Pending cancellation rejected');sql(`update public.orl_requests set deletion_status='',assigned_slot_id=null where id=${lit(r)}`);await denied(()=>revert(p),'Broken reciprocal request link rejected');sql(`update public.orl_requests set assigned_slot_id=${lit(a)} where id=${lit(r)};update public.orl_ot_slots set request_id=null where id=${lit(a)}`);await denied(()=>revert(p),'Broken reciprocal slot link rejected');sql(`update public.orl_ot_slots set request_id=${lit(r)} where id=${lit(a)}`);
 const futureSlot=slot(future),futureId=await create(futureSlot,'COMPLETED',true);await denied(()=>revert(params(futureId,futureSlot)),'Future completed episode rejected',/today or a past OT date/);
 const activeSlot=slot(),activeId=await create(activeSlot,'SCHEDULED');await denied(()=>revert(params(activeId,activeSlot)),'Active episode cannot Undo Done');
 await denied(()=>sql(`update public.orl_requests set ot_hold=true,ot_hold_reason='Synthetic hold',ot_hold_at=now(),ot_hold_by=${lit(actors.ADMIN)} where id=${lit(r)}`),'Completed plus Hold is prohibited by preserved lifecycle constraint',/orl_requests_ot_hold_state/);
 sql(`update public.orl_requests set ot_hold=true,ot_hold_reason='Synthetic waiting for another date',ot_hold_at=now(),ot_hold_by=${lit(actors.ADMIN)} where id=${lit(activeId)}`);const unrelatedHold=frozen(activeId);
 await denied(()=>revert(params(activeId,activeSlot)),'Held active episode cannot Undo Done');
 const duplicateArgs=await createArgs();rpc('orl_ic_c1_create',duplicateArgs);const duplicate=duplicateArgs.p_request_id;
 sql(`update public.orl_requests set mrn=${lit(' '+request(r).mrn.toLowerCase()+' ')},surgery=' Synthetic   PROCEDURE ' where id=${lit(duplicate)}`);
 for(const status of ['DRAFT','PENDING REVIEW','APPROVED','CONFIRMED','SCHEDULED']){sql(`update public.orl_requests set status=${lit(status)} where id=${lit(duplicate)}`);await denied(()=>revert(p),'Global normalized active duplicate '+status,/another active episode/)}
 sql(`update public.orl_requests set status='COMPLETED' where id=${lit(duplicate)}`);
 // An audit append failure, or an update failure after the append, rolls back all effects.
 sql("create function public.synthetic_068_audit_failure() returns trigger language plpgsql as $$begin if new.action='OT_DONE_REVERSED' then raise exception 'Synthetic audit failure';end if;return new;end $$;create trigger synthetic_068_audit_failure before insert on public.orl_audit_log for each row execute function public.synthetic_068_audit_failure()");
 await denied(()=>revert(p),'Audit failure rolls back correction',/Synthetic audit failure/);sql('drop trigger synthetic_068_audit_failure on public.orl_audit_log;drop function public.synthetic_068_audit_failure()');
 sql("create function public.synthetic_068_update_failure() returns trigger language plpgsql as $$begin if old.status='COMPLETED' and new.status='SCHEDULED' then raise exception 'Synthetic update failure';end if;return new;end $$;create trigger synthetic_068_update_failure before update on public.orl_requests for each row execute function public.synthetic_068_update_failure()");
 await denied(()=>revert(p),'Update failure rolls back preceding audit',/Synthetic update failure/);sql('drop trigger synthetic_068_update_failure on public.orl_requests;drop function public.synthetic_068_update_failure()');
 // Retain exact old completion events, episode/IC/slot/day; only live status metadata changes.
 for(const [date,legacy] of [[past,false],[today,true]]){
  const s=slot(date),id=await create(s,'COMPLETED',legacy),before=request(id),beforeFrozen=frozen(id),beforeIc=identity(id),beforeSlot=slotState(s);
  const proposal=crypto.randomUUID(),oldProposal=crypto.randomUUID();
  for(const [pid,gen] of [[proposal,generation],[oldProposal,crypto.randomUUID()]])sql(`insert into orl_private.booking_move_requests(id,request_id,from_slot_id,from_date,target_date,reason,request_version,generation,requested_by,requested_by_name) values(${lit(pid)},${lit(id)},${lit(s)},${lit(date)},${lit(future)},'Synthetic stale move',${lit(before.updated_at)},${lit(gen)},${lit(actors.STAFF)},'Synthetic Staff')`);
  const proposalFields=sql(`select to_jsonb(m)-array['status','updated_at'] from orl_private.booking_move_requests m where id=${lit(proposal)}`),oldProposalState=sql(`select to_jsonb(m) from orl_private.booking_move_requests m where id=${lit(oldProposal)}`);
  sql(`update public.orl_ot_sessions set status='CANCELLED',note='Synthetic historical closure' where id=${lit(session(date))}`);const beforeDay=dayState(session(date));
  const logs=sql(`select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.orl_audit_log a where record_id=${lit(id)}`),lastAudit=sql('select coalesce(max(id),0) from public.orl_audit_log');
  const selection=params(id,s,'WEBMASTER',{p_reason:'Correct mistake '+password+' IC '+raw});const result=revert(selection);
  assert.deepEqual(result,{request_id:id,slot_id:s,status:'SCHEDULED',action:'UNDO_DONE',ot_hold:false});
  assert.equal(frozen(id),beforeFrozen);assert.equal(identity(id),beforeIc);assert.equal(slotState(s),beforeSlot);assert.equal(dayState(session(date)),beforeDay);
  const after=request(id);assert.equal(after.status,'SCHEDULED');assert.equal(after.completed_at,null);assert.equal(after.completed_by,null);assert.notEqual(after.updated_at,before.updated_at);
  assert.equal(sql(`select status from orl_private.booking_move_requests where id=${lit(proposal)}`),'INVALIDATED');assert.equal(sql(`select to_jsonb(m)-array['status','updated_at'] from orl_private.booking_move_requests m where id=${lit(proposal)}`),proposalFields);assert.equal(sql(`select to_jsonb(m) from orl_private.booking_move_requests m where id=${lit(oldProposal)}`),oldProposalState);
  assert.equal(frozen(activeId),unrelatedHold,'Unrelated held episode and Hold metadata remain exact');
  assert.equal(sql(`select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.orl_audit_log a where record_id=${lit(id)} and id<=${lastAudit}`),logs,'Original Done audit retained exactly');
  const log=JSON.parse(sql(`select to_jsonb(a) from public.orl_audit_log a where action='OT_DONE_REVERSED' and record_id=${lit(id)}`)),detail=JSON.parse(log.details);
  assert.equal(log.user_id,actors.WEBMASTER);assert.equal(log.user_role,'WEBMASTER');assert.equal(detail.previous_status,'COMPLETED');assert.equal(detail.new_status,'SCHEDULED');assert.equal(detail.original_completed_at,before.completed_at);assert.equal(detail.original_completed_by,before.completed_by);assert.equal(detail.slot_id,s);assert.equal(detail.ot_date,date);
  assert.ok(!log.details.includes(raw));assert.ok(!log.details.includes(password));assert.ok(!log.details.includes('Synthetic undo case'));assert.equal(detail.previous_hold,before.ot_hold);
  await denied(()=>revert(selection),'Undo replay rejected');await denied(()=>revert(params(id,s)),'Fresh selection does not undo a non-Done episode');
  // Restored episode remains active and continues blocking ordinary duplicate creates.
  const createDuplicate=await createArgs({...newData(id),mrn:before.mrn,surgery:before.surgery});await denied(()=>rpc('orl_ic_c1_create',createDuplicate),'Existing create duplicate guard still blocks restored episode',/already|Duplicate|duplicate/);
 }
 // Other nonactive episodes and different procedures do not block Undo Done.
 for(const status of ['CANCELLED','REJECTED','COMPLETED']){const s=slot(),id=await create(s),other=await createArgs();rpc('orl_ic_c1_create',other);sql(`update public.orl_requests set mrn=${lit(request(id).mrn)},surgery=${lit(request(id).surgery)},status=${lit(status)} where id=${lit(other.p_request_id)}`);assert.equal(revert(params(id,s)).status,'SCHEDULED')}
 const separateSlot=slot(),separateId=await create(separateSlot),different=await createArgs();rpc('orl_ic_c1_create',different);sql(`update public.orl_requests set mrn=${lit(request(separateId).mrn)},surgery='Different procedure' where id=${lit(different.p_request_id)}`);assert.equal(revert(params(separateId,separateSlot)).status,'SCHEDULED');
 // Concurrent duplicate edits, creates, slot/date changes and advisory-lock owners
 // must fail fast, never wait in a cycle or append an unconfirmed reversal.
 const contested=slot(),contestedId=await create(contested),contestedSelection=params(contestedId,contested);
 const compete=async(lockSql,selection=contestedSelection)=>{
  let signal;const ready=new Promise(resolve=>signal=resolve),child=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let output='',error='';
  child.stdout.on('data',d=>{output+=d;if(output.includes('UNDO_LOCK_READY'))signal()});child.stderr.on('data',d=>error+=d);
  const exited=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,error}))});
  // Keep stdin and the transaction open until Undo replies, rather than relying
  // on a sleep that might expire while another test consumes CPU.
  child.stdin.write(`begin;set local statement_timeout='10s';${lockSql};select 'UNDO_LOCK_READY';\n`);
  let response,readyTimer;
  try{
   await Promise.race([ready,exited.then(out=>assert.fail('Lock fixture exited early: '+out.error)),new Promise((_,reject)=>{readyTimer=setTimeout(()=>reject(Error('Lock fixture readiness timeout')),10000)})]);
   response=await asyncSql("set statement_timeout='5s';"+call('orl_ic_undo_done',selection));assert.notEqual(response.code,0);
   assert.doesNotMatch(response.error,/statement timeout|deadlock detected/,'NOWAIT contention must not wait in a lock cycle');
  }finally{clearTimeout(readyTimer);child.stdin.end('commit;\n');assert.equal((await exited).code,0,error)}
  return response;
 };
 await compete(`update public.orl_requests set remark=remark where id=${lit(different.p_request_id)}`);
 await compete(`select 1 from public.orl_ot_slots where id=${lit(contested)} for update`);
 await compete(`select 1 from public.orl_requests where id=${lit(contestedId)} for update`);
 await compete(`select 1 from public.orl_ot_sessions where id=${lit(session(past))} for update`);
 const contestedData=request(contestedId),caseKey=`lower(btrim(${lit(contestedData.mrn)}))||chr(31)||lower(regexp_replace(btrim(${lit(contestedData.surgery)}),chr(92)||'s+',' ','g'))`;
 assert.equal(sql(`select hashtextextended(${caseKey},0)`),sql(`select hashtextextended(lower(btrim(mrn))||chr(31)||lower(regexp_replace(btrim(surgery),chr(92)||'s+',' ','g')),0) from public.orl_requests where id=${lit(contestedId)}`));
 await compete(`select pg_advisory_xact_lock(hashtextextended(${caseKey},0))`);
 assert.equal(request(contestedId).status,'COMPLETED');assert.equal(sql(`select count(*) from public.orl_audit_log where action='OT_DONE_REVERSED' and record_id=${lit(contestedId)}`),'0');
 // Two identical submissions: at most one commit and exactly one audit event.
 const races=await Promise.all([asyncSql(call('orl_ic_undo_done',contestedSelection)),asyncSql(call('orl_ic_undo_done',contestedSelection))]);assert.equal(races.filter(x=>x.code===0).length,1);assert.equal(races.filter(x=>x.code!==0).length,1);assert.equal(sql(`select count(*) from public.orl_audit_log where action='OT_DONE_REVERSED' and record_id=${lit(contestedId)}`),'1');
 // Real standard CREATE competes with Undo for the same case. Whichever wins,
 // the result cannot contain two active episodes and no receipt is replayed.
 for(let attempt=0;attempt<3;attempt++){
  const s=slot(),id=await create(s),before=request(id),selection=params(id,s),creation=await createArgs({...newData(id),mrn:before.mrn,surgery:before.surgery});
  const outcomes=await Promise.all([asyncSql(call('orl_ic_undo_done',selection)),asyncSql(call('orl_ic_c1_create',creation))]);
  assert.equal(outcomes.filter(x=>x.code===0).length,1,JSON.stringify(outcomes));
  assert.equal(sql(`select count(*) from public.orl_requests where lower(btrim(mrn))=lower(btrim(${lit(before.mrn)})) and status not in('CANCELLED','COMPLETED','REJECTED')`),'1');
  assert.equal(sql(`select count(*) from public.orl_audit_log where action='OT_DONE_REVERSED' and record_id=${lit(id)}`),outcomes[0].code===0?'1':'0');
 }
 // A different active episode is committed before correction; the new snapshot sees it.
 const dupRaceSlot=slot(),dupRaceId=await create(dupRaceSlot),dupRaceOther=await createArgs();rpc('orl_ic_c1_create',dupRaceOther);const raceData=request(dupRaceId),raceSelection=params(dupRaceId,dupRaceSlot);
 await compete(`update public.orl_requests set mrn=${lit(raceData.mrn)},surgery=${lit(raceData.surgery)} where id=${lit(dupRaceOther.p_request_id)}`,raceSelection);
 await denied(()=>revert(raceSelection),'Committed concurrent duplicate remains rejected',/another active episode/);
 const oldGeneration=params(r,a);sql('update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton');await denied(()=>revert(oldGeneration),'Restore generation invalidates selection');
 assert.equal(sql('select count(*) from orl_private.c1_write_permit'),'0');assert.equal(sql("select (orl_private.c6_stats()->>'plaintext_rows')::int"),'0');assert.equal(sql("select (orl_private.c6_stats()->>'identity_mismatch')::int"),'0');
 for(const path of ['security/release/audit-done-past-reassign.sql','security/release/audit-undo-done.sql']){const audit=JSON.parse(run(path));assert.equal(Object.keys(audit).length,path.includes('undo')?14:13);for(const [name,ok] of Object.entries(audit))assert.equal(ok,true,path+' '+name)}
});
