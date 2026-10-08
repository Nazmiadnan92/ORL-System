import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');

test('060 release changes only statistics detail scope with protected masking/session/ACL and backup-first hash-pinned installation',()=>{
 const migration=read('supabase/060_shared_statistics_patient_list.sql'),installer=read('security/release/install-060.ps1');
 for(const f of ['supabase/060_shared_statistics_patient_list.sql','security/release/audit-shared-statistics.sql']){
  assert.ok(installer.includes(createHash('sha256').update(readFileSync(new URL('../../'+f,import.meta.url))).digest('hex').toUpperCase()),f+' hash pin');
 }
 const replacements=[...migration.matchAll(/create or replace function\s+([\w.]+)/gi)].map(m=>m[1]);
 assert.deepEqual(replacements,['orl_private.c1_read_orl_subspecialty_statistics']);
 assert.doesNotMatch(migration,/(?:update|delete from|insert into|truncate|alter table)\s+(?:public|orl_private)\./i);
 assert.doesNotMatch(migration,/\bgrant\s|created_by\s*=\s*u\.id|u\.role\s+in\s*\(/i);
 assert.match(migration,/'scope','ALL_REQUESTS'/);assert.match(migration,/'row_scope','ALL_REQUESTS'/);
 assert.match(migration,/where r\.status<>'DRAFT'/);assert.match(migration,/limit 100 offset p_offset/);
 assert.match(migration,/u:=public\.orl_require_session\(p_session_token\)/);
 assert.match(migration,/revoke all on function orl_private\.c1_read_orl_subspecialty_statistics[\s\S]*from public,anon,authenticated,service_role/);
 const baseline=read('supabase/059_global_subspecialty_statistics.sql').match(/as \$\$([\s\S]*?)\$\$;/)[1].replaceAll('\r','');
 assert.equal(createHash('md5').update(baseline).digest('hex'),'904a7c884989c5fadc8411a7c1c9c2d7');
 assert.ok(migration.includes(createHash('md5').update(baseline).digest('hex')));
 assert.ok(installer.indexOf('pg_dump.exe')>=0&&installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 060'"));
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/AsSecureString/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.doesNotMatch(installer,/pg_restore\.exe.*--dbname|PGSSLMODE\s*=\s*['"]?(disable|require)/);
 assert.match(read('security/release/Pasang-060.cmd'),/install-060\.ps1/);
 assert.match(read('security/release/audit-shared-statistics.sql'),/begin read only;/i);
 assert.match(read('docs/index.html'),/clinical-features\.js\?v=064/);
 const ui=read('docs/clinical-features.js');assert.doesNotMatch(ui,/MY_REQUESTS|permitted records|limited to your requests/);
 assert.match(ui,/matching records/);
 const runner=read('tests/ic-write/run-c7-local.ps1');assert.match(runner,/if\(\$WithSharedStatistics\)\{\$WithStatistics=\$true\}/);
 assert.ok(runner.indexOf("'statistics-integration.test.mjs'")<runner.indexOf("'shared-statistics-integration.test.mjs'"));
});
