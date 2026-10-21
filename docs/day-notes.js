// Advisory OT date notes only. No patient data or booking permissions are changed.
(function(root){
 'use strict';
 const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
 const date=value=>typeof value==='string'&&/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);
 const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
 const manager=role=>role==='ADMIN'||role==='WEBMASTER';
 const maxLength=500,length=value=>Array.from(value).length;
 let adapters=null,editor=null,writing=false;
 const context=()=>adapters?.getContext?.()||{};
 const current=c=>editor===c&&c.box.isConnected&&context().token===c.owner&&manager(context().role);
 const noteBox=text=>`<div class="ot-day-note" role="note" aria-label="Day Note"><strong class="ot-day-note-label">Day Note</strong><strong class="ot-day-note-text">${esc(text)}</strong></div>`;
 function validSnapshot(row,sessionId,otDate){
  return row&&row.session_id===sessionId&&date(row.ot_date)&&(!otDate||row.ot_date===otDate)
   &&typeof row.day_note==='string'&&length(row.day_note)<=maxLength&&Number.isSafeInteger(row.revision)&&row.revision>=0&&uuid(row.generation);
 }
 function render(s){
  if(!s||!date(s.ot_date))return '';
  const verified=s._day_note_owner===context().token&&!!context().token&&!s._day_note_error
   &&typeof s.day_note==='string'&&length(s.day_note)<=maxLength&&Number.isSafeInteger(s._day_note_revision)&&s._day_note_revision>=0&&uuid(s._day_note_generation);
  if(!verified)return '<div class="ot-day-note ot-day-note-unavailable" role="note"><strong>Day note unavailable. Reload to check.</strong></div>';
  return s.day_note.trim()?noteBox(s.day_note):'';
 }
 function control(s){
  if(!context().token||!manager(context().role)||!uuid(s?.session_id)||!date(s.ot_date))return '';
  return `<button type="button" class="mini ot-day-note-control" data-day-note-session="${esc(s.session_id)}" data-day-note-date="${esc(s.ot_date)}" aria-label="Edit Day Note for ${esc(s.ot_date)}">Day Note</button>`;
 }
 function configure(next){
  for(const key of ['getContext','read','save','modal','closeModal'])if(typeof next?.[key]!=='function')throw Error('Day Note configuration is incomplete.');
  adapters=next;
 }
 async function open(sessionId,otDate){
  if(!adapters||writing||!uuid(sessionId)||!date(otDate)||!manager(context().role)||!context().token)return;
  const owner=context().token;
  adapters.modal('<h2>Day Note</h2><div id="otDayNoteEditor" class="ot-day-note-editor" role="region" aria-label="Edit Day Note">Loading the latest note…</div>');
  const box=root.document.getElementById('otDayNoteEditor');
  if(!box)return;
  const c={box,owner,sessionId,otDate,used:false};editor=c;
  try{
   const row=await adapters.read({sessionId,otDate,owner});
   if(!current(c))return;
   if(!validSnapshot(row,sessionId,otDate))throw Error('The latest Day Note could not be verified.');
   c.snapshot=Object.freeze({...row});drawEditor(c);
  }catch(error){
   if(!current(c))return;
   box.textContent='Day Note could not be loaded. Close this window and reload the schedule before editing.';
  }
 }
 function drawEditor(c){
  const snapshot=c.snapshot,hasNote=!!snapshot.day_note.trim();
  c.box.innerHTML=`<p class="ot-day-note-date">OT date: <strong>${esc(adapters.formatDate?adapters.formatDate(c.otDate):c.otDate)}</strong></p><p class="ot-day-note-help">Everyone can read this note when choosing this OT date. This is a reminder only; it does not block any booking or sub-specialty. Do not enter patient details.</p><form id="otDayNoteForm"><div class="field"><label for="otDayNoteText">Day Note<textarea id="otDayNoteText" name="note" rows="4" aria-describedby="otDayNoteCount" placeholder="e.g. No Otology cases on this date."></textarea></label><small id="otDayNoteCount" class="ot-day-note-count"></small></div><div class="ot-day-note-preview-label">Preview</div><div id="otDayNotePreview"></div>${hasNote?'<label class="confirm-check ot-day-note-remove"><input name="remove" type="checkbox"> Remove this Day Note from this date. Its audit history will be kept.</label>':''}<p class="ot-day-note-help">Changes are recorded in the Audit Log.</p><div class="actions"><button type="submit" class="primary" id="otDayNoteSave">Save Note</button><button type="button" class="secondary" id="otDayNoteCancel">Cancel</button></div><p id="otDayNoteMessage" class="ot-day-note-message" role="status" aria-live="polite"></p></form>`;
  const form=c.box.querySelector('form'),input=form.elements.note,remove=form.elements.remove,submit=form.querySelector('[type="submit"]'),cancel=form.querySelector('#otDayNoteCancel'),message=form.querySelector('#otDayNoteMessage');
  input.value=snapshot.day_note;
  const preview=()=>{
   const removing=remove?.checked===true,n=length(input.value);input.disabled=removing;
   form.querySelector('#otDayNoteCount').textContent=`${n} / ${maxLength} characters`;
   form.querySelector('#otDayNoteCount').classList.toggle('over-limit',n>maxLength);
   form.querySelector('#otDayNotePreview').innerHTML=removing?'<p class="ot-day-note-help">The note will be removed after saving.</p>':noteBox(input.value.trim()||'Your note will appear here in bold.');
   submit.textContent=removing?'Remove Note':'Save Note';submit.className=removing?'danger':'primary';
  };
  input.addEventListener('input',preview);remove?.addEventListener('change',preview);preview();
  cancel.onclick=()=>{if(!writing){if(editor===c)editor=null;adapters.closeModal()}};
  form.onsubmit=async event=>{
   event.preventDefault();if(c.used||writing)return;
   if(!current(c)){message.textContent='Your session changed. Close this window and sign in again.';return}
   const removing=remove?.checked===true,note=removing?'':input.value.trim();
   if(!removing&&(!note||length(note)>maxLength)){message.textContent='Enter a Day Note with 1 to 500 characters.';return}
   if(note===snapshot.day_note){message.textContent='No changes to save.';return}
   c.used=true;writing=true;submit.disabled=true;cancel.disabled=true;input.disabled=true;if(remove)remove.disabled=true;
   const pending='Saving your Day Note. Please wait; this change cannot be cancelled after it has been sent.';message.textContent=pending;
   const modal=c.box.closest('.modal'),close=modal?.querySelector('.close'),wasDisabled=close?.disabled;
   const guard=event=>{if(!writing||editor!==c||!form.isConnected)return;if(event.type==='keydown'?event.key==='Escape':event.target===modal||close?.contains(event.target)){event.preventDefault();event.stopImmediatePropagation();message.textContent=pending}};
   if(close){close._dayNoteOwner=c;close.disabled=true}modal?.addEventListener('click',guard,true);modal?.addEventListener('keydown',guard,true);
   const releaseClose=()=>{modal?.removeEventListener('click',guard,true);modal?.removeEventListener('keydown',guard,true);if(close?._dayNoteOwner===c){close.disabled=wasDisabled;delete close._dayNoteOwner}};
   const observer=new MutationObserver(()=>{if(!form.isConnected||modal?.hidden){releaseClose();observer.disconnect()}});
   if(modal)observer.observe(modal,{subtree:true,childList:true,attributes:true,attributeFilter:['hidden']});
   try{
    const result=await adapters.save({sessionId:c.sessionId,otDate:c.otDate,note,revision:snapshot.revision,generation:snapshot.generation,owner:c.owner});
    if(!current(c))return;
    const confirmedChange=result?.changed===true&&result.revision>snapshot.revision;
    const confirmedNoop=result?.changed===false&&result.revision===snapshot.revision&&result.day_note===snapshot.day_note;
    if(!validSnapshot(result,c.sessionId,c.otDate)||result.generation!==snapshot.generation||(!confirmedChange&&!confirmedNoop)||(removing&&result.day_note!==''))throw Error('Day Note was not confirmed.');
    editor=null;adapters.closeModal();adapters.toast?.(confirmedNoop?'No change was needed. The current Day Note is kept.':removing?'Day Note removed. Its audit history is kept.':'Day Note saved. Bookings are unchanged.'+(result.day_note!==note?' The server adjusted the note text; please review it.':''));
    try{await adapters.refresh?.({date:c.otDate,sessionId:c.sessionId,owner:c.owner})}catch{if(context().token===c.owner)adapters.toast?.('Day Note saved. Reload the schedule to see the latest note.')}
   }catch(error){
    if(!current(c))return;
    message.textContent='The change was not confirmed. Close this window, reload the schedule and check the Day Note before trying again. It will not be sent again automatically.';
   }finally{
    writing=false;observer.disconnect();releaseClose();
    if(form.isConnected){cancel.disabled=false;cancel.textContent='Close'}
   }
  };
 }
 root.document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-day-note-session]');if(!button||button.disabled)return;
  event.preventDefault();open(button.dataset.dayNoteSession,button.dataset.dayNoteDate);
 });
 root.orlDayNotes=Object.freeze({configure,render,control,open});
})(window);
