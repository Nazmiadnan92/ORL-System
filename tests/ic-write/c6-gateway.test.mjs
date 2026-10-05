import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {maskIdentityDisplay,prepareC6Backup,verifyIdentityBackup} from '../../supabase/functions/_shared/c1/compatibility.mjs';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';
import {createIcRpcRouter} from '../../docs/ic-client.mjs';

const token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',generation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const runId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',requestId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const raw='010203-04-5678',randomKey=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'c6-synthetic',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',
  encryptionKeys:{'enc-v1':randomKey()},searchKeys:{'search-v1':randomKey()}};
const req=body=>new Request('https://synthetic.supabase.co/functions/v1/ic-requests',{method:'POST',
  headers:{'x-orl-session':token,'content-type':'application/json',origin:'https://nazmiadnan92.github.io'},body:JSON.stringify(body)});

test('C6 backup conversion retains only display mask outside authenticated ciphertext',async()=>{
  const engine=await createIdentityCrypto(config),identity={request_id:requestId,envelope:await engine.encrypt(raw,requestId),search:await engine.searchHash(raw)};
  const backup={format:'ORLOMS_BACKUP',version:2,identity_format:'ORL_IC_SHADOW_V1',creation_receipt_format:'ORL_CREATE_RECEIPTS_V1',
    creation_receipts:[],users:[],settings:[],holidays:[],ot_sessions:[],ot_slots:[],audit_log:[],
    requests:[{id:requestId,patient_ic:raw,ic_protected:true,creation_tracked:false}],identities:[identity]};
  const safe=await prepareC6Backup(backup,config);
  assert.equal(safe.version,3);assert.equal(safe.plaintext_removed,true);assert.equal(safe.requests[0].patient_ic,'010203-**-****');
  assert.doesNotMatch(JSON.stringify(safe),/010203-04-5678/);assert.equal((await verifyIdentityBackup(safe,config)).version,3);
  assert.equal(maskIdentityDisplay('A1234567'),'********4567');
});

test('C6 gateway search hashes exact identity and cutover is strict Webmaster-only',async()=>{
  let role='STAFF',calls=[];
  const rpc=async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};calls.push({name,args});
    if(name==='orl_ic_c6_find_patient')return [{id:requestId,patient_ic:'010203-**-****'}];
    if(name==='orl_ic_c6_status')return {plaintext_rows:1,generation};
    if(name==='orl_ic_c6_cutover')return {status:'COMPLETED',plaintext_rows:0,generation};throw Error('unexpected')};
  const gateway=createIcGateway({enabled:true,origins:['https://nazmiadnan92.github.io'],rpc,cryptoConfig:()=>config,rateLimit:async()=>true});
  let response=await gateway(req({operation:'SEARCH',search:raw}));assert.equal(response.status,200);
  assert.equal(calls[0].name,'orl_ic_c6_find_patient');assert.equal(Object.hasOwn(calls[0].args,'patient_ic'),false);
  assert.notEqual(calls[0].args.p_search_hash,raw);assert.equal(calls[0].args.p_search_key_id,'search-v1');
  response=await gateway(req({operation:'C6_CUTOVER',password:'SYNTHETIC',generation,run_id:runId}));assert.equal(response.status,403);
  role='WEBMASTER';response=await gateway(req({operation:'C6_CUTOVER',password:'SYNTHETIC',generation,run_id:runId}));
  assert.equal(response.status,200);assert.equal((await response.json()).result.status,'COMPLETED');
});

test('browser patient search uses Edge only and never legacy IC search',async()=>{
  let legacy=0;const send=async(operation,payload)=>{assert.equal(operation,'SEARCH');assert.equal(payload.search,raw);return {result:[]}};
  const route=createIcRpcRouter({send,session:()=>token,legacy:async()=>{legacy++;return[]}});
  assert.deepEqual(await route('orl_find_patient_search',{p_session_token:token,p_search:raw}),[]);assert.equal(legacy,0);
});
