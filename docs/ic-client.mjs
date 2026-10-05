// C1 browser client. No keys or direct private-table access.
// Loaded only by the explicit icProtectionEnabled configuration gate.
export function createIcTransport({ baseUrl, publishableKey, session, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('Invalid backend URL.');
  const endpoint = new URL('/functions/v1/ic-requests', base);
  return async (operation, payload) => {
    if (!['OT_EXPORT','SEARCH','REVEAL','UNSCHEDULED_COUNT','REPAIR_VIEW','REPAIR','CONTROL_VIEW','CONTROL','CREATE', 'PREPARE_CREATE', 'RESOLVE_CREATE', 'CONFIRM', 'ASSIGN', 'REVIEW', 'CLEAR', 'DELETE_REQUEST', 'DELETE_RESOLVE', 'EDIT', 'MOVE', 'REASSIGN', 'REMOVE', 'BACKUP_EXPORT', 'BACKUP_RESTORE', 'BACKUP_CONVERT'].includes(operation)) throw new Error('Unsupported protected operation.');
    const token = session();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) throw new Error('Please sign in again.');
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', apikey: publishableKey, 'x-orl-session': token },
        body: JSON.stringify({ ...payload, operation }), signal: AbortSignal.timeout(30000) });
    } catch { throw new Error('Result not confirmed. Check the saved records before retrying.'); }
    let data;
    try { data = await response.json(); } catch { throw new Error('Result not confirmed. Check the saved records before retrying.'); }
    if (!response.ok) throw new Error(data?.error || 'Protected operation unavailable.');
    return data;
  };
}

export function identityEditPayload({ canEdit, replace, value, data }) {
  const clean = { ...data }; delete clean.patient_ic;
  if (!canEdit || !replace) return { ic_mode: 'KEEP', data: clean };
  if (typeof value !== 'string' || /[*•]/.test(value)) throw new Error('Enter the full replacement IC, not a masked value.');
  return { ic_mode: 'SET', data: { ...clean, patient_ic: value } };
}

// Optional checkbox explicitly distinguishes unchanged IC from intentional clearing.
export function bindProtectedIcField(form, { canEdit, masked = '', document: doc = document, onModeChange = () => {} }) {
  const input = form.elements.patient_ic;
  if (!input) throw new Error('IC field is missing.');
  input.value = ''; input.disabled = true; input.required = false;
  input.placeholder = masked || 'No IC recorded'; input.autocomplete = 'off';
  const label = doc.createElement('label'), toggle = doc.createElement('input');
  toggle.type = 'checkbox'; toggle.disabled = !canEdit;
  label.append(toggle, doc.createTextNode(' Replace IC / Passport (leave unticked to keep current IC)'));
  input.parentElement.after(label);
  const refresh = () => {
    input.disabled = !canEdit || !toggle.checked;
    if (input.disabled) input.value = '';
    onModeChange(!input.disabled);
  };
  toggle.addEventListener('change', refresh);
  const collect = data => identityEditPayload({ canEdit, replace: toggle.checked, value: input.value, data });
  // Carry an explicit replacement across Edit -> Postpone in memory only.
  collect.restore = choice => {
    const safe = identityEditPayload({ canEdit, replace: choice.ic_mode === 'SET',
      value: choice.data?.patient_ic, data: {} });
    toggle.checked = safe.ic_mode === 'SET';
    input.value = safe.data.patient_ic || '';
    refresh();
  };
  return collect;
}

export function previewBackupVersion(backup) {
  if (!backup || backup.format !== 'ORLOMS_BACKUP' || ![1, 2, 3].includes(backup.version)) throw new Error('Unsupported backup.');
  if (backup.version === 1) return { canRestore: false, message: 'Legacy backup: protected recovery conversion is required. Keep this file.' };
  if (!['ORL_IC_SHADOW_V1','ORL_IC_ENCRYPTED_V1'].includes(backup.identity_format) || !Array.isArray(backup.identities)) throw new Error('Incomplete protected backup.');
  if(backup.version===3&&backup.plaintext_removed!==true)throw new Error('Incomplete C6 backup.');
  if (backup.creation_receipt_format !== 'ORL_CREATE_RECEIPTS_V1' || !Array.isArray(backup.creation_receipts))
    throw new Error('Backup needs creation-recovery conversion. Keep this file.');
  for (const section of ['requests', 'users', 'settings', 'holidays', 'ot_sessions', 'ot_slots', 'audit_log'])
    if (!Array.isArray(backup[section])) throw new Error('Incomplete protected backup.');
  return { canRestore: true, message: 'File opened. The server must verify encrypted identities before Restore.',
    requests: backup.requests.length, identities: backup.identities.length };
}


