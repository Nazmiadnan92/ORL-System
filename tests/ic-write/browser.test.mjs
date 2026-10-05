import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createIcTransport, createIcRpcRouter, createPendingCreation, identityEditPayload, bindProtectedIcField, previewBackupVersion } from '../../docs/ic-client.mjs';
import { createIdentityCrypto, toBase64 } from '../../supabase/functions/_shared/ic-crypto.mjs';
import { verifyIdentityBackup } from '../../security/candidates/c1-create/compatibility.mjs';

const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const options = { baseUrl: 'https://synthetic.supabase.co', publishableKey: 'sb_publishable_SYNTHETIC_ONLY', session: () => session };

test('control router carries read context even for empty holidays and consumes it before uncertain writes',async()=>{
  const calls=[];let fail=false;
  const route=createIcRpcRouter({session:()=>session,legacy:()=>assert.fail('No fallback'),send:async(op,b)=>{
    calls.push({op,b});if(op==='CONTROL_VIEW')return {generation:session,revision:'a'.repeat(32),data:{rows:[]}};
    if(fail)throw Error('Uncertain');return {action:b.action,result:null};
  }});
  const rows=await route('orl_list_holidays',{p_session_token:session});assert.deepEqual(Object.keys(rows),[]);assert.ok(rows._ic_control);
  fail=true;const args={p_session_token:session,p_id:null,p_date:'2027-01-01',p_title:'Test',p_description:'',p_control:rows._ic_control};
  await assert.rejects(route('orl_save_holiday',args),/Uncertain/);
  await assert.rejects(route('orl_save_holiday',args),/Reload/);assert.equal(calls.filter(c=>c.op==='CONTROL').length,1);
  await assert.rejects(route('orl_save_holiday',{...args,p_control:{...rows._ic_control}}),/Reload/);
});
test('control router binds session/slot targets and original login; never refreshes context while saving',async()=>{
  let owner=session;const id=crypto.randomUUID(),calls=[];
  const route=createIcRpcRouter({session:()=>owner,legacy:()=>assert.fail('No fallback'),send:async(op,b)=>{
    calls.push(op);return op==='CONTROL_VIEW'?{generation:session,revision:'a'.repeat(32),data:{}}:{action:b.action,result:'CLOSED'};
  }});
  const v=await route('orl_ic_control_view',{p_session_token:session,p_scope:'SLOT',p_id:id,p_generation:session});
  const args={p_session_token:session,p_slot_id:id,p_closed:true,p_control:v.context};
  await assert.rejects(route('orl_set_slot_closed',{...args,p_slot_id:crypto.randomUUID()}),/Wrong/);
  owner=crypto.randomUUID();await assert.rejects(route('orl_set_slot_closed',args),/Reload/);owner=session;
  assert.equal(await route('orl_set_slot_closed',args),'CLOSED');assert.deepEqual(calls,['CONTROL_VIEW','CONTROL']);
});
test('browser sends protected operations only to fixed Edge URL, without service keys, retries or legacy fallback', async () => {
  let captured, count = 0;
  const send = createIcTransport({ ...options, fetchImpl: async (url, init) => {
    count++; captured = { url: String(url), init }; return Response.json({ request_id: 'TEST' });
  } });
  assert.deepEqual(await send('EDIT', { operation: 'BACKUP_RESTORE', ic_mode: 'KEEP', data: {} }), { request_id: 'TEST' });
  assert.equal(captured.url, 'https://synthetic.supabase.co/functions/v1/ic-requests');
  assert.equal(captured.init.headers['x-orl-session'], session);
  assert.equal(captured.init.headers.Authorization, undefined);
  assert.equal(JSON.parse(captured.init.body).operation, 'EDIT');
  assert.equal(captured.init.redirect, 'error'); assert.equal(captured.init.cache, 'no-store');
  await assert.rejects(send('ARBITRARY_RPC', {})); assert.equal(count, 1);
  let failed = 0;
  const broken = createIcTransport({ ...options, fetchImpl: async () => { failed++; throw new Error('private transport detail'); } });
  await assert.rejects(broken('CREATE', {}), /Result not confirmed/); assert.equal(failed, 1);
  const html = createIcTransport({ ...options, fetchImpl: async () => new Response('<html>error</html>') });
  await assert.rejects(html('CREATE', {}), /Result not confirmed/);
  assert.throws(() => createIcTransport({ ...options, baseUrl: 'http://bad.invalid' }));
  await assert.rejects(createIcTransport({ ...options, session: () => '-'.repeat(36) })('EDIT', {}), /sign in/);
});

