import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('054 closes explicit/inherited helper access without changing data, login or trusted workflows',()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const file=p=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+p,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const install=()=>file('supabase/054_session_helper_private.sql');
 const lit=v=>"'"+String(v).replaceAll("'","''")+"'";
 const allowed=r=>sql(`select has_function_privilege('${r}','public.orl_require_session(uuid)','EXECUTE')`);
 const snapshot=()=>sql(`select jsonb_build_object('definitions',(select md5(string_agg(pg_get_functiondef(p.oid),'' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.prokind='f'),
  'users',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.orl_users t),
  'sessions',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.orl_sessions t),
  'requests',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.orl_requests t),
  'identities',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by request_id)::text,'')) from orl_private.request_identity t),
  'other_acl',(select md5(string_agg(coalesce(p.proacl::text,''),'' order by p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.oid<>'public.orl_require_session(uuid)'::regprocedure));`);
 // Reproduce the real environment's explicit grants: an ordinary local cluster misses this.
 for(const r of ['anon','authenticated','service_role'])assert.equal(allowed(r),'t');
 sql('create role synthetic_helper_parent; grant execute on function public.orl_require_session(uuid) to synthetic_helper_parent; grant synthetic_helper_parent to anon;');
 assert.throws(install); // inherited grant must fail closed and roll back the revokes
 assert.equal(allowed('authenticated'),'t');
 sql('revoke synthetic_helper_parent from anon; revoke all on function public.orl_require_session(uuid) from synthetic_helper_parent; drop role synthetic_helper_parent;');
 const before=snapshot();install();assert.equal(snapshot(),before);install();assert.equal(snapshot(),before);
 const audit=JSON.parse(file('security/release/audit-session-helper.sql'));
 assert.equal(Object.keys(audit).length,6);for(const [k,v] of Object.entries(audit))assert.equal(v,true,k);
 const pass='SyntheticPass1';
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const id=crypto.randomUUID(),name='helper_'+role.toLowerCase();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit(name)},extensions.crypt(${lit(pass)},extensions.gen_salt('bf',4)),${lit('Synthetic '+role)},${lit(role)})`);
  for(const caller of ['anon','authenticated']){
   const login=JSON.parse(sql(`set role ${caller};select to_jsonb(x) from public.orl_login(${lit(name)},${lit(pass)}) x`));
   assert.equal(login.role,role);assert.ok(!Object.hasOwn(login,'password_hash'));
   const token=lit(login.session_token);
   for(const directRole of ['anon','authenticated','service_role']){
    assert.equal(allowed(directRole),'f');
    assert.throws(()=>sql(`set role ${directRole};select public.orl_require_session(${token})`));
   }
   const current=JSON.parse(sql(`set role ${caller};select to_jsonb(x) from public.orl_current_user(${token}) x`));
   assert.equal(current.role,role);assert.ok(!Object.hasOwn(current,'password_hash'));
   // Public SECURITY DEFINER and service-only Edge RPCs still call the helper internally.
   assert.doesNotThrow(()=>sql(`set role ${caller};select public.orl_get_settings(${token});select public.orl_get_requests(${token})`));
   assert.doesNotThrow(()=>sql(`set role service_role;select public.orl_ic_c1_authorize(${token});select public.orl_ic_c1_prepare_create(${token})`));
   if(role==='STAFF')assert.throws(()=>sql(`set role ${caller};select public.orl_list_users(${token})`));
   else assert.doesNotThrow(()=>sql(`set role ${caller};select public.orl_list_users(${token})`));
   sql(`set role ${caller};select public.orl_logout(${token})`);
   assert.throws(()=>sql(`set role ${caller};select public.orl_get_settings(${token})`));
  }
 }
 // Password-required and deactivated accounts must not bypass the existing guards.
 sql("update public.orl_users set must_change_password=true where username='helper_staff'");
 const pending=JSON.parse(sql(`set role anon;select to_jsonb(x) from public.orl_login('helper_staff',${lit(pass)}) x`));
 assert.equal(pending.must_change_password,true);
 assert.throws(()=>sql(`set role anon;select public.orl_get_settings(${lit(pending.session_token)})`));
 sql(`set role anon;select public.orl_complete_required_password_change(${lit(pending.session_token)},'ChangedPass123')`);
 const changed=JSON.parse(sql("set role anon;select to_jsonb(x) from public.orl_login('helper_staff','ChangedPass123') x"));
 assert.equal(changed.must_change_password,false);
 sql("update public.orl_users set is_active=false where username='helper_staff'");
 assert.throws(()=>sql(`set role anon;select public.orl_get_settings(${lit(changed.session_token)})`));
 // Future unexpected overloads cannot silently receive a successful migration stamp.
 sql("create function public.orl_require_session(text) returns boolean language sql as $$select false$$");
 assert.throws(install);sql('drop function public.orl_require_session(text)');
});
