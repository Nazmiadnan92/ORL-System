import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {createPendingCreation,createIcRpcRouter} from '../../docs/ic-client.mjs';

const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('creation uses the prepared generation exactly; bad preparation retains reference but never submits clinical data',async()=>{
  const store=storage(),calls=[];
  const manager=make(store,()=>assert.fail('unexpected'),{send:async(op,payload)=>{
    calls.push({op,payload});return op==='PREPARE_CREATE'?{generation:id}:{request_id:id};
  }});
  await manager.create({patient_ic:'SYNTHETIC'});
  assert.deepEqual(calls.map(c=>c.op),['PREPARE_CREATE','CREATE']);
  assert.deepEqual(calls[0].payload,{});
  assert.equal(calls[1].payload.generation,id);
  const broken=make(storage(),()=>assert.fail('unexpected'),{send:async(op)=>{
    assert.equal(op,'PREPARE_CREATE');return {generation:'invalid'};
  }});
  await assert.rejects(broken.create({patient_ic:'SYNTHETIC'}),/prepare/);
  assert.equal(broken.pending(),id);
});
function storage() { const map=new Map();return {map,getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)}; }
const make=(store,send,options={})=>createPendingCreation({storage:store,key:'synthetic-user',
  send:(op,payload)=>op==='PREPARE_CREATE'?Promise.resolve({generation:id}):send(op,payload),
  newId:()=>id,withLock:fn=>fn(),...options});

test('Assign router consumes captured request/slot generation and clears UUID only after acknowledged assignment',async()=>{
  const calls=[],manager=make(storage(),async(op,p)=>{calls.push([op,p]);return op==='CREATE'?{request_id:id}:{result:op==='CONFIRM'?'APPROVED':'CONFIRMED'}});
  await manager.create({});await manager.confirm(id);assert.equal(manager.pending(),id);
  const router=createIcRpcRouter({creation:manager,session:()=>id,legacy:()=>assert.fail('No legacy assignment'),send:()=>assert.fail()});
  await assert.rejects(router('orl_assign_slot',{p_session_token:id,p_request_id:id,p_slot_id:id}),/view has changed/);
  assert.equal(calls.length,2);
  assert.equal(await router('orl_assign_slot',{p_session_token:id,p_request_id:id,p_slot_id:id,p_slot_generation:id}),'CONFIRMED');
  assert.equal(manager.pending(),null);
  assert.deepEqual(calls.at(-1),['ASSIGN',{request_id:id,slot_id:id,generation:id,slot_generation:id}]);
});

test('Assign cannot adopt new generation, repeat uncertain writes, or cross login sessions',async()=>{
  let owner=id,generation=id,assigns=0;
  const manager=make(storage(),()=>assert.fail(),{session:()=>owner,send:async(op)=>{
    if(op==='PREPARE_CREATE')return {generation};
    if(op==='CREATE')return {request_id:id};
    if(op==='RESOLVE_CREATE')return {request_id:id,outcome:'CREATED',status:'APPROVED',assigned:false};
    if(op==='CONFIRM')return {result:'APPROVED'};
    assigns++;return {result:'MALFORMED'};
  }});
  await manager.create({});await manager.confirm(id);generation=crypto.randomUUID();
  await assert.rejects(manager.assign(id,id,generation),/view has changed/);assert.equal(assigns,0);
  await manager.resolve();await assert.rejects(manager.assign(id,id,id),/view has changed/);
  owner=crypto.randomUUID();await assert.rejects(manager.assign(id,id,generation),/sign in/);
  await manager.resolve();await assert.rejects(manager.assign(id,id,generation),/not confirmed/);
  await assert.rejects(manager.assign(id,id,generation),/Check Previous Save/);
  assert.equal(assigns,1);assert.equal(manager.pending(),id);
});

test('lost CREATE response survives client reload, blocks fresh submission and stores only random UUID',async()=>{
  const store=storage();let calls=0;
  const send=async(op)=>{
    calls++;
    if(op==='CREATE')throw new Error('Synthetic response lost');
    return {request_id:id,outcome:'CREATED',status:'DRAFT',assigned:false};
  };
  const first=make(store,send);
  await assert.rejects(first.create({patient_ic:'PRIVATE-SYNTHETIC',patient_name:'NOT-STORED'}));
  assert.deepEqual([...store.map.values()],[id]);
  const reloaded=make(store,send);
  await assert.rejects(reloaded.create({}),/previous save/);assert.equal(calls,1);
  assert.equal((await reloaded.resolve()).status,'DRAFT');assert.equal(reloaded.pending(),id);
  await reloaded.acknowledge(id);assert.equal(reloaded.pending(),null);
});