test('browser KEEP removes masked/stale IC, replacement requires explicit toggle and rejects mask', () => {
  const data = { patient_ic: '******-**-1234', diagnosis: 'TEST', age: '0', age_months: '6' };
  for (const canEdit of [false, true]) assert.deepEqual(identityEditPayload({ canEdit, replace: false, data }),
    { ic_mode: 'KEEP', data: { diagnosis: 'TEST', age: '0', age_months: '6' } });
  assert.equal(identityEditPayload({ canEdit: false, replace: true, value: 'ATTEMPT', data }).ic_mode, 'KEEP');
  assert.throws(() => identityEditPayload({ canEdit: true, replace: true, value: '******1234', data }));
  assert.deepEqual(identityEditPayload({ canEdit: true, replace: true, value: '', data }).data,
    { diagnosis: 'TEST', age: '0', age_months: '6', patient_ic: '' });
  assert.equal(data.patient_ic, '******-**-1234');
});

test('form binding never pre-fills raw IC; checkbox controls replacement and Staff remains disabled', () => {
  function fixture() {
    const elements = [], input = { value: 'SYNTHETIC', parentElement: { after(x) { elements.push(x); } } };
    const doc = { createTextNode: text => ({ text }), createElement: tag => ({ tag, children: [],
      append(...xs) { this.children.push(...xs); }, addEventListener(type, fn) { this[type] = fn; } }) };
    return { input, elements, doc, form: { elements: { patient_ic: input } } };
  }
  const f = fixture(), collect = bindProtectedIcField(f.form, { canEdit: true, masked: '******-**-1234', document: f.doc });
  const toggle = f.elements[0].children[0];
  assert.equal(f.input.value, ''); assert.equal(f.input.disabled, true); assert.equal(f.input.placeholder, '******-**-1234');
  assert.equal(collect({}).ic_mode, 'KEEP');
  toggle.checked = true; toggle.change(); f.input.value = 'REPLACEMENT123';
  assert.equal(f.input.disabled, false); assert.equal(collect({}).data.patient_ic, 'REPLACEMENT123');
  toggle.checked = false; toggle.change(); assert.equal(f.input.value, ''); assert.equal(f.input.disabled, true);
  const staff = fixture(); bindProtectedIcField(staff.form, { canEdit: false, document: staff.doc });
  assert.equal(staff.elements[0].children[0].disabled, true);
});

// Exercise the EXISTING deployed file decoder, not a freshly invented file format.
const app = readFileSync(new URL('../../docs/app.js', import.meta.url), 'utf8');
const maskSource=app.slice(app.indexOf('function maskPatientIc('),app.indexOf('function formatOtDocumentDate('));
const maskContext=vm.createContext({});
vm.runInContext(maskSource+'\nglobalThis.maskPatientIc=maskPatientIc;',maskContext);
test('browser and exported OT lists preserve first six Malaysian IC digits and hide the final six',()=>{
  assert.equal(maskContext.maskPatientIc('010203-04-5678'),'010203-**-****');
  assert.equal(maskContext.maskPatientIc('010203045678'),'010203-**-****');
  assert.equal(maskContext.maskPatientIc('010203-**-****'),'010203-**-****');
  assert.equal(maskContext.maskPatientIc('C1-PASSPORT-SECRET'),'********CRET');
});
const lines = app.split('\n').filter(line => /^async function (backupKey|streamBytes|decodeBackup)\(/.test(line));
assert.equal(lines.length, 3, 'Backup decoder layout changed; review the extraction.');
const context = vm.createContext({ crypto, TextEncoder, TextDecoder, Uint8Array, Blob, Response, CompressionStream, DecompressionStream });
vm.runInContext(lines.join('\n') + '\nglobalThis.codec={backupKey,streamBytes,decodeBackup};', context);
const codec = context.codec;
const passphrase = 'SYNTHETIC-BACKUP-' + crypto.randomUUID();
async function makeFile(data) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await codec.streamBytes(new TextEncoder().encode(JSON.stringify(data)), 'gzip');
  const key = await codec.backupKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return new Blob([new TextEncoder().encode('ORLOMS1G'), salt, iv, ciphertext]);
}
const base = () => ({ format: 'ORLOMS_BACKUP', version: 2, identity_format: 'ORL_IC_SHADOW_V1',
  creation_receipt_format: 'ORL_CREATE_RECEIPTS_V1', creation_receipts: [],
  requests: [], identities: [], users: [], settings: [], holidays: [], ot_sessions: [], ot_slots: [], audit_log: [] });

