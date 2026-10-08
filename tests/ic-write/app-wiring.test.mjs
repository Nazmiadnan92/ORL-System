import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as client from '../../docs/ic-client.mjs';

const app = readFileSync(new URL('../../docs/app.js', import.meta.url), 'utf8');
const helpers = app.slice(app.indexOf('let protectedIcClientPromise;'), app.indexOf('function toast('));
const active = name => app.split(/\r?\n/).filter(line =>
  line.startsWith('function ' + name + '(') || line.startsWith('async function ' + name + '(')).at(-1);
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('actual Database Repair submits only the captured health context and consumes it before dispatch',async()=>{
  const context={owner:session,generation:id,revision:'a'.repeat(32)},calls=[],messages=[];let callback;
  const ctx=vm.createContext({token:session,window:{_dbRepairContext:context},protectedIcEnabled:()=>true,confirm:()=>true,
    toast:x=>messages.push(x),secureDatabaseAction:(a,b,fn)=>callback=fn,
    rpc:async(name,args)=>{calls.push({name,args});return {status:'COMPLETED',fixed:2}},dbHealth:async()=>calls.push({health:true})});
  vm.runInContext(active('dbRepair'),ctx);await ctx.dbRepair();assert.equal(ctx.window._dbRepairContext,null);
  await callback('SYNTHETIC');assert.equal(calls[0].name,'orl_db_repair');assert.equal(calls[0].args.p_repair,context);
  assert.equal(calls[1].health,true);
  await ctx.dbRepair();assert.equal(calls.length,2);assert.ok(messages.some(x=>/Reload Database Health/.test(x)));
});

test('legacy DOCX fallback defensively masks IC and never formats a full identifier',()=>{
  const start=app.lastIndexOf('async function generateOtList('),end=app.indexOf('\nfunction ',start+1),source=app.slice(start,end);
  assert.match(source,/maskPatientIc\(slot\.patient_ic\)/);
  assert.doesNotMatch(source,/formatPatientIc\(slot\.patient_ic\)/);
});

test('Request Management has no permanent-delete shortcut and offers cancellation plus unscheduled count edit',()=>{
  const start=app.indexOf('async function drawRequests('),end=app.indexOf('\nfunction jumpToRequest',start),source=app.slice(start,end);
  assert.doesNotMatch(source,/deleteRequest\s*\(/);
  assert.match(source,/Request Cancel/);
  assert.match(source,/editPostpone\([^)]*,true\)/);
});

function countHarness(enabled=true,assigned=false){
  const row={id,assigned_slot_id:assigned?session:null,_ic_generation:session,
    _ic_delete_version:'2026-10-04T12:00:00.123456+08:00',_ic_review_owner:session};
  const calls=[],messages=[];let value='7',fail=false;
  const ctx=vm.createContext({token:session,user:{role:'WEBMASTER'},window:{_reviewRows:[row]},currentPage:'management',
    protectedIcEnabled:()=>enabled,prompt:()=>value,toast:x=>messages.push(x),
    rpc:async(name,args)=>{calls.push({name,args});if(fail)throw Error('Count result not confirmed. Reload and check.')},
    go:async page=>calls.push({go:page})});
  const start=app.indexOf('let manualCountBusy='),end=app.indexOf('\nasync function postponed(',start);
  vm.runInContext(app.slice(start,end),ctx);
  return {ctx,row,calls,messages,value:x=>value=x,fail:()=>fail=true};
}

test('protected unscheduled count uses the reviewed version/generation once; default-OFF keeps legacy arguments',async()=>{
  const h=countHarness();await h.ctx.editPostpone(id,0,true);
  assert.deepEqual(structuredClone(h.calls[0]),{name:'orl_set_postpone_count',args:{p_session_token:session,
    p_request_id:id,p_count:7,p_generation:session,p_expected_version:h.row._ic_delete_version}});
  assert.equal(h.row._ic_countConsumed,true);assert.deepEqual(h.calls[1],{go:'management'});
  await h.ctx.editPostpone(id,7,true);assert.equal(h.calls.length,2);assert.ok(h.messages.some(x=>/Reload Request Management/.test(x)));
  const legacy=countHarness(false);await legacy.ctx.editPostpone(id,0,true);
  assert.deepEqual(structuredClone(legacy.calls[0].args),{p_session_token:session,p_request_id:id,p_count:7});
});

test('manual count validates role/value/location and never retries an uncertain protected write',async()=>{
  const scheduled=countHarness();await scheduled.ctx.editPostpone(id,0,false);assert.equal(scheduled.calls.length,0);
  assert.ok(scheduled.messages.some(x=>/scheduled patient/));
  const invalid=countHarness();invalid.value('1.5');await invalid.ctx.editPostpone(id,0,true);assert.equal(invalid.calls.length,0);
  const denied=countHarness();denied.ctx.user.role='ADMIN';await denied.ctx.editPostpone(id,0,true);assert.equal(denied.calls.length,0);
  const uncertain=countHarness();uncertain.fail();await uncertain.ctx.editPostpone(id,0,true);await uncertain.ctx.editPostpone(id,0,true);
  assert.equal(uncertain.calls.length,1);assert.equal(uncertain.row._ic_countConsumed,true);
});