test('fenced no-save clears pending; uncertain/malformed/unavailable resolution never clears it',async()=>{
  for(const result of [null,{request_id:'wrong',outcome:'CANCELLED'},{request_id:id,outcome:'CREATED',status:'DRAFT'},{request_id:id,outcome:'UNAVAILABLE'}]){
    const store=storage();store.setItem('synthetic-user',id);
    const manager=make(store,async()=>result);
    if(result?.outcome==='UNAVAILABLE')await manager.resolve();else await assert.rejects(manager.resolve());
    assert.equal(manager.pending(),id);
  }
  const store=storage();store.setItem('synthetic-user',id);
  const manager=make(store,async()=>({request_id:id,outcome:'CANCELLED'}));
  await manager.resolve();assert.equal(manager.pending(),null);
});

test('missing storage, malformed reference and competing tab fail before CREATE is sent',async()=>{
  let sends=0;const send=async()=>{sends++;return {request_id:id}};
  const blocked={getItem:()=>null,setItem(){throw Error('Storage unavailable')}};
  await assert.rejects(make(blocked,send).create({}));
  const store=storage();store.setItem('synthetic-user','corrupt');
  await assert.rejects(make(store,send).create({}),/unreadable/);
  await assert.rejects(make(storage(),send,{withLock:()=>{throw Error('Another tab')}}).create({}));
  assert.equal(sends,0);
});

test('CONFIRM response loss and acknowledged confirmation both retain reference until assignment',async()=>{
  let lost=true,confirms=0;
  const store=storage(),manager=make(store,async(op)=>{
    if(op==='CONFIRM'){confirms++;if(lost)throw Error('Confirm response lost');return {result:'APPROVED'}}
    if(op==='RESOLVE_CREATE')return {request_id:id,outcome:'CREATED',status:'DRAFT',assigned:false};
    return {request_id:id};
  });
  await manager.create({});
  const route=createIcRpcRouter({session:()=>id,creation:manager,send:()=>assert.fail('No new creation'),legacy:()=>assert.fail('No legacy Confirm')});
  await assert.rejects(route('orl_confirm_request',{p_session_token:id,p_request_id:id}),/response lost/);
  assert.equal(manager.pending(),id);
  await assert.rejects(route('orl_confirm_request',{p_session_token:id,p_request_id:id}),/Check Previous Save/);
  assert.equal(confirms,1);lost=false;await manager.resolve();
  await assert.rejects(route('orl_confirm_request',{p_session_token:id,p_request_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}));
  assert.equal(manager.pending(),id);
  assert.equal(await route('orl_confirm_request',{p_session_token:id,p_request_id:id}),'APPROVED');
  assert.equal(manager.pending(),id);assert.equal(confirms,2);
});

test('Confirm never prepares a fresh generation at submit and recovered selection cannot adopt a newer context',async()=>{
  const fresh=crypto.randomUUID(),calls=[];let generation=id;
  const manager=make(storage(),()=>assert.fail(),{send:async(op,payload)=>{
    calls.push({op,payload});if(op==='PREPARE_CREATE')return {generation};
    if(op==='CONFIRM')return {result:'CONFIRMED'};
    if(op==='RESOLVE_CREATE')return {request_id:id,outcome:'CREATED',status:'DRAFT',assigned:false};return {request_id:id};
  }});
  await manager.create({});generation=fresh;await manager.confirm(id);
  assert.deepEqual(calls.map(c=>c.op),['PREPARE_CREATE','CREATE','CONFIRM']);
  assert.equal(calls.at(-1).payload.generation,id);
  const store=storage();store.setItem('synthetic-user',id);calls.length=0;generation=id;
  const recovered=make(store,()=>assert.fail(),{send:async(op,payload)=>{
    calls.push({op,payload});if(op==='PREPARE_CREATE')return {generation};
    if(op==='RESOLVE_CREATE')return {request_id:id,outcome:'CREATED',status:'DRAFT',assigned:false};return {result:'APPROVED'};
  }});
  const viewed=await recovered.resolve();generation=fresh;await recovered.resolve();
  await assert.rejects(recovered.confirm(id,viewed.generation),/Check Previous Save/);
  assert.equal(calls.some(c=>c.op==='CONFIRM'),false);
});

