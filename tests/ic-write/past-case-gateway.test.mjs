import test from 'node:test';import assert from 'node:assert/strict';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {createBackendRpc} from '../../supabase/functions/_shared/c1/backend.mjs';
const token='11111111-1111-4111-8111-111111111111',slot='22222222-2222-4222-8222-222222222222',rid='33333333-3333-4333-8333-333333333333',generation='44444444-4444-4444-8444-444444444444',sessionId='55555555-5555-4555-8555-555555555555',origin='https://synthetic.invalid';
const patient={patient_name:'Synthetic',mrn:'TEST',age:36,age_months:null,diagnosis:'TEST',surgery:'TEST',doctor:'Synthetic',specialist:'',sub_specialty:'Gen ORL',phone:'',remark:'',patient_ic:'900101-**-****'};
const view={mode:'EDIT',slot_id:slot,session_id:sessionId,ot_date:'2026-01-01',slot_type:'MAIN',slot_number:1,slot_status:'CONFIRMED',session_status:'ACTIVE',request_id:rid,request_status:'COMPLETED',ot_hold:false,postpone_count:0,generation,expected_version:'2026-01-01T01:02:03.123456Z',snapshot:'a'.repeat(64),patient};
const input={operation:'PAST_SAVE',mode:'EDIT',slot_id:slot,request_id:rid,data:{diagnosis:'CORRECTED'},reason:'Synthetic correction',ic_mode:'KEEP',password:'Synthetic-Password',generation,snapshot:view.snapshot,expected_version:view.expected_version};
const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'synthetic-past-case',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}};
function harness({role='WEBMASTER',pass=true,failure=false,read=view,saveResult}={}){
 const calls=[];let keys=0;const gateway=createIcGateway({enabled:true,origins:[origin],rateLimit:async()=>true,cryptoConfig:()=>{keys++;return config},rpc:async(name,args)=>{
  calls.push({name,args});if(name==='orl_ic_c1_authorize')return{role};if(name==='orl_ic_c1_check_password')return pass;
  if(name==='orl_ic_past_case_view')return read;
  if(name==='orl_ic_past_case_save'){if(failure)throw Error('SECRET SQL DETAIL');return saveResult||{request_id:rid,slot_id:slot,ot_date:'2026-01-01',mode:args.p_mode,status:args.p_mode==='ADD'?'SCHEDULED':'COMPLETED',updated_at:'2026-10-18T01:01:01Z'}}
  assert.fail('Unexpected RPC '+name);
 }});
 return{calls,keys:()=>keys,send:async body=>{const response=await gateway(new Request(origin+'/ic-requests',{method:'POST',headers:{origin,'Content-Type':'application/json','x-orl-session':token},body:JSON.stringify(body)}));return{status:response.status,body:await response.json()}}};
}
test('historical operations are Webmaster-only and password-checked before key access or mutation',async()=>{
 for(const role of ['STAFF','ADMIN'])for(const body of [input,{operation:'PAST_VIEW',slot_id:slot}]){
  const h=harness({role});assert.equal((await h.send(body)).status,403);assert.deepEqual(h.calls.map(x=>x.name),['orl_ic_c1_authorize']);assert.equal(h.keys(),0);
 }
 const h=harness({pass:false});assert.equal((await h.send({...input,ic_mode:'SET',data:{patient_ic:'900101011234'}})).status,403);assert.equal(h.keys(),0);assert.equal(h.calls.length,2);
});
test('historical gateway rejects extra lifecycle fields, invalid reasons, snapshots and identity modes without writes',async()=>{
 for(const change of [{mode:'DELETE'},{slot_id:'bad'},{request_id:null},{snapshot:'bad'},{generation:null},{expected_version:null},{password:''},{reason:' '},{reason:'x'.repeat(2001)},{data:{status:'COMPLETED'}},{data:{postpone_count:'1'}},{data:{ot_hold:'false'}},{data:{age:36}},{data:{patient_ic:'MASKED'}},{mode:'ADD',expected_version:null},{extra:'unexpected'}]){
  const h=harness();assert.equal((await h.send({...input,...change})).status,400,JSON.stringify(change));assert.equal(h.calls.length,1);assert.equal(h.keys(),0);
 }
});
test('historical KEEP reads no keys; SET protects identifier against the exact request ID and keeps it out of replies',async()=>{
 const h=harness();const kept=await h.send(input);assert.equal(kept.status,200);assert.equal(h.keys(),0);
 const p=h.calls.at(-1).args;assert.equal(p.p_ic_mode,'KEEP');assert.equal(p.p_envelope,null);assert.equal(p.p_search,null);assert.deepEqual(p.p_data,input.data);assert.equal(p.p_password,input.password);assert.equal(p.p_snapshot,input.snapshot);
 const engine=await createIdentityCrypto(config),raw='900101-01-1234';
 for(const mode of ['ADD','EDIT']){
  const current=harness(),result=await current.send({...input,mode,expected_version:mode==='ADD'?null:input.expected_version,ic_mode:'SET',data:{...input.data,patient_ic:raw}});
  assert.equal(result.status,200);const saved=current.calls.at(-1).args;assert.equal(await engine.decrypt(saved.p_envelope,rid),raw);assert.deepEqual(saved.p_search,await engine.searchHash(raw));
  assert.equal(result.body.result.status,mode==='ADD'?'SCHEDULED':'COMPLETED');assert.ok(!JSON.stringify(result.body).includes(raw));assert.equal(current.keys(),1);
 }
 const blank=harness();assert.equal((await blank.send({...input,mode:'ADD',expected_version:null,ic_mode:'SET',data:{patient_ic:''}})).status,200);assert.equal(blank.calls.at(-1).args.p_envelope,null);
});
test('historical view projects masked fields only and no key access; malformed source fails closed',async()=>{
 const pending=harness({read:{...view,request_status:'PENDING REVIEW',slot_status:'RESERVED',patient:{...patient,age:null,age_months:null}},saveResult:{request_id:rid,slot_id:slot,ot_date:view.ot_date,mode:'EDIT',status:'PENDING REVIEW',updated_at:'2026-10-18T01:01:01Z'}});
 assert.equal((await pending.send({operation:'PAST_VIEW',slot_id:slot})).body.result.request_status,'PENDING REVIEW');
 assert.equal((await pending.send(input)).body.result.status,'PENDING REVIEW');
 const h=harness({read:{...view,envelope:'NEVER RELEASE',patient:{...patient,secret:'NEVER RELEASE'}}});const result=await h.send({operation:'PAST_VIEW',slot_id:slot});assert.equal(result.status,200);assert.equal(h.keys(),0);assert.ok(!JSON.stringify(result.body).includes('NEVER RELEASE'));
 for(const read of [null,{}, {...view,slot_id:rid},{...view,snapshot:null},{...view,patient:{...patient,patient_ic:'900101-01-1234'}}]){
  const current=harness({read});assert.equal((await current.send({operation:'PAST_VIEW',slot_id:slot})).status,409);assert.equal(current.keys(),0);
 }
});
test('historical uncertain saves are sanitized and never retried; backend only exposes the two fixed RPCs',async()=>{
 const h=harness({failure:true});const result=await h.send(input);assert.equal(result.status,409);assert.doesNotMatch(JSON.stringify(result.body),/SECRET SQL DETAIL|Synthetic-Password/);assert.equal(h.calls.filter(x=>x.name==='orl_ic_past_case_save').length,1);
 const calls=[],rpc=createBackendRpc({baseUrl:'https://synthetic.supabase.co',secretKey:'sb_secret_SYNTHETIC',fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return new Response('{}')}});
 for(const name of ['orl_ic_past_case_view','orl_ic_past_case_save'])await rpc(name,{p_session_token:token});
 await assert.rejects(rpc('orl_past_case_snapshot',{}),/Unsupported/);assert.equal(calls.length,2);assert.ok(calls.every(x=>x.options.redirect==='error'&&x.options.cache==='no-store'));
});
