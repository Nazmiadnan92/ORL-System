// Local candidate conversion only. Exposed only by the default-OFF candidate gateway.
// Caller must authorize Webmaster/password before loading keys or calling this.
// Does not restore, write SQL, overwrite a file, or fabricate missing recovery receipts.
import {createIdentityCrypto} from '../../../supabase/functions/_shared/ic-crypto.mjs';
import {verifyIdentityBackup} from './compatibility.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function convertLegacyBackup(input,cryptoConfig){
  try{
    const backup=structuredClone(input);
    if(!backup||backup.format!=='ORLOMS_BACKUP'||backup.version!==1)throw Error();
    for(const section of ['requests','users','settings','holidays','ot_sessions','ot_slots','audit_log'])
      if(!Array.isArray(backup[section])||backup[section].some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error();
    // Never silently reinterpret a protected backup whose version was altered.
    for(const name of ['identities','identity_format','creation_receipts','creation_receipt_format'])
      if(Object.hasOwn(backup,name))throw Error();
    const seen=new Set();
    for(const r of backup.requests){
      if(typeof r.id!=='string'||!uuid.test(r.id)||seen.has(r.id)||typeof r.patient_ic!=='string'
          || /[*•]/.test(r.patient_ic)
          || Object.hasOwn(r,'ic_protected')||Object.hasOwn(r,'creation_tracked'))throw Error();
      seen.add(r.id);
    }
    const engine=await createIdentityCrypto(cryptoConfig);
    backup.version=2;backup.identity_format='ORL_IC_SHADOW_V1';backup.identities=[];
    backup.creation_receipt_format='ORL_CREATE_RECEIPTS_V1';backup.creation_receipts=[];
    for(const r of backup.requests){
      r.ic_protected=r.patient_ic!=='';r.creation_tracked=false;
      if(!r.ic_protected)continue;
      const envelope=await engine.encrypt(r.patient_ic,r.id);
      if(await engine.decrypt(envelope,r.id)!==r.patient_ic)throw Error();
      backup.identities.push({request_id:r.id,envelope,search:await engine.searchHash(r.patient_ic)});
    }
    return await verifyIdentityBackup(backup,cryptoConfig);
  }catch{throw new Error('Legacy backup conversion failed. Keep the original file; no restore was started.')}
}
