import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {pathToFileURL} from 'node:url';
test('maintenance screen, safe message, Webmaster form, changed login and unavailable status',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});await page.route('**/*',r=>r.abort());
 await page.setContent('<section id="login"><input id="username"></section><section id="app"><div id="settings"></div></section>');
 await page.addStyleTag({content:await readFile(new URL('../../docs/styles.css',import.meta.url),'utf8')});
 await page.addStyleTag({content:await readFile(new URL('../../docs/portal.css',import.meta.url),'utf8')});
 await page.addStyleTag({content:await readFile(new URL('../../docs/maintenance.css',import.meta.url),'utf8')});
 await page.addStyleTag({content:'#settings{max-width:1040px;margin:30px auto;padding:0 20px}'});
 await page.evaluate(()=>document.body.dataset.theme='PURPLE');
 await page.addScriptTag({content:await readFile(new URL('../../docs/maintenance.js',import.meta.url),'utf8')});
 await page.evaluate(()=>{
  window.actor={role:'ADMIN',user_id:'synthetic-admin'};window.session='synthetic-session';window.calls=[];window.blocks=0;window.resumes=0;window.failed=false;
  window.statusData={enabled:false,message:'Maintenance',expected_end:null,revision:0};window.confirm=()=>true;
  window.controller=ORLMaintenance.attach({call:async(name,args)=>{calls.push({name,args});if(failed)throw Error('offline');
   if(name==='orl_set_maintenance'){statusData={enabled:args.p_enabled,message:args.p_message,expected_end:args.p_expected_end,revision:statusData.revision+1}}
   return {...statusData}},user:()=>actor,token:()=>session,onBlock:()=>blocks++,onResume:()=>resumes++,logout:()=>{actor=null}});
 });
 await page.evaluate(()=>controller.refresh());assert.equal(await page.locator('.maintenance-screen').isVisible(),false);
 await page.evaluate(()=>{statusData.enabled=true;statusData.message='<img src=x onerror="window.exposed=true">';return controller.refresh()});
 assert.equal(await page.locator('.maintenance-screen').isVisible(),true);assert.equal(await page.locator('#app').isVisible(),false);
 assert.equal(await page.locator('.maintenance-message img').count(),0);
 assert.equal(await page.evaluate(()=>controller.before('orl_create_request').then(()=>false,()=>true)),true);
 assert.equal(await page.evaluate(()=>controller.before('orl_logout').then(()=>true)),true);
 await page.evaluate(()=>{statusData.message='Kami sedang menjalankan penyelenggaraan berjadual untuk memastikan portal beroperasi dengan lancar. Sila semak semula sebentar lagi.';statusData.expected_end='2030-10-06T12:00:00Z';return controller.refresh()});
 const capture=async name=>{if(process.env.ORL_MAINTENANCE_QA){await mkdir(process.env.ORL_MAINTENANCE_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_MAINTENANCE_QA,name+'.png'),fullPage:true})}};
 await capture('public-desktop');await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.querySelector('.maintenance-screen').scrollWidth<=innerWidth),true);await capture('public-mobile');
 await page.locator('.maintenance-login').scrollIntoViewIfNeeded();assert.equal(await page.locator('.maintenance-login').isVisible(),true);
 await page.setViewportSize({width:1280,height:900});
 await page.evaluate(()=>controller.mountSettings(document.querySelector('#settings')));assert.equal(await page.locator('.maintenance-settings').count(),0);
 await page.evaluate(()=>{actor={role:'WEBMASTER',user_id:'wm'};controller.paint()});
 assert.equal(await page.locator('.maintenance-screen').isVisible(),false);assert.equal(await page.locator('.maintenance-banner').isVisible(),true);
 assert.equal(await page.locator('.maintenance-banner').textContent(),'MAINTENANCE ON · Admin/Staff access paused');
 await page.evaluate(()=>controller.mountSettings(document.querySelector('#settings')));
 await page.locator('[name="message"]').fill('Penyelenggaraan berjadual sedang dijalankan. Terima kasih atas kesabaran anda.');
 assert.equal(await page.locator('.maintenance-preview-message').textContent(),'Penyelenggaraan berjadual sedang dijalankan. Terima kasih atas kesabaran anda.');
 assert.match(await page.locator('.maintenance-char-count').textContent(),/\/500$/);
 await capture('settings-desktop');await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await capture('settings-mobile');
 await page.setViewportSize({width:1280,height:900});
 await page.locator('[name="enabled"]').uncheck();await page.locator('[name="password"]').fill('SyntheticPass1');
 await page.locator('.maintenance-settings button').click();await page.waitForFunction(()=>calls.some(c=>c.name==='orl_set_maintenance'));
 assert.equal(await page.locator('[name="password"]').inputValue(),'');assert.equal(await page.locator('.maintenance-settings button').isDisabled(),true);
 const write=await page.evaluate(()=>calls.find(c=>c.name==='orl_set_maintenance').args);
 assert.equal(write.p_enabled,false);assert.equal(write.p_expected_revision,0);assert.equal(write.p_session_token,'synthetic-session');
 await page.evaluate(()=>{document.querySelector('#settings').replaceChildren();return controller.mountSettings(document.querySelector('#settings'))});
 await page.locator('[name="password"]').fill('SyntheticPass1');await page.evaluate(()=>{session='changed'});
 await page.locator('.maintenance-settings button').click();assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='orl_set_maintenance').length),1);
 await page.evaluate(()=>{actor={role:'STAFF',user_id:'staff'};failed=true;return controller.refresh()});
 assert.equal(await page.locator('.maintenance-screen').isVisible(),true);
 assert.equal(await page.evaluate(()=>controller.before('orl_create_request').then(()=>false,()=>true)),true);
 await page.evaluate(()=>{failed=false;return controller.refresh()});assert.equal(await page.locator('.maintenance-screen').isVisible(),false);
 await page.evaluate(()=>{actor=null;statusData.enabled=true;return controller.refresh()});
 await page.locator('.maintenance-login').click();assert.equal(await page.locator('#login').isVisible(),true);
 assert.equal(await page.locator('.maintenance-screen').isVisible(),false);
 }finally{await browser.close()}
});

