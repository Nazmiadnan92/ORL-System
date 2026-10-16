// OT Hold and completion change booking state only. No identity values are sent.
let otLifecycleBusy=false;
function otLifecycleActions(slot,session,admin){
  if(!admin||!protectedIcEnabled()||!slot.request_id||['CANCELLED','COMPLETED'].includes(slot.request_status))return '';
  const id=slot.request_id;
  if(slot.ot_hold===true)return `<button class="mini hold-control" onclick="openOtLifecycle('${id}','RELEASE_HOLD')">Remove OT Hold</button>`;
  return `<button class="mini hold-control" onclick="openOtLifecycle('${id}','HOLD')">OT Hold</button>`+
    (slot.status==='CONFIRMED'&&session.ot_date<=malaysiaToday().iso?`<button class="mini done-control" onclick="openOtLifecycle('${id}','COMPLETE')">✓ Mark as Done</button>`:'');
}
function otLifecycleSelection(requestId){
  const session=(window._schedule||[]).find(day=>day.slots.some(slot=>slot.request_id===requestId));
  const cached=session?.slots.find(slot=>slot.request_id===requestId);
  const held=(window._otHoldRows||[]).find(row=>row.id===requestId);
  const holdView=!!$('#otHoldRows');
  const row=holdView?held:$('#scheduleList')?cached:null;
  const slotId=holdView?(row?.slot_id||row?.assigned_slot_id):row?.id;
  const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if(!row||row._ic_review_owner!==token||row._ic_lifecycleConsumed||![requestId,slotId,row._ic_generation].every(uuid)
    ||typeof row._ic_edit_version!=='string'||!Number.isFinite(Date.parse(row._ic_edit_version)))throw Error('Reload this patient before changing OT Hold or completion.');
  return {row,owner:token,requestId,slotId,generation:row._ic_generation,version:row._ic_edit_version,
    date:holdView?row.ot_date:session.ot_date,status:row.request_status||row.status};
}
function openOtLifecycle(requestId,action){
  if(otLifecycleBusy)return;
  if(!['ADMIN','WEBMASTER'].includes(user?.role)||!protectedIcEnabled()){toast('Admin or Webmaster access required.');return}
  if(!['HOLD','RELEASE_HOLD','COMPLETE'].includes(action))return;
  let selected;
  try{
    selected=otLifecycleSelection(requestId);
    if(['CANCELLED','COMPLETED'].includes(selected.status))throw Error('This case is closed. Its history is retained.');
    if(action==='HOLD'&&selected.row.ot_hold===true||action==='RELEASE_HOLD'&&selected.row.ot_hold!==true)throw Error('OT Hold changed. Reload and review again.');
    if(action==='COMPLETE'&&(selected.row.ot_hold===true||selected.status!=='SCHEDULED'||selected.date>malaysiaToday().iso))throw Error('Only a confirmed operation on today or a past date can be marked Done. Remove OT Hold first if appropriate.');
  }catch(error){toast(error.message);return}
  const title=action==='HOLD'?'Place on OT Hold':action==='RELEASE_HOLD'?'Remove OT Hold':'Mark Operation as Done';
  const description=action==='HOLD'?'The patient stays in this occupied slot but will NOT appear in the OT List. Use Postpone when a new date has been agreed.':
    action==='RELEASE_HOLD'?'The patient will remain in this slot and will be included in the OT List again. Confirm that this operation is going ahead.':
    'Confirm that the operation actually took place. The completed request and its original OT slot will remain as history. A later operation must use a new request, with the same MRN.';
  modal(`<h2>${title}</h2><p><b>${esc(selected.row.patient_name)}</b><br>OT: ${esc(formatSystemDate(selected.date))}</p><div class="security-warning">${description}</div><form id="otLifecycleForm">${action==='COMPLETE'?'<label class="confirm-check"><input name="confirmed" type="checkbox" required> I confirm this operation has been completed.</label>':'<div class="field"><label>Reason<textarea name="reason" maxlength="4096" required></textarea></label></div>'}<div class="actions"><button class="primary" type="submit">${title}</button><button class="secondary" type="button" onclick="closeModal()">Cancel</button></div><p id="otLifecycleMessage" role="status"></p></form>`);
  const form=$('#otLifecycleForm');let consumed=false;
  form.onsubmit=async event=>{
    event.preventDefault();if(consumed||otLifecycleBusy)return;
    const message=form.querySelector('#otLifecycleMessage'),button=form.querySelector('[type="submit"]');
    const reason=action==='COMPLETE'?'':form.elements.reason.value.trim();
    if(action==='COMPLETE'?!form.elements.confirmed.checked:!reason){message.textContent=action==='COMPLETE'?'Confirm that the operation is completed.':'Please enter a reason.';return}
    if(token!==selected.owner||!['ADMIN','WEBMASTER'].includes(user?.role)||!form.isConnected){message.textContent='Please sign in again and reopen this patient.';return}
    consumed=true;otLifecycleBusy=true;button.disabled=true;message.textContent='Saving…';
    for(const row of [...(window._schedule||[]).flatMap(day=>day.slots),...(window._otHoldRows||[])])
      if(row.request_id===requestId||row.id===requestId)row._ic_lifecycleConsumed=true;
    try{
      await rpc('orl_ic_ot_lifecycle',{p_session_token:selected.owner,p_request_id:requestId,p_slot_id:selected.slotId,
        p_action:action,p_reason:reason,p_generation:selected.generation,p_expected_version:selected.version});
      if(token!==selected.owner)return;
      if(form.isConnected)closeModal();toast(action==='HOLD'?'OT Hold applied. Slot retained; excluded from OT List.':action==='RELEASE_HOLD'?'OT Hold removed. Patient included in the OT List again.':'Operation marked Done. History retained; use a new request for a later operation.');
      await reloadOtLifecycleView();
    }catch(error){
      if(token!==selected.owner)return;
      if(form.isConnected){message.textContent=error.message+' Reload and check the patient before another action. This action will not be repeated automatically.';
        const reload=document.createElement('button');reload.type='button';reload.className='secondary';reload.textContent='Reload and Check';reload.onclick=()=>{closeModal();reloadOtLifecycleView()};message.after(reload)}
    }finally{otLifecycleBusy=false}
  };
}
async function reloadOtLifecycleView(){
  if($('#otHoldRows'))return showOtHoldTab();
  if($('#scheduleList'))return reloadSchedule();
}
function otPostponedTabs(active){
  return `<div class="ot-hold-tabs" role="group" aria-label="Postponed management view"><button class="${active==='HISTORY'?'primary':'secondary'}" aria-pressed="${active==='HISTORY'}" onclick="postponed()">Postpone History</button><button class="${active==='HOLD'?'primary':'secondary'}" aria-pressed="${active==='HOLD'}" onclick="postponed('HOLD')">OT Hold</button></div>`;
}
async function showOtHoldTab(){
  if(!['ADMIN','WEBMASTER'].includes(user?.role)){toast('Admin or Webmaster access required.');return}
  const owner=token,c=$('#content');window._otHoldRows=[];
  c.innerHTML=head('Postponed Management','OT Hold keeps the original slot occupied. These patients are excluded from the OT List until the hold is removed or a new OT date is assigned.')+otPostponedTabs('HOLD')+'<div id="otHoldRows" class="card empty">Loading OT Hold…</div>';
  const box=$('#otHoldRows');
  try{
    const rows=await rpc('orl_get_ot_hold_requests',{p_session_token:owner});
    if(token!==owner||!box.isConnected)return;
    window._otHoldRows=rows;
    box.className='table-wrap';box.innerHTML=rows.length?`<table><thead><tr><th>Patient / MRN</th><th>Original OT Slot</th><th>Hold Reason</th><th>On Hold Since</th><th>Actions</th></tr></thead><tbody>${rows.map(row=>`<tr><td><b>${esc(row.patient_name)}</b><br><small>${esc(row.mrn)} · ${esc(row.request_number)}</small></td><td>${esc(formatSystemDate(row.ot_date))}<br>${esc(row.slot_type==='SPECIAL'?'Special':'Main')} Slot ${esc(row.slot_number)}<br><span class="badge OT-HOLD">OT HOLD</span></td><td>${esc(row.ot_hold_reason)}</td><td>${row.ot_hold_at?esc(new Date(row.ot_hold_at).toLocaleString()):'—'}</td><td><button class="mini" onclick="jumpToRequest('${row.ot_date}','${row.id}')">View / Postpone</button> <button class="mini" onclick="openOtLifecycle('${row.id}','RELEASE_HOLD')">Remove OT Hold</button></td></tr>`).join('')}</tbody></table>`:'<div class="card empty">No patients on OT Hold.</div>';
  }catch(error){if(token===owner&&box.isConnected)box.textContent=error.message}
}
