import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
test('061 blocks past assignment/move/proposal/approval, keeps today bookable and historical data/restore/read functions unchanged',()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=x=>x==null?'NULL':"'"+String(x).replaceAll("'","''")+"'";
 const run=p=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+p,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 const gen=sql('select generation from orl_private.c1_restore_generation where singleton');
 const dates=JSON.parse(sql("select jsonb_build_array((clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date-1,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date,(clock_timestamp() at time zone 'Asia/Kuala_Lumpur')::date+1)"));
 const actors={};for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const id=crypto.randomUUID();actors[role]=id;
  sql("insert into public.orl_users(id,username,password_hash,display_name,role) values("+[id,'past_'+role,'unused','Synthetic past OT',role].map(lit).join(',')+");insert into public.orl_sessions(user_id,token_hash,expires_at) values("+lit(id)+",encode(extensions.digest("+lit(id)+",'sha256'),'hex'),now()+interval '1 hour')");
 }
 let serial=0;const slots={};
 for(const date of dates){
  sql("insert into public.orl_ot_sessions(ot_date,day_name,status,holiday_override) values("+lit(date)+",'Synthetic','ACTIVE',true) on conflict(ot_date) do update set status='ACTIVE',holiday_override=true");
  const session=sql('select id from public.orl_ot_sessions where ot_date='+lit(date));slots[date]=[];
  for(let n=0;n<10;n++){const id=crypto.randomUUID();sql('insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,status) values('+[id,session,n===9?'SPECIAL':'MAIN'].map(lit).join(',')+','+(9000+n)+",'AVAILABLE')");slots[date].push(id)}
 }
 const make=(role='ADMIN')=>{const id=crypto.randomUUID(),n=++serial;sql("insert into public.orl_requests(id,request_number,patient_ic,mrn,patient_name,age,surgery,diagnosis,doctor,specialist,sub_specialty,phone,status,created_by) values("+[id,'PAST-TEST-'+n,'','PAST-TEST-'+n,'Synthetic past OT',20,'Synthetic procedure '+n,'Synthetic diagnosis','Synthetic doctor','Synthetic specialist','Gen ORL','0','CONFIRMED',actors[role]].map(lit).join(',')+")");return id};
 const assign=(role,id,slot)=>sql('set role service_role;select public.orl_ic_c1_assign('+[actors[role],id,slot,gen,gen].map(lit).join(',')+')');
 const view=(id,role='ADMIN')=>JSON.parse(sql('set role anon;select public.orl_booking_move_view('+[actors[role],id].map(lit).join(',')+')'));
 const propose=(v,date)=>JSON.parse(sql('set role anon;select public.orl_booking_move_request('+[actors.ADMIN,v.request_id,date,'Synthetic reason',v.from_slot_id,v.request_version,gen].map(lit).join(',')+')'));
 const historic=make();assign('ADMIN',historic,slots[dates[0]][0]);
 const future=make();assign('ADMIN',future,slots[dates[2]][0]);
 const proposal=propose(view(future),dates[0]);
 const snapshot=()=>sql("select md5(jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a),'moves',(select jsonb_agg(to_jsonb(m) order by id) from orl_private.booking_move_requests m))::text)");
 const functions=()=>sql("select md5(string_agg(pg_get_functiondef(p.oid)||coalesce(proacl::text,''),E'\\n' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.prokind='f' and p.proname not in('orl_assign_slot','orl_move_postponed_checked','orl_booking_move_request','orl_booking_move_review')");
 const acl=()=>sql("select md5(string_agg(oid::text||coalesce(proacl::text,''),',' order by oid)) from pg_proc where proname in('orl_assign_slot','orl_move_postponed_checked','orl_booking_move_request','orl_booking_move_review')");
 const before=snapshot(),beforeFunctions=functions(),beforeAcl=acl();run('supabase/061_past_ot_booking_guard.sql');
 assert.equal(snapshot(),before);assert.equal(functions(),beforeFunctions);assert.equal(acl(),beforeAcl);assert.throws(()=>run('supabase/061_past_ot_booking_guard.sql'));assert.equal(snapshot(),before);
 const audit=JSON.parse(run('security/release/audit-past-ot.sql'));assert.equal(Object.keys(audit).length,9);for(const [k,v]of Object.entries(audit))assert.equal(v,true,k);
 const denied=action=>{const state=snapshot();assert.throws(action,e=>String(e.stderr).includes('Past OT dates are closed'));assert.equal(snapshot(),state,'Failure must roll back all writes')};
 let n=1;for(const role of Object.keys(actors)){const id=make(role);denied(()=>assign(role,id,slots[dates[0]][n]));assert.equal(assign(role,id,slots[dates[1]][n]),role==='STAFF'?'RESERVED':'CONFIRMED');n++}
 const approved=make();sql("update public.orl_requests set status='APPROVED' where id="+lit(approved));const version=sql('select updated_at from public.orl_requests where id='+lit(approved));
 denied(()=>sql('set role anon;select public.orl_booking_assign_existing('+[actors.ADMIN,approved,slots[dates[0]][8],version,gen].map(lit).join(',')+')'));
 denied(()=>propose(view(future),dates[0]));
 const m=JSON.parse(sql('select orl_private.booking_move_summary('+lit(proposal.id)+')'));
 const review=action=>sql('set role anon;select public.orl_booking_move_review('+[actors.ADMIN,m.id,action,action==='APPROVE'?slots[dates[0]][8]:null,m.move_version,m.request_version,gen].map(lit).join(',')+')');
 denied(()=>review('APPROVE'));assert.doesNotThrow(()=>review('REJECT'));
 const move=(id,from,to)=>{const v=sql('select updated_at from public.orl_requests where id='+lit(id));return sql('set role service_role;select public.orl_ic_c1_mutate('+[actors.ADMIN,'MOVE',from,to,id,'{}','','Synthetic move','KEEP',null,null,gen,v].map(lit).join(',')+')')};
 denied(()=>move(future,slots[dates[2]][0],slots[dates[0]][8]));
 assert.equal(sql('select status from public.orl_requests where id='+lit(historic)),'SCHEDULED');
 assert.doesNotThrow(()=>move(historic,slots[dates[0]][0],slots[dates[1]][8]),'Can postpone an old case to today');
 const special=make();denied(()=>assign('ADMIN',special,slots[dates[0]][9]));assert.equal(assign('ADMIN',special,slots[dates[1]][9]),'CONFIRMED');
 assert.equal(functions(),beforeFunctions);assert.equal(acl(),beforeAcl);
 assert.equal(sql("select (timestamptz '2026-10-08 15:59:59+00' at time zone 'Asia/Kuala_Lumpur')::date='2026-10-08'::date"),'t');
 assert.equal(sql("select (timestamptz '2026-10-08 16:00:00+00' at time zone 'Asia/Kuala_Lumpur')::date='2026-10-09'::date"),'t');
});
