import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIcGateway } from '../../security/candidates/c1-create/gateway.mjs';
import { createBackendRpc } from '../../security/candidates/c1-create/backend.mjs';
import { createIdentityCrypto, toBase64 } from '../../supabase/functions/_shared/ic-crypto.mjs';
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id = crypto.randomUUID();
const randomKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
const keys = { context: 'c1-gateway-synthetic', activeEncryptionKey: 'enc-v1', activeSearchKey: 'search-v1',
  encryptionKeys: { 'enc-v1': randomKey() }, searchKeys: { 'search-v1': randomKey() } };
const req = (body, overrides = {}) => new Request('https://synthetic.supabase.co/functions/v1/ic-requests', {
  method: 'POST', headers: { 'x-orl-session': token, 'content-type': 'application/json', origin: 'https://nazmiadnan92.github.io' },
  body: JSON.stringify(body), ...overrides });
const gateway = (rpc, more = {}) => createIcGateway({ enabled: true, origins: ['https://nazmiadnan92.github.io'], rpc, cryptoConfig: () => keys, rateLimit: async () => true, ...more });
const clinical = { patient_ic: 'TEST-IC-123', age: '10', age_months: '0', patient_name: 'Synthetic', mrn: 'TEST', surgery: 'TEST',
  diagnosis: 'TEST', doctor: 'Test', specialist: 'Test', sub_specialty: 'Gen ORL', phone: '0' };
const emptyBackup = () => ({ format: 'ORLOMS_BACKUP', version: 2, identity_format: 'ORL_IC_SHADOW_V1',
  creation_receipt_format: 'ORL_CREATE_RECEIPTS_V1', creation_receipts: [],
  requests: [], identities: [], users: [], settings: [], holidays: [], ot_sessions: [], ot_slots: [], audit_log: [] });

test('Database Repair gateway is Webmaster-only, strict and returns only confirmed results',async()=>{
  let role='WEBMASTER',fail=false;
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};if(fail)throw Error('PRIVATE');
    if(name==='orl_ic_c1_repair_view')return {generation:id,revision:'a'.repeat(32),health:{status:'HEALTHY'}};
    if(name==='orl_ic_c1_repair')return {status:'COMPLETED',fixed:2};throw Error('unexpected')});
  assert.equal((await run(req({operation:'REPAIR_VIEW',generation:id}))).status,200);
  assert.equal((await run(req({operation:'REPAIR',password:'SYNTHETIC',generation:id,revision:'a'.repeat(32)}))).status,200);
  role='ADMIN';assert.equal((await run(req({operation:'REPAIR_VIEW',generation:id}))).status,403);
  role='WEBMASTER';assert.equal((await run(req({operation:'REPAIR',password:'',generation:id,revision:'bad'}))).status,400);
  fail=true;const response=await run(req({operation:'REPAIR',password:'SYNTHETIC',generation:id,revision:'a'.repeat(32)}));
  assert.equal(response.status,503);assert.equal((await response.text()).includes('PRIVATE'),false);
});

test('unscheduled count gateway is strict Webmaster-only and sanitizes uncertain results',async()=>{
  let role='WEBMASTER',calls=0,fail=false;const version='2026-10-04T12:00:00.123456+08:00';
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};calls++;if(fail)throw Error('PRIVATE');
    assert.equal(name,'orl_ic_c1_unscheduled_count');assert.equal(args.p_count,7);return 7});
  const body={operation:'UNSCHEDULED_COUNT',request_id:id,count:7,expected_version:version,generation:id};
  assert.equal((await run(req(body))).status,200);role='ADMIN';assert.equal((await run(req(body))).status,403);
  role='WEBMASTER';for(const bad of [{...body,count:-1},{...body,count:1.5},{...body,expected_version:''},{...body,extra:true}])
    assert.equal((await run(req(bad))).status,400);
  fail=true;const response=await run(req(body));assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/PRIVATE/);assert.equal(calls,2);
});

