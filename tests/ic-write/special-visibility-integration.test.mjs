import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('062: all Staff Special patients/slots/counts are visible and masked; writes, ACLs, data and existing gates are preserved',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1','Use the disposable local C7 harness');
 assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=x=>x==null?'NULL':"'"+String(typeof x==='object'?JSON.stringify(x):x).replaceAll("'","''")+"'";
 const run=path=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+path,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const rejects=(fn,pattern)=>assert.throws(fn,error=>pattern.test(String(error.stderr||error.message)));
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");

 const actors={};
 for(const name of ['STAFF_A','STAFF_B','ADMIN','WEBMASTER']){
  const id=crypto.randomUUID();actors[name]=id;
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('special_visibility_'+name)},'unused',${lit('Synthetic '+name)},${lit(name.startsWith('STAFF')?'STAFF':name)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const schedule=(who,dbRole='anon',token=actors[who],year=2095,month=6)=>JSON.parse(sql(`set role ${dbRole};select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.orl_get_schedule(${lit(token)},${year??'null'},${month??'null'}) s`));
 const counts=(who,dbRole='anon',token=actors[who],year=2095)=>JSON.parse(sql(`set role ${dbRole};select public.orl_get_year_month_counts(${lit(token)},${year??'null'})`));
 const specialDays=(who,dbRole='anon',token=actors[who],year=2095)=>JSON.parse(sql(`set role ${dbRole};select public.orl_get_special_ot_days(${lit(token)},${year??'null'})`));
 const reads=[schedule,counts,specialDays];
 // Generate the complete fixture year before snapshots; normal calendar reads
 // can fill missing dates/slots, so that established behavior is not a migration mutation.
 counts('ADMIN');
 const sessions={};
 for(const [i,name]of ['active','cancelled','holiday','override'].entries()){
  const date='2095-06-'+String(10+i);
  sql(`insert into public.orl_ot_sessions(ot_date,day_name,special_title,status,holiday_override)
   values(${lit(date)},'Synthetic',${lit('Synthetic visibility '+name)},${lit(name==='cancelled'?'CANCELLED':'ACTIVE')},${name==='override'})
   on conflict(ot_date) do update set special_title=excluded.special_title,status=excluded.status,holiday_override=excluded.holiday_override;`);
  sessions[name]={id:sql(`select id from public.orl_ot_sessions where ot_date=${lit(date)}`),date};
 }
 sql(`insert into public.orl_holidays(holiday_date,title,is_active) values(${lit(sessions.holiday.date)},'Synthetic visibility holiday',true),(${lit(sessions.override.date)},'Synthetic visibility override',true)`);
 // The existing holiday-insert trigger clears overrides; activate the fixture afterwards.
 sql(`update public.orl_ot_sessions set holiday_override=true where id=${lit(sessions.override.id)}`);
 schedule('ADMIN');
 const slot=(name,type,number)=>sql(`select id from public.orl_ot_slots where session_id=${lit(sessions[name].id)} and slot_type=${lit(type)} and slot_number=${number}`);
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const engine=await createIdentityCrypto({context:'synthetic-special-visibility',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const raw='900101-01-1234';
 const create=async who=>{
  const id=crypto.randomUUID();
  const data={patient_ic:raw,age:'30',age_months:'0',patient_name:'Synthetic visibility '+who,mrn:'VISIBLE-'+id,surgery:'Synthetic visibility procedure',diagnosis:'Synthetic diagnosis',doctor:'Synthetic doctor',specialist:'Synthetic specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic '+raw};
  sql(`set role service_role;select public.orl_ic_c1_create(${[actors[who],id,data,await engine.encrypt(raw,id),await engine.searchHash(raw),generation].map(lit).join(',')})`);
  sql(`update public.orl_requests set status='CONFIRMED' where id=${lit(id)}`);
  return id;
 };
 const assign=(who,request,target)=>sql(`set role service_role;select public.orl_ic_c1_assign(${[actors[who],request,target,generation,generation].map(lit).join(',')})`);
 const occupied=[];
 for(const [i,who]of ['STAFF_B','ADMIN','WEBMASTER'].entries()){
  const request=await create(who),target=slot('active','SPECIAL',i+1);
  assign('ADMIN',request,target);occupied.push({request,target,who});
 }
 const ownWaiting=await create('STAFF_A'),ownBooked=await create('STAFF_A'),ownSource=slot('active','MAIN',1);
 assert.equal(assign('STAFF_A',ownBooked,ownSource),'RESERVED');
 const closed=slot('active','SPECIAL',4),free=slot('active','SPECIAL',5);
 sql(`update public.orl_ot_slots set status='CLOSED' where id=${lit(closed)}`);

 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const unrelated=()=>sql("select md5(string_agg(pg_get_functiondef(p.oid),E'\\n' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.prokind='f' and p.oid not in('orl_private.c1_read_schedule(uuid,integer,integer)'::regprocedure,'public.orl_get_year_month_counts(uuid,integer)'::regprocedure,'public.orl_get_special_ot_days(uuid,integer)'::regprocedure)");
 const access=()=>sql("select md5(jsonb_build_object('functions',(select jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,p.prosecdef,p.proconfig) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private')),'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','orl_private')),'schemas',(select jsonb_agg(jsonb_build_array(oid,nspowner,nspacl) order by oid) from pg_namespace where nspname in('public','orl_private')),'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in('public','orl_private')))::text)");
 const oldAdmin={schedule:schedule('ADMIN'),counts:counts('ADMIN'),specialDays:specialDays('ADMIN')};
 assert.equal(schedule('STAFF_A').flatMap(s=>s.slots).some(s=>s.type==='SPECIAL'),false);
 assert.ok(counts('STAFF_A').every(m=>m.special_available===null));
 assert.ok(specialDays('STAFF_A').every(d=>d.special_available===null&&d.special_closed===null&&d.special_total===null));
 const before=snapshot(),beforeFunctions=unrelated(),beforeAccess=access();
 run('supabase/062_staff_special_slot_visibility.sql');
 assert.equal(snapshot(),before,'062 must change no stored application data');
 assert.equal(unrelated(),beforeFunctions,'Mask wrapper, session/Restore checks, all writes and all other functions stay identical');
 assert.equal(access(),beforeAccess,'Function/schema/table ACLs, owners, security settings and RLS policies stay identical');
 assert.throws(()=>run('supabase/062_staff_special_slot_visibility.sql'));
 assert.equal(snapshot(),before,'Rejected reinstall must be atomic');
 const audit=JSON.parse(run('security/release/audit-special-visibility.sql'));
 assert.equal(Object.keys(audit).length,10);for(const [name,ok]of Object.entries(audit))assert.equal(ok,true,name);

 for(const who of Object.keys(actors))for(const dbRole of ['anon','authenticated']){
  const rows=schedule(who,dbRole),monthCounts=counts(who,dbRole),days=specialDays(who,dbRole);
  assert.deepEqual(rows,oldAdmin.schedule,who+' receives the full existing masked Admin schedule');
  assert.deepEqual(monthCounts,oldAdmin.counts,who+' receives all availability counts');
  assert.deepEqual(days,oldAdmin.specialDays,who+' receives all Special day counts');
  const active=rows.find(s=>s.session_id===sessions.active.id),special=active.slots.filter(s=>s.type==='SPECIAL');
  assert.deepEqual(special.map(s=>s.number),[1,2,3,4,5,6]);
  assert.equal(special.find(s=>s.id===closed).status,'CLOSED');
  assert.equal(special.find(s=>s.id===free).status,'AVAILABLE');
  assert.equal(special.find(s=>s.id===free).request_id,null);
  for(const fixture of occupied){
   const patient=special.find(s=>s.id===fixture.target);
   assert.equal(patient.request_id,fixture.request);assert.equal(patient.created_by,actors[fixture.who]);
   assert.equal(patient.patient_name,'Synthetic visibility '+fixture.who);
   assert.equal(patient.patient_ic,'900101-**-****');assert.equal(patient.patient_ic_masked,true);
   assert.equal(patient.patient_ic_present,true);assert.ok(patient._ic_edit_version);
   assert.ok(!('ciphertext'in patient)&&!('envelope'in patient)&&!('search_hash'in patient));
  }
  assert.ok(!JSON.stringify(rows).includes(raw));assert.ok(!JSON.stringify(rows).includes('900101011234'));
  const activeDay=days.find(d=>d.session_id===sessions.active.id);
  assert.equal(activeDay.special_total,6);assert.equal(activeDay.special_closed,1);assert.equal(activeDay.special_available,2);
  for(const month of monthCounts){assert.equal(typeof month.special_available,'number');assert.equal(month.available,month.main_available+month.special_available)}
  for(const [name,status]of [['cancelled','CANCELLED'],['holiday','HOLIDAY'],['override','ACTIVE']]){
   assert.equal(rows.find(s=>s.session_id===sessions[name].id).status,status);
   assert.equal(days.find(d=>d.session_id===sessions[name].id).status,status);
  }
 }
 assert.equal(snapshot(),before,'Visibility/count reads do not alter prepared calendar, patients, identities or audit');

 const denied=(fn,pattern)=>{const state=snapshot();rejects(fn,pattern);assert.equal(snapshot(),state,'Denied writes must roll back every application table')};
 // Own requests reach the actual Special destination guard, not the unrelated-owner guard.
 denied(()=>assign('STAFF_A',ownWaiting,free),/Special slots are available to Admin and Webmaster only/);
 const ownVersion=sql(`select updated_at from public.orl_requests where id=${lit(ownBooked)}`);
 denied(()=>sql(`set role service_role;select public.orl_ic_c1_mutate(${[actors.STAFF_A,'MOVE',ownSource,free,ownBooked,{},'','Synthetic move','KEEP',null,null,generation,ownVersion].map(lit).join(',')})`),/Special slots are available to Admin and Webmaster only/);
 const waitingVersion=sql(`select updated_at from public.orl_requests where id=${lit(ownWaiting)}`);
 denied(()=>sql(`set role anon;select public.orl_booking_assign_existing(${[actors.STAFF_A,ownWaiting,free,waitingVersion,generation].map(lit).join(',')})`),/Admin or Webmaster access required/);
 denied(()=>sql(`set role anon;select public.orl_booking_move_view(${lit(actors.STAFF_A)},${lit(occupied[0].request)})`),/access denied/i);
 for(const dbRole of ['anon','authenticated','service_role']){
  for(const fn of ['orl_private.c1_read_schedule(uuid,integer,integer)','public.orl_require_session(uuid)','public.orl_prepare_schedule(uuid,integer,integer)'])
   assert.equal(sql(`select has_function_privilege(${lit(dbRole)},${lit(fn)},'EXECUTE')`),'f');
  denied(()=>sql(`set role ${dbRole};select * from orl_private.c1_read_schedule(${lit(actors.STAFF_A)},2095,6)`),/permission denied/i);
  assert.equal(sql(`select has_table_privilege(${lit(dbRole)},'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE')`),'f');
 }
 for(const dbRole of ['anon','authenticated']){
  denied(()=>sql(`set role ${dbRole};select public.orl_assign_slot(${[actors.STAFF_A,ownWaiting,free].map(lit).join(',')})`),/permission denied/i);
  denied(()=>sql(`set role ${dbRole};update public.orl_ot_slots set request_id=${lit(ownWaiting)} where id=${lit(free)}`),/permission denied/i);
 }
 assert.equal(unrelated(),beforeFunctions);assert.equal(access(),beforeAccess);

 for(const token of [null,crypto.randomUUID()])for(const read of reads)
  rejects(()=>read('STAFF_A','anon',token),/session|sign|login/i);
 for(const [year,month]of [[null,1],[2025,1],[2101,1],[2095,null],[2095,13]])
  rejects(()=>schedule('STAFF_A','anon',actors.STAFF_A,year,month),/Invalid schedule period/);
 for(const year of [null,2025,2101])for(const read of [counts,specialDays])
  rejects(()=>read('STAFF_A','anon',actors.STAFF_A,year),/Invalid year/);
 for(const who of Object.keys(actors)){
  sql(`update public.orl_users set must_change_password=true where id=${lit(actors[who])}`);
  try{for(const read of reads)assert.throws(()=>read(who))}finally{sql(`update public.orl_users set must_change_password=false where id=${lit(actors[who])}`)}
  sql(`update public.orl_users set is_active=false where id=${lit(actors[who])}`);
  try{for(const read of reads)assert.throws(()=>read(who))}finally{sql(`update public.orl_users set is_active=true where id=${lit(actors[who])}`)}
  const expires=sql(`select expires_at from public.orl_sessions where user_id=${lit(actors[who])}`);
  sql(`update public.orl_sessions set expires_at=now()-interval '1 hour' where user_id=${lit(actors[who])}`);
  try{for(const read of reads)assert.throws(()=>read(who))}finally{sql(`update public.orl_sessions set expires_at=${lit(expires)} where user_id=${lit(actors[who])}`)}
 }
 sql('update orl_private.site_maintenance set enabled=true where singleton');
 try{
  for(const who of ['STAFF_A','STAFF_B','ADMIN'])for(const read of reads)rejects(()=>read(who),/ORL_MAINTENANCE/);
  for(const read of reads)assert.doesNotThrow(()=>read('WEBMASTER'));
 }finally{sql('update orl_private.site_maintenance set enabled=false where singleton')}

 // The existing Restore advisory fence still protects schedule generation and
 // annual counts. Special-day metadata retains its existing session/recovery gate.
 const holder=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let holderError='',holderOutput='';
 holder.stderr.on('data',d=>holderError+=d);
 const ended=new Promise(resolve=>holder.on('exit',resolve));
 const held=new Promise((resolve,reject)=>{holder.stdout.on('data',d=>{holderOutput+=d;if(holderOutput.includes('VISIBILITY_FENCE_HELD'))resolve()});holder.on('error',reject);holder.on('exit',code=>{if(!holderOutput.includes('VISIBILITY_FENCE_HELD'))reject(Error('Fence fixture exited: '+code+' '+holderError))})});
 holder.stdin.write("begin;select pg_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0));select 'VISIBILITY_FENCE_HELD';\n");
 await held;
 try{for(const who of Object.keys(actors))for(const read of [schedule,counts])rejects(()=>read(who),/Restore is running/)}
 finally{holder.stdin.end('commit;\n');assert.equal(await ended,0,holderError)}
 const databaseName=sql('select database_name from orl_private.c1_database_identity where singleton');
 sql("update orl_private.c1_database_identity set database_name='synthetic_recovery_required' where singleton");
 try{for(const who of Object.keys(actors))for(const read of reads)rejects(()=>read(who),/Full-dump recovery is required/)}
 finally{sql(`update orl_private.c1_database_identity set database_name=${lit(databaseName)} where singleton`)}
 assert.equal(snapshot(),before,'All read and denial coverage leaves application data unchanged');

 // Admin and Webmaster still assign to Specials through the existing write path.
 for(const [i,who]of ['ADMIN','WEBMASTER'].entries()){
  const request=await create(who),target=slot('override','SPECIAL',i+1);
  assert.equal(assign(who,request,target),'CONFIRMED');
  assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${lit(request)}`),target);
 }
 assert.equal(unrelated(),beforeFunctions);assert.equal(access(),beforeAccess);
});