function controlHarness(enabled=true){
  const row={session_id:id,ot_date:'2027-01-03',_ic_generation:id,_ic_review_owner:session,slots:[{id}]},calls=[],messages=[];
  let cancel=false,fail=false,hold=null;
  const context={generation:id,revision:'a'.repeat(32)};
  const ctx=vm.createContext({token:session,user:{role:'ADMIN'},window:{_schedule:[row]},protectedIcEnabled:()=>enabled,
    confirm:()=>!cancel,prompt:()=>cancel?null:'Synthetic title',toast:x=>messages.push(x),reloadSchedule:async()=>calls.push({reload:true}),
    rpc:async(name,args)=>{calls.push({name,args});if(name==='orl_ic_control_view')return {context,data:{session:{ot_date:row.ot_date,status:'ACTIVE'},slots:[]}};
      if(hold)await hold;if(fail)throw Error('Control update not confirmed')}
  });
  vm.runInContext(app.slice(app.indexOf('let controlBusy='),app.indexOf('let clearSlotBusy=',app.indexOf('let controlBusy=')))||'',ctx);
  vm.runInContext(active('setSlotClosed'),ctx);
  return {ctx,row,calls,messages,context,cancel:()=>cancel=true,fail:()=>fail=true,hold:p=>hold=p};
}
test('actual control actions review current date, retain default-OFF argument shape and cancel without writes',async()=>{
  for(const enabled of [true,false])for(const [fn,args,rpcName] of [['setSession',[id,'CANCELLED'],'orl_set_session'],['setTitle',[id],'orl_set_session'],['setSlotClosed',[id,true],'orl_set_slot_closed']]){
    const h=controlHarness(enabled);await h.ctx[fn](...args);const sent=h.calls.find(x=>x.name===rpcName);assert.ok(sent);
    assert.equal(Object.hasOwn(sent.args,'p_control'),enabled);if(enabled)assert.equal(sent.args.p_control,h.context);
    const cancelled=controlHarness(enabled);cancelled.cancel();await cancelled.ctx[fn](...args);
    assert.equal(cancelled.calls.some(x=>x.name===rpcName),false);
  }
});
test('actual control failure consumes schedule selection, blocks overlapping/repeated actions and changed login',async()=>{
  const h=controlHarness();h.fail();let release;h.hold(new Promise(r=>release=r));
  const pending=h.ctx.setSession(id,'CANCELLED');await new Promise(r=>setImmediate(r));await h.ctx.setTitle(id);release();await pending;
  await h.ctx.setSlotClosed(id,true);assert.equal(h.calls.filter(x=>x.name==='orl_set_session').length,1);
  assert.equal(h.calls.some(x=>x.reload),false);assert.equal(h.calls.some(x=>x.name==='orl_set_slot_closed'),false);
  const other=controlHarness();other.ctx.token=crypto.randomUUID();await other.ctx.setSession(id,'ACTIVE');assert.equal(other.calls.length,0);
});
test('actual clear-holidays password callback retains initial view and rejects changed login',async()=>{
  const initial={},later={},calls=[];let callback;
  const ctx=vm.createContext({token:session,window:{_holidayRows:{_ic_control:initial}},protectedIcEnabled:()=>true,
    confirm:()=>true,secureDatabaseAction:(a,b,fn)=>callback=fn,rpc:async(name,args)=>{calls.push(args);return 2},toast:()=>{},holidays:async()=>{}});
  vm.runInContext(active('holidayControlArgs')+'\n'+active('clearAllHolidays'),ctx);ctx.clearAllHolidays();
  ctx.window._holidayRows={_ic_control:later};await callback('SYNTHETIC');assert.equal(calls[0].p_control,initial);
  ctx.clearAllHolidays();ctx.token=crypto.randomUUID();await assert.rejects(callback('SYNTHETIC'),/sign in/);assert.equal(calls.length,1);
});

function deletionHarness(enabled=true){
  const row={id,status:'CONFIRMED',deletion_status:'',assigned_slot_id:null,_ic_generation:id,
    _ic_delete_version:'2026-10-04T12:00:00.123456+08:00',_ic_review_owner:session};
  const pending={...row,deletion_status:'PENDING'},calls=[],messages=[];
  let cancel=false,fail=false;
  const ctx=vm.createContext({token:session,user:{role:'ADMIN'},window:{_reviewRows:[row],_deletionRows:[pending]},
    protectedIcEnabled:()=>enabled,prompt:()=>cancel?null:'Synthetic reason',confirm:()=>!cancel,toast:x=>messages.push(x),
    rpc:async(name,args)=>{calls.push({name,args});if(fail)throw Error('Cancellation result not confirmed. Reload and check.')},
    requests:async()=>calls.push({requests:true}),deletions:async()=>calls.push({deletions:true})});
  vm.runInContext(app.slice(app.indexOf('let deletionBusy='),app.indexOf('async function holidays(',app.indexOf('let deletionBusy='))),ctx);
  return {ctx,row,pending,calls,messages,cancel:()=>cancel=true,fail:()=>fail=true};
}

