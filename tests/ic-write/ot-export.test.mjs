import test from 'node:test';import assert from 'node:assert/strict';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';
import {verifyOtExport} from '../../supabase/functions/_shared/c1/ot-export.mjs';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {createIcRpcRouter,createIcTransport} from '../../docs/ic-client.mjs';
const token=crypto.randomUUID(),generation=crypto.randomUUID(),sessionId=crypto.randomUUID(),requestId=crypto.randomUUID(),lease=crypto.randomUUID();
const raw='010203-04-5678',key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'ot-export-unit',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}};
const expiry=()=>new Date(Date.now()+60000).toISOString();
async function view(){
 const engine=await createIdentityCrypto(config);
 return {lease_id:lease,generation,expires_at:expiry(),snapshot:{session:{session_id:sessionId,ot_date:'2030-01-01'},patients:[
  {request_id:requestId,patient_ic:'010203-**-****',patient_name:'Synthetic',mrn:'SYNTHETIC',age:'20',age_months:'0',
   diagnosis:'TEST',surgery:'TEST',sub_specialty:'Gen ORL',envelope:await engine.encrypt(raw,requestId),search:await engine.searchHash(raw)},
  {request_id:crypto.randomUUID(),patient_ic:'',patient_name:'Synthetic Blank',envelope:null,search:null}
 ]}};
}
test('every export IC is authenticated; duplicates, swapped ciphertext, mask/hash mismatches fail closed',async()=>{
 const v=await view(),good=await verifyOtExport(v,config,sessionId,generation);
 assert.equal(good.patients[0].patient_ic,raw);assert.equal(good.patients[1].patient_ic,'');
 assert.ok(!JSON.stringify(good).includes('ciphertext'));assert.equal(v.snapshot.patients[0].patient_ic,'010203-**-****');
 const alterations=[
  x=>x.generation=crypto.randomUUID(),x=>x.expires_at='2000-01-01',x=>x.snapshot.session.session_id=crypto.randomUUID(),
  x=>x.snapshot.patients[0].request_id=crypto.randomUUID(),x=>x.snapshot.patients.push(x.snapshot.patients[0]),
  x=>x.snapshot.patients[0].search.hash='bad',x=>x.snapshot.patients[0].patient_ic='wrong',
  x=>x.snapshot.patients[1].patient_ic='unprotected',x=>x.snapshot.patients[1].search={},
  x=>x.snapshot.patients=[]];
 for(const alter of alterations){const bad=structuredClone(v);alter(bad);await assert.rejects(verifyOtExport(bad,config,sessionId,generation))}
});
test('gateway authorizes roles, verifies crypto, audits before release and never leaks failure values',async()=>{
 let role='STAFF',fail=false,badReceipt=false,tamper=false;const calls=[];
 const gateway=createIcGateway({enabled:true,origins:['https://nazmiadnan92.github.io'],cryptoConfig:()=>config,rateLimit:async()=>true,
  rpc:async(name,args)=>{
   if(name==='orl_ic_c1_authorize')return{role};calls.push(name);
   if(name==='orl_ic_ot_export_view'){const v=await view();if(tamper)v.snapshot.patients[0].search.hash='bad';return v}
   if(name==='orl_ic_ot_export_commit'){
    if(fail)throw Error('PRIVATE '+raw);
    assert.equal(args.p_ot_session_id,sessionId);
    return{lease_id:lease,generation,session_id:sessionId,patient_count:badReceipt?99:2,expires_at:expiry()};
   }throw Error('Unexpected RPC');
  }});
 const body={operation:'OT_EXPORT',password:'SYNTHETIC',session_id:sessionId,generation};
 const run=b=>gateway(new Request('https://synthetic.supabase.co/functions/v1/ic-requests',{method:'POST',
  headers:{'content-type':'application/json','x-orl-session':token,origin:'https://nazmiadnan92.github.io'},body:JSON.stringify(b)}));
 assert.equal((await run(body)).status,403);assert.equal(calls.length,0);
 role='ADMIN';
 for(const bad of [{...body,password:''},{...body,session_id:'bad'},{...body,request_ids:[requestId]}])assert.equal((await run(bad)).status,400);
 for(const allowed of ['ADMIN','WEBMASTER']){
  role=allowed;calls.length=0;const response=await run(body);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).result.patients[0].patient_ic,raw);
  assert.deepEqual(calls,['orl_ic_ot_export_view','orl_ic_ot_export_commit']);
 }
 fail=true;let response=await run(body);assert.equal(response.status,403);assert.ok(!(await response.text()).includes(raw));
 fail=false;badReceipt=true;response=await run(body);assert.equal(response.status,403);assert.ok(!(await response.text()).includes(raw));
 badReceipt=false;tamper=true;calls.length=0;response=await run(body);assert.equal(response.status,403);
 assert.deepEqual(calls,['orl_ic_ot_export_view']);
});
test('browser route uses only protected endpoint and rejects changed session/expired or wrong-target results',async()=>{
 let current=token,change=false,expire=false,wrong=false;
 const send=createIcTransport({baseUrl:'https://synthetic.supabase.co',publishableKey:'sb_publishable_SYNTHETIC',session:()=>current,
  fetchImpl:async(url,init)=>{
   assert.equal(new URL(url).pathname,'/functions/v1/ic-requests');assert.equal(JSON.parse(init.body).operation,'OT_EXPORT');
   const v=await verifyOtExport(await view(),config,sessionId,generation);
   if(change)current=crypto.randomUUID();
   return Response.json({result:{...v,session:{...v.session,session_id:wrong?crypto.randomUUID():sessionId},
    export_id:lease,expires_at:expire?'2000-01-01':expiry()}});
  }});
 const route=createIcRpcRouter({send,session:()=>current,legacy:()=>assert.fail('No legacy fallback')});
 const args={p_session_token:token,p_session_id:sessionId,p_password:'SYNTHETIC',p_generation:generation};
 assert.equal((await route('orl_ic_ot_export',args)).patients[0].patient_ic,raw);
 expire=true;await assert.rejects(route('orl_ic_ot_export',args));expire=false;
 wrong=true;await assert.rejects(route('orl_ic_ot_export',args));wrong=false;
 change=true;await assert.rejects(route('orl_ic_ot_export',args));
});
