// Server-only C3 reveal helper. Decrypted identity exists only in this call and
// is released after SQL records the authorized, purpose-bound one-time access.
import { createIdentityCrypto } from '../ic-crypto.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fail=()=>{throw new Error('C3 identity reveal verification failed.');};

export async function verifyC3Reveal(view,cryptoConfig){
  if(!exact(view,['lease_id','request_id','generation','lease_expires_at','identity_updated_at','envelope','search'])
    ||![view.lease_id,view.request_id,view.generation].every(value=>uuid.test(value||''))
    ||![view.lease_expires_at,view.identity_updated_at].every(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))
    ||Date.parse(view.lease_expires_at)<=Date.now()||!object(view.envelope)||!object(view.search))return fail();
  const engine=await createIdentityCrypto(cryptoConfig),requestId=view.request_id.toLowerCase();
  const patientIc=await engine.decrypt(view.envelope,requestId);
  const check=await engine.searchHash(patientIc,view.search.key_id);
  if(check.hash!==view.search.hash||check.normalization_version!==view.search.normalization_version)return fail();
  return {lease_id:view.lease_id.toLowerCase(),request_id:requestId,generation:view.generation.toLowerCase(),
    identity_updated_at:view.identity_updated_at,patient_ic:patientIc};
}
