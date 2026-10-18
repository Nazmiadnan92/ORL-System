import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const qaDirectory=fileURLToPath(new URL('../../qa/past-cases/',import.meta.url));
test('Webmaster-only historical records use a fresh protected view, reviewed clinical corrections and one-shot saving',async()=>{
  const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1180,height:940},timezoneId:'Asia/Kuala_Lumpur'});
    await page.clock.install({time:new Date('2026-10-18T04:00:00Z')});
    await page.route('**/*',route=>route.abort());
    await page.setContent('<main><div id="actions"></div></main><div id="modal" class="modal" hidden><div class="dialog"><button class="close" onclick="closeModal()">×</button><div id="modalBody"></div></div></div>');
    for(const file of ['styles.css','mobile.css','past-cases.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
    await page.evaluate(()=>{
      window.$=selector=>document.querySelector(selector);window.esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
      window.sid='11111111-1111-4111-8111-111111111111';window.rid='22222222-2222-4222-8222-222222222222';
      window.owner='33333333-3333-4333-8333-333333333333';window.gen='44444444-4444-4444-8444-444444444444';
      if(!crypto.randomUUID)crypto.randomUUID=()=> '55555555-5555-4555-8555-555555555555';
      window.protectedIcEnabled=()=>window.protectedMode;window.isPastOtDate=date=>date<'2026-10-18';
      window.formatSystemDate=value=>value;window.patientNameCase=value=>String(value||'').trim();window.clinicalUpper=value=>String(value||'').trim().toUpperCase();
      window.subspecialtyOptions=()=>['Gen ORL','Rhinology','Otology','Head & Neck','Paeds','Sleep Surgery'];window.bindClinicalFormatting=()=>{};
      window.maskPatientIc=value=>value?'900101-**-****':'';
      window.modal=html=>{$('#modalBody').innerHTML=html;$('#modal').hidden=false};window.closeModal=()=>{$('#modalBody').textContent='';$('#modal').hidden=true};
      window.toast=value=>messages.push(value);window.reloadSchedule=async options=>{refreshes.push(options)};
      window.fixture=(mode='EDIT',overrides={})=>{
        closeModal();window.token=owner;window.user={role:'WEBMASTER',display_name:'Synthetic Webmaster'};window.protectedMode=true;
        window.calls=[];window.messages=[];window.refreshes=[];window.pauseRead=false;window.pauseWrite=false;window.failWrite=false;window.badResult=false;
        window.patient={patient_name:'Synthetic Patient',mrn:'SYNTHETIC-MRN',age:36,age_months:2,diagnosis:'SYNTHETIC DIAGNOSIS',surgery:'SYNTHETIC PROCEDURE',doctor:'Synthetic Doctor',specialist:'Synthetic Specialist',sub_specialty:'Gen ORL',phone:'TEST-ONLY',remark:'Synthetic remark',patient_ic:'900101-**-****'};
        window.slot={id:sid,request_id:mode==='EDIT'?rid:null,patient_name:mode==='EDIT'?patient.patient_name:null,status:mode==='EDIT'?'CONFIRMED':'CLOSED'};
        window.session={ot_date:'2026-10-17'};
        window.view={mode,slot_id:sid,session_id:gen,ot_date:'2026-10-17',slot_type:'MAIN',slot_number:4,slot_status:slot.status,session_status:'ACTIVE',request_id:slot.request_id,request_status:mode==='EDIT'?'SCHEDULED':null,ot_hold:false,postpone_count:3,generation:gen,expected_version:mode==='EDIT'?'2026-10-17T01:02:03.456789Z':null,snapshot:'a'.repeat(64),patient:mode==='EDIT'?patient:null,_ic_past_context:Object.freeze({issued:Math.random()}),...overrides};
        window.expectedResponseDate=view.ot_date;
      };
      window.rpc=async(name,args)=>{
        calls.push({name,args:JSON.parse(JSON.stringify(args))});
        if(name==='orl_ic_past_case_view'){const result=view;if(pauseRead)await new Promise(resolve=>window.releaseRead=resolve);return result}
        if(name==='orl_ic_past_case_save'){
          window.contextMatched=args.p_context===view._ic_past_context;
          if(pauseWrite)await new Promise(resolve=>window.releaseWrite=resolve);
          if(failWrite)throw Error('Synthetic uncertain save.');
          return {request_id:badResult?'unexpected':args.p_request_id,slot_id:sid,ot_date:expectedResponseDate,mode:view.mode,status:view.mode==='ADD'?'SCHEDULED':view.request_status,updated_at:'2026-10-18T01:02:03Z'};
        }
        throw Error('Unexpected synthetic RPC');
      };
      fixture();
    });
    const clinical=await readFile(new URL('../../docs/clinical-features.js',import.meta.url),'utf8');
    await page.addScriptTag({content:clinical.slice(0,clinical.indexOf('function ageFields'))});
    await page.addScriptTag({content:await readFile(new URL('../../docs/past-cases.js',import.meta.url),'utf8')});
    const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
    const extract=name=>{const start=app.lastIndexOf('function '+name+'(');assert.ok(start>=0,name);const rest=app.slice(start),end=rest.search(/\n(?:async )?function /);return end<0?rest:rest.slice(0,end)};
    await page.evaluate(()=>{
      window.canPickSlot=()=>false;window.directRequestAllowed=()=>false;window.patientAgeFromIc=()=>36;window.patientAgeText=()=> '36 years';
      window.otLifecycleActions=()=>'';Object.defineProperty(window,'status',{value:value=>esc(value),configurable:true,writable:true});
    });
    for(const name of ['slotCard','editSlot'])await page.addScriptTag({content:extract(name)});
    const reset=(mode='EDIT',overrides={})=>page.evaluate(({mode,overrides})=>fixture(mode,overrides),{mode,overrides});
    const open=()=>page.evaluate(()=>openPastCase(sid));
    const submit=()=>page.evaluate(()=>$('#pastCaseForm').onsubmit({preventDefault(){}}));
    const change=async()=>{await page.locator('[name="diagnosis"]').fill('corrected synthetic diagnosis');await page.locator('[name="reason"]').fill('Synthetic documented correction');await submit()};
    const confirm=async()=>{await page.locator('[name="password"]').fill('synthetic-password');await page.locator('[name="confirmed"]').check()};
    const writes=()=>page.evaluate(()=>calls.filter(call=>call.name==='orl_ic_past_case_save'));

    // Exercise the actual final schedule renderer and the ordinary Edit entry-point guard.
    for(const role of ['STAFF','ADMIN','WEBMASTER'])for(const mode of ['ADD','EDIT','DONE']){
      await reset(mode==='ADD'?'ADD':'EDIT');await page.evaluate(({role,mode})=>{
        user.role=role;slot={...(mode==='ADD'?{}:patient),...slot,type:'MAIN',number:4,request_status:mode==='DONE'?'COMPLETED':'SCHEDULED',_ic_generation:gen};
        session={...session,session_id:gen,status:'ACTIVE',slots:[slot]};window._schedule=[session];
        $('#actions').innerHTML=slotCard(slot,session,role!=='STAFF');
      },{role,mode});
      assert.equal(await page.locator('#actions [onclick^="editSlot"]').count(),0,`${role} ${mode}: ordinary Edit absent`);
      assert.equal(await page.locator('#actions [onclick^="openPastCase"]').count(),role==='WEBMASTER'?1:0,`${role} ${mode}: dedicated historical control`);
      if(role==='WEBMASTER'){
        assert.match(await page.locator('#actions [onclick^="openPastCase"]').innerText(),mode==='ADD'?/Add Past Case/:/Edit Past Record/);
        await page.evaluate(()=>editSlot(sid));assert.equal(await page.locator('#pastCaseForm').count(),1);
      }else{
        await page.evaluate(()=>editSlot(sid));assert.equal(await page.locator('#pastCaseForm').count(),0);assert.equal(await page.evaluate(()=>calls.length),0);
        assert.match(await page.evaluate(()=>messages.at(-1)),/Only Webmaster/);
      }
    }
    for(const role of ['STAFF','ADMIN','WEBMASTER']){
      await reset();await page.evaluate(role=>{user.role=role;slot={...patient,...slot,type:'MAIN',number:4,request_status:'SCHEDULED'};session.ot_date='2026-10-19';$('#actions').innerHTML=slotCard(slot,session,role!=='STAFF')},role);
      assert.equal(await page.locator('#actions [onclick^="editSlot"]').count(),1,`${role}: future Edit retained`);
      assert.equal(await page.locator('#actions [onclick^="openPastCase"]').count(),0);
    }

    for(const role of ['STAFF','ADMIN']){
      await reset();await page.evaluate(role=>{user.role=role;$('#actions').innerHTML=pastCaseActions(slot,session)},role);
      assert.equal(await page.locator('#actions button').count(),0);await open();assert.equal(await page.evaluate(()=>calls.length),0);
    }
    for(const mode of ['EDIT','ADD']){
      await reset(mode);await page.evaluate(()=>{$('#actions').innerHTML=pastCaseActions(slot,session)});
      assert.match(await page.locator('#actions button').innerText(),mode==='EDIT'?/Edit Past Record/:/Add Past Case/);
    }
    for(const scenario of ['today','future','unprotected','notempty','reserved','invalidid']){
      await reset('ADD');await page.evaluate(scenario=>{
        if(scenario==='today')session.ot_date='2026-10-18';if(scenario==='future')session.ot_date='2026-10-19';
        if(scenario==='unprotected')protectedMode=false;if(scenario==='notempty')slot.patient_name='Not empty';
        if(scenario==='reserved')slot.status='RESERVED';if(scenario==='invalidid')slot.id='unsafe';
        $('#actions').innerHTML=pastCaseActions(slot,session);
      },scenario);assert.equal(await page.locator('#actions button').count(),0,scenario);
    }
    await reset();await open();assert.equal((await page.evaluate(()=>calls))[0].name,'orl_ic_past_case_view');
    assert.equal(await page.locator('[name="patient_name"]').inputValue(),'Synthetic Patient');
    assert.equal(await page.locator('[name="ic_mode"]').inputValue(),'KEEP');assert.equal(await page.locator('[name="patient_ic"]').inputValue(),'');
    assert.equal(await page.locator('[name="patient_ic"]').isVisible(),false);
    assert.equal(await page.locator('[name="status"],[name="postpone_count"],[name="ot_hold"],[name="ot_date"],[name="slot_id"]').count(),0);
    await submit();assert.match(await page.locator('#pastCaseMessage').innerText(),/reason/i);assert.equal((await writes()).length,0);
    await page.locator('[name="reason"]').fill('A reason without a correction');await submit();assert.match(await page.locator('#pastCaseMessage').innerText(),/No details have changed/);
    await change();assert.equal(await page.locator('#pastCaseReview').isVisible(),true);assert.equal(await page.locator('#pastCaseDetails').isVisible(),false);
    assert.match(await page.locator('#pastCaseChanges').innerText(),/SYNTHETIC DIAGNOSIS.*CORRECTED SYNTHETIC DIAGNOSIS/s);
    assert.doesNotMatch(await page.locator('#pastCaseReview').innerText(),/900101/);
    await submit();assert.match(await page.locator('#pastCaseMessage').innerText(),/password.*confirm/);assert.equal((await writes()).length,0);
    await confirm();await page.evaluate(()=>{patient.diagnosis='Changed after view';view.ot_date='2026-10-16';view.request_id=gen;pauseWrite=true;window.pending=$('#pastCaseForm').onsubmit({preventDefault(){}})});
    await page.waitForFunction(()=>typeof releaseWrite==='function');assert.equal(await page.locator('[name="password"]').inputValue(),'');
    await submit();assert.equal((await writes()).length,1);assert.equal(await page.locator('#pastCaseSubmit').isDisabled(),true);
    let sent=(await writes())[0].args;
    assert.equal(sent.p_data.diagnosis,'CORRECTED SYNTHETIC DIAGNOSIS');assert.equal(sent.p_request_id,'22222222-2222-4222-8222-222222222222');
    assert.equal(sent.p_ic_mode,'KEEP');assert.equal(Object.hasOwn(sent.p_data,'patient_ic'),false);
    assert.deepEqual(Object.keys(sent).sort(),['p_session_token','p_context','p_request_id','p_data','p_reason','p_ic_mode','p_password'].sort());
    assert.deepEqual(sent.p_data,{diagnosis:'CORRECTED SYNTHETIC DIAGNOSIS'});
    assert.equal(Object.hasOwn(sent.p_data,'age'),false,'An unchanged displayed age must not rewrite a possibly older stored age');
    assert.equal(Object.hasOwn(sent.p_data,'age_months'),false,'Unchanged month precision must not be written silently');
    assert.equal(await page.evaluate(()=>contextMatched),true);
    await page.evaluate(()=>releaseWrite());await page.evaluate(()=>pending);assert.equal(await page.locator('#modal').isHidden(),true);
    assert.deepEqual(await page.evaluate(()=>refreshes),[{forceOpenDate:'2026-10-17'}]);

    // Legacy unknown ages stay unknown when an unrelated clinical field is corrected.
    await reset();await page.evaluate(()=>{patient.age=null;patient.age_months=null});await open();
    assert.equal(await page.locator('[name="age"]').inputValue(),'');assert.equal(await page.locator('[name="age"]').getAttribute('required'),null);
    await change();await confirm();await submit();sent=(await writes())[0].args;
    assert.deepEqual(sent.p_data,{diagnosis:'CORRECTED SYNTHETIC DIAGNOSIS'});assert.equal(await page.locator('#modal').isHidden(),true);
    // A known age cannot be cleared or replaced with an invalid number.
    for(const age of ['','-1','131','1.5']){
      await reset();await open();await page.locator('[name="age"]').fill(age);await change();
      assert.equal(await page.locator('#pastCaseReview').isHidden(),true);assert.equal((await writes()).length,0);
      assert.match(await page.locator('#pastCaseMessage').innerText(),/Age \(Years\)/);
    }

    // Done, cancellation, Hold and counts are never editable fields or write payload keys.
    for(const overrides of [{request_status:'COMPLETED'},{ot_hold:true},{request_status:'CANCELLED'}]){
      await reset('EDIT',overrides);await open();await change();await confirm();await submit();
      assert.equal((await writes()).length,1);assert.equal(Object.hasOwn((await writes())[0].args.p_data,'status'),false);
    }
    // A replacement identity is explicit; the review never displays plaintext.
    await reset();await open();await page.locator('[name="ic_mode"]').selectOption('SET');await page.locator('[name="reason"]').fill('Correct identity');
    await submit();assert.match(await page.locator('#pastCaseMessage').innerText(),/Enter the corrected IC/);
    await page.locator('[name="patient_ic"]').fill('900101-01-1234');await submit();assert.doesNotMatch(await page.locator('#pastCaseReview').innerText(),/900101-01-1234/);
    await confirm();await submit();sent=(await writes())[0].args;assert.equal(sent.p_ic_mode,'SET');assert.equal(sent.p_data.patient_ic,'900101-01-1234');

    // Valid replacement IC derives the same historical age reviewed and sent, never today's age.
    await reset('EDIT',{ot_date:'2001-10-17'});await open();
    assert.equal(await page.locator('[name="age"]').inputValue(),'36');assert.equal(await page.locator('[name="age_months"]').inputValue(),'2');
    await page.locator('[name="ic_mode"]').selectOption('SET');await page.locator('[name="patient_ic"]').fill('900101-01-1234');
    assert.equal(await page.locator('[name="age"]').inputValue(),'11');assert.equal(await page.locator('[name="age_months"]').inputValue(),'9');
    assert.equal(await page.locator('[name="age"]').getAttribute('readonly'),'');
    await page.evaluate(()=>{document.querySelector('[name="age"]').value='100'});await page.locator('[name="reason"]').fill('Synthetic historical identity correction');await submit();
    assert.match(await page.locator('#pastCaseChanges').innerText(),/Age \(Years\).*36.*11/s);assert.match(await page.locator('#pastCaseChanges').innerText(),/Age \(Months\).*2.*9/s);
    await confirm();await submit();sent=(await writes())[0].args;assert.equal(sent.p_data.age,'11');assert.equal(sent.p_data.age_months,'9');assert.equal(await page.locator('#modal').isHidden(),true);
    // Passport needs a manual historical age; switching back to KEEP restores manual fields.
    await reset('EDIT',{ot_date:'2001-10-17'});await open();await page.locator('[name="age"]').fill('10');
    await page.locator('[name="ic_mode"]').selectOption('SET');await page.locator('[name="patient_ic"]').fill('900101-01-1234');
    assert.equal(await page.locator('[name="age"]').inputValue(),'11');await page.locator('[name="ic_mode"]').selectOption('KEEP');
    assert.equal(await page.locator('[name="age"]').inputValue(),'10');assert.equal(await page.locator('[name="age_months"]').inputValue(),'2');
    assert.equal(await page.locator('[name="age"]').getAttribute('readonly'),null);
    await page.locator('[name="reason"]').fill('Synthetic manual historical age correction');await submit();await confirm();await submit();
    sent=(await writes())[0].args;assert.equal(sent.p_ic_mode,'KEEP');assert.equal(sent.p_data.age,'10');
    await reset('EDIT',{ot_date:'2001-10-17'});await open();await page.locator('[name="ic_mode"]').selectOption('SET');await page.locator('[name="patient_ic"]').fill('900101-01-1234');
    await page.locator('[name="patient_ic"]').fill('P-SYNTHETIC');await page.locator('[name="age"]').fill('');await page.locator('[name="reason"]').fill('Synthetic passport correction');
    await submit();assert.match(await page.locator('#pastCaseMessage').innerText(),/Age \(Years\) is required/);
    await page.locator('[name="age"]').fill('15');await page.locator('[name="age_months"]').fill('');await submit();await confirm();await submit();
    sent=(await writes())[0].args;assert.equal(sent.p_data.age,'15');assert.equal(sent.p_data.age_months,'');assert.equal(sent.p_data.patient_ic,'P-SYNTHETIC');

    // A late entry uses a new request id and no implicit completion/status controls.
    await reset('ADD');await open();
    assert.match(await page.locator('.past-case-notice').innerText(),/not marked Done/);
    assert.equal(await page.locator('[name="doctor"]').inputValue(),'');
    for(const [name,value] of Object.entries({patient_name:'Synthetic Missed Case',mrn:'TEST-LATE',diagnosis:'Synthetic late diagnosis',surgery:'Synthetic late procedure',doctor:'Synthetic Historical Doctor',reason:'Paper record entered late'}))await page.locator(`[name="${name}"]`).fill(value);
    await submit();assert.match(await page.locator('#pastCaseMessage').innerText(),/Age \(Years\) is required/);assert.equal((await writes()).length,0);
    await page.locator('[name="age"]').fill('36');await submit();await confirm();await submit();sent=(await writes())[0].args;
    assert.notEqual(sent.p_request_id,'22222222-2222-4222-8222-222222222222');assert.match(sent.p_request_id,/^[a-f0-9-]{36}$/);
    assert.equal(sent.p_data.patient_ic,'');assert.equal(sent.p_ic_mode,'SET');assert.equal(sent.p_data.age,'36');
    assert.equal(Object.hasOwn(sent.p_data,'status'),false);assert.match(await page.evaluate(()=>messages.at(-1)),/not marked Done/);
    await reset('ADD',{ot_date:'2001-10-17'});await open();
    for(const [name,value] of Object.entries({patient_name:'Synthetic Missed IC Case',mrn:'TEST-LATE-IC',diagnosis:'Synthetic diagnosis',surgery:'Synthetic procedure',doctor:'Synthetic Doctor',patient_ic:'900101-01-1234',reason:'Synthetic historical identity entry'}))await page.locator(`[name="${name}"]`).fill(value);
    assert.equal(await page.locator('[name="age"]').inputValue(),'11');await submit();
    assert.match(await page.locator('#pastCaseChanges').innerText(),/Age \(Years\).*11/s);assert.match(await page.locator('#pastCaseChanges').innerText(),/Age \(Months\).*9/s);
    await confirm();await submit();sent=(await writes())[0].args;assert.equal(sent.p_data.age,'11');assert.equal(sent.p_data.age_months,'9');assert.equal(await page.locator('#modal').isHidden(),true);

    // A failed or mismatched response cannot silently resubmit the same snapshot.
    for(const failure of ['failWrite','badResult']){
      await reset();await open();await change();await confirm();await page.evaluate(failure=>window[failure]=true,failure);await submit();
      assert.match(await page.locator('#pastCaseMessage').innerText(),/Reload and check.*not be repeated automatically/);
      await submit();assert.equal((await writes()).length,1);
      await page.getByRole('button',{name:'Reload and Check'}).click();assert.equal(await page.locator('#modal').isHidden(),true);
    }
    for(const stale of ['token','role','unprotected']){
      await reset();await open();await change();await confirm();await page.evaluate(stale=>{if(stale==='token')token='changed';if(stale==='role')user.role='ADMIN';if(stale==='unprotected')protectedMode=false},stale);await submit();
      assert.equal((await writes()).length,0);assert.equal(await page.locator('[name="password"]').inputValue(),'');assert.match(await page.locator('#pastCaseMessage').innerText(),/sign in again/);
    }
    // Closing/replacing a form scrubs detached sensitive inputs as well.
    await reset();await open();await page.locator('[name="ic_mode"]').selectOption('SET');await page.locator('[name="patient_ic"]').fill('900101-01-1234');await change();await confirm();
    await page.evaluate(()=>{window.oldForm=$('#pastCaseForm');modal('<div id="replacement">Another dialog</div>')});
    await page.waitForFunction(()=>oldForm.elements.password.value===''&&oldForm.elements.patient_ic.value==='');
    await page.evaluate(()=>oldForm.onsubmit({preventDefault(){}}));assert.equal((await writes()).length,0);assert.equal(await page.locator('#replacement').innerText(),'Another dialog');
    // An old view response must not overwrite a different modal or a different login.
    for(const stale of ['modal','login']){
      await reset();await page.evaluate(()=>{pauseRead=true;window.pendingRead=openPastCase(sid)});await page.waitForFunction(()=>typeof releaseRead==='function');
      await page.evaluate(stale=>{if(stale==='login')token='changed';modal('<div id="replacement">Keep this dialog</div>');releaseRead()},stale);await page.evaluate(()=>pendingRead);
      assert.equal(await page.locator('#replacement').innerText(),'Keep this dialog');assert.equal(await page.locator('#pastCaseForm').count(),0);
    }
    await reset();await open();await change();await confirm();await page.evaluate(()=>{pauseWrite=true;window.pendingSave=$('#pastCaseForm').onsubmit({preventDefault(){}})});await page.waitForFunction(()=>typeof releaseWrite==='function');
    await page.evaluate(()=>{modal('<div id="replacement">New dialog during saving</div>');releaseWrite()});await page.evaluate(()=>pendingSave);
    assert.equal(await page.locator('#replacement').innerText(),'New dialog during saving');assert.equal(await page.evaluate(()=>refreshes.length),0);
    // Synthetic HTML is text, not executable markup; both layouts remain usable.
    await reset();await page.evaluate(()=>{patient.patient_name='Synthetic <img src=x onerror=alert(1)>';patient.remark='<script>synthetic</script>'});await open();await change();
    assert.equal(await page.locator('#modalBody img,#modalBody script').count(),0);
    await mkdir(qaDirectory,{recursive:true});await page.screenshot({path:resolve(qaDirectory,'past-record-review-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:resolve(qaDirectory,'past-record-review-mobile.png'),fullPage:true});
    await page.locator('#pastCaseBack').click();await page.screenshot({path:resolve(qaDirectory,'past-record-edit-mobile.png'),fullPage:true});
  }finally{await browser.close()}
});
