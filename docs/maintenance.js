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
  const icon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
  const doc=root.document,overlay=doc.createElement('section');overlay.className='maintenance-screen';overlay.hidden=true;
  overlay.setAttribute('aria-label','Status sistem ORL');
  overlay.innerHTML=`<div class="maintenance-shell"><div class="maintenance-brand"><span class="maintenance-brand-icon">${icon}</span><div><strong>ORL OT</strong><span>MANAGEMENT SYSTEM</span></div><span class="maintenance-brand-caption">Operating Theatre Portal</span></div><div class="maintenance-card"><div class="maintenance-intro"><span class="maintenance-eyebrow">SYSTEM NOTICE</span><div class="maintenance-illustration" aria-hidden="true"><span class="maintenance-orbit"></span><span class="maintenance-emblem">${icon}</span><span class="maintenance-orbit-dot"></span></div><span class="maintenance-kicker">SEBENTAR SAHAJA</span><h1></h1><p class="maintenance-lead">Ruang kerja klinikal anda akan kembali tersedia selepas penyelenggaraan selesai.</p><div class="maintenance-service"><span></span>ORL Operating Theatre</div></div><div class="maintenance-detail"><span class="maintenance-notice-badge">AKSES DIHENTIKAN SEMENTARA</span><h2>Makluman kepada pengguna</h2><p class="maintenance-message" aria-live="polite"></p><div class="maintenance-time"><span class="maintenance-time-label">ANGGARAN KEMBALI</span><p class="maintenance-estimate"></p><small>Masa ini adalah anggaran. Akses dibuka semula oleh Webmaster.</small></div><div class="maintenance-public-actions"><button type="button" class="primary maintenance-retry">Semak status semula <span aria-hidden="true">↗</span></button><button type="button" class="maintenance-login">Webmaster sign in</button></div><p class="maintenance-help"></p></div></div><div class="maintenance-footer"><span>ORL OT Management System</span><span>Status disemak secara automatik setiap 30 saat</span></div></div>`;
  const banner=doc.createElement('div');banner.className='maintenance-banner';banner.hidden=true;
  doc.body.append(overlay,banner);let loginRequested=false;
  const controller=create({read:()=>call('orl_maintenance_status',{}),user,onBlock,onResume,
   render({state,blocked,user:actor}){
    const show=blocked&&(!loginRequested||!!actor);
    overlay.hidden=!show;
    if(blocked){doc.querySelector('#app').hidden=true;if(show)doc.querySelector('#login').hidden=true;else doc.querySelector('#login').hidden=false}
    else if(actor)doc.querySelector('#app').hidden=false;
    else doc.querySelector('#login').hidden=false;
    overlay.querySelector('h1').textContent=state?'Kami sedang menambah baik sistem.':'Menyemak status sistem.';
    overlay.querySelector('.maintenance-kicker').textContent=state?'PENYELENGGARAAN SISTEM':'SAMBUNGAN SISTEM';
    overlay.querySelector('.maintenance-notice-badge').textContent=state?'AKSES DIHENTIKAN SEMENTARA':'STATUS BELUM DISAHKAN';
    overlay.querySelector('.maintenance-lead').textContent=state?'Terima kasih atas kesabaran anda. Akses akan dibuka semula selepas penyelenggaraan selesai.':'Kami belum dapat mengesahkan status portal. Sila semak sambungan dan cuba semula.';
    overlay.querySelector('.maintenance-message').textContent=state?.message||'Status belum dapat disahkan. Semak sambungan atau cuba semula.';
    overlay.querySelector('.maintenance-estimate').textContent=state?.expected_end?new Date(state.expected_end).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+' MYT':'Akan dimaklumkan';
    overlay.querySelector('.maintenance-login').textContent=actor?'Sign out':'Webmaster sign in';
    overlay.querySelector('.maintenance-help').textContent='Akses Admin dan Staf dijeda sementara. Hanya Webmaster boleh masuk semasa penyelenggaraan.';
    banner.hidden=!(state?.enabled&&(!blocked||loginRequested));
    banner.textContent=state?.enabled?'MAINTENANCE ON · Akses Admin/Staf dijeda':'';
    banner.title=state?.enabled?state.message:'';
   }});
  overlay.querySelector('.maintenance-retry').onclick=()=>controller.refresh();
  overlay.querySelector('.maintenance-login').onclick=()=>{if(user())logout();else{loginRequested=true;controller.paint();doc.querySelector('#username').focus()}};
  controller.mountSettings=async container=>{
   if(user()?.role!=='WEBMASTER')return;
   const owner=token(),account=user().user_id;
   const current=await controller.refresh();if(!container.isConnected||token()!==owner||user()?.user_id!==account)return;
   const box=doc.createElement('section');box.className='card maintenance-settings';container.append(box);
   box.innerHTML=`<div class="maintenance-settings-head"><div class="maintenance-settings-title"><span class="maintenance-settings-icon">${icon}</span><div><span class="maintenance-eyebrow">WEBMASTER CONTROL</span><h2>Maintenance Mode</h2><p>Urus akses portal semasa kerja penyelenggaraan.</p></div></div><span class="maintenance-current" role="status"></span></div><form><div class="maintenance-workspace"><div class="maintenance-editor"><label class="maintenance-switch-row"><span><strong>Aktifkan maintenance</strong><small>Jeda akses Admin dan Staf, termasuk sesi yang sedang aktif.</small></span><span class="maintenance-switch"><input name="enabled" type="checkbox" role="switch" aria-label="Aktifkan maintenance"><span class="maintenance-switch-track" aria-hidden="true"></span></span></label><div class="maintenance-field"><label for="maintenance-message-input">Mesej kepada pengguna <span class="maintenance-required">*</span></label><textarea id="maintenance-message-input" name="message" maxlength="500" rows="4" required aria-describedby="maintenance-message-hint"></textarea><div class="maintenance-field-hint"><small id="maintenance-message-hint">Dipaparkan pada halaman maintenance. Jangan masukkan data pesakit.</small><span class="maintenance-char-count"></span></div></div><div class="maintenance-field"><label for="maintenance-end-input">Anggaran siap <span class="maintenance-optional">Pilihan</span></label><input id="maintenance-end-input" name="end" type="datetime-local" aria-describedby="maintenance-end-hint"><small id="maintenance-end-hint">Waktu Malaysia (MYT). Akses tidak dibuka secara automatik.</small></div></div><div class="maintenance-preview-column"><div class="maintenance-preview-label"><span>PRATONTON NOTIS</span><span>Draf</span></div><div class="maintenance-preview"><span class="maintenance-preview-symbol">${icon}</span><span class="maintenance-kicker">ORL OT MANAGEMENT SYSTEM</span><h3>Sistem sedang diselenggara.</h3><p class="maintenance-preview-message"></p><div class="maintenance-preview-time"><span>Anggaran siap</span><strong></strong></div></div><div class="maintenance-access-note"><strong>Apa yang akan berlaku?</strong><ul><li>Admin &amp; Staf: akses dijeda</li><li>Webmaster: akses dikekalkan</li><li>Setiap perubahan: direkod dalam Audit Log</li></ul></div></div></div><div class="maintenance-save-panel"><div class="maintenance-save-field"><label for="maintenance-password-input">Sahkan dengan password website</label><input id="maintenance-password-input" name="password" type="password" autocomplete="current-password" placeholder="Password akaun Webmaster" required><small>Bukan password database Supabase.</small></div><div class="maintenance-save-action"><button class="primary">Simpan tetapan <span aria-hidden="true">→</span></button><small>Perubahan hanya berkuat kuasa selepas disimpan.</small></div></div><div class="maintenance-settings-foot"><span class="maintenance-caution">Maklumkan staf supaya menyimpan kerja sebelum menghidupkan maintenance.</span><p class="maintenance-feedback" role="status"></p></div></form>`;
   const form=box.querySelector('form'),feedback=box.querySelector('.maintenance-feedback'),button=form.querySelector('button');
   const updateStatus=s=>{box.dataset.enabled=s?.enabled?'true':'false';box.querySelector('.maintenance-current').textContent=s?(s.enabled?'Maintenance aktif':'Sistem beroperasi'):'Status tidak tersedia'};
   updateStatus(current);
   if(!current){button.disabled=true;return}
   form.elements.enabled.checked=current.enabled;form.elements.message.value=current.message;
   if(current.expected_end)form.elements.end.value=new Date(Date.parse(current.expected_end)+8*3600000).toISOString().slice(0,16);
   const preview=()=>{box.querySelector('.maintenance-preview-message').textContent=form.elements.message.value||'Mesej maintenance anda akan dipaparkan di sini.';box.querySelector('.maintenance-char-count').textContent=form.elements.message.value.length+'/500';const end=form.elements.end.value?new Date(form.elements.end.value+':00+08:00'):null;box.querySelector('.maintenance-preview-time strong').textContent=end&&Number.isFinite(end.getTime())?end.toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' MYT':'Akan dimaklumkan'};
   form.elements.message.addEventListener('input',preview);form.elements.end.addEventListener('input',preview);preview();
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
    finally{const latest=await controller.refresh();if(token()===owner)updateStatus(latest)}
   };
  };
  return controller;
 }
 root.ORLMaintenance={create,attach,valid};
})(window);
