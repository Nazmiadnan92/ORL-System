// Populate the approved blank workbook locally. No patient data leaves the browser.
async function readOtTemplate(buffer){
 const bytes=new Uint8Array(buffer),v=new DataView(buffer),decode=new TextDecoder();let end=bytes.length-22;
 while(end>=0&&v.getUint32(end,true)!==0x06054b50)end--;
 if(end<0)throw new Error('Invalid Excel template.');
 let pos=v.getUint32(end+16,true);const entries={};
 for(let i=0;i<v.getUint16(end+10,true);i++){
  if(v.getUint32(pos,true)!==0x02014b50)throw new Error('Invalid template directory.');
  const method=v.getUint16(pos+10,true),size=v.getUint32(pos+20,true),len=v.getUint16(pos+28,true),extra=v.getUint16(pos+30,true),comment=v.getUint16(pos+32,true),off=v.getUint32(pos+42,true),name=decode.decode(bytes.slice(pos+46,pos+46+len));
  const start=off+30+v.getUint16(off+26,true)+v.getUint16(off+28,true),data=bytes.slice(start,start+size);
  if(method===0)entries[name]=data;
  else if(method===8)entries[name]=new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  else throw new Error('Unsupported Excel template compression.');
  pos+=46+len+extra+comment;
 }return entries;
}
async function buildOtExcel(buffer,session,patients){
 const entries=await readOtTemplate(buffer),ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main',decoder=new TextDecoder(),parser=new DOMParser(),serializer=new XMLSerializer();
 const parse=name=>{const doc=parser.parseFromString(decoder.decode(entries[name]),'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid template XML.');return doc};
 const sheet=parse('xl/worksheets/sheet1.xml'),book=parse('xl/workbook.xml'),rows=sheet.getElementsByTagNameNS(ns,'sheetData')[0];
 const all=(doc,tag)=>Array.from(doc.getElementsByTagNameNS(ns,tag));
 const setCell=(row,col,value)=>{const ref=col+row.getAttribute('r');let cell=all(row,'c').find(c=>c.getAttribute('r')===ref);if(!cell){cell=sheet.createElementNS(ns,'c');cell.setAttribute('r',ref);row.append(cell)}cell.replaceChildren();cell.setAttribute('t','inlineStr');const is=sheet.createElementNS(ns,'is'),t=sheet.createElementNS(ns,'t');t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');t.textContent=String(value??'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'');is.append(t);cell.append(is)};
 const shiftRef=(ref,delta)=>ref.replace(/(\$?[A-Z]+\$?)(\d+)/g,(_,col,n)=>col+(Number(n)>=19?Number(n)+delta:n));
 const extra=Math.max(0,patients.length-10),template=all(rows,'row').find(r=>r.getAttribute('r')==='18').cloneNode(true);
 if(extra){
  all(rows,'row').filter(r=>Number(r.getAttribute('r'))>=19).forEach(r=>{r.setAttribute('r',Number(r.getAttribute('r'))+extra);all(r,'c').forEach(c=>c.setAttribute('r',shiftRef(c.getAttribute('r'),extra)))});
  const before=all(rows,'row').find(r=>Number(r.getAttribute('r'))===19+extra);
  for(let n=19;n<19+extra;n++){const r=template.cloneNode(true);r.setAttribute('r',n);all(r,'c').forEach(c=>c.setAttribute('r',c.getAttribute('r').replace(/\d+$/,n)));rows.insertBefore(r,before)}
  all(sheet,'mergeCell').forEach(m=>m.setAttribute('ref',shiftRef(m.getAttribute('ref'),extra)));
  all(sheet,'dimension').forEach(d=>d.setAttribute('ref',shiftRef(d.getAttribute('ref'),extra)));
 }
 const dateRow=all(rows,'row').find(r=>r.getAttribute('r')==='4');for(const col of ['C','D','E','F','G','H'])setCell(dateRow,col,col==='C'?'TARIKH: '+formatOtDocumentDate(session.ot_date)+'.':'');
 patients.forEach((p,i)=>{const r=all(rows,'row').find(r=>Number(r.getAttribute('r'))===9+i),values=[i+1,[patientNameCase(p.patient_name),formatPatientIc(p.patient_ic),clinicalUpper(p.mrn)].filter(Boolean).join('\n'),patientAgeText(p,session.ot_date,true),'',clinicalUpper(p.diagnosis),clinicalUpper(p.surgery),'','','',p.sub_specialty];values.forEach((v,j)=>setCell(r,String.fromCharCode(65+j),v));const widths=[5,25,8,13,29,28,21,17,17,11];const lines=Math.max(...values.map((v,j)=>String(v??'').split('\n').reduce((n,l)=>n+Math.max(1,Math.ceil(l.length/(widths[j]-2))),0)));r.setAttribute('ht',Math.max(48,lines*13+8));r.setAttribute('customHeight','1')});
 all(book,'definedName').filter(n=>n.getAttribute('name')==='_xlnm.Print_Area').forEach(n=>n.textContent="'OT List'!$A$1:$J$"+(23+extra));
 // Allow tall lists to flow down pages rather than shrinking text to one page.
 all(sheet,'pageSetup').forEach(p=>{p.setAttribute('fitToWidth','1');p.setAttribute('fitToHeight','0')});
 const names=all(book,'definedNames')[0];let title=all(names,'definedName').find(n=>n.getAttribute('name')==='_xlnm.Print_Titles');if(!title){title=book.createElementNS(ns,'definedName');title.setAttribute('name','_xlnm.Print_Titles');title.setAttribute('localSheetId','0');names.append(title)}title.textContent="'OT List'!$1:$8";
 entries['xl/worksheets/sheet1.xml']=serializer.serializeToString(sheet);entries['xl/workbook.xml']=serializer.serializeToString(book);
 return new Blob([createDocxBlob(entries)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
async function generateOtList(sessionId){
 if(!['ADMIN','WEBMASTER'].includes(user?.role)){toast('Only Admin or Webmaster can generate the OT list.');return}
 const session=(window._schedule||[]).find(s=>s.session_id===sessionId);if(!session){toast('OT date could not be found.');return}
 const patients=session.slots.filter(s=>s.patient_name&&s.request_status!=='CANCELLED'&&!['AVAILABLE','CLOSED'].includes(s.status));
 if(!patients.length){toast('No scheduled patients are available for this OT list.');return}
 try{toast('Preparing Excel OT list…');const response=await fetch('assets/ot-list-template.xlsx?v=063');if(!response.ok)throw new Error('Unable to load Excel template.');const blob=await buildOtExcel(await response.arrayBuffer(),session,patients),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='OT-List-'+formatSystemDate(session.ot_date)+'.xlsx';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Excel OT list downloaded.');}catch(e){toast('Could not generate Excel OT list: '+e.message)}
}
