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
   const originalSheet=decodeXml(original['xl/worksheets/sheet1.xml']),originalFooter=[...originalSheet.querySelectorAll('row')].filter(r=>+r.getAttribute('r')>=24&&+r.getAttribute('r')<=29);
   const footerShape=rows=>rows.map(row=>({height:row.getAttribute('ht'),cells:[...row.querySelectorAll('c')].map(c=>({style:c.getAttribute('s'),type:c.getAttribute('t'),content:c.innerHTML}))}));
   for(const n of [0,1,2,3,4,6,11,12,16]){
    const list=Array.from({length:n},()=>({...sample}));
    for(const fullIc of [false,true]){
     const blob=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},list,{fullIc});
     const entries=await readOtTemplate(await blob.arrayBuffer()),decode=new TextDecoder(),xml=decode.decode(entries['xl/worksheets/sheet1.xml']);
     const doc=new DOMParser().parseFromString(xml,'application/xml'),setup=doc.querySelector('pageSetup'),book=decodeXml(entries['xl/workbook.xml']);
     const rows=[...doc.querySelectorAll('sheetData row')],lastRow=Number(rows.at(-1).getAttribute('r'));
     const height=(from,to)=>rows.filter(r=>Number(r.getAttribute('r'))>=from&&Number(r.getAttribute('r'))<=to).reduce((sum,r)=>sum+Number(r.getAttribute('ht')||15),0);
     const ends=[...[...doc.querySelectorAll('rowBreaks brk')].map(b=>Number(b.getAttribute('id'))),lastRow];let start=12;
     const margins=doc.querySelector('pageMargins'),printableHeight=(210/25.4-Number(margins.getAttribute('top'))-Number(margins.getAttribute('bottom')))*72;
     const pagesFit=ends.every(end=>{const fits=(height(1,11)+height(start,end))*.69<=printableHeight;start=end+1;return fits});
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
      fixedPatientHeight:rows.filter(r=>Number(r.getAttribute('r'))>=12&&Number(r.getAttribute('r'))<12+Math.max(1,n)*6).every(r=>r.getAttribute('ht')==='20'&&r.getAttribute('customHeight')==='1'),
      footerSpacing:rows.slice(-6,-4).map(r=>+r.getAttribute('ht')),
      footerLabelsUnchanged:JSON.stringify(footerShape(rows.slice(-4)))===JSON.stringify(footerShape(originalFooter.slice(-4))),
      marginsCorrect:['top','bottom'].every(side=>Math.abs(Number(margins.getAttribute(side))*25.4-15)<1e-9)&&['left','right','header','footer'].every(side=>margins.getAttribute(side)===originalSheet.querySelector('pageMargins').getAttribute(side)),
      wardPairs:Array.from({length:Math.max(1,n)},(_,i)=>12+i*6).every(first=>[0,2,4].every(offset=>doc.querySelector('mergeCell[ref="D'+(first+offset)+':D'+(first+offset+1)+'"]'))),
      signatureLine:['B','C','D'].every(col=>{const cell=doc.querySelector('c[r="'+col+signatureRow+'"]'),xf=outputXfs[Number(cell?.getAttribute('s')||0)];return outputBorders[Number(xf.getAttribute('borderId')||0)].querySelector('bottom')?.hasAttribute('style')}),
      pages:ends.length,worksheetChildren:[...doc.documentElement.children].map(child=>child.localName),
      repeatedHeader:book.querySelector('definedName[name="_xlnm.Print_Titles"]')?.textContent==="'OT List'!$1:$11",
      dynamicDate:doc.querySelector('[r="A4"]').textContent.includes('2030'),
      printArea:book.querySelector('definedName[name="_xlnm.Print_Area"]')?.textContent==="'OT List'!$A$1:$J$"+(23+(Math.max(1,n)-1)*6)&&lastRow===23+(Math.max(1,n)-1)*6&&doc.querySelector('dimension').getAttribute('ref')==='A1:J'+lastRow});
    }
   }return out;
  });
  // Reproduce the reported 25 October layout without patient information:
  // the middle procedure needs seven rows, so three cases occupy 19, not 18.
  const threeBoxes=await page.evaluate(async()=>{
   const out=[],parse=bytes=>new DOMParser().parseFromString(new TextDecoder().decode(bytes),'application/xml');
   for(const middleRows of [7,8]){
    const list=Array.from({length:3},(_,i)=>({...sample,patient_name:'Synthetic Case '+(i+1),diagnosis:'TEST',surgery:i===1?Array.from({length:middleRows},(_,j)=>'LINE '+(j+1)).join('\n'):'TEST'}));
    const blocks=list.map((p,i)=>otPatientBlocks(p,i,'2026-10-25',true)[0]);
    const blob=await buildOtExcel(template.slice(0),{ot_date:'2026-10-25'},list,{fullIc:true}),bytes=Array.from(new Uint8Array(await blob.arrayBuffer()));
    const parts=await readOtTemplate(new Uint8Array(bytes).buffer),doc=parse(parts['xl/worksheets/sheet1.xml']),book=parse(parts['xl/workbook.xml']);
    const lastRow=30+middleRows,rows=[...doc.querySelectorAll('sheetData row')],margins=doc.querySelector('pageMargins');
    const breaks=[...doc.querySelectorAll('rowBreaks brk')].map(b=>Number(b.getAttribute('id')));
    const height=(a,b)=>rows.filter(r=>+r.getAttribute('r')>=a&&+r.getAttribute('r')<=b).reduce((sum,r)=>sum+Number(r.getAttribute('ht')||15),0);
    const available=(210/25.4-Number(margins.getAttribute('top'))-Number(margins.getAttribute('bottom')))*72;let first=12;
    out.push({middleRows,boxRows:blocks.map(b=>b.rowCount),breaks,bytes,
     pagesFit:[...breaks,lastRow-1].every(end=>{const fits=(height(1,11)+height(first,end)+12)*.69<=available;first=end+1;return fits}),
     printArea:book.querySelector('definedName[name="_xlnm.Print_Area"]').textContent,
     merges:['A12:A17','A18:A'+(17+middleRows),'A'+(18+middleRows)+':A'+(23+middleRows)].every(ref=>!!doc.querySelector('mergeCell[ref="'+ref+'"]')),
     fixedHeight:rows.filter(r=>+r.getAttribute('r')>=12&&+r.getAttribute('r')<=23+middleRows).every(r=>r.getAttribute('ht')==='20'),
     exactProcedure:doc.querySelector('c[r="F18"]').textContent===list[1].surgery});
   }return out;
  });
  for(const row of threeBoxes){
   assert.deepEqual(row.boxRows,[6,row.middleRows,6]);
   assert.deepEqual(row.breaks,row.middleRows===7?[]:[25],'A 6+7+6-row list and signature fit one A4 page; a genuinely taller list keeps whole boxes on separate pages');
   assert.equal(row.printArea,"'OT List'!$A$1:$J$"+(29+row.middleRows));
   assert.ok(row.merges&&row.fixedHeight&&row.exactProcedure&&row.pagesFit,'No case, clinical text, row height, or A4 safety allowance is sacrificed to fit');
   if(process.env.ORL_OT_LAYOUT_QA_DIR){await mkdir(process.env.ORL_OT_LAYOUT_QA_DIR,{recursive:true});await writeFile(resolve(process.env.ORL_OT_LAYOUT_QA_DIR,`synthetic-6-${row.middleRows}-6.xlsx`),new Uint8Array(row.bytes))}
  }
  for(const row of result){
   assertWorksheetOrder(row.worksheetChildren);assert.ok(row.fixedPatientHeight,'Every patient row, including an empty list, keeps template height 20');
   assert.deepEqual(row.footerSpacing,[12,24],'Only the empty gap and signature-line space are compacted');
   assert.ok(row.footerLabelsUnchanged&&row.marginsCorrect,'Footer text, effective styles and populated row heights stay unchanged; only vertical print margins become 15 mm');
   if(row.n<=3)assert.equal(row.pages,1,'Up to three standard patient boxes and the signature fit on one A4 page without shrinking text');
   if(row.n===6)assert.equal(row.pages,2,'Six standard boxes use two full pages, not an extra page for the last patient and signature');
  }
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
   const long='SYNTHETIC LONG CLINICAL DESCRIPTION '.repeat(4)+'END MARKER',patient={...sample,diagnosis:long,surgery:long};
   const output=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},[patient],{fullIc:true}),generated=await readOtTemplate(await output.arrayBuffer()),clinical=parse(generated['xl/worksheets/sheet1.xml']);
   const allCells=[...clinical.querySelectorAll('c')],columnText=col=>allCells.filter(c=>new RegExp('^'+col+'[0-9]+$').test(c.getAttribute('r'))&&Number(c.getAttribute('r').match(/\d+/)[0])>=12).map(c=>c.querySelector('t')?.textContent||'').join('');
   return{cellsSafe,stringsSafe,metaSafe,blankPatientRows:[...doc.querySelectorAll('row')].filter(r=>Number(r.getAttribute('r'))>=12&&Number(r.getAttribute('r'))<=23).every(r=>![...r.querySelectorAll('c')].some(c=>c.querySelector('v,t'))),
    widthPx,footerArial14,signatureLine,worksheetChildren:[...clinical.documentElement.children].map(child=>child.localName),
    exactDiagnosis:columnText('E')===long,exactProcedure:columnText('F')===long,noContinuation:!clinical.documentElement.textContent.includes('Sambungan'),
    onePatient:allCells.filter(c=>/^A[0-9]+$/.test(c.getAttribute('r'))&&c.querySelector('t')?.textContent==='1').length===1,
    oneClinicalCell:allCells.filter(c=>/^F[0-9]+$/.test(c.getAttribute('r'))&&c.querySelector('t')?.textContent===long).length===1,
    identifiedBlocks:allCells.filter(c=>/^A[0-9]+$/.test(c.getAttribute('r'))&&c.querySelector('t')?.textContent==='1').every(c=>{
     const row=Number(c.getAttribute('r').slice(1)),at=(col,r)=>clinical.querySelector('[r="'+col+r+'"]')?.textContent;
     return at('B',row)===sample.patient_name&&at('B',row+2)===sample.patient_ic&&at('B',row+3)===sample.mrn;
    }),
    fixedContinuationHeight:[...clinical.querySelectorAll('row')].filter(r=>Number(r.getAttribute('r'))>=12&&Number(r.getAttribute('r'))<Number(clinical.querySelectorAll('row')[clinical.querySelectorAll('row').length-6].getAttribute('r'))).every(r=>r.getAttribute('ht')==='20'),
    breaks:[...clinical.querySelectorAll('rowBreaks brk')].map(b=>Number(b.getAttribute('id'))),maxHeight:Math.max(...[...clinical.querySelectorAll('row')].map(r=>Number(r.getAttribute('ht'))||15))};
  });
  assertWorksheetOrder(layout.worksheetChildren);
  assert.ok(layout.cellsSafe&&layout.stringsSafe&&layout.metaSafe&&layout.blankPatientRows,'Public template contains only approved static labels and blank patient cells');
  assert.ok(layout.footerArial14,'Footer labels retain effective Arial 14');assert.ok(layout.signatureLine,'Signature has bottom borders across B25:D25');
  assert.equal(layout.widthPx,1268,'Column widths retain the uploaded template proportions');
  assert.ok(layout.exactDiagnosis&&layout.exactProcedure&&layout.noContinuation&&layout.onePatient&&layout.oneClinicalCell&&layout.identifiedBlocks,'Long clinical content remains intact in one patient box with identifiers once');
  assert.ok(layout.maxHeight<80);assert.ok(layout.fixedContinuationHeight,'Long text adds 20pt rows within one box rather than stretching rows');
  const wrapping=await page.evaluate(()=>{
   const limits=[[162,2],[162,1],[162,1],[42,6],[190,6],[183,6],[64,6]],out=[];
   for(const text of ['SHORT','SYNTHETIC LONG WORDS '.repeat(50),'W'.repeat(400),'First line\nSecond line\n'.repeat(15),'ÉTAPE SYNTHÉTIQUE 中文 '.repeat(20)]){
    for(const [width,lines]of limits){const parts=otTextPieces(text,width,lines);out.push({preserved:parts.map(p=>p.text).join('')===text,bounded:parts.every(p=>p.lines<=lines)})}
    for(const fullIc of [false,true]){
     const patient={...sample,patient_name:text,patient_ic:'P'+'9'.repeat(50),mrn:'M'.repeat(70),diagnosis:text,surgery:text,sub_specialty:text};
     const before=JSON.stringify(patient),blocks=otPatientBlocks(patient,0,'2030-01-01',fullIc),block=blocks[0];
     out.push({preserved:blocks.map(b=>b.cells[4]).join('')===clinicalUpper(text)&&blocks.map(b=>b.cells[5]).join('')===clinicalUpper(text)&&JSON.stringify(patient)===before,
      bounded:blocks.length===1&&block.height===20&&block.cells.every((cell,i)=>{
       const lines=otTextPieces(cell,[172,172,172,53,200,193,74][i],10000)[0].lines;
       return lines*18+2<=(i<3?block.identityRows[i]:block.rowCount)*20;
      })});
    }
   }return out;
  });
  for(const check of wrapping){assert.ok(check.preserved,'One box retains every character without changing the source');assert.ok(check.bounded,'Each populated field has enough 20pt rows')}
  const variableBoxes=await page.evaluate(async()=>{
   const procedure='RT TUMOR EXCISION VIA ENDOSCOPIC EAR SURGERY KIV MASTOID EXPLORATION, MRM, ET OBLITERATION, TRANSCERVICAL APPROACH, RIGHT SUPERFICIAL PAROTIDECTOMY';
   const list=[{...sample,surgery:procedure},{...sample,patient_name:'Synthetic Second'},
    {...sample,patient_name:'Synthetic Patient With A Very Long Name For Layout Verification Only',patient_ic:'P'+'9'.repeat(35),mrn:'M'.repeat(40)},
    {...sample,patient_name:'Synthetic Fourth',diagnosis:'LINE ONE\nLINE TWO\nLINE THREE\nLINE FOUR\nLINE FIVE\nLINE SIX\nLINE SEVEN\nLINE EIGHT\nLINE NINE'}];
   const before=JSON.stringify(list),blocks=list.map((p,i)=>otPatientBlocks(p,i,'2030-01-01',true)[0]);
   const original=await readOtTemplate(template.slice(0)),output=await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},list,{fullIc:true}),parts=await readOtTemplate(await output.arrayBuffer());
   const parse=x=>new DOMParser().parseFromString(new TextDecoder().decode(x),'application/xml'),doc=parse(parts['xl/worksheets/sheet1.xml']),styles=parse(parts['xl/styles.xml']);
   const xfs=[...styles.querySelectorAll('cellXfs xf')],borders=[...styles.querySelectorAll('borders border')];
   const at=(col,row)=>doc.querySelector('c[r="'+col+row+'"]'),text=(col,row)=>at(col,row)?.querySelector('t')?.textContent||'';
   const check=[],ends=[];let first=12;
   for(const b of blocks){
    const end=first+b.rowCount-1,icRow=first+b.identityRows[0],mrnRow=icRow+b.identityRows[1];
    check.push(['A','C','E','F','J'].every(col=>!!doc.querySelector('mergeCell[ref="'+col+first+':'+col+end+'"]')));
    check.push(text('A',first)===String(b.number)&&text('B',first)===b.cells[0]&&text('B',icRow)===b.cells[1]&&text('B',mrnRow)===b.cells[2]&&text('F',first)===b.cells[5]);
    for(let row=first;row<=end;row++){
     check.push(doc.querySelector('row[r="'+row+'"]').getAttribute('ht')==='20');
     for(const col of 'ABCDEFGHIJ'){
      const border=borders[Number(xfs[Number(at(col,row).getAttribute('s'))].getAttribute('borderId'))];
      check.push(border.querySelector('top').hasAttribute('style')===(row===first));
      check.push(border.querySelector('bottom').hasAttribute('style')===(row===end));
     }
    }
    ends.push(end);first=end+1;
   }
   const rows=[...doc.querySelectorAll('sheetData row')],height=(a,b)=>rows.filter(r=>+r.getAttribute('r')>=a&&+r.getAttribute('r')<=b).reduce((sum,r)=>sum+Number(r.getAttribute('ht')||15),0);
   const breaks=[...doc.querySelectorAll('rowBreaks brk')].map(b=>+b.getAttribute('id'));let start=12;
   const margins=doc.querySelector('pageMargins'),printableHeight=(210/25.4-Number(margins.getAttribute('top'))-Number(margins.getAttribute('bottom')))*72;
   const pagesFit=[...breaks,first+5].every(end=>{const fits=(height(1,11)+height(start,end))*.69<=printableHeight;start=end+1;return fits});
   return {check,unchanged:before===JSON.stringify(list),pagesFit,wholeBoxes:breaks.every(end=>ends.includes(end)),
    numbers:[...doc.querySelectorAll('c')].filter(c=>/^A\d+$/.test(c.getAttribute('r'))&&+c.getAttribute('r').slice(1)>=12&&c.querySelector('t')?.textContent).map(c=>c.textContent),
    expanded:blocks[0].rowCount>6&&blocks[1].rowCount===6&&blocks[2].identityRows[0]>2,
    footer:doc.querySelector('dimension').getAttribute('ref')==='A1:J'+(first+5),
    fonts:new XMLSerializer().serializeToString(parse(original['xl/styles.xml']).querySelector('fonts'))===new XMLSerializer().serializeToString(styles.querySelector('fonts'))};
  });
  assert.ok(variableBoxes.check.every(Boolean),'Variable boxes have exact values, full-height merges and borders only at each patient boundary');
  assert.deepEqual(variableBoxes.numbers,['1','2','3','4']);assert.ok(variableBoxes.expanded&&variableBoxes.footer&&variableBoxes.wholeBoxes&&variableBoxes.pagesFit&&variableBoxes.fonts&&variableBoxes.unchanged);
  const oversized=await page.evaluate(async()=>{
   try{await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},[{...sample,surgery:'SYNTHETIC LONG CLINICAL DESCRIPTION '.repeat(100)}]);return false}
   catch(error){return /too much text for one A4 patient box/.test(error.message)}
  });assert.ok(oversized,'Impossible one-page merged text is explicitly rejected, never clipped, shrunk or duplicated');
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
     const block=otPatientBlocks(patient,0,'2030-01-01',fullIc)[0];
     const identityCells=[doc.querySelector('c[r="B'+(12+block.identityRows[0])+'"]')];
     out.push({input,fullIc,expected:fullIc?expected:maskPatientIc(input),actual:identityCells.map(c=>c.querySelector('t')?.textContent||'').join(''),textType:identityCells.every(c=>c.getAttribute('t')==='inlineStr')?'inlineStr':'invalid',unchanged:before===JSON.stringify(patient)});
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
   for(const n of [0,1,2,3,4,6,11,12,16]){
    const data=await page.evaluate(async n=>Array.from(new Uint8Array(await (await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},Array.from({length:n},(_,i)=>({...sample,patient_name:'Synthetic Patient '+(i+1),diagnosis:'SYNTHETIC LONG DIAGNOSIS FOR PRINT LAYOUT VERIFICATION',surgery:'SYNTHETIC PROCEDURE FOR PRINT LAYOUT VERIFICATION'})))).arrayBuffer())),n);
    await writeFile(resolve(process.env.ORL_OT_LAYOUT_QA_DIR,`synthetic-${n}.xlsx`),new Uint8Array(data));
   }
   const overflow=await page.evaluate(async()=>Array.from(new Uint8Array(await (await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},[{...sample,patient_name:'Synthetic Patient With A Long Name For Continuation Test',diagnosis:'SYNTHETIC DIAGNOSIS FIRST LINE\nSECOND LINE\nTHIRD LINE\nFOURTH LINE\nFIFTH LINE\nSIXTH LINE\nSEVENTH LINE END',surgery:'SYNTHETIC PROCEDURE STEP ONE VIA ENDOSCOPIC APPROACH FOLLOWED BY STEP TWO AND EXTENDED VERIFICATION OF THE OPERATIVE FIELD WITH FINAL CHECK END MARKER'}],{fullIc:true})).arrayBuffer())));
   await writeFile(resolve(process.env.ORL_OT_LAYOUT_QA_DIR,'synthetic-overflow.xlsx'),new Uint8Array(overflow));
   const singleBox=await page.evaluate(async()=>Array.from(new Uint8Array(await (await buildOtExcel(template.slice(0),{ot_date:'2030-01-01'},[
    {...sample,patient_name:'Pesakit Contoh',diagnosis:'CONTOH DIAGNOSIS',surgery:'RT TUMOR EXCISION VIA ENDOSCOPIC EAR SURGERY KIV MASTOID EXPLORATION, MRM, ET OBLITERATION, TRANSCERVICAL APPROACH, RIGHT SUPERFICIAL PAROTIDECTOMY'},
    {...sample,patient_name:'Pesakit Contoh Kedua',diagnosis:'CONTOH DIAGNOSIS',surgery:'PROSEDUR RINGKAS'}
   ],{fullIc:false})).arrayBuffer())));
   await writeFile(resolve(process.env.ORL_OT_LAYOUT_QA_DIR,'synthetic-single-box.xlsx'),new Uint8Array(singleBox));
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