test('actual deletion read cache records rendered snapshot and clears stale rows if loading fails, in both modes',async()=>{
  for(const enabled of [true,false]){
    const rows=[{id,_ic_delete_version:'2026-10-04T00:00:00Z'}];let fail=false;
    const read=async()=>{if(fail)throw Error('Unavailable');return rows};
    const ctx=vm.createContext({window:{_deletionRows:['stale']},protectedIcEnabled:()=>enabled,legacyRpc:read,protectedIcClient:async()=>({route:read})});
    vm.runInContext(app.slice(app.indexOf('async function rpc('),app.indexOf('function configureProtectedIcForm(')),ctx);
    await ctx.rpc('orl_get_deletions',{});assert.equal(ctx.window._deletionRows,rows);
    fail=true;await assert.rejects(ctx.rpc('orl_get_deletions',{}));assert.equal(ctx.window._deletionRows.length,0);
  }
});

test('actual deletion request/resolve captures exact timestamp, nullable slot and generation; default-OFF and cancel preserved',async()=>{
  for(const enabled of [true,false])for(const resolving of [true,false]){
    const h=deletionHarness(enabled);await (resolving?h.ctx.resolveDeletion(id,'APPROVE'):h.ctx.requestDeletion(id));
    assert.equal(h.calls[0].args.p_expected_version,enabled?h.row._ic_delete_version:undefined);
    assert.equal(h.calls[0].args.p_expected_slot,enabled?null:undefined);
    assert.equal(h.calls[0].args.p_generation,enabled?id:undefined);assert.equal(h.calls.length,2);
    const c=deletionHarness(enabled);c.cancel();await c.ctx.requestDeletion(id);await c.ctx.resolveDeletion(id,'REJECT');assert.equal(c.calls.length,0);
  }
});

test('actual uncertain deletion request/decision consumes both lists and requires refresh without retries',async()=>{
  for(const resolving of [true,false]){
    const h=deletionHarness();h.fail();
    const act=()=>resolving?h.ctx.resolveDeletion(id,'APPROVE'):h.ctx.requestDeletion(id);
    await act();await act();assert.equal(h.calls.length,1);
    assert.equal(h.row._ic_deletionConsumed,true);assert.equal(h.pending._ic_deletionConsumed,true);
    assert.ok(h.messages.some(x=>/Reload/.test(x)));
  }
});

test('actual deletion blocks stale login/missing snapshot and Staff decisions',async()=>{
  for(const change of [h=>h.ctx.token=id,h=>delete h.row._ic_delete_version,h=>h.row.deletion_status='PENDING']){
    const h=deletionHarness();change(h);await h.ctx.requestDeletion(id);assert.equal(h.calls.length,0);
  }
  const staff=deletionHarness();staff.ctx.user.role='STAFF';await staff.ctx.resolveDeletion(id,'APPROVE');assert.equal(staff.calls.length,0);
});

function clearHarness(enabled=true){
  const calls=[],messages=[],slot={id,request_id:session,_ic_generation:id,_ic_review_owner:session};
  let decision=true,fail=false,hold=null;
  const ctx=vm.createContext({token:session,user:{role:'ADMIN'},window:{_schedule:[{slots:[slot]}]},
    protectedIcEnabled:()=>enabled,confirm:()=>decision,toast:x=>messages.push(x),
    rpc:async(name,args)=>{calls.push({name,args});if(hold)await hold;if(fail)throw Error('Clear not confirmed. Reload and check the slot.');return null},
    reloadSchedule:async()=>calls.push({reload:true})});
  vm.runInContext(app.slice(app.indexOf('let clearSlotBusy='),app.indexOf('\nfunction ',app.indexOf('let clearSlotBusy='))),ctx);
  return {ctx,slot,calls,messages,cancel:()=>decision=false,fail:()=>fail=true,hold:p=>hold=p};
}

test('actual Clear retains displayed patient/generation; legacy args preserved; cancel, Staff and stale login do not submit',async()=>{
  for(const enabled of [true,false]){
    const h=clearHarness(enabled);await h.ctx.clearSlot(id);
    assert.equal(h.calls[0].args.p_expected_request_id,session);
    assert.equal(h.calls[0].args.p_generation,enabled?id:undefined);assert.ok(h.calls.some(c=>c.reload));
    const c=clearHarness(enabled);c.cancel();await c.ctx.clearSlot(id);assert.equal(c.calls.length,0);
  }
  for(const change of [h=>h.ctx.user.role='STAFF',h=>h.ctx.token=id,h=>delete h.slot._ic_generation,h=>h.slot.request_id=null]){
    const h=clearHarness();change(h);await h.ctx.clearSlot(id);assert.equal(h.calls.length,0);
  }
});

