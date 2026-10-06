// Server remains authoritative. This controller never grants access or stores patient data.
(function(root){
 'use strict';
 const exempt=new Set(['orl_login','orl_current_user','orl_logout','orl_complete_required_password_change','orl_maintenance_status','orl_set_maintenance']);
 function valid(s){return s&&typeof s.enabled==='boolean'&&typeof s.message==='string'&&s.message.length<=500&&Number.isSafeInteger(s.revision)&&s.revision>=0&&(s.expected_end===null||Number.isFinite(Date.parse(s.expected_end)))}
 function create({read,user,render,onBlock=()=>{},onResume=()=>{},clock=root}){
  let state=null,inflight=null,lastBlocked=false;
  const blocked=()=>user()?.role!=='WEBMASTER'&&(!state||state.enabled);
  const paint=()=>{const now=blocked();if(now&&!lastBlocked)onBlock();const resume=!now&&lastBlocked;lastBlocked=now;render({state,blocked:now,user:user()});if(resume)onResume()};
  const refresh=()=>{if(inflight)return inflight;inflight=(async()=>{try{const next=await read();if(!valid(next))throw Error('Invalid maintenance status');state=next}catch{state=null}finally{inflight=null;paint()}return state})();return inflight};
  return {blocked,refresh,state:()=>state,paint,
   async before(name){if(exempt.has(name))return;if(!state)await refresh();paint();if(blocked())throw Error(state?'Sistem sedang diselenggara. Sila cuba semula selepas maintenance.':'Status sistem tidak dapat disahkan. Sila semak sambungan dan cuba semula.')},
   async failed(){await refresh()},
   after(name){if(!exempt.has(name)&&blocked())throw Error('Sistem sedang diselenggara. Tiada hasil dipaparkan.')},
   start(){refresh();clock.setInterval(refresh,30000);clock.addEventListener('focus',refresh)}
  };
 }
 function attach({call,user,token,onBlock,onResume,logout}){
  const doc=root.document,overlay=doc.createElement('section');overlay.className='maintenance-screen';overlay.hidden=true;
  overlay.innerHTML='<div class="maintenance-card"><h1></h1><p class="maintenance-message"></p><p class="maintenance-estimate"></p><button type="button" class="primary maintenance-retry">Semak semula</button> <button type="button" class="maintenance-login">Webmaster sign in</button><p class="maintenance-help"></p></div>';
  const banner=doc.createElement('div');banner.className='maintenance-banner';banner.hidden=true;
  doc.body.append(overlay,banner);let loginRequested=false;
  const controller=create({read:()=>call('orl_maintenance_status',{}),user,onBlock,onResume,
   render({state,blocked,user:actor}){
    const show=blocked&&(!loginRequested||!!actor);
    overlay.hidden=!show;
    if(blocked){doc.querySelector('#app').hidden=true;if(show)doc.querySelector('#login').hidden=true;else doc.querySelector('#login').hidden=false}
    else if(actor)doc.querySelector('#app').hidden=false;
    else doc.querySelector('#login').hidden=false;
    overlay.querySelector('h1').textContent=state?'Sistem sedang diselenggara':'Menyemak status sistem';
    overlay.querySelector('.maintenance-message').textContent=state?.message||'Status belum dapat disahkan. Semak sambungan atau cuba semula.';
    overlay.querySelector('.maintenance-estimate').textContent=state?.expected_end?'Anggaran siap: '+new Date(state.expected_end).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur'})+' MYT (anggaran sahaja)':'';
    overlay.querySelector('.maintenance-login').textContent=actor?'Sign out':'Webmaster sign in';
    overlay.querySelector('.maintenance-help').textContent='Admin dan Staf tidak boleh menggunakan sistem sehingga Webmaster membuka semula akses.';
    banner.hidden=!(state?.enabled&&(!blocked||loginRequested));
    banner.textContent=state?.enabled?'MAINTENANCE ON — '+state.message:'';
   }});
  overlay.querySelector('.maintenance-retry').onclick=()=>controller.refresh();
  overlay.querySelector('.maintenance-login').onclick=()=>{if(user())logout();else{loginRequested=true;controller.paint();doc.querySelector('#username').focus()}};
  controller.mountSettings=async container=>{
   if(user()?.role!=='WEBMASTER')return;
   const owner=token(),account=user().user_id;
   const current=await controller.refresh();if(!container.isConnected||token()!==owner||user()?.user_id!==account)return;
   const box=doc.createElement('section');box.className='card maintenance-settings';container.append(box);
   box.innerHTML='<h2>Maintenance Mode · Webmaster</h2><p class="maintenance-current"></p><p>Admin/Staf akan disekat, termasuk sesi yang sudah login. Maklumkan staf supaya simpan kerja dahulu. Webmaster masih boleh masuk. ON/OFF direkodkan dalam Audit Log.</p><form><label><input name="enabled" type="checkbox"> Maintenance ON</label><label>Mesej kepada pengguna (jangan masukkan data pesakit)<textarea name="message" maxlength="500" required></textarea></label><label>Anggaran siap — waktu Malaysia (pilihan)<input name="end" type="datetime-local"></label><small>Anggaran sahaja; Webmaster mesti OFF sendiri untuk membuka semula akses.</small><label>Password website Webmaster<input name="password" type="password" autocomplete="current-password" required></label><button class="primary">Save Maintenance Settings</button><p class="maintenance-feedback" role="status"></p></form>';
   const form=box.querySelector('form'),feedback=box.querySelector('.maintenance-feedback'),button=form.querySelector('button');
   box.querySelector('.maintenance-current').textContent=current?'Status: '+(current.enabled?'ON':'OFF'):'Status tidak tersedia. Muat semula Settings.';
   if(!current){button.disabled=true;return}
   form.elements.enabled.checked=current.enabled;form.elements.message.value=current.message;
   if(current.expected_end)form.elements.end.value=new Date(Date.parse(current.expected_end)+8*3600000).toISOString().slice(0,16);
   let busy=false;
   form.onsubmit=async e=>{e.preventDefault();if(busy)return;
    if(user()?.role!=='WEBMASTER'||user()?.user_id!==account||token()!==owner){feedback.textContent='Sesi berubah. Buka semula Settings.';return}
    if(!root.confirm(form.elements.enabled.checked?'Hidupkan/kemas kini maintenance? Admin dan Staf akan disekat; kerja yang belum disimpan mungkin hilang.':'Matikan maintenance dan buka semula akses Admin/Staf?'))return;
    busy=true;button.disabled=true;feedback.textContent='Saving…';
    const password=form.elements.password.value;form.elements.password.value='';
    try{
     await call('orl_set_maintenance',{p_session_token:owner,p_password:password,p_enabled:form.elements.enabled.checked,
      p_message:form.elements.message.value.trim(),p_expected_end:form.elements.end.value?new Date(form.elements.end.value+':00+08:00').toISOString():null,p_expected_revision:current.revision});
     if(token()!==owner)return;
     feedback.textContent='Saved. Buka semula Settings sebelum membuat perubahan seterusnya.';
    }catch{feedback.textContent='Perubahan belum disahkan. Semak status/Audit Log dan buka semula Settings; jangan ulang secara automatik.'}
    finally{await controller.refresh()}
   };
  };
  return controller;
 }
 root.ORLMaintenance={create,attach,valid};
})(window);
