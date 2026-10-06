import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';

test('056: default OFF, password/role/revision guards, live sessions blocked, locks drain prior operations, audit and recovery retained',async()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v===null?'NULL':"'"+String(v).replaceAll("'","''")+"'";
 const install=()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../supabase/056_webmaster_maintenance.sql',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 const snapshot=()=>sql("select md5(jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i))::text)");
 const before=snapshot();install();assert.equal(snapshot(),before);assert.throws(install);
 const audit=JSON.parse(execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../security/release/audit-maintenance.sql',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());
 assert.equal(Object.keys(audit).length,6);for(const [name,ok]of Object.entries(audit))assert.equal(ok,true,name);
 const status=()=>JSON.parse(sql('set role anon;select public.orl_maintenance_status()'));
 assert.equal(status().enabled,false);assert.equal(status().revision,0);
 const actors={};const password='SyntheticPass1';
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  sql(`insert into public.orl_users(username,password_hash,display_name,role) values('maint_${role}',extensions.crypt(${lit(password)},extensions.gen_salt('bf',4)),'Synthetic',${lit(role)})`);
  actors[role]=JSON.parse(sql(`set role anon;select to_jsonb(x) from public.orl_login('maint_${role}',${lit(password)}) x`)).session_token;
 }
 const toggle=(role,on,revision,pass=password)=>sql(`set role anon;select public.orl_set_maintenance(${lit(actors[role])},${lit(pass)},${on},'Synthetic maintenance','2099-01-01',${revision})`);
 for(const role of ['STAFF','ADMIN'])assert.throws(()=>toggle(role,true,0));
 assert.throws(()=>toggle('WEBMASTER',true,0,'wrong'));assert.equal(status().revision,0);
 assert.throws(()=>toggle('WEBMASTER',true,99));
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(sql(`select has_table_privilege('${role}','orl_private.site_maintenance','SELECT') or has_table_privilege('${role}','orl_private.site_maintenance','UPDATE') or has_function_privilege('${role}','public.orl_require_session(uuid)','EXECUTE')`),'f');
 }
 // Keep an already-authorized Admin transaction open; ON must not finish first.
 const holder=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let holderError='';holder.stderr.on('data',d=>holderError+=d);
 const held=new Promise((resolve,reject)=>{holder.stdout.on('data',d=>{if(String(d).includes('LOCKED'))resolve()});holder.on('error',reject)});
 const ended=new Promise(resolve=>holder.on('exit',resolve));
 holder.stdin.write(`begin;set role service_role;select public.orl_ic_c1_authorize(${lit(actors.ADMIN)});select 'LOCKED';\n`);await held;
 try{
  assert.throws(()=>sql(`set lock_timeout='200ms';set role anon;select public.orl_set_maintenance(${lit(actors.WEBMASTER)},${lit(password)},true,'Synthetic maintenance',null,0)`));
  assert.equal(status().enabled,false);
 }finally{holder.stdin.end('commit;\n');assert.equal(await ended,0,holderError)}
 toggle('WEBMASTER',true,0);assert.equal(status().enabled,true);
 for(const role of ['STAFF','ADMIN']){
  const token=lit(actors[role]);
  for(const query of [`set role anon;select public.orl_get_settings(${token})`,
   `set role anon;select public.orl_get_schedule(${token},2096,4)`,
   `set role service_role;select public.orl_ic_c1_authorize(${token})`,
   `set role service_role;select public.orl_ic_c1_prepare_create(${token})`])
   assert.throws(()=>sql(query),e=>String(e.stderr).includes('ORL_MAINTENANCE'));
  // Sign-in/profile/logout remain available without granting clinical access.
  assert.ok(sql(`set role anon;select user_id from public.orl_current_user(${token})`));
  const fresh=JSON.parse(sql(`set role anon;select to_jsonb(x) from public.orl_login('maint_${role}',${lit(password)}) x`));
  assert.throws(()=>sql(`set role service_role;select public.orl_ic_c1_authorize(${lit(fresh.session_token)})`));
  actors[role]=fresh.session_token;
 }
 assert.doesNotThrow(()=>sql(`set role anon;select public.orl_get_settings(${lit(actors.WEBMASTER)})`));
 assert.doesNotThrow(()=>sql(`set role service_role;select public.orl_ic_c1_authorize(${lit(actors.WEBMASTER)})`));
 assert.throws(()=>toggle('WEBMASTER',false,0));assert.equal(status().enabled,true);
 toggle('WEBMASTER',false,1);assert.equal(status().enabled,false);assert.equal(status().expected_end,null);
 for(const role of ['STAFF','ADMIN'])assert.doesNotThrow(()=>sql(`set role service_role;select public.orl_ic_c1_authorize(${lit(actors[role])})`));
 assert.equal(sql("select string_agg(action,',' order by id) from public.orl_audit_log where record_id='MAINTENANCE'"),'MAINTENANCE_ON,MAINTENANCE_OFF');
 assert.equal(snapshot(),before);
 sql("update public.orl_users set must_change_password=true where username='maint_WEBMASTER'");
 assert.throws(()=>toggle('WEBMASTER',true,2));
 sql("update public.orl_users set must_change_password=false,is_active=false where username='maint_WEBMASTER'");
 assert.throws(()=>toggle('WEBMASTER',true,2));assert.equal(status().enabled,false);
});
