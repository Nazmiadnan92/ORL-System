import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
// CT_Worksheet is an ordered sequence, even when optional sheetViews is absent.
// https://github.com/dotnet/Open-XML-SDK/blob/main/data/schemas/schemas_openxmlformats_org_spreadsheetml_2006_main.json
const worksheetOrder='sheetPr dimension sheetViews sheetFormatPr cols sheetData sheetCalcPr sheetProtection protectedRanges scenarios autoFilter sortState dataConsolidate customSheetViews mergeCells phoneticPr conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup headerFooter rowBreaks colBreaks customProperties cellWatches ignoredErrors drawing legacyDrawing legacyDrawingHF drawingHF picture oleObjects controls webPublishItems tableParts extLst'.split(' ');
function assertWorksheetOrder(children){
 const positions=children.map(name=>worksheetOrder.indexOf(name));
 assert.ok(positions.every((position,i)=>position>=0&&(!i||position>=positions[i-1])),`Worksheet children must follow the OOXML sequence: ${children.join(', ')}`);
 assert.equal(children.filter(name=>name==='dimension').length,1,'Exactly one dimension is present');
}
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
  const bytes=Array.from(await readFile(new URL('../../docs/assets/ot-list-template-v072.xlsx',import.meta.url)));
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
   for(const n of [0,1,2,6,11,12,16]){
    const list=Array.from({length:n},()=>({...sample}));
    for(const fullIc of [false,true]){
     const blob=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},list,{fullIc});
     const entries=await readOtTemplate(await blob.arrayBuffer()),decode=new TextDecoder(),xml=decode.decode(entries['xl/worksheets/sheet1.xml']);
     const doc=new DOMParser().parseFromString(xml,'application/xml'),setup=doc.querySelector('pageSetup'),book=decodeXml(entries['xl/workbook.xml']);
     const rows=[...doc.querySelectorAll('sheetData row')],lastRow=Number(rows.at(-1).getAttribute('r'));
     const height=(from,to)=>rows.filter(r=>Number(r.getAttribute('r'))>=from&&Number(r.getAttribute('r'))<=to).reduce((sum,r)=>sum+Number(r.getAttribute('ht')||15),0);
     const ends=[...[...doc.querySelectorAll('rowBreaks brk')].map(b=>Number(b.getAttribute('id'))),lastRow];let start=12;
     const pagesFit=ends.every(end=>{const fits=height(1,11)+height(start,end)<=(210/25.4*72-108)/.69;start=end+1;return fits});
     const shared=entries['xl/sharedStrings.xml']?[...decodeXml(entries['xl/sharedStrings.xml']).querySelectorAll('si')].map(s=>s.textContent):[];
     const outputStyles=decodeXml(entries['xl/styles.xml']),outputXfs=[...outputStyles.querySelectorAll('cellXfs xf')],outputBorders=[...outputStyles.querySelectorAll('borders border')];
     const signatureRow=13+Math.max(1,n)*6;
     out.push({n,fullIc,pagesFit,footerOnce:[...doc.querySelectorAll('c')].filter(c=>(c.getAttribute('t')==='s'?shared[Number(c.querySelector('v')?.textContent)]:c.textContent)==='(DR MOHD AYZAM BIN HJ AHMAD)').length===1,count:[...doc.querySelectorAll('c')].filter(c=>c.getAttribute('r').match(/^B\d+$/)&&c.textContent.includes('Synthetic Patient')).length,
      hasRaw:xml.includes(sample.patient_ic),hasMask:xml.includes('010203-**-****'),formulas:doc.querySelectorAll('f').length,
      fontDeltas:[...decodeXml(entries['xl/styles.xml']).querySelectorAll('fonts font sz')].map((s,i)=>Number(s.getAttribute('val'))-originalSizes[i]),
      a4:setup.getAttribute('paperSize')==='9',landscape:setup.getAttribute('orientation')==='landscape',
      readablePages:setup.getAttribute('scale')==='69'&&setup.getAttribute('fitToHeight')==='0'&&!setup.hasAttribute('fitToWidth')&&doc.querySelector('pageSetUpPr').getAttribute('fitToPage')==='0',
      wholeBlocks:[...doc.querySelectorAll('rowBreaks brk')].every(b=>(Number(b.getAttribute('id'))-11)%6===0),
      patientRows:rows.filter(r=>Number(r.getAttribute('r'))>=12&&Number(r.getAttribute('r'))<12+Math.max(1,n)*6).length,
      wardPairs:Array.from({length:Math.max(1,n)},(_,i)=>12+i*6).every(first=>[0,2,4].every(offset=>doc.querySelector('mergeCell[ref="D'+(first+offset)+':D'+(first+offset+1)+'"]'))),
      signatureLine:['B','C','D'].every(col=>{const cell=doc.querySelector('c[r="'+col+signatureRow+'"]'),xf=outputXfs[Number(cell?.getAttribute('s')||0)];return outputBorders[Number(xf.getAttribute('borderId')||0)].querySelector('bottom')?.hasAttribute('style')}),
      pages:ends.length,worksheetChildren:[...doc.documentElement.children].map(child=>child.localName),
      repeatedHeader:book.querySelector('definedName[name="_xlnm.Print_Titles"]')?.textContent==="'OT List'!$1:$11",
      dynamicDate:doc.querySelector('[r="A4"]').textContent.includes('2030'),
      printArea:book.querySelector('definedName[name="_xlnm.Print_Area"]')?.textContent==="'OT List'!$A$1:$J$"+(23+(Math.max(1,n)-1)*6)&&lastRow===23+(Math.max(1,n)-1)*6&&doc.querySelector('dimension').getAttribute('ref')==='A1:J'+lastRow});
    }
   }return out;
  });
  for(const row of result)assertWorksheetOrder(row.worksheetChildren);
  for(const row of result){assert.equal(row.count,row.n);assert.equal(row.hasRaw,row.n>0&&row.fullIc);assert.equal(row.hasMask,row.n>0&&!row.fullIc);assert.equal(row.formulas,0);assert.ok(row.printArea&&row.pagesFit&&row.footerOnce);assert.ok(row.fontDeltas.every(n=>n===0));assert.equal(row.patientRows,Math.max(1,row.n)*6);assert.ok(row.wardPairs,'Every patient has three separate two-row Ward/Gender/Weight fields');assert.ok(row.signatureLine,'Signature line follows the final patient');assert.ok(row.a4&&row.landscape&&row.readablePages&&row.wholeBlocks&&row.repeatedHeader&&row.dynamicDate);if(row.n>=6)assert.ok(row.pages>1,'Additional patients add pages at the same scale')}
  const dimensionVariants=await page.evaluate(async()=>{
   const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main',out=[];
   for(const variant of ['no-views','with-views','existing-correct','existing-at-end','no-sheetPr']){
    const parts=await readOtTemplate(template.slice(0)),doc=new DOMParser().parseFromString(new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']),'application/xml'),root=doc.documentElement;
    const sourceHasViews=!!doc.querySelector('sheetViews'),sourceHasDimension=!!doc.querySelector('dimension');
    if(variant==='with-views'){const views=doc.createElementNS(ns,'sheetViews'),view=doc.createElementNS(ns,'sheetView');view.setAttribute('workbookViewId','0');views.append(view);root.insertBefore(views,doc.querySelector('sheetFormatPr'))}
    if(variant.startsWith('existing-')){const dim=doc.createElementNS(ns,'dimension');dim.setAttribute('ref','A1:J999');root.insertBefore(dim,variant==='existing-correct'?doc.querySelector('sheetFormatPr'):null)}
    if(variant==='no-sheetPr')doc.querySelector('sheetPr').remove();
    parts['xl/worksheets/sheet1.xml']=new XMLSerializer().serializeToString(doc);
    const blob=await buildOtExcel(await createDocxBlob(parts).arrayBuffer(),{ot_date:'2030-01-01'},[sample]);
    const generated=await readOtTemplate(await blob.arrayBuffer()),sheet=new DOMParser().parseFromString(new TextDecoder().decode(generated['xl/worksheets/sheet1.xml']),'application/xml');
    out.push({variant,sourceHasViews,sourceHasDimension,children:[...sheet.documentElement.children].map(child=>child.localName),ref:sheet.querySelector('dimension').getAttribute('ref')});
   }return out;
  });
  for(const row of dimensionVariants){assert.equal(row.sourceHasViews,false,'Actual v072 template lacks optional sheetViews');assert.equal(row.sourceHasDimension,false);assertWorksheetOrder(row.children);assert.equal(row.ref,'A1:J23',row.variant)}
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
   const fonts=[...styles.querySelectorAll('fonts font')],xfs=[...styles.querySelectorAll('cellXfs xf')],borders=[...styles.querySelectorAll('borders border')];
   const cellStyle=cell=>xfs[Number(cell.getAttribute('s')||0)],cellFont=cell=>fonts[Number(cellStyle(cell).getAttribute('fontId')||0)];
   const footerCells=[...doc.querySelectorAll('row')].filter(r=>Number(r.getAttribute('r'))>=24&&Number(r.getAttribute('r'))<=29).flatMap(r=>[...r.querySelectorAll('c')]);
   const footerArial14=footerCells.filter(c=>c.querySelector('v,t')).every(c=>cellFont(c).querySelector('name').getAttribute('val')==='Arial'&&cellFont(c).querySelector('sz').getAttribute('val')==='14');
   const signatureLine=['B25','C25','D25'].every(ref=>borders[Number(cellStyle(doc.querySelector('c[r="'+ref+'"]')).getAttribute('borderId')||0)].querySelector('bottom')?.hasAttribute('style'));
   const long='SYNTHETIC LONG CLINICAL DESCRIPTION '.repeat(100)+'END MARKER',patient={...sample,diagnosis:long,surgery:long};
   const output=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},[patient],{fullIc:true}),generated=await readOtTemplate(await output.arrayBuffer()),clinical=parse(generated['xl/worksheets/sheet1.xml']);
   const allCells=[...clinical.querySelectorAll('c')],columnText=col=>allCells.filter(c=>new RegExp('^'+col+'[0-9]+$').test(c.getAttribute('r'))&&Number(c.getAttribute('r').match(/\d+/)[0])>=12).map(c=>c.querySelector('t')?.textContent||'').join('');
   return{cellsSafe,stringsSafe,metaSafe,blankPatientRows:[...doc.querySelectorAll('row')].filter(r=>Number(r.getAttribute('r'))>=12&&Number(r.getAttribute('r'))<=23).every(r=>![...r.querySelectorAll('c')].some(c=>c.querySelector('v,t'))),
    widthPx,footerArial14,signatureLine,worksheetChildren:[...clinical.documentElement.children].map(child=>child.localName),
    exactDiagnosis:columnText('E')===long,exactProcedure:columnText('F')===long,continuation:clinical.documentElement.textContent.includes('Sambungan'),
    identifiedBlocks:allCells.filter(c=>/^A[0-9]+$/.test(c.getAttribute('r'))&&c.querySelector('t')?.textContent==='1').every(c=>{
     const row=Number(c.getAttribute('r').slice(1)),at=(col,r)=>clinical.querySelector('[r="'+col+r+'"]')?.textContent;
     return at('B',row)===sample.patient_name&&at('B',row+2)===sample.patient_ic&&at('B',row+3)===sample.mrn;
    }),
    breaks:[...clinical.querySelectorAll('rowBreaks brk')].map(b=>Number(b.getAttribute('id'))),maxHeight:Math.max(...[...clinical.querySelectorAll('row')].map(r=>Number(r.getAttribute('ht'))||15))};
  });
  assertWorksheetOrder(layout.worksheetChildren);
  assert.ok(layout.cellsSafe&&layout.stringsSafe&&layout.metaSafe&&layout.blankPatientRows,'Public template contains only approved static labels and blank patient cells');
  assert.ok(layout.footerArial14,'Footer labels retain effective Arial 14');assert.ok(layout.signatureLine,'Signature has bottom borders across B25:D25');
  assert.equal(layout.widthPx,1268,'Column widths retain the uploaded template proportions');
  assert.ok(layout.exactDiagnosis&&layout.exactProcedure&&layout.continuation&&layout.identifiedBlocks,'Long clinical content continues without loss and keeps patient identifiers');
  assert.ok(layout.breaks.length>0&&layout.breaks.every(id=>(id-11)%6===0));assert.ok(layout.maxHeight<80);
  const staleRejected=await page.evaluate(async()=>{
   const parts=await readOtTemplate(template.slice(0));
   const original=new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']);
   for(const [from,to]of [['B29:E29','B28:E28'],['D12:D13','D12:D14'],['D14:D15','D14:D16'],['D16:D17','D16:D18']]){
    parts['xl/worksheets/sheet1.xml']=original.replace(from,to);
    try{await buildOtExcel(await createDocxBlob(parts).arrayBuffer(),{ot_date:'2030-01-01'},[sample]);return false}catch(e){if(!/template version mismatch/.test(e.message))return false}
   }return true;
  });assert.ok(staleRejected,'Mismatched footer or Ward/Gender/Weight template cannot silently produce the wrong layout');
  const identities=await page.evaluate(async()=>{
   const cases=[
    ['010203045678','010203-04-5678'],['010203-04-5678','010203-04-5678'],['010203 04 5678','010203-04-5678'],
    [' 010203 - 04 - 5678 ','010203-04-5678'],['000000000001','000000-00-0001'],
    ['01020304567','01020304567'],['0102030456789','0102030456789'],['010203045678A','010203045678A'],
    ['P1234567','P1234567'],['P123-4567','P123-4567'],['01234567890P','01234567890P'],
    ['０１０２０３０４５６７８','０１０２０３０４５６７８'],['010203-**-****','010203-**-****'],['','']
   ],out=[];
   for(const [input,expected]of cases){
    for(const fullIc of [true,false]){
     const patient={...sample,patient_ic:input},before=JSON.stringify(patient);
     const blob=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},[patient],{fullIc});
     const entries=await readOtTemplate(await blob.arrayBuffer()),doc=new DOMParser().parseFromString(new TextDecoder().decode(entries['xl/worksheets/sheet1.xml']),'application/xml');
     const cell=doc.querySelector('c[r="B14"]');
     out.push({input,fullIc,expected:fullIc?expected:maskPatientIc(input),actual:cell?.querySelector('t')?.textContent||'',textType:cell?.getAttribute('t'),unchanged:before===JSON.stringify(patient)});
    }
   }return out;
  });
  for(const row of identities){assert.equal(row.actual,row.expected,`${row.fullIc?'Audited':'Masked'} identifier formatting: ${row.input}`);assert.equal(row.textType,'inlineStr','Identifier remains text to preserve leading zeroes');assert.ok(row.unchanged,'Formatting does not modify the source snapshot')}
  const held=await page.evaluate(async()=>{
   const list=[{...sample,patient_name:'Synthetic Held First',patient_ic:'020304056789',ot_hold:true},{...sample},
    {...sample,patient_name:'Synthetic Held Last',patient_ic:'030405067890',ot_hold:true},{...sample,patient_name:'Synthetic Included',ot_hold:false}];
   const before=JSON.stringify(list),blob=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},list,{fullIc:true});
   const entries=await readOtTemplate(await blob.arrayBuffer()),xml=new TextDecoder().decode(entries['xl/worksheets/sheet1.xml']),doc=new DOMParser().parseFromString(xml,'application/xml');
   return{noHeld:!xml.includes('Synthetic Held')&&!xml.includes('020304')&&!xml.includes('030405'),
    numbers:[...doc.querySelectorAll('c')].filter(c=>/^A(?:12|18)$/.test(c.getAttribute('r'))).map(c=>c.textContent),
    included:doc.querySelector('c[r="B18"]')?.textContent,unchanged:before===JSON.stringify(list)};
  });
  assert.ok(held.noHeld&&held.unchanged,'Hold exclusions never enter the file or mutate the snapshot');assert.deepEqual(held.numbers,['1','2']);assert.equal(held.included,'Synthetic Included');
  if(process.env.ORL_OT_LAYOUT_QA_DIR){
   await mkdir(process.env.ORL_OT_LAYOUT_QA_DIR,{recursive:true});
   for(const n of [0,1,2,6,11,12,16]){
    const data=await page.evaluate(async n=>Array.from(new Uint8Array(await (await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},Array.from({length:n},(_,i)=>({...sample,patient_name:'Synthetic Patient '+(i+1),diagnosis:'SYNTHETIC LONG DIAGNOSIS FOR PRINT LAYOUT VERIFICATION',surgery:'SYNTHETIC PROCEDURE FOR PRINT LAYOUT VERIFICATION'})))).arrayBuffer())),n);
    await writeFile(resolve(process.env.ORL_OT_LAYOUT_QA_DIR,`synthetic-${n}.xlsx`),new Uint8Array(data));
   }
  }
  const holdGate=await page.evaluate(()=>{
   const slots=_schedule[0].slots;_schedule[0].slots=slots.map(slot=>({...slot,ot_hold:true}));
   try{generateOtList(sid);return{modalCount:document.querySelectorAll('#otExportForm').length,rpcCount,lastToast:toasts.at(-1)}}
   finally{_schedule[0].slots=slots}
  });assert.equal(holdGate.modalCount,0);assert.equal(holdGate.rpcCount,0);assert.match(holdGate.lastToast,/No scheduled patients/);
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
