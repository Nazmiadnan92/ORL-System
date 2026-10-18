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
// Wrap estimates use the same Arial 14 font as Excel. Pieces preserve every
// character; unusually long clinical text continues in another six-row block.
function otTextPieces(value,width,maxLines){
 const text=String(value??''),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
 ctx.font='14pt Arial';const lines=[];let remaining=text;
 while(remaining){
  let length=0,lastSpace=0;
  for(const char of remaining){
   const next=length+char.length;
   if(char==='\n'){length=next;break}
   if(length&&ctx.measureText(remaining.slice(0,next)).width>width){length=lastSpace||length;break}
   length=next;if(/\s/.test(char))lastSpace=length;
  }
  if(!length)length=Array.from(remaining)[0].length;
  lines.push(remaining.slice(0,length));remaining=remaining.slice(length);
 }
 if(!lines.length)return[{text:'',lines:1}];
 const parts=[];for(let i=0;i<lines.length;i+=maxLines)parts.push({text:lines.slice(i,i+maxLines).join(''),lines:Math.min(maxLines,lines.length-i)});
 return parts;
}
function otExportIdentity(value){
 const text=String(value??''),digits=text.replace(/[ -]/g,'');
 // Format only a twelve-digit IC, never strip letters or punctuation from a passport.
 return /^[0-9 -]+$/.test(text)&&/^[0-9]{12}$/.test(digits)?digits.slice(0,6)+'-'+digits.slice(6,8)+'-'+digits.slice(8):text;
}
function otPatientBlocks(patient,index,date,fullIc){
 const values=[patientNameCase(patient.patient_name),fullIc?otExportIdentity(patient.patient_ic):maskPatientIc(patient.patient_ic),
  clinicalUpper(patient.mrn),patientAgeText(patient,date,true),clinicalUpper(patient.diagnosis),clinicalUpper(patient.surgery),patient.sub_specialty];
 // Each template row stays 20pt: name spans two rows (40pt), IC/MRN one
 // each (20pt), and clinical fields six (120pt). Conservative inner widths
 // and line budgets keep Arial 14 unchanged; overflow gets another block.
 const limits=[[162,2],[162,1],[162,1],[42,6],[190,6],[183,6],[64,6]];
 const fields=values.map((value,i)=>otTextPieces(value,...limits[i])),count=Math.max(...fields.map(p=>p.length)),blocks=[];
 for(let part=0;part<count;part++){
  const cells=fields.map(p=>p[part]||{text:'',lines:1});
  // Keep a detached continuation page identifiable without revealing an IC
  // outside the same audited/fullIc authorization used for its first block.
  if(part)for(const i of [0,1,2,3,6])if(fields[i].length===1)cells[i]=fields[i][0];
  if(part&&!cells[0].text)cells[0]={text:'Kes '+(index+1),lines:1};
  blocks.push({number:index+1,part,cells:cells.map(c=>c.text),height:20});
 }
 return blocks;
}
async function buildOtExcel(buffer,session,patients,{fullIc=false}={}){
 patients=patients.filter(patient=>patient.ot_hold!==true);
 const entries=await readOtTemplate(buffer),ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main',decoder=new TextDecoder(),parser=new DOMParser(),serializer=new XMLSerializer();
 const parse=name=>{const doc=parser.parseFromString(decoder.decode(entries[name]),'application/xml');if(doc.querySelector('parsererror'))throw new Error('Invalid template XML.');return doc};
 const sheet=parse('xl/worksheets/sheet1.xml'),book=parse('xl/workbook.xml'),styles=parse('xl/styles.xml'),rows=sheet.getElementsByTagNameNS(ns,'sheetData')[0];
 const all=(doc,tag)=>Array.from(doc.getElementsByTagNameNS(ns,tag));
 const setCell=(row,col,value)=>{const ref=col+row.getAttribute('r');let cell=all(row,'c').find(c=>c.getAttribute('r')===ref);if(!cell){cell=sheet.createElementNS(ns,'c');cell.setAttribute('r',ref);row.append(cell)}cell.replaceChildren();cell.setAttribute('t','inlineStr');const is=sheet.createElementNS(ns,'is'),t=sheet.createElementNS(ns,'t');t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');t.textContent=String(value??'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'');is.append(t);cell.append(is)};
 const sourceRows=all(rows,'row'),rowAt=n=>sourceRows.find(r=>Number(r.getAttribute('r'))===n),merges=all(sheet,'mergeCells')[0];
 const mergeRefs=all(merges,'mergeCell').map(m=>m.getAttribute('ref'));
 const body=sourceRows.filter(r=>Number(r.getAttribute('r'))>=12&&Number(r.getAttribute('r'))<=17);
 const footer=sourceRows.filter(r=>Number(r.getAttribute('r'))>=24&&Number(r.getAttribute('r'))<=29);
 if(body.length!==6||footer.length!==6||!rowAt(29)||!['B29:E29','B12:B13','A12:A17','C12:C17','E12:E17','F12:F17','J12:J17','D12:D13','D14:D15','D16:D17'].every(ref=>mergeRefs.includes(ref)))throw Error('OT template version mismatch. Reload the website before generating.');
 const shift=(ref,delta)=>ref.replace(/(\$?[A-Z]+\$?)(\d+)/g,(_,col,n)=>col+(Number(n)+delta));
 const bodyMerges=mergeRefs.filter(ref=>{const ends=ref.match(/\d+/g).map(Number);return ends[0]>=12&&ends[1]<=17});
 const footerMerges=mergeRefs.filter(ref=>Number(ref.match(/\d+/)[0])>=24);
 sourceRows.filter(r=>Number(r.getAttribute('r'))>=12).forEach(r=>r.remove());
 all(merges,'mergeCell').filter(m=>Number(m.getAttribute('ref').match(/\d+/)[0])>=12).forEach(m=>m.remove());
 const addMerge=ref=>{const m=sheet.createElementNS(ns,'mergeCell');m.setAttribute('ref',ref);merges.append(m)};
 const cloneRows=(source,delta,height)=>source.map(original=>{const row=original.cloneNode(true);row.setAttribute('r',Number(row.getAttribute('r'))+delta);all(row,'c').forEach(c=>c.setAttribute('r',shift(c.getAttribute('r'),delta)));if(height){row.setAttribute('ht',height);row.setAttribute('customHeight','1')}rows.append(row);return row});
 setCell(rowAt(4),'A','TARIKH: '+formatOtDocumentDate(session.ot_date)+'.');
 const blocks=patients.flatMap((patient,index)=>otPatientBlocks(patient,index,session.ot_date,fullIc));
 if(!blocks.length)blocks.push({number:'',part:0,cells:['No scheduled patients.','','','','','',''],height:20});
 const headerHeight=sourceRows.filter(r=>Number(r.getAttribute('r'))<=11).reduce((sum,r)=>sum+Number(r.getAttribute('ht')||15),0);
 // Preserve the uploaded template's fixed print scale. Disable fit-to-page so
 // manual breaks are honoured; more patients add pages, never smaller fonts.
 const printScale=69,bodyBudget=(210/25.4*72-108)/(printScale/100)-headerHeight-12;
 const footerHeight=footer.reduce((sum,r)=>sum+Number(r.getAttribute('ht')||15),0);
 const breaks=[];let used=0;
 blocks.forEach((block,i)=>{
  const first=12+i*6,height=block.height*6,last=i===blocks.length-1;
  if(height>bodyBudget)throw Error('OT text layout could not fit safely. Contact Webmaster; no file was downloaded.');
  if(used&&(used+height>bodyBudget||(last&&height+footerHeight<=bodyBudget&&used+height+footerHeight>bodyBudget))){breaks.push(first-1);used=0}
  const cloned=cloneRows(body,i*6,block.height);bodyMerges.forEach(ref=>addMerge(shift(ref,i*6)));
  for(const row of cloned)for(const col of 'ABCDEFGHIJ')setCell(row,col,'');
  const[name,ic,mrn,age,diagnosis,surgery,sub]=block.cells;
  [['A',block.number],['B',name],['C',age],['E',diagnosis],['F',surgery],['J',sub]].forEach(([col,value])=>setCell(cloned[0],col,value));
  setCell(cloned[2],'B',ic);setCell(cloned[3],'B',mrn);if(block.part)setCell(cloned[5],'B','Sambungan');
  used+=height;
 });
 const delta=(blocks.length-2)*6,footerStart=24+delta,lastRow=29+delta;
 if(used+footerHeight>bodyBudget)breaks.push(footerStart-1);
 cloneRows(footer,delta);footerMerges.forEach(ref=>addMerge(shift(ref,delta)));
 merges.setAttribute('count',String(all(merges,'mergeCell').length));
 // OOXML requires dimension after optional sheetPr and before all other sheet
 // content. The approved template has no sheetViews; never append it at the end.
 let dimension=all(sheet,'dimension')[0];if(!dimension)dimension=sheet.createElementNS(ns,'dimension');
 const firstContent=Array.from(sheet.documentElement.children).find(node=>node!==dimension&&node.localName!=='sheetPr');
 sheet.documentElement.insertBefore(dimension,firstContent||null);dimension.setAttribute('ref','A1:J'+lastRow);
 const names=all(book,'definedNames')[0];for(const[name,value]of [['_xlnm.Print_Area',"'OT List'!$A$1:$J$"+lastRow],['_xlnm.Print_Titles',"'OT List'!$1:$11"]]){
  let item=all(names,'definedName').find(n=>n.getAttribute('name')===name);if(!item){item=book.createElementNS(ns,'definedName');item.setAttribute('name',name);item.setAttribute('localSheetId','0');names.append(item)}item.textContent=value;
 }
 all(sheet,'pageSetUpPr').forEach(p=>p.setAttribute('fitToPage','0'));
 all(sheet,'pageSetup').forEach(p=>{p.setAttribute('paperSize','9');p.setAttribute('orientation','landscape');p.setAttribute('scale',String(printScale));p.setAttribute('fitToHeight','0');p.removeAttribute('fitToWidth')});
 for(const tag of ['rowBreaks','colBreaks'])all(sheet,tag).forEach(p=>p.remove());
 if(breaks.length){const element=sheet.createElementNS(ns,'rowBreaks');element.setAttribute('count',breaks.length);element.setAttribute('manualBreakCount',breaks.length);for(const id of breaks){const b=sheet.createElementNS(ns,'brk');for(const[k,v]of Object.entries({id,min:0,max:16383,man:1}))b.setAttribute(k,v);element.append(b)}sheet.documentElement.insertBefore(element,all(sheet,'drawing')[0]||null)}
 entries['xl/worksheets/sheet1.xml']=serializer.serializeToString(sheet);entries['xl/workbook.xml']=serializer.serializeToString(book);entries['xl/styles.xml']=serializer.serializeToString(styles);
 return new Blob([createDocxBlob(entries)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
let otExportBusy=false;
async function generateOtList(sessionId){
 if(!['ADMIN','WEBMASTER'].includes(user?.role)){toast('Only Admin or Webmaster can generate the OT list.');return}
 if(otExportBusy){toast('An OT list is already being prepared.');return}
 if(!protectedIcEnabled()){toast('Protected OT export is unavailable. Contact Webmaster.');return}
 const session=(window._schedule||[]).find(s=>s.session_id===sessionId);if(!session){toast('OT date could not be found.');return}
 const patients=session.slots.filter(s=>s.patient_name&&s.ot_hold!==true&&s.request_status!=='CANCELLED'&&!['AVAILABLE','CLOSED'].includes(s.status));
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
   // Keep the old asset intact for already-open tabs using the earlier layout.
   const response=await fetch('assets/ot-list-template-v072.xlsx',{cache:'no-store'});
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
