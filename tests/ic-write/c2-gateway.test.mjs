import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIcGateway } from '../../supabase/functions/_shared/c1/gateway.mjs';
import { prepareC2Backfill, verifyC2Identities } from '../../supabase/functions/_shared/c1/c2-maintenance.mjs';
import { createIdentityCrypto, toBase64 } from '../../supabase/functions/_shared/ic-crypto.mjs';

const token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', generation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc', revision='a'.repeat(32), version='2026-10-05T01:02:03.123456Z';
const randomKey=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'c2-synthetic',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',
  encryptionKeys:{'enc-v1':randomKey()},searchKeys:{'search-v1':randomKey()}};
const req=body=>new Request('https://synthetic.supabase.co/functions/v1/ic-requests',{method:'POST',
  headers:{'x-orl-session':token,'content-type':'application/json',origin:'https://nazmiadnan92.github.io'},body:JSON.stringify(body)});

test('C2 helpers encrypt, decrypt and hash every row without returning plaintext',async()=>{
  const row={request_id:requestId,patient_ic:'000101-00-0000',expected_request_updated_at:version};
  const items=await prepareC2Backfill([row],config);
  assert.equal(Object.hasOwn(items[0],'patient_ic'),false);
  const engine=await createIdentityCrypto(config);
  assert.equal(await engine.decrypt(items[0].envelope,requestId),row.patient_ic);
  const verified=await verifyC2Identities([{...row,expected_identity_updated_at:version,
    envelope:items[0].envelope,search:items[0].search}],config);
  assert.deepEqual(verified,[{request_id:requestId,expected_request_updated_at:version,expected_identity_updated_at:version}]);
  const changed={...items[0].envelope,ciphertext:items[0].envelope.ciphertext.replace(/^./,items[0].envelope.ciphertext[0]==='A'?'B':'A')};
  await assert.rejects(()=>verifyC2Identities([{...row,expected_identity_updated_at:version,envelope:changed,search:items[0].search}],config));
});

test('C2 gateway is Webmaster-only, strict, sanitized and never retries uncertain commits',async()=>{
  let role='WEBMASTER',commitCalls=0,failCommit=false;
  const rpc=async(name,args)=>{
    if(name==='orl_ic_c1_authorize')return {role};
    if(name==='orl_ic_c2_status')return {generation,revision,missing_supported:1};
    if(name==='orl_ic_c2_backfill_view')return {generation,revision,items:[{request_id:requestId,
      patient_ic:'000101-00-0000',expected_request_updated_at:version}]};
    if(name==='orl_ic_c2_backfill_commit'){
      commitCalls++;assert.equal(Object.hasOwn(args.p_items[0],'patient_ic'),false);
      if(failCommit)throw Error('PRIVATE RAW 000101-00-0000');
      return {generation,revision:'b'.repeat(32),committed:1};
    }
    throw Error('unexpected '+name);
  };
  const gateway=createIcGateway({enabled:true,origins:['https://nazmiadnan92.github.io'],rpc,
    cryptoConfig:()=>config,rateLimit:async()=>true});
  const status={operation:'C2_STATUS',password:'SYNTHETIC'};
  assert.equal((await gateway(req(status))).status,200);
  role='ADMIN';assert.equal((await gateway(req(status))).status,403);role='WEBMASTER';
  assert.equal((await gateway(req({...status,extra:true}))).status,400);
  const body={operation:'C2_BACKFILL',password:'SYNTHETIC',generation,revision};
  assert.equal((await gateway(req(body))).status,200);assert.equal(commitCalls,1);
  failCommit=true;const response=await gateway(req(body));
  assert.equal(response.status,503);assert.equal(commitCalls,2);
  assert.doesNotMatch(await response.text(),/000101|PRIVATE/);
});
