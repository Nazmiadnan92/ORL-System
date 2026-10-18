import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('existing Reassign permits only Webmaster to select an empty CLOSED slot on the same past date',async()=>{
  const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1180,height:940},timezoneId:'America/Los_Angeles'});
    await page.clock.install({time:new Date('2026-10-18T04:00:00Z')});
    await page.route('**/*',route=>route.abort());
    await page.setContent('<main><div id="actions"></div></main><div id="modal" class="modal" hidden><div class="dialog"><button class="close" onclick="closeModal()">×</button><div id="modalBody"></div></div></div>');
    for(const file of ['styles.css','mobile.css','schedule.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
    await page.evaluate(()=>{
      window.$=selector=>document.querySelector(selector);
      window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
      window.sid=uuid(1);window.from=uuid(2);window.to=uuid(3);window.rid=uuid(4);window.owner=uuid(5);window.gen=uuid(6);
      window.formatSystemDate=value=>value;window.patientNameCase=value=>value||'';window.clinicalUpper=value=>value||'';
      window.maskPatientIc=()=>'';window.patientAgeText=()=> 'Synthetic age';window.patientAgeFromIc=()=> '—';
      window.canPickSlot=()=>false;window.directRequestAllowed=()=>false;window.otLifecycleActions=()=>'';window.pastCaseActions=()=>'';
      Object.defineProperty(window,'status',{configurable:true,writable:true,value:value=>esc(value)});
      window.protectedIcEnabled=()=>window.protectedMode;
      window.modal=html=>{$('#modalBody').innerHTML=html;$('#modal').hidden=false};
      window.closeModal=()=>{$('#modalBody').textContent='';$('#modal').hidden=true};
      window.toast=message=>messages.push(message);window.reloadSchedule=async()=>{refreshes++};
      window.fixture=(role='WEBMASTER',date='2026-10-17')=>{
        closeModal();$('#actions').textContent='';window.user={role};window.token=owner;window.protectedMode=true;
        window.calls=[];window.messages=[];window.refreshes=0;window.confirmations=[];window.allowConfirm=true;
        window.failWrite=false;window.pauseWrite=false;window.changeDuringConfirm=false;
        window.source={id:from,type:'MAIN',number:5,request_id:rid,patient_name:'Synthetic Patient',status:'CONFIRMED',request_status:'SCHEDULED',deletion_status:'',_ic_generation:gen,postpone_count:3};
        window.destination={id:to,type:'MAIN',number:2,request_id:null,patient_name:null,status:'CLOSED',request_status:null};
        window.session={session_id:sid,ot_date:date,status:'ACTIVE',slots:[source,destination]};
        window.otherDestination={id:uuid(15),type:'SPECIAL',number:1,status:'CLOSED',request_id:null};
        window._schedule=[session,{session_id:uuid(16),ot_date:'2026-10-16',status:'ACTIVE',slots:[otherDestination]}];
      };
      window.confirm=message=>{confirmations.push(message);if(changeDuringConfirm)token='changed-during-confirm';return allowConfirm};
      window.rpc=async(name,args)=>{
        calls.push({name,args:JSON.parse(JSON.stringify(args))});
        if(pauseWrite)await new Promise(resolve=>window.releaseWrite=resolve);
        if(failWrite)throw Error('Synthetic uncertain reassignment. Reload and check.');
        return 'REASSIGNED';
      };
      fixture();
    });
    const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
    const dateHelpers=(await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')).split('function refreshPastOtCards')[0];
    await page.addScriptTag({content:dateHelpers});
    await page.addScriptTag({content:app.slice(app.indexOf('let reassignSelection=null;'),app.indexOf('function editSlot('))});
    const start=app.lastIndexOf('function slotCard('),rest=app.slice(start),end=rest.search(/\n(?:async )?function /);
    await page.addScriptTag({content:rest.slice(0,end)});
    const reset=(role='WEBMASTER',date='2026-10-17')=>page.evaluate(({role,date})=>fixture(role,date),{role,date});
    const open=()=>page.evaluate(()=>reassignSlot(sid,from));
    const choose=()=>page.evaluate(()=>swapSlot(from,to));
    const writes=()=>page.evaluate(()=>calls);

    // No new menu: the actual schedule renderer still exposes the same Reassign action.
    for(const role of ['WEBMASTER','ADMIN','STAFF']){
      await reset(role);await page.evaluate(()=>{$('#actions').innerHTML=slotCard(source,session,user.role!=='STAFF')});
      assert.equal(await page.locator('#actions [onclick^="reassignSlot"]').count(),role==='STAFF'?0:1);
      await open();
      assert.equal(await page.locator('#modalBody button').count(),role==='WEBMASTER'?1:0);
      assert.equal(await page.locator('#modalBody [onclick*="000000000015"]').count(),0,'Other sessions and dates are not destinations');
      await choose();assert.equal((await writes()).length,role==='WEBMASTER'?1:0);
    }
    for(const date of ['2026-10-18','2026-10-19']){
      await reset('WEBMASTER',date);await open();assert.equal(await page.locator('#modalBody button').count(),0);
      await choose();assert.equal((await writes()).length,0,'Today and future CLOSED slots stay closed');
    }
    for(const scenario of ['source-done-admin','source-cancelled','source-approved','source-closed','source-pending-cancel','source-missing-deletion-status','target-done','occupied-request','occupied-name','missing-request-snapshot','unprotected']){
      await reset();await page.evaluate(scenario=>{
        if(scenario==='source-done-admin'){source.request_status='COMPLETED';user.role='ADMIN'}
        if(scenario==='source-cancelled')source.request_status='CANCELLED';
        if(scenario==='source-approved')source.request_status='APPROVED';
        if(scenario==='source-closed')source.status='CLOSED';
        if(scenario==='source-pending-cancel')source.deletion_status='PENDING';
        if(scenario==='source-missing-deletion-status')delete source.deletion_status;
        if(scenario==='target-done')destination.request_status='COMPLETED';
        if(scenario==='occupied-request')destination.request_id=uuid(20);
        if(scenario==='occupied-name')destination.patient_name='Synthetic Occupant';
        if(scenario==='missing-request-snapshot')delete destination.request_id;
        if(scenario==='unprotected')protectedMode=false;
        $('#actions').innerHTML=slotCard(source,session,true);
      },scenario);
      if(scenario==='source-done-admin')assert.equal(await page.locator('#actions [onclick^="reassignSlot"]').count(),0);
      await open();await choose();assert.equal((await writes()).length,0,scenario);
      assert.equal(await page.locator('#modalBody button').count(),0,scenario);
    }
    for(const held of [true,false])for(const reserved of [true,false]){
      await reset();await page.evaluate(({held,reserved})=>{
        source.ot_hold=held;source.status=reserved?'RESERVED':'CONFIRMED';source.request_status=reserved?'CONFIRMED':'SCHEDULED';
      },{held,reserved});await open();await choose();assert.equal((await writes()).length,1,`Hold ${held}, reserved ${reserved}: active source remains eligible`);
    }

    // Main and Special CLOSED targets have an explicit historical label and cancel is non-mutating.
    for(const type of ['MAIN','SPECIAL']){
      await reset();await page.evaluate(type=>destination.type=type,type);await open();
      assert.match(await page.locator('#modalBody button').innerText(),/Closed · historical correction/);
      assert.match(await page.locator('#modalBody').innerText(),/vacated slot stays closed/);
      await page.evaluate(()=>allowConfirm=false);await page.locator('#modalBody button').click();
      assert.equal((await writes()).length,0);assert.equal(await page.evaluate(()=>refreshes),0);
      assert.equal(await page.locator('#modal').isVisible(),true);assert.equal(await page.evaluate(()=>reassignSelection.busy),false);
      assert.match(await page.evaluate(()=>confirmations.at(-1)),/same OT date.*remain closed.*postpone count/s);
      assert.match(await page.evaluate(()=>confirmations.at(-1)),new RegExp(`from Main S5 to ${type==='SPECIAL'?'Special':'Main'} S2 \\(Closed\\)`));
    }

    // All identity and destination snapshots are captured once; later schedule data cannot retarget the write.
    await reset();await open();
    await page.evaluate(()=>{source.request_id=uuid(30);source._ic_generation=uuid(31);source.number=8;destination.request_id=uuid(32);destination.number=9;destination.type='SPECIAL';session.ot_date='2026-10-19'});
    await choose();assert.equal((await writes()).length,1);
    assert.deepEqual((await writes())[0],{name:'orl_swap_slots_checked',args:{
      p_session_token:'00000000-0000-4000-8000-000000000005',p_from:'00000000-0000-4000-8000-000000000002',p_to:'00000000-0000-4000-8000-000000000003',
      p_expected_from_request_id:'00000000-0000-4000-8000-000000000004',p_expected_to_request_id:null,p_generation:'00000000-0000-4000-8000-000000000006'
    }});
    assert.match(await page.evaluate(()=>confirmations[0]),/2026-10-17/);
    assert.match(await page.evaluate(()=>confirmations[0]),/from Main S5 to Main S2 \(Closed\)/);
    assert.equal(await page.evaluate(()=>refreshes),1);assert.equal(await page.locator('#modal').isHidden(),true);
    await choose();assert.equal((await writes()).length,1,'Consumed selection cannot run twice');

    // A direct call cannot select another day's slot or bypass role/owner/Done restrictions.
    await reset();await open();await page.evaluate(()=>swapSlot(from,otherDestination.id));assert.equal((await writes()).length,0);
    for(const stale of ['login','role-admin','role-staff','unprotected','confirm-login']){
      await reset();await open();await page.evaluate(stale=>{
        if(stale==='login')token='changed';if(stale==='role-admin')user.role='ADMIN';if(stale==='role-staff')user.role='STAFF';
        if(stale==='unprotected')protectedMode=false;if(stale==='confirm-login')changeDuringConfirm=true;
      },stale);await choose();assert.equal((await writes()).length,0,stale);
    }
    await reset();await open();await page.evaluate(()=>failWrite=true);await choose();await choose();
    assert.equal((await writes()).length,1);assert.equal(await page.evaluate(()=>reassignSelection),null);
    assert.equal(await page.evaluate(()=>messages.includes('OT slots reassigned.')),false);
    await reset();await open();await page.evaluate(()=>{pauseWrite=true;window.pending=swapSlot(from,to)});
    await page.waitForFunction(()=>typeof releaseWrite==='function');await choose();assert.equal((await writes()).length,1);
    await page.evaluate(()=>{token='new-login';modal('<div id="newDialog">Keep new account dialog</div>');releaseWrite()});await page.evaluate(()=>pending);
    assert.equal(await page.locator('#newDialog').innerText(),'Keep new account dialog');assert.equal(await page.evaluate(()=>refreshes),0);
    assert.equal(await page.evaluate(()=>messages.includes('OT slots reassigned.')),false);

    // Ordinary available destinations and occupied swaps remain unchanged, without the CLOSED confirmation.
    for(const role of ['ADMIN','WEBMASTER'])for(const date of ['2026-10-17','2026-10-18','2026-10-19'])for(const occupied of [false,true]){
      await reset(role,date);await page.evaluate(occupied=>{
        destination.status=occupied?'CONFIRMED':'AVAILABLE';destination.request_id=occupied?uuid(40):null;
        destination.patient_name=occupied?'Synthetic Other Patient':null;destination.request_status=occupied?'SCHEDULED':null;
      },occupied);await open();await choose();assert.equal((await writes()).length,1,`${role} ${date} ${occupied}`);
      assert.equal((await writes())[0].args.p_expected_to_request_id,occupied?'00000000-0000-4000-8000-000000000040':null);
      assert.equal(await page.evaluate(()=>confirmations.length),0);
    }
    await reset('ADMIN');await page.evaluate(()=>{destination.status='CONFIRMED';destination.request_id=uuid(40);destination.patient_name='Synthetic Done';destination.request_status='COMPLETED';destination.deletion_status=''});
    await open();await choose();assert.equal((await writes()).length,0,'Admin cannot swap an occupied Done destination');
    await reset();await page.evaluate(()=>{
      session.slots.push({id:uuid(50),type:'SPECIAL',number:1,request_id:null,patient_name:null,status:'CLOSED',request_status:null},
        {id:uuid(51),type:'MAIN',number:1,request_id:uuid(52),patient_name:'Synthetic Other Patient',status:'CONFIRMED',request_status:'SCHEDULED'},
        {id:uuid(53),type:'MAIN',number:3,request_id:null,patient_name:null,status:'AVAILABLE',request_status:null});
    });await open();
    if(process.env.ORL_CLOSED_PAST_QA){await mkdir(process.env.ORL_CLOSED_PAST_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_CLOSED_PAST_QA,'closed-past-reassign-desktop.png'),fullPage:true})}
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#modalBody button').first().isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }finally{await browser.close()}
});
