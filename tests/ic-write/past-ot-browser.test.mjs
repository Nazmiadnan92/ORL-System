import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
test('past OT uses Malaysia midnight, grey cards and PAST, keeps history/Print/View OT and hides all new booking choices',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:1000},timezoneId:'America/Los_Angeles'});
  await page.clock.install({time:new Date('2026-10-08T15:59:00Z')});await page.route('**/*',r=>r.abort());
  await page.setContent('<main><div id="specialDays"></div><div id="scheduleList" class="schedule old-style"></div></main>');
  for(const file of ['styles.css','schedule.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];
   window.currentPage='schedule';window.user={role:'WEBMASTER'};window.pendingRequest=null;
   window.esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
   Object.defineProperty(window,'status',{writable:true,configurable:true,value:()=>''});
   window.formatSystemDate=x=>x;window.admissionDate=x=>x;window.patientNameCase=x=>x;window.clinicalUpper=x=>x;
   window.patientAgeFromIc=()=>20;window.patientAgeText=()=> '20 years';window.maskPatientIc=()=> '900101-**-****';
   window.protectedIcEnabled=()=>true;window.slotPreview=()=>'<span class="slot-preview-card">Synthetic historical patient</span>';
   window.makeDay=(date,state='ACTIVE',special='')=>({ot_date:date,day_name:'Synthetic day',session_id:date,status:state,special_title:special,holiday_name:state==='HOLIDAY'?'Synthetic holiday':'',
    slots:[{id:date+'-1',type:'MAIN',number:1,status:'AVAILABLE'},{id:date+'-2',type:'SPECIAL',number:1,status:'AVAILABLE'},
     {id:date+'-3',type:'MAIN',number:2,status:'CONFIRMED',request_status:'SCHEDULED',request_id:'synthetic',patient_name:'Synthetic historical patient',mrn:'TEST-ONLY',patient_ic:'900101-**-****',sub_specialty:'Gen ORL'}]});
   window._schedule=[makeDay('2026-10-07'),makeDay('2026-10-08'),makeDay('2026-10-09','ACTIVE','Special OT Day'),makeDay('2026-10-06','HOLIDAY')];window._holidays=[];
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  const extract=name=>{const start=app.lastIndexOf('function '+name+'('),rest=app.slice(start),end=rest.search(/\n(?:async )?function /);assert.ok(start>=0);return end<0?rest:rest.slice(0,end)};
  for(const name of ['status','canPickSlot','directRequestAllowed','sessionAvailability','specialDayAvailability','collapsedSlot','slotCard','scheduleCard','toggleOT'])await page.addScriptTag({content:extract(name)});
  const draw=()=>page.evaluate(()=>{$('#scheduleList').innerHTML=_schedule.map(s=>scheduleCard(s,[])).join('')});
  for(const role of ['STAFF','ADMIN','WEBMASTER']){
   await page.evaluate(role=>user={role},role);await draw();
   const past=page.locator('#d-2026-10-07');assert.equal(await past.locator('.badge.PAST').count(),1);
   assert.equal(await past.locator('[onclick^="requestSlot"],[onclick^="assignSlot"],[onclick^="setSession"],[onclick^="setSlotClosed"]').count(),0);
   assert.equal(await past.locator('[onclick^="generateOtList"]').count(),role==='STAFF'?0:1);
   assert.equal(await past.locator('.has-preview').count(),1);assert.match(await past.innerText(),/closed to new requests/);
   assert.equal(await page.locator('#d-2026-10-08.past').count(),0);assert.ok(await page.locator('#d-2026-10-08 [onclick^="requestSlot"]').count()>0);
   assert.equal(await page.locator('#d-2026-10-09 .badge.PAST').count(),0);
   assert.equal(await page.locator('#d-2026-10-06 .badge.HOLIDAY').count(),1);
   const style=await past.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,top:getComputedStyle(el).borderTopColor}));
   assert.deepEqual(style,{bg:'rgb(241, 243, 245)',top:'rgb(75, 85, 99)'});
  }
  assert.equal(await page.evaluate(()=>isPastOtDate('2026-10-08',new Date('2026-10-08T15:59:59Z'))),false);
  assert.equal(await page.evaluate(()=>isPastOtDate('2026-10-08',new Date('2026-10-08T16:00:00Z'))),true);
  assert.equal(await page.evaluate(()=>isPastOtDate('2026-12-31',new Date('2026-12-31T16:00:00Z'))),true);
  assert.equal(await page.evaluate(()=>isPastOtDate('2028-02-29',new Date('2028-02-29T16:00:00Z'))),true);
  await page.evaluate(()=>{pendingRequest='synthetic';});await draw();
  assert.equal(await page.locator('#d-2026-10-07 [onclick^="assignSlot"]').count(),0);
  assert.ok(await page.locator('#d-2026-10-08 [onclick^="assignSlot"]').count()>0);
  await page.evaluate(()=>{pendingRequest=null});await draw();
  if(process.env.ORL_PAST_QA){await mkdir(process.env.ORL_PAST_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_PAST_QA,'past-ot-desktop.png'),fullPage:true})}
  await page.locator('#d-2026-10-08 .session-toggle').click();assert.equal(await page.locator('#d-2026-10-08.open').count(),1);
  const before=await page.evaluate(()=>JSON.stringify(_schedule));
  await page.clock.setSystemTime(new Date('2026-10-08T16:00:00Z'));await page.evaluate(()=>refreshPastOtCards());
  assert.equal(await page.locator('#d-2026-10-08.past.open').count(),1);
  assert.equal(await page.locator('#d-2026-10-08 [onclick^="requestSlot"]').count(),0);
  assert.equal(await page.locator('#d-2026-10-09.past').count(),0);
  assert.equal(await page.evaluate(()=>JSON.stringify(_schedule)),before,'No stored status or patient data is changed');
  await page.setViewportSize({width:390,height:844});await page.locator('#d-2026-10-08 .session-toggle').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ORL_PAST_QA)await page.screenshot({path:resolve(process.env.ORL_PAST_QA,'past-ot-mobile.png'),fullPage:true});
 }finally{await browser.close()}
});