test('existing .orlbackup gzip/AES file format round-trips version 2 and server verifies IC after decoding', async () => {
  const randomKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const keys = { context: 'c1-file-test', activeEncryptionKey: 'enc-v1', activeSearchKey: 'search-v1',
    encryptionKeys: { 'enc-v1': randomKey() }, searchKeys: { 'search-v1': randomKey() } };
  const engine = await createIdentityCrypto(keys), id = crypto.randomUUID(), raw = 'SYNTHETIC-PASSPORT-123';
  const owner=crypto.randomUUID(),data = base();
  data.requests.push({ id, created_by:owner, patient_ic: raw, ic_protected: true, creation_tracked: true, age: 0, age_months: 6 });
  data.creation_receipts.push({request_id:id,owner_id:owner,outcome:'CREATED',created_at:'2026-10-01T00:00:00Z'},
    {request_id:crypto.randomUUID(),owner_id:owner,outcome:'CANCELLED',created_at:'2026-10-01T00:00:00Z'});
  data.identities.push({ request_id: id, envelope: await engine.encrypt(raw, id), search: await engine.searchHash(raw) });
  const file = await makeFile(data), decoded = await codec.decodeBackup(file, passphrase);
  assert.equal(previewBackupVersion(decoded).canRestore, true);
  assert.equal(previewBackupVersion(decoded).identities, 1);
  // Decoder runs in a separate VM realm; compare plain structured-cloned values.
  assert.deepEqual(structuredClone(decoded.creation_receipts),data.creation_receipts);
  assert.deepEqual(await verifyIdentityBackup(decoded, keys), data);
  assert.equal(new TextDecoder().decode(await file.arrayBuffer()).includes(raw), false);
});

test('wrong passphrase/tampering fail; old files still open but protected restore requires conversion', async () => {
  const file = await makeFile(base());
  await assert.rejects(codec.decodeBackup(file, 'incorrect'), /passphrase or damaged/);
  const bytes = new Uint8Array(await file.arrayBuffer()); bytes[bytes.length - 1] ^= 1;
  await assert.rejects(codec.decodeBackup(new Blob([bytes]), passphrase), /passphrase or damaged/);
  const old = { ...base(), version: 1 }; delete old.identities; delete old.identity_format;
  const opened = await codec.decodeBackup(await makeFile(old), passphrase);
  assert.equal(previewBackupVersion(opened).canRestore, false);
  assert.match(previewBackupVersion(opened).message, /Keep this file/);
  assert.throws(() => previewBackupVersion({ ...base(), version: 3 }));
});

test('release frontend protection remains enabled while cache 075 publishes C3 Reveal', () => {
  const html = readFileSync(new URL('../../docs/index.html', import.meta.url), 'utf8');
  const config = readFileSync(new URL('../../docs/config.js', import.meta.url), 'utf8');
  assert.equal(html.includes('c1-create'), false);
  assert.equal(/icProtectionEnabled\s*:\s*true/.test(config), true);
  assert.match(html, /config\.js\?v=025/);
  assert.match(html, /app\.js\?v=075/);
  assert.match(app, /ic-client\.mjs\?v=075/);
  assert.ok(app.includes('cfg.icProtectionEnabled===true'));
  assert.ok(app.includes("!protectedIcEnabled()?await legacyRpc(name,args):await (await protectedIcClient()).route(name,args)"));
});

