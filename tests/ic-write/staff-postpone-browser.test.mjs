import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('Staff postpones any creator to Main with unchanged cross-owner details; own clinical edits and Admin controls remain scoped',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:900},timezoneId:'Asia/Kuala_Lumpur'});
  await page.clock.install({time:new Date('2026-10-12T04:00:00Z')});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<div id="modal" class="modal" hidden><div class="dialog"><div id="modalBody"></div></div></div>');
  for(const file of ['styles.css','schedule.css','mobile.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.addScriptTag({content:(await readFile(new URL('../../docs/ic-client.mjs',import.meta.url),'utf8')).replace(/^export /gm,'')});
  await page.addScriptTag({content:await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  const extract=(source,name)=>{
   let start=source.lastIndexOf('function '+name+'(');assert.ok(start>=0,name);
   if(source.slice(start-6,start)==='async ')start-=6;
   const rest=source.slice(start),end=rest.search(/\n(?:async )?function /);
   return end<0?rest:rest.slice(0,end);
  };
  await page.addScriptTag({content:extract(await readFile(new URL('../../docs/clinical-features.js',import.meta.url),'utf8'),'ageFields')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];
   window.esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
   window.staffId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';window.otherId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
   window.rid='cccccccc-cccc-4ccc-8ccc-cccccccccccc';window.sourceId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
   window.mainId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';window.specialId='ffffffff-ffff-4fff-8fff-ffffffffffff';
   window.gen='11111111-1111-4111-8111-111111111111';window.token='22222222-2222-4222-8222-222222222222';
   window.user={role:'STAFF',user_id:staffId};window.messages=[];window.sends=[];window.refreshes=0;
   window.months=['January','February','March','April','May','June','July','August','September','October','November','December'];
   window.formatSystemDate=x=>x;window.protectedIcEnabled=()=>true;window.bindAgeToIc=()=>{};
   window.modal=html=>{$('#modalBody').innerHTML=html;$('#modal').hidden=false};
   window.closeModal=()=>{$('#modal').hidden=true};window.toast=x=>messages.push(x);
   window.reloadSchedule=async()=>{refreshes++};window.showPostponedPatient=async()=>true;window._scheduleYM={year:2027,month:1};
   window.fixture=(creator,creatorRole)=>{
    const record={id:sourceId,request_id:rid,type:'SPECIAL',number:1,status:'CONFIRMED',created_by:creator,created_by_role:creatorRole,
     patient_ic:'900101-**-****',age:36,age_months:0,patient_name:'Synthetic patient',mrn:'TEST-ONLY',surgery:'TEST SURGERY',diagnosis:'TEST DIAGNOSIS',
     doctor:'Test Doctor',specialist:'Test Specialist',sub_specialty:'Gen ORL',phone:'0',remark:'Synthetic remark',
     _ic_generation:gen,_ic_edit_version:'2026-10-12T01:02:03.123456+00:00'};
    window._schedule=[{ot_date:'2027-01-10',slots:[record]}];sends=[];messages=[];return record;
   };
   const route=createIcRpcRouter({session:()=>token,send:async(operation,payload)=>{
    if(operation==='PREPARE_CREATE')return {generation:gen};
    sends.push({operation,payload});return {result:user.role==='STAFF'?'RESERVED':'CONFIRMED'};
   },legacy:async(name)=>{
    if(name!=='orl_get_schedule')throw Error('Unexpected fixture read');
    return [{ot_date:'2027-01-13',day_name:'Wednesday',status:'ACTIVE',slots:[
     {id:mainId,type:'MAIN',number:1,status:'AVAILABLE'},
     {id:specialId,type:'SPECIAL',number:1,status:'AVAILABLE'}]}];
   }});
   window.protectedIcClient=async()=>({bindProtectedIcField,route});
  });
  for(const name of ['field','maskPatientIc','patientNameCase','clinicalUpper','normalizeClinicalFields','bindClinicalFormatting',
   'admissionDate','configureProtectedIcForm','protectedIcArgs','rpc','postponeSlot','loadPostponeSlots','completePostpone'])await page.addScriptTag({content:extract(app,name)});
  const open=async(creatorRole,own=false,actor='STAFF')=>{
   await page.evaluate(({creatorRole,own,actor})=>{user={role:actor,user_id:staffId};fixture(own?staffId:otherId,creatorRole);postponeSlot(sourceId);return $('#postponeForm')._icReady},{creatorRole,own,actor});
   await page.waitForSelector('#postSlots button');
  };
  const main=()=>page.locator('#postSlots button').filter({hasText:'Main S1'});
  for(const creator of ['STAFF','ADMIN','WEBMASTER']){
   await open(creator);
   assert.match(await page.locator('.edit-permission-note').innerText(),/created by another user.*details stay unchanged.*Admin approval/);
   for(const name of ['mrn','patient_name','surgery','diagnosis','doctor','specialist','sub_specialty','phone','remark','age','age_months'])
    assert.equal(await page.locator(`[name="${name}"]`).evaluate(el=>el.readOnly),true,name);
   assert.equal(await page.locator('[name="patient_ic"]').isDisabled(),true);
   assert.match(await page.locator('[name="patient_ic"]').getAttribute('placeholder'),/900101-\*\*-\*\*\*\*/);
   assert.equal(await page.locator('#postponeForm input[type="checkbox"]').isDisabled(),true);
   assert.equal(await page.locator('#postSlots .special').count(),0);
   await main().click();assert.equal(await page.evaluate(()=>sends.length),0);
   assert.match(await page.evaluate(()=>messages.at(-1)),/postpone reason/);
   // DOM tampering cannot turn this move into a clinical or identity edit.
   await page.evaluate(()=>{
    const f=$('#postponeForm');for(const name of ['mrn','patient_name','surgery','diagnosis','remark'])f.elements[name].value='ATTEMPT';
    f.elements.patient_ic.value='SYNTHETIC-REPLACEMENT';f.querySelector('input[type="checkbox"]').checked=true;
    _schedule[0].slots[0]._ic_generation=otherId;_schedule[0].slots[0]._ic_edit_version='2026-10-12T03:00:00+00:00';
   });
   await page.locator('[name="reason"]').fill('Synthetic clinical reason');await main().click();
   const call=await page.evaluate(()=>sends[0]);
   assert.equal(call.operation,'MOVE');assert.deepEqual(call.payload.data,{});assert.equal(call.payload.ic_mode,'KEEP');
   assert.equal(call.payload.generation,'11111111-1111-4111-8111-111111111111');
   assert.equal(call.payload.expected_version,'2026-10-12T01:02:03.123456+00:00');
   assert.equal(call.payload.expected_request,'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
   assert.equal(call.payload.to_slot,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
   assert.equal(call.payload.reason,'Synthetic clinical reason');
   assert.match(await page.evaluate(()=>messages.at(-1)),/reserved for Admin confirmation/);
   assert.equal(await page.evaluate(()=>_schedule[0].slots[0].created_by),await page.evaluate(()=>otherId));
  }
  await open('STAFF',true);
  assert.equal(await page.locator('[name="surgery"]').evaluate(el=>el.readOnly),false);
  assert.equal(await page.locator('[name="diagnosis"]').evaluate(el=>el.readOnly),false);
  assert.equal(await page.locator('[name="patient_name"]').evaluate(el=>el.readOnly),true);
  await page.locator('[name="surgery"]').fill('updated surgery');await page.locator('[name="diagnosis"]').fill('updated diagnosis');
  await page.evaluate(()=>{$('[name="mrn"]').value='ATTEMPT'});
  await page.locator('[name="reason"]').fill('Own patient reason');await main().click();
  assert.deepEqual(await page.evaluate(()=>sends[0].payload.data),{surgery:'UPDATED SURGERY',diagnosis:'UPDATED DIAGNOSIS'});
  for(const actor of ['ADMIN','WEBMASTER']){
   await open('STAFF',false,actor);
   assert.equal(await page.locator('.edit-permission-note').count(),0);
   assert.equal(await page.locator('[name="patient_name"]').evaluate(el=>el.readOnly),false);
   assert.equal(await page.locator('#postponeForm input[type="checkbox"]').isEnabled(),true);
   assert.equal(await page.locator('#postSlots .special').count(),1);
   await page.locator('[name="patient_name"]').fill('changed synthetic');await page.locator('[name="reason"]').fill('Admin reason');
   await page.locator('#postSlots .special').click();
   assert.equal(await page.evaluate(()=>sends[0].payload.data.patient_name),'Changed Synthetic');
   assert.equal(await page.evaluate(()=>sends[0].payload.to_slot),'ffffffff-ffff-4fff-8fff-ffffffffffff');
  }
  await open('ADMIN');await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await browser.close()}
});
