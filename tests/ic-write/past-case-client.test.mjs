import test from 'node:test';import assert from 'node:assert/strict';
import {createIcTransport,createIcRpcRouter} from '../../docs/ic-client.mjs';
const owner='11111111-1111-4111-8111-111111111111',slot='22222222-2222-4222-8222-222222222222',rid='33333333-3333-4333-8333-333333333333',generation='44444444-4444-4444-8444-444444444444',sessionId='55555555-5555-4555-8555-555555555555';
const patient={patient_name:'Synthetic Patient',mrn:'TEST-ONLY',age:36,age_months:null,diagnosis:'TEST',surgery:'TEST',doctor:'Synthetic Doctor',specialist:'',sub_specialty:'Gen ORL',phone:'',remark:'',patient_ic:'900101-**-****'};
const view=(mode='EDIT',status='COMPLETED')=>({mode,slot_id:slot,session_id:sessionId,ot_date:'2026-01-01',slot_type:'SPECIAL',slot_number:1,slot_status:mode==='ADD'?'CLOSED':'CONFIRMED',session_status:'CANCELLED',request_id:mode==='ADD'?null:rid,request_status:mode==='ADD'?null:status,ot_hold:false,postpone_count:0,generation,expected_version:mode==='ADD'?null:'2026-01-01T01:02:03.123456Z',snapshot:'a'.repeat(64),patient:mode==='ADD'?null:{...patient}});
const saveArgs=context=>({p_session_token:owner,p_context:context,p_request_id:rid,p_data:{diagnosis:'CORRECTED'},p_reason:'Synthetic correction',p_ic_mode:'KEEP',p_password:'Synthetic-Password'});
test('historical router issues immutable one-shot contexts and only uses fixed protected transport',async()=>{
 const calls=[];let currentView=view();
 const send=createIcTransport({baseUrl:'https://synthetic.supabase.co',publishableKey:'synthetic',session:()=>owner,fetchImpl:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url:String(url),options,body});
  return new Response(JSON.stringify({result:body.operation==='PAST_VIEW'?currentView:{request_id:rid,slot_id:slot,ot_date:currentView.ot_date,status:body.mode==='ADD'?'SCHEDULED':currentView.request_status,updated_at:'2026-10-18T01:01:01Z',mode:body.mode}}));
 }});
 const router=createIcRpcRouter({session:()=>owner,send,legacy:()=>assert.fail('No fallback')});
 for(const [mode,status] of [['EDIT','COMPLETED'],['EDIT','PENDING REVIEW'],['ADD',null]]){
  currentView=view(mode,status);const read=await router('orl_ic_past_case_view',{p_session_token:owner,p_slot_id:slot}),context=read._ic_past_context;
  assert.ok(Object.isFrozen(context));assert.deepEqual(calls.at(-1).body,{operation:'PAST_VIEW',slot_id:slot});
  read.snapshot='b'.repeat(64);read.mode='WRONG';read.request_status='CANCELLED';
  const args=saveArgs(context);if(mode==='ADD'){args.p_ic_mode='SET';args.p_data={patient_name:'Synthetic',patient_ic:'900101-01-1234'}}
  const result=await router('orl_ic_past_case_save',args);assert.equal(result.status,mode==='ADD'?'SCHEDULED':status);
  const call=calls.at(-1);assert.equal(call.url,'https://synthetic.supabase.co/functions/v1/ic-requests');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');assert.equal(call.options.headers['x-orl-session'],owner);
  assert.equal(call.body.mode,mode);assert.equal(call.body.snapshot,'a'.repeat(64));assert.equal(call.body.generation,generation);assert.equal(call.body.expected_version,currentView.expected_version);
  const before=calls.length;await assert.rejects(router('orl_ic_past_case_save',args),/Reload/);assert.equal(calls.length,before,'No duplicate save');
 }
});
test('historical router rejects fabricated, cloned, stale and mutated contexts or lifecycle payloads before sending',async()=>{
 let active=owner,sent=0;const router=createIcRpcRouter({session:()=>active,legacy:()=>assert.fail('No fallback'),send:async()=>{sent++;return{result:view()}}});
 const read=await router('orl_ic_past_case_view',{p_session_token:owner,p_slot_id:slot}),args=saveArgs(read._ic_past_context);
 for(const change of [{p_context:{...args.p_context}},{p_context:null},{p_request_id:slot},{p_data:{status:'SCHEDULED'}},{p_data:{postpone_count:'0'}},{p_data:{ot_hold:'false'}},{p_data:{age:36}},{p_data:{patient_ic:'900101-**-****'}},{p_reason:' '},{p_reason:'x'.repeat(2001)},{p_password:''},{p_ic_mode:'SET',p_data:{patient_ic:'900101-**-****'}}])await assert.rejects(router('orl_ic_past_case_save',{...args,...change}));
 assert.equal(sent,1);
 active=rid;await assert.rejects(router('orl_ic_past_case_save',args),/sign in/);await assert.rejects(router('orl_ic_past_case_save',{...args,p_session_token:active}),/Reload/);assert.equal(sent,1);
});
test('uncertain or wrong-target historical result consumes selection, never retries and never returns success',async()=>{
 for(const failure of ['lost','session','date','slot','request','mode','status','version']){
  let active=owner,sent=0;const router=createIcRpcRouter({session:()=>active,legacy:()=>assert.fail('No fallback'),send:async operation=>{
   sent++;if(operation==='PAST_VIEW')return{result:view()};if(failure==='lost')throw Error('Result not confirmed');
   const result={request_id:rid,slot_id:slot,ot_date:'2026-01-01',mode:'EDIT',status:'COMPLETED',updated_at:'2026-10-18T01:01:01Z'};
   if(failure==='session')active=rid;else result[{date:'ot_date',slot:'slot_id',request:'request_id',mode:'mode',status:'status',version:'updated_at'}[failure]]='wrong';return{result};
  }});
  const read=await router('orl_ic_past_case_view',{p_session_token:owner,p_slot_id:slot}),args=saveArgs(read._ic_past_context);
  await assert.rejects(router('orl_ic_past_case_save',args),/not confirmed/);active=owner;await assert.rejects(router('orl_ic_past_case_save',args),/Reload/);assert.equal(sent,2);
 }
});
test('historical view fails closed on malformed or unmasked clinical data and changed sessions',async()=>{
 for(const bad of [null,{}, {...view(),slot_id:rid},{...view(),snapshot:'bad'},{...view(),generation:null},{...view(),patient:{...patient,patient_ic:'900101-01-1234'}},{...view(),patient:{...patient,age:131}},{...view('ADD'),request_id:rid}]){
  const router=createIcRpcRouter({session:()=>owner,legacy:()=>assert.fail('No fallback'),send:async()=>({result:bad})});
  await assert.rejects(router('orl_ic_past_case_view',{p_session_token:owner,p_slot_id:slot}),/verified/);
 }
});
