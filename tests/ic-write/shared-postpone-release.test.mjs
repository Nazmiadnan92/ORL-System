import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8').replaceAll('\r','');
const md5=s=>createHash('md5').update(s).digest('hex');

test('063 changes only shared Staff postpone; cross-owner fields/IC/Edit/assignment permissions stay protected',()=>{
 const migration=read('supabase/063_staff_shared_postpone.sql');
 const bodies=[...migration.matchAll(/\$newbody\$([\s\S]*?)\$newbody\$/g)].map(x=>x[1]);
 assert.equal(bodies.length,1);const body=bodies[0];
 assert.ok(migration.includes(md5(body)));
 assert.match(body,/if r\.created_by is distinct from u\.id then\s+--[^\n]+\n\s+safe_data:='\{\}'::jsonb;/);
 assert.match(body,/else\s+-- Preserve the existing clinical edit permission[\s\S]*'surgery',[\s\S]*'diagnosis',/);
 assert.match(body,/u\.role='STAFF' and b\.slot_type='SPECIAL' then raise exception/);
 assert.match(body,/p_reason is null or p_reason !~ '\[\^\[:space:\]\]' or length\(p_reason\)>4096/);
 assert.match(body,/p_reason:=orl_private\.c1_redact_text\(btrim\(p_reason\)\)/);
 assert.match(body,/new_status:=case when u\.role='STAFF' then 'RESERVED' else 'CONFIRMED' end/);
 assert.match(body,/postpone_count=postpone_count\+1/);assert.match(body,/'PATIENT_POSTPONED'/);
 assert.doesNotMatch(body,/set\s+created_by\s*=|created_by\s*=\s*u\.id/);
 assert.match(body,/where id=r\.id/);assert.match(body,/for update/);
 assert.match(body,/Past OT dates are closed/);assert.match(body,/b\.request_id is not null/);
 const outer=migration.replace(/\$newbody\$[\s\S]*?\$newbody\$/g,'');
 assert.doesNotMatch(outer,/(?:update|delete from|insert into|truncate|alter table)\s+(?:public|orl_private)\./i);
 assert.doesNotMatch(migration,/\bgrant\s/i);assert.match(migration,/proacl is not distinct from before_acl/);
 assert.match(migration,/orl_edit_scheduled_request_checked/);assert.match(migration,/orl_ic_c1_mutate/);
 const targets=[...migration.matchAll(/fn regprocedure:=to_regprocedure\('([^']+)'\)/g)].map(x=>x[1]);
 assert.deepEqual(targets,['public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)']);
});

test('063 installer pins files and requires hidden database password, valid TLS, backup and explicit confirmation',()=>{
 const installer=read('security/release/install-063.ps1');
 for(const file of ['supabase/063_staff_shared_postpone.sql','security/release/audit-shared-postpone.sql']){
  const sha=createHash('sha256').update(readFileSync(new URL('../../'+file,import.meta.url))).digest('hex').toUpperCase();
  assert.ok(installer.includes(sha),file+' hash pin');
 }
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 063'"));
 assert.ok(installer.indexOf("Read-Host 'Type INSTALL 063'")<installer.indexOf('-f $migration'));
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/Test-OrlReviewedCa/);
 assert.match(installer,/-AsSecureString/);assert.match(installer,/Count-ne13/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.doesNotMatch(installer,/pg_restore\.exe.*--dbname/);
 assert.match(installer,/\n'@\n \$lines=\$preflight/);
 assert.match(read('security/release/Pasang-063.cmd'),/install-063\.ps1/);
 const audit=read('security/release/audit-shared-postpone.sql');assert.match(audit,/begin read only;/);
 assert.match(audit,/'edit_permissions_preserved'/);assert.match(audit,/'mutation_guards_preserved'/);
});
