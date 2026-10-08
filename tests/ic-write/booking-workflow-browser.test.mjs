import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
test('booking UI: snapshots, same-date rejection, date-only Staff proposals, explicit approvals and uncertain-write reconciliation',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:900}});await page.route('**/*',r=>r.abort());
  await page.setContent('<div class="modal"><div class="dialog"><div id="modalBody"></div></div></div><section id="bookingMoves"></section>');
  for(const file of ['styles.css','schedule.css','booking-workflow.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.token='synthetic-session';window.user={role:'ADMIN'};
   window.esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
   window.formatSystemDate=v=>v||'';Object.defineProperty(window,'status',{value:v=>esc(v),writable:true,configurable:true});window.confirm=()=>true;
   window.toast=v=>messages.push(v);window.go=v=>navigation.push(v);
   window.modal=html=>{$('.modal').hidden=false;$('#modalBody').innerHTML=html};window.closeModal=()=>{$('.modal').hidden=true;$('#modalBody').textContent=''};
   window.messages=[];window.navigation=[];window.calls=[];window.fail=false;window.malformed=false;
   window.rid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';window.gen='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
   window.mid='cccccccc-cccc-4ccc-8ccc-cccccccccccc';window.sid='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
   window.view={request_id:rid,request_number:'SYNTHETIC-01',patient_name:'Synthetic <img src=x>',mrn:'TEST-ONLY',surgery:'Synthetic procedure',
    generation:gen,request_version:'2026-10-08T01:02:03.123456Z',status:'APPROVED',from_slot_id:sid,from_date:'2027-01-13'};
   window.slots=Array.from({length:6},(_,i)=>({id:'eeeeeeee-eeee-4eee-8eee-'+String(i+1).padStart(12,'0'),number:i+1,type:'SPECIAL',status:i===4?'CLOSED':'AVAILABLE',_ic_generation:gen}));
   window.scheduleRows=[{ot_date:'2027-01-10',day_name:'Sunday',status:'ACTIVE',special_title:'RHINO <b>Special</b> Day',slots}];
   window.dateRows=['2027-01-10','2027-01-13','2027-01-17','2027-01-20'].map((ot_date,i)=>({ot_date,day_name:'Synthetic day',status:'ACTIVE',special_title:i===0?'RHINO Special Day':'',generation:gen,available_slots:i===3?0:2}));
   window.moves=[];window.rpc=async(name,args)=>{
    calls.push({name,args});
    if(name==='orl_booking_assign_view'||name==='orl_booking_move_view')return structuredClone(view);
    if(name==='orl_get_schedule')return structuredClone(scheduleRows);
    if(name==='orl_booking_move_dates')return structuredClone(dateRows);
    if(name==='orl_booking_move_list')return structuredClone(moves);
    if(fail)throw Error('Synthetic connection interrupted');
    if(malformed)return {};
    if(name==='orl_booking_assign_existing')return 'CONFIRMED';
    if(name==='orl_booking_move_request')return {id:mid,request_id:rid,generation:gen,status:'PENDING',target_date:args.p_target_date};
    if(name==='orl_booking_move_review')return {id:mid,request_id:rid,generation:gen,status:args.p_action==='REJECT'?'REJECTED':'APPROVED',target_slot_id:args.p_target_slot};
    throw Error('Unexpected fixture RPC '+name);
   };
  });
  const source=await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8');await page.addScriptTag({content:source});
  assert.deepEqual(await page.evaluate(()=>['2027-01-10','2027-01-13','2027-01-17'].map(d=>bookingMovement(view.from_date,d))),['REASSIGN','SAME_DATE','POSTPONE']);
  await page.evaluate(()=>openBookingAssign(rid));await page.waitForSelector('[data-booking-slot]');
  assert.equal(await page.locator('[data-booking-slot]').count(),6);assert.equal(await page.locator('.booking-special-title b').count(),0);
  assert.equal(await page.locator('.booking-context img').count(),0);assert.equal(await page.locator('[data-booking-slot]').nth(4).isDisabled(),true);
  if(process.env.ORL_BOOKING_QA){await mkdir(process.env.ORL_BOOKING_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_BOOKING_QA,'assign-desktop.png'),fullPage:true})}
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ORL_BOOKING_QA)await page.screenshot({path:resolve(process.env.ORL_BOOKING_QA,'assign-mobile.png'),fullPage:true});
  await page.locator('[data-booking-slot]').nth(5).click();
  let write=await page.evaluate(()=>calls.find(c=>c.name==='orl_booking_assign_existing').args);
  assert.equal(write.p_expected_version,'2026-10-08T01:02:03.123456Z');assert.equal(write.p_generation,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');assert.equal(write.p_target_slot.endsWith('000000000006'),true);
  assert.equal(Object.hasOwn(write,'patient_ic'),false);
  // An interrupted or malformed result consumes the UI selection. No auto retry.
  await page.evaluate(()=>{fail=true;return openBookingAssign(rid)});await page.waitForSelector('[data-booking-slot]');
  await page.locator('[data-booking-slot]').first().click();
  assert.match(await page.locator('#bookingOutcome').textContent(),/Do not repeat/);
  const writesBefore=await page.evaluate(()=>calls.length);
  await page.evaluate(()=>bookingCommit(bookingContext,{slot:slots[0].id}));assert.equal(await page.evaluate(()=>calls.length),writesBefore);
  await page.evaluate(()=>{fail=false;malformed=true;return openBookingAssign(rid)});await page.waitForSelector('[data-booking-slot]');await page.locator('[data-booking-slot]').first().click();
  assert.match(await page.locator('#bookingOutcome').textContent(),/Result not confirmed/);
  await page.evaluate(()=>{malformed=false;user.role='STAFF';closeModal();calls=[];return openBookingAssign(rid)});
  assert.equal(await page.evaluate(()=>calls.length),0);
  // Staff chooses a date, never sees/picks a Special slot; server summary includes special-only capacity.
  await page.evaluate(()=>openBookingMove(rid));await page.waitForSelector('[data-booking-date]');
  assert.equal(await page.locator('[data-booking-slot]').count(),0);
  assert.equal(await page.locator('[data-booking-date="2027-01-13"]').isDisabled(),true);
  assert.equal(await page.locator('[data-booking-date="2027-01-20"]').isDisabled(),true);
  await page.locator('#bookingReason').fill('Bring forward to special day');
  await page.locator('[data-booking-date="2027-01-10"]').click();
  write=await page.evaluate(()=>calls.find(c=>c.name==='orl_booking_move_request').args);
  assert.equal(write.p_target_date,'2027-01-10');assert.equal(Object.hasOwn(write,'p_target_slot'),false);
  assert.equal(write.p_expected_from_slot,'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(await page.evaluate(()=>calls.some(c=>/assign_existing|move_review/.test(c.name))),false);
  // Changed login cannot reuse a modal. Wrong generation never produces a bookable target.
  await page.evaluate(()=>openBookingMove(rid));await page.waitForSelector('[data-booking-date]');
  const beforeLogin=await page.evaluate(()=>calls.length);await page.evaluate(()=>{token='changed';return bookingCommit(bookingContext,{date:'2027-01-17'})});
  assert.equal(await page.evaluate(()=>calls.length),beforeLogin);
  await page.evaluate(()=>{token='synthetic-session';user.role='ADMIN';slots.forEach(x=>x._ic_generation='wrong');return openBookingAssign(rid)});
  await page.waitForFunction(()=>document.querySelector('#bookingDates').textContent.includes('No slots available'));
  assert.equal(await page.locator('[data-booking-slot]').count(),0);
  await page.evaluate(()=>{closeModal();slots.forEach(x=>x._ic_generation=gen);moves=[{...view,id:mid,status:'PENDING',target_date:'2027-01-10',move_version:'2026-10-08T02:03:04.987654Z',action:'REASSIGN',reason:'Synthetic move',requested_by_name:'Synthetic Staff'}];return loadBookingMoves()});
  await page.locator('#bookingMoves button').click();await page.waitForSelector('[data-booking-slot]');
  await page.locator('[data-booking-slot]').first().click();
  write=await page.evaluate(()=>calls.find(c=>c.name==='orl_booking_move_review').args);
  assert.equal(write.p_action,'APPROVE');assert.equal(write.p_expected_move_version,'2026-10-08T02:03:04.987654Z');assert.equal(write.p_expected_request_version,'2026-10-08T01:02:03.123456Z');
  // Actual duplicate renderer exposes no override; same-day submit rule is present in actual active form.
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  await page.addScriptTag({content:app.slice(app.indexOf('function renderDuplicateWarning('),app.indexOf('async function checkDuplicateRequest('))});
  await page.evaluate(()=>{modal('<div id="duplicateCheck"></div>');renderDuplicateWarning({exact_count:1,matches:[{id:rid,exact:true,ot_date:'2027-01-13',request_number:'Synthetic',status:'SCHEDULED',patient_name:'Synthetic',surgery:'Synthetic'}]})});
  assert.match(await page.locator('#duplicateCheck').textContent(),/Request Move/);assert.equal(await page.locator('[name="allow_duplicate"]').count(),0);
  const activeForm=app.slice(app.indexOf('function bindRequestForm('),app.indexOf('\nfunction submit(){',app.indexOf('function bindRequestForm(')));
  assert.match(activeForm,/x\.exact&&x\.ot_date===target\.date/);assert.match(activeForm,/data\.allow_duplicate=false/);
  await page.addScriptTag({content:app.split(/\r?\n/).find(l=>l.startsWith('async function loadPostponeSlots(){'))});
  await page.evaluate(()=>{modal('<input id="postYear" value="2027"><input id="postMonth" value="1"><div id="postSlots"></div>');return loadPostponeSlots()});
  assert.equal(await page.locator('#postSlots .post-date.special-day').count(),1);
  assert.equal(await page.locator('#postSlots .booking-special-title').count(),1);
  assert.equal(await page.locator('#postSlots .slot.special').count(),5); // Closed S5 is not selectable.
  assert.match(await page.locator('#postSlots').textContent(),/Special S6/);
  const index=await readFile(new URL('../../docs/index.html',import.meta.url),'utf8');
  assert.ok(index.indexOf('booking-workflow.js?v=001')<index.indexOf('app.js?v=081'));assert.match(index,/booking-workflow\.css\?v=001/);
 }finally{await browser.close()}
});