const protectedRpcs = new Set(['orl_create_request', 'orl_edit_scheduled_request_checked',
  'orl_move_postponed_checked', 'orl_db_remove_patient', 'orl_db_export', 'orl_db_import', 'orl_ic_convert_legacy_backup']);
const generationReads = new Set(['orl_get_schedule', 'orl_get_requests', 'orl_get_deletions', 'orl_db_find_patient', 'orl_db_cancelled', 'orl_db_duplicates']);
const generationUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function tagReadGeneration(value,generation,reviewOwner){
  if(Array.isArray(value))return value.map(x=>tagReadGeneration(x,generation,reviewOwner));
  if(value&&typeof value==='object')return {...Object.fromEntries(Object.entries(value).map(([k,v])=>[k,tagReadGeneration(v,generation,reviewOwner)])),_ic_generation:generation,...(reviewOwner?{_ic_review_owner:reviewOwner}:{})};
  return value;
}

// Storage holds a random reference only: never IC, clinical fields, keys or session tokens.
// Caller supplies an origin-wide Web Lock so separate tabs cannot start two pending saves.
export function createPendingCreation({ storage, key, send, withLock, session = () => null, newId = () => crypto.randomUUID() }) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const pending = () => {
    const value = storage.getItem(key);
    if (value !== null && !uuid.test(value)) throw new Error('Saved reference is unreadable. Contact Webmaster; do not resubmit.');
    return value;
  };
  let confirmation=null,assignment=null;
  const sameSession=owner=>{if(session()!==owner)throw new Error('Please sign in again and check the previous save.');};
  const clear = id => { if (pending() === id) storage.removeItem(key); if(confirmation?.id===id)confirmation=null; if(assignment?.id===id)assignment=null; };
  return {
    pending,
    async create(data) {
      return withLock(async () => {
        const owner=session();confirmation=null;assignment=null;
        if (pending()) throw new Error('A previous save needs checking. Use Check Previous Save before submitting again.');
        const id = newId();
        if (!uuid.test(id)) throw new Error('Unable to prepare a save reference.');
        storage.setItem(key, id);
        if (pending() !== id) throw new Error('Unable to retain a save reference. Nothing was submitted.');
        const prepared=await send('PREPARE_CREATE',{});
        if(typeof prepared?.generation!=='string'||!uuid.test(prepared.generation))
          throw new Error('Unable to prepare save. Use Check Previous Save.');
        sameSession(owner);
        const response = await send('CREATE', { request_id: id, generation: prepared.generation, data });
        sameSession(owner);
        if (response?.request_id !== id) throw new Error('Save not confirmed. Use Check Previous Save.');
        // Retain the reference through both CONFIRM and ASSIGN, including lost responses.
        confirmation={id,generation:prepared.generation,owner};
        return id;
      });
    },
    async resolve() {
      return withLock(async () => {
        const owner=session();confirmation=null;assignment=null;
        const id = pending();
        if (!id) return null;
        // Capture before the recovery read, never when the user later confirms.
        const prepared=await send('PREPARE_CREATE',{});
        if(!generationUuid(prepared?.generation))throw new Error('Unable to check previous save safely.');
        sameSession(owner);
        const result = await send('RESOLVE_CREATE', { request_id: id });
        sameSession(owner);
        if (result?.request_id !== id || !['CREATED','CANCELLED','UNAVAILABLE'].includes(result.outcome))
          throw new Error('Save status could not be verified. Do not resubmit.');
        if (result.outcome === 'CREATED' && (typeof result.status !== 'string' || typeof result.assigned !== 'boolean'))
          throw new Error('Saved state could not be verified.');
        if (result.outcome === 'CANCELLED') clear(id);
        if(result.outcome==='CREATED'&&result.status==='DRAFT'&&!result.assigned)
          confirmation={id,generation:prepared.generation,owner};
        if(result.outcome==='CREATED'&&['CONFIRMED','APPROVED'].includes(result.status)&&!result.assigned)
          assignment={id,generation:prepared.generation,owner};
        return {...result,generation:prepared.generation};
      });
    },
    async confirm(id,expectedGeneration) {
      return withLock(async()=>{
        const selected=confirmation;
        if(!selected||selected.id!==id||pending()!==id
          || (expectedGeneration!==undefined&&expectedGeneration!==selected.generation))
          throw new Error('Use Check Previous Save before confirming.');
        sameSession(selected.owner);
        confirmation=null; // An uncertain response requires an explicit new check.
        const response=await send('CONFIRM',{request_id:id,generation:selected.generation});
        sameSession(selected.owner);
        if(!['CONFIRMED','APPROVED'].includes(response?.result))throw new Error('Confirmation not confirmed. Use Check Previous Save.');
        assignment=selected;
        return response.result;
      });
    },
    async assign(id,slotId,slotGeneration) {
      return withLock(async()=>{
        const selected=assignment;
        if(!selected||selected.id!==id||pending()!==id)
          throw new Error('Use Check Previous Save before assigning a slot.');
        sameSession(selected.owner);
        if(!generationUuid(slotId)||!generationUuid(slotGeneration)||slotGeneration!==selected.generation)
          throw new Error('The selected view has changed. Use Check Previous Save and reload the schedule.');
        assignment=null;
        const response=await send('ASSIGN',{request_id:id,slot_id:slotId,
          generation:selected.generation,slot_generation:slotGeneration});
        sameSession(selected.owner);
        if(!['CONFIRMED','RESERVED'].includes(response?.result))
          throw new Error('Assignment not confirmed. Use Check Previous Save.');
        clear(id);
        return response.result;
      });
    },
    async acknowledge(id) { return withLock(async () => clear(id)); },
  };
}

