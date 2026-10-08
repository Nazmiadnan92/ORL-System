// Non-IC booking metadata only. Every write uses a captured server snapshot.
function malaysiaOtDateKey(at=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day}`;
}
function isPastOtDate(date,at=new Date()){return /^\d{4}-\d{2}-\d{2}$/.test(date||'')&&date<malaysiaOtDateKey(at)}
function refreshPastOtCards(){
 if(typeof currentPage==='undefined'||currentPage!=='schedule'||typeof user==='undefined'||!user)return;
 for(const session of window._schedule||[]){
  const card=document.getElementById('d-'+session.ot_date);
  if(!card||card.classList.contains('past')||!isPastOtDate(session.ot_date))continue;
  const open=card.classList.contains('open'),left=card.querySelector('.slot-grid')?.scrollLeft||0;
  const holder=document.createElement('div');holder.innerHTML=scheduleCard(session,window._holidays||[]);
  const next=holder.firstElementChild;if(open)next.classList.add('open');card.replaceWith(next);
  if(open)next.querySelector('.session-toggle').textContent='Hide OT ▴';
  const grid=next.querySelector('.slot-grid');if(grid)grid.scrollLeft=left;
 }
 const day=malaysiaOtDateKey();if(window._pastOtDirectoryDay!==day&&window._specialOtDays&&document.getElementById('specialDays')){
  window._pastOtDirectoryDay=day;document.getElementById('specialDays').innerHTML=renderSpecialDays(window._specialOtDays);
 }
}
document.addEventListener('DOMContentLoaded',()=>{setInterval(refreshPastOtCards,30000)});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshPastOtCards()});
let bookingContext=null,bookingMoves=[],bookingMoveOwner=null;
const bookingUuid=value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value||'');
const bookingAdmin=()=>['ADMIN','WEBMASTER'].includes(user?.role);
function bookingMovement(from,to){return to===from?'SAME_DATE':to<from?'REASSIGN':'POSTPONE'}
function bookingDateHeading(s){return `<b>${esc(s.day_name||'')} ${esc(formatSystemDate(s.ot_date))}</b>${s.special_title?`<span class="booking-special-title">Special OT Day · ${esc(s.special_title)}</span>`:''}`}
function bookingRequestActions(r){
  if(!bookingUuid(r.id)||r.deletion_status==='PENDING')return '';
  if(bookingAdmin()&&r.status==='APPROVED'&&!r.assigned_slot_id)return `<button class="mini" onclick="openBookingAssign('${r.id}')">Assign Slot</button>`;
  if(r.assigned_slot_id&&['SCHEDULED','APPROVED','CONFIRMED'].includes(r.status))return `<button class="mini" onclick="openBookingMove('${r.id}')">Request Move</button>`;
  return '';
}
function bookingAlive(c){return bookingContext===c&&token===c.owner&&c.box?.isConnected}
function bookingPatient(v){return `<div class="booking-context"><b>${esc(v.request_number)}</b><small>${esc(v.patient_name)} · MRN ${esc(v.mrn)}</small><small>${esc(v.surgery)}</small></div>`}
function bookingSnapshot(v,id){
  if(!v||v.request_id!==id||!bookingUuid(v.generation)||typeof v.request_version!=='string'||!v.request_version)throw Error('Unable to verify the current record. Reopen it from Request Management.');
  return v;
}
async function openBookingAssign(id){
  if(!bookingAdmin()||!bookingUuid(id))return;
  const owner=token;
  modal('<h2>Assign Existing Request</h2><div id="bookingEditor">Loading current record…</div>');
  const box=$('#bookingEditor'),c={mode:'ASSIGN',owner,box,used:false,sequence:0};bookingContext=c;
  try{
    c.view=bookingSnapshot(await rpc('orl_booking_assign_view',{p_session_token:owner,p_request_id:id}),id);
    if(!bookingAlive(c))return;
    if(c.view.status!=='APPROVED')throw Error('Only approved, unassigned requests can use this action.');
    bookingRenderPicker(c);
  }catch(e){if(bookingAlive(c))box.textContent=e.message}
}
async function openBookingMove(id){
  if(!bookingUuid(id))return;
  const preferred=$('#requestForm')?.dataset.bookingDate||'',owner=token;
  modal('<h2>Request Booking Move</h2><div id="bookingEditor">Loading current booking…</div>');
  const box=$('#bookingEditor'),c={mode:'REQUEST',owner,box,used:false,sequence:0};bookingContext=c;
  try{
    c.view=bookingSnapshot(await rpc('orl_booking_move_view',{p_session_token:owner,p_request_id:id}),id);
    if(!bookingAlive(c))return;
    if(c.view.pending_move_id)throw Error('This booking already has a pending move. Check Move Requests before continuing.');
    c.preferred=preferred;bookingRenderPicker(c);
  }catch(e){if(bookingAlive(c))box.textContent=e.message}
}
function bookingRenderPicker(c){
  const v=c.view,today=new Date(),initial=c.mode==='REVIEW'?v.target_date:c.preferred||v.from_date||today.toISOString().slice(0,10);
  c.box.innerHTML=bookingPatient(v)+(c.mode==='ASSIGN'?'<p>Choose an available Main or Special slot. The existing request and postpone count are retained.</p>':
    `<p>Current OT: <b>${esc(formatSystemDate(v.from_date))}</b>. Earlier = Reassign; later = Postpone (+1 after approval). Same date is not allowed.</p><p>The original booking stays in place until Admin/Webmaster approves an available destination slot. Existing patient details are used; unsaved form edits are not applied.</p>`)+
    (c.mode==='REQUEST'?'<label>Reason<textarea id="bookingReason" maxlength="1000" rows="2" required placeholder="Why should the booking move?"></textarea></label>':'')+
    (c.mode==='REVIEW'?`<p>Requested date: <b>${esc(formatSystemDate(v.target_date))}</b> · ${esc(v.action)}</p><p>Reason: ${esc(v.reason)}</p><button type="button" id="bookingReject" class="danger">Reject Move Request</button>`:
    `<label>OT month<input type="month" id="bookingMonth" value="${esc(initial.slice(0,7))}"></label>`)+
    '<div id="bookingDates">Loading OT dates…</div><div class="booking-outcome" id="bookingOutcome" role="status"></div>';
  if(c.mode==='REVIEW')$('#bookingReject').onclick=()=>bookingCommit(c,{action:'REJECT'});
  else $('#bookingMonth').onchange=()=>bookingLoadDates(c,$('#bookingMonth').value);
  bookingLoadDates(c,initial.slice(0,7));
}
async function bookingLoadDates(c,month){
  if(!bookingAlive(c)||c.used)return;
  const box=c.box.querySelector('#bookingDates'),seq=++c.sequence;
  c.slots=new Map();c.dates=new Set();box.textContent='Loading OT dates…';
  if(!/^\d{4}-\d{2}$/.test(month)){box.textContent='Choose an OT month.';return}
  const [year,m]=month.split('-').map(Number);
  try{
    const rows=await rpc(c.mode==='REQUEST'?'orl_booking_move_dates':'orl_get_schedule',{p_session_token:c.owner,p_year:year,p_month:m});
    if(!bookingAlive(c)||seq!==c.sequence||c.used)return;
    const dates=rows.filter(s=>s.status==='ACTIVE'&&!isPastOtDate(s.ot_date)&&(c.mode!=='REVIEW'||s.ot_date===c.view.target_date));
    box.innerHTML=dates.map(s=>{
      const same=c.mode==='REQUEST'&&s.ot_date===c.view.from_date;
      const slots=(s.slots||[]).filter(x=>x._ic_generation===c.view.generation);
      if(c.mode!=='REQUEST'||s.generation===c.view.generation)c.dates.add(s.ot_date);
      const available=slots.filter(x=>x.status==='AVAILABLE');
      const count=c.mode==='REQUEST'?(s.generation===c.view.generation?Number(s.available_slots)||0:0):available.length;
      let actions='';
      if(c.mode==='REQUEST')actions=`<button type="button" data-booking-date="${esc(s.ot_date)}" ${same||!count?'disabled':''}>${same?'Already booked on this date':!count?'No available slots':`Request ${bookingMovement(c.view.from_date,s.ot_date)==='REASSIGN'?'Reassign':'Postpone'}`}</button><small>${count} currently available · Admin selects the slot</small>`;
      else actions=slots.map(x=>{
        if(bookingUuid(x.id))c.slots.set(x.id,{...x,date:s.ot_date});
        return `<button type="button" class="${x.type==='SPECIAL'?'special':''}" data-booking-slot="${esc(x.id)}" ${x.status==='AVAILABLE'?'':'disabled'}>${x.type==='SPECIAL'?'★ Special':'Main'} S${Number(x.number)} · ${esc(x.status)}</button>`;
      }).join('')||'<small>No slots available. Reload the schedule before continuing.</small>';
      return `<div class="booking-day ${s.special_title?'special-day':''}">${bookingDateHeading(s)}<div class="booking-slots">${actions}</div></div>`;
    }).join('')||'<p>No active OT dates in this selection.</p>';
    box.querySelectorAll('[data-booking-date]').forEach(b=>b.onclick=()=>bookingCommit(c,{date:b.dataset.bookingDate}));
    box.querySelectorAll('[data-booking-slot]').forEach(b=>b.onclick=()=>bookingCommit(c,{slot:b.dataset.bookingSlot,action:'APPROVE'}));
    if(c.mode==='REQUEST'&&c.preferred===c.view.from_date){const message='Duplicate rejected: this case is already booked on the same OT date. The existing booking is unchanged.';$('#bookingOutcome').textContent=message;toast(message)}
  }catch(e){if(bookingAlive(c)&&seq===c.sequence)box.textContent=e.message}
}
async function bookingCommit(c,choice){
  if(!bookingAlive(c)||c.used)return;
  const v=c.view,out=c.box.querySelector('#bookingOutcome');let name,args,confirmation;
  if(c.mode==='REQUEST'){
    const reason=c.box.querySelector('#bookingReason').value.trim();
    if(!reason){out.textContent='Enter a reason before choosing the requested date.';return}
    if(!c.dates.has(choice.date)){out.textContent='Reload the OT dates.';return}
    if(bookingMovement(v.from_date,choice.date)==='SAME_DATE'){out.textContent='Duplicate rejected: the patient is already booked on this date.';toast(out.textContent);return}
    name='orl_booking_move_request';args={p_request_id:v.request_id,p_target_date:choice.date,p_reason:reason,p_expected_from_slot:v.from_slot_id,p_expected_version:v.request_version,p_generation:v.generation};
    confirmation=`Request ${bookingMovement(v.from_date,choice.date)} to ${formatSystemDate(choice.date)}? The existing booking stays until approval.`;
  }else{
    const reject=c.mode==='REVIEW'&&choice.action==='REJECT',slot=c.slots?.get(choice.slot);
    if(!reject&&(!slot||slot.status!=='AVAILABLE'||slot._ic_generation!==v.generation)){out.textContent='Reload and choose an available slot.';return}
    if(c.mode==='ASSIGN'){
      name='orl_booking_assign_existing';args={p_request_id:v.request_id,p_target_slot:choice.slot,p_expected_version:v.request_version,p_generation:v.generation};
    }else{
      name='orl_booking_move_review';args={p_move_id:v.id,p_action:choice.action,p_target_slot:reject?null:choice.slot,p_expected_move_version:v.move_version,p_expected_request_version:v.request_version,p_generation:v.generation};
    }
    confirmation=reject?'Reject only this move request? The original booking remains unchanged.':`${c.mode==='ASSIGN'?'Assign existing request':'Approve '+v.action} to ${formatSystemDate(slot.date)}, ${slot.type} S${slot.number}?`;
  }
  if(!confirm(confirmation)||!bookingAlive(c))return;
  if(choice.date&&isPastOtDate(choice.date)||choice.slot&&isPastOtDate(c.slots?.get(choice.slot)?.date)){out.textContent='Past OT dates are closed to new bookings. Choose today or a future date.';return}c.used=true; // Lost responses must be reconciled by a fresh read, never retried here.
  c.box.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);out.textContent='Saving…';
  try{
    const result=await rpc(name,{p_session_token:c.owner,...args});
    if(!bookingAlive(c))return;
    if(c.mode==='ASSIGN'?result!=='CONFIRMED':!result||result.request_id!==v.request_id||result.generation!==v.generation||!bookingUuid(result.id)
      ||(c.mode==='REQUEST'?(result.status!=='PENDING'||result.target_date!==args.p_target_date):
        (result.id!==v.id||result.status!==(choice.action==='REJECT'?'REJECTED':'APPROVED')||(choice.action==='APPROVE'&&result.target_slot_id!==choice.slot))))throw Error('Result not confirmed.');
    closeModal();bookingContext=null;
    toast(c.mode==='ASSIGN'?'Existing request assigned. Postpone count unchanged.':c.mode==='REQUEST'?'Move request submitted. The original booking remains in place.':choice.action==='REJECT'?'Move request rejected. Original booking unchanged.':'Booking moved successfully.');
    go(bookingAdmin()?'management':'requests');
  }catch(e){
    if(!bookingAlive(c))return;
    out.textContent=e.message+' Close this form and refresh Request Management / My Requests to check the result before another action. Do not repeat the submission blindly.';
  }
}
async function loadBookingMoves(){
  const box=$('#bookingMoves'),owner=token;if(!box)return;
  bookingMoves=[];bookingMoveOwner=null;box.textContent='Loading move requests…';
  try{
    const rows=await rpc('orl_booking_move_list',{p_session_token:owner});
    if(token!==owner||!box.isConnected)return;
    if(!Array.isArray(rows))throw Error('Unable to read move requests.');
    bookingMoves=rows;bookingMoveOwner=owner;
    box.innerHTML='<h3>Move Requests</h3><p>Existing bookings remain in place until approval. Earlier = Reassign; later = Postpone.</p>'+rows.map(v=>`<article>${bookingPatient(v)}<b>${esc(formatSystemDate(v.from_date))} → ${esc(formatSystemDate(v.target_date))}</b> · ${esc(v.action)} · ${status(v.status)}<small>Requested by ${esc(v.requested_by_name)} · ${esc(v.reason)}</small>${v.reviewed_by_name?`<small>Reviewed by ${esc(v.reviewed_by_name)}</small>`:''}${bookingAdmin()&&v.status==='PENDING'&&bookingUuid(v.id)?`<button type="button" class="mini" onclick="reviewBookingMove('${v.id}')">Review &amp; Choose Slot</button>`:''}</article>`).join('')+(rows.length?'':'<p>No move requests.</p>');
  }catch(e){if(token===owner&&box.isConnected)box.textContent='Move requests unavailable: '+e.message}
}
function reviewBookingMove(id){
  if(!bookingAdmin()||bookingMoveOwner!==token)return;
  const view=bookingMoves.find(v=>v.id===id&&v.status==='PENDING');if(!view){toast('Refresh Move Requests before reviewing.');return}
  modal('<h2>Review Booking Move</h2><div id="bookingEditor"></div>');
  const c={mode:'REVIEW',owner:token,box:$('#bookingEditor'),view,used:false,sequence:0};bookingContext=c;bookingRenderPicker(c);
}