test('control gateway validates fixed actions, roles, strict snapshots and never loads crypto keys',async()=>{
  let role='ADMIN',calls=[];
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};calls.push({name,args});
    return name==='orl_ic_c1_control_view'?{generation:id,revision:'a'.repeat(32),data:{rows:[]}}:{action:args.p_action,result:null}},
    {cryptoConfig:()=>assert.fail('No keys for metadata controls')});
  const body={operation:'CONTROL',action:'SESSION_STATUS',id,data:{status:'ACTIVE'},generation:id,revision:'a'.repeat(32)};
  assert.equal((await run(req(body))).status,200);assert.equal(calls[0].name,'orl_ic_c1_control');
  for(const bad of [{...body,data:{status:null}},{...body,extra:'x'},{...body,revision:''},{...body,action:'ARBITRARY_SQL'},
    {...body,action:'HOLIDAY_GENERATE',id:null,data:{year:null}}])assert.equal((await run(req(bad))).status,400);
  assert.equal(calls.length,1);role='STAFF';assert.equal((await run(req(body))).status,403);
  assert.equal((await run(req({operation:'CONTROL_VIEW',scope:'SLOT',id,generation:id}))).status,403);
  assert.equal((await run(req({operation:'CONTROL_VIEW',scope:'HOLIDAYS',id:null,generation:null}))).status,200);
  role='ADMIN';assert.equal((await run(req({...body,action:'HOLIDAY_CLEAR',id:null,data:{password:'SYNTHETIC'}}))).status,403);
});
test('control gateway sanitizes uncertain errors without retries or raw credentials',async()=>{
  let calls=0;const run=gateway(async name=>{if(name==='orl_ic_c1_authorize')return {role:'WEBMASTER'};calls++;throw Error('PRIVATE-SYNTHETIC')});
  const response=await run(req({operation:'CONTROL',action:'HOLIDAY_CLEAR',id:null,data:{password:'SYNTHETIC'},generation:id,revision:'a'.repeat(32)}));
  assert.equal(response.status,503);assert.equal(calls,1);assert.doesNotMatch(await response.text(),/PRIVATE-SYNTHETIC/);
});

test('gateway disabled by default, authorizes before processing, never trusts role supplied in body', async () => {
  let count = 0;
  const rpc = async () => { count++; return { role: 'STAFF' }; };
  assert.equal((await gateway(rpc, { enabled: false })(req({}))).status, 503); assert.equal(count, 0);
  assert.equal((await gateway(rpc)(req({}, { headers: {} }))).status, 401); assert.equal(count, 0);
  assert.equal((await gateway(rpc)(req({}, { headers: { origin: 'https://evil.invalid' } }))).status, 403); assert.equal(count, 0);
  const forged = await gateway(rpc)(req({ operation: 'BACKUP_EXPORT', role: 'WEBMASTER', password: 'TEST' }));
  assert.equal(forged.status, 403); assert.equal(count, 1);
  assert.equal((await gateway(async () => { throw new Error('PRIVATE SESSION ERROR'); })(req({}))).status, 403);
});
test('gateway Assign is strict, loads no keys, sanitizes uncertain errors and never retries',async()=>{
  let calls=0,fail=false;
  const run=gateway(async(name,args)=>{
    if(name==='orl_ic_c1_authorize')return {role:'STAFF'};
    calls++;assert.equal(name,'orl_ic_c1_assign');assert.equal(args.p_slot_generation,id);
    if(fail)throw Error('PRIVATE SQL DETAILS');return 'RESERVED';
  },{cryptoConfig:()=>assert.fail('Assign needs no keys')});
  const body={operation:'ASSIGN',request_id:id,slot_id:id,generation:id,slot_generation:id};
  for(const altered of [{...body,slot_generation:null},{...body,slot_id:{}},{...body,role:'WEBMASTER'}])
    assert.equal((await run(req(altered))).status,400);
  assert.equal(calls,0);
  assert.deepEqual(await (await run(req(body))).json(),{result:'RESERVED'});
  fail=true;const response=await run(req(body));assert.equal(response.status,503);
  const text=JSON.stringify(await response.json());assert.match(text,/Check Previous Save/);assert.doesNotMatch(text,/PRIVATE/);
  assert.equal(calls,2);
});

