import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('Done historical reordering is Webmaster-only, same-date, confirmed and preserves normal Done restrictions',async()=>{
  const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1180,height:940},timezoneId:'America/Los_Angeles'});
    await page.clock.install({time:new Date('2026-10-18T04:00:00Z')});await page.route('**/*',route=>route.abort());
    await page.setContent('<main><div id="actions"></div></main><div id="modal" class="modal" hidden><div class="dialog"><button class="close" onclick="closeModal()">×</button><div id="modalBody"></div></div></div>');
    for(const file of ['styles.css','mobile.css','schedule.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
    await page.evaluate(()=>{
      window.$=selector=>document.querySelector(selector);
      window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
      window.sid=uuid(1);window.from=uuid(2);window.to=uuid(3);window.rid=uuid(4);window.owner=uuid(5);window.gen=uuid(6);
      window.formatSystemDate=value=>value;window.patientNameCase=value=>value||'';window.clinicalUpper=value=>value||'';
      window.maskPatientIc=()=>'';window.patientAgeText=()=> 'Synthetic age';window.patientAgeFromIc=()=> '—';
      window.canPickSlot=()=>false;window.directRequestAllowed=()=>false;window.pastCaseActions=()=>'';
      window.malaysiaToday=()=>({iso:'2026-10-18'});
      Object.defineProperty(window,'status',{configurable:true,writable:true,value:value=>esc(value)});
      window.protectedIcEnabled=()=>window.protectedMode;
      window.modal=html=>{$('#modalBody').innerHTML=html;$('#modal').hidden=false};
      window.closeModal=()=>{$('#modalBody').textContent='';$('#modal').hidden=true};
      window.toast=message=>messages.push(message);window.reloadSchedule=async()=>{refreshes++};
      window.fixture=(options={})=>{
        const {role='WEBMASTER',date='2026-10-17',protectedMode=true,sourceDone=true,destination='AVAILABLE'}=options;
        closeModal();$('#actions').textContent='';window.user={role};window.token=owner;window.protectedMode=protectedMode;
        window.calls=[];window.messages=[];window.refreshes=0;window.confirmations=[];window.allowConfirm=true;
        window.failWrite=false;window.pauseWrite=false;window.changeDuringConfirm=false;
        window.source={id:from,type:'MAIN',number:5,request_id:rid,patient_name:'Synthetic Completed Patient',status:'CONFIRMED',request_status:sourceDone?'COMPLETED':'SCHEDULED',deletion_status:'',_ic_generation:gen,postpone_count:3,ot_hold:false,
          completed_at:sourceDone?'2026-10-17T05:06:07Z':null,completed_by:sourceDone?uuid(7):null};
        const occupied=['SCHEDULED','COMPLETED'].includes(destination);
        window.destination={id:to,type:'SPECIAL',number:2,request_id:occupied?uuid(8):null,patient_name:occupied?'Synthetic Other Patient':null,status:occupied?'CONFIRMED':destination,request_status:occupied?destination:null,deletion_status:occupied?'':null,
          completed_at:destination==='COMPLETED'?'2026-10-17T08:09:10Z':null,completed_by:destination==='COMPLETED'?uuid(9):null};
        window.session={session_id:sid,ot_date:date,status:'ACTIVE',slots:[source,window.destination]};
        window.otherDestination={id:uuid(15),type:'MAIN',number:1,status:'AVAILABLE',request_id:null};
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
    const lifecycle=await readFile(new URL('../../docs/ot-lifecycle.js',import.meta.url),'utf8');
    await page.addScriptTag({content:lifecycle.slice(0,lifecycle.indexOf('function otLifecycleSelection'))});
    await page.addScriptTag({content:app.slice(app.indexOf('let reassignSelection=null;'),app.indexOf('function editSlot('))});
    const start=app.lastIndexOf('function slotCard('),rest=app.slice(start),end=rest.search(/\n(?:async )?function /);
    await page.addScriptTag({content:rest.slice(0,end)});
    const reset=(options={})=>page.evaluate(options=>fixture(options),options);
    const draw=()=>page.evaluate(()=>{$('#actions').innerHTML=slotCard(source,session,user.role!=='STAFF')});
    const open=()=>page.evaluate(()=>reassignSlot(sid,from));
    const choose=()=>page.evaluate(()=>swapSlot(from,to));
    const writes=()=>page.evaluate(()=>calls);

    // Both ends of a Done-involving reorder are guarded, including direct function calls and legacy mode.
    for(const sourceDone of [true,false])for(const role of ['WEBMASTER','ADMIN','STAFF'])for(const date of ['2026-10-17','2026-10-18','2026-10-19'])for(const protectedMode of [true,false]){
      const allowed=role==='WEBMASTER'&&date==='2026-10-17'&&protectedMode;
      await reset({sourceDone,role,date,protectedMode,destination:sourceDone?'AVAILABLE':'COMPLETED'});await draw();
      if(sourceDone){
        assert.equal(await page.locator('#actions [onclick^="reassignSlot"]').count(),allowed?1:0,`${role} ${date} protected=${protectedMode}`);
        assert.equal(await page.locator('#actions [onclick^="openUndoDone"]').count(),role==='WEBMASTER'&&date<='2026-10-18'&&protectedMode?1:0,'Undo Done is a separate privileged correction, not ordinary editing');
        assert.equal(await page.locator('#actions [onclick^="postponeSlot"],#actions [onclick^="editSlot"],#actions [onclick^="clearSlot"],#actions [onclick^="openOtLifecycle"],#actions [onclick^="approveSlotRequest"]').count(),0,'Done remains closed to ordinary patient/lifecycle edits');
        assert.equal(await page.locator('#actions .COMPLETED').innerText(),'DONE');
      }
      await open();assert.equal(await page.locator('#modalBody button').count(),allowed?1:0);
      await choose();assert.equal((await writes()).length,allowed?1:0);
      assert.equal(await page.evaluate(()=>confirmations.length),allowed?1:0);
    }
    for(const destination of ['AVAILABLE','CLOSED','SCHEDULED','COMPLETED'])for(const sourceType of ['MAIN','SPECIAL']){
      await reset({destination});await page.evaluate(sourceType=>source.type=sourceType,sourceType);await open();
      assert.match(await page.locator('#modalBody').innerText(),/Done status and completion details are preserved/);
      if(destination==='COMPLETED')assert.match(await page.locator('#modalBody button').innerText(),/· Done/);
      await page.evaluate(()=>allowConfirm=false);await choose();assert.equal((await writes()).length,0);assert.equal(await page.locator('#modal').isVisible(),true);
      assert.match(await page.evaluate(()=>confirmations.at(-1)),/Done status, completion details, Hold status and postpone count will not change/);
      assert.match(await page.evaluate(()=>confirmations.at(-1)),/Past slots stay closed to new requests/);
      assert.match(await page.evaluate(()=>confirmations.at(-1)),new RegExp(`from ${sourceType==='MAIN'?'Main':'Special'} S5 \\(Done\\) to Special S2`));
      const before=await page.evaluate(()=>JSON.stringify({source,destination}));
      await page.evaluate(()=>allowConfirm=true);await choose();assert.equal((await writes()).length,1);
      assert.equal(await page.evaluate(()=>JSON.stringify({source,destination})),before,'UI never changes completion/hold/count/clinical fields optimistically');
      assert.deepEqual(Object.keys((await writes())[0].args).sort(),['p_session_token','p_from','p_to','p_expected_from_request_id','p_expected_to_request_id','p_generation'].sort());
      assert.equal((await writes())[0].args.p_expected_to_request_id,['SCHEDULED','COMPLETED'].includes(destination)?'00000000-0000-4000-8000-000000000008':null);
      await choose();assert.equal((await writes()).length,1,'Consumed context cannot submit twice');
    }
    for(const sourceDone of [true,false])for(const scenario of ['source-closed','source-pending-cancel','source-missing-deletion','target-closed-occupied','target-pending-cancel','target-cancelled','target-approved','target-reserved-empty','target-named-empty','target-missing-id']){
      await reset({sourceDone,destination:'COMPLETED'});await page.evaluate(scenario=>{
        if(scenario==='source-closed')source.status='CLOSED';
        if(scenario==='source-pending-cancel')source.deletion_status='PENDING';
        if(scenario==='source-missing-deletion')delete source.deletion_status;
        if(scenario==='target-closed-occupied')destination.status='CLOSED';
        if(scenario==='target-pending-cancel')destination.deletion_status='PENDING';
        if(scenario==='target-cancelled')destination.request_status='CANCELLED';
        if(scenario==='target-approved')destination.request_status='APPROVED';
        if(scenario==='target-reserved-empty'){destination.request_id=null;destination.patient_name=null;destination.request_status=null;destination.status='RESERVED'}
        if(scenario==='target-named-empty'){destination.request_id=null;destination.request_status=null;destination.status='AVAILABLE'}
        if(scenario==='target-missing-id')delete destination.request_id;
      },scenario);
      // When neither end is Done, retain ordinary reassignment behavior; its backend rules are unchanged.
      if(!sourceDone&&['target-cancelled','target-approved','target-reserved-empty','target-named-empty'].includes(scenario))continue;
      await open();await choose();assert.equal((await writes()).length,0,`${sourceDone} ${scenario}`);
    }
    // Hold, Reserved and historical completion metadata (including legacy nulls) are not rewritten.
    for(const reserved of [true,false])for(const held of [true,false]){
      await reset({destination:'COMPLETED'});await page.evaluate(({reserved,held})=>{
        source.status=reserved?'RESERVED':'CONFIRMED';source.ot_hold=held;source.completed_at=null;source.completed_by=null;
        destination.status=reserved?'RESERVED':'CONFIRMED';destination.ot_hold=held;
      },{reserved,held});await open();await choose();assert.equal((await writes()).length,1);
    }

    // Frozen dates, labels, patient IDs and generation cannot be replaced by later browser reads.
    await reset({destination:'COMPLETED'});await open();
    await page.evaluate(()=>{source.request_id=uuid(30);source._ic_generation=uuid(31);source.number=8;source.request_status='SCHEDULED';destination.request_id=uuid(32);destination.number=9;destination.type='MAIN';destination.request_status='SCHEDULED';session.ot_date='2026-10-19'});
    await choose();assert.deepEqual((await writes())[0],{name:'orl_swap_slots_checked',args:{
      p_session_token:'00000000-0000-4000-8000-000000000005',p_from:'00000000-0000-4000-8000-000000000002',p_to:'00000000-0000-4000-8000-000000000003',
      p_expected_from_request_id:'00000000-0000-4000-8000-000000000004',p_expected_to_request_id:'00000000-0000-4000-8000-000000000008',p_generation:'00000000-0000-4000-8000-000000000006'
    }});
    assert.match(await page.evaluate(()=>confirmations[0]),/from Main S5 \(Done\) to Special S2 \(Done\) on 2026-10-17/);
    await reset();await open();await page.evaluate(()=>swapSlot(from,otherDestination.id));assert.equal((await writes()).length,0,'Cross-date destination is not in captured choices');
    for(const sourceDone of [true,false])for(const stale of ['login','role-admin','role-staff','unprotected','confirm-login']){
      await reset({sourceDone,destination:'COMPLETED'});await open();await page.evaluate(stale=>{
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

    await reset({destination:'COMPLETED'});await page.evaluate(()=>{
      session.slots.push({id:uuid(50),type:'MAIN',number:1,request_id:null,patient_name:null,status:'CLOSED',request_status:null},
        {id:uuid(51),type:'MAIN',number:3,request_id:null,patient_name:null,status:'AVAILABLE',request_status:null});
    });await open();
    if(process.env.ORL_DONE_PAST_QA){await mkdir(process.env.ORL_DONE_PAST_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_DONE_PAST_QA,'done-past-reassign-desktop.png'),fullPage:true})}
    await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#modalBody button').first().isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(process.env.ORL_DONE_PAST_QA)await page.screenshot({path:resolve(process.env.ORL_DONE_PAST_QA,'done-past-reassign-mobile.png'),fullPage:true});
  }finally{await browser.close()}
});
