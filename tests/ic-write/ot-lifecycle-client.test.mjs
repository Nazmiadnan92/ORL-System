import test from 'node:test';
import assert from 'node:assert/strict';
import {createIcTransport,createIcRpcRouter} from '../../docs/ic-client.mjs';

const owner='11111111-1111-4111-8111-111111111111',rid='22222222-2222-4222-8222-222222222222';
const slot='33333333-3333-4333-8333-333333333333',generation='44444444-4444-4444-8444-444444444444';
const args={p_session_token:owner,p_request_id:rid,p_slot_id:slot,p_action:'HOLD',p_reason:'Synthetic reason',p_generation:generation,p_expected_version:'2026-10-16T01:02:03.123456Z'};
test('lifecycle router retains the exact reviewed version and fixed protected endpoint without identity, refresh or fallback',async()=>{
 let session=owner;const calls=[];
 const send=createIcTransport({baseUrl:'https://synthetic.supabase.co',publishableKey:'synthetic-only',session:()=>session,fetchImpl:async(url,options)=>{
  calls.push({url:String(url),options});const body=JSON.parse(options.body);
  return new Response(JSON.stringify({result:{request_id:rid,action:body.action,status:body.action==='COMPLETE'?'COMPLETED':'SCHEDULED',ot_hold:body.action==='HOLD'}}));
 }});
 const route=createIcRpcRouter({session:()=>session,send,legacy:()=>assert.fail('No legacy fallback')});
 for(const action of ['HOLD','RELEASE_HOLD','COMPLETE']){
  const result=await route('orl_ic_ot_lifecycle',{...args,p_action:action,p_reason:action==='COMPLETE'?'':args.p_reason});
  assert.equal(result.action,action);const {url,options}=calls.at(-1),body=JSON.parse(options.body);
  assert.equal(url,'https://synthetic.supabase.co/functions/v1/ic-requests');assert.equal(options.headers['x-orl-session'],owner);
  assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  assert.deepEqual(body,{operation:'OT_LIFECYCLE',request_id:rid,slot_id:slot,action,reason:action==='COMPLETE'?'':args.p_reason,generation,expected_version:args.p_expected_version});
 }
 assert.equal(calls.length,3);
 for(const change of [{p_session_token:rid},{p_request_id:'bad'},{p_slot_id:null},{p_generation:null},{p_expected_version:''},{p_action:'DELETE'},{p_reason:' '},{p_reason:'x'.repeat(4097)},{p_action:'COMPLETE'}]){
  await assert.rejects(route('orl_ic_ot_lifecycle',{...args,...change}));
 }
 assert.equal(calls.length,3);
 session=rid;await assert.rejects(route('orl_ic_ot_lifecycle',args),/sign in/);assert.equal(calls.length,3);
});

test('lifecycle uncertain/malformed replies never retry or return success across a changed login',async()=>{
 let session=owner,reply={result:{request_id:rid,action:'HOLD',status:'SCHEDULED',ot_hold:true}},fail=false,change=false;let sent=0;
 const route=createIcRpcRouter({session:()=>session,legacy:()=>assert.fail('No fallback'),send:async()=>{sent++;if(fail)throw Error('Uncertain');if(change)session=rid;return reply}});
 for(const result of [null,{}, {...reply.result,request_id:slot},{...reply.result,action:'COMPLETE'},{...reply.result,status:'APPROVED'},{...reply.result,status:'COMPLETED'},{...reply.result,ot_hold:false}]){
  reply={result};const before=sent;await assert.rejects(route('orl_ic_ot_lifecycle',args),/not confirmed/);assert.equal(sent,before+1);
 }
 fail=true;const before=sent;await assert.rejects(route('orl_ic_ot_lifecycle',args),/Uncertain/);assert.equal(sent,before+1);
 fail=false;change=true;reply={result:{request_id:rid,action:'HOLD',status:'SCHEDULED',ot_hold:true}};await assert.rejects(route('orl_ic_ot_lifecycle',args),/not confirmed/);
});

test('hold read tags the server snapshot generation and owner; invalid and stale reads fail closed',async()=>{
 let session=owner,view={generation,requests:[{id:rid,slot_id:slot,_ic_edit_version:args.p_expected_version,ot_hold:true}]},changed=false;const calls=[];
 const route=createIcRpcRouter({session:()=>session,send:()=>assert.fail('No generation refresh'),legacy:async(name,body)=>{calls.push({name,body});if(changed)session=rid;return view}});
 const rows=await route('orl_get_ot_hold_requests',{p_session_token:owner});
 assert.equal(rows[0]._ic_generation,generation);assert.equal(rows[0]._ic_review_owner,owner);assert.equal(rows[0]._ic_edit_version,args.p_expected_version);
 assert.deepEqual(calls[0],{name:'orl_get_ot_hold_requests',body:{p_session_token:owner}});
 for(const bad of [null,{}, {generation,requests:null},{generation:'bad',requests:[]}]){view=bad;await assert.rejects(route('orl_get_ot_hold_requests',{p_session_token:owner}),/Reload/)}
 view={generation,requests:[]};changed=true;await assert.rejects(route('orl_get_ot_hold_requests',{p_session_token:owner}),/Reload/);
});
