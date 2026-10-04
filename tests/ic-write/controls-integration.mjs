import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export function installControls(sql){
  // Exercise the UNCHANGED 018 parser and Kedah replacement logic. Only the
  // HTTP extension is substituted; this never makes a network request.
  sql(`do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Local fixture only'; end if;end$$;
    create type extensions.http_response as (status integer,content text);
    create table public.c1_calendar_fixture(status integer,content text);
    insert into public.c1_calendar_fixture values(200,'');
    revoke all on public.c1_calendar_fixture from public,anon,authenticated,service_role;
    create function extensions.http_get(varchar) returns extensions.http_response language sql as
    $$select status,content from public.c1_calendar_fixture limit 1$$;
    revoke all on function extensions.http_get(varchar) from public,anon,authenticated,service_role;`);
  const source=readFileSync(new URL('../../supabase/018_generate_malaysia_holidays.sql',import.meta.url),'utf8');
  assert.ok(source.includes('create extension if not exists http with schema extensions;'));
  sql(source.replace('create extension if not exists http with schema extensions;','-- Local HTTP fixture, no external connection.'));
  sql(readFileSync(new URL('./controls.sql',import.meta.url),'utf8'));
}

export async function runControlTests({t,sql,parallelSql,literal,json,users,payload,client,password}){
  const gen=()=>sql('select generation from orl_private.c1_restore_generation');
  const view=(scope,id=null,who='ADMIN',generation=['SESSION','SLOT'].includes(scope)?gen():null)=>
    client(who)('CONTROL_VIEW',{scope,id,generation});
  const act=(action,id,data,v,who='ADMIN')=>client(who)('CONTROL',{action,id,data,generation:v.generation,revision:v.revision});
  const query=(action,id,data,v,who='ADMIN')=>`set role service_role; select public.orl_ic_c1_control(${literal(users[who])},${literal(action)},${literal(id)},${json(data)},${literal(v.generation)},${literal(v.revision)})`;
  const preserve=()=>sql(`select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),
    'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),
    'receipts',(select jsonb_agg(to_jsonb(c) order by request_id) from orl_private.c1_creation_receipts c))`);
  const day=crypto.randomUUID(),main=crypto.randomUUID(),special=crypto.randomUUID(),occupied=crypto.randomUUID();
  sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${literal(day)},'2087-01-05','Synthetic');
    insert into public.orl_ot_slots(id,session_id,slot_type,slot_number) values
    (${literal(main)},${literal(day)},'MAIN',1),(${literal(occupied)},${literal(day)},'MAIN',2),(${literal(special)},${literal(day)},'SPECIAL',1)`);
  const p=await payload('ADMIN');await client('ADMIN')('CREATE',{request_id:p.p_request_id,generation:p.p_generation,data:p.p_data});
  await client('ADMIN')('CONFIRM',{request_id:p.p_request_id,generation:p.p_generation});
  await client('ADMIN')('ASSIGN',{request_id:p.p_request_id,slot_id:occupied,generation:gen(),slot_generation:gen()});

  await t.test('controls preserve patient/identity/receipt while closing Main/Special and updating session status/title',async()=>{
    const before=preserve();
    for(const slot of [main,special]){
      assert.equal((await act('SLOT_CLOSED',slot,{closed:true},await view('SLOT',slot))).result,'CLOSED');
      assert.equal((await act('SLOT_CLOSED',slot,{closed:false},await view('SLOT',slot),'WEBMASTER')).result,'AVAILABLE');
    }
    await assert.rejects(act('SLOT_CLOSED',occupied,{closed:true},await view('SLOT',occupied)));
    await act('SESSION_TITLE',day,{title:'Synthetic Special Day'},await view('SESSION',day));
    await act('SESSION_STATUS',day,{status:'CANCELLED'},await view('SESSION',day));
    await assert.rejects(act('SLOT_CLOSED',main,{closed:true},await view('SLOT',main)));
    await act('SESSION_STATUS',day,{status:'ACTIVE'},await view('SESSION',day));
    assert.equal(preserve(),before);
    assert.equal(sql(`select request_id from public.orl_ot_slots where id=${literal(occupied)}`),p.p_request_id);
  });
  await t.test('control roles, strict arguments, revoked sessions and stale snapshots fail without writes',async()=>{
    const before=preserve(),v=await view('SLOT',main);
    await assert.rejects(view('SLOT',main,'STAFF'));
    await assert.rejects(act('SLOT_CLOSED',main,{closed:true},v,'STAFF'));
    assert.throws(()=>sql(query('SLOT_CLOSED',main,{closed:true},v,'STAFF')),/Admin/);
    for(const d of [{closed:null},{closed:'true'},{closed:true,patient_ic:'SYNTHETIC'}]){
      await assert.rejects(act('SLOT_CLOSED',main,d,v));assert.throws(()=>sql(query('SLOT_CLOSED',main,d,v)));
    }
    await act('SESSION_TITLE',day,{title:'Changed after view'},await view('SESSION',day));
    await assert.rejects(act('SLOT_CLOSED',main,{closed:true},v));
    const fresh=await view('SLOT',main);
    sql(`update public.orl_users set must_change_password=true where id=${literal(users.ADMIN)}`);
    try{await assert.rejects(act('SLOT_CLOSED',main,{closed:true},fresh))}finally{sql(`update public.orl_users set must_change_password=false where id=${literal(users.ADMIN)}`)}
    assert.equal(preserve(),before);
    for(const role of ['anon','authenticated'])for(const signature of ['orl_ic_c1_control(uuid,text,uuid,jsonb,uuid,text)','orl_ic_c1_control_view(uuid,text,uuid,uuid)'])
      assert.equal(sql(`select has_function_privilege('${role}','public.${signature}','EXECUTE')`),'f');
  });
  await t.test('holiday CRUD blocks dates, resets overrides, preserves bookings and rejects stale edits/deletes',async()=>{
    const before=preserve(),v=await view('HOLIDAYS');
    const {result:id}=await act('HOLIDAY_SAVE',null,{date:'2087-01-05',title:'Synthetic Clinic Block',description:''},v);
    await assert.rejects(act('HOLIDAY_DELETE',id,{},v));
    await assert.rejects(act('SLOT_CLOSED',main,{closed:true},await view('SLOT',main)));
    await act('SESSION_STATUS',day,{status:'ACTIVE'},await view('SESSION',day));
    assert.equal(sql(`select holiday_override from public.orl_ot_sessions where id=${literal(day)}`),'t');
    await act('HOLIDAY_SAVE',id,{date:'2087-01-05',title:'Updated Clinic Block',description:'Synthetic'},await view('HOLIDAYS'));
    assert.equal(sql(`select holiday_override from public.orl_ot_sessions where id=${literal(day)}`),'f');
    await act('HOLIDAY_DELETE',id,{},await view('HOLIDAYS'));
    await assert.rejects(act('HOLIDAY_DELETE',id,{},await view('HOLIDAYS')));
    assert.equal(preserve(),before);
  });
  await t.test('actual 018 parser with offline HTTP fixture keeps existing dates, filters states and adds Friday replacement Sunday',async()=>{
    // 2088-01-02 is selected dynamically below to keep the fixture explicitly Friday.
    const friday=sql("select d::date from generate_series(date '2088-01-01',date '2088-01-07',interval '1 day') d where extract(isodow from d)=5");
    const textDate=sql(`select to_char(${literal(friday)}::date,'DD Mon')`),replacement=sql(`select ${literal(friday)}::date+2`);
    const body=`| ${textDate} | Friday | Synthetic National | National |\n| 20 Jan | Tuesday | Synthetic Other State | Johor |\n| 21 Jan | Wednesday | Synthetic Exclusion | National except Kedah |\n| 22 Jan | Thursday | Synthetic Kedah | Kedah |`;
    sql(`update public.c1_calendar_fixture set status=200,content=${literal(body)}`);
    const before=preserve(),r=await act('HOLIDAY_GENERATE',null,{year:2088},await view('HOLIDAYS'));
    assert.equal(r.result.inserted,3);
    assert.equal(sql(`select title from public.orl_holidays where holiday_date=${literal(replacement)}`),'Synthetic National (Replacement Holiday)');
    const again=await act('HOLIDAY_GENERATE',null,{year:2088},await view('HOLIDAYS'));assert.equal(again.result.inserted,0);
    assert.equal(sql("select count(*) from public.orl_holidays where holiday_date in('2088-01-20','2088-01-21')"),'0');
    const h=sql('select jsonb_agg(to_jsonb(h) order by id) from public.orl_holidays h');
    sql("update public.c1_calendar_fixture set status=503");await assert.rejects(act('HOLIDAY_GENERATE',null,{year:2088},await view('HOLIDAYS')));
    sql("update public.c1_calendar_fixture set status=200,content='Unparseable fixture'");await assert.rejects(act('HOLIDAY_GENERATE',null,{year:2088},await view('HOLIDAYS')));
    assert.equal(sql('select jsonb_agg(to_jsonb(h) order by id) from public.orl_holidays h'),h);assert.equal(preserve(),before);
  });
  await t.test('settings validation and lazy schedule capacity retain existing slots and protected identities',async()=>{
    const original=await view('SETTINGS'),before=preserve();
    for(const data of [{SPECIAL_SLOTS:'-1'},{SPECIAL_SLOTS:'1000'},{START_YEAR:'2101'},{OT_DAYS:'injection'},{MAIN_SLOTS:'0'},{SYSTEM_NAME:''},{UNKNOWN:'x'}])
      await assert.rejects(act('SETTINGS',null,data,await view('SETTINGS')));
    await act('SETTINGS',null,{SPECIAL_SLOTS:'3'},await view('SETTINGS'));
    await assert.rejects(act('SETTINGS',null,{SPECIAL_SLOTS:'1'},original));
    sql(`select public.orl_prepare_schedule(${literal(users.STAFF)},2086,2)`);
    assert.equal(sql("select max(slot_number) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where s.ot_date between '2086-02-01' and '2086-02-28' and sl.slot_type='SPECIAL'"),'3');
    await act('SETTINGS',null,{SPECIAL_SLOTS:'1'},await view('SETTINGS'));
    sql(`select public.orl_prepare_schedule(${literal(users.STAFF)},2086,2)`);
    assert.equal(sql("select max(slot_number) from public.orl_ot_slots sl join public.orl_ot_sessions s on s.id=sl.session_id where s.ot_date between '2086-02-01' and '2086-02-28' and sl.slot_type='SPECIAL'"),'3');
    await act('SETTINGS',null,original.data,await view('SETTINGS'));assert.equal(preserve(),before);
  });
  await t.test('Restore invalidates controls; audit failure rolls back and concurrent controls commit at most once',async()=>{
    const v=await view('SLOT',main),backup=(await client('WEBMASTER')('BACKUP_EXPORT',{password})).backup;
    await client('WEBMASTER')('BACKUP_RESTORE',{password,backup});
    await assert.rejects(act('SLOT_CLOSED',main,{closed:true},v));
    const before=preserve();
    sql(`create function public.c1_control_audit_fail() returns trigger language plpgsql as $$begin
      if new.action in('OT_SLOT_CLOSED','HOLIDAY_SAVED','SETTINGS_UPDATED') then raise exception 'Synthetic audit failure';end if;return new;end$$;
      create trigger c1_control_audit_fail before insert on public.orl_audit_log for each row execute function public.c1_control_audit_fail()`);
    try{
      await assert.rejects(act('SLOT_CLOSED',main,{closed:true},await view('SLOT',main)));
      const h=await view('HOLIDAYS');await assert.rejects(act('HOLIDAY_SAVE',null,{date:'2087-02-01',title:'Rollback',description:''},h));
      assert.equal((await view('HOLIDAYS')).revision,h.revision);
      const s=await view('SETTINGS');await assert.rejects(act('SETTINGS',null,{SPECIAL_SLOTS:'4'},s));assert.equal((await view('SETTINGS')).revision,s.revision);
    }finally{sql('drop trigger c1_control_audit_fail on public.orl_audit_log;drop function public.c1_control_audit_fail()')}
    const fresh=await view('SLOT',main),q=query('SLOT_CLOSED',main,{closed:true},fresh);
    const results=await Promise.all([parallelSql(q),parallelSql(q)]);assert.equal(results.filter(r=>!r.error).length,1);
    // The successful response could be lost: the old snapshot cannot repeat it.
    await assert.rejects(act('SLOT_CLOSED',main,{closed:true},fresh));
    await act('SLOT_CLOSED',main,{closed:false},await view('SLOT',main));assert.equal(preserve(),before);
  });
  await t.test('clear-all holidays requires Webmaster password, retains patients and rejects stale confirmation',async()=>{
    const before=preserve(),v=await view('HOLIDAYS');
    await assert.rejects(act('HOLIDAY_CLEAR',null,{password},v,'ADMIN'));
    assert.throws(()=>sql(query('HOLIDAY_CLEAR',null,{password},v,'ADMIN')));
    await assert.rejects(act('HOLIDAY_CLEAR',null,{password:'WRONG-SYNTHETIC'},v,'WEBMASTER'));
    await act('HOLIDAY_CLEAR',null,{password},v,'WEBMASTER');
    assert.equal(sql('select count(*) from public.orl_holidays'),'0');assert.equal(preserve(),before);
    await assert.rejects(act('HOLIDAY_CLEAR',null,{password},v,'WEBMASTER'));
  });
  await t.test('metadata controls refuse a concurrent writer; lazy schedule creation refuses an active Restore fence',async()=>{
    const v=await view('SLOT',main),before=preserve();
    const holder=parallelSql("begin;lock table public.orl_ot_slots in row exclusive mode;select pg_sleep(2);commit");
    for(let i=0;i<30;i++){
      if(sql("select exists(select 1 from pg_locks where relation='public.orl_ot_slots'::regclass and mode='RowExclusiveLock' and granted)")==='t')break;
      await new Promise(r=>setTimeout(r,20));
      if(i===29)assert.fail('Synthetic lock not acquired');
    }
    await assert.rejects(act('SLOT_CLOSED',main,{closed:true},v));assert.equal((await holder).error,null);
    const restore=parallelSql("begin;select pg_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0));select pg_sleep(2);commit");
    for(let i=0;i<30;i++){
      if(sql("select exists(select 1 from pg_locks where locktype='advisory' and mode='ExclusiveLock' and granted)")==='t')break;
      await new Promise(r=>setTimeout(r,20));if(i===29)assert.fail('Synthetic fence not acquired');
    }
    assert.throws(()=>sql(`select public.orl_prepare_schedule(${literal(users.STAFF)},2084,2)`),/busy|Restore|restore/i);
    await assert.rejects(view('SLOT',main));assert.equal((await restore).error,null);assert.equal(preserve(),before);
  });
}
