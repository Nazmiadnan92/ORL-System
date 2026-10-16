import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('Staff views Special slots, patients and availability without Special request or assignment controls',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:900},timezoneId:'Asia/Kuala_Lumpur'});
  await page.clock.install({time:new Date('2026-10-11T04:00:00Z')});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<main><div id="monthSummary"></div><div id="specialDays"></div><div id="scheduleList" class="schedule old-style"></div></main>');
  for(const file of ['styles.css','schedule.css','mobile.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];
   window.user={role:'STAFF'};window.pendingRequest=null;window.currentPage='schedule';
   window.esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
   Object.defineProperty(window,'status',{value:()=>'',writable:true,configurable:true});
   window.formatSystemDate=x=>x;window.admissionDate=x=>x;window.patientNameCase=x=>x;window.clinicalUpper=x=>x;
   window.patientAgeFromIc=()=>20;window.patientAgeText=()=> '20 years';window.maskPatientIc=()=> '900101-**-****';
   window.protectedIcEnabled=()=>true;window._holidays=[];window.messages=[];window.toast=x=>messages.push(x);
   window.modal=()=>{throw Error('Staff must not open a Special-slot request form')};
   const patient={patient_name:'Synthetic Special Patient',mrn:'TEST-ONLY',patient_ic:'900101-**-****',age:20,
    surgery:'TEST PROCEDURE',diagnosis:'TEST DIAGNOSIS',doctor:'Test Doctor',sub_specialty:'Gen ORL',request_id:'synthetic-request'};
   window.day={ot_date:'2027-01-10',day_name:'Sunday',session_id:'synthetic-session',status:'ACTIVE',special_title:'Synthetic Special OT',slots:[
    {id:'main-1',type:'MAIN',number:1,status:'AVAILABLE'},
    ...['AVAILABLE','CONFIRMED','RESERVED','CLOSED','CONFIRMED','AVAILABLE'].map((state,index)=>({
     ...(index===1||index===2||index===4?patient:{}),id:'special-'+(index+1),type:'SPECIAL',number:index+1,status:state,
     request_status:index===4?'CANCELLED':index===2?'CONFIRMED':index===1?'SCHEDULED':null}))]};
   window._schedule=[day];
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  await page.addScriptTag({content:await readFile(new URL('../../docs/ot-lifecycle.js',import.meta.url),'utf8')});
  const extract=name=>{
   const start=app.lastIndexOf('function '+name+'(');assert.ok(start>=0);
   const rest=app.slice(start),end=rest.search(/\n(?:async )?function /);
   return end<0?rest:rest.slice(0,end);
  };
  for(const name of ['status','canPickSlot','directRequestAllowed','requestSlot','monthAvailability','sessionAvailability',
   'malaysiaToday','specialDayAvailability','renderSpecialDays','slotPreview','collapsedSlot','slotCard','scheduleCard','toggleOT'])await page.addScriptTag({content:extract(name)});
  const draw=()=>page.evaluate(()=>{
   $('#monthSummary').innerHTML=monthAvailability({main_available:1,special_available:2});
   $('#specialDays').innerHTML=renderSpecialDays([{date:day.ot_date,title:day.special_title,day_name:day.day_name,status:'ACTIVE',main_available:1,main_total:1,main_closed:0,special_available:2,special_total:6,special_closed:1}]);
   $('#scheduleList').innerHTML=scheduleCard(day,[]);
  });
  await draw();
  assert.match(await page.locator('#monthSummary').innerText(),/Special: 2 Available/);
  assert.match(await page.locator('.session-summary').innerText(),/Special: 2 Available/);
  assert.match(await page.locator('#specialDays').innerText(),/Special: 2 Available/);
  assert.equal(await page.locator('.collapsed-slot.special-slot').count(),6);
  assert.equal(await page.locator('.collapsed-slot.special-slot.has-preview').count(),3);
  assert.equal(await page.locator('.special-slot.click-request,.special-slot.selectable').count(),0);
  assert.equal(await page.locator('[onclick="requestSlot(\'main-1\')"]').count(),2);
  await page.locator('.session-toggle').click();
  const specialRows=page.locator('.slot-row').filter({has:page.locator('.slot-title b', {hasText:'Special Slot'})});
  assert.equal(await specialRows.count(),6);
  assert.match(await specialRows.nth(1).innerText(),/Synthetic Special Patient/);
  assert.match(await specialRows.nth(1).innerText(),/900101-\*\*-\*\*\*\*/);
  assert.match(await specialRows.nth(2).innerText(),/PENDING APPROVAL/);
  assert.match(await specialRows.nth(3).innerText(),/CLOSED/);
  assert.match(await specialRows.nth(4).innerText(),/CANCELLED/);
  assert.equal(await specialRows.locator('[onclick^="requestSlot"],[onclick^="assignSlot"],[onclick^="revealPatientIc"]').count(),0);
  await page.evaluate(()=>requestSlot('special-1'));
  assert.match(await page.evaluate(()=>messages.at(-1)),/not available for a new request/);
  await page.evaluate(()=>{pendingRequest='synthetic-pending'});await draw();
  assert.equal(await page.locator('.special-slot.selectable').count(),0);
  assert.equal(await page.locator('[onclick="assignSlot(\'main-1\')"]').count(),2);
  assert.equal(await page.evaluate(()=>canPickSlot(day.slots[1],day)),false);
  for(const role of ['ADMIN','WEBMASTER']){
   await page.evaluate(role=>{user.role=role;pendingRequest=null},role);await draw();
   assert.equal(await page.locator('.special-slot.click-request').count(),2);
   await page.evaluate(()=>{pendingRequest='synthetic-pending'});await draw();
   assert.equal(await page.locator('.special-slot.selectable').count(),2);
  }
  await page.evaluate(()=>{user.role='STAFF';pendingRequest=null});await draw();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('.collapsed-slot.special-slot').count(),6);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await browser.close()}
});