test('actual uncertain Clear blocks concurrent/repeat clicks until explicit fresh schedule, without success or automatic retry',async()=>{
  const h=clearHarness();let release;h.hold(new Promise(resolve=>release=resolve));h.fail();
  const first=h.ctx.clearSlot(id);await h.ctx.clearSlot(id);release();await first;await h.ctx.clearSlot(id);
  assert.equal(h.calls.length,1);assert.equal(h.slot._ic_clearConsumed,true);
  assert.ok(h.messages.some(x=>/Reload/.test(x)));assert.equal(h.messages.some(x=>/OT slot cleared/.test(x)),false);
});

function reviewHarness({enabled=true,role='ADMIN'}={}){
  const calls=[],messages=[],slotId=crypto.randomUUID();
  const row={id,assigned_slot_id:slotId,status:'CONFIRMED',_ic_generation:session,_ic_review_owner:session};
  const slot={id:slotId,request_id:id,status:'RESERVED',_ic_generation:session,_ic_review_owner:session};
  let answer='',decision=true,fail=false,hold=null;
  const ctx=vm.createContext({token:session,user:{role},window:{_reviewRows:[row],_schedule:[{slots:[slot]}]},
    protectedIcEnabled:()=>enabled,prompt:()=>answer,confirm:()=>decision,toast:x=>messages.push(x),
    rpc:async(name,args)=>{calls.push({name,args});if(hold)await hold;if(fail)throw Error('Review not confirmed. Reload and check the request.');return args.p_action},
    management:async()=>calls.push({management:true}),reloadSchedule:async()=>calls.push({schedule:true}),refreshNotifications(){}});
  const code=app.slice(app.indexOf('let reviewBusy='),app.indexOf('let manualCountBusy='));
  const approval=app.slice(app.indexOf('async function approveSlotRequest('),app.indexOf('\nfunction slotCard(',app.indexOf('async function approveSlotRequest(')));
  vm.runInContext(code+'\n'+approval,ctx);
  return {ctx,row,slot,calls,messages,cancel:()=>{answer=null;decision=false},fail:()=>{fail=true},
    hold:promise=>{hold=promise}};
}

test('actual management review and schedule approval send displayed slot/generation; cancel never writes',async()=>{
  for(const enabled of [true,false]){
    const h=reviewHarness({enabled});await h.ctx.review(id,'REJECT');
    assert.equal(h.calls[0].args.p_expected_slot,enabled?h.row.assigned_slot_id:undefined);
    assert.equal(h.calls[0].args.p_generation,enabled?session:undefined);assert.ok(h.calls.some(x=>x.management));
    const s=reviewHarness({enabled});await s.ctx.approveSlotRequest(id);
    assert.equal(s.calls[0].args.p_expected_slot,enabled?s.slot.id:undefined);assert.ok(s.calls.some(x=>x.schedule));
    const cancelled=reviewHarness({enabled});cancelled.cancel();await cancelled.ctx.review(id,'REJECT');await cancelled.ctx.approveSlotRequest(id);
    assert.equal(cancelled.calls.length,0);
  }
});

test('actual uncertain review consumes both views; simultaneous or repeated clicks cannot send again before reload',async()=>{
  const h=reviewHarness();let release;h.hold(new Promise(resolve=>release=resolve));h.fail();
  const first=h.ctx.review(id,'APPROVE');await h.ctx.approveSlotRequest(id);release();await first;
  await h.ctx.review(id,'REJECT');await h.ctx.approveSlotRequest(id);
  assert.equal(h.calls.length,1);assert.equal(h.row._ic_reviewConsumed,true);assert.equal(h.slot._ic_reviewConsumed,true);
  assert.ok(h.messages.some(x=>/Reload/.test(x)));
});

test('actual Review blocks Staff, changed login, missing generation and no-longer-pending views',async()=>{
  for(const change of [h=>h.ctx.user.role='STAFF',h=>h.ctx.token=id,h=>delete h.row._ic_generation,h=>h.row.status='SCHEDULED']){
    const h=reviewHarness();change(h);await h.ctx.review(id,'APPROVE');assert.equal(h.calls.length,0);
  }
  const h=reviewHarness();h.slot.status='CONFIRMED';await h.ctx.approveSlotRequest(id);assert.equal(h.calls.length,0);
});

