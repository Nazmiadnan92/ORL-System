import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

test('saved Postpone shows the fresh destination patient name across month/year and mobile; failed saves and stale reads cannot navigate or highlight another patient',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900},timezoneId:'Asia/Kuala_Lumpur'});
  await page.clock.install({time:new Date('2026-10-12T04:00:00Z')});
  await page.route('**/*',route=>route.abort());
  await page.setContent('<main style="margin-left:0;width:100%;min-width:0"><header>ORL synthetic navigation test</header><div id="content"></div></main><div id="modal" class="modal" hidden><div class="dialog"><div id="modalBody"></div></div></div>');
  for(const file of ['styles.css','schedule.css','mobile.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  await page.addScriptTag({content:await readFile(new URL('../../docs/ot-lifecycle.js',import.meta.url),'utf8')});
  const extract=name=>{let start=app.lastIndexOf('function '+name+'(');assert.ok(start>=0,name);if(app.slice(start-6,start)==='async ')start-=6;const rest=app.slice(start),end=rest.search(/\n(?:async )?function /);return end<0?rest:rest.slice(0,end)};
  await page.evaluate(()=>{
   window.$=selector=>document.querySelector(selector);window.$$=selector=>[...document.querySelectorAll(selector)];
   window.esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
   window.head=title=>'<h1>'+title+'</h1>';window.months=['January','February','March','April','May','June','July','August','September','October','November','December'];
   window.token='11111111-1111-4111-8111-111111111111';window.rid='22222222-2222-4222-8222-222222222222';
   window.sourceId='33333333-3333-4333-8333-333333333333';window.targetId='44444444-4444-4444-8444-444444444444';
   window.gen='55555555-5555-4555-8555-555555555555';window.user={role:'STAFF',user_id:'synthetic-staff'};window.postponeBusy=false;
   window.pendingRequest=null;window.currentPage='schedule';window.protectedIcEnabled=()=>true;window.patientAgeFromIc=()=>36;window.patientAgeText=()=>'36 years';
   window.maskPatientIc=value=>value;window.patientNameCase=value=>value;window.clinicalUpper=value=>value;window.normalizeClinicalFields=()=>{};
   window.formatSystemDate=value=>value;window.admissionDate=value=>value;window.isPastOtDate=value=>typeof value==='string'&&value<'2026-10-12';
   window.savedScheduleView=()=>null;window.rememberScheduleView=(year,month)=>window._scheduleYM={year,month};
   window.scheduleYearBoxes=year=>'<b>'+year+'</b>';window.scheduleMonthTabs=(counts,year,month)=>'<b>'+months[month-1]+' '+year+'</b>';
   window.renderSpecialDays=()=>'';window.sessionAvailability=()=>'';window.slotPreview=()=>'';
   window.toast=message=>messages.push(message);window.closeModal=()=>{$('#modal').hidden=true;$('#modalBody').replaceChildren()};
   window.protectedIcArgs=async(form,data)=>({p_data:data,p_ic_mode:'KEEP',p_generation:gen,p_expected_version:'2026-10-12T00:00:00.123456+00:00'});
   window.reloadSchedule=async()=>{reloads++;return schedule(_scheduleYM.year,_scheduleYM.month)};
   window.messages=[];window.calls=[];window.scrolls=[];window.writeCount=0;window.reloads=0;
   const nativeScroll=Element.prototype.scrollIntoView;
   Element.prototype.scrollIntoView=function(options){scrolls.push({className:this.className,text:this.textContent,request:this.closest('[data-request-id]')?.dataset.requestId,options});return nativeScroll.call(this,options)};
   window.rowsFor=(year,month)=>{
    const prefix=year+'-'+String(month).padStart(2,'0')+'-';
    return ['01','04','07','10','13','16','19','22','25','28'].map((day,index)=>{
     const date=prefix+day,target=date===targetDate,source=date===sourceDate;
     const rows=Array.from({length:target?4:1},(_,slotIndex)=>({id:source&&slotIndex===0?sourceId:target&&slotIndex===2?targetId:'synthetic-'+date+'-'+slotIndex,type:'MAIN',number:slotIndex+1,status:'AVAILABLE',request_id:null,patient_name:null}));
     const patient={request_id:rid,patient_name:'Synthetic Moved Patient',patient_ic:'900101-**-****',mrn:'SYNTHETIC-ONLY',age:36,phone:'0',surgery:'Synthetic procedure',diagnosis:'Synthetic clinical detail. '.repeat(35),doctor:'Synthetic Doctor',specialist:'Synthetic Specialist',sub_specialty:'Gen ORL',remark:'Synthetic remark',postpone_count:1};
     if(source&&!saved)Object.assign(rows[0],patient,{status:'CONFIRMED',request_status:'SCHEDULED'});
     if(target){
      Object.assign(rows[0],{request_id:'other-request',patient_name:'Synthetic Other Patient',status:'CONFIRMED',request_status:'SCHEDULED',patient_ic:'800101-**-****'});
      if(saved&&!missingTarget)Object.assign(rows[2],patient,{status:user.role==='STAFF'?'RESERVED':'CONFIRMED',request_status:user.role==='STAFF'?'CONFIRMED':'SCHEDULED'});
      if(saved&&wrongSlot){Object.assign(rows[1],patient,{status:'CONFIRMED'});Object.assign(rows[2],{request_id:'wrong-request',patient_name:'Synthetic Wrong Patient'})}
      if(saved&&wrongRequest)Object.assign(rows[2],{request_id:'wrong-request',patient_name:'Synthetic Wrong Patient'});
     }
     return {session_id:'session-'+date,ot_date:date,day_name:'Synthetic',status:'ACTIVE',special_title:'',holiday_name:'',slots:rows};
    });
   };
   window.rpc=async(name,args)=>{
    calls.push({name,args});
    if(name==='orl_move_postponed_checked'){
     writeCount++;if(writeFail)throw Error('Synthetic move failed');if(malformedResult)return 'UPDATED';
     saved=true;if(changeOwnerOnWrite)token='changed-owner';if(changeDateOnWrite)_postponeDates.set(targetId,'2030-02-01');
     return user.role==='STAFF'?'RESERVED':'CONFIRMED';
    }
    if(name==='orl_get_schedule'){
     if(saved&&holdRead)await new Promise(resolve=>window.releaseRead=resolve);
     if(saved&&readFail)throw Error('Synthetic schedule reload failed');
     return rowsFor(args.p_year,args.p_month);
    }
    if(['orl_list_holidays','orl_get_year_month_counts','orl_get_special_ot_days'].includes(name))return [];
    throw Error('Unexpected synthetic RPC '+name);
   };
   window.fixture=async({from='2027-01-10',to='2027-01-13',role='STAFF'}={})=>{
    token='11111111-1111-4111-8111-111111111111';user.role=role;window.sourceDate=from;window.targetDate=to;
    window.saved=false;window.missingTarget=false;window.wrongSlot=false;window.wrongRequest=false;window.writeFail=false;window.readFail=false;window.malformedResult=false;
    window.changeOwnerOnWrite=false;window.changeDateOnWrite=false;window.holdRead=false;window.releaseRead=null;writeCount=0;reloads=0;
    const [year,month]=from.split('-').map(Number);await schedule(year,month);window._postponeDates=new Map([[targetId,to]]);
    window._postponeExpected=rid;window._postponeFrom=sourceId;window._postponePatientIc='900101-**-****';postponeBusy=false;
    $('#modalBody').innerHTML='<form id="postponeForm"><input name="reason" value="Synthetic postpone reason"></form>';$('#modal').hidden=false;
    $('#postponeForm')._postponeMoveOnly=role==='STAFF';calls=[];messages=[];scrolls=[];window.scrollTo(0,0);
   };
  });
  for(const name of ['malaysiaToday','adjacentOtMonth','scheduleMonthFooter','status','canPickSlot','directRequestAllowed','slotCard','collapsedSlot','scheduleCard','toggleOT','schedule','showPostponedPatient','completePostpone'])await page.addScriptTag({content:extract(name)});
  const cases=[
   {from:'2027-01-10',to:'2027-01-13',role:'STAFF',width:1440,height:900,motion:'no-preference'},
   {from:'2027-01-10',to:'2027-02-16',role:'ADMIN',width:1440,height:900,motion:'reduce'},
   {from:'2027-12-10',to:'2028-01-19',role:'STAFF',width:390,height:844,motion:'reduce'},
   {from:'2027-01-13',to:'2027-01-13',role:'ADMIN',width:1440,height:900,motion:'reduce',compacted:true},
   {from:'2027-01-10',to:'2027-01-28',role:'STAFF',width:1440,height:900,motion:'reduce',boundary:true}
  ];
  await mkdir(new URL('../../qa/postpone-navigation/',import.meta.url),{recursive:true});
  for(const [index,scenario]of cases.entries()){
   await page.setViewportSize({width:scenario.width,height:scenario.height});await page.emulateMedia({reducedMotion:scenario.motion});
   await page.evaluate(s=>fixture(s),scenario);await page.evaluate(compacted=>{wrongSlot=!!compacted;changeDateOnWrite=true;return completePostpone(targetId)},scenario.compacted);
   const [year,month]=scenario.to.split('-').map(Number);assert.deepEqual(await page.evaluate(()=>_scheduleYM),{year,month});
   const card=page.locator('#d-'+scenario.to),row=card.locator('[data-request-id="22222222-2222-4222-8222-222222222222"]');
   assert.equal(await card.evaluate(el=>el.classList.contains('open')),true);assert.equal(await row.locator('.patient').innerText(),'Synthetic Moved Patient');
   assert.equal(await page.locator('.request-jump-highlight').count(),1);assert.equal(await row.evaluate(el=>el.classList.contains('request-jump-highlight')),true);
   const scroll=await page.evaluate(()=>scrolls.at(-1));assert.equal(scroll.className,'patient');assert.equal(scroll.request,'22222222-2222-4222-8222-222222222222');
   assert.equal(scroll.options.block,'center');assert.equal(scroll.options.behavior,scenario.motion==='reduce'?'auto':'smooth');
   await page.waitForFunction(({date,boundary})=>{const el=document.querySelector('#d-'+date+' .request-jump-highlight .patient'),b=el?.getBoundingClientRect();return b&&b.top>0&&b.bottom<innerHeight&&b.left>=0&&b.right<=innerWidth&&(boundary||Math.abs((b.top+b.bottom)/2-innerHeight/2)<80)},{date:scenario.to,boundary:scenario.boundary});
   assert.match(await row.innerText(),scenario.role==='STAFF'?/PENDING APPROVAL/:/CONFIRMED/);
   assert.equal(await page.evaluate(()=>writeCount),1);assert.equal(await page.locator('#modal').isHidden(),true);
   assert.match(await page.evaluate(()=>messages[0]),scenario.role==='STAFF'?/reserved for Admin confirmation/:/Patient postponed/);
   if(scenario.from!==scenario.to&&scenario.from.slice(0,7)===scenario.to.slice(0,7))assert.equal(await page.locator('#d-'+scenario.from+' [data-request-id="22222222-2222-4222-8222-222222222222"]').count(),0,'Fresh source no longer shows moved patient');
   if(scenario.compacted)assert.equal(await row.locator('.slot-title').innerText().then(value=>value.includes('Main Slot 2')),true,'Follow the patient after Main compaction changes its slot');
   if(index===0||scenario.width===390)await page.screenshot({path:resolve(fileURLToPath(new URL('../../qa/postpone-navigation/',import.meta.url)),scenario.width===390?'mobile.png':'desktop.png')});
   await page.clock.fastForward(2700);assert.equal(await row.evaluate(el=>el.classList.contains('request-jump-highlight')),false);
  }
  // Failure and malformed save responses leave the current view/form intact.
  for(const mode of ['writeFail','malformedResult']){
   await page.evaluate(()=>fixture());await page.evaluate(mode=>{window[mode]=true;return completePostpone(targetId)},mode);
   assert.deepEqual(await page.evaluate(()=>_scheduleYM),{year:2027,month:1});assert.equal(await page.locator('#modal').isVisible(),true);
   assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='orl_get_schedule').length),0);assert.equal(await page.evaluate(()=>scrolls.length),0);
   assert.equal(await page.locator('.request-jump-highlight').count(),0);assert.match(await page.evaluate(()=>messages.at(-1)),/failed|not confirmed/);
  }
  // The save succeeded, so display problems must explicitly say it is saved.
  for(const mode of ['readFail','missingTarget','wrongRequest','missingDate']){
   await page.evaluate(()=>fixture({to:'2027-02-16'}));
   await page.evaluate(mode=>{if(mode==='missingDate')_postponeDates.clear();else window[mode]=true;return completePostpone(targetId)},mode);
   assert.equal(await page.evaluate(()=>writeCount),1);assert.equal(await page.locator('#modal').isHidden(),true);
   assert.match(await page.evaluate(()=>messages.at(-1)),/Postpone was saved.*Reload.*do not postpone again/);
   assert.equal(await page.locator('.request-jump-highlight').count(),0);assert.equal(await page.evaluate(()=>scrolls.length),0);
  }
  await page.evaluate(()=>fixture());await page.evaluate(()=>{changeOwnerOnWrite=true;return completePostpone(targetId)});
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='orl_get_schedule').length),0);assert.equal(await page.evaluate(()=>scrolls.length),0);
  // Logout or another page navigation during destination loading cannot repaint
  // the replacement page or focus a stale DOM row after that load resolves.
  for(const change of ['owner','page']){
   await page.evaluate(()=>fixture({to:'2027-02-16'}));await page.evaluate(()=>{holdRead=true;window.pendingMove=completePostpone(targetId)});
   await page.waitForFunction(()=>typeof releaseRead==='function');
   await page.evaluate(change=>{if(change==='owner')token='changed-during-read';$('#content').innerHTML='<p id="replacement-page">Replacement page</p>';releaseRead()},change);
   await page.evaluate(()=>pendingMove);assert.equal(await page.locator('#replacement-page').innerText(),'Replacement page');
   assert.equal(await page.locator('.request-jump-highlight').count(),0);assert.equal(await page.evaluate(()=>scrolls.length),0);
  }
 }finally{await browser.close()}
});
