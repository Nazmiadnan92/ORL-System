import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('058: six Specials from 2027; legacy/Main capacity, bookings, CLOSED rows, role/holiday/maintenance/Restore guards preserved',async()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v==null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const install=()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../supabase/058_six_special_slots_2027.sql',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 const rejects=(f,pattern)=>assert.throws(f,e=>pattern.test(String(e.stderr||e.message)));
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const password='SyntheticPass1',users={};
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const user=crypto.randomUUID();users[role]=user;
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(user)},${lit('cap_'+role)},extensions.crypt(${lit(password)},extensions.gen_salt('bf',4)),'Synthetic capacity',${lit(role)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(user)},encode(extensions.digest(${lit(user)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const makeRequest=role=>{
  const request=crypto.randomUUID();
  const data={patient_ic:'',age:'20',age_months:'0',patient_name:'Synthetic capacity',mrn:'CAP-'+request,surgery:'TEST',diagnosis:'TEST',doctor:'Test',specialist:'Test',sub_specialty:'Gen ORL',phone:'0',remark:''};
  sql(`set role service_role;select public.orl_ic_c1_create(${lit(users[role])},${lit(request)},${lit(data)},null,null,${lit(generation)})`);
  return request;
 };
 const booked=makeRequest('ADMIN'),excessRequest=makeRequest('ADMIN');
 const waiting=makeRequest('ADMIN'),staffWaiting=makeRequest('STAFF');
 sql(`update public.orl_requests set status='APPROVED' where id=${lit(waiting)};
  update public.orl_requests set status='CONFIRMED' where id=${lit(staffWaiting)};`);
 const fixtures={};
 for(const [i,label]of ['booked','closed','cancelled','holiday','override','mixed','empty','excess'].entries()){
  const id=crypto.randomUUID(),date='2027-03-'+String(i+1).padStart(2,'0');fixtures[label]={id,date};
  sql(`insert into public.orl_ot_sessions(id,ot_date,day_name,special_title,status) values(${lit(id)},${lit(date)},'Synthetic',${lit('Capacity '+label)},${lit(label==='cancelled'?'CANCELLED':'ACTIVE')});
   insert into public.orl_ot_slots(session_id,slot_type,slot_number,status) values(${lit(id)},'MAIN',1,'CLOSED');`);
  if(label!=='empty')sql(`insert into public.orl_ot_slots(session_id,slot_type,slot_number,status)
    select ${lit(id)},'SPECIAL',n,case when ${lit(label)}='closed' or (${lit(label)}='mixed' and n=1) then 'CLOSED' else 'AVAILABLE' end from generate_series(1,2) n;`);
 }
 const legacy=crypto.randomUUID();
 sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${lit(legacy)},'2026-11-02','Synthetic');
  insert into public.orl_ot_slots(session_id,slot_type,slot_number) select ${lit(legacy)},'MAIN',n from generate_series(1,10) n;
  insert into public.orl_ot_slots(session_id,slot_type,slot_number,status) select ${lit(legacy)},'SPECIAL',n,'CLOSED' from generate_series(1,2) n;
  insert into public.orl_holidays(holiday_date,title) values(${lit(fixtures.holiday.date)},'Synthetic capacity holiday'),(${lit(fixtures.override.date)},'Synthetic capacity override');
  update public.orl_ot_sessions set holiday_override=true where id=${lit(fixtures.override.id)};`);
 const occupied=sql(`select id from public.orl_ot_slots where session_id=${lit(fixtures.booked.id)} and slot_type='SPECIAL' and slot_number=1`);
 const excessSlot=crypto.randomUUID();
 sql(`update public.orl_ot_slots set request_id=${lit(booked)},status='CONFIRMED' where id=${lit(occupied)};
  insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status) values(${lit(excessSlot)},${lit(fixtures.excess.id)},'SPECIAL',7,${lit(excessRequest)},'CONFIRMED');
  update public.orl_requests set status='SCHEDULED',assigned_slot_id=${lit(occupied)} where id=${lit(booked)};
  update public.orl_requests set status='SCHEDULED',assigned_slot_id=${lit(excessSlot)} where id=${lit(excessRequest)};`);
 const patientState=()=>sql("select md5(jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),'receipts',(select jsonb_agg(to_jsonb(c) order by request_id) from orl_private.c1_creation_receipts c))::text)");
 const slotRows=()=>JSON.parse(sql("select coalesce(jsonb_object_agg(id,to_jsonb(sl)),'{}') from public.orl_ot_slots sl"));
 const calendarState=()=>sql("select md5(jsonb_build_object('sessions',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_sessions s),'holidays',(select jsonb_agg(to_jsonb(h) order by id) from public.orl_holidays h),'settings',(select jsonb_agg(to_jsonb(v) order by setting_key) from public.orl_settings v))::text)");
 const definitions=()=>sql("select jsonb_agg(jsonb_build_array(oid::regprocedure::text,pg_get_functiondef(oid),proacl) order by oid) from pg_proc where oid in('public.orl_prepare_schedule(uuid,integer,integer)'::regprocedure,'public.orl_require_session(uuid)'::regprocedure,'public.orl_ic_c1_control(uuid,text,uuid,jsonb,uuid,text)'::regprocedure)");
 const rejectedRows=slotRows(),rejectedPatients=patientState(),rejectedCalendar=calendarState(),guardDefinitions=definitions();
 rejects(install,/above S6/);
 assert.deepEqual(slotRows(),rejectedRows);assert.equal(patientState(),rejectedPatients);assert.equal(calendarState(),rejectedCalendar);assert.equal(definitions(),guardDefinitions);
 // Resolve only this synthetic fixture, retaining the occupied row and its link.
 sql(`update public.orl_ot_slots set slot_number=6 where id=${lit(excessSlot)}`);
 const before=slotRows(),patientsBefore=patientState(),calendarBefore=calendarState();
 install();assert.equal(patientState(),patientsBefore);assert.equal(calendarState(),calendarBefore);assert.equal(definitions(),guardDefinitions);
 const after=slotRows();for(const [id,row]of Object.entries(before))assert.deepEqual(after[id],row,`existing slot changed: ${id}`);
 for(const [id,row]of Object.entries(after))if(!before[id]){
  assert.equal(row.slot_type,'SPECIAL');assert.ok(row.slot_number>=1&&row.slot_number<=6);assert.equal(row.request_id,null);
  assert.equal(sql(`select ot_date>=date '2027-01-01' from public.orl_ot_sessions where id=${lit(row.session_id)}`),'t');
 }
 assert.equal(sql("select count(*) from (select s.id from public.orl_ot_sessions s left join public.orl_ot_slots sl on sl.session_id=s.id and sl.slot_type='SPECIAL' where s.ot_date>=date '2027-01-01' group by s.id having array_agg(sl.slot_number order by sl.slot_number) is distinct from array[1,2,3,4,5,6]) mismatch"),'0');
 assert.equal(sql(`select count(*) from public.orl_ot_slots where session_id=${lit(fixtures.closed.id)} and slot_type='SPECIAL' and status='CLOSED'`),'6');
 assert.equal(sql(`select count(*) from public.orl_ot_slots where session_id=${lit(fixtures.mixed.id)} and slot_type='SPECIAL' and status='CLOSED'`),'1');
 rejects(install,/already installed/);assert.deepEqual(slotRows(),after);

 const schedule=(role,year,month)=>JSON.parse(sql(`set role anon;select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.orl_get_schedule(${lit(users[role])},${year},${month}) s`));
 const staffRows=schedule('STAFF',2027,3);assert.equal(staffRows.flatMap(s=>s.slots).some(s=>s.type==='SPECIAL'),false);
 const adminRows=schedule('ADMIN',2027,3);for(const session of adminRows)assert.deepEqual(session.slots.filter(s=>s.type==='SPECIAL').map(s=>s.number),[1,2,3,4,5,6]);
 for(const [label,status]of [['cancelled','CANCELLED'],['holiday','HOLIDAY'],['override','ACTIVE']])assert.equal(adminRows.find(s=>s.session_id===fixtures[label].id).status,status);
 const afterRead=slotRows();schedule('WEBMASTER',2027,3);assert.deepEqual(slotRows(),afterRead);
 const specialSlot=(label,n=3)=>sql(`select id from public.orl_ot_slots where session_id=${lit(fixtures[label].id)} and slot_type='SPECIAL' and slot_number=${n}`);
 const assign=(role,request,slot)=>sql(`set role service_role;select public.orl_ic_c1_assign(${lit(users[role])},${lit(request)},${lit(slot)},${lit(generation)},${lit(generation)})`);
 for(const label of ['closed','cancelled','holiday'])rejects(()=>assign('ADMIN',waiting,specialSlot(label)),/unavailable|holiday|closed/i);
 rejects(()=>assign('STAFF',staffWaiting,specialSlot('empty')),/Special slots|Admin/i);
 assert.equal(patientState(),patientsBefore);

 const settingsView=role=>JSON.parse(sql(`set role service_role;select public.orl_ic_c1_control_view(${lit(users[role])},'SETTINGS',null,null)`));
 const changeSettings=(role,data,view=settingsView(role))=>sql(`set role service_role;select public.orl_ic_c1_control(${lit(users[role])},'SETTINGS',null,${lit(data)},${lit(view.generation)},${lit(view.revision)})`);
 const originalSettings=settingsView('ADMIN');
 rejects(()=>changeSettings('STAFF',{SPECIAL_SLOTS:'3'}),/Admin access/);
 try{
  changeSettings('ADMIN',{SPECIAL_SLOTS:'3'});
  rejects(()=>changeSettings('ADMIN',{SPECIAL_SLOTS:'4'},originalSettings),/Controls changed/);
  const legacyRows=schedule('ADMIN',2026,12);
  for(const s of legacyRows){assert.equal(s.slots.filter(x=>x.type==='MAIN').length,10);assert.equal(s.slots.filter(x=>x.type==='SPECIAL').length,3)}
  for(const s of schedule('ADMIN',2100,12)){assert.equal(s.slots.filter(x=>x.type==='MAIN').length,5);assert.equal(s.slots.filter(x=>x.type==='SPECIAL').length,6)}
  changeSettings('ADMIN',{SPECIAL_SLOTS:'100'});
  for(const s of schedule('ADMIN',2027,4)){assert.equal(s.slots.filter(x=>x.type==='MAIN').length,5);assert.equal(s.slots.filter(x=>x.type==='SPECIAL').length,6)}
 }finally{changeSettings('ADMIN',{SPECIAL_SLOTS:originalSettings.data.SPECIAL_SLOTS})}
 assert.equal(patientState(),patientsBefore);
 // Existing 2026 rows are not part of the migration or future-year generation.
 for(const row of Object.values(before).filter(r=>r.session_id===legacy))assert.deepEqual(slotRows()[row.id],row);
 const runtimeExcess=crypto.randomUUID();sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number) values(${lit(runtimeExcess)},${lit(fixtures.empty.id)},'SPECIAL',7)`);
 const runtimeBefore=slotRows();rejects(()=>schedule('ADMIN',2027,3),/above S6/);assert.deepEqual(slotRows(),runtimeBefore);
 sql(`delete from public.orl_ot_slots where id=${lit(runtimeExcess)}`);

 for(const role of ['anon','authenticated','service_role'])for(const fn of ['orl_private.c1_prepare_schedule(uuid,integer,integer)','public.orl_prepare_schedule(uuid,integer,integer)','public.orl_require_session(uuid)'])
  assert.equal(sql(`select has_function_privilege('${role}',${lit(fn)},'EXECUTE')`),'f');
 rejects(()=>sql(`set role anon;select public.orl_prepare_schedule(${lit(users.ADMIN)},2027,5)`),/permission denied/i);
 rejects(()=>sql(`set role anon;select * from public.orl_get_schedule(${lit(crypto.randomUUID())},2027,5)`),/session|sign|login/i);
 for(const [year,month]of [['null','1'],['2025','1'],['2101','1'],['2027','null'],['2027','13']])
  rejects(()=>sql(`set role anon;select * from public.orl_get_schedule(${lit(users.ADMIN)},${year},${month})`),/Invalid schedule period/);
 const state=JSON.parse(sql('set role anon;select public.orl_maintenance_status()'));
 const maintenance=(enabled,revision)=>sql(`set role anon;select public.orl_set_maintenance(${lit(users.WEBMASTER)},${lit(password)},${enabled},'Synthetic capacity maintenance',null,${revision})`);
 maintenance(true,state.revision);
 try{
  for(const role of ['STAFF','ADMIN'])rejects(()=>schedule(role,2027,5),/ORL_MAINTENANCE/);
  assert.doesNotThrow(()=>schedule('WEBMASTER',2027,5));
 }finally{maintenance(false,state.revision+1)}

 const holder=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let holderError='',holderOutput='';
 holder.stderr.on('data',d=>holderError+=d);
 const ended=new Promise(resolve=>holder.on('exit',resolve));
 const held=new Promise((resolve,reject)=>{holder.stdout.on('data',d=>{holderOutput+=d;if(holderOutput.includes('CAPACITY_FENCE_HELD'))resolve()});holder.on('error',reject);holder.on('exit',code=>{if(!holderOutput.includes('CAPACITY_FENCE_HELD'))reject(Error('Fence fixture exited: '+code+' '+holderError))})});
 holder.stdin.write("begin;select pg_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0));select 'CAPACITY_FENCE_HELD';\n");
 await held;
 try{rejects(()=>schedule('ADMIN',2027,6),/Restore is running/)}
 finally{holder.stdin.end('commit;\n');assert.equal(await ended,0,holderError)}
 assert.equal(patientState(),patientsBefore);
});
