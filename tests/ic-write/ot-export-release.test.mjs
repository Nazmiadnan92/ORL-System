import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('053 installer pins reviewed files, backs up before confirmation, never restores production',()=>{
 const installer=read('security/release/install-053.ps1');
 for(const path of ['supabase/053_ot_list_full_ic_export.sql','security/release/audit-ot-export.sql'])
  assert.ok(installer.includes(createHash('sha256').update(read(path)).digest('hex').toUpperCase()));
 assert.match(installer,/#Requires -Version 7.4/);assert.match(installer,/Read-Host 'Paste DATABASE password \(hidden\)' -AsSecureString/);
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/Test-OrlReviewedCa/);
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf('Type INSTALL 053'));
 assert.match(installer,/--list \$partial/);assert.doesNotMatch(installer,/pg_restore.exe[^\n]+--dbname/);
 assert.match(installer,/\$env:PGPASSWORD=\$oldPassword;\$password=\$null/);
 const sql=read('supabase/053_ot_list_full_ic_export.sql');
 assert.doesNotMatch(sql,/\b(?:update|delete from|insert into) public\.orl_requests/i);
 assert.match(sql,/OT_LIST_FULL_IC_GENERATED/);
 assert.match(sql,/revoke all on function public.orl_ic_ot_export_commit/);
});
test('release uses same Generate button and bumped module caches, with full IC only in audited Excel path',()=>{
 assert.match(read('docs/index.html'),/app\.js\?v=081/);assert.match(read('docs/index.html'),/ot-excel\.js\?v=068/);
 assert.match(read('docs/app.js'),/ic-client\.mjs\?v=078/);
 const s=read('docs/ot-excel.js');
 assert.match(s,/fullIc=false/);assert.match(s,/orl_ic_ot_export/);
 assert.match(s,/buildOtExcel\(template,result.session,result.patients,\{fullIc:true\}\)/);
 assert.match(s,/p.patient_ic=''/);assert.doesNotMatch(s,/localStorage|sessionStorage|console\./);
});
