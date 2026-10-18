import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const read=p=>readFile(new URL('../../'+p,import.meta.url),'utf8');
test('Audit UI: readable summaries, exact originals, keyboard disclosure, read-only search, stale responses and safe narrow layout',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1200,height:950}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.abort());
  await page.setContent('<body data-theme="RUBY"><div id="content"></div></body>');
  const index=await read('docs/index.html');
  for(const match of index.matchAll(/<link rel="stylesheet" href="([^?\"]+)\?[^\"]+"/g))await page.addStyleTag({content:await read('docs/'+match[1])});
  await page.addScriptTag({content:await read('docs/audit-display.js')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.token='synthetic-session';window.calls=[];window.deferred=[];
   window.head=(title,sub)=>'<h1 class="title">'+title+'</h1><p class="sub">'+sub+'</p>';
   const base={occurred_at:'2026-10-19T01:02:03Z',user_name:'Test Webmaster',user_role:'WEBMASTER',record_id:'synthetic-record-id',record_type:'REQUEST'};
   window.fixture=[
    {...base,action:'OT_SLOT_REASSIGNED',details:JSON.stringify({mode:'CLOSED_PAST_REASSIGN',ot_date:'2026-10-11',from_slot_label:'Main Slot 5',to_slot_label:'Main Slot 6',from_slot_id:'synthetic-old-slot'})},
    {...base,action:'OT_LIST_FULL_IC_GENERATED',details:'Authorized Excel OT list with full IC. OT date: 21-10-2026. Patient count: 3. Purpose: OT list preparation. Export reference: synthetic-export-id. Access released; physical printing/download completion is not tracked.'},
    {...base,action:'OT_DONE_REVERSED',details:' { "ot_date": "14-10-2026", "previous_status": "COMPLETED", "new_status": "SCHEDULED", "reason": "Marked by mistake" } '},
    {...base,action:'OT_HOLD_PLACED',details:'{"ot_date":"14-10-2026","reason":"Awaiting review","previous_status":"SCHEDULED"}'},
    {...base,action:'LOGIN',user_name:'Test Staff',user_role:'STAFF',details:'Custom username login'}
   ];
   window.rpc=async(name,args)=>{calls.push({name,args});if(window.delay)return new Promise(resolve=>deferred.push(resolve));if(window.failure)throw new Error('Synthetic access denied');return window.empty?[]:fixture;};
  });
  const app=await read('docs/app.js');
  await page.addScriptTag({content:app.slice(app.indexOf('async function audit()'),app.indexOf('async function settings()'))});
  await page.evaluate(()=>audit());
  assert.equal(await page.locator('tbody tr').count(),5);
  assert.equal(await page.locator('details[open]').count(),0);
  assert.match(await page.locator('body').innerText(),/Past OT slot changed/);
  assert.doesNotMatch(await page.locator('body').innerText(),/CLOSED_PAST_REASSIGN|synthetic-record-id|synthetic-export-id/);
  const disclosure=page.locator('details summary').first();await disclosure.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('details[open]').count(),1);
  assert.equal(await page.locator('details pre').first().textContent(),await page.evaluate(()=>fixture[0].details));
  await page.keyboard.press('Enter');assert.equal(await page.locator('details[open]').count(),0);
  const out=fileURLToPath(new URL('../../qa/audit-display/',import.meta.url));await mkdir(out,{recursive:true});
  await page.screenshot({path:resolve(out,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.ok(await page.locator('.audit-table').evaluate(el=>el.scrollWidth>el.clientWidth));
  await page.screenshot({path:resolve(out,'mobile.png'),fullPage:true});
  await page.setViewportSize({width:1200,height:950});
  await page.locator('#aq').fill('OT_MARKED_DONE');await page.getByRole('button',{name:'Search',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>calls.at(-1)),{name:'orl_get_audit',args:{p_session_token:'synthetic-session',p_search:'OT_MARKED_DONE'}});
  assert.ok((await page.evaluate(()=>calls)).every(x=>x.name==='orl_get_audit'));
  await page.evaluate(()=>{window.delay=true;window.pendingA=loadAudit();window.pendingB=loadAudit();});
  await page.evaluate(async()=>{deferred[1]([{action:'LOGIN',details:'Newest result',user_name:'Latest response'}]);await pendingB;deferred[0]([{action:'LOGIN',user_name:'Stale response'}]);await pendingA;});
  assert.match(await page.locator('#auditRows').innerText(),/Latest response/);assert.doesNotMatch(await page.locator('#auditRows').innerText(),/Stale response/);
  await page.evaluate(()=>{window.pendingC=loadAudit();token='different-session';});
  await page.evaluate(async()=>{deferred[2]([{action:'LOGIN',user_name:'Old session data'}]);await pendingC;window.delay=false;});
  assert.doesNotMatch(await page.locator('#auditRows').innerText(),/Old session data/);
  await page.evaluate(async()=>{window.empty=true;await loadAudit();});assert.match(await page.locator('#auditRows').innerText(),/No matching audit records/);
  await page.evaluate(async()=>{window.empty=false;window.failure=true;await loadAudit();});assert.equal(await page.locator('#auditRows').innerText(),'Synthetic access denied');
  await page.evaluate(async()=>{
   window.failure=false;
   const attack='<img src=x onerror="window.pwned=1"> & <script>window.pwned=1</script>';
   window.fixture=[{action:'OT_HOLD_PLACED',details:JSON.stringify({reason:attack}),user_name:attack,user_role:attack,record_id:attack,record_type:attack}];
   await loadAudit();
  });
  assert.equal(await page.locator('#auditRows img, #auditRows script').count(),0);assert.equal(await page.evaluate(()=>window.pwned),undefined);
  await page.locator('details summary').click();assert.match(await page.locator('details pre').textContent(),/<img/);
  await page.evaluate(async()=>{window.fixture=Array.from({length:500},(_,i)=>({action:'OT_MARKED_DONE',user_name:'Synthetic user '+i,details:JSON.stringify({ot_date:'2026-10-14'})}));await loadAudit();});
  assert.equal(await page.locator('tbody tr').count(),500);assert.equal(await page.locator('details[open]').count(),0);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
