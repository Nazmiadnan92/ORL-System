import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {verifyC2Identities} from '../../supabase/functions/_shared/c1/c2-maintenance.mjs';
import {verifyC3Reveal} from '../../supabase/functions/_shared/c1/c3-reveal.mjs';
const randomKey=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'c6-integration-synthetic',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',
  encryptionKeys:{'enc-v1':randomKey()},searchKeys:{'search-v1':randomKey()}};
const password='SYNTHETIC-C6-PASSWORD',raw='010203-04-5678';

test('migration 050 requires fresh crypto receipt, masks legacy rows and keeps create/search/backup encrypted',async()=>{
  const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
  const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  const literal=v=>v==null?'NULL':"'"+String(v).replaceAll("'","''")+"'",json=v=>literal(JSON.stringify(v))+'::jsonb',service=q=>sql('set role service_role; '+q);
  sql(`truncate orl_private.c3_reveal_lease,orl_private.c2_verified_identity,orl_private.c2_verification_runs,
    orl_private.request_identity,orl_private.c1_creation_receipts,public.orl_audit_log,public.orl_ot_slots,
    public.orl_ot_sessions,public.orl_requests,public.orl_sessions,public.orl_users cascade;`);
  const wm=crypto.randomUUID();sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values
    (${literal(wm)},'c6_webmaster',extensions.crypt(${literal(password)},extensions.gen_salt('bf',4)),'Synthetic C6','WEBMASTER');
    insert into public.orl_sessions(user_id,token_hash,expires_at) values
    (${literal(wm)},encode(extensions.digest(${literal(wm)},'sha256'),'hex'),now()+interval '1 hour');`);
  const generation=sql('select generation from orl_private.c1_restore_generation where singleton'),engine=await createIdentityCrypto(config),requestId=crypto.randomUUID();
  const data={patient_ic:raw,age:'20',age_months:'0',patient_name:'Synthetic C6',mrn:'C6-'+requestId,surgery:'TEST',diagnosis:'TEST',
    doctor:'Test Doctor',specialist:'Test Specialist',sub_specialty:'Gen ORL',phone:'0',remark:`Identity ${raw}`};
  assert.equal(service(`select public.orl_ic_c1_create(${literal(wm)},${literal(requestId)},${json(data)},
    ${json(await engine.encrypt(raw,requestId))},${json(await engine.searchHash(raw))},${literal(generation)});`),requestId);
  sql(`update public.orl_requests set deletion_reason=${literal(raw)},review_note=${literal(raw)},
    postpone_history=${json([{reason:raw}])} where id=${literal(requestId)};
    insert into public.orl_audit_log(action,details,record_id) values ('C6_TEST',${literal(raw)},${literal(raw)}),('C6_UNCHANGED','No identity here','unchanged');
    insert into public.orl_holidays(holiday_date,title,description) values ('2098-01-01','C6 synthetic',${literal(raw)});
    insert into public.orl_ot_sessions(ot_date,day_name,note,special_title) values ('2098-01-01','Wednesday',${literal(raw)},${literal(raw)});`);
  let state=JSON.parse(service(`select public.orl_ic_c2_status(${literal(wm)},${literal(password)});`));
  const run=JSON.parse(service(`select public.orl_ic_c2_verify_start(${literal(wm)},${literal(password)},${literal(generation)},${literal(state.revision)});`));
  const view=JSON.parse(service(`select public.orl_ic_c2_verify_view(${literal(wm)},${literal(password)},${literal(generation)},${literal(run.run_id)});`));
  const receipts=await verifyC2Identities(view.items,config);
  const progress=JSON.parse(service(`select public.orl_ic_c2_verify_commit(${literal(wm)},${literal(password)},${literal(generation)},${literal(run.run_id)},${json(receipts)});`));
  assert.equal(progress.remaining,0);
  assert.equal(JSON.parse(service(`select public.orl_ic_c2_finalize(${literal(wm)},${literal(password)},${literal(generation)},${literal(run.run_id)});`)).status,'COMPLETED');
  const migration=fileURLToPath(new URL('../../supabase/050_ic_c6_plaintext_cutover.sql',import.meta.url));
  execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',migration],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.throws(()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',migration],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  state=JSON.parse(service(`select public.orl_ic_c6_status(${literal(wm)},${literal(password)});`));assert.equal(state.plaintext_rows,1);
  const beforeRepair=sql(`select row_to_json(r) from public.orl_requests r where id=${literal(requestId)}`);
  const repair=fileURLToPath(new URL('../../supabase/051_ic_c6_scoped_updates.sql',import.meta.url));
  const beforeBody=sql("select prosrc from pg_proc where oid='public.orl_ic_c6_cutover(uuid,text,uuid,uuid)'::regprocedure");
  assert.ok([...beforeBody.matchAll(/update public\.[\s\S]*?;/g)].some(m=>!/\bwhere\b/i.test(m[0])));
  execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',repair],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(sql(`select row_to_json(r) from public.orl_requests r where id=${literal(requestId)}`),beforeRepair);
  assert.throws(()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',repair],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  const repairedBody=sql("select prosrc from pg_proc where oid='public.orl_ic_c6_cutover(uuid,text,uuid,uuid)'::regprocedure");
  const updates=[...repairedBody.matchAll(/update public\.[\s\S]*?;/g)];assert.equal(updates.length,5);
  for(const [update] of updates)assert.match(update,/\bwhere\b/i);
  const untouchedAudit=sql("select xmin::text from public.orl_audit_log where action='C6_UNCHANGED'");
  const done=JSON.parse(service(`select public.orl_ic_c6_cutover(${literal(wm)},${literal(password)},${literal(generation)},${literal(run.run_id)});`));
  assert.equal(done.status,'COMPLETED');assert.equal(done.plaintext_rows,0);
  assert.equal(sql(`select patient_ic from public.orl_requests where id=${literal(requestId)}`),'010203-**-****');
  assert.equal(sql(`select remark from public.orl_requests where id=${literal(requestId)}`),'Identity 010203-**-****');
  assert.equal(sql(`select deletion_reason||'|'||review_note||'|'||(postpone_history->0->>'reason') from public.orl_requests where id=${literal(requestId)}`),'010203-**-****|010203-**-****|010203-**-****');
  assert.equal(sql("select details||'|'||record_id from public.orl_audit_log where action='C6_TEST'"),'010203-**-****|010203-**-****');
  assert.equal(sql("select description from public.orl_holidays where holiday_date='2098-01-01'"),'010203-**-****');
  assert.equal(sql("select note||'|'||special_title from public.orl_ot_sessions where ot_date='2098-01-01'"),'010203-**-****|010203-**-****');
  assert.equal(sql("select xmin::text from public.orl_audit_log where action='C6_UNCHANGED'"),untouchedAudit);
  assert.throws(()=>service(`select public.orl_ic_c6_cutover(${literal(wm)},${literal(password)},${literal(generation)},${literal(run.run_id)});`));
  const secondId=crypto.randomUUID(),secondRaw='A1234567',second={...data,patient_ic:secondRaw,mrn:'C6-'+secondId,remark:''};
  assert.equal(service(`select public.orl_ic_c1_create(${literal(wm)},${literal(secondId)},${json(second)},
    ${json(await engine.encrypt(secondRaw,secondId))},${json(await engine.searchHash(secondRaw))},${literal(generation)});`),secondId);
  assert.equal(sql(`select patient_ic from public.orl_requests where id=${literal(secondId)}`),'********4567');
  const search=await engine.searchHash(raw),rows=JSON.parse(service(`select public.orl_ic_c6_find_patient(${literal(wm)},${literal(raw)},${literal(search.key_id)},${literal(search.hash)});`));
  assert.equal(rows.some(r=>r.id===requestId),true);assert.equal(rows.find(r=>r.id===requestId).patient_ic,'010203-**-****');
  const backup=JSON.parse(service(`select public.orl_ic_c1_export(${literal(wm)},${literal(password)});`));
  assert.equal(backup.version,3);assert.equal(backup.plaintext_removed,true);assert.doesNotMatch(JSON.stringify(backup),/010203-04-5678|A1234567/);
  // C7 regressions: post-cutover age, private ACLs, reveal and application restore.
  if(process.env.ORL_IC_TEST_C7==='1'){
  assert.equal(sql("select public.orl_age_parts('010203-**-****','2030-03-04') is null"),'t');
  const before052=sql('select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r');
  const fix=fileURLToPath(new URL('../../supabase/052_ic_c7_age_and_recovery.sql',import.meta.url));
  execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fix],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.equal(sql('select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r'),before052);
  assert.throws(()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fix],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  assert.equal(sql("select public.orl_age_parts('010203-**-****','2030-03-04')=public.orl_age_parts('010203-04-5678','2030-03-04')"),'t');
  assert.equal(sql("select public.orl_age_parts('991332-**-****','2030-03-04') is null"),'t');
  for(const role of ['anon','authenticated','service_role']){
    assert.equal(sql(`select has_table_privilege('${role}','orl_private.request_identity','SELECT,INSERT,UPDATE,DELETE')`),'f');
    assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c2_backfill_view(uuid,text,uuid,text)','EXECUTE')`),'f');
    assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean)','EXECUTE')`),'f');
  }
  const staff=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values
    (${literal(staff)},'c7_staff',extensions.crypt(${literal(password)},extensions.gen_salt('bf',4)),'Synthetic C7 Staff','STAFF');
    insert into public.orl_sessions(user_id,token_hash,expires_at) values
    (${literal(staff)},encode(extensions.digest(${literal(staff)},'sha256'),'hex'),now()+interval '1 hour');`);
  assert.throws(()=>service(`select public.orl_ic_c3_reveal_view(${literal(staff)},${literal(password)},${literal(requestId)},'CLINICAL_VERIFICATION',${literal(generation)});`));
  const visible=JSON.parse(sql(`set role anon;select public.orl_get_requests(${literal(wm)});`));
  assert.ok(visible.some(r=>r.id===requestId));assert.doesNotMatch(JSON.stringify(visible),/010203-04-5678|A1234567/);
  const staffSchedule=JSON.parse(sql(`set role anon;select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.orl_get_schedule(${literal(staff)},2098,1) s;`));
  assert.ok(staffSchedule.length>0);
  assert.equal(staffSchedule.flatMap(s=>s.slots||[]).some(s=>s.type==='SPECIAL'),false);
  assert.throws(()=>service(`select public.orl_ic_c3_reveal_view(${literal(wm)},'WRONG',${literal(requestId)},'CLINICAL_VERIFICATION',${literal(generation)});`));
  const revealed=await verifyC3Reveal(JSON.parse(service(`select public.orl_ic_c3_reveal_view(${literal(wm)},${literal(password)},${literal(requestId)},'CLINICAL_VERIFICATION',${literal(generation)});`)),config);
  assert.equal(revealed.patient_ic,raw);
  service(`select public.orl_ic_c3_reveal_commit(${literal(wm)},${literal(password)},${literal(revealed.lease_id)},${literal(requestId)},${literal(generation)},${literal(revealed.identity_updated_at)});`);
  assert.equal(sql(`select patient_ic from public.orl_requests where id=${literal(requestId)}`),'010203-**-****');
  assert.equal(sql(`select count(*) from public.orl_audit_log where action='IC_FULL_REVEAL' and details like '%'||${literal(raw)}||'%'`),'0');
  service(`select public.orl_ic_c3_reveal_view(${literal(wm)},${literal(password)},${literal(secondId)},'CLINICAL_VERIFICATION',${literal(generation)});`);
  assert.equal(service(`select public.orl_ic_c1_remove(${literal(wm)},${literal(password)},'REQUEST',${literal(requestId)},${literal(generation)},array[${literal(requestId)}::uuid]);`),'1');
  assert.equal(sql(`select count(*) from orl_private.c3_reveal_lease where request_id=${literal(requestId)}`),'0');
  assert.equal(sql(`select count(*) from orl_private.c3_reveal_lease where request_id=${literal(secondId)}`),'1');
  assert.equal(sql(`select count(*) from public.orl_audit_log where action='IC_FULL_REVEAL' and record_id=${literal(requestId)}`),'1');
  const imported=JSON.parse(service(`select public.orl_ic_c1_import(${literal(wm)},${literal(password)},${json(backup)});`));
  assert.equal(imported.identities,2);
  assert.notEqual(sql('select generation from orl_private.c1_restore_generation where singleton'),generation);
  assert.throws(()=>service(`select public.orl_ic_c1_create(${literal(wm)},${literal(crypto.randomUUID())},${json(data)},null,null,${literal(generation)});`));
  assert.equal(sql('select count(*) from orl_private.c3_reveal_lease'),'0');
  assert.equal(sql("select (orl_private.c6_stats()->>'plaintext_rows')::int"),'0');
  assert.equal(sql("select (orl_private.c6_stats()->>'identity_mismatch')::int"),'0');
  for(const signature of ['public.orl_ic_c1_import(uuid,text,jsonb)','public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean)']){
    const body=sql(`select prosrc from pg_proc where oid='${signature}'::regprocedure`);
    for(const [statement] of body.matchAll(/delete from [^;]+;/g))assert.match(statement,/\bwhere\b/);
  }
  const auditFile=fileURLToPath(new URL('../../security/release/audit-c7.sql',import.meta.url));
  const audit=JSON.parse(execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',auditFile],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());
  for(const [key,value] of Object.entries(audit))assert.equal(value,['plaintext_rows','identity_mismatch'].includes(key)?0:true,key);
  const restoredGeneration=sql('select generation from orl_private.c1_restore_generation where singleton');
  const finalized=JSON.parse(sql(`select public.orl_ic_c1_finalize_full_dump_recovery(${literal(restoredGeneration)},'ROTATE C1 GENERATION AND INVALIDATE SESSIONS',true);`));
  assert.equal(finalized.status,'READY');assert.equal(sql('select count(*) from public.orl_sessions'),'0');
  }
});
