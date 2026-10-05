import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';
import {verifyC3Reveal} from '../../supabase/functions/_shared/c1/c3-reveal.mjs';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {createIcTransport,createIcRpcRouter} from '../../docs/ic-client.mjs';

const token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',generation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',leaseId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const updated='2026-10-05T08:00:00.000Z',raw='000101-00-0000';
const randomKey=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'c3-synthetic',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',
  encryptionKeys:{'enc-v1':randomKey()},searchKeys:{'search-v1':randomKey()}};
const req=body=>new Request('https://synthetic.supabase.co/functions/v1/ic-requests',{method:'POST',
  headers:{'x-orl-session':token,'content-type':'application/json',origin:'https://nazmiadnan92.github.io'},body:JSON.stringify(body)});

async function view(){const engine=await createIdentityCrypto(config);return {lease_id:leaseId,request_id:requestId,generation,
  lease_expires_at:new Date(Date.now()+120000).toISOString(),identity_updated_at:updated,
  envelope:await engine.encrypt(raw,requestId),search:await engine.searchHash(raw)}}

test('C3 helper authenticates envelope and search hash before returning plaintext',async()=>{
  const item=await view(),result=await verifyC3Reveal(item,config);
  assert.equal(result.patient_ic,raw);assert.equal(result.request_id,requestId);
  await assert.rejects(()=>verifyC3Reveal({...item,request_id:crypto.randomUUID()},config));
  await assert.rejects(()=>verifyC3Reveal({...item,lease_expires_at:new Date(Date.now()-1000).toISOString()},config));
  await assert.rejects(()=>verifyC3Reveal({...item,search:{...item.search,hash:item.search.hash.replace(/^./,item.search.hash[0]==='A'?'B':'A')}},config));
});

test('C3 gateway is Admin/Webmaster only, purpose/password strict and audits before releasing IC',async()=>{
  let role='STAFF',calls=[],failCommit=false;
  const rpc=async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};calls.push({name,args});
    if(name==='orl_ic_c3_reveal_view')return view();
    if(name==='orl_ic_c3_reveal_commit'){if(failCommit)throw Error('PRIVATE '+raw);return {lease_id:leaseId,request_id:requestId,
      generation,purpose:'CLINICAL_VERIFICATION',expires_at:new Date(Date.now()+60000).toISOString()}}
    throw Error('unexpected')};
  const gateway=createIcGateway({enabled:true,origins:['https://nazmiadnan92.github.io'],rpc,cryptoConfig:()=>config,rateLimit:async()=>true});
  const body={operation:'REVEAL',password:'SYNTHETIC',request_id:requestId,purpose:'CLINICAL_VERIFICATION',generation};
  assert.equal((await gateway(req(body))).status,403);assert.equal(calls.length,0);role='ADMIN';
  for(const bad of [{...body,password:''},{...body,purpose:'CURIOSITY'},{...body,request_id:'bad'},{...body,extra:true}])
    assert.equal((await gateway(req(bad))).status,400);
  let response=await gateway(req(body));assert.equal(response.status,200);assert.equal((await response.json()).result.patient_ic,raw);
  assert.deepEqual(calls.map(x=>x.name),['orl_ic_c3_reveal_view','orl_ic_c3_reveal_commit']);
  failCommit=true;response=await gateway(req(body));assert.equal(response.status,403);const text=await response.text();
  assert.doesNotMatch(text,/000101|PRIVATE/);assert.match(text,/do not retry blindly/i);assert.equal(calls.filter(x=>x.name==='orl_ic_c3_reveal_commit').length,2);
});

test('browser Reveal uses fixed gateway, same session and no legacy fallback',async()=>{
  const calls=[];const send=createIcTransport({baseUrl:'https://synthetic.supabase.co',publishableKey:'sb_publishable_SYNTHETIC',
    session:()=>token,fetchImpl:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return Response.json({result:{request_id:requestId,
      patient_ic:raw,purpose:'PATIENT_IDENTIFICATION',expires_at:new Date(Date.now()+60000).toISOString()}})}});
  const route=createIcRpcRouter({send,session:()=>token,legacy:()=>assert.fail('Reveal cannot use legacy RPC')});
  const result=await route('orl_ic_reveal',{p_session_token:token,p_password:'SYNTHETIC',p_request_id:requestId,
    p_purpose:'PATIENT_IDENTIFICATION',p_generation:generation});
  assert.equal(result.patient_ic,raw);assert.equal(calls[0].body.operation,'REVEAL');assert.equal(calls[0].body.password,'SYNTHETIC');
  for(const bad of [{p_purpose:'CURIOSITY'},{p_password:''},{p_generation:'bad'}])
    await assert.rejects(route('orl_ic_reveal',{p_session_token:token,p_password:'SYNTHETIC',p_request_id:requestId,
      p_purpose:'PATIENT_IDENTIFICATION',p_generation:generation,...bad}),/Reopen/);
  assert.equal(calls.length,1);
});
