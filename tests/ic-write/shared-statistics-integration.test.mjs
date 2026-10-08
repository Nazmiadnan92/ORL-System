import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('060: all roles see all non-Draft patient rows; pagination/filters/masking and existing session, View OT and write boundaries survive',async()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=x=>x==null?'NULL':"'"+String(x).replaceAll("'","''")+"'";
 const install=()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../supabase/060_shared_statistics_patient_list.sql',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet then raise exception 'Disposable local fixture only'; end if; end $$;");
 assert.equal(sql("select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='orl_private.c1_read_orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)'::regprocedure"),'904a7c884989c5fadc8411a7c1c9c2d7','Run historical 059 first');

 const actors={};for(const name of ['STAFF_A','STAFF_B','ADMIN','WEBMASTER']){
  const role=name.startsWith('STAFF')?'STAFF':name,id=crypto.randomUUID();actors[name]=id;
  sql("insert into public.orl_users(id,username,password_hash,display_name,role) values("+[id,'shared_stat_'+name,'unused','Synthetic shared statistics',role].map(lit).join(',')+");"+
   "insert into public.orl_sessions(user_id,token_hash,expires_at) values("+lit(id)+",encode(extensions.digest("+lit(id)+",'sha256'),'hex'),now()+interval '1 hour');");
 }
 // Separate dates/names keep the historical 059 fixtures intact. All data and cryptographic material are synthetic.
 sql("insert into public.orl_requests(request_number,patient_ic,mrn,patient_name,age,age_months,surgery,diagnosis,doctor,specialist,sub_specialty,phone,status,created_by,created_at,postpone_count) "+
  "select 'STATSH-'||n,'900101-**-****','STATSH-'||n,'Synthetic shared '||n,20,0,'Synthetic procedure','Synthetic diagnosis','Synthetic doctor',"+
  "case when n<=102 then 'Alpha' else 'Beta' end,case when n<=102 then 'Shared A' when n=103 then 'Shared B' else 'Shared C' end,'0',"+
  "case when n<=102 then 'CONFIRMED' when n=103 then 'SCHEDULED' when n=104 then 'CANCELLED' when n=106 then 'APPROVED' when n=107 then 'COMPLETED' when n=108 then 'REJECTED' else 'DRAFT' end,"+
  "case when n<=100 or n=109 then "+lit(actors.STAFF_A)+"::uuid when n<=103 or n=108 then "+lit(actors.STAFF_B)+"::uuid when n in(104,107) then "+lit(actors.ADMIN)+"::uuid else "+lit(actors.WEBMASTER)+"::uuid end,"+
  "case when n=1 then '2092-01-31 16:30:00+00'::timestamptz when n=103 then '2093-01-01'::timestamptz when n=106 then '2092-02-25'::timestamptz else '2092-02-15'::timestamptz end,case when n=2 then 1 else 0 end from generate_series(1,109) n;");
 const session=crypto.randomUUID(),slot=crypto.randomUUID();
 sql("insert into public.orl_ot_sessions(id,ot_date,day_name) values("+lit(session)+",'2092-02-20','Synthetic');"+
  "insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status) select "+lit(slot)+","+lit(session)+",'MAIN',1,id,'CONFIRMED' from public.orl_requests where request_number='STATSH-103';"+
  "update public.orl_requests set assigned_slot_id="+lit(slot)+" where request_number='STATSH-103';");

 // 059's direct test inserts intentionally lacked encrypted counterparts. Supply valid synthetic envelopes
 // for those fixtures and this suite before taking snapshots, so the full 060 storage audit can pass.
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const engine=await createIdentityCrypto({context:'synthetic-shared-statistics',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}});
 const ids=JSON.parse(sql("select jsonb_agg(r.id) from public.orl_requests r join public.orl_users u on u.id=r.created_by left join orl_private.request_identity i on i.request_id=r.id where i.request_id is null and ((r.request_number ~ '^STAT-[0-9]+$' and u.username in('stat_STAFF_A','stat_STAFF_B')) or (r.request_number ~ '^STATSH-[0-9]+$' and u.username like 'shared_stat_%'))"));
 const raw='900101-01-1234',search=await engine.searchHash(raw),identityInserts=[];
 for(const id of ids){const envelope=await engine.encrypt(raw,id);identityInserts.push('select orl_private.c1_store_identity('+[id,raw,JSON.stringify(envelope),JSON.stringify(search)].map(lit).join(',')+');')}
 sql(identityInserts.join('\n'));

 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const unrelated=()=>sql("select md5(string_agg(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),E'\\n' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.proname<>'c1_read_orl_subspecialty_statistics' and p.prokind='f'");
 const access=()=>sql("select md5(string_agg(c.oid::text||coalesce(c.relacl::text,'')||c.relrowsecurity::text||c.relforcerowsecurity::text,E'\\n' order by c.oid)) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','orl_private')");
 const stats=(who,opts={},dbRole='anon')=>JSON.parse(sql('set role '+dbRole+';select public.orl_subspecialty_statistics('+[actors[who],opts.from??'2092-02-01',opts.to??'2092-02-29',opts.sub??'',opts.specialist??'',opts.status??'ACTIVE',opts.assignment??''].map(lit).join(',')+','+(opts.offset??0)+')'));
 const schedule=who=>JSON.parse(sql('set role anon;select coalesce(jsonb_agg(to_jsonb(s)),\'[]\') from public.orl_get_schedule('+lit(actors[who])+',2092,2) s'));
 const previousSchedules=Object.fromEntries(Object.keys(actors).map(who=>[who,schedule(who)]));
 const oldAdmin=stats('ADMIN'),oldAdminSecond=stats('ADMIN',{offset:100});
 assert.equal(stats('STAFF_A').row_total,100);assert.equal(stats('STAFF_B').row_total,3);
 const before=snapshot(),beforeFunctions=unrelated(),beforeAccess=access();
 install();assert.equal(snapshot(),before,'Migration must not mutate any stored application data');
 assert.equal(unrelated(),beforeFunctions,'All other functions, including edit/write/View OT and their ACLs, are identical');assert.equal(access(),beforeAccess);
 assert.throws(install);assert.equal(snapshot(),before,'Rejected reinstall is atomic');
 const audit=JSON.parse(execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../security/release/audit-shared-statistics.sql',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());
 assert.equal(Object.keys(audit).length,7);for(const [k,v]of Object.entries(audit))assert.equal(v,true,k);

 const responses=Object.fromEntries(Object.keys(actors).map(who=>[who,stats(who)]));
 for(const [who,r]of Object.entries(responses)){
  assert.equal(r.scope,'ALL_REQUESTS');assert.equal(r.row_scope,'ALL_REQUESTS');assert.equal(r.total,104);assert.equal(r.row_total,r.total);
  assert.equal(r.rows.length,100);assert.deepEqual(r.cards,[{name:'Shared A',count:102},{name:'Shared B',count:1},{name:'Shared C',count:1}]);
  assert.deepEqual(r.rows,oldAdmin.rows,who+' has the previous unrestricted patient list');assert.deepEqual(r,responses.STAFF_A);
  const second=stats(who,{offset:100});assert.equal(second.rows.length,4);assert.deepEqual(second.rows,oldAdminSecond.rows);
  const rows=[...r.rows,...second.rows];assert.equal(new Set(rows.map(x=>x.id)).size,104);
  assert.ok(rows.some(x=>x.request_number==='STATSH-103'),'Staff sees another creator’s assigned patient');
  assert.ok(rows.some(x=>x.request_number==='STATSH-106'),'All roles see the Webmaster-created patient');
  assert.ok(rows.every(x=>x.patient_ic==='900101-**-****'&&x.patient_ic_masked===true));
  assert.ok(rows.every(x=>!('created_by'in x)&&!('assigned_slot_id'in x)&&!('ciphertext'in x)&&!('search_hash'in x)));
  assert.ok(!JSON.stringify(rows).includes(raw));assert.equal(stats(who,{offset:200}).rows.length,0);
  assert.deepEqual(schedule(who),previousSchedules[who],'View OT remains unchanged');
  const all=[stats(who,{status:'ALL'}),stats(who,{status:'ALL',offset:100})];
  assert.equal(all[0].total,107);assert.equal(all[0].row_total,107);assert.equal(all.flatMap(x=>x.rows).length,107);
  assert.ok(all.flatMap(x=>x.rows).every(x=>x.status!=='DRAFT'));
 }
 assert.deepEqual(stats('STAFF_A',{},'authenticated'),responses.STAFF_A);
 for(const who of Object.keys(actors)){
  const selected=stats(who,{sub:'Shared B'});assert.equal(selected.total,1);assert.equal(selected.row_total,1);assert.equal(selected.rows[0].request_number,'STATSH-103');
  assert.equal(selected.cards.reduce((n,c)=>n+c.count,0),104);
  assert.equal(stats(who,{specialist:'bEtA'}).total,2);assert.equal(stats(who,{assignment:'ASSIGNED'}).total,1);
  assert.equal(stats(who,{assignment:'UNASSIGNED'}).total,103);assert.equal(stats(who,{status:'POSTPONED'}).total,1);
  assert.equal(stats(who,{status:'PENDING'}).total,102);
  for(const status of ['SCHEDULED','APPROVED','COMPLETED','CANCELLED','REJECTED'])assert.equal(stats(who,{status}).total,1);
  assert.equal(stats(who,{from:'2092-02-01',to:'2092-02-01'}).rows[0].request_number,'STATSH-1');
  assert.equal(stats(who,{sub:'No such specialty'}).row_total,0);
 }
 for(const opts of [{offset:-1},{status:'DRAFT'},{status:'BAD'},{assignment:'BAD'},{from:'2092-03-01'}])assert.throws(()=>stats('STAFF_A',opts));
 const otherRequest=sql("select id from public.orl_requests where request_number='STATSH-103'");
 assert.throws(()=>sql('set role anon;select public.orl_booking_move_view('+lit(actors.STAFF_A)+','+lit(otherRequest)+')'));
 assert.doesNotThrow(()=>sql('set role anon;select public.orl_booking_move_view('+lit(actors.STAFF_B)+','+lit(otherRequest)+')'));
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(sql("select has_function_privilege("+lit(role)+",'orl_private.c1_read_orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)','EXECUTE')"),'f');
  assert.equal(sql("select has_function_privilege("+lit(role)+",'public.orl_require_session(uuid)','EXECUTE')"),'f');
  assert.equal(sql("select has_table_privilege("+lit(role)+",'orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE')"),'f');
 }
 assert.throws(()=>sql('set role anon;select * from orl_private.request_identity'));
 assert.throws(()=>sql("set role anon;update public.orl_requests set patient_name='Forbidden' where id="+lit(otherRequest)));
 assert.equal(snapshot(),before,'Statistics reads and denied writes mutate no stored data');assert.equal(unrelated(),beforeFunctions);assert.equal(access(),beforeAccess);
 assert.throws(()=>sql("set role anon;select public.orl_subspecialty_statistics(null)"));
 assert.throws(()=>sql("set role anon;select public.orl_subspecialty_statistics('11111111-1111-4111-8111-111111111111')"));
 for(const who of Object.keys(actors)){
  sql('update public.orl_users set must_change_password=true where id='+lit(actors[who]));assert.throws(()=>stats(who));
  sql('update public.orl_users set must_change_password=false,is_active=false where id='+lit(actors[who]));assert.throws(()=>stats(who));
  sql('update public.orl_users set is_active=true where id='+lit(actors[who]));
  sql("update public.orl_sessions set expires_at=now()-interval '1 hour' where user_id="+lit(actors[who]));assert.throws(()=>stats(who));
  sql("update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id="+lit(actors[who]));
 }
 sql('update orl_private.site_maintenance set enabled=true where singleton');
 for(const who of ['STAFF_A','STAFF_B','ADMIN'])assert.throws(()=>stats(who));assert.doesNotThrow(()=>stats('WEBMASTER'));
 sql('update orl_private.site_maintenance set enabled=false where singleton');
 assert.equal(unrelated(),beforeFunctions);assert.equal(access(),beforeAccess);
});