// Preserve the existing application's return shapes without ever falling back on error.
export function createIcRpcRouter({ send, legacy, session, creation }) {
  const controlActions={orl_set_session:null,orl_set_slot_closed:'SLOT_CLOSED',orl_save_holiday:'HOLIDAY_SAVE',
    orl_delete_holiday:'HOLIDAY_DELETE',orl_generate_public_holidays:'HOLIDAY_GENERATE',orl_clear_all_holidays:'HOLIDAY_CLEAR',orl_save_settings:'SETTINGS'};
  const issued=new WeakSet(),used=new WeakSet();
  return async (name, args = {}) => {
    if(name==='orl_find_patient_search'){
      const owner=session();if(!owner||args.p_session_token!==owner)throw Error('Please sign in again.');
      const response=await send('SEARCH',{search:args.p_search});
      if(session()!==owner||!Array.isArray(response?.result))throw Error('Patient search result not confirmed.');
      return response.result;
    }
    if(name==='orl_ic_ot_export'){
      const owner=session();
      if(!owner||args.p_session_token!==owner)throw Error('Please sign in again.');
      if(!generationUuid(args.p_session_id)||!generationUuid(args.p_generation)
        ||typeof args.p_password!=='string'||!args.p_password||args.p_password.length>1024)
        throw Error('Reload the schedule and reopen Generate OT List.');
      const response=await send('OT_EXPORT',{password:args.p_password,session_id:args.p_session_id,generation:args.p_generation});
      const result=response?.result;
      if(session()!==owner||result?.session?.session_id!==args.p_session_id||result?.generation!==args.p_generation
        ||!generationUuid(result?.export_id)||!Array.isArray(result?.patients)||!result.patients.length||result.patients.length>200
        ||!Number.isFinite(Date.parse(result?.expires_at))||Date.parse(result.expires_at)<=Date.now()
        ||!/^\d{4}-\d{2}-\d{2}$/.test(result.session.ot_date||'')
        ||result.patients.some(p=>!generationUuid(p?.request_id)||typeof p.patient_ic!=='string')
        ||new Set(result.patients.map(p=>p.request_id)).size!==result.patients.length)
        throw Error('OT export result not confirmed. Check Audit Log before trying again.');
      return result;
    }
    if(name==='orl_ic_reveal'){
      const owner=session();
      if(!owner||args.p_session_token!==owner)throw Error('Please sign in again.');
      if(!generationUuid(args.p_request_id)||!generationUuid(args.p_generation)
        ||typeof args.p_password!=='string'||!args.p_password||args.p_password.length>1024
        ||!['CLINICAL_VERIFICATION','PATIENT_IDENTIFICATION','DATA_CORRECTION'].includes(args.p_purpose))
        throw Error('Reopen Reveal IC and complete every field.');
      const response=await send('REVEAL',{password:args.p_password,request_id:args.p_request_id,
        purpose:args.p_purpose,generation:args.p_generation});
      if(session()!==owner||response?.result?.request_id!==args.p_request_id
        ||typeof response.result.patient_ic!=='string'||!response.result.patient_ic
        ||!Number.isFinite(Date.parse(response.result.expires_at)))throw Error('Reveal result not confirmed.');
      return response.result;
    }
    if(name==='orl_db_health'){
      const owner=session();if(!owner||args.p_session_token!==owner)throw Error('Please sign in again.');
      const prepared=await send('PREPARE_CREATE',{});
      if(!generationUuid(prepared?.generation))throw Error('Unable to prepare Database Repair view.');
      const result=await send('REPAIR_VIEW',{generation:prepared.generation});
      if(session()!==owner||result?.generation!==prepared.generation||!result.health)throw Error('Reload Database Repair.');
      const health=result.health;Object.defineProperty(health,'_ic_repair',{value:Object.freeze({owner,generation:result.generation,revision:result.revision}),enumerable:false});
      return health;
    }
    if(name==='orl_db_repair'){
      const owner=session(),context=args.p_repair;
      if(!owner||args.p_session_token!==owner||!context||context.owner!==owner||!generationUuid(context.generation)
        ||!/^[a-f0-9]{32}$/.test(context.revision||''))throw Error('Reload Database Repair and review again.');
      const response=await send('REPAIR',{password:args.p_password,generation:context.generation,revision:context.revision});
      if(session()!==owner||response?.result?.status!=='COMPLETED')throw Error('Repair result not confirmed. Reload and inspect.');
      return response.result;
    }
    if(['orl_ic_control_view','orl_list_holidays','orl_get_settings'].includes(name)){
      const owner=session();if(!owner||args.p_session_token!==owner)throw Error('Please sign in again.');
      const scope=name==='orl_list_holidays'?'HOLIDAYS':name==='orl_get_settings'?'SETTINGS':args.p_scope;
      const result=await send('CONTROL_VIEW',{scope,id:args.p_id??null,generation:args.p_generation??null});
      if(session()!==owner||!generationUuid(result?.generation)||! /^[a-f0-9]{32}$/.test(result?.revision||''))throw Error('Reload controls.');
      const context=Object.freeze({owner,scope,id:args.p_id??null,generation:result.generation,revision:result.revision});issued.add(context);
      if(name==='orl_ic_control_view')return {data:result.data,context};
      const value=scope==='HOLIDAYS'?result.data?.rows:result.data;
      if(!value||typeof value!=='object'||(scope==='HOLIDAYS'&&!Array.isArray(value)))throw Error('Invalid control view.');
      Object.defineProperty(value,'_ic_control',{value:context,enumerable:false});return value;
    }
    if(Object.hasOwn(controlActions,name)){
      const c=args.p_control,owner=session();
      if(!c||!issued.has(c)||used.has(c)||c.owner!==owner||args.p_session_token!==owner)throw Error('Reload controls and review again.');
      const action=name==='orl_set_session'?(args.p_status===null?'SESSION_TITLE':'SESSION_STATUS'):controlActions[name];
      const id=args.p_session_id??args.p_slot_id??args.p_id??null;
      const scope=action.startsWith('SESSION')?'SESSION':action==='SLOT_CLOSED'?'SLOT':action==='SETTINGS'?'SETTINGS':'HOLIDAYS';
      if(c.scope!==scope||(['SESSION','SLOT'].includes(scope)&&c.id!==id))throw Error('Wrong control selection.');
      const data=action==='SESSION_TITLE'?{title:args.p_title}:action==='SESSION_STATUS'?{status:args.p_status}:
        action==='SLOT_CLOSED'?{closed:args.p_closed}:action==='HOLIDAY_SAVE'?{date:args.p_date,title:args.p_title,description:args.p_description}:
        action==='HOLIDAY_GENERATE'?{year:args.p_year}:action==='HOLIDAY_CLEAR'?{password:args.p_password}:action==='SETTINGS'?args.p_data:{};
      used.add(c); // Consumed before dispatch: failures never enable a blind repeat.
      const response=await send('CONTROL',{action,id,data,generation:c.generation,revision:c.revision});
      if(session()!==owner||response?.action!==action||!Object.hasOwn(response,'result'))throw Error('Control result unconfirmed. Reload and inspect.');
      return response.result;
    }
    if(generationReads.has(name)){
      const owner=session();
      if(!owner||args.p_session_token!==owner)throw new Error('Please sign in again.');
      // Capture BEFORE the read, never at submission. A Restore between these
      // two calls can only cause conservative rejection, not bless stale data.
      const prepared=await send('PREPARE_CREATE',{});
      if(!generationUuid(prepared?.generation))throw new Error('Unable to prepare a safe view. Reload records.');
      if(session()!==owner)throw new Error('Please sign in again.');
      const result=await legacy(name,args);
      if(session()!==owner)throw new Error('Please sign in again.');
      return tagReadGeneration(result,prepared.generation,['orl_get_schedule','orl_get_requests','orl_get_deletions'].includes(name)?owner:undefined);
    }
    if (name === 'orl_set_postpone_count') {
      const owner=session();
      if(!owner||args.p_session_token!==owner||!generationUuid(args.p_request_id)||!generationUuid(args.p_generation)
        ||typeof args.p_expected_version!=='string'||!args.p_expected_version||!Number.isInteger(args.p_count)
        ||args.p_count<0||args.p_count>999)throw new Error('Reload the unscheduled request before editing its count.');
      const response=await send('UNSCHEDULED_COUNT',{request_id:args.p_request_id,count:args.p_count,
        expected_version:args.p_expected_version,generation:args.p_generation});
      if(session()!==owner||response?.result!==args.p_count)throw new Error('Count update not confirmed. Reload the request.');
      return null;
    }
    if (name === 'orl_swap_slots_checked') {
      if(!session()||args.p_session_token!==session())throw new Error('Please sign in again.');
      if(![args.p_from,args.p_to,args.p_expected_from_request_id,args.p_generation].every(generationUuid)
        || !(args.p_expected_to_request_id===null||generationUuid(args.p_expected_to_request_id)))
        throw new Error('Reload the schedule and reopen Reassign.');
      const response=await send('REASSIGN',{from_slot:args.p_from,to_slot:args.p_to,
        expected_from:args.p_expected_from_request_id,expected_to:args.p_expected_to_request_id,generation:args.p_generation});
      if(response?.result!=='REASSIGNED')throw new Error('Reassign not confirmed. Reload and check both slots.');
      return null;
    }
    if (['orl_edit_scheduled_request', 'orl_move_postponed', 'orl_db_import_locked', 'orl_delete_request', 'orl_swap_slots', 'orl_clear_slot',
      'orl_postpone_slot','orl_update_slot_request'].includes(name))
      throw new Error('This older action is unavailable in protected mode. Contact Webmaster.');
    if (['orl_request_deletion','orl_resolve_deletion'].includes(name)) {
      const owner=session(),request=name==='orl_request_deletion';
      if(!owner||args.p_session_token!==owner)throw new Error('Please sign in again.');
      if(![args.p_request_id,args.p_generation].every(generationUuid)
        || !(args.p_expected_slot===null||generationUuid(args.p_expected_slot))
        || typeof args.p_expected_version!=='string'||!args.p_expected_version||args.p_expected_version.length>64
        || (request?(typeof args.p_reason!=='string'||!args.p_reason.trim()||args.p_reason.length>4096):!['APPROVE','REJECT'].includes(args.p_action)))
        throw new Error('Reload and review the cancellation request again.');
      const response=await send(request?'DELETE_REQUEST':'DELETE_RESOLVE',{request_id:args.p_request_id,
        expected_slot:args.p_expected_slot,expected_version:args.p_expected_version,generation:args.p_generation,
        ...(request?{reason:args.p_reason}:{action:args.p_action})});
      if(session()!==owner)throw new Error('Please sign in again.');
      if(response?.result!==(request?'REQUESTED':args.p_action))throw new Error('Cancellation result not confirmed. Reload and check before another action.');
      return null;
    }
    if (name === 'orl_clear_slot_checked') {
      const owner=session();
      if(!owner||args.p_session_token!==owner)throw new Error('Please sign in again.');
      if(![args.p_slot_id,args.p_expected_request_id,args.p_generation].every(generationUuid))
        throw new Error('Reload the schedule and select the patient again.');
      const response=await send('CLEAR',{slot_id:args.p_slot_id,expected_request:args.p_expected_request_id,generation:args.p_generation});
      if(session()!==owner)throw new Error('Please sign in again.');
      if(response?.result!=='CLEARED')throw new Error('Clear not confirmed. Reload and check the slot before another action.');
      return null;
    }
    if (name === 'orl_review_request') {
      const owner=session();
      if(!owner||args.p_session_token!==owner)throw new Error('Please sign in again.');
      if(![args.p_request_id,args.p_generation].every(generationUuid)
        || !(args.p_expected_slot===null||generationUuid(args.p_expected_slot))
        || !['APPROVE','REJECT'].includes(args.p_action)||typeof args.p_note!=='string'||args.p_note.length>4096)
        throw new Error('Reload and review the pending request again.');
      const response=await send('REVIEW',{request_id:args.p_request_id,action:args.p_action,note:args.p_note,
        expected_slot:args.p_expected_slot,generation:args.p_generation});
      if(session()!==owner)throw new Error('Please sign in again.');
      if(response?.result!==args.p_action)throw new Error('Review not confirmed. Reload and check the request before another action.');
      return response.result;
    }
    if (name === 'orl_assign_slot') {
      if (!session() || args.p_session_token !== session()) throw new Error('Please sign in again.');
      if(!creation?.assign)throw new Error('Assignment recovery is not configured. Nothing submitted.');
      return creation.assign(args.p_request_id,args.p_slot_id,args.p_slot_generation);
    }
    if (name === 'orl_confirm_request') {
      if (!session() || args.p_session_token !== session()) throw new Error('Please sign in again.');
      if(!creation?.confirm)throw new Error('Confirmation recovery is not configured. Nothing submitted.');
      return creation.confirm(args.p_request_id,args.p_generation);
    }
    if (!protectedRpcs.has(name)) return legacy(name, args);
    if (!session() || args.p_session_token !== session()) throw new Error('Please sign in again.');
    if (name === 'orl_create_request') {
      if (!creation) throw new Error('Save recovery is not configured. Nothing was submitted.');
      return creation.create(args.p_data);
    }
    if (name === 'orl_db_remove_patient') {
      if (!['REQUEST', 'MRN'].includes(args.p_mode) || typeof args.p_value !== 'string' || !args.p_value.trim())
        throw new Error('Invalid removal request.');
      if(!generationUuid(args.p_generation)||!Array.isArray(args.p_expected_ids)||!args.p_expected_ids.length
        ||args.p_expected_ids.some(id=>!generationUuid(id)))throw new Error('Reload and review the removal targets first.');
      const response = await send('REMOVE', { password: args.p_password, mode: args.p_mode, value: args.p_value,
        generation:args.p_generation,expected_ids:args.p_expected_ids });
      if (!Number.isSafeInteger(response?.result) || response.result < 1)
        throw new Error('Removal result not confirmed. Check the records and audit log; do not repeat blindly.');
      return response.result;
    }
    if (name === 'orl_db_export') return (await send('BACKUP_EXPORT', { password: args.p_password })).backup;
    if (name === 'orl_ic_convert_legacy_backup') {
      if (args.p_backup?.format !== 'ORLOMS_BACKUP' || args.p_backup?.version !== 1)
        throw new Error('Only an original legacy backup can be converted.');
      const backup = (await send('BACKUP_CONVERT', { password: args.p_password, backup: args.p_backup })).backup;
      if (!previewBackupVersion(backup).canRestore) throw new Error('Converted backup is incomplete. Keep the original file.');
      return backup;
    }
    if (name === 'orl_db_import') {
      const preview = previewBackupVersion(args.p_backup);
      if (!preview.canRestore) throw new Error(preview.message);
      return (await send('BACKUP_RESTORE', { password: args.p_password, backup: args.p_backup })).result;
    }
    if (!['KEEP', 'SET'].includes(args.p_ic_mode)) throw new Error('IC field is not ready. Reopen the form.');
    if(!generationUuid(args.p_generation))throw new Error('Reload the schedule and reopen this form.');
    if(typeof args.p_expected_version!=='string'||!args.p_expected_version||args.p_expected_version.length>64)
      throw new Error('The patient record version is missing. Reload the schedule and reopen this form.');
    const common = { from_slot: args.p_slot_id || args.p_from_slot_id,
      expected_request: args.p_expected_request_id, expected_version:args.p_expected_version,
      ic_mode: args.p_ic_mode, data: args.p_data, generation:args.p_generation };
    const response = name === 'orl_edit_scheduled_request_checked'
      ? await send('EDIT', { ...common, action: args.p_action })
      : await send('MOVE', { ...common, to_slot: args.p_to_slot_id, reason: args.p_reason });
    return response.result;
  };
}
