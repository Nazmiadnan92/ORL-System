import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const qaDirectory=fileURLToPath(new URL('../../qa/ot-lifecycle/',import.meta.url));

test('OT Hold and Done UI uses immutable checked selections, privileged controls and deliberate completion',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:900},timezoneId:'Asia/Kuala_Lumpur'});
  await page.clock.install({time:new Date('2026-10-16T04:00:00Z')});await page.route('**/*',route=>route.abort());
  await page.setContent('<main id="content"></main><div id="actions"></div><div id="modal" class="modal" hidden><div class="dialog"><div id="modalBody"></div></div></div>');
  for(const file of ['styles.css','schedule.css','mobile.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];
   window.esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
   window.token='11111111-1111-4111-8111-111111111111';window.rid='22222222-2222-4222-8222-222222222222';window.sid='33333333-3333-4333-8333-333333333333';window.gen='44444444-4444-4444-8444-444444444444';
   window.user={role:'ADMIN'};window.currentPage='schedule';window.protectedIcEnabled=()=>true;window.malaysiaToday=()=>({iso:'2026-10-16'});
   window.formatSystemDate=x=>x;window.head=(title,description)=>`<h1>${esc(title)}</h1><p>${esc(description)}</p>`;
   window.modal=html=>{$('#modalBody').innerHTML=html;$('#modal').hidden=false};window.closeModal=()=>{$('#modal').hidden=true};
   window.messages=[];window.calls=[];window.refreshes=0;window.toast=x=>messages.push(x);window.reloadSchedule=async()=>{refreshes++};
   window.fixture=(overrides={})=>{
    window.row={id:sid,request_id:rid,patient_name:'Synthetic <img src=x>',mrn:'TEST-MRN',patient_ic:'900101-**-****',age:36,diagnosis:'SYNTHETIC DIAGNOSIS',surgery:'SYNTHETIC PROCEDURE',doctor:'Synthetic Doctor',specialist:'Synthetic Specialist',sub_specialty:'Gen ORL',phone:'TEST-ONLY',postpone_count:2,request_number:'TEST-ONLY',request_status:'SCHEDULED',status:'CONFIRMED',type:'MAIN',number:1,ot_hold:false,deletion_status:'',
     _ic_generation:gen,_ic_edit_version:'2026-10-16T01:02:03.123456Z',_ic_review_owner:'11111111-1111-4111-8111-111111111111',...overrides};
    window._schedule=[{ot_date:'2026-10-16',slots:[row]}];window._otHoldRows=[];window.currentPage='schedule';window.user={role:'ADMIN'};
    window.token='11111111-1111-4111-8111-111111111111';window.calls=[];window.messages=[];window.pauseWrite=false;window.failWrite=false;window.pauseRead=false;$('#content').innerHTML='<div id="scheduleList"></div>';closeModal();return row;
   };
   window.rpc=async(name,args)=>{
    calls.push({name,args});
    if(name==='orl_ic_ot_lifecycle'){
     if(pauseWrite)await new Promise(resolve=>window.releaseWrite=resolve);
     if(failWrite)throw Error('Synthetic stale version. Update not confirmed.');
     return {request_id:args.p_request_id,action:args.p_action,status:args.p_action==='COMPLETE'?'COMPLETED':'SCHEDULED',ot_hold:args.p_action==='HOLD'};
    }
    if(name==='orl_get_ot_hold_requests'){
     if(pauseRead)await new Promise(resolve=>window.releaseRead=resolve);
     return [{...row,id:rid,slot_id:sid,assigned_slot_id:sid,ot_date:'2026-10-16',slot_type:'MAIN',slot_number:1,status:'SCHEDULED',ot_hold:true,ot_hold_reason:'Synthetic <script>danger</script>',ot_hold_at:'2026-10-16T01:02:03Z'}];
    }throw Error('Unexpected fixture RPC '+name);
   };
   fixture();
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/ot-lifecycle.js',import.meta.url),'utf8')});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  const extract=name=>{let start=app.lastIndexOf('function '+name+'(');assert.ok(start>=0,name);if(app.slice(start-6,start)==='async ')start-=6;const rest=app.slice(start),end=rest.search(/\n(?:async )?function /);return end<0?rest:rest.slice(0,end)};
  await page.evaluate(()=>{
   window.canPickSlot=()=>false;window.directRequestAllowed=()=>false;window.patientAgeFromIc=()=>36;window.patientAgeText=()=> '36 years';
   window.maskPatientIc=()=> '900101-**-****';window.patientNameCase=x=>x||'';window.clinicalUpper=x=>x||'';window.admissionDate=x=>x;window.isPastOtDate=()=>false;
   Object.defineProperty(window,'status',{value:x=>esc(x),configurable:true,writable:true});window.bookingRequestActions=()=>'<button>Request Move</button>';
  });
  for(const name of ['slotCard','collapsedSlot','slotPreview','requestManagementActions','editSlot'])await page.addScriptTag({content:extract(name)});
  const draw=()=>page.evaluate(()=>{$('#actions').innerHTML=otLifecycleActions(row,_schedule[0],['ADMIN','WEBMASTER'].includes(user.role))});
  for(const role of ['ADMIN','WEBMASTER']){
   await page.evaluate(role=>{fixture();user.role=role},role);await draw();
   assert.equal(await page.locator('#actions .hold-control').count(),1);assert.equal(await page.locator('#actions .done-control').count(),1);
  }
  await page.evaluate(()=>{fixture();user.role='STAFF'});await draw();assert.equal(await page.locator('#actions button').count(),0);
  await page.evaluate(()=>openOtLifecycle(rid,'HOLD'));assert.equal(await page.locator('#modal').isHidden(),true);assert.equal(await page.evaluate(()=>calls.length),0);
  await page.evaluate(()=>{fixture();_schedule[0].ot_date='2026-10-17'});await draw();assert.equal(await page.locator('#actions .done-control').count(),0);
  await page.evaluate(()=>openOtLifecycle(rid,'COMPLETE'));assert.equal(await page.locator('#modal').isHidden(),true);
  await page.evaluate(()=>fixture({ot_hold:true}));await draw();assert.match(await page.locator('#actions').innerText(),/Remove OT Hold/);assert.equal(await page.locator('#actions .done-control').count(),0);
  await page.evaluate(()=>openOtLifecycle(rid,'COMPLETE'));assert.equal(await page.locator('#modal').isHidden(),true);
  await page.evaluate(()=>fixture({request_status:'COMPLETED'}));await draw();assert.equal(await page.locator('#actions button').count(),0);
  await page.evaluate(()=>openOtLifecycle(rid,'HOLD'));assert.equal(await page.locator('#modal').isHidden(),true);
  await page.evaluate(()=>editSlot(sid));assert.equal(await page.locator('#modal').isHidden(),true);assert.match(await page.evaluate(()=>messages.at(-1)),/read-only/);
  await page.evaluate(()=>{$('#actions').innerHTML=slotCard(row,_schedule[0],true)+collapsedSlot(row,_schedule[0])});
  assert.equal(await page.locator('#actions .slot-row .COMPLETED').innerText(),'DONE');assert.equal(await page.locator('#actions .collapsed-slot.ot-done').count(),1);
  assert.equal(await page.locator('#actions [onclick^="postponeSlot"],#actions [onclick^="editSlot"],#actions [onclick^="clearSlot"],#actions [onclick^="reassignSlot"],#actions [onclick^="openOtLifecycle"]').count(),0);
  assert.match(await page.locator('#actions .slot-preview-card').textContent(),/Status: DONE/);
  for(const role of ['STAFF','ADMIN','WEBMASTER'])for(const date of ['2026-10-15','2026-10-16','2026-10-17']){
   await page.evaluate(({role,date})=>{user.role=role;_schedule[0].ot_date=date;window.isPastOtDate=value=>value<'2026-10-16';$('#actions').innerHTML=slotCard(row,_schedule[0],role!=='STAFF')},{role,date});
   assert.equal(await page.locator('#actions [onclick^="reassignSlot"]').count(),role==='WEBMASTER'&&date==='2026-10-15'?1:0);
   assert.equal(await page.locator('#actions [onclick^="openUndoDone"]').count(),role==='WEBMASTER'&&date<='2026-10-16'?1:0);
   assert.equal(await page.locator('#actions [onclick^="postponeSlot"],#actions [onclick^="editSlot"],#actions [onclick^="clearSlot"],#actions [onclick^="openOtLifecycle"]').count(),0,'Historical reorder does not unlock Done lifecycle/ordinary editing');
  }
  await page.evaluate(()=>{window.isPastOtDate=()=>false;_schedule[0].ot_date='2026-10-16'});
  for(const role of ['STAFF','ADMIN','WEBMASTER']){
   await page.evaluate(role=>{user.role=role;$('#actions').innerHTML=requestManagementActions({id:rid,status:'COMPLETED',assigned_slot_id:sid},role!=='STAFF')},role);
   assert.equal(await page.locator('#actions button').count(),0);
  }
  await page.evaluate(()=>{fixture({ot_hold:true,ot_hold_reason:'Synthetic hold reason'});$('#actions').innerHTML=slotCard(row,_schedule[0],true)+collapsedSlot(row,_schedule[0])});
  assert.equal(await page.locator('#actions .slot-row .OT-HOLD').innerText(),'OT HOLD');assert.equal(await page.locator('#actions .collapsed-slot.ot-hold').count(),1);
  assert.equal(await page.locator('#actions [onclick^="clearSlot"],#actions .done-control').count(),0);
  assert.equal(await page.locator('#actions [onclick^="postponeSlot"]').innerText(),'Choose New OT Date');assert.equal(await page.locator('#actions .hold-control').innerText(),'Remove OT Hold');
  assert.match(await page.locator('#actions .slot-preview-card').textContent(),/Status: OT HOLD/);
  await mkdir(qaDirectory,{recursive:true});
  await page.evaluate(()=>{$('#actions').innerHTML='<h1>Synthetic OT Hold preview</h1><div class="schedule old-style"><article class="session-card open"><div class="slot-grid">'+slotCard({...row,patient_name:'Synthetic Patient'},_schedule[0],true)+'</div></article></div>'});
  await page.screenshot({path:resolve(qaDirectory,'hold-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{row.patient_name='Synthetic Patient';openOtLifecycle(rid,'RELEASE_HOLD')});
  await page.screenshot({path:resolve(qaDirectory,'hold-mobile.png'),fullPage:true});await page.evaluate(()=>closeModal());await page.setViewportSize({width:1180,height:900});
  await page.evaluate(()=>{$('#actions').innerHTML=requestManagementActions({id:rid,status:'CONFIRMED',ot_hold:true,assigned_slot_id:sid},true)});
  assert.match(await page.locator('#actions').innerText(),/Confirm.*Edit Request/);assert.doesNotMatch(await page.locator('#actions').innerText(),/Request Move|Request Cancel|Reject/);
  await page.evaluate(()=>{fixture({_ic_edit_version:null});openOtLifecycle(rid,'HOLD')});assert.equal(await page.locator('#modal').isHidden(),true);assert.match(await page.evaluate(()=>messages.at(-1)),/Reload/);

  // A modal captures its record version and restore generation before later reads mutate the cache.
  await page.evaluate(()=>{fixture();openOtLifecycle(rid,'HOLD')});assert.equal(await page.locator('#modalBody img').count(),0);
  await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator('#otLifecycleMessage').innerText(),/reason/);
  await page.locator('[name="reason"]').fill('  Synthetic hold reason  ');
  await page.evaluate(()=>{row._ic_generation=sid;row._ic_edit_version='2026-10-16T04:00:00Z';pauseWrite=true;window.pending=$('#otLifecycleForm').onsubmit({preventDefault(){}})});
  await page.waitForFunction(()=>typeof releaseWrite==='function');assert.equal(await page.locator('#otLifecycleForm [type="submit"]').isDisabled(),true);
  await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));assert.equal(await page.evaluate(()=>calls.length),1);
  let sent=await page.evaluate(()=>calls[0].args);
  assert.equal(sent.p_generation,'44444444-4444-4444-8444-444444444444');assert.equal(sent.p_expected_version,'2026-10-16T01:02:03.123456Z');
  assert.equal(sent.p_slot_id,'33333333-3333-4333-8333-333333333333');assert.equal(sent.p_request_id,'22222222-2222-4222-8222-222222222222');assert.equal(sent.p_reason,'Synthetic hold reason');
  assert.deepEqual(Object.keys(sent).sort(),['p_session_token','p_request_id','p_slot_id','p_action','p_reason','p_generation','p_expected_version'].sort());
  await page.evaluate(()=>releaseWrite());await page.evaluate(()=>pending);assert.equal(await page.locator('#modal').isHidden(),true);assert.equal(await page.evaluate(()=>refreshes),1);
  await page.evaluate(()=>openOtLifecycle(rid,'HOLD'));assert.equal(await page.locator('#modal').isHidden(),true);assert.equal(await page.evaluate(()=>calls.length),1);

  // Stale/uncertain failures consume the selection. Neither a double submit nor reopening repeats it.
  await page.evaluate(()=>{fixture();failWrite=true;openOtLifecycle(rid,'HOLD')});await page.locator('[name="reason"]').fill('Synthetic reason');
  await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));assert.match(await page.locator('#otLifecycleMessage').innerText(),/Reload and check.*not be repeated automatically/);
  await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));assert.equal(await page.evaluate(()=>calls.length),1);
  await page.evaluate(()=>{closeModal();openOtLifecycle(rid,'HOLD')});assert.equal(await page.locator('#modal').isHidden(),true);assert.equal(await page.evaluate(()=>calls.length),1);
  for(const change of ['token','role']){
   await page.evaluate(()=>{fixture();openOtLifecycle(rid,'HOLD')});await page.locator('[name="reason"]').fill('Synthetic reason');
   await page.evaluate(change=>{if(change==='token')token='changed';else user.role='STAFF';return $('#otLifecycleForm').onsubmit({preventDefault(){}})},change);
   assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator('#otLifecycleMessage').innerText(),/sign in again/);
  }
  // A direct jump to the schedule may leave currentPage stale; the connected view selects the patient.
  await page.evaluate(()=>{fixture();currentPage='postponed';_otHoldRows=[{id:rid,slot_id:gen,ot_hold:true}];openOtLifecycle(rid,'HOLD')});
  assert.equal(await page.locator('#otLifecycleForm').count(),1);await page.locator('[name="reason"]').fill('Synthetic direct schedule jump');
  await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));assert.equal(await page.evaluate(()=>calls[0].args.p_slot_id),'33333333-3333-4333-8333-333333333333');
  // Resolving an earlier action cannot close a different modal opened while it was in flight.
  await page.evaluate(()=>{fixture();pauseWrite=true;openOtLifecycle(rid,'HOLD')});await page.locator('[name="reason"]').fill('Synthetic in-flight view change');
  await page.evaluate(()=>{window.pendingReplacement=$('#otLifecycleForm').onsubmit({preventDefault(){}})});await page.waitForFunction(()=>typeof releaseWrite==='function');
  await page.evaluate(()=>{modal('<div id="replacementModal">Different action</div>');releaseWrite()});await page.evaluate(()=>pendingReplacement);
  assert.equal(await page.locator('#replacementModal').innerText(),'Different action');assert.equal(await page.locator('#modal').isVisible(),true);
  await page.evaluate(()=>{fixture();openOtLifecycle(rid,'COMPLETE')});assert.equal(await page.locator('[name="reason"]').count(),0);
  await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));assert.equal(await page.evaluate(()=>calls.length),0);
  await page.locator('[name="confirmed"]').check();await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));
  sent=await page.evaluate(()=>calls[0].args);assert.equal(sent.p_action,'COMPLETE');assert.equal(sent.p_reason,'');
  await page.evaluate(()=>{fixture({ot_hold:true});openOtLifecycle(rid,'RELEASE_HOLD')});await page.locator('[name="reason"]').fill('Operation is going ahead');
  await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));assert.equal(await page.evaluate(()=>calls[0].args.p_action),'RELEASE_HOLD');

  await page.evaluate(()=>{fixture();currentPage='postponed';return showOtHoldTab()});
  assert.match(await page.locator('h1').innerText(),/Postponed Management/);assert.equal(await page.locator('.ot-hold-tabs button').count(),2);
  assert.equal(await page.locator('.ot-hold-tabs button[aria-pressed="true"]').innerText(),'OT Hold');assert.equal(await page.locator('#otHoldRows script,#otHoldRows img').count(),0);
  assert.match(await page.locator('#otHoldRows').innerText(),/Synthetic <script>danger<\/script>/);
  await page.locator('#otHoldRows button').filter({hasText:'Remove OT Hold'}).click();assert.equal(await page.locator('#otLifecycleForm').count(),1);
  await page.locator('[name="reason"]').fill('Synthetic tab removal');await page.evaluate(()=>$('#otLifecycleForm').onsubmit({preventDefault(){}}));
  assert.equal(await page.evaluate(()=>calls.find(c=>c.name==='orl_ic_ot_lifecycle').args.p_slot_id),'33333333-3333-4333-8333-333333333333');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.evaluate(()=>{fixture();user.role='STAFF';return showOtHoldTab()});assert.equal(await page.evaluate(()=>calls.length),0);
  await page.evaluate(()=>{fixture();pauseRead=true;currentPage='postponed';window.pendingTab=showOtHoldTab()});await page.waitForFunction(()=>typeof releaseRead==='function');
  await page.evaluate(()=>{$('#content').innerHTML='<p id="replacement">Replacement page</p>';releaseRead()});await page.evaluate(()=>pendingTab);assert.equal(await page.locator('#replacement').innerText(),'Replacement page');
 }finally{await browser.close()}
});

