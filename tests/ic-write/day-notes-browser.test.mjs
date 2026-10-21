import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('Day Notes are bold advisory reminders; only Admin/Webmaster may edit a freshly reviewed date',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:900}});await page.route('**/*',route=>route.abort());
  await page.setContent('<main id="content"><section class="card"><h2>OT Schedule</h2><b>Wednesday, 18-11-2026</b><div class="admit">Admission: 16-11-2026</div><div id="note"></div><div id="controls"></div><button id="booking">Request this date</button></section></main><div id="modal" class="modal" hidden><div class="dialog"><button class="close" onclick="closeModal()">×</button><div id="modalBody"></div></div></div>');
  for(const file of ['styles.css','mobile.css','day-notes.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
   window.modal=html=>{$('#modalBody').innerHTML=html;$('#modal').hidden=false};window.closeModal=()=>{$('#modal').hidden=true;$('#modalBody').textContent=''};
   $('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))closeModal()});
   window.fixture=(options={})=>{
    closeModal();window.user={role:options.role||'ADMIN'};window.token=uuid(1);window.calls=[];window.reads=[];window.messages=[];window.refreshes=[];
    window.failRead=false;window.failWrite=false;window.pauseRead=false;window.pauseWrite=false;window.badResult=false;
    window.row={session_id:uuid(2),ot_date:'2026-11-18',day_note:'No Otology cases on this date.\nPlease discuss any changes with the OT team.',_day_note_owner:token,_day_note_revision:4,_day_note_generation:uuid(3),...options};
    window.snapshot={session_id:row.session_id,ot_date:row.ot_date,day_note:row.day_note,revision:row._day_note_revision,generation:row._day_note_generation};
    $('#note').innerHTML='';$('#controls').innerHTML='';
   };
   fixture();
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/day-notes.js',import.meta.url),'utf8')});
  await page.evaluate(()=>orlDayNotes.configure({
   getContext:()=>({token,role:user.role}),modal,closeModal,formatDate:()=> '18-11-2026',toast:text=>messages.push(text),refresh:async data=>{refreshes.push(data)},
   read:async args=>{reads.push({...args});const captured=JSON.parse(JSON.stringify(snapshot));if(pauseRead)await new Promise(resolve=>window.releaseRead=resolve);if(failRead)throw Error('Read failed');return captured},
   save:async args=>{calls.push({...args});if(pauseWrite)await new Promise(resolve=>window.releaseWrite=resolve);if(failWrite)throw Error('Write failed');return {...snapshot,day_note:args.note,revision:args.revision+1,changed:true,...(badResult||{})}}
  }));
  const reset=options=>page.evaluate(options=>fixture(options),options||{});
  const draw=()=>page.evaluate(()=>{$('#note').innerHTML=orlDayNotes.render(row);$('#controls').innerHTML=orlDayNotes.control(row)});
  const open=()=>page.evaluate(()=>orlDayNotes.open(row.session_id,row.ot_date));
  const submit=()=>page.evaluate(()=>$('#otDayNoteForm').onsubmit({preventDefault(){}}));
  for(const role of ['ADMIN','WEBMASTER','STAFF']){
   await reset({role});await draw();assert.match(await page.locator('#note').innerText(),/No Otology cases/);
   assert.equal(await page.locator('#controls button').count(),role==='STAFF'?0:1);await open();
   assert.equal(await page.locator('#otDayNoteForm').count(),role==='STAFF'?0:1);assert.equal(await page.locator('#booking').isDisabled(),false,'Day Note must never alter booking availability');
  }
  for(const patch of [{_day_note_error:true},{_day_note_owner:'old-owner'},{_day_note_revision:null},{_day_note_generation:null},{day_note:null}]){
   await reset(patch);await draw();assert.match(await page.locator('#note').innerText(),/unavailable/);
  }
  await reset({day_note:''});await draw();assert.equal(await page.locator('#note').innerText(),'');await open();assert.equal(await page.locator('[name="remove"]').count(),0);
  await submit();assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator('#otDayNoteMessage').innerText(),/1 to 500/);
  await page.locator('[name="note"]').fill('x'.repeat(501));await submit();assert.equal(await page.evaluate(()=>calls.length),0);
  assert.equal(await page.locator('#otDayNoteCount').innerText(),'501 / 500 characters');
  await page.locator('[name="note"]').fill('  No Otology cases on this date.  ');await submit();
  assert.equal(await page.locator('#modal').isHidden(),true);assert.equal(await page.evaluate(()=>calls[0].note),'No Otology cases on this date.');
  assert.deepEqual(await page.evaluate(()=>calls[0]),{sessionId:'00000000-0000-4000-8000-000000000002',otDate:'2026-11-18',note:'No Otology cases on this date.',revision:4,generation:'00000000-0000-4000-8000-000000000003',owner:'00000000-0000-4000-8000-000000000001'});
  assert.equal(await page.evaluate(()=>refreshes.length),1);assert.match(await page.evaluate(()=>messages[0]),/Bookings are unchanged/);
  await reset();await open();await submit();assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator('#otDayNoteMessage').innerText(),/No changes/);
  await page.locator('[name="remove"]').check();assert.equal(await page.locator('[name="note"]').isDisabled(),true);assert.equal(await page.locator('#otDayNoteSave').innerText(),'Remove Note');
  await submit();assert.equal(await page.evaluate(()=>calls[0].note),'');assert.match(await page.evaluate(()=>messages[0]),/history is kept/);
  for(const change of ['owner','role']){
   await reset();await open();await page.locator('[name="note"]').fill('Changed note');await page.evaluate(change=>{if(change==='owner')token=uuid(8);else user.role='STAFF'},change);await submit();
   assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator('#otDayNoteMessage').innerText(),/session changed/);
  }
  // A delayed first read must not overwrite an editor opened afterwards.
  await reset();await page.evaluate(()=>{pauseRead=true;window.firstOpen=orlDayNotes.open(row.session_id,row.ot_date)});await page.waitForFunction(()=>typeof releaseRead==='function');
  await page.evaluate(()=>{pauseRead=false;snapshot.day_note='Most recent note';window.secondOpen=orlDayNotes.open(row.session_id,row.ot_date)});await page.evaluate(()=>secondOpen);
  await page.evaluate(()=>releaseRead());await page.evaluate(()=>firstOpen);assert.equal(await page.locator('[name="note"]').inputValue(),'Most recent note');
  for(const badSnapshot of [{revision:null},{generation:null},{ot_date:'2026-11-19'},{session_id:'wrong-id'}]){
   await reset();await page.evaluate(patch=>Object.assign(snapshot,patch),badSnapshot);await open();assert.equal(await page.locator('#otDayNoteForm').count(),0);assert.match(await page.locator('#otDayNoteEditor').innerText(),/could not be loaded/);
  }
  await reset();await page.evaluate(()=>failRead=true);await open();assert.equal(await page.locator('#otDayNoteForm').count(),0);
  for(const failure of ['failWrite','badResult']){
   await reset();await open();await page.locator('[name="note"]').fill('A changed note');await page.evaluate(failure=>{if(failure==='failWrite')failWrite=true;else badResult={revision:4}},failure);await submit();
   assert.match(await page.locator('#otDayNoteMessage').innerText(),/not confirmed.*not be sent again automatically/);await submit();assert.equal(await page.evaluate(()=>calls.length),1);assert.equal(await page.evaluate(()=>refreshes.length),0);
   assert.equal(await page.locator('#otDayNoteCancel').innerText(),'Close');assert.equal(await page.locator('#modal .close').isDisabled(),false);
  }
  // The server may redact sensitive-looking content and normalize whitespace.
  await reset();await open();await page.locator('[name="note"]').fill('A synthetic note to be sanitized');
  await page.evaluate(()=>badResult={day_note:'A sanitized synthetic note'});await submit();assert.equal(await page.locator('#modal').isHidden(),true);assert.match(await page.evaluate(()=>messages[0]),/server adjusted/);
  // A canonicalized no-op is confirmed without inventing a changed revision.
  await reset();await open();await page.locator('[name="note"]').fill('Equivalent text after server normalization');
  await page.evaluate(()=>badResult={day_note:snapshot.day_note,revision:snapshot.revision,changed:false});await submit();assert.equal(await page.locator('#modal').isHidden(),true);assert.match(await page.evaluate(()=>messages[0]),/No change was needed/);
  await reset();await open();await page.locator('[name="note"]').fill('A revised note');
  await page.evaluate(()=>{pauseWrite=true;window.pending=$('#otDayNoteForm').onsubmit({preventDefault(){}})});await page.waitForFunction(()=>typeof releaseWrite==='function');
  assert.equal(await page.locator('#otDayNoteSave').isDisabled(),true);assert.equal(await page.locator('#otDayNoteCancel').isDisabled(),true);assert.equal(await page.locator('#modal .close').isDisabled(),true);
  await page.evaluate(()=>{for(const element of [$('#modal'),$('#modal .close')])element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));$('#modal').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))});
  assert.equal(await page.locator('#otDayNoteForm').isVisible(),true);await submit();assert.equal(await page.evaluate(()=>calls.length),1);
  // Captured generation/revision are immutable even if a background read changes the source.
  await page.evaluate(()=>{snapshot.revision=99;snapshot.generation=uuid(9);releaseWrite()});await page.evaluate(()=>pending);
  assert.equal(await page.evaluate(()=>calls[0].revision),4);assert.equal(await page.evaluate(()=>calls[0].generation),'00000000-0000-4000-8000-000000000003');assert.match(await page.locator('#otDayNoteMessage').innerText(),/not confirmed/);
  for(const replacement of ['owner','modal']){
   await reset();await open();await page.locator('[name="note"]').fill('Changed note');await page.evaluate(()=>{pauseWrite=true;window.replaced=$('#otDayNoteForm').onsubmit({preventDefault(){}})});await page.waitForFunction(()=>typeof releaseWrite==='function');
   await page.evaluate(replacement=>{if(replacement==='owner')token=uuid(9);modal('<p id="replacement">Keep the new view</p>')},replacement);
   await page.waitForFunction(()=>!$('#modal .close').disabled);await page.evaluate(()=>releaseWrite());await page.evaluate(()=>replaced);
   assert.equal(await page.locator('#replacement').innerText(),'Keep the new view');assert.equal(await page.evaluate(()=>refreshes.length),0);assert.equal(await page.evaluate(()=>messages.length),0);
  }
  await reset({day_note:'<img src=x onerror=alert(1)>\nNo Otology cases on this date.'});await draw();await open();
  assert.equal(await page.locator('#note img,#otDayNoteEditor img').count(),0);assert.match(await page.locator('#note').innerText(),/<img src=x/);
  assert.equal(await page.locator('#note .ot-day-note-text').evaluate(el=>Number(getComputedStyle(el).fontWeight)>=700),true);
  assert.equal(await page.locator('#note .ot-day-note-text').evaluate(el=>getComputedStyle(el).whiteSpace),'pre-wrap');
  await reset();await draw();await page.locator('#controls button').click();assert.equal(await page.locator('#otDayNoteForm').isVisible(),true);
  if(process.env.ORL_DAY_NOTE_QA){
   await mkdir(process.env.ORL_DAY_NOTE_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_DAY_NOTE_QA,'day-note-desktop.png'),fullPage:true});
   await page.locator('#otDayNoteCancel').click();await page.screenshot({path:resolve(process.env.ORL_DAY_NOTE_QA,'day-note-schedule.png'),fullPage:true});await open();
  }
  await page.setViewportSize({width:390,height:844});await page.locator('[name="note"]').fill('a'.repeat(500));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if(process.env.ORL_DAY_NOTE_QA)await page.screenshot({path:resolve(process.env.ORL_DAY_NOTE_QA,'day-note-mobile.png'),fullPage:true});
 }finally{await browser.close()}
});
