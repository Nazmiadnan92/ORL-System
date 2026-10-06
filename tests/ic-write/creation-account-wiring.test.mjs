import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import * as clientModule from '../../docs/ic-client.mjs';

const app=readFileSync(new URL('../../docs/app.js',import.meta.url),'utf8');
const bootstrap=app.slice(app.indexOf('let protectedIcClientPromise;'),app.indexOf('async function rpc('))
 .replace(/import\('\.\/ic-client\.mjs\?v=\d+'\)/,'Promise.resolve(clientModule)');
const account='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',second='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const session='cccccccc-cccc-4ccc-8ccc-cccccccccccc',generation='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const request='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',slot='ffffffff-ffff-4fff-8fff-ffffffffffff';
const storageKey=id=>'orl-pending-create:synthetic.invalid:'+id;

function harness(profile){
 const entries=new Map(),calls=[],locks=[];
 const storage={getItem:k=>entries.get(k)??null,setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
 const module={...clientModule,createIcTransport:()=>async(op,payload)=>{
  calls.push({op,payload});
  if(op==='PREPARE_CREATE')return {generation};
  if(op==='CREATE')return {request_id:payload.request_id};
  if(op==='RESOLVE_CREATE')return {request_id:payload.request_id,outcome:'CREATED',status:'DRAFT',assigned:false};
  if(op==='CONFIRM')return {result:'CONFIRMED'};
  if(op==='ASSIGN')return {result:'CONFIRMED'};
  assert.fail('Unexpected operation '+op);
 },createPendingCreation:options=>clientModule.createPendingCreation({...options,newId:()=>request})};
 const ctx=vm.createContext({clientModule:module,user:profile,token:session,URL,
  cfg:{icProtectionEnabled:true,supabaseUrl:'https://synthetic.invalid'},localStorage:storage,
  navigator:{locks:{request:async(key,options,callback)=>{locks.push(key);return callback({name:key})}}},
  legacyRpc:()=>assert.fail('No legacy write')});
 vm.runInContext(bootstrap,ctx);
 return {ctx,entries,calls,locks};
}

test('login and restored account contracts expose user_id, not id',()=>{
 const sql=readFileSync(new URL('../../supabase/044_required_password_change.sql',import.meta.url),'utf8');
 for(const name of ['orl_login','orl_current_user']){
  const fields=sql.match(new RegExp('create function public\\.'+name+'\\([^]*?returns table \\(([^]*?)\\)'))[1];
  assert.match(fields,/\buser_id uuid/);assert.doesNotMatch(fields,/(?:^|\n)\s*id uuid/);
 }
});

for(const role of ['WEBMASTER','ADMIN','STAFF'])for(const restored of [false,true]){
 test(`${role}: ${restored?'restored':'fresh login'} actual account shape can create, confirm and assign`,async()=>{
  const profile={user_id:account,username:'synthetic',display_name:'Synthetic',role,must_change_password:false,
   ...(restored?{}:{session_token:session})};
  const h=harness(profile),client=await h.ctx.protectedIcClient();
  assert.equal(client.creation.pending(),null);
  const id=await client.route('orl_create_request',{p_session_token:session,p_data:{patient_name:'Synthetic',patient_ic:'SYNTHETIC'}});
  assert.equal(id,request);assert.equal(h.entries.get(storageKey(account)),request);
  await client.route('orl_confirm_request',{p_session_token:session,p_request_id:id});
  await client.route('orl_assign_slot',{p_session_token:session,p_request_id:id,p_slot_id:slot,p_slot_generation:generation});
  assert.equal(h.entries.size,0);assert.deepEqual(h.calls.map(x=>x.op),['PREPARE_CREATE','CREATE','CONFIRM','ASSIGN']);
  assert.ok(h.locks.every(key=>key===storageKey(account)));
 });
}

test('pending recovery stays isolated by user_id across account changes',async()=>{
 const h=harness({user_id:account,id:second,role:'WEBMASTER'}),client=await h.ctx.protectedIcClient();
 h.entries.set(storageKey(account),request);
 assert.equal(client.creation.pending(),request);
 const recovered=await client.creation.resolve();assert.equal(recovered.request_id,request);
 h.ctx.user={user_id:second,role:'WEBMASTER'};h.ctx.token=second;
 assert.equal(client.creation.pending(),null);assert.equal(h.entries.get(storageKey(account)),request);
 h.ctx.user={user_id:account,role:'WEBMASTER'};h.ctx.token=session;
 assert.equal(client.creation.pending(),request);
 assert.ok(!h.calls.some(x=>x.op==='CREATE'));
});

test('missing account identity and mismatched session remain blocked before writes',async()=>{
 const h=harness({id:account,role:'WEBMASTER'}),client=await h.ctx.protectedIcClient();
 assert.throws(()=>client.creation.pending(),/Please sign in again/);
 await assert.rejects(client.route('orl_create_request',{p_session_token:session,p_data:{}}),/Please sign in again/);
 h.ctx.user={user_id:account,role:'WEBMASTER'};
 await assert.rejects(client.route('orl_create_request',{p_session_token:second,p_data:{}}),/Please sign in again/);
 h.ctx.user=null;assert.throws(()=>client.creation.pending(),/Please sign in again/);
 assert.equal(h.entries.size,0);assert.equal(h.calls.length,0);
});
