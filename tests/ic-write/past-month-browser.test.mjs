import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';

test('month cards follow Malaysia month/year, keep current month green, preserve historical navigation and refresh across midnight',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:700},timezoneId:'America/Los_Angeles'});
  await page.clock.install({time:new Date('2026-10-08T03:00:00Z')});await page.route('**/*',r=>r.abort());
  await page.setContent('<main><div id="content"></div></main>');
  for(const file of ['styles.css','schedule.css','mobile.css'])await page.addStyleTag({content:await readFile(new URL('../../docs/'+file,import.meta.url),'utf8')});
  await page.evaluate(()=>{
   window.$=s=>document.querySelector(s);window.$$=s=>[...document.querySelectorAll(s)];
   window.currentPage='schedule';window.user={role:'STAFF'};window.token='synthetic-session';
   window.months=['January','February','March','April','May','June','July','August','September','October','November','December'];
   window.esc=s=>String(s??'');window.head=()=>'<h2>OT Schedule</h2>';window.savedScheduleView=()=>null;
   window.rememberScheduleView=(year,month)=>{window._scheduleYM={year,month}};
   window.scheduleYearBoxes=()=>'';window.scheduleMonthFooter=()=>'';window.renderSpecialDays=()=>'';
   window.captureScheduleState=()=>({});window.restoreScheduleState=()=>{};window.toast=message=>{throw Error(message)};
   window.counts=months.map((_,index)=>({month:index+1,main_available:index===9||index===10?0:index===11?null:70,special_available:4}));
   window.calls=[];window.rpc=async(name,args)=>{calls.push({name,args});return name==='orl_get_year_month_counts'?structuredClone(counts):[]};
  });
  await page.addScriptTag({content:await readFile(new URL('../../docs/booking-workflow.js',import.meta.url),'utf8')});
  const app=await readFile(new URL('../../docs/app.js',import.meta.url),'utf8');
  const extract=name=>{let start=app.lastIndexOf('function '+name+'(');assert.ok(start>=0);if(app.slice(start-6,start)==='async ')start-=6;const rest=app.slice(start),end=rest.search(/\n(?:async )?function /);return end<0?rest:rest.slice(0,end)};
  for(const name of ['malaysiaToday','monthAvailability','scheduleMonthTabs','schedule','reloadSchedule'])await page.addScriptTag({content:extract(name)});
  const month=key=>page.locator(`[data-ot-month="${key}"]`);
  const color=locator=>locator.evaluate(el=>getComputedStyle(el).backgroundColor);
  await page.evaluate(()=>schedule(2026,10));
  assert.equal(await page.locator('.month-tab.past').count(),9);
  assert.equal(await color(month('2026-09')),'rgb(241, 243, 245)');
  assert.match(await month('2026-09').innerText(),/^September\s+PAST$/);
  assert.doesNotMatch(await month('2026-09').ariaSnapshot(),/Available|Special/);
  assert.equal(await color(month('2026-10')),'rgb(220, 252, 231)');
  assert.match(await month('2026-10').innerText(),/Main: 0 Available/);
  assert.doesNotMatch(await month('2026-10').innerText(),/PAST|Special/);
  assert.equal(await color(month('2026-11')),'rgb(254, 226, 226)');
  assert.match(await month('2026-12').innerText(),/Availability unavailable/);
  for(const role of ['ADMIN','WEBMASTER']){
   await page.evaluate(role=>{user.role=role;return schedule(2026,10)},role);
   assert.doesNotMatch(await month('2026-09').innerText(),/Main:|Special:/);
   assert.match(await month('2026-10').innerText(),/Special: 4 Available/);
  }
  await month('2026-09').click();await page.waitForFunction(()=>window._scheduleYM.month===9&&document.querySelector('[data-ot-month="2026-09"].active'));
  assert.equal(await month('2026-09').isEnabled(),true);
  assert.notEqual(await month('2026-09').evaluate(el=>getComputedStyle(el).boxShadow),'none');
  assert.ok(await page.evaluate(()=>calls.some(x=>x.name==='orl_get_schedule'&&x.args.p_year===2026&&x.args.p_month===9)));
  await page.evaluate(()=>{counts[10].main_available=8;return reloadSchedule()});
  assert.equal(await color(month('2026-11')),'rgb(220, 252, 231)');
  assert.equal(await page.locator('.month-tab.past.active').count(),1);
  if(process.env.ORL_MONTH_QA){await mkdir(process.env.ORL_MONTH_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_MONTH_QA,'past-months-desktop.png'),fullPage:true})}
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.ORL_MONTH_QA)await page.screenshot({path:resolve(process.env.ORL_MONTH_QA,'past-months-mobile.png'),fullPage:true});
  await page.evaluate(()=>schedule(2025,12));assert.equal(await page.locator('.month-tab.past').count(),12);
  await page.evaluate(()=>schedule(2027,1));assert.equal(await page.locator('.month-tab.past,.month-tab.current-month').count(),0);
  assert.match(await month('2027-01').innerText(),/Main: 70 Available/);
  // The browser is still on October 31 in Los Angeles when Malaysia changes to November.
  await page.clock.setSystemTime(new Date('2026-10-31T15:59:50Z'));await page.evaluate(()=>{counts[10].main_available=0;return schedule(2026,10)});
  await month('2026-10').focus();
  const before=await page.evaluate(()=>JSON.stringify({counts,_schedule}));
  await page.evaluate(()=>document.dispatchEvent(new Event('DOMContentLoaded')));await page.clock.runFor(31000);
  assert.equal(await page.locator('.month-tab.past').count(),10);
  assert.match(await month('2026-10').innerText(),/^October\s+PAST$/);
  assert.equal(await color(month('2026-11')),'rgb(220, 252, 231)');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.otMonth),'2026-10');
  assert.equal(await page.locator('.month-tab.past.active').count(),1);
  assert.equal(await page.evaluate(()=>JSON.stringify({counts,_schedule})),before,'Clock refresh never mutates server counts or historical records');
  // Returning to an already-open tab also handles a Malaysia year rollover.
  await page.clock.setSystemTime(new Date('2026-12-31T15:59:59Z'));await page.evaluate(()=>schedule(2026,12));
  assert.equal(await page.locator('.month-tab.current-month').count(),1);
  await page.clock.setSystemTime(new Date('2026-12-31T16:00:00Z'));await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.locator('.month-tab.past').count(),12);
  assert.equal(await page.locator('.month-tab.current-month').count(),0);
  await page.evaluate(()=>{counts[0].main_available=0;return schedule(2027,1)});
  assert.equal(await page.locator('.month-tab.past').count(),0);
  assert.equal(await color(month('2027-01')),'rgb(220, 252, 231)');
 }finally{await browser.close()}
});
