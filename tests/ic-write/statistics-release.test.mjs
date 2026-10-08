import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('059 release changes only aggregate scope and keeps private/masked boundaries; installer is hash-pinned and backup-first',()=>{
 const migration=read('supabase/059_global_subspecialty_statistics.sql'),installer=read('security/release/install-059.ps1');
 for(const f of ['supabase/059_global_subspecialty_statistics.sql','security/release/audit-global-statistics.sql'])assert.ok(installer.includes(createHash('sha256').update(readFileSync(new URL('../../'+f,import.meta.url))).digest('hex').toUpperCase()));
 assert.match(migration,/create or replace function orl_private\.c1_read_orl_subspecialty_statistics/);
 assert.doesNotMatch(migration,/create or replace function public\.|(?:update|delete from|insert into)\s+(?:public|orl_private)\./i);
 assert.match(migration,/select \* from selected where u\.role in\('ADMIN','WEBMASTER'\) or created_by=u\.id/);
 assert.match(migration,/'scope','ALL_REQUESTS'/);assert.match(migration,/'row_total',\(select count\(\*\) from permitted_rows\)/);
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 059'"));
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/AsSecureString/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.doesNotMatch(installer,/pg_restore\.exe.*--dbname|PGSSLMODE\s*=\s*['"]?(disable|require)/);
 const base=read('supabase/041_subspecialty_statistics.sql').match(/as \$\$([\s\S]*?)\$\$;/)[1].replaceAll('\r','').replace(/^[ \t]+/gm,'');
 assert.ok(migration.includes(createHash('md5').update(base).digest('hex')));
 assert.match(read('docs/index.html'),/clinical-features\.js\?v=064/);
});
