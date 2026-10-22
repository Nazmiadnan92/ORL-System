import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('071 Pending assignment: one approval-and-assignment write, unchanged assigned Confirm flow, role/state guards and safe uncertain outcomes',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:940},timezoneId:'Asia/Kuala_Lumpur'});await page.route('**/*',route=>route.abort());
  await page.clock.install({time:new Date('2026-10-22T04:00:00Z')});
  await page.setContent('<div id="content"></div><div id="actionPreview"></div><div class="modal" hidden><div class="dialog"><button class="close" onclick="closeModal()">×</button><div id="modalBody"></div></div></div>');
  for(const file of ['styles.css','schedule.css','mobile.css','booking-workflow.css','day-notes.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
   window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.formatSystemDate=value=>value||'';window.patientNameCase=value=>value||'';window.clinicalUpper=value=>value||'';window.head=(title,sub)=>`<h1 class="title">${esc(title)}</h1><p class="sub">${esc(sub)}</p>`;
   Object.defineProperty(window,'status',{value:value=>`<span class="badge">${esc(value)}</span>`,writable:true,configurable:true});
   window.modal=html=>{$('.modal').hidden=false;$('#modalBody').innerHTML=html};window.closeModal=()=>{$('.modal').hidden=true;$('#modalBody').textContent=''};
   window.toast=message=>messages.push(message);window.go=dest=>navigation.push(dest);window.confirm=text=>{confirmations.push(text);return allowConfirm};
   window.fixture=(state='CONFIRMED',role='ADMIN')=>{
    closeModal();$('#actionPreview').textContent='';window.user={role};window.token=uuid(1);window.rid=uuid(2);window.gen=uuid(3);
    window.calls=[];window.messages=[];window.navigation=[];window.confirmations=[];window.allowConfirm=true;
    window.failWrite=false;window.badResult=false;window.pauseWrite=false;window.pauseRead=false;
    window.view={request_id:rid,request_number:'SYNTHETIC-001',patient_name:'Synthetic Patient A',mrn:'SYNTHETIC-MRN-A',surgery:'Synthetic procedure',status:state,generation:gen,request_version:'2026-10-22T01:02:03.123456Z'};
    window.slots=[{id:uuid(11),number:1,type:'MAIN',status:'AVAILABLE',_ic_generation:gen},{id:uuid(12),number:2,type:'SPECIAL',status:'AVAILABLE',_ic_generation:gen},{id:uuid(13),number:3,type:'MAIN',status:'CLOSED',_ic_generation:gen},{id:uuid(14),number:4,type:'MAIN',status:'CONFIRMED',_ic_generation:gen}];
    window.scheduleRows=[{session_id:uuid(20),ot_date:'2026-11-18',day_name:'Wednesday',status:'ACTIVE',special_title:'',slots,day_note:'No Otology cases on this date.',_day_note_owner:token,_day_note_revision:1,_day_note_generation:gen}];
    window.pendingRows=[{...view,id:rid,postpone_count:2,created_at:'2026-10-22T01:02:03Z',assigned_slot_id:null,deletion_status:''},
     {...view,id:uuid(4),request_number:'SYNTHETIC-002',patient_name:'Synthetic Patient B',mrn:'SYNTHETIC-MRN-B',created_at:'2026-10-22T00:02:03Z',assigned_slot_id:uuid(5),ot_date:'2026-11-18',slot_type:'MAIN',slot_number:5,postpone_count:0,deletion_status:''}];
   };
   window.rpc=async(name,args)=>{
    calls.push({name,args:JSON.parse(JSON.stringify(args))});
    if(name==='orl_booking_assign_view'){const captured=JSON.parse(JSON.stringify(view));if(pauseRead)await new Promise(resolve=>window.releaseRead=resolve);return captured}
    if(name==='orl_get_schedule')return JSON.parse(JSON.stringify(scheduleRows));
    if(name==='orl_get_requests')return JSON.parse(JSON.stringify(pendingRows));
    if(name==='orl_booking_move_list')return [];
    if(name==='orl_booking_assign_existing'){if(pauseWrite)await new Promise(resolve=>window.releaseWrite=resolve);if(failWrite)throw Error('Synthetic slot conflict or lost response.');return badResult?{}:'CONFIRMED'}
    throw Error('Unexpected RPC '+name);
   };
   fixture();
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')});
  await page.addScriptTag({content:await readFile(new URL('../../docs/day-notes.js',import.meta.url),'utf8')});
  await page.evaluate(()=>orlDayNotes.configure({getContext:()=>({token,role:user.role}),read:async()=>{},save:async()=>{},modal,closeModal}));
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  for(const name of ['requestManagementStatus','requestSlotCard','requestManagementActions','requestList','drawRequests']){
   const prefix=(name==='requestList'||name==='drawRequests'?'async ':'')+'function '+name+'(',start=app.lastIndexOf(prefix),tail=app.slice(start),end=tail.search(/\n(?:async )?function /);
   assert.ok(start>=0,name);await page.addScriptTag({content:tail.slice(0,end<0?undefined:end)});
  }
  const reset=(state='CONFIRMED',role='ADMIN')=>page.evaluate(({state,role})=>fixture(state,role),{state,role});
  const open=async()=>{await page.evaluate(()=>openBookingAssign(rid));await page.waitForSelector('[data-booking-slot]')};
  const writes=()=>page.evaluate(()=>calls.filter(call=>call.name==='orl_booking_assign_existing'));
  const draw=patch=>page.evaluate(patch=>{$('#actionPreview').innerHTML=requestManagementActions({...pendingRows[0],...patch},user.role!=='STAFF')},patch);
  for(const role of ['ADMIN','WEBMASTER','STAFF'])for(const state of ['CONFIRMED','APPROVED','SCHEDULED','COMPLETED','CANCELLED','REJECTED','DRAFT'])for(const assigned of [false,true]){
   await reset(state,role);await draw({assigned_slot_id:assigned?'00000000-0000-4000-8000-000000000005':null});
   const eligible=role!=='STAFF'&&['CONFIRMED','APPROVED'].includes(state)&&!assigned;
   assert.equal(await page.locator('#actionPreview [onclick^="openBookingAssign"]').count(),eligible?1:0,`${role} ${state} assigned=${assigned}`);
   assert.equal(await page.locator('#actionPreview button').filter({hasText:/^Confirm$/}).count(),role!=='STAFF'&&state==='CONFIRMED'&&assigned?1:0);
   if(role!=='STAFF'&&state==='CONFIRMED')assert.equal(await page.locator('#actionPreview button').filter({hasText:/^Reject$/}).count(),1,'Pending unassigned still offers Reject');
  }
  for(const patch of [{ot_hold:true},{deletion_status:'PENDING'},{status:'COMPLETED'},{status:'CANCELLED'}]){
   await reset();await draw(patch);assert.equal(await page.locator('#actionPreview [onclick^="openBookingAssign"]').count(),0);
   assert.equal(await page.locator('#actionPreview [onclick^="requestDeletion"]').count(),0);
  }
  for(const assigned of [false,true]){
   await reset('CONFIRMED','STAFF');await page.evaluate(assigned=>{$('#actionPreview').innerHTML=requestManagementActions({...pendingRows[0],assigned_slot_id:assigned?uuid(5):null},true)},assigned);
   assert.equal(await page.locator('#actionPreview [onclick^="openBookingAssign"],#actionPreview [onclick^="review("]').count(),0,'A caller-supplied admin=true must not expose privileged actions to Staff');
  }
  await reset();await draw({ot_hold:true,assigned_slot_id:'00000000-0000-4000-8000-000000000005'});
  assert.equal(await page.locator('#actionPreview [onclick^="openBookingAssign"]').count(),0);assert.equal(await page.locator('#actionPreview button').filter({hasText:/^Confirm$/}).count(),1,'Existing held assigned Confirm flow is retained');
  assert.equal(await page.locator('#actionPreview button').filter({hasText:/^Reject$/}).count(),0);
  await reset('CONFIRMED','WEBMASTER');await page.evaluate(()=>requestList(true));assert.equal(await page.locator('#rf').inputValue(),'PENDING');
  assert.equal(await page.locator('#requestRows tbody tr').count(),2,await page.locator('#requestRows').innerText());assert.equal(await page.locator('#requestRows [onclick^="openBookingAssign"]').innerText(),'Assign OT Slot');
  if(process.env.ORL_PENDING_ASSIGN_QA){
   await mkdir(process.env.ORL_PENDING_ASSIGN_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_PENDING_ASSIGN_QA,'management-desktop.png'),fullPage:true});
   await page.setViewportSize({width:390,height:844});await page.screenshot({path:resolve(process.env.ORL_PENDING_ASSIGN_QA,'management-mobile.png'),fullPage:true});
   await page.locator('#requestRows [onclick^="openBookingAssign"]').scrollIntoViewIfNeeded();await page.screenshot({path:resolve(process.env.ORL_PENDING_ASSIGN_QA,'management-actions-mobile.png'),fullPage:true});await page.setViewportSize({width:1280,height:940});
  }
  for(const role of ['ADMIN','WEBMASTER'])for(const state of ['CONFIRMED','APPROVED'])for(const target of [0,1]){
   await reset(state,role);await open();assert.equal((await writes()).length,0,'Opening/reviewing a picker must not approve anything');
   assert.match(await page.locator('.booking-assign-explanation').innerText(),state==='CONFIRMED'?/pending approval.*approve and assign it together.*Nothing changes/:/already approved/);
   assert.match(await page.locator('#bookingDates .ot-day-note').innerText(),/No Otology cases/);assert.equal(await page.locator('[data-booking-slot]').nth(2).isDisabled(),true);assert.equal(await page.locator('[data-booking-slot]').nth(3).isDisabled(),true);
   await page.locator('[data-booking-slot]').nth(target).click();const calls=await writes();assert.equal(calls.length,1);assert.equal(calls[0].args.p_target_slot,`00000000-0000-4000-8000-00000000001${target+1}`);
   assert.equal(calls[0].args.p_request_id,'00000000-0000-4000-8000-000000000002');assert.equal(calls[0].args.p_expected_version,'2026-10-22T01:02:03.123456Z');assert.equal(calls[0].args.p_generation,'00000000-0000-4000-8000-000000000003');
   assert.equal(await page.evaluate(()=>calls.some(call=>/orl_review_request|orl_confirm_request|orl_create_request/.test(call.name))),false,'One RPC, no separate frontend approval/create call');
   assert.match(await page.evaluate(()=>confirmations[0]),state==='CONFIRMED'?/Approve and assign.*saved together/:/Assign this approved request/);
   assert.deepEqual(await page.evaluate(()=>navigation),['management']);assert.match(await page.evaluate(()=>messages[0]),state==='CONFIRMED'?/approved and assigned/:/Approved request assigned/);
  }
  await reset();await open();await page.evaluate(()=>allowConfirm=false);await page.locator('[data-booking-slot]').first().click();assert.equal((await writes()).length,0);assert.equal(await page.locator('[data-booking-slot]').first().isDisabled(),false);
  await page.evaluate(()=>allowConfirm=true);await page.evaluate(()=>bookingCommit(bookingContext,{slot:slots[2].id}));assert.equal((await writes()).length,0);
  for(const invalid of [{status:'SCHEDULED'},{status:'DRAFT'},{status:'COMPLETED'},{ot_hold:true},{assigned_slot_id:'00000000-0000-4000-8000-000000000005'},{deletion_status:'PENDING'},{generation:'wrong'}]){
   await reset();await page.evaluate(patch=>Object.assign(view,patch),invalid);await page.evaluate(()=>openBookingAssign(rid));assert.equal(await page.locator('[data-booking-slot]').count(),0);assert.equal((await writes()).length,0);
  }
  await reset('CONFIRMED','STAFF');await page.evaluate(()=>openBookingAssign(rid));assert.equal(await page.evaluate(()=>calls.length),0);
  for(const change of ['owner','role','modal']){
   await reset();await open();await page.evaluate(change=>{if(change==='owner')token=uuid(99);else if(change==='role')user.role='STAFF';else modal('<p id="replacement">Keep this view</p>');return bookingCommit(bookingContext,{slot:slots[0].id})},change);assert.equal((await writes()).length,0);
  }
  for(const change of ['owner','role','modal']){
   await reset();await page.evaluate(()=>{pauseRead=true;window.pendingRead=openBookingAssign(rid)});await page.waitForFunction(()=>typeof releaseRead==='function');
   await page.evaluate(change=>{if(change==='owner')token=uuid(99);else if(change==='role')user.role='STAFF';else modal('<p id="replacement">Keep this view</p>');releaseRead()},change);await page.evaluate(()=>pendingRead);
   assert.equal(await page.locator('[data-booking-slot]').count(),0);assert.equal((await writes()).length,0);
  }
  for(const failure of ['failWrite','badResult']){
   await reset();await open();await page.evaluate(failure=>window[failure]=true,failure);await page.locator('[data-booking-slot]').first().click();assert.match(await page.locator('#bookingOutcome').innerText(),/Do not repeat/);
   await page.evaluate(()=>bookingCommit(bookingContext,{slot:slots[1].id}));assert.equal((await writes()).length,1);assert.deepEqual(await page.evaluate(()=>navigation),[]);assert.deepEqual(await page.evaluate(()=>messages),[]);
  }
  await reset();await open();await page.evaluate(()=>{pauseWrite=true;window.pendingWrite=bookingCommit(bookingContext,{slot:slots[0].id})});await page.waitForFunction(()=>typeof releaseWrite==='function');
  assert.deepEqual(await page.evaluate(()=>navigation),[]);assert.equal(await page.locator('[data-booking-slot]').first().isDisabled(),true);
  await page.evaluate(()=>{view.request_version='2026-10-22T09:00:00Z';view.generation=uuid(99);return bookingCommit(bookingContext,{slot:slots[1].id})});assert.equal((await writes()).length,1);
  await page.evaluate(()=>releaseWrite());await page.evaluate(()=>pendingWrite);assert.deepEqual(await page.evaluate(()=>navigation),['management']);assert.equal((await writes())[0].args.p_expected_version,'2026-10-22T01:02:03.123456Z');
  for(const change of ['owner','role','modal']){
   await reset();await open();await page.evaluate(()=>{pauseWrite=true;window.pendingChange=bookingCommit(bookingContext,{slot:slots[0].id})});await page.waitForFunction(()=>typeof releaseWrite==='function');
   await page.evaluate(change=>{if(change==='owner')token=uuid(99);else if(change==='role')user.role='STAFF';modal('<p id="replacement">Keep this view</p>');releaseWrite()},change);await page.evaluate(()=>pendingChange);
   assert.equal(await page.locator('#replacement').innerText(),'Keep this view');assert.deepEqual(await page.evaluate(()=>navigation),[]);assert.deepEqual(await page.evaluate(()=>messages),[]);
  }
  await reset();await page.evaluate(()=>{view.patient_name='<img src=x onerror=alert(1)> Synthetic';view.surgery='Synthetic <b>procedure</b>'});await open();assert.equal(await page.locator('.booking-context img,.booking-context b b').count(),0);
  await reset();await page.evaluate(()=>requestList(true));await open();await page.locator('#bookingMonth').fill('2026-11');await page.locator('#bookingMonth').dispatchEvent('change');await page.waitForSelector('[data-booking-slot]');await page.locator('#bookingMonth').blur();
  if(process.env.ORL_PENDING_ASSIGN_QA)await page.screenshot({path:resolve(process.env.ORL_PENDING_ASSIGN_QA,'assign-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if(process.env.ORL_PENDING_ASSIGN_QA)await page.screenshot({path:resolve(process.env.ORL_PENDING_ASSIGN_QA,'assign-mobile.png'),fullPage:true});
 }finally{await browser.close()}
});