test('Management starts Pending, duplicate lookup sits under MRN, and Postpone choices show a smaller admission date',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:900}});await page.route('**/*',route=>route.abort());await page.setContent('<main id="content"></main>');
  for(const file of ['styles.css','schedule.css','mobile.css','booking-workflow.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  const extract=name=>{let start=app.lastIndexOf('function '+name+'(');assert.ok(start>=0,name);if(app.slice(start-6,start)==='async ')start-=6;const rest=app.slice(start),end=rest.search(/\n(?:async )?function /);return end<0?rest:rest.slice(0,end)};
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];window.esc=x=>String(x??'');window.head=(title,text)=>`<h1>${title}</h1><p>${text}</p>`;
   window.user={role:'ADMIN'};window.token='synthetic';window.drawRequests=async()=>{window.seenFilter=$('#rf').value};window.loadBookingMoves=async()=>{};
   window.ageFields=()=>'<div class="field"><label>Age<input name="age"></label></div>';window.subspecialtyOptions=()=>['Gen ORL'];window.isPastOtDate=()=>false;
   window.formatSystemDate=x=>x;window.admissionDate=()=> '2026-10-19';window._holidays=[];
   Object.defineProperty(window,'status',{value:x=>String(x),configurable:true,writable:true});
   window.rpc=async()=>[{ot_date:'2026-10-20',status:'ACTIVE',day_name:'Tuesday',slots:[{id:'synthetic-slot',type:'MAIN',number:1,status:'AVAILABLE'}]}];
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')});
  for(const name of ['field','requestList','requestFormMarkup','renderDuplicateWarning','loadPostponeSlots'])await page.addScriptTag({content:extract(name)});
  await page.evaluate(()=>requestList(true));assert.equal(await page.locator('#rf').inputValue(),'PENDING');assert.equal(await page.evaluate(()=>seenFilter),'PENDING');
  await page.evaluate(()=>requestList(false));assert.equal(await page.locator('#rf').inputValue(),'');
  await page.evaluate(()=>{$('#content').innerHTML=requestFormMarkup()});
  assert.equal(await page.locator('[name="mrn"]').evaluate(el=>el.closest('.field').querySelector('#duplicateCheck')?.parentElement===el.closest('.field')),true);
  assert.equal(await page.locator('#duplicateCheck').evaluate(el=>el.previousElementSibling?.tagName),'LABEL');
  await page.evaluate(()=>{renderDuplicateWarning({exact_count:0,matches:[{id:'22222222-2222-4222-8222-222222222222',request_number:'SYNTHETIC-001',status:'SCHEDULED',patient_name:'Synthetic Patient',surgery:'SYNTHETIC PROCEDURE',ot_date:'2026-10-20',exact:false}]});$('[name="mrn"]').value='TEST-MRN'});
  await mkdir(qaDirectory,{recursive:true});await page.screenshot({path:resolve(qaDirectory,'mrn-notice.png'),fullPage:true});
  await page.evaluate(()=>{$('#content').innerHTML='<input id="postYear" value="2026"><input id="postMonth" value="10"><div id="postSlots"></div>';return loadPostponeSlots()});
  assert.equal(await page.locator('#postSlots .post-admission').count(),1);assert.equal(await page.locator('#postSlots .post-admission').evaluate(el=>el.tagName),'SMALL');
  assert.match(await page.locator('#postSlots .post-admission').innerText(),/Admission.*2026-10-19/);
  await page.screenshot({path:resolve(qaDirectory,'postpone-admission.png'),fullPage:true});
 }finally{await browser.close()}
});
