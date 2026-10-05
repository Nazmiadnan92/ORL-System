import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIdentityCrypto, toBase64 } from '../../supabase/functions/_shared/ic-crypto.mjs';
import { prepareC2Backfill, verifyC2Identities } from '../../supabase/functions/_shared/c1/c2-maintenance.mjs';

const randomKey=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'c2-integration-synthetic',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',
  encryptionKeys:{'enc-v1':randomKey()},searchKeys:{'search-v1':randomKey()}};
const password='SYNTHETIC-C2-PASSWORD';

test('migration 048 backfills and cryptographically reconciles every legacy identity',async()=>{
  assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
  const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
  const sql=query=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:query,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  const literal=value=>value==null?'NULL':"'"+String(value).replaceAll("'","''")+"'";
  const json=value=>literal(JSON.stringify(value))+'::jsonb';
  const service=query=>sql('set role service_role; '+query);
  const wm=sql("select id from public.orl_users where username='c1_webmaster'");
  assert.match(wm,/^[0-9a-f-]{36}$/i);
  sql(`update public.orl_users set password_hash=extensions.crypt(${literal(password)},extensions.gen_salt('bf',4)) where id=${literal(wm)};
    truncate public.orl_requests,orl_private.request_identity,orl_private.c1_creation_receipts cascade;
    delete from public.orl_audit_log;`);
  const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
  const engine=await createIdentityCrypto(config), ids=[];
  for(let n=0;n<5;n++){
    const id=crypto.randomUUID(),raw=`00010${n}-00-000${n}`;
    const data={patient_ic:raw,age:'26',age_months:'0',patient_name:`Synthetic C2 ${n}`,mrn:`C2-${n}-${id}`,
      surgery:'TEST PROCEDURE',diagnosis:'TEST',doctor:'Test Doctor',specialist:'Test Specialist',
      sub_specialty:'Gen ORL',phone:'0',remark:''};
    const result=service(`select public.orl_ic_c1_create(${literal(wm)},${literal(id)},${json(data)},
      ${json(await engine.encrypt(raw,id))},${json(await engine.searchHash(raw))},${literal(generation)});`);
    assert.equal(result,id);ids.push(id);
  }
  sql(`delete from orl_private.request_identity where request_id in (${ids.map(literal).join(',')})`);
  const migration=fileURLToPath(new URL('../../supabase/048_ic_c2_controlled_legacy_backfill.sql',import.meta.url));
  execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',migration],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  assert.throws(()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',migration],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  for(const role of ['anon','authenticated'])assert.equal(sql(`select has_function_privilege('${role}','public.orl_ic_c2_status(uuid,text)','EXECUTE')`),'f');
  assert.equal(sql("select has_table_privilege('service_role','orl_private.c2_verified_identity','SELECT,INSERT,UPDATE,DELETE')"),'f');
  const status=()=>JSON.parse(service(`select public.orl_ic_c2_status(${literal(wm)},${literal(password)});`));
  let state=status();assert.equal(state.missing_supported,5);assert.equal(state.missing_unsupported,0);
  const staleRevision=state.revision;
  const view=JSON.parse(service(`select public.orl_ic_c2_backfill_view(${literal(wm)},${literal(password)},${literal(generation)},${literal(state.revision)});`));
  const items=await prepareC2Backfill(view.items,config);
  const committed=JSON.parse(service(`select public.orl_ic_c2_backfill_commit(${literal(wm)},${literal(password)},
    ${literal(generation)},${literal(state.revision)},${json(items)});`));
  assert.equal(committed.committed,5);assert.notEqual(committed.revision,staleRevision);
  assert.throws(()=>service(`select public.orl_ic_c2_backfill_view(${literal(wm)},${literal(password)},${literal(generation)},${literal(staleRevision)});`));
  state=status();assert.equal(state.complete,true);assert.equal(state.protected_nonblank,5);
  const run=JSON.parse(service(`select public.orl_ic_c2_verify_start(${literal(wm)},${literal(password)},
    ${literal(generation)},${literal(state.revision)});`));
  let verify=JSON.parse(service(`select public.orl_ic_c2_verify_view(${literal(wm)},${literal(password)},
    ${literal(generation)},${literal(run.run_id)});`));
  const receipts=await verifyC2Identities(verify.items,config);
  const progress=JSON.parse(service(`select public.orl_ic_c2_verify_commit(${literal(wm)},${literal(password)},
    ${literal(generation)},${literal(run.run_id)},${json(receipts)});`));
  assert.equal(progress.remaining,0);assert.equal(progress.verified,5);
  const complete=JSON.parse(service(`select public.orl_ic_c2_finalize(${literal(wm)},${literal(password)},
    ${literal(generation)},${literal(run.run_id)});`));
  assert.equal(complete.status,'COMPLETED');assert.equal(complete.verified,5);
  assert.equal(sql("select count(*) from public.orl_requests where patient_ic<>''"),'5');
  assert.equal(sql("select count(*) from public.orl_audit_log where details ~ '[0-9]{6}-[0-9]{2}-[0-9]{4}'"),'0');
  assert.throws(()=>service(`select public.orl_ic_c2_finalize(${literal(wm)},${literal(password)},${literal(generation)},${literal(run.run_id)});`));
});