test('protected RPC router preserves clinical/backup return shapes and never falls back after failure', async () => {
  const calls = [], legacy = [];
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const send = async (operation, payload) => {
    if(operation==='PREPARE_CREATE')return {generation:id};
    calls.push({ operation, payload });
    return { request_id: id, result: operation==='REMOVE'?2:'UPDATED', backup: base() }; };
  const store = new Map();
  const creation = createPendingCreation({send,key:'synthetic',newId:()=>id,withLock:fn=>fn(),
    storage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)}});
  const route = createIcRpcRouter({ session: () => session, creation,
    legacy: async (...args) => { legacy.push(args); return 'LEGACY'; },
    send });
  const common = { p_session_token: session, p_generation:id, p_expected_ids:[id] };
  assert.equal(await route('orl_create_request', { ...common, p_data: { patient_ic: 'SYNTHETIC' } }), id);
  assert.equal(calls[0].payload.request_id, id);
  assert.equal(await route('orl_edit_scheduled_request_checked', { ...common, p_slot_id: id,
    p_expected_request_id: id, p_expected_version:'2026-10-04T12:00:00.123456+08:00', p_ic_mode: 'KEEP', p_data: {}, p_action: 'CONFIRM' }), 'UPDATED');
  assert.deepEqual(calls[1].payload, { from_slot: id, expected_request: id, expected_version:'2026-10-04T12:00:00.123456+08:00', ic_mode: 'KEEP', data: {}, action: 'CONFIRM', generation:id });
  await route('orl_move_postponed_checked', { ...common, p_from_slot_id: id, p_to_slot_id: session,
    p_expected_request_id: id, p_expected_version:'2026-10-04T12:00:00.123456+08:00', p_ic_mode: 'SET', p_data: { patient_ic: '' }, p_reason: 'TEST' });
  assert.equal(calls[2].operation, 'MOVE');
  assert.equal((await route('orl_db_export', { ...common, p_password: 'synthetic' })).version, 2);
  await route('orl_db_import', { ...common, p_password: 'synthetic', p_backup: base() });
  assert.equal(calls.at(-1).operation, 'BACKUP_RESTORE');
  assert.equal((await route('orl_ic_convert_legacy_backup',{...common,p_password:'synthetic',p_backup:{format:'ORLOMS_BACKUP',version:1}})).version,2);
  assert.equal(calls.at(-1).operation,'BACKUP_CONVERT');
  assert.equal(await route('orl_db_remove_patient',{...common,p_password:'synthetic',p_mode:'MRN',p_value:'SYNTHETIC'}),2);
  assert.deepEqual(calls.at(-1),{operation:'REMOVE',payload:{password:'synthetic',mode:'MRN',value:'SYNTHETIC',generation:id,expected_ids:[id]}});
  const count = calls.length;
  for(const name of ['orl_edit_scheduled_request','orl_move_postponed','orl_db_import_locked','orl_delete_request','orl_swap_slots'])
    await assert.rejects(route(name,common),/older action is unavailable/);
  await assert.rejects(route('orl_db_import', { ...common, p_backup: { format: 'ORLOMS_BACKUP', version: 1 } }), /Keep this file/);
  await assert.rejects(route('orl_edit_scheduled_request_checked', common), /not ready/);
  await assert.rejects(route('orl_db_remove_patient', common), /Invalid removal/);
  await assert.rejects(route('orl_db_export', { p_session_token: 'other' }), /sign in/);
  assert.equal(calls.length, count); assert.equal(legacy.length, 0);
  assert.equal(await route('orl_get_schedule', common), 'LEGACY');
  const broken = createIcRpcRouter({ session: () => session, creation:{create:async()=>{throw new Error('Unconfirmed')}},
    legacy: () => assert.fail('No fallback'),
    send: async () => { throw new Error('Unconfirmed'); } });
  await assert.rejects(broken('orl_create_request', { ...common, p_data: {} }), /Unconfirmed/);
  await assert.rejects(broken('orl_db_remove_patient',{...common,p_password:'synthetic',p_mode:'REQUEST',p_value:id}),/Unconfirmed/);
});

test('Database Repair uses the exact reviewed generation/revision without refreshing at write',async()=>{
  const calls=[],old=crypto.randomUUID();let generation=old;
  const route=createIcRpcRouter({session:()=>session,legacy:()=>assert.fail('No legacy Repair'),send:async(op,p)=>{
    calls.push({op,p});if(op==='PREPARE_CREATE')return {generation};
    if(op==='REPAIR_VIEW')return {generation,revision:'a'.repeat(32),health:{status:'WARNING'}};
    if(op==='REPAIR')return {result:{status:'COMPLETED',fixed:1}};throw Error('unexpected');
  }});
  const viewed=await route('orl_db_health',{p_session_token:session}),context=viewed._ic_repair;
  generation=crypto.randomUUID();
  assert.equal((await route('orl_db_repair',{p_session_token:session,p_password:'SYNTHETIC',p_repair:context})).fixed,1);
  assert.deepEqual(calls.map(x=>x.op),['PREPARE_CREATE','REPAIR_VIEW','REPAIR']);assert.equal(calls[2].p.generation,old);
  for(const bad of [null,{...context,revision:'bad'},{...context,owner:crypto.randomUUID()}])
    await assert.rejects(route('orl_db_repair',{p_session_token:session,p_password:'SYNTHETIC',p_repair:bad}),/Reload/);
  assert.equal(calls.length,3);
});

