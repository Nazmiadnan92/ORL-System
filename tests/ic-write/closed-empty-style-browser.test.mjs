import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('empty Closed slots share stripes across stored Closed and past-date closure without altering patients or availability',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:950},timezoneId:'America/Los_Angeles'});
  await page.clock.install({time:new Date('2026-10-18T04:00:00Z')});await page.route('**/*',r=>r.abort());
  await page.setContent('<main><section class="session-card past open"><div id="detail" class="slot-grid"></div><div id="compact"></div></section></main>');
  for(const file of ['styles.css','schedule.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.user={role:'WEBMASTER'};window.token='synthetic';
   window.esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.patientNameCase=x=>x||'';window.clinicalUpper=x=>x||'';window.patientAgeFromIc=()=> '—';window.patientAgeText=()=> '—';window.maskPatientIc=()=> '—';
   window.protectedIcEnabled=()=>true;window.canPickSlot=()=>false;window.directRequestAllowed=()=>false;
   window.otLifecycleActions=()=>'';window.pastCaseActions=()=>'';window.slotPreview=()=>'';
   Object.defineProperty(window,'status',{configurable:true,writable:true,value:x=>`<span class="badge ${esc(x)}">${esc(x)}</span>`});
   window.fixture=(date,stored,type,occupied=false,state='SCHEDULED')=>{
    window.day={ot_date:date,status:'ACTIVE',session_id:'synthetic-day'};
    window.slot={id:'synthetic-slot',type,number:5,status:stored,request_id:occupied?'synthetic-request':null,patient_name:occupied?'Synthetic Patient':null,
     request_status:occupied?state:null,deletion_status:'',ot_hold:state==='HOLD',mrn:'SYNTHETIC',sub_specialty:'Gen ORL'};
   };
  });
  const helpers=(await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')).split('function refreshPastOtCards')[0];
  await page.addScriptTag({content:helpers});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  for(const name of ['slotCard','collapsedSlot']){
   const start=app.lastIndexOf('function '+name+'('),rest=app.slice(start),end=rest.search(/\n(?:async )?function /);assert.ok(start>=0);
   await page.addScriptTag({content:end<0?rest:rest.slice(0,end)});
  }
  const draw=()=>page.evaluate(()=>{
   document.querySelector('.session-card').classList.toggle('past',isPastOtDate(day.ot_date));
   $('#detail').innerHTML=slotCard(slot,day,user.role!=='STAFF');$('#compact').innerHTML=collapsedSlot(slot,day);
  });
  const pattern=selector=>page.locator(selector).evaluate(el=>getComputedStyle(el).backgroundImage);
  let expected;
  for(const role of ['STAFF','ADMIN','WEBMASTER'])for(const type of ['MAIN','SPECIAL'])for(const date of ['2026-10-17','2026-10-18','2026-10-19'])for(const stored of ['AVAILABLE','CLOSED']){
   await page.evaluate(({role,type,date,stored})=>{user.role=role;fixture(date,stored,type)},{role,type,date,stored});
   const before=await page.evaluate(()=>JSON.stringify({slot,day}));await draw();
   const closed=stored==='CLOSED'||date==='2026-10-17';
   assert.equal(await page.locator('#detail .closed-empty').count(),closed?1:0);
   assert.equal(await page.locator('#compact .closed-empty').count(),closed?1:0);
   assert.equal(await page.locator('#detail .badge.CLOSED').count(),closed?1:0);
   const detail=await pattern('#detail .slot-row'),compact=await pattern('#compact .collapsed-slot');
   if(closed){
    assert.match(detail,/repeating-linear-gradient/);expected??=detail;assert.equal(detail,expected);assert.equal(compact,expected);
    await page.locator('#compact .collapsed-slot').hover();assert.equal(await pattern('#compact .collapsed-slot'),expected,'Hover retains stripe');
   }else{assert.equal(detail,'none');assert.equal(compact,'none')}
   assert.equal(await page.evaluate(()=>JSON.stringify({slot,day})),before,'Rendering never writes stored slot status or patient data');
  }
  for(const [stored,state,colour] of [['CONFIRMED','SCHEDULED','rgb(239, 252, 244)'],['RESERVED','CONFIRMED','rgb(255, 246, 217)'],['CONFIRMED','COMPLETED','rgb(237, 242, 246)'],['CONFIRMED','HOLD','rgb(255, 244, 220)']]){
   await page.evaluate(({stored,state})=>fixture('2026-10-17',stored,'MAIN',true,state),{stored,state});await draw();
   assert.equal(await page.locator('.closed-empty').count(),0,'Occupied records never receive the empty-slot overlay');
   assert.equal(await pattern('#detail .slot-row'),'none');
   assert.equal(await page.locator('#detail .slot-row').evaluate(el=>getComputedStyle(el).backgroundColor),colour);
  }
  // A missing display name does not make a linked patient slot unoccupied.
  await page.evaluate(()=>{fixture('2026-10-17','CONFIRMED','MAIN',true);slot.patient_name=null});await draw();assert.equal(await page.locator('.closed-empty').count(),0);
  // Malaysia midnight switches only the display state, even in a non-Malaysia browser.
  await page.evaluate(()=>fixture('2026-10-18','AVAILABLE','MAIN'));await draw();assert.equal(await page.locator('.closed-empty').count(),0);
  await page.clock.setSystemTime(new Date('2026-10-18T16:00:00Z'));await draw();assert.equal(await page.locator('.closed-empty').count(),2);
  assert.equal(await page.evaluate(()=>slot.status),'AVAILABLE');
  await page.evaluate(()=>{
   fixture('2026-10-17','AVAILABLE','MAIN');
   $('#detail').innerHTML=[5,6,7,8].map(n=>slotCard({...slot,number:n,status:n===5?'AVAILABLE':'CLOSED'},day,true)).join('');
   $('#compact').innerHTML=[5,6,7,8].map(n=>collapsedSlot({...slot,number:n,status:n===5?'AVAILABLE':'CLOSED'},day)).join(' ');
  });
  assert.equal(await page.locator('#detail .closed-empty').count(),4);
  if(process.env.ORL_CLOSED_EMPTY_QA){await mkdir(process.env.ORL_CLOSED_EMPTY_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_CLOSED_EMPTY_QA,'closed-empty-desktop.png'),fullPage:true})}
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await pattern('#detail .slot-row:first-child'),expected);
  if(process.env.ORL_CLOSED_EMPTY_QA)await page.screenshot({path:resolve(process.env.ORL_CLOSED_EMPTY_QA,'closed-empty-mobile.png'),fullPage:true});
 }finally{await browser.close()}
});
