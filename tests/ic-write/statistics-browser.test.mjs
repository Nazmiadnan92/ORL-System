import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('statistics UI shows the same all-user patient list for Staff, Admin and Webmaster with 100-row pagination and filters',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage();await page.route('**/*',r=>r.abort());await page.setContent('<section id="content"></section>');
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.currentPage='statistics';window.user={role:'STAFF',user_id:'synthetic'};window.token='synthetic-token';
   window.months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
   window.esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
   window.head=(t,s)=>'<h1>'+esc(t)+'</h1><p>'+esc(s)+'</p>';window.patientNameCase=x=>x;window.clinicalUpper=x=>x;
   window.requestSlotCard=()=>'<span>Existing schedule link</span>';window.calls=[];
   window.fixture={scope:'ALL_REQUESTS',row_scope:'ALL_REQUESTS',total:103,row_total:103,cards:[{name:'Test specialty',count:103}],
    rows:Array.from({length:103},(_,n)=>({patient_name:n===0?'Synthetic <img src=x>':'Other user patient '+n,mrn:'TEST-'+n,
     age:20,age_months:0,diagnosis:'Synthetic',surgery:'Synthetic',doctor:'Test',specialist:'Test',sub_specialty:'Test specialty',
     status:'SCHEDULED',postpone_count:0,ot_date:'2027-01-01'}))};
   window.rpc=async(name,args)=>{calls.push({name,args});return {...structuredClone(fixture),rows:structuredClone(fixture.rows.slice(args.p_offset,args.p_offset+100))}};
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/clinical-features.js',import.meta.url),'utf8')});
  let staffRows;
  for(const role of ['STAFF','ADMIN','WEBMASTER']){
   await page.evaluate(role=>{user={role,user_id:'synthetic-'+role};statistics()},role);
   await page.waitForFunction(()=>document.querySelector('#statsNext'));
   assert.match(await page.locator('#content').innerText(),/cases from all users/);
   assert.match(await page.locator('#statsCards').innerText(),/All sub-specialties: 103/);
   assert.match(await page.locator('#statsResults').innerText(),/103 matching requests across all users/);
   assert.match(await page.locator('#statsResults').innerText(),/1-100 of 103 matching records/);
   assert.doesNotMatch(await page.locator('#statsResults').innerText(),/limited to your requests|permitted records/);
   assert.equal(await page.locator('#statsResults tbody tr').count(),100);
   assert.match(await page.locator('#statsResults').innerText(),/Other user patient 99/);
   assert.match(await page.locator('#statsResults').innerText(),/Existing schedule link/);
   assert.equal(await page.locator('#statsResults img').count(),0);
   const rows=await page.locator('#statsResults tbody').innerText();
   if(role==='STAFF')staffRows=rows;else assert.equal(rows,staffRows);
   assert.equal(await page.locator('#statsPrev').isDisabled(),true);
   assert.equal(await page.locator('#statsNext').isDisabled(),false);
   await page.locator('#statsNext').click();
   assert.equal(await page.evaluate(()=>calls.at(-1).args.p_offset),100);
   assert.equal(await page.locator('#statsResults tbody tr').count(),3);
   assert.match(await page.locator('#statsResults').innerText(),/101-103 of 103 matching records/);
   assert.equal(await page.locator('#statsNext').isDisabled(),true);
   await page.locator('#statsPrev').click();assert.equal(await page.evaluate(()=>calls.at(-1).args.p_offset),0);
  }
  await page.locator('#statsMonth').selectOption('2');await page.locator('#statsYear').fill('2028');
  await page.locator('#statsSpecialist').fill('Beta');await page.locator('#statsStatus').selectOption('ALL');await page.locator('#statsAssignment').selectOption('ASSIGNED');
  await page.locator('#statsForm button').click();
  assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{name:'orl_subspecialty_statistics',args:{p_session_token:'synthetic-token',p_from:'2028-02-01',p_to:'2028-02-29',p_sub:'',p_specialist:'Beta',p_status:'ALL',p_assignment:'ASSIGNED',p_offset:0}});
  await page.locator('#statsNext').click();await page.locator('#statsCards button').nth(1).click();
  assert.equal(await page.evaluate(()=>calls.at(-1).args.p_sub),'Test specialty');assert.equal(await page.evaluate(()=>calls.at(-1).args.p_offset),0);
  await page.locator('#statsFrom').fill('2028-03-02');await page.locator('#statsTo').fill('2028-03-04');await page.locator('#statsForm button').click();
  assert.equal(await page.evaluate(()=>calls.at(-1).args.p_from),'2028-03-02');assert.equal(await page.evaluate(()=>calls.at(-1).args.p_to),'2028-03-04');
  for(const invalid of [{scope:'MY_REQUESTS'},{row_scope:'MY_REQUESTS'},{row_total:2},{row_total:104}]){
   await page.evaluate(async invalid=>{Object.assign(fixture,{scope:'ALL_REQUESTS',row_scope:'ALL_REQUESTS',row_total:103},invalid);await loadStatistics()},invalid);
   assert.match(await page.locator('#statsResults').innerText(),/shared patient list update is not available yet/i);assert.equal(await page.locator('#statsCards button').count(),0);
  }
  await page.evaluate(()=>{Object.assign(fixture,{scope:'ALL_REQUESTS',row_scope:'ALL_REQUESTS',row_total:103});window.rpc=()=>new Promise(r=>window.finishStatistics=r);loadStatistics();token='changed-token';finishStatistics(fixture)});
  assert.equal(await page.locator('#statsCards button').count(),0);assert.equal(await page.locator('#statsResults').innerText(),'Loading...');
 }finally{await browser.close()}
});