test('Review gateway is Admin-only, validates nullable slot/snapshot/action/note, and does not retry or load keys',async()=>{
  let role='STAFF',calls=0,fail=false;
  const run=gateway(async(name,args)=>{
    if(name==='orl_ic_c1_authorize')return {role};
    calls++;assert.equal(name,'orl_ic_c1_review');assert.equal(args.p_generation,id);
    if(fail)throw Error('PRIVATE ERROR');return args.p_action;
  },{cryptoConfig:()=>assert.fail('No Review crypto')});
  const body={operation:'REVIEW',request_id:id,expected_slot:null,generation:id,action:'APPROVE',note:''};
  assert.equal((await run(req(body))).status,403);assert.equal(calls,0);role='ADMIN';
  for(const invalid of [{...body,expected_slot:undefined},{...body,generation:null},{...body,action:'DELETE'},
    {...body,note:'x'.repeat(4097)},{...body,role:'WEBMASTER'}])assert.equal((await run(req(invalid))).status,400);
  assert.equal(calls,0);assert.deepEqual(await(await run(req(body))).json(),{result:'APPROVE'});
  role='WEBMASTER';assert.deepEqual(await(await run(req({...body,expected_slot:id,action:'REJECT'}))).json(),{result:'REJECT'});
  fail=true;const response=await run(req(body));assert.equal(response.status,503);
  const result=JSON.stringify(await response.json());assert.match(result,/Reload/);assert.doesNotMatch(result,/PRIVATE/);assert.equal(calls,3);
});

test('Clear gateway is Admin/WM-only, strict snapshot, no keys, sanitized uncertain errors without retry',async()=>{
  let role='STAFF',calls=0,fail=false;
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};calls++;
    assert.equal(name,'orl_ic_c1_clear');assert.equal(args.p_expected_request_id,id);
    if(fail)throw Error('PRIVATE SQL DETAILS');return 'CLEARED';
  },{cryptoConfig:()=>assert.fail('Clear needs no keys')});
  const body={operation:'CLEAR',slot_id:id,expected_request:id,generation:id};
  assert.equal((await run(req(body))).status,403);role='ADMIN';
  for(const bad of [{...body,expected_request:null},{...body,generation:undefined},{...body,role:'WEBMASTER'}])
    assert.equal((await run(req(bad))).status,400);
  assert.equal(calls,0);assert.deepEqual(await(await run(req(body))).json(),{result:'CLEARED'});
  role='WEBMASTER';fail=true;const response=await run(req(body));assert.equal(response.status,503);
  const text=JSON.stringify(await response.json());assert.match(text,/Reload/);assert.doesNotMatch(text,/PRIVATE/);assert.equal(calls,2);
});

test('cancellation gateway separates request/decision roles, checks exact snapshot/reason/action, and never loads keys or retries',async()=>{
  let role='STAFF',calls=0,fail=false;
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};calls++;
    assert.equal(name,'orl_ic_c1_deletion');assert.equal(args.p_expected_version,'2026-10-04T12:00:00.123456+08:00');
    if(fail)throw Error('PRIVATE');return args.p_operation==='REQUEST'?'REQUESTED':args.p_operation;
  },{cryptoConfig:()=>assert.fail('No cancellation crypto')});
  const common={request_id:id,expected_slot:null,expected_version:'2026-10-04T12:00:00.123456+08:00',generation:id};
  const request={...common,operation:'DELETE_REQUEST',reason:'Synthetic'},decision={...common,operation:'DELETE_RESOLVE',action:'APPROVE'};
  assert.equal((await run(req(decision))).status,403);
  for(const bad of [{...request,reason:''},{...request,reason:'x'.repeat(4097)},{...request,expected_slot:undefined},{...request,expected_version:'invalid'},{...request,password:'extra'}])
    assert.equal((await run(req(bad))).status,400);
  assert.equal(calls,0);assert.deepEqual(await(await run(req(request))).json(),{result:'REQUESTED'});
  role='ADMIN';assert.equal((await run(req({...decision,action:'DELETE'}))).status,400);
  assert.deepEqual(await(await run(req(decision))).json(),{result:'APPROVE'});
  fail=true;const response=await run(req(decision));assert.equal(response.status,503);assert.doesNotMatch(JSON.stringify(await response.json()),/PRIVATE/);assert.equal(calls,3);
});

