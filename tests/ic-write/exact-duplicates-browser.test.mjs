import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
test('Duplicate UI: Webmaster only, masked full-identity groups, safe errors and stale response rejection',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.abort());await page.setContent('<div id="dbBody"></div>');
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.user={role:'WEBMASTER'};window.token='synthetic-session';
   window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   window.dbRemovalContext=()=>'';window.toast=()=>{};window.calls=[];window.deferred=[];
   const record={request_number:'TEST-1',patient_name:'Synthetic Patient',patient_ic:'900101-01-1234',mrn:'TEST-MRN',surgery:'Test procedure',diagnosis:'Test',status:'SCHEDULED',created_at:'2026-10-01',id:'fake-id'};
   window.fixture=[{match_type:'PATIENT IC',match_value:'900101011234',record_count:2,records:[record,{...record,id:'fake-2'}]},
    {match_type:'MRN',match_value:'TEST-MRN',record_count:2,records:[record,{...record,id:'fake-2'}]}];
   window.rpc=async(name,args)=>{calls.push({name,args});if(window.delay)return new Promise(resolve=>deferred.push(resolve));if(window.failure)throw Error('Protected identity data needs review.');return fixture;};
  });
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  await page.addScriptTag({content:'const status=v=>esc(v);\n'+app.slice(app.indexOf('function maskPatientIc('),app.indexOf('function formatOtDocumentDate('))+
   app.slice(app.indexOf('function dbPatientTable('),app.indexOf('function dbRemovalContext('))+
   app.slice(app.indexOf('let dbDuplicateSequence='),app.indexOf('async function dbHealth('))});
  await page.evaluate(()=>dbDuplicates());
  assert.equal(await page.locator('.duplicate-group').count(),2,await page.locator('#dbBody').innerText());
  let text=await page.locator('#dbBody').innerText();
  assert.match(text,/Full IC \/ Passport match: 900101-\*\*-\*\*\*\*/);assert.match(text,/separate operations/);
  assert.doesNotMatch(text,/900101011234|900101-01-1234/);
  for(const role of ['ADMIN','STAFF']){
   const count=await page.evaluate(()=>calls.length);
   await page.evaluate(async role=>{user.role=role;$('#dbBody').textContent='';await dbDuplicates();},role);
   assert.equal(await page.evaluate(()=>calls.length),count);assert.equal(await page.locator('#dbBody').innerText(),'');
  }
  await page.evaluate(()=>{user.role='WEBMASTER';window.delay=true;window.first=dbDuplicates();window.second=dbDuplicates();});
  await page.evaluate(async()=>{deferred[1]([]);await second;deferred[0](fixture);await first;});
  assert.match(await page.locator('#dbResults').innerText(),/No matching/);
  await page.evaluate(()=>{window.pending=dbDuplicates();token='new-session';});
  await page.evaluate(async()=>{deferred[2](fixture);await pending;});
  assert.equal(await page.locator('.duplicate-group').count(),0);
  await page.evaluate(()=>{window.pending=dbDuplicates();user.role='STAFF';});
  await page.evaluate(async()=>{deferred[3](fixture);await pending;});
  assert.equal(await page.locator('.duplicate-group').count(),0);
  await page.evaluate(()=>{user.role='WEBMASTER';window.pending=dbDuplicates();$('#dbBody').innerHTML='<div id="dbResults">Other panel</div>';});
  await page.evaluate(async()=>{deferred[4](fixture);await pending;window.delay=false;window.failure=true;await dbDuplicates();});
  assert.equal(await page.locator('#dbResults').innerText(),'Protected identity data needs review.');
  await page.evaluate(async()=>{window.failure=false;window.fixture={};await dbDuplicates();});
  assert.match(await page.locator('#dbResults').innerText(),/Unable to verify duplicate matches/);
  await page.evaluate(async()=>{
   const attack='<img src=x onerror="window.pwned=1">';
   window.fixture=[{match_type:'MRN',match_value:attack,record_count:2,records:[{patient_name:attack},{patient_name:attack}]}];await dbDuplicates();
  });
  assert.equal(await page.locator('#dbResults img').count(),0);assert.equal(await page.evaluate(()=>window.pwned),undefined);
  assert.ok((await page.evaluate(()=>calls)).every(c=>c.name==='orl_db_duplicates'));
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
