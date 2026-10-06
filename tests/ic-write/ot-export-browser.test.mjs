import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
test('actual Excel builder and export modal: full IC only after protected response; cancel/signout/failures do not download',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="modal"></div>');
  await page.route('**/*',route=>route.abort());
  const read=p=>readFile(new URL('../../'+p,import.meta.url),'utf8'),app=await read('docs/app.js'),clinical=await read('docs/clinical-features.js');
  const chunk=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
  await page.addScriptTag({content:chunk('function maskPatientIc(','function xmlText(')+chunk('function zipCrc32(','function generateOtList(')
   +chunk('function patientNameCase(','function normalizeClinicalFields(')+clinical.slice(0,clinical.indexOf('let statsOffset='))});
  const bytes=Array.from(await readFile(new URL('../../docs/assets/ot-list-template.xlsx',import.meta.url)));
  await page.evaluate(bytes=>{
   window.template=new Uint8Array(bytes).buffer;window.user={role:'ADMIN'};window.token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
   window.sid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';window.generation='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
   window.sample={request_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',patient_name:'Synthetic Patient',patient_ic:'010203-04-5678',
    mrn:'SYNTHETIC',age:20,age_months:0,diagnosis:'=TEST()',surgery:'TEST',sub_specialty:'Gen ORL'};
   window._schedule=[{session_id:sid,ot_date:'2030-01-01',_ic_generation:generation,slots:[{...sample,patient_ic:'010203-**-****',status:'CONFIRMED'}]}];
   window.$=s=>document.querySelector(s);window.esc=s=>s;window.formatSystemDate=s=>s;
   window.modal=html=>$('#modal').innerHTML=html;window.closeModal=()=>$('#modal').replaceChildren();
   window.toasts=[];window.toast=s=>toasts.push(s);window.protectedIcEnabled=()=>true;
   window.fetch=async()=>({ok:true,arrayBuffer:async()=>template.slice(0)});
   window.rpcCount=0;window.rpc=async(name,args)=>{
    rpcCount++;window.lastArgs={...args};if(window.failRpc)throw Error('Synthetic failure');
    if(window.hold)await new Promise(resolve=>window.resume=resolve);
    return{session:{session_id:sid,ot_date:'2030-01-01'},patients:[{...sample}],expires_at:new Date(Date.now()+60000).toISOString()};
   };
   window.downloads=0;HTMLAnchorElement.prototype.click=function(){downloads++};
   URL.createObjectURL=blob=>{window.lastBlob=blob;return 'blob:synthetic'};URL.revokeObjectURL=()=>{};
  },bytes);
  await page.addScriptTag({content:await read('docs/ot-excel.js')});
  const result=await page.evaluate(async()=>{
   const out=[];
   const original=await readOtTemplate(template.slice(0)),decodeXml=v=>new DOMParser().parseFromString(new TextDecoder().decode(v),'application/xml');
   const originalSizes=[...decodeXml(original['xl/styles.xml']).querySelectorAll('fonts font sz')].map(s=>Number(s.getAttribute('val')));
   for(const n of [1,3,8,12]){
    const list=Array.from({length:n},()=>({...sample}));
    for(const fullIc of [false,true]){
     const blob=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},list,{fullIc});
     const entries=await readOtTemplate(await blob.arrayBuffer()),decode=new TextDecoder(),xml=decode.decode(entries['xl/worksheets/sheet1.xml']);
     const doc=new DOMParser().parseFromString(xml,'application/xml'),setup=doc.querySelector('pageSetup');
     out.push({n,fullIc,count:[...doc.querySelectorAll('c')].filter(c=>c.getAttribute('r').match(/^B\d+$/)&&c.textContent.includes('Synthetic Patient')).length,
      hasRaw:xml.includes(sample.patient_ic),hasMask:xml.includes('010203-**-****'),formulas:doc.querySelectorAll('f').length,
      fontDeltas:[...decodeXml(entries['xl/styles.xml']).querySelectorAll('fonts font sz')].map((s,i)=>Number(s.getAttribute('val'))-originalSizes[i]),
      a4:setup.getAttribute('paperSize')==='9',landscape:setup.getAttribute('orientation')==='landscape',
      onePage:setup.getAttribute('fitToWidth')==='1'&&setup.getAttribute('fitToHeight')==='1'&&doc.querySelector('pageSetUpPr').getAttribute('fitToPage')==='1',
      noFixedScale:!setup.hasAttribute('scale'),noManualBreaks:!doc.querySelector('rowBreaks,colBreaks'),
      printArea:decode.decode(entries['xl/workbook.xml']).includes('$J$'+(14+n))});
    }
   }return out;
  });
  for(const row of result){assert.equal(row.count,row.n);assert.equal(row.hasRaw,row.fullIc);assert.equal(row.hasMask,!row.fullIc);assert.equal(row.formulas,0);assert.ok(row.printArea);assert.ok(row.fontDeltas.every(n=>n===1));assert.ok(row.a4&&row.landscape&&row.onePage&&row.noFixedScale&&row.noManualBreaks)}
  if(process.env.ORL_OT_LAYOUT_QA_DIR){
   await mkdir(process.env.ORL_OT_LAYOUT_QA_DIR,{recursive:true});
   for(const n of [3,12]){
    const data=await page.evaluate(async n=>Array.from(new Uint8Array(await (await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},Array.from({length:n},(_,i)=>({...sample,patient_name:'Synthetic Patient '+(i+1),diagnosis:'SYNTHETIC LONG DIAGNOSIS FOR PRINT LAYOUT VERIFICATION',surgery:'SYNTHETIC PROCEDURE FOR PRINT LAYOUT VERIFICATION'})))).arrayBuffer())),n);
    await writeFile(resolve(process.env.ORL_OT_LAYOUT_QA_DIR,`synthetic-${n}.xlsx`),new Uint8Array(data));
   }
  }
  await page.evaluate(()=>{user.role='STAFF';generateOtList(sid)});assert.equal(await page.locator('#otExportForm').count(),0);
  await page.evaluate(()=>{user.role='ADMIN';generateOtList(sid)});await page.locator('button.secondary').click();
  assert.equal(await page.evaluate(()=>rpcCount),0);
  const submit=async()=>{
   await page.evaluate(()=>generateOtList(sid));await page.locator('[name=password]').fill('SYNTHETIC');
   await page.locator('[type=checkbox]').check();await page.locator('[type=submit]').click();
  };
  await submit();await page.waitForFunction(()=>downloads===1);
  assert.equal(await page.evaluate(()=>rpcCount),1);
  assert.equal(await page.evaluate(()=>_schedule[0].slots[0].patient_ic),'010203-**-****');
  assert.ok(!(await page.locator('body').innerText()).includes('010203-04-5678'));
  assert.equal(await page.evaluate(()=>lastArgs.p_generation),await page.evaluate(()=>generation));
  for(const mode of ['cancel','signout','failure']){
   await page.evaluate(mode=>{window.hold=mode!=='failure';window.failRpc=mode==='failure';window.resume=null},mode);
   await submit();
   if(mode!=='failure'){
    await page.waitForFunction(()=>typeof resume==='function');
    assert.equal(await page.locator('[name=password]').inputValue(),'');
    await page.evaluate(mode=>{if(mode==='cancel')closeModal();else token='signed-out';resume()},mode);
   }
   await page.waitForFunction(()=>!otExportBusy);assert.equal(await page.evaluate(()=>downloads),1);
   await page.evaluate(()=>{token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';closeModal()});
  }
 }finally{await browser.close()}
});
