import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createIdentityCrypto,toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';

test('069: full identity duplicates only; no masked-prefix matches, no data mutation, Webmaster only, no identity disclosure',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v==null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const run=p=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+p,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet or inet_server_port()<>55461 then raise exception 'Disposable local fixture only'; end if; end $$;");
 const audit068=JSON.parse(run('security/release/audit-undo-done.sql'));for(const [key,ok] of Object.entries(audit068))assert.equal(ok,true,'068 baseline '+key);
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const core='orl_private.c1_read_orl_db_duplicates(uuid)';
 const functionState=()=>sql(`select md5(jsonb_agg(to_jsonb(p) order by p.oid)::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.oid<>${lit(core)}::regprocedure`);
 const deny=(fn,pattern)=>{const before=snapshot();assert.throws(fn,error=>pattern.test(String(error.stderr||error.message)));assert.equal(snapshot(),before,'Denied attempt leaves all stored data untouched');};
 const original=sql(`select pg_get_functiondef(${lit(core)}::regprocedure)`);
 sql(original.replace('declare u public.orl_users%rowtype;','declare u public.orl_users%rowtype; -- deliberate local drift'));
 deny(()=>run('supabase/069_exact_identity_duplicates.sql'),/baseline differs/);sql(original);
 const beforeInstall=snapshot(),functionsBefore=functionState();
 run('supabase/069_exact_identity_duplicates.sql');
 assert.equal(snapshot(),beforeInstall,'No row, audit, generation, setting or patient changed by installation');
 assert.equal(functionState(),functionsBefore,'Only the private duplicate read core changes');
 deny(()=>run('supabase/069_exact_identity_duplicates.sql'),/baseline differs/);
 const audit069=JSON.parse(run('security/release/audit-exact-duplicates.sql'));assert.equal(Object.keys(audit069).length,9);for(const [key,ok] of Object.entries(audit069))assert.equal(ok,true,key);
 const actors={};
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const id=actors[role]=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('dupe_'+role.toLowerCase()+'_'+id.slice(0,8))},'unused',${lit('Synthetic '+role)},${lit(role)});insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour')`);
 }
 // The unchanged session guard takes a maintenance SHARE lock. Use the same
 // transaction mode as the RPC; row digests below prove the scan changes no data.
 const call=(actor=actors.WEBMASTER,dbRole='anon')=>`set role ${dbRole};begin;select public.orl_db_duplicates(${lit(actor)});rollback;`;
 const scan=(actor,dbRole)=>JSON.parse(sql(call(actor,dbRole)));
 for(const dbRole of ['anon','authenticated','service_role']){
  for(const role of ['STAFF','ADMIN'])deny(()=>scan(actors[role],dbRole),/Webmaster access required/);
  deny(()=>sql(`set role ${dbRole};select orl_private.c1_read_orl_db_duplicates(${lit(actors.WEBMASTER)})`),/permission denied/);
  deny(()=>sql(`set role ${dbRole};select search_hash from orl_private.request_identity`),/permission denied/);
 }
 deny(()=>scan(null),/session has expired/);deny(()=>scan(crypto.randomUUID()),/session has expired/);
 for(const update of ["is_active=false","must_change_password=true"]){
  sql(`update public.orl_users set ${update} where id=${lit(actors.WEBMASTER)}`);
  deny(()=>scan(),/session has expired|Password change required/);
  sql(`update public.orl_users set is_active=true,must_change_password=false where id=${lit(actors.WEBMASTER)}`);
 }
 sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${lit(actors.WEBMASTER)}`);deny(()=>scan(),/session has expired/);
 sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${lit(actors.WEBMASTER)}`);
 const randomKey=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
 const engine=await createIdentityCrypto({context:'synthetic-exact-duplicates',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',encryptionKeys:{'enc-v1':randomKey()},searchKeys:{'search-v1':randomKey()}});
 const generation=sql('select generation from orl_private.c1_restore_generation where singleton'),ids=[],full=[],hashes=[];
 const create=async(raw,mrn)=>{
  const id=crypto.randomUUID(),envelope=raw?await engine.encrypt(raw,id):null,search=raw?await engine.searchHash(raw):null;
  const data={patient_name:'Synthetic duplicate test',mrn:mrn||'DUPE-'+id,age:'36',age_months:'1',diagnosis:'Test only',surgery:'Procedure '+id,doctor:'Synthetic doctor',specialist:'Synthetic specialist',sub_specialty:'Gen ORL',phone:'0',patient_ic:raw};
  sql(`set role service_role;select public.orl_ic_c1_create(${lit(actors.STAFF)},${lit(id)},${lit(data)},${lit(envelope)},${lit(search)},${lit(generation)});`);
  ids.push(id);if(raw)full.push(raw);if(search)hashes.push(search.hash);return id;
 };
 const a=await create('900101-01-1234'),same=await create('900101011234');
 const sameEight=await create('900101-01-5678'),sameSix=await create('900101-02-9012');
 const sameLast=await create('910202-02-1234'),different=await create('920303-03-0001');
 const passport=await create('AB123456'),passportSame=await create('ab123456'),passportSuffix=await create('XY123456');
 const blankA=await create('','DUPE-SAME-MRN'),blankB=await create('','DUPE-SAME-MRN');
 // Completed and cancelled history is reviewable, not automatically deleted.
 sql(`update public.orl_requests set status='COMPLETED' where id=${lit(same)};update public.orl_requests set status='CANCELLED' where id=${lit(passportSame)}`);
 const frozen=snapshot(),groups=scan();
 assert.equal(snapshot(),frozen,'Read-only scan writes nothing');
 for(const dbRole of ['authenticated','service_role'])assert.deepEqual(scan(actors.WEBMASTER,dbRole),groups);
 const ownGroups=groups.filter(g=>g.records.some(r=>ids.includes(r.id)));
 const ic=ownGroups.filter(g=>g.match_type==='PATIENT IC');
 assert.equal(ic.length,2);
 assert.deepEqual(ic.map(g=>g.records.map(r=>r.id).sort()).sort(),[[a,same].sort(),[passport,passportSame].sort()].sort());
 for(const id of [sameEight,sameSix,sameLast,different,passportSuffix,blankA,blankB])assert.ok(!ic.some(g=>g.records.some(r=>r.id===id)));
 assert.deepEqual(ownGroups.find(g=>g.match_type==='MRN'&&g.match_value==='DUPE-SAME-MRN').records.map(r=>r.id).sort(),[blankA,blankB].sort());
 const serialized=JSON.stringify(groups);for(const value of [...full,...hashes])assert.ok(!serialized.includes(value),'Full identifier and keyed hash never returned');
 assert.doesNotMatch(serialized,/search_hash|search_key_id|ciphertext|nonce|envelope|normalization_version/);
 for(const g of ic){assert.equal(g.record_count,2);assert.ok(g.match_value.includes('*'));for(const r of g.records)assert.ok(r.patient_ic.includes('*'));}
 // Do not silently fall back to masks or hide false negatives across key domains.
 sql(`update orl_private.request_identity set search_key_id='search-v2' where request_id=${lit(a)}`);
 deny(()=>scan(),/Unable to verify full IC matches safely/);
 sql(`update orl_private.request_identity set search_key_id='search-v1' where request_id=${lit(a)}`);
 // Use an isolated transaction to simulate incomplete protected metadata. Always roll it back.
 deny(()=>sql(`begin;delete from orl_private.request_identity where request_id=${lit(a)};set local role anon;select public.orl_db_duplicates(${lit(actors.WEBMASTER)});rollback;`),/Unable to verify full IC matches safely/);
 assert.deepEqual(scan(),groups);
 const finalAudit=JSON.parse(run('security/release/audit-exact-duplicates.sql'));for(const ok of Object.values(finalAudit))assert.equal(ok,true);
});
