import {test} from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {verifyC3Reveal} from '../../supabase/functions/_shared/c1/c3-reveal.mjs';
const randomKey=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'c3-integration-synthetic',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',
  encryptionKeys:{'enc-v1':randomKey()},searchKeys:{'search-v1':randomKey()}};
const password='SYNTHETIC-C3-PASSWORD',raw='000202-00-0000';

test('migration 049 enforces one-record password/purpose lease and value-free audit',async()=>{
  const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
  const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  const literal=v=>v==null?'NULL':"'"+String(v).replaceAll("'","''")+"'",json=v=>literal(JSON.stringify(v))+'::jsonb';
  const service=q=>sql('set role service_role; '+q),admin=crypto.randomUUID(),staff=crypto.randomUUID(),requestId=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values
    (${literal(admin)},'c3_admin',extensions.crypt(${literal(password)},extensions.gen_salt('bf',4)),'Synthetic Admin','ADMIN'),
    (${literal(staff)},'c3_staff',extensions.crypt(${literal(password)},extensions.gen_salt('bf',4)),'Synthetic Staff','STAFF');
    insert into public.orl_sessions(user_id,token_hash,expires_at) values
    (${literal(admin)},encode(extensions.digest(${literal(admin)},'sha256'),'hex'),now()+interval '1 hour'),
    (${literal(staff)},encode(extensions.digest(${literal(staff)},'sha256'),'hex'),now()+interval '1 hour');`);
  const generation=sql('select generation from orl_private.c1_restore_generation where singleton'),engine=await createIdentityCrypto(config);
  const data={patient_ic:raw,age:'26',age_months:'0',patient_name:'Synthetic C3',mrn:'C3-'+requestId,surgery:'TEST',diagnosis:'TEST',
    doctor:'Test Doctor',specialist:'Test Specialist',sub_specialty:'Gen ORL',phone:'0',remark:''};
  assert.equal(service(`select public.orl_ic_c1_create(${literal(admin)},${literal(requestId)},${json(data)},
    ${json(await engine.encrypt(raw,requestId))},${json(await engine.searchHash(raw))},${literal(generation)});`),requestId);
  const migration=fileURLToPath(new URL('../../supabase/049_ic_c3_authorized_reveal.sql',import.meta.url));
  execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',migration],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.throws(()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',migration],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c3_reveal_view(uuid,text,uuid,text,uuid)','EXECUTE')`),'f');
  assert.equal(sql("select has_table_privilege('service_role','orl_private.c3_reveal_lease','SELECT,INSERT,UPDATE,DELETE')"),'f');
  assert.throws(()=>service(`select public.orl_ic_c3_reveal_view(${literal(staff)},${literal(password)},${literal(requestId)},'CLINICAL_VERIFICATION',${literal(generation)});`));
  assert.throws(()=>service(`select public.orl_ic_c3_reveal_view(${literal(admin)},'WRONG',${literal(requestId)},'CLINICAL_VERIFICATION',${literal(generation)});`));
  assert.throws(()=>service(`select public.orl_ic_c3_reveal_view(${literal(admin)},${literal(password)},${literal(requestId)},'CURIOSITY',${literal(generation)});`));
  const view=JSON.parse(service(`select public.orl_ic_c3_reveal_view(${literal(admin)},${literal(password)},${literal(requestId)},'CLINICAL_VERIFICATION',${literal(generation)});`));
  const verified=await verifyC3Reveal(view,config);assert.equal(verified.patient_ic,raw);
  const commit=JSON.parse(service(`select public.orl_ic_c3_reveal_commit(${literal(admin)},${literal(password)},${literal(verified.lease_id)},
    ${literal(requestId)},${literal(generation)},${literal(verified.identity_updated_at)});`));
  assert.equal(commit.request_id,requestId);assert.ok(Date.parse(commit.expires_at)>Date.now());
  assert.throws(()=>service(`select public.orl_ic_c3_reveal_commit(${literal(admin)},${literal(password)},${literal(verified.lease_id)},
    ${literal(requestId)},${literal(generation)},${literal(verified.identity_updated_at)});`));
  assert.equal(sql(`select count(*) from public.orl_audit_log where action='IC_FULL_REVEAL' and record_id=${literal(requestId)}`),'1');
  assert.equal(sql(`select count(*) from public.orl_audit_log where action='IC_FULL_REVEAL' and details like '%'||${literal(raw)}||'%'`),'0');
  assert.equal(sql(`select patient_ic from public.orl_requests where id=${literal(requestId)}`),raw,'C3 must not remove plaintext before C6');
});