function assignmentHarness(enabled=true){
  const calls=[],message={},button={},form={elements:{},dataset:{},querySelector:()=>button};
  for(const name of ['age','mrn','patient_name','surgery','diagnosis','doctor','specialist','sub_specialty','phone'])
    form.elements[name]={value:'Synthetic',addEventListener(){}};
  const slot={id,type:'MAIN',number:1,status:'AVAILABLE',_ic_generation:session};
  const day={status:'ACTIVE',ot_date:'2092-02-03',day_name:'Synthetic',slots:[slot]};
  let failAssign=false;
  const ctx=vm.createContext({token:session,pendingRequest:null,user:{role:'ADMIN',display_name:'Synthetic'},window:{_schedule:[day]},
    protectedIcEnabled:()=>enabled,showPendingCreation:async()=>{calls.push({recovery:true});return false},
    $:selector=>selector==='#formMsg'?message:form,patientNameCase:x=>x,bindAgeToIc(){},bindClinicalFormatting(){},queueDuplicateCheck(){},
    FormData:class{constructor(f){this.f=f}*[Symbol.iterator](){for(const [k,v]of Object.entries(this.f.elements))yield[k,v.value]}},
    normalizeClinicalFields(){},checkDuplicateRequest:async()=>({exact_count:0}),
    rpc:async(name,args)=>{calls.push({name,args});if(name==='orl_create_request')return id;if(name==='orl_assign_slot'&&failAssign)throw Error('Lost response');return 'CONFIRMED'},
    closeModal:()=>calls.push({close:true}),toast:text=>calls.push({toast:text}),reloadSchedule:async()=>calls.push({reload:true}),
    schedule:()=>calls.push({schedule:true}),requests:()=>calls.push({requests:true}),submit:()=>calls.push({submit:true}),
    modal(){},esc:x=>x,formatSystemDate:x=>x,requestFormMarkup:()=>'',Date});
  const bind=app.slice(app.indexOf('function bindRequestForm('),app.indexOf('\nfunction submit(){',app.indexOf('function bindRequestForm(')));
  const direct=app.slice(app.indexOf('function directRequestAllowed('),app.indexOf('function slotPreview(',app.indexOf('function directRequestAllowed(')));
  const assign=app.slice(app.indexOf('let assignSlotBusy='),app.indexOf('\nfunction ',app.indexOf('let assignSlotBusy=')));
  vm.runInContext(bind+'\n'+direct+'\n'+assign,ctx);
  return {ctx,calls,form,slot,message,fail:()=>{failAssign=true},submit:()=>form.onsubmit({preventDefault(){},submitter:button})};
}

test('actual direct-slot form preserves opening slot generation and default-OFF legacy argument shape',async()=>{
  for(const enabled of [true,false]){
    const h=assignmentHarness(enabled);h.ctx.requestSlot(id);h.slot._ic_generation=id;await h.submit();
    const writes=h.calls.filter(x=>x.name);
    assert.deepEqual(writes.map(x=>x.name),['orl_create_request','orl_confirm_request','orl_assign_slot']);
    assert.equal(writes[2].args.p_slot_generation,enabled?session:undefined);
    assert.equal(h.ctx.pendingRequest,null);assert.ok(h.calls.some(x=>x.reload));
  }
});

test('actual direct form preserves uncertain assignment for explicit recovery, not automatic retry',async()=>{
  const h=assignmentHarness();h.ctx.requestSlot(id);h.fail();await h.submit();
  assert.equal(h.calls.filter(x=>x.name==='orl_assign_slot').length,1);
  assert.match(h.message.textContent,/Check Previous Save/);
  assert.equal(h.calls.some(x=>x.close||x.reload),false);assert.equal(h.ctx.pendingRequest,null);
  assert.ok(h.calls.at(-1).recovery);
  const changed=assignmentHarness();changed.ctx.requestSlot(id);changed.ctx.token=id;await changed.submit();
  assert.equal(changed.calls.some(x=>x.name),false);assert.match(changed.message.textContent,/sign in/);
});

test('actual choose-after-submit uses displayed generation and interrupted Assign opens recovery without resubmitting',async()=>{
  const h=assignmentHarness();h.ctx.bindRequestForm(h.form);await h.submit();
  assert.equal(h.ctx.pendingRequest,id);assert.ok(h.calls.some(x=>x.schedule));
  h.fail();await h.ctx.assignSlot(id);
  assert.equal(h.calls.filter(x=>x.name==='orl_assign_slot').length,1);
  assert.equal(h.calls.find(x=>x.name==='orl_assign_slot').args.p_slot_generation,session);
  assert.ok(h.calls.some(x=>x.submit));assert.equal(h.ctx.pendingRequest,null);
});

