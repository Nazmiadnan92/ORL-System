import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

test('070: advisory Day Notes are role-gated, atomic, concurrent-safe, audited and preserved by protected backup/restore',async()=>{
 assert.equal(process.env.ORL_IC_TEST_C7,'1');assert.equal(process.env.ORL_IC_TEST_PORT,'55461');
 const database=process.env.ORL_IC_TEST_DATABASE;assert.match(database,/^orl_day_note_test_[a-z0-9_]+$/);
 const args=['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d',database,'-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['pipe','pipe','pipe']}).trim();
 const lit=v=>v==null?'NULL':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
 const run=p=>execFileSync(process.env.ORL_IC_TEST_PSQL,[...args,'-f',fileURLToPath(new URL('../../'+p,import.meta.url))],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 const call=(name,p,role='anon')=>`set role ${role};select public.${name}(${Object.entries(p).map(([k,v])=>`${k}=>${lit(v)}`).join(',')});`;
 const rpc=(name,p,role)=>JSON.parse(sql(call(name,p,role)));
 sql("do $$begin if session_user<>'orl_test_owner' or inet_server_addr() is distinct from '127.0.0.1'::inet or inet_server_port()<>55461 or current_database() !~ '^orl_day_note_test_' then raise exception 'Disposable local fixture only'; end if; end $$;");
 const variant=process.env.ORL_DAY_NOTE_EXPORT_VARIANT||'canonical';assert.ok(['canonical','deployed'].includes(variant));
 if(variant==='deployed')run('tests/ic-write/fixtures/backup-016-deployed-indentation.sql');
 const exporter='public.orl_db_export(uuid,text)';
 const exportFingerprint=()=>sql(`select jsonb_build_object('raw_body',prosrc,'security_definer',prosecdef,'configuration',proconfig,'acl',proacl,'owner',proowner) from pg_proc where oid=${lit(exporter)}::regprocedure`);
 const exporterBefore=exportFingerprint(),exportDefinition=sql(`select pg_get_functiondef(${lit(exporter)}::regprocedure)`);
 const expectedExportHash=variant==='canonical'?'685f55c7c5c33548eb79933d3beeb16d':'e3ca01db6ff28a4a095eaa5addf2e192';
 assert.equal(sql(`select md5(replace(prosrc,chr(13),'')) from pg_proc where oid=${lit(exporter)}::regprocedure`),expectedExportHash);
 const tables=JSON.parse(sql("select jsonb_agg(format('%I.%I',schemaname,tablename) order by schemaname,tablename) from pg_tables where schemaname in('public','orl_private')"));
 const snapshot=()=>sql("select md5(concat_ws('|',"+tables.map(t=>"(select md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'')) from "+t+" r)").join(',')+'))');
 const denied=(fn,pattern)=>{const before=snapshot();assert.throws(fn,error=>pattern.test(String(error.stderr||error.message)));assert.equal(snapshot(),before,'Denied action writes no data');};
 const migration=readFileSync(new URL('../../supabase/070_ot_day_notes.sql',import.meta.url),'utf8').replace(/^begin;\r?$/m,'-- outer transaction').replace(/^commit;\r?$/m,'-- outer transaction');
 for(const changed of [
  exportDefinition.replace("'version',1","'version',2"),
  exportDefinition.replace('declare u public.orl_users%rowtype;',' declare u public.orl_users%rowtype;'),
  `alter function ${exporter} security invoker;`,
  `alter function ${exporter} set search_path=pg_catalog;`,
  ...['public','anon','authenticated','service_role'].map(role=>`grant execute on function ${exporter} to ${role};`)
 ]){
  assert.notEqual(changed,exportDefinition,'Synthetic unsupported variant differs');
  denied(()=>sql('begin;\n'+changed+';\n'+migration+'\nrollback;'),/baseline differs|protected permissions differ/);
  assert.equal(exportFingerprint(),exporterBefore,'Rejected installation leaves exporter body/config/grants byte-identical');
  assert.equal(sql("select count(*) from pg_attribute where attrelid='public.orl_ot_sessions'::regclass and attname in('day_note','day_note_revision') and not attisdropped"),'0');
 }
 const oldRows=sql("select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_sessions s");
 const importFn='public.orl_db_import_locked(uuid,text,jsonb)',readFn='public.orl_get_ot_day_notes(uuid,integer)',writeFn='public.orl_set_ot_day_note(uuid,uuid,text,bigint,uuid)';
 const untouchedFunctions=()=>sql(`select md5(jsonb_agg(to_jsonb(p) order by p.oid)::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','orl_private') and p.proname not in('orl_get_ot_day_notes','orl_set_ot_day_note') and p.oid<>${lit(importFn)}::regprocedure`);
 const oldFns=untouchedFunctions();
 const original=sql(`select pg_get_functiondef(${lit(importFn)}::regprocedure)`);
 sql(original.replace('request_total integer:=0;','request_total integer:=0; /* synthetic drift */'));
 denied(()=>run('supabase/070_ot_day_notes.sql'),/baseline differs/);sql(original);
 run('supabase/070_ot_day_notes.sql');
 assert.equal(exportFingerprint(),exporterBefore,'070 leaves the exact reviewed exporter untouched');
 assert.equal(sql("select jsonb_agg(to_jsonb(s)-'day_note'-'day_note_revision' order by id) from public.orl_ot_sessions s"),oldRows,'Installation preserves every prior session field');
 assert.equal(untouchedFunctions(),oldFns,'No unrelated function or grant changed');
 assert.equal(sql("select count(*) from public.orl_ot_sessions where day_note<>'' or day_note_revision<>0"),'0');
 denied(()=>run('supabase/070_ot_day_notes.sql'),/already exists/);
 for(const role of ['anon','authenticated']){
  assert.equal(sql(`select has_function_privilege(${lit(role)},${lit(readFn)},'EXECUTE') and has_function_privilege(${lit(role)},${lit(writeFn)},'EXECUTE')`),'t');
  denied(()=>sql(`set role ${role};select day_note from public.orl_ot_sessions`),/permission denied/);
 }
 for(const fn of [readFn,writeFn])assert.equal(sql(`select has_function_privilege('service_role',${lit(fn)},'EXECUTE')`),'f');
 const actors={},password='Synthetic-070-password';
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const id=actors[role]=crypto.randomUUID();
  sql(`insert into public.orl_users(id,username,password_hash,display_name,role) values(${lit(id)},${lit('day_note_'+role+'_'+id.slice(0,8))},extensions.crypt(${lit(password)},extensions.gen_salt('bf',4)),${lit('Synthetic '+role)},${lit(role)});insert into public.orl_sessions(user_id,token_hash,expires_at) values(${lit(id)},encode(extensions.digest(${lit(id)},'sha256'),'hex'),now()+interval '1 hour')`);
 }
 sql('update orl_private.site_maintenance set enabled=false where singleton');
 const id=crypto.randomUUID(),other=crypto.randomUUID();
 sql(`insert into public.orl_ot_sessions(id,ot_date,day_name,status,note,special_title,holiday_override) values(${lit(id)},'2099-02-20','Synthetic','CANCELLED','Cancellation preserved','Title preserved',true),(${lit(other)},'2098-02-20','Synthetic','ACTIVE','','',false)`);
 const generation=()=>sql('select generation from orl_private.c1_restore_generation where singleton');
 const read=(role='STAFF',extra={},dbRole)=>rpc('orl_get_ot_day_notes',{p_session_token:actors[role],p_year:2099,...extra},dbRole);
 const current=()=>JSON.parse(sql(`select to_jsonb(s) from public.orl_ot_sessions s where id=${lit(id)}`));
 const params=(note,role='ADMIN',extra={})=>({p_session_token:actors[role],p_session_id:id,p_note:note,p_expected_revision:current().day_note_revision,p_generation:generation(),...extra});
 const save=p=>rpc('orl_set_ot_day_note',p);
 const events=()=>JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]'::jsonb) from public.orl_audit_log a where action like 'OT_DAY_NOTE_%' and record_id=${lit(id)}`));
 const clinical=(restored=false)=>sql("select md5(concat_ws('|',(select jsonb_agg(to_jsonb(r) order by id)::text from public.orl_requests r),(select jsonb_agg(to_jsonb(s) order by id)::text from public.orl_ot_slots s),(select jsonb_agg("+(restored?"to_jsonb(i)-'created_at'-'updated_at'":"to_jsonb(i)")+" order by request_id)::text from orl_private.request_identity i)))");
 const clinicalBefore=clinical(),clinicalRestoreBefore=clinical(true),sessionBefore=current(),frozen=snapshot();
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const result=read(role);assert.equal(result.generation,generation());
  assert.deepEqual(result.notes.find(n=>n.session_id===id),{session_id:id,ot_date:'2099-02-20',day_note:'',revision:0});
  assert.ok(!result.notes.some(n=>n.session_id===other));
  assert.doesNotMatch(JSON.stringify(result),/patient|password|token|cancel|Title preserved/i);
 }
 assert.equal(snapshot(),frozen,'Read creates no sessions/slots/audit');
 assert.deepEqual(read('STAFF',{},'authenticated'),read());
 for(const p of [{p_session_token:null},{p_session_token:crypto.randomUUID()},{p_year:2025},{p_year:2101},{p_year:null}])denied(()=>read('STAFF',p),/expired|Invalid year/);
 denied(()=>save(params('Denied','STAFF')),/Admin or Webmaster/);
 for(const extra of [{p_note:null},{p_note:'x'.repeat(501)},{p_note:'invalid\u0001control'},{p_expected_revision:null},{p_expected_revision:-1},{p_expected_revision:9007199254740992},{p_session_id:null},{p_session_id:crypto.randomUUID()},{p_generation:null},{p_generation:crypto.randomUUID()},{p_expected_revision:1}])denied(()=>save(params('No Otology cases', 'ADMIN',extra)),/required|changed|Restore/);
 const add=save(params('  No Otology cases on this date.  '));assert.equal(add.day_note,'No Otology cases on this date.');assert.equal(add.changed,true);assert.equal(add.revision,1);
 const noChange=snapshot();assert.equal(save(params(add.day_note)).changed,false);assert.equal(snapshot(),noChange,'No-op does not bump revision or audit');
 const stale=params('An old draft');save(params('Discuss with consultant','WEBMASTER'));denied(()=>save(stale),/changed/);
 assert.equal(save(params('  consultant\r\nSpecial arrangement\rnext\t  ')).day_note,'consultant\nSpecial arrangement\nnext','CRLF/tabs normalize without trimming ending n/t letters');
 const redacted=save(params('Do not include 900101-01-1234 in notes'));assert.ok(!redacted.day_note.includes('900101-01-1234'));
 assert.ok(!JSON.stringify(events()).includes('900101-01-1234'));
 assert.equal(save(params('x'.repeat(500))).day_note.length,500);
 const removed=save(params(' \t\r\n '));assert.equal(removed.day_note,'');assert.equal(removed.changed,true);
 assert.equal(events()[0].action,'OT_DAY_NOTE_ADDED');assert.equal(events().at(-1).action,'OT_DAY_NOTE_REMOVED');assert.ok(events().some(e=>e.action==='OT_DAY_NOTE_UPDATED'));
 assert.deepEqual(Object.fromEntries(Object.entries(current()).filter(([k])=>!['day_note','day_note_revision'].includes(k))),Object.fromEntries(Object.entries(sessionBefore).filter(([k])=>!['day_note','day_note_revision'].includes(k))),'Only note and its revision change');
 assert.equal(clinical(),clinicalBefore,'Notes never move or alter patients/slots/identities');
 // Audit insertion and note update must commit or roll back together.
 sql("create function public.synthetic_070_audit_fail() returns trigger language plpgsql as $$begin if new.action like 'OT_DAY_NOTE_%' then raise exception 'Synthetic audit unavailable'; end if;return new;end$$;create trigger synthetic_070_audit_fail before insert on public.orl_audit_log for each row execute function public.synthetic_070_audit_fail()");
 denied(()=>save(params('Must roll back')),/Synthetic audit unavailable/);
 sql('drop trigger synthetic_070_audit_fail on public.orl_audit_log;drop function public.synthetic_070_audit_fail()');
 // Session validation and maintenance are authoritative for reads and writes.
 for(const change of ['is_active=false','must_change_password=true']){
  sql(`update public.orl_users set ${change} where id=${lit(actors.ADMIN)}`);
  denied(()=>read('ADMIN'),/expired|Password change/);denied(()=>save(params('Denied')),/expired|Password change/);
  sql(`update public.orl_users set is_active=true,must_change_password=false where id=${lit(actors.ADMIN)}`);
 }
 sql(`update public.orl_sessions set expires_at=now()-interval '1 minute' where user_id=${lit(actors.STAFF)}`);denied(()=>read(),/expired/);
 sql(`update public.orl_sessions set expires_at=now()+interval '1 hour' where user_id=${lit(actors.STAFF)}`);
 sql('update orl_private.site_maintenance set enabled=true where singleton');
 denied(()=>read(),/ORL_MAINTENANCE/);denied(()=>save(params('Denied')),/ORL_MAINTENANCE/);
 assert.ok(read('WEBMASTER').notes.length);save(params('Allowed during maintenance','WEBMASTER'));
 sql('update orl_private.site_maintenance set enabled=false where singleton');
 // Existing restore fence and a locked date fail promptly, never blind-retry.
 async function compete(lock,attempt,pattern){
  const holder=spawn(process.env.ORL_IC_TEST_PSQL,args,{stdio:['pipe','pipe','pipe']});let output='',error='';
  const ready=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Local lock fixture timeout')),8000);holder.stdout.on('data',d=>{output+=d;if(output.includes('DAY_NOTE_LOCKED')){clearTimeout(timeout);resolve()}});holder.stderr.on('data',d=>error+=d);holder.on('error',reject)});
  const done=new Promise(resolve=>holder.on('close',code=>resolve(code)));
  holder.stdin.write(`begin;${lock};select 'DAY_NOTE_LOCKED';\n`);
  try{await ready;denied(attempt,pattern)}finally{holder.stdin.end('rollback;\n');assert.equal(await done,0,error)}
 }
 await compete(`select 1 from public.orl_ot_sessions where id=${lit(id)} for update`,()=>save(params('Concurrent denied')),/lock|obtain/i);
 await compete("select pg_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0))",()=>save(params('Restore denied')),/Restore is running/);
 await compete("select pg_advisory_xact_lock(hashtextextended('orl_ic_restore_generation',0))",()=>read(),/Restore is running/);
 // The export path is unchanged and includes both columns. A protected v3
 // round-trip preserves notes; earlier v3 files without the fields still work.
 const preserved=save(params('No Otology cases; discuss with consultant','WEBMASTER'));
 const exportBackup=()=>rpc('orl_ic_c1_export',{p_session_token:actors.WEBMASTER,p_password:password},'service_role');
 const importBackup=backup=>rpc('orl_ic_c1_import',{p_session_token:actors.WEBMASTER,p_password:password,p_backup:backup},'service_role');
 const backup=exportBackup(),savedSession=backup.ot_sessions.find(s=>s.id===id);
 assert.equal(savedSession.day_note,preserved.day_note);assert.equal(savedSession.day_note_revision,preserved.revision);
 for(const invalid of [{day_note:null},{day_note:4},{day_note:'x'.repeat(501)},{day_note_revision:null},{day_note_revision:'1'},{day_note_revision:-1},{day_note_revision:1.5},{day_note_revision:9007199254740992}]){
  const bad=structuredClone(backup);Object.assign(bad.ot_sessions.find(s=>s.id===id),invalid);
  denied(()=>importBackup(bad),/Day Note|invalid input/);
 }
 const oldDraft=params('Stale after restore','WEBMASTER');importBackup(backup);
 assert.equal(current().day_note,preserved.day_note);assert.equal(current().day_note_revision,preserved.revision);denied(()=>save(oldDraft),/Restore/);
 const legacy=structuredClone(backup);for(const s of legacy.ot_sessions){delete s.day_note;delete s.day_note_revision}importBackup(legacy);
 assert.equal(current().day_note,'');assert.equal(current().day_note_revision,0);
 importBackup(backup);assert.equal(current().day_note,preserved.day_note);assert.equal(current().day_note_revision,preserved.revision);
 // Existing protected Restore rebuilds the identity storage timestamps, but
 // all clinical records, slots and encrypted identity contents must match.
 assert.equal(clinical(true),clinicalRestoreBefore,'Backup/restore preserves original clinical records and protected contents');
 assert.equal(exportFingerprint(),exporterBefore,'All operations and Restore leave the exporter unchanged');
 const audit=JSON.parse(run('security/release/audit-day-notes.sql'));assert.equal(Object.keys(audit).length,10);for(const [name,ok] of Object.entries(audit))assert.equal(ok,true,variant+' audit: '+name);
 const hashes=JSON.parse(sql(`select jsonb_object_agg(oid::regprocedure::text,md5(replace(prosrc,chr(13),''))) from pg_proc where oid in(${[readFn,writeFn,importFn].map(x=>lit(x)+'::regprocedure').join(',')})`));
 console.log('070 verified function hashes:',JSON.stringify(hashes));
});
