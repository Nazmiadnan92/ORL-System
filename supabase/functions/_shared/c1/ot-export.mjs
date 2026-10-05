import {createIdentityCrypto} from '../ic-crypto.mjs';
import {maskIdentityDisplay} from './compatibility.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function verifyOtExport(view,config,sessionId,generation){
  const fail=()=>{throw Error('OT export verification failed.');};
  if(!uuid.test(view?.lease_id||'')||view?.generation!==generation
    ||!Number.isFinite(Date.parse(view?.expires_at))||Date.parse(view.expires_at)<=Date.now()
    ||view?.snapshot?.session?.session_id!==sessionId
    ||!/^\d{4}-\d{2}-\d{2}$/.test(view.snapshot.session.ot_date||''))return fail();
  const source=view.snapshot.patients;
  if(!Array.isArray(source)||source.length<1||source.length>200)return fail();
  const seen=new Set(),engine=await createIdentityCrypto(config),patients=[];
  for(const item of source){
    if(!uuid.test(item?.request_id||'')||seen.has(item.request_id))return fail();
    seen.add(item.request_id);
    let raw='';
    if(item.envelope!==null){
      raw=await engine.decrypt(item.envelope,item.request_id);
      const hash=await engine.searchHash(raw,item.search?.key_id);
      if(hash.hash!==item.search?.hash||hash.normalization_version!==item.search?.normalization_version
        ||maskIdentityDisplay(raw)!==item.patient_ic)return fail();
    }else if(item.patient_ic!==''||item.search!==null)return fail();
    const result={request_id:item.request_id,patient_ic:raw};
    for(const field of ['patient_name','mrn','age','age_months','diagnosis','surgery','sub_specialty'])result[field]=item[field];
    patients.push(result);
  }
  return {lease_id:view.lease_id,generation,session:{session_id:sessionId,ot_date:view.snapshot.session.ot_date},patients};
}