test('gateway CREATE uses verified encryption and returns no IC, envelope, HMAC, or key', async () => {
  let args;
  const run = gateway(async (name, p) => {
    if (name === 'orl_ic_c1_authorize') return { role: 'STAFF' };
    assert.equal(name, 'orl_ic_c1_create'); args = p; return p.p_request_id;
  });
  const response = await run(req({ operation: 'CREATE', request_id: id, generation:id, data: clinical }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { request_id: id });
  const engine = await createIdentityCrypto(keys);
  assert.equal(await engine.decrypt(args.p_envelope, id), clinical.patient_ic);
  assert.equal((await run(req({ operation: 'CREATE', request_id: id, data: clinical, envelope: {} }))).status, 400);
});
test('gateway KEEP needs no crypto keys, SET is Admin-only, malformed fields cannot select arbitrary RPCs', async () => {
  let calls = 0, role = 'STAFF', captured;
  const run = gateway(async (name, args) => {
    if (name === 'orl_ic_c1_authorize') return { role };
    calls++; assert.equal(name, 'orl_ic_c1_mutate'); captured = args; return 'UPDATED';
  }, { cryptoConfig: () => { throw new Error('KEY MUST NOT BE READ FOR KEEP'); } });
  const body = { operation: 'EDIT', generation:id, from_slot: crypto.randomUUID(), expected_request: id,
    expected_version:'2026-10-04T12:00:00.123456+08:00', ic_mode: 'KEEP', data: { diagnosis: 'NEW' }, action: 'CONFIRM' };
  assert.equal((await run(req(body))).status, 200); assert.equal(captured.p_envelope, null);
  assert.equal(captured.p_expected_version,body.expected_version);
  assert.equal((await run(req({...body,expected_version:''}))).status,400);
  assert.equal((await run(req({ ...body, ic_mode: 'SET', data: { patient_ic: 'TEST-222' } }))).status, 403);
  assert.equal((await run(req({ ...body, data: { created_by: token } }))).status, 400);
  assert.equal((await run(req({ ...body, rpc: 'orl_db_import' }))).status, 400);
  assert.equal((await run(req({ ...body, from_slot: { toString: {} } }))).status, 400);
  assert.equal(calls, 1);
  role = 'ADMIN';
  assert.equal((await run(req({ ...body, ic_mode: 'SET', data: { patient_ic: 'TEST-222' } }))).status, 400);
  assert.equal(calls, 1);
});
test('gateway Confirm validates generation/reference, permits role-checked SQL and never retries or loads keys',async()=>{
  let role='STAFF',calls=0,fail=false;
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};calls++;
    assert.equal(name,'orl_ic_c1_confirm');assert.equal(args.p_generation,id);
    if(fail)throw Error('PRIVATE SQL ERROR');return role==='STAFF'?'CONFIRMED':'APPROVED';
  },{cryptoConfig:()=>assert.fail('Confirm does not need keys')});
  const body={operation:'CONFIRM',request_id:token,generation:id};
  for(const change of [{generation:undefined},{generation:'bad'},{request_id:null},{role:'WEBMASTER'}])
    assert.equal((await run(req({...body,...change}))).status,400);
  assert.equal(calls,0);
  for(role of ['STAFF','ADMIN','WEBMASTER'])assert.equal((await run(req(body))).status,200);
  fail=true;const response=await run(req(body));assert.equal(response.status,503);assert.equal(calls,4);
  const text=await response.text();assert.match(text,/Check Previous Save/);assert.doesNotMatch(text,/PRIVATE SQL/);
});