test('changed login and malformed confirmation result keep the reference and never fall back',async()=>{
  let owner=id,confirms=0;
  const manager=make(storage(),async(op)=>{if(op==='CONFIRM'){confirms++;return {result:'WRONG'}}
    if(op==='RESOLVE_CREATE')return {request_id:id,outcome:'CREATED',status:'DRAFT',assigned:false};return {request_id:id};
  },{session:()=>owner});
  await manager.create({});owner=crypto.randomUUID();
  await assert.rejects(manager.confirm(id),/sign in/);assert.equal(confirms,0);assert.equal(manager.pending(),id);
  await manager.resolve();await assert.rejects(manager.confirm(id),/not confirmed/);
  assert.equal(confirms,1);assert.equal(manager.pending(),id);
});

test('concurrent clients share one lock and retain one pending reference while CREATE response is delayed',async()=>{
  const store=storage();let locked=false,finish,calls=0;
  const withLock=async fn=>{if(locked)throw Error('Another tab');locked=true;try{return await fn()}finally{locked=false}};
  const send=async()=>{calls++;await new Promise(resolve=>{finish=resolve});return {request_id:id}};
  const a=make(store,send,{withLock}),b=make(store,send,{withLock});
  const pending=a.create({});
  await assert.rejects(b.create({}),/Another tab/);
  finish();await pending;
  await assert.rejects(b.create({}),/previous save/);assert.equal(calls,1);
});

test('actual recovery panel resumes saved DRAFT or confirmed request without invoking CREATE',async()=>{
  const app=readFileSync(new URL('../../docs/app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('async function showPendingCreation('),app.indexOf('function toast('));
  for(const status of ['DRAFT','CONFIRMED','SCHEDULED']){
    const calls=[],children=[];
    const node=()=>({children:[],append(...items){this.children.push(...items)},remove(){this.removed=true}});
    const result={request_id:id,outcome:'CREATED',status,assigned:status==='SCHEDULED',generation:id};
    let resolves=0;
    const creation={pending:()=>id,resolve:async()=>{resolves++;return result},acknowledge:async x=>calls.push(['ack',x])};
    const form={querySelector:()=>null,prepend:x=>children.unshift(x)};
    const ctx=vm.createContext({protectedIcEnabled:()=>true,protectedIcClient:async()=>({creation}),
      document:{createElement:node},token:id,pendingRequest:null,closeModal(){},schedule(){calls.push(['schedule'])},toast(){},
      rpc:async(name,args)=>{assert.equal(args.p_generation,id);calls.push([name,args.p_request_id])}});
    vm.runInContext(source,ctx);
    assert.equal(await ctx.showPendingCreation(form),true);
    const button=children[0].children[1];await button.onclick();
    assert.equal(button.textContent,'Resume Saved Request');await button.onclick();
    assert.equal(calls.some(x=>x[0]==='orl_create_request'),false);
    assert.equal(calls.some(x=>x[0]==='orl_confirm_request'),status==='DRAFT');
    assert.equal(ctx.pendingRequest,status==='SCHEDULED'?null:id);
    assert.equal(calls.some(x=>x[0]==='ack'),status==='SCHEDULED');
    assert.equal(resolves,status==='DRAFT'?1:2,'DRAFT resume must not refresh the reviewed generation at submit');
  }
});

test('actual recovery panel requires Check Previous Save again after an uncertain Confirm',async()=>{
  const app=readFileSync(new URL('../../docs/app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('async function showPendingCreation('),app.indexOf('function toast('));
  const nodes=[],node=()=>({children:[],append(...x){this.children.push(...x)},remove(){}});
  let resolves=0,confirms=0;
  const creation={pending:()=>id,resolve:async()=>{resolves++;return {request_id:id,outcome:'CREATED',status:'DRAFT',assigned:false,generation:id}}};
  const ctx=vm.createContext({protectedIcEnabled:()=>true,protectedIcClient:async()=>({creation}),document:{createElement:node},
    token:id,rpc:async()=>{confirms++;throw Error('Uncertain confirmation')},schedule:()=>assert.fail(),closeModal:()=>assert.fail(),toast:()=>assert.fail()});
  vm.runInContext(source,ctx);await ctx.showPendingCreation({querySelector:()=>null,prepend:x=>nodes.push(x)});
  const button=nodes[0].children[1];await button.onclick();await button.onclick();
  assert.equal(confirms,1);assert.equal(resolves,1);assert.equal(button.textContent,'Check Previous Save');
  await button.onclick();assert.equal(resolves,2);assert.equal(confirms,1);
});
