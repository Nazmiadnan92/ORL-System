import test from 'node:test';
import assert from 'node:assert/strict';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';
import {createBackendRpc} from '../../supabase/functions/_shared/c1/backend.mjs';
const token='11111111-1111-4111-8111-111111111111',slot='22222222-2222-4222-8222-222222222222',rid='33333333-3333-4333-8333-333333333333',generation='44444444-4444-4444-8444-444444444444',origin='https://synthetic.invalid';
const input={operation:'OT_UNDO_DONE',password:'Synthetic-Password',request_id:rid,slot_id:slot,reason:'Marked Done by mistake',generation,expected_version:'2026-10-18T01:02:03.123456Z'};
const receipt={request_id:rid,slot_id:slot,status:'SCHEDULED',action:'UNDO_DONE',ot_hold:false};
function harness({role='WEBMASTER',result=receipt,failure=false,throttle=true}={}){
 const calls=[];let keys=0;
 const gateway=createIcGateway({enabled:true,origins:[origin],rateLimit:async()=>throttle,cryptoConfig:()=>{keys++;throw Error('Undo Done must not read keys')},rpc:async(name,args)=>{
  calls.push({name,args});if(name==='orl_ic_c1_authorize')return{role};
  if(name==='orl_ic_undo_done'){if(failure)throw Error('SECRET SQL DETAIL '+input.password);return result}
  assert.fail('Unexpected RPC '+name);
 }});
 return{calls,keys:()=>keys,send:async body=>{const response=await gateway(new Request(origin+'/ic-requests',{method:'POST',headers:{origin,'content-type':'application/json','x-orl-session':token},body:JSON.stringify(body)}));return{status:response.status,headers:response.headers,body:await response.json()}}};
}
test('Undo Done requires Webmaster and shared throttling before any mutation or key access',async()=>{
 for(const role of ['STAFF','ADMIN']){const h=harness({role});assert.equal((await h.send(input)).status,403);assert.equal(h.calls.length,1);assert.equal(h.keys(),0)}
 const h=harness({throttle:false});assert.equal((await h.send(input)).status,429);assert.equal(h.calls.length,1);assert.equal(h.keys(),0);
});
test('Undo Done rejects invalid and extra payload fields without any write',async()=>{
 for(const change of [{password:''},{password:null},{password:'x'.repeat(1025)},{request_id:null},{slot_id:'bad'},{generation:null},{expected_version:null},{expected_version:'bad'},{reason:''},{reason:' \n\t '},{reason:'x'.repeat(4097)},{reason:[]},{action:'COMPLETE'},{data:{status:'SCHEDULED'}},{allow_duplicate:true}]){
  const h=harness();assert.equal((await h.send({...input,...change})).status,400,JSON.stringify(change));assert.equal(h.calls.length,1);assert.equal(h.keys(),0);
 }
 for(const key of Object.keys(input).filter(k=>k!=='operation')){const body={...input};delete body[key];const h=harness();assert.equal((await h.send(body)).status,400);assert.equal(h.calls.length,1)}
});
test('Undo Done is one password-checked atomic RPC, with precise selection and a projected nonclinical reply',async()=>{
 const h=harness({result:{...receipt,password:input.password,patient_ic:'900101-01-1234',patient_name:'DO NOT RELEASE',completed_by:'PRIVATE'}}),response=await h.send(input);
 assert.equal(response.status,200);assert.deepEqual(response.body,{result:receipt});assert.equal(response.headers.get('cache-control'),'no-store');
 assert.deepEqual(h.calls.map(x=>x.name),['orl_ic_c1_authorize','orl_ic_undo_done']);assert.equal(h.keys(),0);
 assert.deepEqual(h.calls[1].args,{p_session_token:token,p_password:input.password,p_request_id:rid,p_slot_id:slot,p_reason:input.reason,p_generation:generation,p_expected_version:input.expected_version});
});
test('Undo Done rejects malformed receipts and sanitized failures without retry or fallback',async()=>{
 for(const result of [null,{}, {...receipt,request_id:slot},{...receipt,slot_id:rid},{...receipt,status:'COMPLETED'},{...receipt,action:'COMPLETE'},{...receipt,ot_hold:null}]){
  const h=harness({result});assert.equal((await h.send(input)).status,409);assert.equal(h.calls.filter(x=>x.name==='orl_ic_undo_done').length,1);assert.equal(h.keys(),0);
 }
 const h=harness({failure:true}),response=await h.send(input);assert.equal(response.status,409);assert.doesNotMatch(JSON.stringify(response.body),/SECRET SQL DETAIL|Synthetic-Password/);assert.equal(h.calls.length,2);assert.equal(h.keys(),0);
});
test('Undo Done fixed backend adapter allows only the dedicated RPC and keeps error detail private',async()=>{
 const calls=[],rpc=createBackendRpc({baseUrl:'https://synthetic.supabase.co',secretKey:'sb_secret_SYNTHETIC',fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(receipt))}});
 assert.deepEqual(await rpc('orl_ic_undo_done',{p_session_token:token}),receipt);assert.match(calls[0].url,/\/rest\/v1\/rpc\/orl_ic_undo_done$/);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.cache,'no-store');
 for(const name of ['orl_undo_done','orl_require_webmaster_password','orl_ic_ot_lifecycle_raw'])await assert.rejects(rpc(name,{}),/Unsupported backend operation/);assert.equal(calls.length,1);
 const denied=createBackendRpc({baseUrl:'https://synthetic.supabase.co',secretKey:'sb_secret_SYNTHETIC',fetchImpl:async()=>new Response('PRIVATE SERVER REASON',{status:409})});await assert.rejects(denied('orl_ic_undo_done',{}),/Backend operation unavailable/);
});