test('gateway Reassign validates snapshots, requires Admin/WM, needs no keys and never retries uncertain results',async()=>{
  let role='STAFF',calls=0,mode='success';
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};
    calls++;assert.equal(name,'orl_ic_c1_reassign');assert.equal(args.p_expected_to_request_id,null);
    if(mode==='lost')throw new Error('PRIVATE DATABASE DETAILS');return mode==='bad'?'WRONG':'REASSIGNED';
  },{cryptoConfig:()=>assert.fail('Slot reassignment must not read keys')});
  const body={operation:'REASSIGN',from_slot:id,to_slot:token,expected_from:id,expected_to:null,generation:id};
  assert.equal((await run(req(body))).status,403);
  role='ADMIN';
  for(const change of [{expected_to:undefined},{generation:null},{to_slot:id},{expected_from:null},{data:{}}])
    assert.equal((await run(req({...body,...change}))).status,400);
  assert.equal(calls,0);assert.equal((await run(req(body))).status,200);
  role='WEBMASTER';assert.equal((await run(req(body))).status,200);
  for(mode of ['lost','bad']){const response=await run(req(body));assert.equal(response.status,503);
    const text=await response.text();assert.match(text,/do not repeat blindly/);assert.doesNotMatch(text,/PRIVATE DATABASE/)}
  assert.equal(calls,4);
});

test('gateway manual count is Webmaster EDIT-only and rejects malformed values before SQL',async()=>{
  let role='ADMIN',calls=0;
  const run=gateway(async(name,args)=>{if(name==='orl_ic_c1_authorize')return {role};
    calls++;assert.equal(args.p_data.postpone_count,'7');return 'UPDATED';});
  const body={operation:'EDIT',generation:id,from_slot:id,expected_request:id,expected_version:'2026-10-04T12:00:00.123456+08:00',ic_mode:'KEEP',data:{postpone_count:'7'},action:'CONFIRM'};
  for(role of ['ADMIN','STAFF'])assert.equal((await run(req(body))).status,403);
  role='WEBMASTER';
  for(const count of ['',null,7,'-1','1.5','1000','1e2',' 2'])
    assert.equal((await run(req({...body,data:{postpone_count:count}}))).status,400);
  const {action,...move}=body;
  assert.equal((await run(req({...move,operation:'MOVE',to_slot:token,reason:'TEST'}))).status,400);
  assert.equal(calls,0);assert.equal((await run(req(body))).status,200);assert.equal(calls,1);
});

