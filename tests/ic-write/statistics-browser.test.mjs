import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
test('statistics UI shows global cards/total and permitted-row pagination; unchanged schedule link, filters and stale-response guards',async()=>{
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
   window.fixture={scope:'ALL_REQUESTS',row_scope:'MY_REQUESTS',total:103,row_total:2,cards:[{name:'Test specialty',count:103}],
    rows:[{patient_name:'Synthetic <img src=x>',mrn:'TEST-1',age:20,age_months:0,diagnosis:'Synthetic',surgery:'Synthetic',doctor:'Test',specialist:'Test',sub_specialty:'Test specialty',status:'SCHEDULED',postpone_count:0,ot_date:'2027-01-01'}]};
   window.rpc=async(name,args)=>{calls.push({name,args});return structuredClone(fixture)};
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/clinical-features.js',import.meta.url),'utf8')});
  await page.evaluate(()=>statistics());await page.waitForFunction(()=>document.querySelector('#statsNext'));
  assert.match(await page.locator('#content').innerText(),/requests from all users/);
  assert.match(await page.locator('#statsCards').innerText(),/All sub-specialties: 103/);
  assert.match(await page.locator('#statsResults').innerText(),/103 matching requests across all users/);
  assert.match(await page.locator('#statsResults').innerText(),/1-1 of 2 permitted records/);
  assert.match(await page.locator('#statsResults').innerText(),/View OT in OT Schedule/);
  assert.equal(await page.locator('#statsResults img').count(),0);assert.equal(await page.locator('#statsNext').isDisabled(),true);
  await page.locator('#statsMonth').selectOption('2');await page.locator('#statsYear').fill('2028');await page.locator('#statsForm button').click();
  const call=await page.evaluate(()=>calls.at(-1));assert.equal(call.name,'orl_subspecialty_statistics');assert.equal(call.args.p_from,'2028-02-01');assert.equal(call.args.p_to,'2028-02-29');
  await page.evaluate(()=>{fixture.row_scope='ALL_REQUESTS';fixture.row_total=103;user={role:'ADMIN'};return loadStatistics()});
  assert.equal(await page.locator('#statsNext').isDisabled(),false);await page.locator('#statsNext').click();assert.equal(await page.evaluate(()=>calls.at(-1).args.p_offset),100);
  await page.evaluate(()=>{fixture.scope='MY_REQUESTS';return loadStatistics()});assert.match(await page.locator('#statsResults').innerText(),/Global statistics are not available yet/);assert.equal(await page.locator('#statsCards button').count(),0);
  await page.evaluate(()=>{fixture.scope='ALL_REQUESTS';window.rpc=()=>new Promise(r=>window.finishStatistics=r);loadStatistics();token='changed-token';finishStatistics(fixture)});
  assert.equal(await page.locator('#statsCards button').count(),0);assert.equal(await page.locator('#statsResults').innerText(),'Loading...');
 }finally{await browser.close()}
});
