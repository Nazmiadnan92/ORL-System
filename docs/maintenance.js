// Server remains authoritative. This controller never grants access or stores patient data.
(function(root){
 'use strict';
 const exempt=new Set(['orl_login','orl_current_user','orl_logout','orl_complete_required_password_change','orl_maintenance_status','orl_set_maintenance']);
 // Translate only the original built-in notice; preserve every custom Webmaster message.
 const defaultMessage='The system is under maintenance. Please try again shortly.';
 const displayMessage=message=>message==='Sistem sedang diselenggara. Sila cuba semula sebentar lagi.'?defaultMessage:message;
 function valid(s){return s&&typeof s.enabled==='boolean'&&typeof s.message==='string'&&s.message.length<=500&&Number.isSafeInteger(s.revision)&&s.revision>=0&&(s.expected_end===null||Number.isFinite(Date.parse(s.expected_end)))}
 function create({read,user,render,onBlock=()=>{},onResume=()=>{},clock=root}){
  let state=null,inflight=null,lastBlocked=false;
  const blocked=()=>user()?.role!=='WEBMASTER'&&(!state||state.enabled);
  const paint=()=>{const now=blocked();if(now&&!lastBlocked)onBlock();const resume=!now&&lastBlocked;lastBlocked=now;render({state,blocked:now,user:user()});if(resume)onResume()};
  const refresh=()=>{if(inflight)return inflight;inflight=(async()=>{try{const next=await read();if(!valid(next))throw Error('Invalid maintenance status');state=next}catch{state=null}finally{inflight=null;paint()}return state})();return inflight};
  return {blocked,refresh,state:()=>state,paint,
   async before(name){if(exempt.has(name))return;if(!state)await refresh();paint();if(blocked())throw Error(state?'The system is under maintenance. Please try again once maintenance is complete.':'The system status could not be verified. Please check your connection and try again.')},
   async failed(){await refresh()},
   after(name){if(!exempt.has(name)&&blocked())throw Error('The system is under maintenance. No results are displayed.')},
   start(){refresh();clock.setInterval(refresh,30000);clock.addEventListener('focus',refresh)}
  };
 }
 function attach({call,user,token,onBlock,onResume,logout}){
  const icon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>';
  const doc=root.document,overlay=doc.createElement('section');overlay.className='maintenance-screen';overlay.hidden=true;
  overlay.setAttribute('aria-label','ORL system status');
  overlay.innerHTML=`<div class="maintenance-shell">
   <div class="maintenance-brand"><img src="assets/orl-logo.png" alt="" width="44" height="56"><div><strong>ORL OT MANAGEMENT</strong><span>Operating Theatre Portal</span></div><span class="maintenance-brand-caption">ORL CLINIC · EAR, NOSE &amp; THROAT</span></div>
   <div class="maintenance-card">
    <div class="maintenance-detail">
     <span class="maintenance-notice-badge"></span>
     <h1><span class="maintenance-title-main"></span><span class="maintenance-title-accent"></span></h1>
     <p class="maintenance-message" aria-live="polite"></p><p class="maintenance-lead"></p>
     <div class="maintenance-time"><span class="maintenance-clock" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span><div><span class="maintenance-time-label">EXPECTED COMPLETION</span><p class="maintenance-estimate"></p><small>Access is restored by the Webmaster, not automatically.</small></div></div>
     <div class="maintenance-public-actions"><button type="button" class="primary maintenance-retry">Check Status <span aria-hidden="true">↻</span></button><button type="button" class="maintenance-login">Webmaster Sign In</button></div><p class="maintenance-help"></p>
    </div>
    <div class="maintenance-art" aria-hidden="true"><span class="maintenance-art-halo"></span><span class="maintenance-art-plus">+</span><img data-src="assets/maintenance-ent-doctor.png" alt="" width="1232" height="1232" decoding="async"><span class="maintenance-art-caption">EAR · NOSE · THROAT</span></div>
   </div>
   <div class="maintenance-footer"><span>ORL OT Management System</span><span>Status checked automatically every 30 seconds</span></div>
  </div>`;
  const banner=doc.createElement('div');banner.className='maintenance-banner';banner.hidden=true;
  doc.body.append(overlay,banner);let loginRequested=false;
  const controller=create({read:()=>call('orl_maintenance_status',{}),user,onBlock,onResume,
   render({state,blocked,user:actor}){
    const show=blocked&&(!loginRequested||!!actor);
    overlay.hidden=!show;
    if(blocked){doc.querySelector('#app').hidden=true;if(show)doc.querySelector('#login').hidden=true;else doc.querySelector('#login').hidden=false}
    else if(actor)doc.querySelector('#app').hidden=false;
    else doc.querySelector('#login').hidden=false;
    if(show){const art=overlay.querySelector('.maintenance-art img');if(!art.getAttribute('src'))art.src=art.dataset.src}
    overlay.querySelector('.maintenance-title-main').textContent=state?'We will be':'System status';
    overlay.querySelector('.maintenance-title-accent').textContent=state?'back soon.':'unavailable.';
    overlay.querySelector('.maintenance-notice-badge').textContent=state?'TEMPORARY MAINTENANCE':'CHECK CONNECTION';
    overlay.querySelector('.maintenance-lead').textContent=state?'Thank you for your patience.':'Please check your internet connection and try again.';
    overlay.querySelector('.maintenance-message').textContent=state?(displayMessage(state.message)||defaultMessage):'The system status could not be verified. Please check your connection or try again.';
    overlay.querySelector('.maintenance-estimate').textContent=state?.expected_end?new Date(state.expected_end).toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})+' MYT':'To be announced';
    overlay.querySelector('.maintenance-time').hidden=!state;
    overlay.querySelector('.maintenance-login').textContent=actor?'Sign Out':'Webmaster Sign In';
    overlay.querySelector('.maintenance-help').textContent=state?'Admin and Staff access is paused. Only the Webmaster can sign in during maintenance.':'Access is paused until the system status can be verified.';
    banner.hidden=!(state?.enabled&&(!blocked||loginRequested));
    banner.textContent=state?.enabled?'MAINTENANCE ON · Admin/Staff access paused':'';
    banner.title=state?.enabled?displayMessage(state.message):'';
   }});
  overlay.querySelector('.maintenance-retry').onclick=()=>controller.refresh();
  overlay.querySelector('.maintenance-login').onclick=()=>{if(user())logout();else{loginRequested=true;controller.paint();doc.querySelector('#username').focus()}};
  controller.mountSettings=async container=>{
   if(user()?.role!=='WEBMASTER')return;
   const owner=token(),account=user().user_id;
   const current=await controller.refresh();if(!container.isConnected||token()!==owner||user()?.user_id!==account)return;
   const box=doc.createElement('section');box.className='card maintenance-settings';container.append(box);
   box.innerHTML=`<div class="maintenance-settings-head"><div class="maintenance-settings-title"><span class="maintenance-settings-icon">${icon}</span><div><span class="maintenance-eyebrow">WEBMASTER CONTROL</span><h2>Maintenance Mode</h2><p>Manage portal access during maintenance.</p></div></div><span class="maintenance-current" role="status"></span></div><form><div class="maintenance-workspace"><div class="maintenance-editor"><label class="maintenance-switch-row"><span><strong>Enable maintenance</strong><small>Pause Admin and Staff access, including active sessions.</small></span><span class="maintenance-switch"><input name="enabled" type="checkbox" role="switch" aria-label="Enable maintenance"><span class="maintenance-switch-track" aria-hidden="true"></span></span></label><div class="maintenance-field"><label for="maintenance-message-input">Message for users <span class="maintenance-required">*</span></label><textarea id="maintenance-message-input" name="message" maxlength="500" rows="4" required aria-describedby="maintenance-message-hint"></textarea><div class="maintenance-field-hint"><small id="maintenance-message-hint">Shown on the maintenance page. Do not include patient data.</small><span class="maintenance-char-count"></span></div></div><div class="maintenance-field"><label for="maintenance-end-input">Expected completion <span class="maintenance-optional">Optional</span></label><input id="maintenance-end-input" name="end" type="datetime-local" aria-describedby="maintenance-end-hint"><small id="maintenance-end-hint">Malaysia time (MYT). Access is not restored automatically.</small></div></div><div class="maintenance-preview-column"><div class="maintenance-preview-label"><span>NOTICE PREVIEW</span><span>Draft</span></div><div class="maintenance-preview"><span class="maintenance-preview-symbol">${icon}</span><span class="maintenance-kicker">ORL OT MANAGEMENT SYSTEM</span><h3>The system is under maintenance.</h3><p class="maintenance-preview-message"></p><div class="maintenance-preview-time"><span>Expected completion</span><strong></strong></div></div><div class="maintenance-access-note"><strong>What happens next?</strong><ul><li>Admin &amp; Staff: access paused</li><li>Webmaster: access retained</li><li>Every change: recorded in the Audit Log</li></ul></div></div></div><div class="maintenance-save-panel"><div class="maintenance-save-field"><label for="maintenance-password-input">Confirm with your website password</label><input id="maintenance-password-input" name="password" type="password" autocomplete="current-password" placeholder="Webmaster account password" required><small>Not your Supabase database password.</small></div><div class="maintenance-save-action"><button class="primary">Save settings <span aria-hidden="true">→</span></button><small>Changes take effect only after saving.</small></div></div><div class="maintenance-settings-foot"><span class="maintenance-caution">Ask staff to save their work before enabling maintenance.</span><p class="maintenance-feedback" role="status"></p></div></form>`;
   const form=box.querySelector('form'),feedback=box.querySelector('.maintenance-feedback'),button=form.querySelector('button');
   const updateStatus=s=>{box.dataset.enabled=s?.enabled?'true':'false';box.querySelector('.maintenance-current').textContent=s?(s.enabled?'Maintenance active':'System operational'):'Status unavailable'};
   updateStatus(current);
   if(!current){button.disabled=true;return}
   form.elements.enabled.checked=current.enabled;form.elements.message.value=displayMessage(current.message);
   if(current.expected_end)form.elements.end.value=new Date(Date.parse(current.expected_end)+8*3600000).toISOString().slice(0,16);
   const preview=()=>{box.querySelector('.maintenance-preview-message').textContent=form.elements.message.value||'Your maintenance message will appear here.';box.querySelector('.maintenance-char-count').textContent=form.elements.message.value.length+'/500';const end=form.elements.end.value?new Date(form.elements.end.value+':00+08:00'):null;box.querySelector('.maintenance-preview-time strong').textContent=end&&Number.isFinite(end.getTime())?end.toLocaleString('en-MY',{timeZone:'Asia/Kuala_Lumpur',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' MYT':'To be announced'};
   form.elements.message.addEventListener('input',preview);form.elements.end.addEventListener('input',preview);preview();
   let busy=false;
   form.onsubmit=async e=>{e.preventDefault();if(busy)return;
    if(user()?.role!=='WEBMASTER'||user()?.user_id!==account||token()!==owner){feedback.textContent='Your session has changed. Reopen Settings.';return}
    if(!root.confirm(form.elements.enabled.checked?'Enable or update maintenance? Admin and Staff access will be blocked; unsaved work may be lost.':'Disable maintenance and restore Admin/Staff access?'))return;
    busy=true;button.disabled=true;feedback.textContent='Saving…';
    const password=form.elements.password.value;form.elements.password.value='';
    try{
     await call('orl_set_maintenance',{p_session_token:owner,p_password:password,p_enabled:form.elements.enabled.checked,
      p_message:form.elements.message.value.trim(),p_expected_end:form.elements.end.value?new Date(form.elements.end.value+':00+08:00').toISOString():null,p_expected_revision:current.revision});
     if(token()!==owner)return;
     feedback.textContent='Saved. Reopen Settings before making further changes.';
    }catch{feedback.textContent='The change could not be confirmed. Check the status/Audit Log and reopen Settings; do not retry automatically.'}
    finally{const latest=await controller.refresh();if(token()===owner)updateStatus(latest)}
   };
  };
  return controller;
 }
 root.ORLMaintenance={create,attach,valid};
})(window);
