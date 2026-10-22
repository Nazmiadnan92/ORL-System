import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r/g,'');
const migration=read('supabase/071_pending_request_assignment.sql');
const functions=[...migration.matchAll(/create or replace function public\.(\w+)\(([^]*?)\)\nreturns ([^]*?) as \$\$([^]*?)\$\$;/g)];

test('071 changes only two assignment wrappers without rewriting core, data, identity or grants',()=>{
 assert.deepEqual(functions.map(m=>m[1]),['orl_booking_assign_view','orl_booking_assign_existing']);
 assert.doesNotMatch(migration,/\b(?:insert into|update|delete from|alter table|grant execute|revoke all)\s+(?:public|orl_private)\./i);
 assert.doesNotMatch(migration,/orl_db_export|orl_db_import|create[^\n]+orl_review_request|create[^\n]+orl_assign_slot/);
 assert.match(migration,/^begin;$/m);assert.match(migration,/^commit;$/m);
 for(const [,name,,header,body] of functions){
  assert.match(header,/language plpgsql security definer set search_path=''/);
  assert.match(body,/u:=public\.orl_require_session\(p_session_token\)/);
  assert.match(body,/u\.role not in\('ADMIN','WEBMASTER'\)/);
  assert.match(body,/r\.status not in\('CONFIRMED','APPROVED'\)/);
  assert.match(body,/r\.assigned_slot_id is not null/);
  assert.match(body,/r\.deletion_status<>'' or r\.ot_hold/);
  assert.match(body,/exists\(select 1 from public\.orl_ot_slots where request_id=r\.id\)/);
  const expected=name.endsWith('_view')?'22512869668d90879f91082d9899ace9':'db0893a9df012b4bd359b30b6bce1526';
  assert.equal(createHash('md5').update(body).digest('hex'),expected);
 }
});

test('071 keeps read protocol, exact stale/restore guards, canonical lock order and atomic approval',()=>{
 const view=functions[0][4],write=functions[1][4];
 for(const field of ['generation','request_version','request_id','patient_name','mrn','surgery','request_number','status'])assert.ok(view.includes(`'${field}'`));
 assert.match(view,/c1_redact_text\(r\.patient_name\)/);assert.doesNotMatch(view,/patient_ic/);
 assert.match(write,/c1_check_generation\(p_generation\)/);
 assert.match(write,/p_expected_version is null or r\.updated_at is distinct from p_expected_version/);
 const controls=write.indexOf('lock table public.orl_settings,public.orl_holidays,public.orl_ot_sessions,public.orl_ot_slots in row exclusive mode nowait');
 const target=write.indexOf('where id=p_target_slot for update');
 const request=write.indexOf('where id=p_request_id for update');
 const approve=write.indexOf("perform public.orl_review_request(p_session_token,p_request_id,'APPROVE','Approved while assigning an OT slot')");
 const assign=write.indexOf('return public.orl_assign_slot(p_session_token,p_request_id,p_target_slot)');
 assert.ok(controls>0&&controls<target&&target<request&&request<approve&&approve<assign);
 assert.match(write,/if r\.status='CONFIRMED' then[^]*?perform public\.orl_review_request[^]*?end if;/);
 assert.doesNotMatch(write,/exception\s+when|\bcommit\b|\brollback\b/i,'Assignment errors propagate to transaction rollback');
});

test('071 preflight is catalog-only and pins post-064 review plus unchanged assignment core',()=>{
 const baseline=migration.match(/do \$baseline\$([^]*?)end \$baseline\$;/)[1];
 assert.match(baseline,/orl_review_request\(uuid,uuid,text,text\)','eb02cd973d9cd40b054d6b00795a1508'/);
 assert.match(baseline,/orl_assign_slot\(uuid,uuid,uuid\)','b924d46e7bcac41332c9470521a72080'/);
 assert.match(baseline,/proconfig=array\[item\.configuration\]/);
 assert.match(baseline,/a\.grantee=0/);assert.match(baseline,/a\.is_grantable/);
 assert.doesNotMatch(baseline,/\b(?:from|join)\s+(?:public|orl_private)\./i);
 assert.doesNotMatch(baseline,/\bperform\s|c6_stats\(\)|c1_recovery_ready\(\)|\b(?:insert|update|delete)\s/i);
});