test('unscheduled manual count uses the displayed request version and has no legacy fallback',async()=>{
  const calls=[],version='2026-10-04T12:00:00.123456+08:00';
  const route=createIcRpcRouter({session:()=>session,legacy:()=>assert.fail('No legacy count'),send:async(op,p)=>{calls.push({op,p});return {result:p.count}}});
  const args={p_session_token:session,p_request_id:session,p_count:6,p_expected_version:version,p_generation:session};
  assert.equal(await route('orl_set_postpone_count',args),null);
  assert.deepEqual(calls[0],{op:'UNSCHEDULED_COUNT',p:{request_id:session,count:6,expected_version:version,generation:session}});
  for(const bad of [{...args,p_count:1000},{...args,p_count:2.5},{...args,p_expected_version:''},{...args,p_generation:null}])
    await assert.rejects(route('orl_set_postpone_count',bad),/Reload/);
  assert.equal(calls.length,1);
});

test('protected read captures generation before data and carries it unchanged through later writes',async()=>{
  const old=crypto.randomUUID(),fresh=crypto.randomUUID(),id=crypto.randomUUID(),calls=[];
  let generation=old;
  const route=createIcRpcRouter({session:()=>session,send:async(op,payload)=>{
    calls.push({op,payload});return op==='PREPARE_CREATE'?{generation}:{result:'UPDATED'};
  },legacy:async name=>{
    assert.equal(calls.at(-1).op,'PREPARE_CREATE');generation=fresh;
    return name==='orl_get_schedule'?[{slots:[{id,request_id:id,patient_ic:'****'}]}]:[{id,patient_ic:'****'}];
  }});
  const rows=await route('orl_get_schedule',{p_session_token:session});
  assert.equal(rows[0].slots[0]._ic_generation,old);
  await route('orl_edit_scheduled_request_checked',{p_session_token:session,p_generation:rows[0].slots[0]._ic_generation,
    p_slot_id:id,p_expected_request_id:id,p_expected_version:'2026-10-04T12:00:00.123456+08:00',p_data:{},p_ic_mode:'KEEP',p_action:'CONFIRM'});
  assert.equal(calls.length,2);assert.equal(calls[1].payload.generation,old,'No fresh generation may be fetched at submit');
  const db=await route('orl_db_find_patient',{p_session_token:session,p_search:'SYNTHETIC'});
  assert.equal(db[0]._ic_generation,fresh);
});

test('Review list captures generation before read; router uses that snapshot without refreshing or fallback',async()=>{
  const generation=crypto.randomUUID(),request=crypto.randomUUID(),calls=[];
  const route=createIcRpcRouter({session:()=>session,send:async(op,p)=>{
    calls.push({op,p});return op==='PREPARE_CREATE'?{generation}:{result:p.action};
  },legacy:async name=>{assert.equal(name,'orl_get_requests');return [{id:request,assigned_slot_id:null,status:'CONFIRMED'}]}});
  const [row]=await route('orl_get_requests',{p_session_token:session});
  assert.equal(row._ic_generation,generation);assert.equal(row._ic_review_owner,session);
  const args={p_session_token:session,p_request_id:request,p_expected_slot:null,p_generation:row._ic_generation,p_action:'REJECT',p_note:''};
  assert.equal(await route('orl_review_request',args),'REJECT');
  assert.deepEqual(calls.map(x=>x.op),['PREPARE_CREATE','REVIEW']);
  assert.equal(calls[1].p.generation,generation);
  for(const bad of [{...args,p_expected_slot:undefined},{...args,p_generation:null},{...args,p_action:'DELETE'}])
    await assert.rejects(route('orl_review_request',bad),/Reload/);
  assert.equal(calls.length,2);
});