test('gateway Webmaster password is checked before crypto/restore, and corrupt/legacy backups never reach import', async () => {
  let cryptoCalls = 0, imports = 0, passwordOk = false;
  const run = gateway(async name => {
    if (name === 'orl_ic_c1_authorize') return { role: 'WEBMASTER' };
    if (name === 'orl_ic_c1_check_password') return passwordOk;
    if (name === 'orl_ic_c1_import') { imports++; return { status: 'COMPLETED' }; }
    assert.fail('unexpected operation');
  }, { cryptoConfig: () => { cryptoCalls++; return keys; } });
  const body = { operation: 'BACKUP_RESTORE', password: 'SYNTHETIC', backup: emptyBackup() };
  assert.equal((await run(req(body))).status, 403); assert.equal(cryptoCalls, 0); assert.equal(imports, 0);
  passwordOk = true;
  assert.equal((await run(req({ ...body, backup: { ...body.backup, version: 1 } }))).status, 400); assert.equal(cryptoCalls, 0);
  assert.equal((await run(req({ ...body, backup: {} }))).status, 400); assert.equal(imports, 0);
  assert.equal((await run(req(body))).status, 200); assert.equal(imports, 1);
});
test('gateway verifies exported identities; lost restore response never auto-retries or returns raw backend error', async () => {
  let imports = 0;
  const run = gateway(async name => {
    if (name === 'orl_ic_c1_authorize') return { role: 'WEBMASTER' };
    if (name === 'orl_ic_c1_check_password') return true;
    if (name === 'orl_ic_c1_export') return emptyBackup();
    if (name === 'orl_ic_c1_import') { imports++; throw new Error('PRIVATE SQL VALUE'); }
  });
  const exported = await run(req({ operation: 'BACKUP_EXPORT', password: 'SYNTHETIC' }));
  assert.equal(exported.status, 200); assert.deepEqual((await exported.json()).backup, emptyBackup());
  const failed = await run(req({ operation: 'BACKUP_RESTORE', password: 'SYNTHETIC', backup: emptyBackup() }));
  assert.equal(failed.status, 503); assert.equal(imports, 1);
  const message = await failed.text(); assert.match(message, /do not rerun blindly/); assert.equal(message.includes('PRIVATE SQL'), false);
});
test('legacy conversion checks Webmaster/password before crypto, rechecks before return, and never calls import', async () => {
  let role='STAFF',passwordOk=false,revoke=false,checks=0,cryptoCalls=0;
  const run=gateway(async name=>{
    if(name==='orl_ic_c1_authorize')return {role};
    assert.equal(name,'orl_ic_c1_check_password','Conversion must not call any database export/import or write RPC');
    checks++;return passwordOk&&!(revoke&&checks===2);
  },{cryptoConfig:()=>{cryptoCalls++;return keys}});
  const backup={format:'ORLOMS_BACKUP',version:1,requests:[{id,patient_ic:'SYNTHETIC-ONLY',age:0,age_months:6}],
    users:[],settings:[],holidays:[],ot_sessions:[],ot_slots:[],audit_log:[]};
  const body={operation:'BACKUP_CONVERT',password:'SYNTHETIC',backup};
  for(role of ['STAFF','ADMIN'])assert.equal((await run(req(body))).status,403);
  assert.equal(checks,0);assert.equal(cryptoCalls,0);
  role='WEBMASTER';assert.equal((await run(req(body))).status,403);assert.equal(cryptoCalls,0);
  passwordOk=true;checks=0;
  const result=await run(req(body));assert.equal(result.status,200);assert.equal(checks,2);
  assert.equal(result.headers.get('cache-control'),'no-store');
  const converted=(await result.json()).backup;
  assert.equal(converted.version,2);assert.equal(converted.requests[0].age_months,6);
  assert.equal(converted.identities.length,1);assert.deepEqual(converted.creation_receipts,[]);
  checks=0;revoke=true;
  const revoked=await run(req(body));assert.equal(revoked.status,403);
  assert.equal((await revoked.text()).includes('SYNTHETIC-ONLY'),false);
  revoke=false;checks=0;
  assert.equal((await run(req({...body,backup:{...backup,identities:[]}}))).status,400);
  assert.equal(checks,1);
});

