import test from 'node:test';
import assert from 'node:assert/strict';
import {createIcTransport,createIcRpcRouter} from '../../docs/ic-client.mjs';

const owner='11111111-1111-4111-8111-111111111111',rid='22222222-2222-4222-8222-222222222222';
const slot='33333333-3333-4333-8333-333333333333',generation='44444444-4444-4444-8444-444444444444';
const args={p_session_token:owner,p_password:'Synthetic-password',p_request_id:rid,p_slot_id:slot,p_reason:'  Synthetic mistaken completion  ',p_generation:generation,p_expected_version:'2026-10-18T01:02:03.123456Z'};
const success=hold=>({request_id:rid,slot_id:slot,status:'SCHEDULED',action:'UNDO_DONE',ot_hold:hold});

test('Undo Done uses the dedicated protected endpoint, exact original context and trimmed mandatory reason/password',async()=>{
  for(const hold of [true,false]){
    const calls=[];
    const send=createIcTransport({baseUrl:'https://synthetic.supabase.co',publishableKey:'synthetic-only',session:()=>owner,fetchImpl:async(url,options)=>{
      calls.push({url:String(url),options});return new Response(JSON.stringify({result:{...success(hold),unrelated:'discard'}}));
    }});
    const route=createIcRpcRouter({session:()=>owner,send,legacy:()=>assert.fail('No legacy fallback')});
    assert.deepEqual(await route('orl_ic_undo_done',{...args,p_action:'DO_NOT_FORWARD',patient_ic:'DO_NOT_FORWARD'}),success(hold));
    assert.equal(calls.length,1);const {url,options}=calls[0];
    assert.equal(url,'https://synthetic.supabase.co/functions/v1/ic-requests');assert.equal(options.headers['x-orl-session'],owner);
    assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
    assert.deepEqual(JSON.parse(options.body),{operation:'OT_UNDO_DONE',password:args.p_password,request_id:rid,slot_id:slot,reason:args.p_reason.trim(),generation,expected_version:args.p_expected_version});
  }
});

test('Undo Done rejects missing/stale context and invalid credentials or reason before dispatch',async()=>{
  let sent=0,session=owner;
  const route=createIcRpcRouter({session:()=>session,legacy:()=>assert.fail('No fallback'),send:async()=>{sent++;return {result:success(false)}}});
  for(const change of [{p_session_token:rid},{p_request_id:'bad'},{p_slot_id:null},{p_generation:null},{p_expected_version:''},{p_reason:null},{p_reason:' '},{p_reason:'x'.repeat(4097)},{p_password:null},{p_password:''},{p_password:'x'.repeat(1025)}]){
    await assert.rejects(route('orl_ic_undo_done',{...args,...change}));
  }
  assert.equal(sent,0);session=rid;await assert.rejects(route('orl_ic_undo_done',args),/sign in/);assert.equal(sent,0);
});

test('Undo Done failures and malformed responses cannot confirm success or trigger automatic retry',async()=>{
  for(const result of [null,{}, {...success(false),request_id:slot},{...success(false),slot_id:rid},{...success(false),action:'COMPLETE'},{...success(false),status:'COMPLETED'},{...success(false),status:'APPROVED'},{...success(false),ot_hold:null}]){
    let sent=0;const route=createIcRpcRouter({session:()=>owner,legacy:()=>assert.fail('No fallback'),send:async()=>{sent++;return {result}}});
    await assert.rejects(route('orl_ic_undo_done',args),/not confirmed/);assert.equal(sent,1);
  }
  let sent=0;
  const route=createIcRpcRouter({session:()=>owner,legacy:()=>assert.fail('No fallback'),send:async()=>{sent++;throw Error('Synthetic uncertain result')}});
  await assert.rejects(route('orl_ic_undo_done',args),/uncertain/);assert.equal(sent,1);
  let session=owner;
  const changed=createIcRpcRouter({session:()=>session,legacy:()=>assert.fail('No fallback'),send:async()=>{sent++;session=rid;return {result:success(false)}}});
  await assert.rejects(changed('orl_ic_undo_done',args),/not confirmed/);assert.equal(sent,2);
});
