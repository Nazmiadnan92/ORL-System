// Disabled-by-default C1 Edge gateway candidate. No deployment or Deno.serve here.
import { createIcRequestHandler, readPayload } from './handler.mjs';
import { prepareIdentityChange, verifyIdentityBackup } from './compatibility.mjs';
import { convertLegacyBackup } from './legacy-backup.mjs';
import { validControl, validControlView } from './controls.mjs';
import { C1_BACKUP_BODY_BYTES, C1_RATE_MAX_REQUESTS, C1_RATE_WINDOW_SECONDS, C1_SMALL_BODY_BYTES, backupWithinRuntimePolicy } from './runtime-policy.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fields = new Set(['patient_ic', 'age', 'age_months', 'mrn', 'patient_name', 'surgery', 'diagnosis',
  'doctor', 'specialist', 'sub_specialty', 'phone', 'remark', 'cancel_reason', 'postpone_count']);
const exact = (body, keys) => Object.keys(body).sort().join(',') === [...keys].sort().join(',');
const validData = data => object(data) && JSON.stringify(data).length <= 16384
  && Object.entries(data).every(([key, value]) => fields.has(key) && typeof value === 'string');
const password = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;

export function createIcGateway({ enabled = false, origins, rpc, cryptoConfig, rateLimit }) {
  return async request => {
    const origin = request.headers.get('origin'), allowed = !origin || origins.includes(origin);
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (origin && allowed) Object.assign(headers, { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-orl-session, apikey' });
    const reply = (status, value) => new Response(JSON.stringify(value), { status, headers });
    if (!allowed) return reply(403, { error: 'Not permitted.' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (!enabled) return reply(503, { error: 'Protected operations are not enabled.' });
    if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    if (new URL(request.url).search) return reply(400, { error: 'Query parameters are not permitted.' });
    const token = request.headers.get('x-orl-session') || '';
    if (!uuid.test(token)) return reply(401, { error: 'Please sign in again.' });
    let actor, body;
    try {
      actor = await rpc('orl_ic_c1_authorize', { p_session_token: token });
      if (!actor || !['STAFF', 'ADMIN', 'WEBMASTER'].includes(actor.role)) throw new Error('Denied');
    } catch { return reply(403, { error: 'Session access denied.' }); }
    // This must be backed by shared state at deployment. Missing/failed rate
    // enforcement fails closed; an isolate-local counter would be bypassable.
    if (typeof rateLimit !== 'function') return reply(503, { error: 'Protected request throttling is unavailable.' });
    try {
      if (await rateLimit({ token, role: actor.role, limit: C1_RATE_MAX_REQUESTS, windowSeconds: C1_RATE_WINDOW_SECONDS }) !== true) {
        const response = reply(429, { error: 'Too many protected requests. Wait before trying again.' });
        response.headers.set('Retry-After', String(C1_RATE_WINDOW_SECONDS));
        return response;
      }
    } catch { return reply(503, { error: 'Protected request throttling is unavailable.' }); }
    try {
      // Large payloads are accepted only for authenticated Webmaster restore/conversion. Other
      // operations have a separate small limit after parsing. Upstream limits may be lower.
      body = await readPayload(request, actor.role === 'WEBMASTER' ? C1_BACKUP_BODY_BYTES : C1_SMALL_BODY_BYTES);
      if (!object(body) || typeof body.operation !== 'string') throw new Error('Invalid');
      if (!['BACKUP_RESTORE', 'BACKUP_CONVERT'].includes(body.operation) && JSON.stringify(body).length > C1_SMALL_BODY_BYTES) throw new Error('Invalid');
    } catch { return reply(400, { error: 'Invalid or oversized protected request.' }); }

    if (body.operation === 'CONTROL_VIEW') {
      if(!validControlView(body))return reply(400,{error:'Invalid control view.'});
      if(['SESSION','SLOT'].includes(body.scope)&&actor.role==='STAFF')return reply(403,{error:'Admin access required.'});
      try{
        const result=await rpc('orl_ic_c1_control_view',{p_session_token:token,p_scope:body.scope,p_id:body.id,p_generation:body.generation});
        if(!uuid.test(result?.generation||'')||! /^[a-f0-9]{32}$/.test(result?.revision||'')||!object(result?.data))throw Error('Invalid');
        return reply(200,result);
      }catch{return reply(503,{error:'Unable to load controls safely. Reload the page before continuing.'})}
    }
    if (body.operation === 'CONTROL') {
      if(actor.role==='STAFF'||(body.action==='HOLIDAY_CLEAR'&&actor.role!=='WEBMASTER'))return reply(403,{error:'Administrative access required.'});
      if(!validControl(body))return reply(400,{error:'Invalid control selection.'});
      try{
        const result=await rpc('orl_ic_c1_control',{p_session_token:token,p_action:body.action,p_id:body.id,p_data:body.data,
          p_generation:body.generation,p_revision:body.revision});
        if(result?.action!==body.action||!Object.hasOwn(result,'result'))throw Error('Invalid');
        return reply(200,result);
      }catch{return reply(503,{error:'Control update not confirmed. Reload and inspect the result before another action; do not repeat blindly.'})}
    }
    if (body.operation === 'REPAIR_VIEW') {
      if(actor.role!=='WEBMASTER')return reply(403,{error:'Webmaster access required.'});
      if(!exact(body,['operation','generation'])||!uuid.test(body.generation))
        return reply(400,{error:'Reload Database Repair.'});
      try{
        const result=await rpc('orl_ic_c1_repair_view',{p_session_token:token,p_generation:body.generation});
        if(!uuid.test(result?.generation||'')||!/^[a-f0-9]{32}$/.test(result?.revision||'')||!object(result?.health))throw Error('Invalid');
        return reply(200,result);
      }catch{return reply(503,{error:'Unable to load Database Repair safely. Reload before continuing.'})}
    }
    if (body.operation === 'REPAIR') {
      if(actor.role!=='WEBMASTER')return reply(403,{error:'Webmaster access required.'});
      if(!exact(body,['operation','password','generation','revision'])||!password(body.password)||!uuid.test(body.generation)
        ||!/^[a-f0-9]{32}$/.test(body.revision))return reply(400,{error:'Reload and review Database Repair again.'});
      try{
        const result=await rpc('orl_ic_c1_repair',{p_session_token:token,p_password:body.password,
          p_generation:body.generation,p_revision:body.revision});
        if(result?.status!=='COMPLETED'||!Number.isSafeInteger(result.fixed)||result.fixed<0)throw Error('Invalid');
        return reply(200,{result});
      }catch{return reply(503,{error:'Repair result not confirmed. Reload Database Health and inspect before retrying.'})}
    }
    if (body.operation === 'UNSCHEDULED_COUNT') {
      if(actor.role!=='WEBMASTER')return reply(403,{error:'Webmaster access required.'});
      if(!exact(body,['operation','request_id','count','expected_version','generation'])||!uuid.test(body.request_id)
        ||!uuid.test(body.generation)||!Number.isInteger(body.count)||body.count<0||body.count>999
        ||typeof body.expected_version!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(body.expected_version)
        ||!Number.isFinite(Date.parse(body.expected_version)))return reply(400,{error:'Reload the unscheduled request and review the count.'});
      try{
        const result=await rpc('orl_ic_c1_unscheduled_count',{p_session_token:token,p_request_id:body.request_id,p_count:body.count,
          p_expected_version:body.expected_version,p_generation:body.generation});
        if(result!==body.count)throw Error('Invalid');return reply(200,{result});
      }catch{return reply(503,{error:'Count update not confirmed. Reload the request before another attempt.'})}
    }
    if (body.operation === 'PREPARE_CREATE') {
      if (!exact(body,['operation'])) return reply(400,{error:'Invalid creation preparation.'});
      try {
        const generation=await rpc('orl_ic_c1_prepare_create',{p_session_token:token});
        if(typeof generation!=='string'||!uuid.test(generation))throw new Error('Invalid generation');
        return reply(200,{generation});
      }catch{return reply(503,{error:'Unable to prepare save. No request was submitted.'})}
    }
    if (body.operation === 'RESOLVE_CREATE') {
      if (!exact(body, ['operation','request_id']) || typeof body.request_id !== 'string' || !uuid.test(body.request_id))
        return reply(400, { error: 'Invalid recovery reference.' });
      try {
        const result = await rpc('orl_ic_c1_resolve_create', { p_session_token: token, p_request_id: body.request_id });
        if (result?.request_id !== body.request_id || !['CREATED','CANCELLED','UNAVAILABLE'].includes(result.outcome))
          throw new Error('Invalid result');
        return reply(200, { request_id: result.request_id, outcome: result.outcome,
          ...(result.outcome === 'CREATED' ? { status: result.status, assigned: result.assigned } : {}) });
      } catch { return reply(503, { error: 'Save status is still unconfirmed. Keep the reference and try checking again; do not resubmit.' }); }
    }
    if (body.operation === 'CREATE') {
      if (!exact(body, ['operation', 'request_id', 'generation', 'data'])) return reply(400, { error: 'Invalid creation request.' });
      // Reuse the tested creation handler; SQL still revalidates the session at commit.
      return createIcRequestHandler({ enabled: true, origins, authorize: async () => true,
        cryptoConfig, commit: args => rpc('orl_ic_c1_create', args) })(new Request(request.url, {
        method: 'POST', headers: request.headers,
        body: JSON.stringify({ request_id: body.request_id, generation: body.generation, data: body.data }),
      }));
    }
    if (body.operation === 'CONFIRM') {
      if(!exact(body,['operation','request_id','generation'])
        || ![body.request_id,body.generation].every(x=>typeof x==='string'&&uuid.test(x)))
        return reply(400,{error:'Invalid confirmation. Check Previous Save first.'});
      try {
        const result=await rpc('orl_ic_c1_confirm',{p_session_token:token,p_request_id:body.request_id,p_generation:body.generation});
        if(!['CONFIRMED','APPROVED'].includes(result))throw new Error('Unexpected result');
        return reply(200,{result});
      } catch {return reply(503,{error:'Confirmation not confirmed. Use Check Previous Save before continuing; do not submit a new request.'})}
    }
    if (body.operation === 'ASSIGN') {
      if(!exact(body,['operation','request_id','slot_id','generation','slot_generation'])
        || ![body.request_id,body.slot_id,body.generation,body.slot_generation].every(x=>typeof x==='string'&&uuid.test(x)))
        return reply(400,{error:'Invalid assignment. Check Previous Save and reload the schedule.'});
      try {
        const result=await rpc('orl_ic_c1_assign',{p_session_token:token,p_request_id:body.request_id,
          p_slot_id:body.slot_id,p_generation:body.generation,p_slot_generation:body.slot_generation});
        if(!['CONFIRMED','RESERVED'].includes(result))throw new Error('Unexpected result');
        return reply(200,{result});
      } catch {return reply(503,{error:'Assignment not confirmed. Use Check Previous Save before continuing; do not submit a new request.'})}
    }
    if (body.operation === 'REVIEW') {
      if(!['ADMIN','WEBMASTER'].includes(actor.role))return reply(403,{error:'Admin access required.'});
      if(!exact(body,['operation','request_id','action','note','expected_slot','generation'])
        || ![body.request_id,body.generation].every(x=>typeof x==='string'&&uuid.test(x))
        || !(body.expected_slot===null||(typeof body.expected_slot==='string'&&uuid.test(body.expected_slot)))
        || !['APPROVE','REJECT'].includes(body.action)||typeof body.note!=='string'||body.note.length>4096)
        return reply(400,{error:'Invalid review. Reload and review the pending request again.'});
      try{
        const result=await rpc('orl_ic_c1_review',{p_session_token:token,p_request_id:body.request_id,
          p_action:body.action,p_note:body.note,p_expected_slot:body.expected_slot,p_generation:body.generation});
        if(result!==body.action)throw new Error('Unexpected result');
        return reply(200,{result});
      }catch{return reply(503,{error:'Review not confirmed. Reload and check the request before another action; do not repeat blindly.'})}
    }
    if (body.operation === 'CLEAR') {
      if(!['ADMIN','WEBMASTER'].includes(actor.role))return reply(403,{error:'Admin access required.'});
      if(!exact(body,['operation','slot_id','expected_request','generation'])
        || ![body.slot_id,body.expected_request,body.generation].every(x=>typeof x==='string'&&uuid.test(x)))
        return reply(400,{error:'Invalid Clear selection. Reload the schedule.'});
      try{
        const result=await rpc('orl_ic_c1_clear',{p_session_token:token,p_slot_id:body.slot_id,
          p_expected_request_id:body.expected_request,p_generation:body.generation});
        if(result!=='CLEARED')throw new Error('Unexpected result');
        return reply(200,{result});
      }catch{return reply(503,{error:'Clear not confirmed. Reload and check the slot before another action; do not repeat blindly.'})}
    }
    if (['DELETE_REQUEST','DELETE_RESOLVE'].includes(body.operation)) {
      const creating=body.operation==='DELETE_REQUEST';
      if(!creating&&!['ADMIN','WEBMASTER'].includes(actor.role))return reply(403,{error:'Admin access required.'});
      if(!exact(body,['operation','request_id','expected_slot','expected_version','generation',creating?'reason':'action'])
        || ![body.request_id,body.generation].every(x=>typeof x==='string'&&uuid.test(x))
        || !(body.expected_slot===null||(typeof body.expected_slot==='string'&&uuid.test(body.expected_slot)))
        || typeof body.expected_version!=='string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(body.expected_version)
        || !Number.isFinite(Date.parse(body.expected_version))
        || (creating?(typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>4096):!['APPROVE','REJECT'].includes(body.action)))
        return reply(400,{error:'Invalid cancellation selection. Reload and review again.'});
      try{
        const result=await rpc('orl_ic_c1_deletion',{p_session_token:token,p_operation:creating?'REQUEST':body.action,
          p_request_id:body.request_id,p_expected_slot:body.expected_slot,p_expected_version:body.expected_version,
          p_generation:body.generation,p_reason:creating?body.reason:''});
        if(result!==(creating?'REQUESTED':body.action))throw new Error('Unexpected result');
        return reply(200,{result});
      }catch{return reply(503,{error:'Cancellation result not confirmed. Reload and check before another action; do not repeat blindly.'})}
    }
    if (body.operation === 'REASSIGN') {
      if (!['ADMIN','WEBMASTER'].includes(actor.role)) return reply(403,{error:'Admin access required.'});
      if (!exact(body,['operation','from_slot','to_slot','expected_from','expected_to','generation'])
          || ![body.from_slot,body.to_slot,body.expected_from,body.generation].every(x=>typeof x==='string'&&uuid.test(x))
          || !(body.expected_to===null||(typeof body.expected_to==='string'&&uuid.test(body.expected_to)))
          || body.from_slot.toLowerCase()===body.to_slot.toLowerCase())
        return reply(400,{error:'Invalid reassign selection. Reload the schedule.'});
      try {
        const result=await rpc('orl_ic_c1_reassign',{p_session_token:token,p_from:body.from_slot,p_to:body.to_slot,
          p_expected_from_request_id:body.expected_from,p_expected_to_request_id:body.expected_to,p_generation:body.generation});
        if(result!=='REASSIGNED')throw new Error('Unexpected result');
        return reply(200,{result});
      } catch { return reply(503,{error:'Reassign not confirmed. Reload and check both slots before another action; do not repeat blindly.'}); }
    }
    if (['EDIT', 'MOVE'].includes(body.operation)) {
      const keys = ['operation', 'from_slot', 'expected_request', 'expected_version', 'ic_mode', 'data', 'generation',
        ...(body.operation === 'MOVE' ? ['to_slot', 'reason'] : ['action'])];
      if (!exact(body, keys) || typeof body.generation !== 'string' || !uuid.test(body.generation)
          || typeof body.from_slot !== 'string' || !uuid.test(body.from_slot)
          || typeof body.expected_request !== 'string' || !uuid.test(body.expected_request)
          || typeof body.expected_version !== 'string'
          || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(body.expected_version)
          || !Number.isFinite(Date.parse(body.expected_version))
          || !['KEEP', 'SET'].includes(body.ic_mode) || !validData(body.data)
          || (body.operation === 'MOVE' && (typeof body.to_slot !== 'string' || !uuid.test(body.to_slot) || typeof body.reason !== 'string' || body.reason.length > 4096))
          || (body.operation === 'EDIT' && !['CONFIRM', 'CANCEL'].includes(body.action)))
        return reply(400, { error: 'Invalid slot update.' });
      if (body.ic_mode === 'SET' && actor.role === 'STAFF') return reply(403, { error: 'IC changes require Admin or Webmaster.' });
      if (Object.hasOwn(body.data, 'postpone_count')) {
        if (actor.role !== 'WEBMASTER') return reply(403, { error: 'Postpone count requires Webmaster.' });
        if (body.operation !== 'EDIT' || !/^[0-9]{1,3}$/.test(body.data.postpone_count))
          return reply(400, { error: 'Manual postpone count must be 0–999 and saved through Edit.' });
      }
      let change;
      try { change = await prepareIdentityChange({ mode: body.ic_mode, data: body.data,
        requestId: body.expected_request.toLowerCase(), cryptoConfig: body.ic_mode === 'SET' ? cryptoConfig() : undefined }); }
      catch { return reply(400, { error: 'IC change could not be verified. Nothing submitted.' }); }
      try {
        const result = await rpc('orl_ic_c1_mutate', { p_session_token: token, p_operation: body.operation,
          p_from_slot: body.from_slot, p_to_slot: body.to_slot || null, p_expected_request: body.expected_request,
          p_data: change.data, p_action: body.action || null, p_reason: body.reason || '', p_ic_mode: body.ic_mode,
          p_envelope: change.envelope, p_search: change.search, p_generation: body.generation,
          p_expected_version: body.expected_version });
        if (!['UPDATED', 'CONFIRMED', 'RESERVED'].includes(result)) throw new Error('Unexpected result');
        return reply(200, { result });
      } catch { return reply(503, { error: 'Update not confirmed. Restore or another action may have changed the records. Reload the schedule and review before retrying.' }); }
    }
    if (body.operation === 'REMOVE') {
      if (actor.role !== 'WEBMASTER') return reply(403, { error: 'Webmaster access required.' });
      if (!exact(body, ['operation', 'password', 'mode', 'value', 'generation', 'expected_ids']) || !password(body.password)
          || typeof body.generation !== 'string' || !uuid.test(body.generation)
          || !Array.isArray(body.expected_ids) || !body.expected_ids.length || body.expected_ids.length > 1000
          || body.expected_ids.some(id => typeof id !== 'string' || !uuid.test(id))
          || new Set(body.expected_ids.map(id => id.toLowerCase())).size !== body.expected_ids.length
          || (body.mode === 'REQUEST' && (body.expected_ids.length !== 1 || body.expected_ids[0].toLowerCase() !== String(body.value).toLowerCase()))
          || !['REQUEST', 'MRN'].includes(body.mode) || typeof body.value !== 'string'
          || !body.value.trim() || body.value.length > 4096
          || (body.mode === 'REQUEST' && !uuid.test(body.value)))
        return reply(400, { error: 'Invalid removal request.' });
      try {
        if (await rpc('orl_ic_c1_check_password', { p_session_token: token, p_password: body.password }) !== true) throw new Error('Denied');
      } catch { return reply(403, { error: 'Webmaster verification failed. No removal was submitted.' }); }
      try {
        // SQL rechecks the password/role and atomically removes clinical + shadow
        // records, releases/compacts slots, and retains creation recovery receipts.
        // No encryption key or IC reveal is needed for authorized removal.
        const result = await rpc('orl_ic_c1_remove', { p_session_token: token, p_password: body.password,
          p_mode: body.mode, p_value: body.value, p_generation: body.generation, p_expected_ids: body.expected_ids });
        if (!Number.isSafeInteger(result) || result < 1) throw new Error('Unexpected result');
        return reply(200, { result });
      } catch { return reply(503, { error: 'Removal result not confirmed. Check the records and audit log before any further action; do not repeat blindly.' }); }
    }
    if (['BACKUP_EXPORT', 'BACKUP_RESTORE', 'BACKUP_CONVERT'].includes(body.operation)) {
      if (actor.role !== 'WEBMASTER') return reply(403, { error: 'Webmaster access required.' });
      if (!exact(body, ['operation', 'password', ...(body.operation !== 'BACKUP_EXPORT' ? ['backup'] : [])]) || !password(body.password))
        return reply(400, { error: 'Invalid backup request.' });
      if (body.operation !== 'BACKUP_EXPORT' && !backupWithinRuntimePolicy(body.backup))
        return reply(400, { error: 'Backup exceeds the protected runtime policy. No restore was started.' });
      // Check password BEFORE attempting expensive verification or decrypting identities.
      try {
        if (await rpc('orl_ic_c1_check_password', { p_session_token: token, p_password: body.password }) !== true) throw new Error('Denied');
      } catch { return reply(403, { error: 'Webmaster verification failed.' }); }
      if (body.operation === 'BACKUP_CONVERT') {
        let converted;
        try { converted = await convertLegacyBackup(body.backup, cryptoConfig()); }
        catch { return reply(400, { error: 'Legacy backup conversion failed. Keep the original file; no restore was started.' }); }
        if (!backupWithinRuntimePolicy(converted)) return reply(400, { error: 'Converted backup exceeds the protected runtime policy. Keep the original file.' });
        // Conversion has NO import/write RPC. Recheck access before releasing the
        // converted clinical payload in case the session was revoked during crypto work.
        try {
          if (await rpc('orl_ic_c1_check_password', { p_session_token: token, p_password: body.password }) !== true) throw new Error('Denied');
        } catch { return reply(403, { error: 'Webmaster verification failed. No restore was started.' }); }
        return reply(200, { backup: converted });
      }
      if (body.operation === 'BACKUP_EXPORT') {
        try {
          const backup = await rpc('orl_ic_c1_export', { p_session_token: token, p_password: body.password });
          // Do not distribute a new backup with stale/mismatched or unrecoverable shadows.
          const verified = await verifyIdentityBackup(backup, cryptoConfig());
          if (!backupWithinRuntimePolicy(verified)) throw new Error('Runtime policy exceeded');
          return reply(200, { backup: verified });
        } catch { return reply(503, { error: 'Backup could not be verified. Keep earlier backups and contact Webmaster.' }); }
      }
      if (body.backup?.version === 1) return reply(400, { error: 'Legacy backup conversion is required. Keep this file; no restore was started.' });
      let verified;
      try { verified = await verifyIdentityBackup(body.backup, cryptoConfig()); }
      catch { return reply(400, { error: 'Backup identity verification failed. No restore was started.' }); }
      try {
        const result = await rpc('orl_ic_c1_import', { p_session_token: token, p_password: body.password, p_backup: verified });
        if (result?.status !== 'COMPLETED') throw new Error('Unexpected result');
        return reply(200, { result });
      } catch { return reply(503, { error: 'Restore result not confirmed. Check system state before retrying; do not rerun blindly.' }); }
    }
    return reply(400, { error: 'Unsupported protected operation.' });
  };
}
