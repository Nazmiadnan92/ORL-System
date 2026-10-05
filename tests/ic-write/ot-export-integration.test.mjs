import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {verifyOtExport} from '../../supabase/functions/_shared/c1/ot-export.mjs';
const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'ot-export-test',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}};
test('053: privileged session-bound exports, fresh snapshot, single-use audit and unchanged encrypted storage',async()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v==null?'NULL':"'"+String(v).replaceAll("'","''")+"'",json=v=>lit(JSON.stringify(v))+'::jsonb',service=q=>sql('set role service_role; '+q);
 const install=()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../supabase/053_ot_list_full_ic_export.sql',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 install();assert.throws(install);
 const auditPath=fileURLToPath(new URL('../../security/release/audit-ot-export.sql',import.meta.url));
 const checks=JSON.parse(execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',auditPath],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());
 assert.equal(Object.keys(checks).length,9);
 for(const [name,value]of Object.entries(checks))assert.equal(value,['plaintext_rows','identity_mismatch'].includes(name)?0:true,name);
 const users={};const pass='SYNTHETIC-EXPORT-PASSWORD';
 for(const role of ['ADMIN','WEBMASTER','STAFF']){
  const id=users[role]=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values
   (${lit(id)},${lit('ot_export_'+role)},extensions.crypt(${lit(pass)},extensions.gen_salt('bf',4)),${lit('Synthetic '+role)},${lit(role)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values
   (${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour');`);
 }
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton'),engine=await createIdentityCrypto(config);
 const sessionId=crypto.randomUUID(),otherSession=crypto.randomUUID(),ids=[];
 sql(`insert into public.orl_ot_sessions(id,ot_date,day_name) values(${lit(sessionId)},'2099-12-01','Tuesday'),(${lit(otherSession)},'2099-12-02','Wednesday');`);
 const raws=['010203-04-5678','','P1234567'];
 for(const [i,raw]of raws.entries()){
  const id=crypto.randomUUID();ids.push(id);
  const data={patient_ic:raw,age:'20',age_months:'0',patient_name:'Synthetic Export '+i,mrn:'EXPORT-'+id,surgery:'TEST',diagnosis:'TEST',
   doctor:'Test Doctor',specialist:'Test Specialist',sub_specialty:'Gen ORL',phone:'0',remark:''};
  service(`select public.orl_ic_c1_create(${lit(users.ADMIN)},${lit(id)},${json(data)},${raw?json(await engine.encrypt(raw,id)):'null'},${raw?json(await engine.searchHash(raw)):'null'},${lit(generation)});`);
  sql(`insert into public.orl_ot_slots(session_id,slot_type,slot_number,request_id,status) values
   (${lit(sessionId)},${lit(i===2?'SPECIAL':'MAIN')},${i+1},${lit(id)},${lit(i===1?'RESERVED':'CONFIRMED')});`);
 }
 const view=(user=users.ADMIN,password=pass,target=sessionId,gen=generation)=>JSON.parse(service(`select public.orl_ic_ot_export_view(${lit(user)},${lit(password)},${lit(target)},${lit(gen)});`));
 const commit=(v,user=users.ADMIN,target=sessionId,gen=generation)=>JSON.parse(service(`select public.orl_ic_ot_export_commit(${lit(user)},${lit(pass)},${lit(v.lease_id)},${lit(target)},${lit(gen)});`));
 for(const role of ['anon','authenticated']){
  for(const signature of ['orl_ic_ot_export_view(uuid,text,uuid,uuid)','orl_ic_ot_export_commit(uuid,text,uuid,uuid,uuid)'])
   assert.equal(sql(`select has_function_privilege('${role}','public.${signature}','EXECUTE')`),'f');
 }
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(sql(`select has_table_privilege('${role}','orl_private.ot_export_lease','SELECT,INSERT,UPDATE,DELETE')`),'f');
  assert.equal(sql(`select has_function_privilege('${role}','orl_private.ot_export_snapshot(uuid)','EXECUTE')`),'f');
 }
 assert.throws(()=>view(users.STAFF));assert.throws(()=>view(users.ADMIN,'WRONG'));
 assert.throws(()=>view(users.ADMIN,pass,otherSession));assert.throws(()=>view(users.ADMIN,pass,sessionId,crypto.randomUUID()));
 for(const role of ['ADMIN','WEBMASTER']){
  const v=view(users[role]);assert.deepEqual(v.snapshot.patients.map(p=>p.request_id),ids);
  const verified=await verifyOtExport(v,config,sessionId,generation);
  assert.deepEqual(verified.patients.map(p=>p.patient_ic),raws);
  assert.equal(commit(v,users[role]).patient_count,3);assert.throws(()=>commit(v,users[role]));
 }
 assert.equal(sql("select count(*) from public.orl_audit_log where action='OT_LIST_FULL_IC_GENERATED'"),'2');
 const audit=JSON.parse(sql("select jsonb_agg(to_jsonb(a)) from public.orl_audit_log a where action='OT_LIST_FULL_IC_GENERATED'"));
 assert.deepEqual(audit.map(a=>a.user_role).sort(),['ADMIN','WEBMASTER']);
 for(const a of audit){assert.equal(a.record_id,sessionId);assert.match(a.details,/2099-12-01/);assert.match(a.details,/Patient count: 3/);assert.ok(a.occurred_at);
  for(const raw of raws.filter(Boolean))assert.ok(!a.details.includes(raw));assert.ok(!a.details.includes('Synthetic Export'))}
 let v=view();assert.throws(()=>commit(v,users.WEBMASTER));assert.throws(()=>commit(v,users.ADMIN,otherSession));
 sql(`update orl_private.ot_export_lease set expires_at=now()-interval '1 second' where lease_id=${lit(v.lease_id)};`);
 assert.throws(()=>commit(v));
 v=view();sql(`update public.orl_requests set diagnosis='Changed synthetic' where id=${lit(ids[0])};`);assert.throws(()=>commit(v));
 v=view();sql(`update public.orl_ot_slots set status='CLOSED' where request_id=${lit(ids[1])};`);assert.throws(()=>commit(v));
 v=view();sql(`update orl_private.request_identity set updated_at=clock_timestamp() where request_id=${lit(ids[0])};`);assert.throws(()=>commit(v));
 // Audit failure must roll back the lease as well, not silently release a result.
 v=view();sql("create function public.export_test_fail_audit() returns trigger language plpgsql as $$ begin if new.action='OT_LIST_FULL_IC_GENERATED' then raise exception 'synthetic audit failure'; end if; return new; end $$; create trigger export_test_audit before insert on public.orl_audit_log for each row execute function public.export_test_fail_audit();");
 assert.throws(()=>commit(v));
 assert.equal(sql(`select committed_at is null from orl_private.ot_export_lease where lease_id=${lit(v.lease_id)}`),'t');
 sql('drop trigger export_test_audit on public.orl_audit_log;drop function public.export_test_fail_audit();');
 assert.equal(sql("select count(*) from public.orl_audit_log where action='OT_LIST_FULL_IC_GENERATED'"),'2');
 assert.equal(sql(`select patient_ic from public.orl_requests where id=${lit(ids[0])}`),'010203-**-****');
 assert.equal(sql("select (orl_private.c6_stats()->>'plaintext_rows')::int"),'0');
 // Restore generation and role changes invalidate already prepared exports.
 v=view();sql(`update public.orl_users set role='STAFF' where id=${lit(users.ADMIN)}`);assert.throws(()=>commit(v));
 sql(`update public.orl_users set role='ADMIN' where id=${lit(users.ADMIN)}`);
 v=view();sql("update orl_private.c1_restore_generation set generation=gen_random_uuid() where singleton");assert.throws(()=>commit(v));
});
