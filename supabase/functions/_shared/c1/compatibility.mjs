// Server-side orchestration candidate only. No deployed HTTP entrypoint.
import { createIdentityCrypto, normalizeIdentity } from '../ic-crypto.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = () => { throw new Error('Identity verification failed. Nothing submitted.'); };

export function maskIdentityDisplay(value) {
  if (typeof value !== 'string') return fail();
  const raw=value.trim();
  if (!raw) return '';
  if (/^(?:\d{6}-\*{2}-\*{4}|\*{6}-\*{2}-\d{4}|\*{4,8}[A-Za-z0-9]{4}|\*{4})$/.test(raw)) return raw;
  const digits=raw.replace(/[^0-9]/g,'');
  if (/^\d{6}-?\d{2}-?\d{4}$/.test(raw)) return `${digits.slice(0,6)}-**-****`;
  const compact=raw.replace(/\s/g,'');
  return compact.length<=4?'****':`********${compact.slice(-4)}`;
}

// KEEP intentionally omits patient_ic; callers must not send masked values as originals.
// No record lookup or reveal is introduced. SQL enforces slot/role permission at commit.
export async function prepareIdentityChange({ mode, data, requestId, cryptoConfig }) {
  if (!uuid.test(requestId) || !object(data) || !['KEEP', 'SET'].includes(mode)) return fail();
  const copy = structuredClone(data);
  if (mode === 'KEEP') {
    if (Object.hasOwn(copy, 'patient_ic')) return fail();
    return { data: copy, envelope: null, search: null };
  }
  if (typeof copy.patient_ic !== 'string') return fail();
  const raw = copy.patient_ic.replace(/^ +| +$/g, '');
  if (raw.includes('*') || raw.includes('•')) return fail();
  const engine = await createIdentityCrypto(cryptoConfig);
  copy.patient_ic = raw;
  if (!raw) return { data: copy, envelope: null, search: null };
  normalizeIdentity(raw);
  const envelope = await engine.encrypt(raw, requestId);
  if (await engine.decrypt(envelope, requestId) !== raw) return fail();
  return { data: copy, envelope, search: await engine.searchHash(raw) };
}

// Returns the exact private clone that was verified, preventing mutation during await.
// The caller passes THIS clone to service-only import, not the original client object.
export async function verifyIdentityBackup(input, cryptoConfig) {
  try {
    const backup = structuredClone(input);
    if (!object(backup) || backup.format !== 'ORLOMS_BACKUP' || ![2,3].includes(backup.version)
        || !['ORL_IC_SHADOW_V1','ORL_IC_ENCRYPTED_V1'].includes(backup.identity_format)
        || (backup.version===3&&(backup.identity_format!=='ORL_IC_ENCRYPTED_V1'||backup.plaintext_removed!==true))
        || backup.creation_receipt_format !== 'ORL_CREATE_RECEIPTS_V1'
        || !Array.isArray(backup.creation_receipts)
        || !Array.isArray(backup.requests) || !Array.isArray(backup.identities)) return fail();
    for (const section of ['users', 'settings', 'holidays', 'ot_sessions', 'ot_slots', 'audit_log'])
      if (!Array.isArray(backup[section]) || backup[section].some(x => !object(x))) return fail();
    const engine = await createIdentityCrypto(cryptoConfig);
    const records = new Map(), seen = new Set();
    for (const r of backup.requests) {
      if (!object(r) || typeof r.id !== 'string' || !uuid.test(r.id) || records.has(r.id)
          || typeof r.ic_protected !== 'boolean' || typeof r.creation_tracked !== 'boolean'
          || typeof r.patient_ic !== 'string') return fail();
      records.set(r.id, r);
    }
    for (const i of backup.identities) {
      if (!object(i) || typeof i.request_id !== 'string' || seen.has(i.request_id)) return fail();
      const r = records.get(i.request_id);
      if (!r || !r.ic_protected || !r.patient_ic || !object(i.search) || i.search.normalization_version !== 1
          || typeof i.search.key_id !== 'string' || typeof i.search.hash !== 'string') return fail();
      const raw = await engine.decrypt(i.envelope, i.request_id);
      if (backup.version===2 ? raw !== r.patient_ic : maskIdentityDisplay(raw) !== r.patient_ic) return fail();
      const search = await engine.searchHash(raw, i.search.key_id);
      if (search.hash !== i.search.hash) return fail();
      seen.add(i.request_id);
    }
    for (const r of records.values()) if (r.ic_protected !== seen.has(r.id)) return fail();
    const receipts = new Map();
    for (const c of backup.creation_receipts) {
      if (!object(c) || typeof c.request_id !== 'string' || !uuid.test(c.request_id)
          || typeof c.owner_id !== 'string' || !uuid.test(c.owner_id) || receipts.has(c.request_id)
          || !['CREATED','CANCELLED'].includes(c.outcome)
          || typeof c.created_at !== 'string' || !Number.isFinite(Date.parse(c.created_at))) return fail();
      receipts.set(c.request_id,c);
      const r=records.get(c.request_id);
      if (r && (c.outcome!=='CREATED' || (r.created_by != null && r.created_by !== c.owner_id))) return fail();
    }
    for (const r of records.values()) if (r.creation_tracked !== receipts.has(r.id)) return fail();
    return backup;
  } catch { return fail(); }
}

// Convert a cryptographically verified v2/v3 backup to the C6 format without
// ever returning the decrypted value. The exact identity remains only in ciphertext.
export async function prepareC6Backup(input, cryptoConfig) {
  const backup=await verifyIdentityBackup(input,cryptoConfig);
  const engine=await createIdentityCrypto(cryptoConfig);
  const identities=new Map(backup.identities.map(i=>[i.request_id,i]));
  for(const request of backup.requests){
    const identity=identities.get(request.id);
    request.patient_ic=identity?maskIdentityDisplay(await engine.decrypt(identity.envelope,request.id)):'';
  }
  backup.version=3;backup.identity_format='ORL_IC_ENCRYPTED_V1';backup.plaintext_removed=true;
  return backup;
}
