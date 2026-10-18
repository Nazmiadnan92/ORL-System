// Dedicated historical correction path. Ordinary booking guards stay closed.
import {prepareIdentityChange,maskIdentityDisplay} from './compatibility.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value));
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const clinical=['patient_name','mrn','age','age_months','diagnosis','surgery','doctor','specialist','sub_specialty','phone','remark','patient_ic'];
const states=['DRAFT','CONFIRMED','PENDING REVIEW','APPROVED','REJECTED','SCHEDULED','CANCELLED','COMPLETED'];
const validData=value=>object(value)&&JSON.stringify(value).length<=16384&&Object.entries(value).every(([key,text])=>clinical.includes(key)&&typeof text==='string');
const password=value=>typeof value==='string'&&value.length>0&&value.length<=1024;
const snapshot=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
function safeView(value,slotId){
 if(!object(value)||value.slot_id!==slotId||![value.slot_id,value.session_id,value.generation].every(uuid)
   ||!['ADD','EDIT'].includes(value.mode)||!date(value.ot_date)||!['MAIN','SPECIAL'].includes(value.slot_type)
   ||!Number.isSafeInteger(value.slot_number)||value.slot_number<1||!['AVAILABLE','CLOSED','RESERVED','CONFIRMED'].includes(value.slot_status)
   ||!['ACTIVE','CANCELLED','HOLIDAY','CLOSED'].includes(value.session_status)||!snapshot(value.snapshot)
   ||typeof value.ot_hold!=='boolean'||!Number.isSafeInteger(value.postpone_count)||value.postpone_count<0)throw Error('Invalid view');
 if(value.mode==='ADD'){
  if(value.request_id!==null||value.expected_version!==null||value.request_status!==null||value.patient!==null
    ||!['AVAILABLE','CLOSED'].includes(value.slot_status)||value.ot_hold||value.postpone_count!==0)throw Error('Invalid empty slot');
 }else{
  if(!uuid(value.request_id)||!timestamp(value.expected_version)||!states.includes(value.request_status)||!object(value.patient))throw Error('Invalid patient view');
  for(const key of clinical){const field=value.patient[key];if(key==='age'||key==='age_months'){
   if(field!==null&&(!Number.isInteger(field)||field<0||field>(key==='age'?130:11)))throw Error('Invalid age');
  }else if(typeof field!=='string')throw Error('Invalid patient field')}
  if(maskIdentityDisplay(value.patient.patient_ic)!==value.patient.patient_ic)throw Error('Unmasked patient identity');
 }
 // Release display fields only, never extra database/envelope fields.
 return Object.fromEntries(['mode','slot_id','session_id','ot_date','slot_type','slot_number','slot_status','session_status','request_id','request_status','ot_hold','postpone_count','generation','expected_version','snapshot'].map(key=>[key,value[key]]).concat([
  ['patient',value.patient===null?null:Object.fromEntries(clinical.map(key=>[key,value.patient[key]]))]
 ]));
}
export async function handlePastCase({body,actor,token,rpc,cryptoConfig,reply}){
 if(actor.role!=='WEBMASTER')return reply(403,{error:'Webmaster access required for historical records.'});
 if(body.operation==='PAST_VIEW'){
  if(!exact(body,['operation','slot_id'])||!uuid(body.slot_id))return reply(400,{error:'Reload the historical slot.'});
  try{return reply(200,{result:safeView(await rpc('orl_ic_past_case_view',{p_session_token:token,p_slot_id:body.slot_id}),body.slot_id)})}
  catch{return reply(409,{error:'Historical record unavailable. Reload the schedule and review this slot.'})}
 }
 if(!exact(body,['operation','mode','slot_id','request_id','data','reason','ic_mode','password','generation','snapshot','expected_version'])
   ||!['ADD','EDIT'].includes(body.mode)||![body.slot_id,body.request_id,body.generation].every(uuid)||!snapshot(body.snapshot)
   ||!(body.mode==='ADD'?body.expected_version===null:timestamp(body.expected_version))
   ||!password(body.password)||typeof body.reason!=='string'||!body.reason.trim()||body.reason.length>2000
   ||!validData(body.data)||!['KEEP','SET'].includes(body.ic_mode)||(body.mode==='ADD'&&body.ic_mode!=='SET')
   ||(body.ic_mode==='KEEP'?Object.prototype.hasOwnProperty.call(body.data,'patient_ic'):typeof body.data.patient_ic!=='string'))
  return reply(400,{error:'Review the historical case, reason and password before saving.'});
 // Re-authenticate before any key access; SQL rechecks in the atomic transaction.
 try{if(await rpc('orl_ic_c1_check_password',{p_session_token:token,p_password:body.password})!==true)throw Error('Denied')}
 catch{return reply(403,{error:'Webmaster password verification failed. Reload and review before trying again.'})}
 let change;
 try{change=await prepareIdentityChange({mode:body.ic_mode,data:body.data,requestId:body.request_id.toLowerCase(),cryptoConfig:body.ic_mode==='SET'?cryptoConfig():undefined})}
 catch{return reply(400,{error:'IC / Passport protection failed. No historical record was submitted.'})}
 try{
  const result=await rpc('orl_ic_past_case_save',{p_session_token:token,p_password:body.password,p_mode:body.mode,
   p_slot_id:body.slot_id,p_request_id:body.request_id,p_data:change.data,p_reason:body.reason,p_ic_mode:body.ic_mode,
   p_envelope:change.envelope,p_search:change.search,p_generation:body.generation,p_snapshot:body.snapshot,p_expected_version:body.expected_version});
  if(!object(result)||result.request_id!==body.request_id||result.slot_id!==body.slot_id||result.mode!==body.mode
    ||!date(result.ot_date)||!states.includes(result.status)||!timestamp(result.updated_at)||(body.mode==='ADD'&&result.status!=='SCHEDULED'))throw Error('Unexpected result');
  return reply(200,{result:Object.fromEntries(['request_id','slot_id','ot_date','status','updated_at','mode'].map(key=>[key,result[key]]))});
 }catch{return reply(409,{error:'Historical save not confirmed. Reload and check the slot and Audit Log before another action; do not repeat blindly.'})}
}