function harness({ enabled = true, role = 'ADMIN' } = {}) {
  const forms = {}, calls = [], messages = [];
  const doc = { createTextNode: text => ({ text }), createElement: tag => ({ tag, children: [],
    append(...xs) { this.children.push(...xs); }, addEventListener(type, fn) { this[type] = fn; } }) };
  function form(kind) {
    const labels = [], elements = {};
    const names = ['patient_ic', 'mrn', 'patient_name', 'surgery', 'diagnosis', 'doctor', 'specialist',
      'sub_specialty', 'phone', 'remark', 'age', 'age_months', ...(kind === 'editSlotForm' ? ['action', ...(role==='WEBMASTER'?['postpone_count']:[])] : ['reason'])];
    for (const name of names) elements[name] = { value: name === 'action' ? 'CONFIRM' : '', dataset: {},
      parentElement: { after(label) { labels.push(label); } }, dispatchEvent() {} };
    return { elements, labels };
  }
  const record = { id, request_id: id, type: 'MAIN', number: 1, patient_ic: '******-**-1234', _ic_generation:session,
    _ic_edit_version:'2026-10-04T12:00:00.123456+08:00',
    age: 0, age_months: 6, mrn: 'SYNTHETIC', patient_name: 'Synthetic Test', diagnosis: 'TEST',
    surgery: 'TEST', doctor: 'Synthetic', specialist: 'Synthetic', sub_specialty: 'Gen ORL', phone: 'TEST' };
  const misc = { '#postMonth': {}, '#postYear': {}, '#backupPreview': {} };
  const legacy = async (name, args) => { calls.push({ legacy: name, args }); return 'LEGACY'; };
  const send = async (operation, payload) => { calls.push({ operation, payload }); return { result: operation==='REMOVE'?1:operation==='REASSIGN'?'REASSIGNED':'UPDATED', request_id: id }; };
  const api = { ...client,
    bindProtectedIcField: (f, options) => client.bindProtectedIcField(f, { ...options, document: doc }),
    route: client.createIcRpcRouter({ session: () => session, send, legacy }) };
  const ctx = vm.createContext({
    cfg: { icProtectionEnabled: enabled }, token: session, user: { role },
    window: { _schedule: [{ ot_date: '2026-11-01', slots: [record] }], _scheduleYM: { year: 2026, month: 11 } },
    $: selector => {
      const field = selector.match(/^#(\w+) \[name="(\w+)"\]$/);
      if (field) return forms[field[1]].elements[field[2]];
      return forms[selector.slice(1)] || misc[selector];
    },
    modal: html => { const key = html.includes('id="postponeForm"') ? 'postponeForm' : 'editSlotForm'; forms[key] = form(key); },
    field: () => '', editSlotField: () => '', editSubspecialtyField: () => '', ageFields: () => '',
    months: [], patientAgeFromIc: () => '—', bindAgeToIc: () => {}, bindClinicalFormatting: () => {},
    normalizeClinicalFields: () => {}, maskPatientIc: () => '******-**-1234', formatSystemDate:x=>x, patientNameCase:x=>x,
    closeModal: () => {}, toast: text => messages.push(text), reloadSchedule: async () => {},
    loadPostponeSlots: () => {}, postponeBusy: false, Event, legacyRpc: legacy,
    FormData: class {
      constructor(f) { this.rows = f.rows || Object.entries(f.elements)
        .filter(([, el]) => !el.disabled).map(([key, el]) => [key, String(el.value)]); }
      [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
      get(key) { return this.rows.find(row => row[0] === key)?.[1]; }
    },
    esc: x => String(x), dashStat: () => '', decodeBackup: async () => ({ format: 'ORLOMS_BACKUP', version: 1 }),
  });
  vm.runInContext(helpers + '\n' + ['editSlot', 'postponeSlot', 'completePostpone', 'previewBackup', 'dbRemove'].map(active).join('\n'), ctx);
  vm.runInContext(app.slice(app.indexOf('let reassignSelection=null;'),app.indexOf('function editSlot(')),ctx);
  ctx.testClient = api;
  vm.runInContext('protectedIcClientPromise=Promise.resolve(testClient);', ctx);
  const submit = async f => f.onsubmit({ preventDefault() {}, target: f });
  return { ctx, forms, misc, record, calls, messages, submit };
}

test('actual app gate keeps legacy calls unchanged and explicit protected mode does not fall back', async () => {
  const h = harness({ enabled: false });
  assert.equal(await h.ctx.rpc('orl_create_request', { p_session_token: session, p_data: {} }), 'LEGACY');
  assert.equal(h.calls[0].legacy, 'orl_create_request');
  h.ctx.cfg.icProtectionEnabled = true;
  vm.runInContext('protectedIcClientPromise=Promise.reject(new Error("MODULE_UNAVAILABLE"));', h.ctx);
  await assert.rejects(h.ctx.rpc('orl_create_request', { p_session_token: session, p_data: {} }), /MODULE_UNAVAILABLE/);
  assert.equal(h.calls.length, 1);
});

test('actual Edit form sends KEEP without masked IC for both Admin and Staff; preserves infant months', async () => {
  for (const role of ['ADMIN', 'STAFF']) {
    const h = harness({ role });
    h.ctx.editSlot(id); const f = h.forms.editSlotForm;
    assert.equal(f.elements.patient_ic.value, '');
    assert.equal(f.elements.patient_ic.disabled, true);
    await f._icReady;
    if (role === 'STAFF') assert.equal(f.labels[0].children[0].disabled, true);
    await h.submit(f);
    assert.equal(h.calls.length, 1); const call = h.calls[0];
    assert.equal(call.operation, 'EDIT'); assert.equal(call.payload.ic_mode, 'KEEP');
    assert.equal(call.payload.expected_version,h.record._ic_edit_version);
    assert.equal(Object.hasOwn(call.payload.data, 'patient_ic'), false);
    assert.equal(call.payload.data.age, '0'); assert.equal(call.payload.data.age_months, '6');
  }
});

test('actual Reassign keeps original generation and patient snapshots; uncertain outcome clears selection without retry',async()=>{
  for(const enabled of [true,false]) {
    const h=harness({enabled}),day=h.ctx.window._schedule[0];day.session_id=session;h.record.status='CONFIRMED';
    day.slots.push({id:session,request_id:null,status:'AVAILABLE',type:'SPECIAL',number:1,_ic_generation:session});
    h.ctx.reassignSlot(session,id);
    h.record._ic_generation=crypto.randomUUID();day.slots[1].request_id=crypto.randomUUID();
    await h.ctx.swapSlot(id,session);assert.equal(h.calls.length,1);
    if(enabled){assert.equal(h.calls[0].operation,'REASSIGN');assert.equal(h.calls[0].payload.generation,session);assert.equal(h.calls[0].payload.expected_to,null)}
    else {assert.equal(h.calls[0].legacy,'orl_swap_slots_checked');assert.equal(Object.hasOwn(h.calls[0].args,'p_generation'),false)}
  }
  const h=harness(),day=h.ctx.window._schedule[0];day.session_id=session;h.record.status='CONFIRMED';
  day.slots.push({id:session,request_id:null,status:'AVAILABLE',type:'SPECIAL',number:1});
  h.ctx.reassignSlot(session,id);let attempts=0;h.ctx.rpc=async()=>{attempts++;throw new Error('Reassign not confirmed')};
  await h.ctx.swapSlot(id,session);await h.ctx.swapSlot(id,session);
  assert.equal(attempts,1);assert.equal(vm.runInContext('reassignSelection',h.ctx),null);
  assert.equal(h.messages.includes('OT slots reassigned.'),false);
});

test('Reassign rejects missing generation and changed login before any protected or legacy write',async()=>{
  for(const switched of [true,false]) {
    const h=harness(),day=h.ctx.window._schedule[0];day.session_id=session;h.record.status='CONFIRMED';
    if(!switched)delete h.record._ic_generation;
    day.slots.push({id:session,request_id:null,status:'AVAILABLE',type:'SPECIAL',number:1});
    h.ctx.reassignSlot(session,id);if(switched)h.ctx.token=crypto.randomUUID();
    await h.ctx.swapSlot(id,session);assert.equal(h.calls.length,0);
    assert.equal(vm.runInContext('reassignSelection',h.ctx),null);
  }
});

test('actual Webmaster Edit saves changed count in one protected request; blank/unchanged omit it and legacy mode is unchanged',async()=>{
  for(const count of ['7','0','']) {
    const h=harness({role:'WEBMASTER'}); h.record.postpone_count=0; h.ctx.editSlot(id);
    const f=h.forms.editSlotForm;await f._icReady;f.elements.postpone_count.value=count;
    await h.submit(f);assert.equal(h.calls.length,1);assert.equal(h.calls[0].operation,'EDIT');
    assert.equal(h.calls[0].payload.data.postpone_count,count==='7'?'7':undefined);
  }
  const h=harness({role:'WEBMASTER',enabled:false});h.ctx.editSlot(id);
  h.forms.editSlotForm.elements.postpone_count.value='7';await h.submit(h.forms.editSlotForm);
  assert.deepEqual(h.calls.map(c=>c.legacy),['orl_edit_scheduled_request_checked','orl_set_postpone_count']);
});

test('invalid count and manual count combined with Postpone never submit; separate legacy count is blocked',async()=>{
  for(const count of ['-1','1.5','1000','2']) {
    const h=harness({role:'WEBMASTER'});h.record.postpone_count=0;h.ctx.editSlot(id);
    const f=h.forms.editSlotForm;await f._icReady;f.elements.postpone_count.value=count;
    if(count==='2')f.elements.action.value='POSTPONE';
    await h.submit(f);assert.equal(h.calls.length,0);assert.equal(h.forms.postponeForm,undefined);
    assert.match(h.messages[0],count==='2'?/Confirm first/:/0 to 999/);
  }
  const h=harness({role:'WEBMASTER'});
  await assert.rejects(h.ctx.rpc('orl_set_postpone_count',{p_session_token:session,p_request_id:id,p_count:1}),/Reload the unscheduled/);
  assert.equal(h.calls.length,0);
});

test('actual Edit -> Postpone carries explicit replacement without placing raw IC in schedule cache', async () => {
  const h = harness(); h.ctx.editSlot(id);
  const f = h.forms.editSlotForm; await f._icReady;
  const toggle = f.labels[0].children[0]; toggle.checked = true; toggle.change();
  f.elements.patient_ic.value = 'SYNTHETIC-REPLACEMENT';
  f.elements.action.value = 'POSTPONE';
  await h.submit(f);
  assert.equal(h.calls.length, 0, 'Opening Postpone must not save anything');
  assert.equal(h.record.patient_ic, '******-**-1234', 'Cached masked identity is not replaced with plaintext');
  const post = h.forms.postponeForm;
  assert.equal(post.elements.patient_ic.value, 'SYNTHETIC-REPLACEMENT');
  assert.equal(post.labels[0].children[0].checked, true);
  post.elements.reason.value = 'Synthetic move';
  await h.ctx.completePostpone(session);
  assert.equal(h.calls.length, 1); const move = h.calls[0];
  assert.equal(move.operation, 'MOVE'); assert.equal(move.payload.ic_mode, 'SET');
  assert.equal(move.payload.expected_version,h.record._ic_edit_version);
  assert.equal(move.payload.data.patient_ic, 'SYNTHETIC-REPLACEMENT');
  assert.equal(move.payload.expected_request, id); assert.equal(move.payload.to_slot, session);
});

test('actual protected replacement untick restores original age and explicit blank remains SET', async () => {
  const h = harness(); h.ctx.editSlot(id); const f = h.forms.editSlotForm; await f._icReady;
  const toggle = f.labels[0].children[0];
  toggle.checked = true; toggle.change();
  f.elements.age.value = '99'; f.elements.age_months.value = '11';
  toggle.checked = false; toggle.change();
  assert.equal(f.elements.age.value, 0); assert.equal(f.elements.age_months.value, 6);
  toggle.checked = true; toggle.change(); f.elements.patient_ic.value = '';
  await h.submit(f);
  assert.equal(h.calls[0].payload.ic_mode, 'SET'); assert.equal(h.calls[0].payload.data.patient_ic, '');
});

test('module load failure leaves actual Edit disabled for IC and prevents save', async () => {
  const h = harness();
  vm.runInContext('protectedIcClientPromise=Promise.reject(new Error("MODULE_UNAVAILABLE"));', h.ctx);
  h.ctx.editSlot(id); const f = h.forms.editSlotForm; await f._icReady; await h.submit(f);
  assert.equal(f.elements.patient_ic.disabled, true);
  assert.equal(h.calls.length, 0);
  assert.ok(h.messages.some(x => x.includes('not ready')));
});

test('actual protected backup preview refuses legacy file and clears previously selected restore payload', async () => {
  const h = harness(); h.ctx.window._restoreBackup = { old: 'must not remain' };
  const button = {};
  await h.ctx.previewBackup({ preventDefault() {}, target: { rows: [['file', {}], ['passphrase', 'synthetic']] }, submitter: button });
  assert.equal(h.ctx.window._restoreBackup, null);
  assert.match(h.misc['#backupPreview'].innerHTML, /Keep this file/);
  assert.equal(h.calls.length, 0);
  assert.equal(button.disabled, false);
});

test('actual removal UI denies Staff/Admin, requires initial consent and defers save until Webmaster password confirmation',async()=>{
  for(const role of ['STAFF','ADMIN']){
    const h=harness({role});await h.ctx.dbRemove('REQUEST',id);assert.equal(h.calls.length,0);assert.match(h.messages[0],/Webmaster/);
  }
  const h=harness({role:'WEBMASTER'});let action,warning,refresh=0;
  h.ctx.confirm=()=>false;h.ctx.secureDatabaseAction=()=>assert.fail('Cancelled');
  await h.ctx.dbRemove('REQUEST',id,session,[id]);assert.equal(h.calls.length,0);
  h.ctx.confirm=text=>{assert.match(text,/ALL patient records/);return true};
  h.ctx.secureDatabaseAction=(_title,text,callback)=>{warning=text;action=callback};h.ctx.database=()=>refresh++;
  await h.ctx.dbRemove('MRN','SYNTHETIC',session,[id]);assert.equal(h.calls.length,0);assert.match(warning,/encrypted IC copy/);
  await action('SYNTHETIC-PASSWORD');assert.equal(refresh,1);
  assert.deepEqual(structuredClone(h.calls[0]),{operation:'REMOVE',payload:{password:'SYNTHETIC-PASSWORD',mode:'MRN',value:'SYNTHETIC',generation:session,expected_ids:[id]}});
  assert.match(h.messages.at(-1),/1 patient record/);
});

test('actual removal UI never displays success or reloads after an uncertain failure',async()=>{
  const h=harness({role:'WEBMASTER'});let action,refresh=0,attempts=0;
  h.ctx.confirm=()=>true;h.ctx.secureDatabaseAction=(_title,_warning,callback)=>action=callback;h.ctx.database=()=>refresh++;
  h.ctx.rpc=async()=>{attempts++;throw Error('Removal result not confirmed')};
  await h.ctx.dbRemove('REQUEST',id,session,[id]);await assert.rejects(action('SYNTHETIC'),/not confirmed/);
  assert.equal(attempts,1);assert.equal(refresh,0);assert.equal(h.messages.length,0);
});

test('actual Edit/Postpone keeps opening generation even if another schedule load replaces cached context',async()=>{
  const h=harness();h.ctx.editSlot(id);const f=h.forms.editSlotForm;await f._icReady;
  h.record._ic_generation=id;f.elements.action.value='POSTPONE';await h.submit(f);
  const post=h.forms.postponeForm;assert.equal(post._icGeneration,session);
  post.elements.reason.value='Synthetic move';
  await h.ctx.completePostpone(session);assert.equal(h.calls[0].payload.generation,session);
  const missing=harness();delete missing.record._ic_generation;missing.ctx.editSlot(id);
  await missing.forms.editSlotForm._icReady;await missing.submit(missing.forms.editSlotForm);
  assert.equal(missing.calls.length,0);assert.match(missing.messages.at(-1),/Reload/);
});
