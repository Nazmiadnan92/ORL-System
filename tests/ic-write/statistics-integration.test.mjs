import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
test('059: global aggregates, unchanged row permissions/View OT/masking, filters/pagination and session gates',()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=x=>x==null?'NULL':"'"+String(x).replaceAll("'","''")+"'";
 const install=()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../supabase/059_global_subspecialty_statistics.sql',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 const actors={};for(const name of ['STAFF_A','STAFF_B','ADMIN','WEBMASTER']){
  const role=name.startsWith('STAFF')?'STAFF':name,id=crypto.randomUUID();actors[name]=id;
  sql("insert into public.orl_users(id,username,password_hash,display_name,role) values("+[id,'stat_'+name,'unused','Synthetic statistics',role].map(lit).join(',')+");"+
   "insert into public.orl_sessions(user_id,token_hash,expires_at) values("+lit(id)+",encode(extensions.digest("+lit(id)+",'sha256'),'hex'),now()+interval '1 hour');");
 }
 const snapshot=()=>sql("select md5(jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i))::text)");
 const unrelated=()=>sql("select md5(string_agg(pg_get_functiondef(p.oid),E'\\n' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.proname<>'c1_read_orl_subspecialty_statistics' and p.prokind='f'");
 const preSnapshot=snapshot(),preFunctions=unrelated();
 install();assert.equal(snapshot(),preSnapshot);assert.equal(unrelated(),preFunctions);assert.throws(install);
 const audit=JSON.parse(execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../security/release/audit-global-statistics.sql',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());
 assert.equal(Object.keys(audit).length,7);for(const [k,v]of Object.entries(audit))assert.equal(v,true,k);
 // Synthetic fixtures only, including a Malaysia day-boundary and an assigned case submitted in a different year.
 sql("insert into public.orl_requests(request_number,patient_ic,mrn,patient_name,age,age_months,surgery,diagnosis,doctor,specialist,sub_specialty,phone,status,created_by,created_at,postpone_count) "+
 "select 'STAT-'||n,'900101-**-****','STAT-'||n,'Synthetic '||n,20,0,'Synthetic procedure','Synthetic diagnosis','Synthetic doctor',case when n<=102 then 'Alpha' else 'Beta' end,case when n<=102 then 'Statistics A' else 'Statistics B' end,'0',case when n<=102 then 'CONFIRMED' when n=103 then 'SCHEDULED' when n=104 then 'CANCELLED' else 'DRAFT' end,case when n<=102 then "+lit(actors.STAFF_A)+"::uuid else "+lit(actors.STAFF_B)+"::uuid end,case when n=1 then '2088-01-31 16:30:00+00'::timestamptz when n=103 then '2090-01-01'::timestamptz else '2088-02-15'::timestamptz end,case when n=2 then 1 else 0 end from generate_series(1,105) n;");
 const session=crypto.randomUUID(),slot=crypto.randomUUID();
 sql("insert into public.orl_ot_sessions(id,ot_date,day_name) values("+lit(session)+",'2088-02-20','Synthetic');"+
 "insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status) select "+lit(slot)+","+lit(session)+" ,'MAIN',1,id,'CONFIRMED' from public.orl_requests where request_number='STAT-103';"+
 "update public.orl_requests set assigned_slot_id="+lit(slot)+" where request_number='STAT-103';");
 const stats=(who,opts={})=>JSON.parse(sql("set role anon;select public.orl_subspecialty_statistics("+[actors[who],opts.from??'2088-02-01',opts.to??'2088-02-29',opts.sub??'',opts.specialist??'',opts.status??'ACTIVE',opts.assignment??''].map(lit).join(',')+","+(opts.offset??0)+")"));
 // Existing schedule reads prepare the month; do that before the no-mutation snapshot.
 for(const who of ['STAFF_A','ADMIN','WEBMASTER'])sql('set role anon;select count(*) from public.orl_get_schedule('+lit(actors[who])+',2088,2)');
 const after=snapshot(),responses=Object.fromEntries(Object.keys(actors).map(k=>[k,stats(k)]));
 for(const r of Object.values(responses)){assert.equal(r.scope,'ALL_REQUESTS');assert.equal(r.total,103);assert.deepEqual(r.cards,[{name:'Statistics A',count:102},{name:'Statistics B',count:1}]);assert.ok(r.rows.every(x=>!('created_by'in x)&&!('assigned_slot_id'in x)));assert.ok(r.rows.every(x=>x.patient_ic==='900101-**-****'));}
 assert.equal(responses.STAFF_A.row_total,102);assert.equal(responses.STAFF_A.rows.length,100);assert.equal(responses.STAFF_A.row_scope,'MY_REQUESTS');
 assert.equal(responses.STAFF_B.row_total,1);assert.equal(responses.STAFF_B.rows[0].request_number,'STAT-103');
 for(const role of ['ADMIN','WEBMASTER'])assert.equal(responses[role].row_total,103);
 const second=stats('STAFF_A',{offset:100});assert.equal(second.rows.length,2);assert.equal(second.total,103);assert.equal(stats('STAFF_A',{offset:200}).rows.length,0);
 const selected=stats('STAFF_A',{sub:'Statistics B'});assert.equal(selected.total,1);assert.equal(selected.row_total,0);assert.equal(selected.rows.length,0);assert.equal(selected.cards.reduce((n,c)=>n+c.count,0),103);
 assert.equal(stats('STAFF_A',{specialist:'beta'}).total,1);assert.equal(stats('STAFF_A',{assignment:'ASSIGNED'}).total,1);
 assert.equal(stats('STAFF_A',{assignment:'UNASSIGNED'}).total,102);assert.equal(stats('STAFF_A',{status:'ALL'}).total,104);
 assert.equal(stats('STAFF_A',{status:'POSTPONED'}).total,1);assert.equal(stats('STAFF_A',{status:'PENDING'}).total,102);
 assert.equal(stats('STAFF_A',{status:'COMPLETED'}).total,0);assert.equal(stats('STAFF_A',{from:'2088-02-01',to:'2088-02-01'}).total,1);
 for(const opts of [{offset:-1},{status:'BAD'},{assignment:'BAD'},{from:'2088-03-01'}])assert.throws(()=>stats('STAFF_A',opts));
 // Compare unchanged per-user detail results and the schedule against the exact previous function in rolled-back transactions.
 const old=readFileSync(new URL('../../supabase/041_subspecialty_statistics.sql',import.meta.url),'utf8').replace('function public.orl_subspecialty_statistics(','function orl_private.c1_read_orl_subspecialty_statistics(').replace(/^begin;\r?$/m,'').split('revoke all on function')[0];
 for(const who of Object.keys(actors)){
  const query="select public.orl_subspecialty_statistics("+lit(actors[who])+",'2088-02-01','2088-02-29','','','ACTIVE','',0)";
  const legacy=JSON.parse(sql('begin;'+old+query+';rollback;'));assert.deepEqual(responses[who].rows,legacy.rows);
 }
 for(const role of ['STAFF_A','ADMIN','WEBMASTER']){
  const q="select jsonb_agg(to_jsonb(s)) from public.orl_get_schedule("+lit(actors[role])+",2088,2) s";
  const now=JSON.parse(sql('set role anon;'+q));
  const prior=JSON.parse(sql('begin;'+old+'set role anon;'+q+';rollback;'));assert.deepEqual(now,prior);
  assert.ok(now.some(day=>day.slots.some(x=>x.request_number==='STAT-103'||x.mrn==='STAT-103')));
 }
 assert.equal(snapshot(),after);assert.equal(unrelated(),preFunctions);
 for(const role of ['anon','authenticated','service_role'])assert.equal(sql("select has_function_privilege("+lit(role)+",'orl_private.c1_read_orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)','EXECUTE')"),'f');
 assert.throws(()=>sql("set role anon;select public.orl_subspecialty_statistics('11111111-1111-4111-8111-111111111111')"));
 sql("update public.orl_users set must_change_password=true where id="+lit(actors.STAFF_A));assert.throws(()=>stats('STAFF_A'));
 sql("update public.orl_users set must_change_password=false,is_active=false where id="+lit(actors.STAFF_A));assert.throws(()=>stats('STAFF_A'));
 sql("update public.orl_users set is_active=true where id="+lit(actors.STAFF_A));
 sql("update public.orl_sessions set expires_at=now()-interval '1 hour' where user_id="+lit(actors.STAFF_B));assert.throws(()=>stats('STAFF_B'));
 sql("update orl_private.site_maintenance set enabled=true where singleton");
 assert.throws(()=>stats('STAFF_A'));assert.throws(()=>stats('ADMIN'));assert.doesNotThrow(()=>stats('WEBMASTER'));
 sql("update orl_private.site_maintenance set enabled=false where singleton");
});