test('actual app bootstrap and RPC hooks remove an open Staff form and retain Webmaster Settings access',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage();await page.route('**/*',r=>r.abort());
  const read=p=>readFile(new URL('../../docs/'+p,import.meta.url),'utf8');
  await page.setContent((await read('index.html')).replace(/<script[^]*?<\/script>/g,''));
  await page.evaluate(()=>{
   window.ORL_CONFIG={supabaseUrl:'https://synthetic.invalid',supabaseAnonKey:'synthetic',icProtectionEnabled:false};
   window.maintenanceState={enabled:false,message:'Synthetic maintenance',expected_end:null,revision:0};window.requestNames=[];
   window.fetch=async url=>{const name=String(url).split('/').at(-1);requestNames.push(name);return {ok:true,json:async()=>name==='orl_maintenance_status'?{...maintenanceState}:{}}};
  });
  // about:blank storage is unavailable: supply only a synthetic in-memory session API.
  await page.addScriptTag({content:"Object.defineProperty(window,'sessionStorage',{value:{getItem:()=>null,removeItem:()=>{},setItem:()=>{},clear:()=>{}}});"});
  await page.addScriptTag({content:await read('maintenance.js')});await page.addScriptTag({content:await read('clinical-features.js')});await page.addScriptTag({content:await read('app.js')});
  await page.evaluate(()=>window.orlMaintenance.refresh());
  assert.equal(await page.locator('#login').isVisible(),true);
  await page.evaluate(()=>{user={user_id:'synthetic',role:'STAFF',display_name:'Synthetic'};token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';window.orlMaintenance.paint();go('submit')});
  assert.equal(await page.locator('#requestForm').count(),1);
  await page.evaluate(()=>{maintenanceState.enabled=true;return window.orlMaintenance.refresh()});
  assert.equal(await page.locator('#requestForm').count(),0);
  assert.equal(await page.evaluate(()=>rpc('orl_create_request',{p_data:{}}).then(()=>false,()=>true)),true);
  assert.equal(await page.evaluate(()=>requestNames.includes('orl_create_request')),false);
  await page.evaluate(()=>{user={user_id:'synthetic-wm',role:'WEBMASTER',display_name:'Synthetic'};window.orlMaintenance.paint();go('settings')});
  await page.locator('.maintenance-settings').waitFor();assert.equal(await page.locator('[name="enabled"]').isChecked(),true);
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{user={role:'STAFF'};window.orlMaintenance.paint()});
  assert.equal(await page.locator('.maintenance-screen').isVisible(),true);
 }finally{await browser.close()}
});