test('Review uncertain results and changed login fail without automatic retries or legacy fallback',async()=>{
  let owner=session,count=0;
  const args={p_session_token:session,p_request_id:session,p_expected_slot:null,p_generation:session,p_action:'APPROVE',p_note:''};
  const route=createIcRpcRouter({session:()=>owner,legacy:()=>assert.fail('No legacy review'),send:async()=>{count++;return {result:'WRONG'}}});
  await assert.rejects(route('orl_review_request',args),/not confirmed/);assert.equal(count,1);
  owner=crypto.randomUUID();await assert.rejects(route('orl_review_request',args),/sign in/);assert.equal(count,1);
});

test('Clear router requires displayed UUIDs, has no fallback/retry, rejects obsolete API and uncertain response',async()=>{
  const calls=[];let result='CLEARED',owner=session;
  const route=createIcRpcRouter({session:()=>owner,legacy:()=>assert.fail('No legacy Clear'),send:async(op,p)=>{calls.push({op,p});return {result}}});
  const args={p_session_token:session,p_slot_id:session,p_expected_request_id:session,p_generation:session};
  assert.equal(await route('orl_clear_slot_checked',args),null);
  assert.deepEqual(calls[0],{op:'CLEAR',p:{slot_id:session,expected_request:session,generation:session}});
  for(const bad of [{...args,p_generation:null},{...args,p_expected_request_id:null}])await assert.rejects(route('orl_clear_slot_checked',bad),/Reload/);
  await assert.rejects(route('orl_clear_slot',args),/older action/);assert.equal(calls.length,1);
  result='WRONG';await assert.rejects(route('orl_clear_slot_checked',args),/not confirmed/);assert.equal(calls.length,2);
  owner=crypto.randomUUID();await assert.rejects(route('orl_clear_slot_checked',args),/sign in/);assert.equal(calls.length,2);
});

test('deletion reads/requests/decisions retain original exact version and never refresh at submission or fall back',async()=>{
  const calls=[],version='2026-10-04T12:00:00.123456+08:00';let bad=false;
  const route=createIcRpcRouter({session:()=>session,legacy:async name=>{assert.equal(name,'orl_get_deletions');return [{id:session,assigned_slot_id:null,_ic_delete_version:version}]},
    send:async(op,p)=>{calls.push({op,p});if(op==='PREPARE_CREATE')return {generation:session};return {result:bad?'WRONG':op==='DELETE_REQUEST'?'REQUESTED':p.action}}});
  const [row]=await route('orl_get_deletions',{p_session_token:session});assert.equal(row._ic_review_owner,session);
  const args={p_session_token:session,p_request_id:session,p_generation:row._ic_generation,p_expected_slot:null,p_expected_version:row._ic_delete_version,p_reason:'Synthetic',p_action:'APPROVE'};
  await route('orl_request_deletion',args);await route('orl_resolve_deletion',args);
  assert.deepEqual(calls.map(x=>x.op),['PREPARE_CREATE','DELETE_REQUEST','DELETE_RESOLVE']);
  assert.equal(calls[2].p.expected_version,version);
  await assert.rejects(route('orl_request_deletion',{...args,p_expected_version:''}),/Reload/);assert.equal(calls.length,3);
  bad=true;await assert.rejects(route('orl_resolve_deletion',args),/not confirmed/);assert.equal(calls.length,4);
});

test('bad view preparation or changed session fails before returning data; unversioned mutation/removal cannot send',async()=>{
  let reads=0,writes=0,owner=session;
  const route=createIcRpcRouter({session:()=>owner,legacy:async()=>{reads++;return []},send:async()=>{writes++;return {generation:'bad'}}});
  await assert.rejects(route('orl_get_schedule',{p_session_token:session}),/safe view/);assert.equal(reads,0);
  await assert.rejects(route('orl_edit_scheduled_request_checked',{p_session_token:session,p_ic_mode:'KEEP',p_data:{}}),/Reload/);
  await assert.rejects(route('orl_db_remove_patient',{p_session_token:session,p_mode:'MRN',p_value:'SYNTHETIC'}),/Reload/);
  assert.equal(writes,1);
  const switched=createIcRpcRouter({session:()=>owner,legacy:async()=>{reads++;return []},send:async()=>{owner=crypto.randomUUID();return {generation:crypto.randomUUID()}}});
  await assert.rejects(switched('orl_get_schedule',{p_session_token:session}),/sign in/);assert.equal(reads,0);
});
