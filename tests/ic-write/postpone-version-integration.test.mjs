import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';import vm from 'node:vm';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
import {createIcGateway} from '../../supabase/functions/_shared/c1/gateway.mjs';
import {createIcRpcRouter} from '../../docs/ic-client.mjs';

test('055: real schedule -> form -> browser router -> gateway -> SQL Move; masking and stale-write guards retained',async()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=q=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v===null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const rpc=async(name,p)=>JSON.parse(sql(`set role service_role;select to_jsonb(public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')}))`));
 const install=()=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../supabase/055_postpone_record_version.sql',import.meta.url))],{stdio:['ignore','pipe','pipe']});
 const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32))),config={context:'synthetic-postpone',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}};
 const engine=await createIdentityCrypto(config),origin='https://synthetic.invalid';
 const gateway=createIcGateway({enabled:true,origins:[origin],rpc,cryptoConfig:()=>config,rateLimit:async({token})=>rpc('orl_ic_c1_rate_limit',{p_session_token:token})});
 let token;let sends=0;
 const router=createIcRpcRouter({session:()=>token,send:async(operation,p)=>{
  sends++;const response=await gateway(new Request(origin+'/ic-requests',{method:'POST',headers:{origin,'Content-Type':'application/json','x-orl-session':token},body:JSON.stringify({operation,...p})}));
  const body=await response.json();if(!response.ok)throw Error(body.error);return body;
 },legacy:async(name,p)=>{
  assert.equal(name,'orl_get_schedule');return JSON.parse(sql(`set role anon;select coalesce(jsonb_agg(to_jsonb(s)),'[]') from public.orl_get_schedule(${lit(p.p_session_token)},${p.p_year},${p.p_month}) s`));
 }});
 const app=readFileSync(new URL('../../docs/app.js',import.meta.url),'utf8');
 const helper=app.slice(app.indexOf('function configureProtectedIcForm('),app.indexOf('async function carryProtectedIcChoice('));
 const ctx=vm.createContext({protectedIcEnabled:()=>true,maskPatientIc:()=>'',toast:()=>{},protectedIcClient:async()=>({bindProtectedIcField:()=>data=>({data,ic_mode:'KEEP'})})});
 vm.runInContext(helper,ctx);
 const formArgs=async row=>{
  const form={elements:{patient_ic:{},age:{value:'20'},age_months:{value:'0'}}};
  ctx.configureProtectedIcForm(form,row,true);return ctx.protectedIcArgs(form,{});
 };
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton');
 const fixtures=[];
 for(const [i,role]of ['WEBMASTER','ADMIN','STAFF'].entries()){
  const user=crypto.randomUUID(),request=crypto.randomUUID(),session=crypto.randomUUID(),nextSession=crypto.randomUUID(),source=crypto.randomUUID(),target=crypto.randomUUID(),other=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(user)},${lit('postpone_'+role)},'unused','Synthetic',${lit(role)});
   insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(user)},encode(extensions.digest(${lit(user)},'sha256'),'hex'),now()+interval '1 hour');
   insert into public.orl_ot_sessions(id,ot_date,day_name) values
    (${lit(session)},'2096-04-${String(i*2+1).padStart(2,'0')}','Synthetic'),
    (${lit(nextSession)},'2096-04-${String(i*2+2).padStart(2,'0')}','Synthetic');`);
  const raw=i===1?'SYNTHETIC-PASSPORT':'010203-04-5678';
  const data={patient_ic:raw,age:'20',age_months:'0',patient_name:'Synthetic Postpone',mrn:'MOVE-'+request,surgery:'TEST',diagnosis:'TEST',doctor:'Test',specialist:'Test',sub_specialty:'Gen ORL',phone:'0',remark:'TEST'};
  await rpc('orl_ic_c1_create',{p_session_token:user,p_request_id:request,p_data:data,p_envelope:await engine.encrypt(raw,request),p_search:await engine.searchHash(raw),p_generation:generation});
  sql(`insert into public.orl_ot_slots(id,session_id,slot_type,slot_number,request_id,status) values
   (${lit(source)},${lit(session)},'MAIN',1,${lit(request)},'CONFIRMED'),
   (${lit(target)},${lit(nextSession)},${lit(role==='STAFF'?'MAIN':'SPECIAL')},2,null,'AVAILABLE'),
   (${lit(other)},${lit(nextSession)},'SPECIAL',3,null,'AVAILABLE');
   update public.orl_requests set status='SCHEDULED',assigned_slot_id=${lit(source)},updated_at='2096-01-01T12:00:00.123456Z' where id=${lit(request)};`);
  fixtures.push({role,user,request,source,target,other,raw});
 }
 const read=async f=>{token=f.user;return (await router('orl_get_schedule',{p_session_token:token,p_year:2096,p_month:4})).flatMap(s=>s.slots).find(s=>s.request_id===f.request)};
 const before=await read(fixtures[0]);assert.equal(before._ic_edit_version,undefined);
 const beforeSends=sends;await assert.rejects(()=>formArgs(before),/record version is missing/);assert.equal(sends,beforeSends);
 const state=()=>sql(`select md5(jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'sessions',(select jsonb_agg(to_jsonb(t) order by id) from public.orl_sessions t))::text)`);
 const unchanged=state();install();assert.equal(state(),unchanged);assert.throws(install);
 const audit=JSON.parse(execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../security/release/audit-postpone-version.sql',import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim());
 assert.equal(Object.keys(audit).length,6);for(const [name,ok]of Object.entries(audit))assert.equal(ok,true,name);
 for(const f of fixtures){
  let row=await read(f);assert.equal(row._ic_edit_version,JSON.parse(sql(`select to_jsonb(updated_at) from public.orl_requests where id=${lit(f.request)}`)));assert.match(row._ic_edit_version,/\.123456[+-]/);assert.ok(!JSON.stringify(row).includes(f.raw));
  const identityBefore=sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(f.request)}`);
  const move=async(r,to=f.target)=>router('orl_move_postponed_checked',{p_session_token:token,p_from_slot_id:r.id,p_to_slot_id:to,...await formArgs(r),p_reason:'Synthetic move',p_expected_request_id:f.request});
  if(f.role==='STAFF')await assert.rejects(()=>move(row,f.other));
  sql(`update public.orl_requests set updated_at=updated_at+interval '1 microsecond' where id=${lit(f.request)}`);
  await assert.rejects(()=>move(row));assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${lit(f.request)}`),f.source);
  row=await read(f);const result=await move(row);assert.equal(result,f.role==='STAFF'?'RESERVED':'CONFIRMED');
  assert.equal(sql(`select assigned_slot_id from public.orl_requests where id=${lit(f.request)}`),f.target);
  assert.equal(sql(`select postpone_count from public.orl_requests where id=${lit(f.request)}`),'1');
  assert.equal(sql(`select count(*) from public.orl_audit_log where record_id=${lit(f.request)} and action='PATIENT_POSTPONED'`),'1');
  assert.equal(sql(`select to_jsonb(i) from orl_private.request_identity i where request_id=${lit(f.request)}`),identityBefore);
  await assert.rejects(()=>move(row)); // old source cannot move the same patient twice
 }
 assert.equal(sql("select orl_private.c1_mask_json('{\"request_id\":\"not-a-uuid\",\"remark\":\"010203-04-5678\"}') ? '_ic_edit_version'"),'f');
 assert.equal(sql("select orl_private.c1_mask_json('{\"remark\":\"010203-04-5678\"}')->>'remark'"),'010203-**-****');
 for(const role of ['anon','authenticated','service_role'])assert.equal(sql(`select has_function_privilege('${role}','orl_private.c1_mask_json(jsonb,date)','EXECUTE')`),'f');
});
