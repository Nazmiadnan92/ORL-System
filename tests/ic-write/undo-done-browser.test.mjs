import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('Undo Done requires Webmaster, a fresh completed slot, reason and password; preserves history and never retries',async()=>{
  const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1180,height:980},timezoneId:'America/Los_Angeles'});
    await page.clock.install({time:new Date('2026-10-18T04:00:00Z')});await page.route('**/*',route=>route.abort());
    await page.setContent('<main id="content"><div id="scheduleList"></div></main><div id="actions"></div><div id="modal" class="modal" hidden><div class="dialog"><button class="close" onclick="closeModal()">×</button><div id="modalBody"></div></div></div>');
    for(const file of ['styles.css','mobile.css','schedule.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
    await page.evaluate(()=>{
      window.$=selector=>document.querySelector(selector);
      window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
      window.sid=uuid(1);window.rid=uuid(2);window.owner=uuid(3);window.gen=uuid(4);
      window.formatSystemDate=value=>value;window.patientNameCase=value=>value||'';window.clinicalUpper=value=>value||'';
      window.maskPatientIc=()=>'';window.patientAgeText=()=> 'Synthetic age';window.patientAgeFromIc=()=> '—';
      window.canPickSlot=()=>false;window.directRequestAllowed=()=>false;window.pastCaseActions=()=>'';
      window.malaysiaToday=()=>({iso:'2026-10-18'});window.isPastOtDate=value=>value<'2026-10-18';
      Object.defineProperty(window,'status',{configurable:true,writable:true,value:value=>esc(value)});
      window.protectedIcEnabled=()=>window.protectedMode;
      window.modal=html=>{$('#modalBody').innerHTML=html;$('#modal').hidden=false};
      window.closeModal=()=>{$('#modalBody').textContent='';$('#modal').hidden=true};
      $('#modal').onclick=event=>{if(event.target===$('#modal'))closeModal()};
      window.toast=message=>messages.push(message);window.reloadSchedule=async options=>{refreshes.push(options)};
      window.fixture=(options={})=>{
        const {role='WEBMASTER',date='2026-10-17',protectedMode=true,...overrides}=options;
        closeModal();$('#actions').textContent='';$('#content').innerHTML='<div id="scheduleList"></div>';window.user={role};window.token=owner;window.protectedMode=protectedMode;
        window.calls=[];window.messages=[];window.refreshes=[];window.failWrite=false;window.pauseWrite=false;window.badResult=false;
        window.row={id:sid,type:'MAIN',number:5,request_id:rid,patient_name:'Synthetic Completed Patient',status:'CONFIRMED',request_status:'COMPLETED',deletion_status:'',_ic_generation:gen,_ic_edit_version:'2026-10-18T01:02:03.123456Z',_ic_review_owner:owner,
          postpone_count:3,ot_hold:false,completed_at:'2026-10-17T05:06:07Z',completed_by:uuid(7),...overrides};
        window.session={session_id:uuid(8),ot_date:date,status:'ACTIVE',slots:[row]};window._schedule=[session];window._otHoldRows=[];
        window.expectedHold=row.ot_hold===true;
      };
      window.rpc=async(name,args)=>{
        calls.push({name,args:JSON.parse(JSON.stringify(args))});window.sentArgs=args;
        if(pauseWrite)await new Promise(resolve=>window.releaseWrite=resolve);
        if(failWrite)throw Error('Synthetic update not confirmed.');
        return {request_id:badResult?uuid(10):rid,slot_id:sid,status:'SCHEDULED',action:'UNDO_DONE',ot_hold:expectedHold};
      };
      fixture();
    });
    await page.addScriptTag({content:await readFile(new URL('../../docs/ot-lifecycle.js',import.meta.url),'utf8')});
    const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
    const start=app.lastIndexOf('function slotCard('),rest=app.slice(start),end=rest.search(/\n(?:async )?function /);
    await page.addScriptTag({content:rest.slice(0,end)});
    const reset=(options={})=>page.evaluate(options=>fixture(options),options);
    const draw=()=>page.evaluate(()=>{$('#actions').innerHTML=slotCard(row,session,user.role!=='STAFF')});
    const open=()=>page.evaluate(()=>openUndoDone(rid));
    const submit=()=>page.evaluate(()=>$('#undoDoneForm').onsubmit({preventDefault(){}}));
    const prepare=async()=>{await page.locator('[name="reason"]').fill('  Synthetic completion marked by mistake  ');await page.locator('[name="password"]').fill('Synthetic-password');await page.locator('[name="confirmed"]').check()};

    for(const role of ['WEBMASTER','ADMIN','STAFF'])for(const date of ['2026-10-17','2026-10-18','2026-10-19'])for(const protectedMode of [true,false]){
      const allowed=role==='WEBMASTER'&&date<='2026-10-18'&&protectedMode;
      await reset({role,date,protectedMode});await draw();
      assert.equal(await page.locator('#actions [onclick^="openUndoDone"]').count(),allowed?1:0);
      assert.equal(await page.locator('#actions [onclick^="postponeSlot"],#actions [onclick^="editSlot"],#actions [onclick^="clearSlot"],#actions [onclick^="openOtLifecycle"]').count(),0,'Undo button does not unlock ordinary Done actions');
      await open();assert.equal(await page.locator('#undoDoneForm').count(),allowed?1:0);assert.equal(await page.evaluate(()=>calls.length),0);
    }
    for(const scenario of [{request_status:'SCHEDULED'},{request_status:'CANCELLED'},{status:'RESERVED'},{status:'CLOSED'},{deletion_status:'PENDING'},{deletion_status:null}]){
      await reset(scenario);await draw();assert.equal(await page.locator('#actions [onclick^="openUndoDone"]').count(),0);await open();assert.equal(await page.locator('#undoDoneForm').count(),0);
    }
    for(const invalid of [{_ic_generation:null},{_ic_edit_version:''},{_ic_review_owner:'different'},{request_id:null},{_ic_lifecycleConsumed:true}]){
      await reset(invalid);await open();assert.equal(await page.locator('#undoDoneForm').count(),0);assert.equal(await page.evaluate(()=>calls.length),0);
    }
    await reset();await page.evaluate(()=>$('#content').innerHTML='<div id="otHoldRows"></div>');await open();assert.equal(await page.locator('#undoDoneForm').count(),0);
    await reset();await open();
    assert.equal(await page.locator('[name="password"]').getAttribute('autocomplete'),'current-password');assert.equal(await page.locator('[name="password"]').getAttribute('type'),'password');
    assert.match(await page.locator('.security-warning').innerText(),/marked Done by mistake.*same OT date and slot.*original Done audit entry is retained.*later operation, create a new request/s);
    assert.equal(await page.locator('[name="status"],[name="slot_id"],[name="ot_date"],[name="completed_at"],[name="patient_ic"]').count(),0);
    await prepare();await page.locator('[name="reason"]').fill('   ');await submit();assert.equal(await page.evaluate(()=>calls.length),0);assert.match(await page.locator('#undoDoneMessage').innerText(),/reason/);assert.equal(await page.locator('[name="password"]').inputValue(),'');
    await prepare();await page.evaluate(()=>$('#undoDoneForm').elements.reason.value='x'.repeat(4097));await submit();assert.equal(await page.evaluate(()=>calls.length),0);
    await prepare();await page.evaluate(()=>$('#undoDoneForm').elements.password.value='x'.repeat(1025));await submit();assert.equal(await page.evaluate(()=>calls.length),0);assert.equal(await page.locator('[name="password"]').inputValue(),'');
    await prepare();await page.locator('[name="confirmed"]').uncheck();await submit();assert.equal(await page.evaluate(()=>calls.length),0);
    await prepare();await page.locator('[name="password"]').fill('');await submit();assert.equal(await page.evaluate(()=>calls.length),0);

    // The old row's original owner, slot, request, generation and exact version are used after later reads.
    await reset({ot_hold:true});await open();await prepare();
    await page.evaluate(()=>{row.id=uuid(20);row.request_id=uuid(21);row._ic_generation=uuid(22);row._ic_edit_version='2026-10-18T05:00:00Z';session.ot_date='2026-10-19';pauseWrite=true;window.pending=$('#undoDoneForm').onsubmit({preventDefault(){}})});
    await page.waitForFunction(()=>typeof releaseWrite==='function');assert.equal(await page.locator('[name="password"]').inputValue(),'');assert.equal(await page.locator('#undoDoneForm [type="submit"]').isDisabled(),true);
    assert.equal(await page.locator('#undoDoneCancel').isDisabled(),true);assert.equal(await page.locator('#modal .close').isDisabled(),true);
    assert.match(await page.locator('#undoDoneMessage').innerText(),/can no longer be cancelled/);
    await page.evaluate(()=>{
      for(const element of [$('#modal'),$('#modal .close'),$('#undoDoneCancel')])element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      $('#modal').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    });
    assert.equal(await page.locator('#undoDoneForm').isVisible(),true,'Cancel, close and backdrop cannot imply cancelling an already sent correction');
    await submit();assert.equal(await page.evaluate(()=>calls.length),1);
    assert.deepEqual(await page.evaluate(()=>calls[0]),{name:'orl_ic_undo_done',args:{p_session_token:'00000000-0000-4000-8000-000000000003',p_password:'Synthetic-password',p_request_id:'00000000-0000-4000-8000-000000000002',p_slot_id:'00000000-0000-4000-8000-000000000001',p_reason:'Synthetic completion marked by mistake',p_generation:'00000000-0000-4000-8000-000000000004',p_expected_version:'2026-10-18T01:02:03.123456Z'}});
    assert.equal(await page.evaluate(()=>row.request_status),'COMPLETED');assert.equal(await page.evaluate(()=>row.completed_at),'2026-10-17T05:06:07Z');assert.equal(await page.evaluate(()=>row.postpone_count),3);
    await page.evaluate(()=>releaseWrite());await page.evaluate(()=>pending);assert.equal(await page.locator('#modal').isHidden(),true);
    assert.equal(await page.locator('#modal .close').isDisabled(),false);
    assert.deepEqual(await page.evaluate(()=>refreshes),[{forceOpenDate:'2026-10-17'}]);assert.equal(await page.evaluate(()=>sentArgs.p_password),'');

    for(const failure of ['failWrite','badResult']){
      await reset();await open();await prepare();await page.evaluate(failure=>window[failure]=true,failure);await submit();
      assert.equal(await page.evaluate(()=>row._ic_lifecycleConsumed),true);assert.equal(await page.evaluate(()=>row.request_status),'COMPLETED');
      assert.match(await page.locator('#undoDoneMessage').innerText(),/Reload and check.*not be repeated automatically/);assert.equal(await page.evaluate(()=>sentArgs.p_password),'');
      assert.equal(await page.locator('#modal .close').isDisabled(),false);assert.equal(await page.locator('#undoDoneCancel').isDisabled(),false);assert.equal(await page.locator('#undoDoneCancel').innerText(),'Close');
      await submit();assert.equal(await page.evaluate(()=>calls.length),1);
      await page.getByRole('button',{name:'Reload and Check'}).click();assert.equal(await page.evaluate(()=>refreshes.length),1);
      await open();assert.equal(await page.locator('#undoDoneForm').count(),0,'Consumed cached row needs a new read, not just reopening');
      await reset();await open();assert.equal(await page.locator('#undoDoneForm').count(),1,'A fresh schedule view permits a deliberate new review');
    }
    for(const change of ['login','role','unprotected']){
      await reset();await open();await prepare();await page.evaluate(change=>{if(change==='login')token='changed';if(change==='role')user.role='ADMIN';if(change==='unprotected')protectedMode=false},change);await submit();
      assert.equal(await page.evaluate(()=>calls.length),0);assert.equal(await page.locator('[name="password"]').inputValue(),'');assert.match(await page.locator('#undoDoneMessage').innerText(),/sign in again/);
    }
    // Private inputs are cleared on cancel, replacement and a hidden tab, not only after a valid save.
    await reset();await open();await prepare();await page.evaluate(()=>window.oldForm=$('#undoDoneForm'));await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>oldForm.elements.password.value),'');
    await reset();await open();await prepare();await page.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden});assert.equal(await page.locator('[name="password"]').inputValue(),'');
    await reset();await open();await prepare();await page.evaluate(()=>{window.oldForm=$('#undoDoneForm');modal('<p id="replacement">Keep replacement</p>')});
    await page.waitForFunction(()=>oldForm.elements.password.value==='');await page.evaluate(()=>oldForm.onsubmit({preventDefault(){}}));assert.equal(await page.evaluate(()=>calls.length),0);
    for(const change of ['login','role','modal']){
      await reset();await open();await prepare();await page.evaluate(()=>{pauseWrite=true;window.pendingChange=$('#undoDoneForm').onsubmit({preventDefault(){}})});await page.waitForFunction(()=>typeof releaseWrite==='function');
      await page.evaluate(change=>{if(change==='login')token='changed';if(change==='role')user.role='ADMIN';modal('<p id="replacement">Keep replacement</p>');releaseWrite()},change);await page.evaluate(()=>pendingChange);
      assert.equal(await page.locator('#replacement').innerText(),'Keep replacement');assert.equal(await page.evaluate(()=>refreshes.length),0);assert.equal(await page.evaluate(()=>messages.length),0);assert.equal(await page.evaluate(()=>sentArgs.p_password),'');
      assert.equal(await page.locator('#modal .close').isDisabled(),false,'A replacement dialog must never inherit the Undo Done close lock');
    }
    await reset({patient_name:'Synthetic <img src=x onerror=alert(1)>'});await open();assert.equal(await page.locator('#modalBody img,#modalBody script').count(),0);
    await reset();await open();await page.locator('[name="reason"]').fill('The completion status was selected for the wrong case. Correcting the record without changing its historical OT slot.');
    if(process.env.ORL_UNDO_DONE_QA){await mkdir(process.env.ORL_UNDO_DONE_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_UNDO_DONE_QA,'undo-done-desktop.png'),fullPage:true})}
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.ORL_UNDO_DONE_QA)await page.screenshot({path:resolve(process.env.ORL_UNDO_DONE_QA,'undo-done-mobile.png'),fullPage:true});
  }finally{await browser.close()}
});
