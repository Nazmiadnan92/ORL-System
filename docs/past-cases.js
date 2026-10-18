// Historical corrections use a freshly issued protected snapshot, never the schedule cache.
let pastCaseBusy=false,pastCaseReadSequence=0;
const pastCaseFields=Object.freeze([
  ['patient_name','Patient Name',240,true],['mrn','MRN',120,true],['age','Age (Years)',130,true],
  ['age_months','Age (Months)',11,false],['diagnosis','Diagnosis',4096,true],['surgery','Surgery / Procedure',4096,true],
  ['doctor','Doctor',240,true],['specialist','Specialist',240,false],['sub_specialty','Sub-specialty',120,true],
  ['phone','Phone',240,false],['remark','Remark',4096,false]
]);
function pastCaseActions(slot,session){
  if(user?.role!=='WEBMASTER'||!protectedIcEnabled()||!isPastOtDate(session.ot_date))return '';
  if(!/^[0-9a-f-]{36}$/i.test(slot.id||''))return '';
  if(slot.request_id)return `<button class="mini past-case-control" onclick="openPastCase('${slot.id}')">Edit Past Record</button>`;
  if(!slot.patient_name&&['AVAILABLE','CLOSED'].includes(slot.status))return `<button class="mini past-case-control" onclick="openPastCase('${slot.id}')">＋ Add Past Case</button>`;
  return '';
}
function pastCaseInput([key,label,max,required],value){
  const number=key==='age'||key==='age_months',wide=['patient_name','diagnosis','surgery','remark'].includes(key);
  let control;
  if(key==='sub_specialty'){
    const options=subspecialtyOptions();if(value&&!options.includes(value))options.push(value);
    control=`<select name="${key}" required>${options.map(option=>`<option value="${esc(option)}">${esc(option)}</option>`).join('')}</select>`;
  }else if(['diagnosis','surgery','remark'].includes(key))control=`<textarea name="${key}" rows="${key==='remark'?3:2}" maxlength="${max}" ${required?'required':''}></textarea>`;
  else control=`<input name="${key}" type="${number?'number':'text'}" ${number?`min="0" max="${max}" step="1"`:`maxlength="${max}"`} ${required?'required':''}>`;
  return `<div class="field ${wide?'wide':''}"><label>${label}${!required&&!number?' (optional)':''}${control}</label>${key==='age_months'?'<small>Blank means unknown. Ages refer to this OT date.</small>':key==='age'?'<small>A new valid Malaysian IC calculates age at this OT date. Otherwise enter the historical age.</small>':''}</div>`;
}
function pastCaseReadData(form,allowMissingAge=false){
  const data={};
  for(const [key,label,max,required] of pastCaseFields){
    const raw=form.elements[key].value.trim();
    if(required&&!raw&&!(key==='age'&&allowMissingAge))throw Error(`${label} is required.`);
    if(key==='age'||key==='age_months'){
      if(raw!==''&&(!/^\d+$/.test(raw)||Number(raw)>max))throw Error(`${label} must be a whole number from 0 to ${max}.`);
      data[key]=raw;
    }else{
      if(raw.length>max)throw Error(`${label} is too long.`);
      data[key]=['patient_name','doctor','specialist'].includes(key)?patientNameCase(raw):['mrn','diagnosis','surgery'].includes(key)?clinicalUpper(raw):raw;
    }
  }
  return data;
}
function pastCaseReviewRows(before,after,mode){
  return pastCaseFields.filter(([key])=>mode==='ADD'||String(before?.[key]??'')!==String(after[key]??'')).map(([key,label])=>
    `<div class="past-case-change"><dt>${label}</dt>${mode==='EDIT'?`<dd class="past-case-before"><small>Before</small>${esc(before?.[key]??'')||'—'}</dd>`:''}<dd class="past-case-after"><small>${mode==='EDIT'?'After':'Record'}</small>${esc(after[key]??'')||'—'}</dd></div>`).join('');
}
async function openPastCase(slotId){
  if(pastCaseBusy)return;
  if(user?.role!=='WEBMASTER'||!protectedIcEnabled()){toast('Webmaster access required.');return}
  if(!/^[0-9a-f-]{36}$/i.test(slotId||'')){toast('Reload the schedule and select the historical slot again.');return}
  const owner=token,sequence=++pastCaseReadSequence;
  modal('<section class="past-case-panel" id="pastCaseLoading"><span class="past-case-eyebrow">WEBMASTER · HISTORICAL RECORDS</span><h2>Loading Past Record</h2><p role="status">Checking the current slot and record safely…</p></section>');
  const loading=$('#pastCaseLoading');
  try{
    const view=await rpc('orl_ic_past_case_view',{p_session_token:owner,p_slot_id:slotId});
    if(sequence!==pastCaseReadSequence||token!==owner||user?.role!=='WEBMASTER'||!loading.isConnected||$('#modal').hidden)return;
    if(!view||view.slot_id!==slotId||!['EDIT','ADD'].includes(view.mode)||!view._ic_past_context||!isPastOtDate(view.ot_date)
      ||(view.mode==='EDIT'&&(!view.request_id||!view.patient))||(view.mode==='ADD'&&(view.request_id||view.patient)))throw Error('This historical slot could not be verified. Reload and check it again.');
    const context=view._ic_past_context,mode=view.mode,before=Object.freeze({...view.patient}),
      selected=Object.freeze({mode,slotId,requestId:view.request_id,otDate:view.ot_date,type:view.slot_type,number:view.slot_number,
        status:view.request_status,hold:view.ot_hold===true,count:view.postpone_count}),
      title=mode==='EDIT'?'Edit Past Record':'Add Past Case';
    const addNote='Records a missed case in this historical slot. It is not marked Done. Confirm Done separately only after verifying the operation took place.';
    const editNote='Correct historical details only. OT date, slot, status, OT Hold and postpone count stay unchanged.';
    modal(`<section class="past-case-panel"><span class="past-case-eyebrow">WEBMASTER · HISTORICAL RECORDS</span><h2>${title}</h2><div class="past-case-context"><div><small>OT DATE</small><strong>${esc(formatSystemDate(selected.otDate))}</strong></div><div><small>SLOT</small><strong>${esc(selected.type==='SPECIAL'?'Special':'Main')} Slot ${esc(selected.number)}</strong></div><span class="past-case-badge">PAST · CLOSED TO REQUESTS</span></div><div class="past-case-notice"><b>Historical record ${mode==='EDIT'?'correction':'entry'}</b><p>${mode==='EDIT'?editNote:addNote}</p></div><form id="pastCaseForm" novalidate><fieldset id="pastCaseDetails"><legend class="past-case-sr-only">Historical patient details</legend><div class="grid">${pastCaseFields.map(field=>pastCaseInput(field,before[field[0]])).join('')}<div class="field wide past-case-identity"><label>Patient IC / Passport${mode==='EDIT'?`<select name="ic_mode"><option value="KEEP">Keep existing protected identity (${esc(maskPatientIc(before.patient_ic||''))||'not recorded'})</option><option value="SET">Replace identity — correction only</option></select>`:' (optional)'}</label><div id="pastCaseIdentityInput" ${mode==='EDIT'?'hidden':''}><label>${mode==='EDIT'?'Correct IC / Passport':'IC / Passport'}<input name="patient_ic" type="text" maxlength="128" autocomplete="off" spellcheck="false"></label><small>${mode==='EDIT'?'Replacement must be entered explicitly. The current full identity is not revealed here.':'The identity will be protected. Leave blank if not recorded.'}</small></div></div><div class="field wide"><label>Reason for ${mode==='EDIT'?'Correction':'Late Entry'}<textarea name="reason" maxlength="2000" rows="3" required placeholder="Explain why this historical record needs to be ${mode==='EDIT'?'corrected':'added'}."></textarea></label><small>Your name, time and reason will be recorded in Audit Log.</small></div></div></fieldset><section id="pastCaseReview" hidden aria-labelledby="pastCaseReviewHeading"><h3 id="pastCaseReviewHeading" tabindex="-1">Review Before Saving</h3><dl id="pastCaseChanges" class="past-case-changes"></dl><div class="past-case-review-note"><b>Reason</b><p id="pastCaseReason"></p><p id="pastCaseIdentitySummary"></p><small>Full IC / Passport is not shown in this review or stored as plaintext in Audit Log.</small></div><div class="field"><label>Your Current Website Password<input name="password" type="password" autocomplete="current-password" maxlength="1024" disabled></label></div><label class="confirm-check past-case-confirm"><input name="confirmed" type="checkbox" disabled> I checked these historical details and the reason for this change.</label></section><div class="actions past-case-actions"><button class="primary" id="pastCaseSubmit" type="submit">Review Changes</button><button class="secondary" id="pastCaseBack" type="button" hidden>Back to Edit</button><button class="secondary" id="pastCaseCancel" type="button">Cancel</button></div><p id="pastCaseMessage" role="status" aria-live="polite"></p></form></section>`);
    const patientSummary=document.createElement('p');patientSummary.className='past-case-patient';patientSummary.id='pastCasePatientSummary';
    const patientLabel=mode==='EDIT'?`${before.patient_name||'Historical patient'} · MRN: ${before.mrn||'—'}`:'New historical case';
    patientSummary.textContent=patientLabel;$('.past-case-context').after(patientSummary);
    const form=$('#pastCaseForm'),details=$('#pastCaseDetails'),review=$('#pastCaseReview'),message=$('#pastCaseMessage'),submit=$('#pastCaseSubmit'),back=$('#pastCaseBack');
    for(const [key] of pastCaseFields)form.elements[key].value=before[key]??'';
    if(mode==='ADD')form.elements.sub_specialty.value=subspecialtyOptions()[0]||'';
    if(mode==='EDIT'&&before.age===null)form.elements.age.required=false;
    bindClinicalFormatting(form);
    let reviewed=null,consumed=false,disposed=false,manualAge=null;
    const syncHistoricalAge=()=>{
      const replacing=mode==='ADD'||form.elements.ic_mode.value==='SET';
      const parts=replacing?icAgeParts(form.elements.patient_ic.value,new Date(selected.otDate+'T12:00:00')):null;
      if(parts){
        if(manualAge===null)manualAge={years:form.elements.age.value,months:form.elements.age_months.value};
        form.elements.age.value=String(parts.years);form.elements.age_months.value=String(parts.months);
        form.elements.age.readOnly=true;form.elements.age_months.readOnly=true;
      }else{
        if(manualAge!==null){form.elements.age.value=manualAge.years;form.elements.age_months.value=manualAge.months;manualAge=null}
        form.elements.age.readOnly=false;form.elements.age_months.readOnly=false;
      }
    };
    form.elements.patient_ic.addEventListener('input',syncHistoricalAge);
    const scrub=()=>{form.elements.password.value='';form.elements.patient_ic.value=''};
    const dispose=()=>{if(disposed)return;disposed=true;scrub();observer.disconnect();document.removeEventListener('visibilitychange',onVisibility)};
    const observer=new MutationObserver(()=>{if(!form.isConnected||$('#modal').hidden)dispose()});
    observer.observe($('#modal'),{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});
    const onVisibility=()=>{if(document.hidden){scrub();if(!consumed)syncHistoricalAge();if(reviewed&&!consumed){returnToEdit();message.textContent='Private fields were cleared when this tab was hidden. Review again before saving.'}}};
    document.addEventListener('visibilitychange',onVisibility);
    const returnToEdit=()=>{if(consumed)return;reviewed=null;details.disabled=false;details.hidden=false;review.hidden=true;back.hidden=true;submit.textContent='Review Changes';form.elements.password.value='';form.elements.password.disabled=true;form.elements.confirmed.disabled=true;form.elements.confirmed.checked=false;patientSummary.textContent=patientLabel;message.textContent=''};
    back.onclick=returnToEdit;
    $('#pastCaseCancel').onclick=()=>{dispose();closeModal()};
    if(mode==='EDIT')form.elements.ic_mode.onchange=()=>{const replace=form.elements.ic_mode.value==='SET';$('#pastCaseIdentityInput').hidden=!replace;form.elements.patient_ic.value='';syncHistoricalAge()};
    form.onsubmit=async event=>{
      event.preventDefault();if(consumed||pastCaseBusy||disposed)return;
      if(token!==owner||user?.role!=='WEBMASTER'||!protectedIcEnabled()||!form.isConnected||$('#modal').hidden){scrub();message.textContent='Please sign in again and reopen this historical slot.';return}
      if(!reviewed){
        try{
          // Compute again at review time, including programmatic/autofill changes.
          // KEEP never derives an age from a masked identity or today's date.
          syncHistoricalAge();
          const data=pastCaseReadData(form,mode==='EDIT'&&before.age===null),reason=form.elements.reason.value.trim(),icMode=mode==='EDIT'?form.elements.ic_mode.value:'SET';
          if(!reason||reason.length>2000)throw Error('Enter a reason for this historical change (up to 2,000 characters).');
          if(!['KEEP','SET'].includes(icMode))throw Error('Select how to handle the protected identity.');
          if(icMode==='SET'&&mode==='EDIT'&&!form.elements.patient_ic.value.trim())throw Error('Enter the corrected IC / Passport, or choose Keep existing protected identity.');
          if(form.elements.patient_ic.value.length>128)throw Error('IC / Passport is too long.');
          if(icMode==='SET'&&form.elements.patient_ic.value.includes('*'))throw Error('Enter the actual IC / Passport, not a masked value.');
          const changes=pastCaseReviewRows(before,data,mode);
          if(mode==='EDIT'&&!changes&&icMode==='KEEP')throw Error('No details have changed. Cancel or enter a correction.');
          reviewed=Object.freeze({data:Object.freeze({...data}),reason,icMode,calculatedAge:icMode==='SET'&&form.elements.age.readOnly});
          $('#pastCaseChanges').innerHTML=changes||'<p>No clinical details changed.</p>';
          $('#pastCaseReason').textContent=reason;
          if(mode==='ADD')patientSummary.textContent=`${data.patient_name} · MRN: ${data.mrn}`;
          $('#pastCaseIdentitySummary').textContent=icMode==='KEEP'?'Protected identity: unchanged.':form.elements.patient_ic.value.trim()?'Protected identity: new value will be securely saved.':'Protected identity: not recorded.';
          details.disabled=true;details.hidden=true;review.hidden=false;back.hidden=false;form.elements.password.disabled=false;form.elements.confirmed.disabled=false;
          submit.textContent=mode==='EDIT'?'Save Historical Correction':'Add Historical Case';message.textContent='';$('#pastCaseReviewHeading').focus();
        }catch(error){message.textContent=error.message}
        return;
      }
      if(!form.elements.password.value||!form.elements.confirmed.checked){message.textContent='Enter your current website password and confirm that you checked these details.';return}
      let requestId;
      try{requestId=selected.requestId||crypto.randomUUID()}catch{message.textContent='This browser cannot safely prepare the entry. Use an updated browser. Nothing was submitted.';return}
      // A masked historical view can display an OT-date age derived from IC,
      // while the stored age is older. KEEP must not rewrite unchanged fields.
      const writeData=mode==='ADD'?{...reviewed.data}:Object.fromEntries(Object.entries(reviewed.data).filter(([key,value])=>String(before[key]??'')!==String(value??'')));
      if(reviewed.calculatedAge){writeData.age=reviewed.data.age;writeData.age_months=reviewed.data.age_months}
      const args={p_session_token:owner,p_context:context,p_request_id:requestId,p_data:writeData,p_reason:reviewed.reason,p_ic_mode:reviewed.icMode,p_password:form.elements.password.value};
      if(reviewed.icMode==='SET')args.p_data.patient_ic=form.elements.patient_ic.value.trim();
      consumed=true;pastCaseBusy=true;submit.disabled=true;back.disabled=true;form.elements.password.disabled=true;form.elements.confirmed.disabled=true;scrub();message.textContent='Saving historical record… Please do not submit again.';
      try{
        const result=await rpc('orl_ic_past_case_save',args);
        if(token!==owner||user?.role!=='WEBMASTER')return;
        if(result?.request_id!==requestId||result?.slot_id!==selected.slotId||result?.ot_date!==selected.otDate||result?.mode!==mode)throw Error('Historical update was not confirmed.');
        if(form.isConnected&&!$('#modal').hidden){dispose();closeModal();await reloadSchedule({forceOpenDate:selected.otDate})}
        toast(mode==='EDIT'?'Historical correction saved. Slot and operation status are unchanged.':'Past case recorded. It is not marked Done; confirm completion separately if appropriate.');
      }catch(error){
        if(token!==owner||!form.isConnected)return;
        message.textContent=error.message+' Reload and check this slot and Audit Log before another action. This save will not be repeated automatically.';
        const reload=document.createElement('button');reload.className='secondary';reload.type='button';reload.textContent='Reload and Check';reload.onclick=()=>{dispose();closeModal();reloadSchedule({forceOpenDate:selected.otDate})};message.after(reload);
      }finally{args.p_password='';if(args.p_data.patient_ic!==undefined)args.p_data.patient_ic='';pastCaseBusy=false}
    };
  }catch(error){if(token===owner&&sequence===pastCaseReadSequence&&loading.isConnected)loading.innerHTML=`<h2>Past Record Unavailable</h2><p role="alert">${esc(error.message)}</p><p>Reload the schedule and check before trying again.</p><button class="secondary" onclick="closeModal()">Close</button>`}
}