test('gateway removal is Webmaster/password only, validates exact target, and needs no encryption keys',async()=>{
  let role='STAFF',passwordOk=false,removed=0,checked=0,captured;
  const run=gateway(async(name,args)=>{
    if(name==='orl_ic_c1_authorize')return {role};
    if(name==='orl_ic_c1_check_password'){checked++;return passwordOk}
    assert.equal(name,'orl_ic_c1_remove');removed++;captured=args;return 2;
  },{cryptoConfig:()=>assert.fail('Removal must not load/reveal IC keys')});
  const body={operation:'REMOVE',password:'SYNTHETIC',mode:'MRN',value:'SYNTHETIC-MRN',generation:id,expected_ids:[id]};
  for(role of ['STAFF','ADMIN'])assert.equal((await run(req(body))).status,403);
  assert.equal(checked,0);role='WEBMASTER';
  for(const change of [{mode:'ALL'},{value:''},{value:' '.repeat(3)},{value:'x'.repeat(4097)},
    {mode:'REQUEST',value:'not-a-uuid'},{password:''},{role:'WEBMASTER'},{value:[]},{generation:null},{expected_ids:[]},{expected_ids:[id,id]},{expected_ids:[null]}])
    assert.equal((await run(req({...body,...change}))).status,400);
  assert.equal(checked,0);assert.equal((await run(req(body))).status,403);assert.equal(removed,0);
  passwordOk=true;const response=await run(req(body));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{result:2});
  assert.deepEqual(captured,{p_session_token:token,p_password:'SYNTHETIC',p_mode:'MRN',p_value:'SYNTHETIC-MRN',p_generation:id,p_expected_ids:[id]});
  assert.equal((await run(req({...body,mode:'REQUEST',value:id}))).status,200);
  assert.equal(removed,2);
});

test('uncertain or malformed removal result never retries and never exposes backend details',async()=>{
  for(const result of [undefined,0,-1,'1',1.5]){
    let calls=0;
    const run=gateway(async name=>{
      if(name==='orl_ic_c1_authorize')return {role:'WEBMASTER'};
      if(name==='orl_ic_c1_check_password')return true;
      assert.equal(name,'orl_ic_c1_remove');calls++;
      if(result===undefined)throw Error('PRIVATE DATABASE DETAIL');return result;
    });
    const response=await run(req({operation:'REMOVE',password:'SYNTHETIC',mode:'REQUEST',value:id,generation:id,expected_ids:[id]}));
    assert.equal(response.status,503);assert.equal(calls,1);
    const text=await response.text();assert.match(text,/do not repeat blindly/);assert.doesNotMatch(text,/PRIVATE DATABASE/);
  }
});

test('backend adapter allows only fixed C1 RPCs, blocks redirects, keeps service key server-side and sanitizes errors', async () => {
  let called = 0, captured;
  const rpc = createBackendRpc({ baseUrl: 'https://synthetic.supabase.co', secretKey: 'sb_secret_SYNTHETIC', fetchImpl: async (url, init) => {
    called++; captured = { url: String(url), init }; return Response.json(true);
  } });
  assert.equal(await rpc('orl_ic_c1_check_password', { p_session_token: token, p_password: 'SYNTHETIC' }), true);
  assert.equal(captured.url, 'https://synthetic.supabase.co/rest/v1/rpc/orl_ic_c1_check_password');
  assert.equal(captured.init.redirect, 'error'); assert.equal(captured.init.headers.Authorization, undefined);
  await assert.rejects(rpc('../orl_db_import', {})); assert.equal(called, 1);
  await rpc('orl_ic_c1_remove',{p_session_token:token,p_password:'SYNTHETIC',p_mode:'REQUEST',p_value:id});
  assert.equal(captured.url,'https://synthetic.supabase.co/rest/v1/rpc/orl_ic_c1_remove');
  for (const baseUrl of ['http://synthetic.supabase.co', 'https://evil.invalid', 'https://synthetic.supabase.co/other', 'https://user:pass@synthetic.supabase.co'])
    assert.throws(() => createBackendRpc({ baseUrl, secretKey: 'sb_secret_SYNTHETIC' }));
  assert.throws(() => createBackendRpc({ baseUrl: 'https://synthetic.supabase.co', secretKey: 'sb_publishable_SYNTHETIC' }));
  const denied = createBackendRpc({ baseUrl: 'https://synthetic.supabase.co', secretKey: 'SYNTHETIC_LEGACY', fetchImpl: async (_, init) => {
    assert.equal(init.headers.Authorization, 'Bearer SYNTHETIC_LEGACY'); return new Response('PRIVATE SQL', { status: 400 });
  } });
  await assert.rejects(denied('orl_ic_c1_create', {}), /^Error: Backend operation unavailable\.$/);
});
