// Populate the approved workbook locally from a server-authorized, audited snapshot.
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
async function buildOtExcel(buffer,session,patients,{fullIc=false}={}){
 const entries=await readOtTemplate(buffer),ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main',decoder=new TextDecoder(),parser=new DOMParser(),serializer=new XMLSerializer();
 const parse=name=>{const doc=parser.parseFromString(decoder.decode(entries[name]),'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid template XML.');return doc};
 const sheet=parse('xl/worksheets/sheet1.xml'),book=parse('xl/workbook.xml'),styles=parse('xl/styles.xml'),rows=sheet.getElementsByTagNameNS(ns,'sheetData')[0];
 const all=(doc,tag)=>Array.from(doc.getElementsByTagNameNS(ns,tag));
 // Always start from the unchanged template: each export increases every font
 // by exactly 1 pt, including titles, headers, patient cells and the signature.
 const enlargeFonts=doc=>all(doc,'sz').forEach(size=>{const pt=Number(size.getAttribute('val'));if(!Number.isFinite(pt)||pt<=0)throw Error('Invalid template font size.');size.setAttribute('val',String(pt+1))});
 enlargeFonts(styles);enlargeFonts(sheet);
 if(entries['xl/sharedStrings.xml']){const strings=parse('xl/sharedStrings.xml');enlargeFonts(strings);entries['xl/sharedStrings.xml']=serializer.serializeToString(strings)}
 const setCell=(row,col,value)=>{const ref=col+row.getAttribute('r');let cell=all(row,'c').find(c=>c.getAttribute('r')===ref);if(!cell){cell=sheet.createElementNS(ns,'c');cell.setAttribute('r',ref);row.append(cell)}cell.replaceChildren();cell.setAttribute('t','inlineStr');const is=sheet.createElementNS(ns,'is'),t=sheet.createElementNS(ns,'t');t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');t.textContent=String(value??'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'');is.append(t);cell.append(is)};
 const shiftRef=(ref,delta)=>ref.replace(/(\$?[A-Z]+\$?)(\d+)/g,(_,col,n)=>col+(Number(n)>=15?Number(n)+delta:n));
 const extra=patients.length-6,template=all(rows,'row').find(r=>r.getAttribute('r')==='14').cloneNode(true);
 if(extra<0)all(rows,'row').filter(r=>Number(r.getAttribute('r'))>=9+patients.length&&Number(r.getAttribute('r'))<=14).forEach(r=>r.remove());
 if(extra){
  all(rows,'row').filter(r=>Number(r.getAttribute('r')) >=15).forEach(r=>{r.setAttribute('r',Number(r.getAttribute('r'))+extra);all(r,'c').forEach(c=>c.setAttribute('r',shiftRef(c.getAttribute('r'),extra)))});
  const before=all(rows,'row').find(r=>Number(r.getAttribute('r'))===15+extra);
  for(let n=15;n<15+extra;n++){const r=template.cloneNode(true);r.setAttribute('r',n);all(r,'c').forEach(c=>c.setAttribute('r',c.getAttribute('r').replace(/\d+$/,n)));rows.insertBefore(r,before)}
  all(sheet,'mergeCell').forEach(m=>m.setAttribute('ref',shiftRef(m.getAttribute('ref'),extra)));
  all(sheet,'dimension').forEach(d=>d.setAttribute('ref',shiftRef(d.getAttribute('ref'),extra)));
 }
 const dateRow=all(rows,'row').find(r=>r.getAttribute('r')==='4');for(const col of ['C','D','E','F','G','H'])setCell(dateRow,col,col==='C'?'TARIKH: '+formatOtDocumentDate(session.ot_date)+'.':'');
 patients.forEach((p,i)=>{const r=all(rows,'row').find(r=>Number(r.getAttribute('r'))===9+i),values=[i+1,[patientNameCase(p.patient_name),fullIc?String(p.patient_ic??''):maskPatientIc(p.patient_ic),clinicalUpper(p.mrn)].filter(Boolean).join('\n'),patientAgeText(p,session.ot_date,true),'',clinicalUpper(p.diagnosis),clinicalUpper(p.surgery),'','','',p.sub_specialty];values.forEach((v,j)=>setCell(r,String.fromCharCode(65+j),v));const widths=[5,25,8,13,29,28,21,17,17,11];const lines=Math.max(...values.map((v,j)=>String(v??'').split('\n').reduce((n,l)=>n+Math.max(1,Math.ceil(l.length/((widths[j]-2)*11/12))),0)));r.setAttribute('ht',Math.max(60,lines*14+8));r.setAttribute('customHeight','1')});
 all(book,'definedName').filter(n=>n.getAttribute('name')==='_xlnm.Print_Area').forEach(n=>n.textContent="'OT List'!$A$1:$J$"+(20+extra));
 // One A4 landscape sheet, including the signature. Long lists are scaled by
 // Excel at print time; never truncate clinical text to enforce a page count.
 all(sheet,'pageSetUpPr').forEach(p=>p.setAttribute('fitToPage','1'));
 all(sheet,'pageSetup').forEach(p=>{p.setAttribute('paperSize','9');p.setAttribute('orientation','landscape');p.setAttribute('fitToWidth','1');p.setAttribute('fitToHeight','1');p.removeAttribute('scale')});
 for(const tag of ['rowBreaks','colBreaks'])all(sheet,tag).forEach(p=>p.remove());
 const names=all(book,'definedNames')[0];let title=all(names,'definedName').find(n=>n.getAttribute('name')==='_xlnm.Print_Titles');if(!title){title=book.createElementNS(ns,'definedName');title.setAttribute('name','_xlnm.Print_Titles');title.setAttribute('localSheetId','0');names.append(title)}title.textContent="'OT List'!$1:$8";
 entries['xl/worksheets/sheet1.xml']=serializer.serializeToString(sheet);entries['xl/workbook.xml']=serializer.serializeToString(book);entries['xl/styles.xml']=serializer.serializeToString(styles);
 return new Blob([createDocxBlob(entries)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
let otExportBusy=false;
async function generateOtList(sessionId){
 if(!['ADMIN','WEBMASTER'].includes(user?.role)){toast('Only Admin or Webmaster can generate the OT list.');return}
 if(otExportBusy){toast('An OT list is already being prepared.');return}
 if(!protectedIcEnabled()){toast('Protected OT export is unavailable. Contact Webmaster.');return}
 const session=(window._schedule||[]).find(s=>s.session_id===sessionId);if(!session){toast('OT date could not be found.');return}
 const patients=session.slots.filter(s=>s.patient_name&&s.request_status!=='CANCELLED'&&!['AVAILABLE','CLOSED'].includes(s.status));
 if(!patients.length){toast('No scheduled patients are available for this OT list.');return}
 const owner=token,generation=session._ic_generation;
 modal(`<h2>Generate OT List</h2><p>OT date: ${esc(formatSystemDate(session.ot_date))}</p><div class="security-warning">The Excel file will contain full IC / Passport numbers. Store it securely and share only with authorized clinical staff. Your name, role, time, OT date and patient count will be recorded in Audit Log.</div><form id="otExportForm"><div class="field"><label>Your Current Website Password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required></label></div><label class="confirm-check"><input type="checkbox" required> I am authorized to generate this OT list for clinical use.</label><div class="actions"><button class="primary" type="submit">Generate Excel</button><button type="button" class="secondary" onclick="closeModal()">Cancel</button></div></form>`);
 const form=$('#otExportForm');
 form.onsubmit=async event=>{
  event.preventDefault();if(otExportBusy)return;
  const button=form.querySelector('[type="submit"]'),data={password:form.elements.password.value};
  form.elements.password.value='';button.disabled=true;button.textContent='Preparing…';otExportBusy=true;
  let result=null,abandoned=false;
  const onVisibility=()=>{if(document.hidden)abandoned=true};
  document.addEventListener('visibilitychange',onVisibility);
  const stillActive=()=>{if(abandoned||document.hidden||!form.isConnected||token!==owner||!['ADMIN','WEBMASTER'].includes(user?.role))throw Error('Export cancelled. Reopen Generate OT List when ready.')};
  try{
   stillActive();
   const response=await fetch('assets/ot-list-template.xlsx?v=066',{cache:'no-store'});
   if(!response.ok)throw Error('Unable to load Excel template.');
   const template=await response.arrayBuffer();stillActive();
   result=await rpc('orl_ic_ot_export',{p_session_token:owner,p_password:data.password,p_session_id:sessionId,p_generation:generation});
   data.password='';stillActive();
   const blob=await buildOtExcel(template,result.session,result.patients,{fullIc:true});
   stillActive();if(Date.parse(result.expires_at)<=Date.now())throw Error('Export expired. Reopen and review.');
   const url=URL.createObjectURL(blob),link=document.createElement('a');
   try{link.href=url;link.download='OT-List-'+formatSystemDate(result.session.ot_date)+'.xlsx';document.body.append(link);link.click()}
   finally{link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
   closeModal();toast('Excel download started. Generation recorded in Audit Log.');
  }catch(error){if(token===owner)toast(error.message)}
  finally{
   data.password='';if(result){for(const p of result.patients)p.patient_ic='';result=null}
   document.removeEventListener('visibilitychange',onVisibility);otExportBusy=false;
   if(form.isConnected){button.disabled=false;button.textContent='Generate Excel'}
  }
 };
}
