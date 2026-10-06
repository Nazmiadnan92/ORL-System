import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const read=p=>readFile(new URL('../../docs/'+p,import.meta.url),'utf8');
const themes=['OCEAN','TAUPE','RUBY','ROSE','PURPLE'];
const capture=async(page,name)=>{
 if(process.env.ORL_MAINTENANCE_QA){await mkdir(process.env.ORL_MAINTENANCE_QA,{recursive:true});await page.screenshot({path:resolve(process.env.ORL_MAINTENANCE_QA,name+'.png'),fullPage:true})}
};
function contrast(a,b){
 const lum=s=>{const rgb=s.match(/[\d.]+/g).slice(0,3).map(v=>{v=Number(v)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722};
 const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}

test('soft login and maintenance palettes match across all themes, mobile layouts and unavailable status',async()=>{
 const {chromium}=await import(pathToFileURL(resolve(dirname(process.execPath),'..','node_modules','playwright','index.mjs')));
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:1000}}),errors=[],remote=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin==='https://orl-design.invalid'&&['/assets/orl-logo.png','/assets/maintenance-ent-doctor.png'].includes(url.pathname)){
    await route.fulfill({contentType:'image/png',body:await readFile(new URL('../../docs'+url.pathname,import.meta.url))});
   }else{remote.push(url.href);await route.abort()}
  });
  const html=(await read('index.html')).replace(/<script[^]*?<\/script>/g,'').replace(/<link[^>]+>/g,'').replace('<head>','<head><base href="https://orl-design.invalid/">');
  await page.setContent(html);
  for(const css of ['styles.css','schedule.css','mobile.css','logo.css','clinical-features.css','portal.css','maintenance.css'])await page.addStyleTag({content:await read(css)});
  await page.addScriptTag({content:await read('maintenance.js')});
  await page.evaluate(()=>{
   window.actor=null;window.failed=false;window.reads=0;
   window.notice={enabled:false,message:'Kami sedang menambah baik sistem untuk pengalaman yang lebih lancar.',expected_end:null,revision:0};
   window.controller=ORLMaintenance.attach({call:async()=>{reads++;if(failed)throw Error('offline');return {...notice}},user:()=>actor,token:()=>null,onBlock:()=>{},onResume:()=>{},logout:()=>{actor=null}});
   return controller.refresh();
  });
  assert.equal(await page.locator('.maintenance-art img').getAttribute('src'),null,'decorative image is not requested during normal login');
  await page.locator('.login-logo').evaluate(img=>img.decode());
  const originalClinical={OCEAN:'rgb(0, 99, 178)',TAUPE:'rgb(129, 88, 84)',RUBY:'rgb(164, 25, 61)',ROSE:'rgb(106, 123, 162)',PURPLE:'rgb(21, 114, 70)'};
  for(const theme of themes){
   await page.evaluate(t=>{document.body.dataset.theme=t;notice.enabled=false;return controller.refresh()},theme);
   const loginStyle=await page.locator('#signIn').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,fg:getComputedStyle(el).color}));
   assert.ok(contrast(loginStyle.bg,loginStyle.fg)>=4.5,theme+' login button contrast');
   assert.equal(await page.locator('body').evaluate(el=>{const swatch=document.createElement('span');swatch.style.color='var(--navy)';el.append(swatch);const result=getComputedStyle(swatch).color;swatch.remove();return result}),originalClinical[theme],'clinical colours remain unchanged');
   await capture(page,'login-'+theme.toLowerCase());
   await page.evaluate(()=>{notice.enabled=true;return controller.refresh()});
   await page.locator('.maintenance-art img').evaluate(img=>img.decode());
   const colours=await page.evaluate(()=>{
    const css=s=>getComputedStyle(document.querySelector(s));
    return {login:css('#login').backgroundColor,maintenance:css('.maintenance-screen').backgroundColor,button:css('.maintenance-retry').backgroundColor,message:css('.maintenance-message').color,badge:css('.maintenance-notice-badge').color,badgeBg:css('.maintenance-notice-badge').backgroundColor};
   });
   assert.equal(colours.login,colours.maintenance,theme+' shared background');assert.equal(colours.button,loginStyle.bg,theme+' shared accent');
   assert.ok(contrast(colours.message,'rgb(255, 255, 255)')>=4.5,theme+' body contrast');
   assert.ok(contrast(colours.badge,colours.badgeBg)>=4.5,theme+' badge contrast');
   await capture(page,'maintenance-'+theme.toLowerCase());
  }
  await page.evaluate(()=>document.body.dataset.theme='OCEAN');
  for(const viewport of [{width:1366,height:768},{width:820,height:900},{width:390,height:844},{width:320,height:640}]){
   await page.setViewportSize(viewport);
   await page.evaluate(()=>{notice.message='Kami sedang menambah baik sistem untuk pengalaman yang lebih lancar.';notice.expected_end=null;notice.enabled=true;return controller.refresh()});
   await page.locator('.maintenance-screen').evaluate(el=>el.scrollTop=0);
   assert.equal(await page.locator('.maintenance-screen').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'no maintenance overflow at '+viewport.width);
   if(viewport.width===390)await capture(page,'maintenance-mobile');
   const before=await page.evaluate(()=>reads);await page.locator('.maintenance-retry').click();assert.equal(await page.evaluate(()=>reads),before+1);
   await page.evaluate(()=>{notice.message='W'.repeat(500);notice.expected_end='2030-10-06T12:00:00Z';return controller.refresh()});
   assert.equal(await page.locator('.maintenance-screen').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'long notice wraps at '+viewport.width);
   assert.match(await page.locator('.maintenance-estimate').textContent(),/MYT/);
   await page.locator('.maintenance-login').scrollIntoViewIfNeeded();assert.equal(await page.locator('.maintenance-login').isVisible(),true);
   await page.evaluate(()=>{notice.enabled=false;return controller.refresh()});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'login has no overflow');
   if(viewport.width===390)await capture(page,'login-mobile');
  }
  await page.evaluate(()=>{notice.enabled=true;return controller.refresh()});
  await page.locator('.maintenance-login').click();assert.equal(await page.locator('#username').evaluate(el=>el===document.activeElement),true);
  await page.evaluate(()=>{actor={role:'STAFF'};failed=true;return controller.refresh()});
  assert.match(await page.locator('.maintenance-title-accent').textContent(),/belum disahkan/);
  assert.equal(await page.locator('.maintenance-time').isVisible(),false);
  assert.equal(await page.evaluate(()=>controller.before('orl_create_request').then(()=>false,()=>true)),true,'fail-closed protection unchanged');
  assert.deepEqual(errors,[]);assert.deepEqual(remote,[],'local assets only');
 }finally{await browser.close()}
});
