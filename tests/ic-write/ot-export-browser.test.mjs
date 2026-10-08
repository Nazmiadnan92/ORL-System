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
  const bytes=Array.from(await readFile(new URL('../../docs/assets/ot-list-template-v070.xlsx',import.meta.url)));
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
   for(const n of [0,1,6,11,12,16]){
    const list=Array.from({length:n},()=>({...sample}));
    for(const fullIc of [false,true]){
     const blob=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},list,{fullIc});
     const entries=await readOtTemplate(await blob.arrayBuffer()),decode=new TextDecoder(),xml=decode.decode(entries['xl/worksheets/sheet1.xml']);
     const doc=new DOMParser().parseFromString(xml,'application/xml'),setup=doc.querySelector('pageSetup');
     const rows=[...doc.querySelectorAll('sheetData row')],lastRow=Number(rows.at(-1).getAttribute('r'));
     const height=(from,to)=>rows.filter(r=>Number(r.getAttribute('r'))>=from&&Number(r.getAttribute('r'))<=to).reduce((sum,r)=>sum+Number(r.getAttribute('ht')||15),0);
     const ends=[...[...doc.querySelectorAll('rowBreaks brk')].map(b=>Number(b.getAttribute('id'))),lastRow];let start=12;
     const pagesFit=ends.every(end=>{const fits=height(1,11)+height(start,end)<=(210/25.4*72-108)/.69;start=end+1;return fits});
     const shared=entries['xl/sharedStrings.xml']?[...decodeXml(entries['xl/sharedStrings.xml']).querySelectorAll('si')].map(s=>s.textContent):[];
     out.push({n,fullIc,pagesFit,footerOnce:[...doc.querySelectorAll('c')].filter(c=>(c.getAttribute('t')==='s'?shared[Number(c.querySelector('v')?.textContent)]:c.textContent)==='(DR MOHD AYZAM BIN HJ AHMAD)').length===1,count:[...doc.querySelectorAll('c')].filter(c=>c.getAttribute('r').match(/^B\d+$/)&&c.textContent.includes('Synthetic Patient')).length,
      hasRaw:xml.includes(sample.patient_ic),hasMask:xml.includes('010203-**-****'),formulas:doc.querySelectorAll('f').length,
      fontDeltas:[...decodeXml(entries['xl/styles.xml']).querySelectorAll('fonts font sz')].map((s,i)=>Number(s.getAttribute('val'))-originalSizes[i]),
      a4:setup.getAttribute('paperSize')==='9',landscape:setup.getAttribute('orientation')==='landscape',
      readablePages:setup.getAttribute('scale')==='69'&&setup.getAttribute('fitToHeight')==='0'&&doc.querySelector('pageSetUpPr').getAttribute('fitToPage')==='0',
      wholeBlocks:[...doc.querySelectorAll('rowBreaks brk')].every(b=>(Number(b.getAttribute('id'))-11)%5===0),
      repeatedHeader:decode.decode(entries['xl/workbook.xml']).includes('$1:$11'),
      dynamicDate:doc.querySelector('[r="A4"]').textContent.includes('2030'),
      printArea:decode.decode(entries['xl/workbook.xml']).includes('$J$'+(22+(Math.max(1,n)-1)*5))});
    }
   }return out;
  });
  for(const row of result){assert.equal(row.count,row.n);assert.equal(row.hasRaw,row.n>0&&row.fullIc);assert.equal(row.hasMask,row.n>0&&!row.fullIc);assert.equal(row.formulas,0);assert.ok(row.printArea&&row.pagesFit&&row.footerOnce);assert.ok(row.fontDeltas.every(n=>n===0));assert.ok(row.a4&&row.landscape&&row.readablePages&&row.wholeBlocks&&row.repeatedHeader&&row.dynamicDate)}
  const layout=await page.evaluate(async()=>{
   const parts=await readOtTemplate(template.slice(0)),decode=new TextDecoder(),parse=p=>new DOMParser().parseFromString(decode.decode(p),'application/xml');
   const doc=parse(parts['xl/worksheets/sheet1.xml']),styles=parse(parts['xl/styles.xml']),book=parse(parts['xl/workbook.xml']);
   const safeHeaders=['No','Nama Pesakit','Nombor IC','MRN','Umur','Wad','Jantina','Berat','Badan','Diagnosis Utama +','Diagnosis Lain','Prosedur','Catatan Khas','Special','Perioperative','(Remarks)','Jangka','Masa (MM:SS)','GA/LA','Darah','Pakar Bedah /','Pegawai Perubatan','Sub'];
   const safeFixed=['JABATAN OTORINOLARINGOLOGI, HOSPITAL SULTANAH','BAHIYAH, ALOR SETAR, KEDAH.','PEMBEDAHAN : DEWAN BEDAH UTAMA - OR 2','TARIKH: ____________________','PAKAR BEDAH: DR ZULKIFLI, DR AYZAM, DR ZAMBRI, DATIN DR FAIZAH, DR YEOH,','DR HUSNA, DR FAIZ, DR NABIHAH, DR K. NAIMAH, DR NG WEI QI, DR AIDAYANTI','PARAMEDIK: ','(DR MOHD AYZAM BIN HJ AHMAD)','Perakuan Pendaftaran: 38861','Ketua Jabatan & Pakar Perunding ORL','Hospital Sultanah Bahiyah, Alor Setar, Kedah.'];
   const allowed=new Set([...safeHeaders,...safeFixed]),strings=parts['xl/sharedStrings.xml']?[...parse(parts['xl/sharedStrings.xml']).querySelectorAll('si')].map(s=>s.textContent):[];
   const values=[...doc.querySelectorAll('c')].map(c=>c.getAttribute('t')==='s'?strings[Number(c.querySelector('v').textContent)]:c.querySelector('t')?.textContent||'');
   const cellsSafe=values.filter(Boolean).every(v=>allowed.has(v)),stringsSafe=strings.filter(Boolean).every(v=>allowed.has(v));
   const metaSafe=Object.keys(parts).every(name=>!/(?:externalLinks|vbaProject|comments|threadedComments|customXml|embeddings|printerSettings)/i.test(name));
   const widthPx=[...doc.querySelectorAll('col')].reduce((sum,c)=>sum+(Number(c.getAttribute('width'))*7+5)*(Number(c.getAttribute('max'))-Number(c.getAttribute('min'))+1),0);
   const normalFont=styles.querySelector('fonts font'),normalXf=styles.querySelector('cellStyleXfs xf');
   const long='SYNTHETIC LONG CLINICAL DESCRIPTION '.repeat(100)+'END MARKER',patient={...sample,diagnosis:long,surgery:long};
   const output=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},[patient],{fullIc:true}),generated=await readOtTemplate(await output.arrayBuffer()),clinical=parse(generated['xl/worksheets/sheet1.xml']);
   const allCells=[...clinical.querySelectorAll('c')],columnText=col=>allCells.filter(c=>new RegExp('^'+col+'[0-9]+$').test(c.getAttribute('r'))&&Number(c.getAttribute('r').match(/\d+/)[0])>=12).map(c=>c.querySelector('t')?.textContent||'').join('');
   return{cellsSafe,stringsSafe,metaSafe,blankPatientRows:[...doc.querySelectorAll('row')].filter(r=>Number(r.getAttribute('r'))>=12&&Number(r.getAttribute('r'))<=21).every(r=>![...r.querySelectorAll('c')].some(c=>c.querySelector('v,t'))),
    widthPx,normalFont:normalFont.querySelector('name').getAttribute('val'),normalSize:normalFont.querySelector('sz').getAttribute('val'),normalFontId:normalXf.getAttribute('fontId'),
    exactDiagnosis:columnText('E')===long,exactProcedure:columnText('F')===long,continuation:clinical.documentElement.textContent.includes('Sambungan'),
    identifiedBlocks:allCells.filter(c=>/^A[0-9]+$/.test(c.getAttribute('r'))&&c.querySelector('t')?.textContent==='1').every(c=>{
     const row=Number(c.getAttribute('r').slice(1)),at=(col,r)=>clinical.querySelector('[r="'+col+r+'"]')?.textContent;
     return at('B',row)===sample.patient_name&&at('B',row+2)===sample.patient_ic&&at('B',row+3)===sample.mrn;
    }),
    breaks:[...clinical.querySelectorAll('rowBreaks brk')].map(b=>Number(b.getAttribute('id'))),maxHeight:Math.max(...[...clinical.querySelectorAll('row')].map(r=>Number(r.getAttribute('ht'))||15))};
  });
  assert.ok(layout.cellsSafe&&layout.stringsSafe&&layout.metaSafe&&layout.blankPatientRows,'Public template contains only approved static labels and blank patient cells');
  assert.equal(layout.normalFont,'Carlito');assert.equal(layout.normalSize,'12');assert.equal(layout.normalFontId,'0');
  assert.equal(layout.widthPx,1268,'Column widths retain the uploaded template proportions');
  assert.ok(layout.exactDiagnosis&&layout.exactProcedure&&layout.continuation&&layout.identifiedBlocks,'Long clinical content continues without loss and keeps patient identifiers');
  assert.ok(layout.breaks.length>0&&layout.breaks.every(id=>(id-11)%5===0));assert.ok(layout.maxHeight<80);
  const staleRejected=await page.evaluate(async()=>{
   const parts=await readOtTemplate(template.slice(0));
   parts['xl/worksheets/sheet1.xml']=new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']).replace('B27:E27','B26:E26');
   try{await buildOtExcel(await createDocxBlob(parts).arrayBuffer(),{ot_date:'2030-01-01'},[sample]);return false}catch(e){return /template version mismatch/.test(e.message)}
  });assert.ok(staleRejected,'Mismatched template cannot silently produce the wrong footer');
  if(process.env.ORL_OT_LAYOUT_QA_DIR){
   await mkdir(process.env.ORL_OT_LAYOUT_QA_DIR,{recursive:true});
   for(const n of [0,1,6,11,12,16]){
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
