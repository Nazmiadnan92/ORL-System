import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');

test('055 repairs only the reviewed masker and preserves fail-closed browser guards',()=>{
 const migration=read('supabase/055_postpone_record_version.sql');
 assert.match(migration,/29dbcc17a7b810c7e553b3c414a3873b/);
 assert.match(migration,/jsonb_build_object\('_ic_edit_version',r.updated_at\)/);
 assert.match(migration,/where r.id=\(p_value->>'request_id'\)::uuid/);
 assert.match(migration,/has_function_privilege/);assert.match(migration,/notify pgrst/);
 assert.doesNotMatch(migration,/\b(?:update\s+public|delete\s+from|insert\s+into|grant\s+execute|drop\s+function)\b/i);
 assert.match(read('docs/app.js'),/form\._icEditVersion=record\._ic_edit_version/);
 assert.match(read('docs/ic-client.mjs'),/typeof args.p_expected_version!=='string'/);
 assert.match(read('docs/ic-client.mjs'),/record version is missing/);
});
test('055 installer is backup-first, TLS verified, privately prompted and hash-pinned',()=>{
 const installer=read('security/release/install-055.ps1');
 for(const p of ['supabase/055_postpone_record_version.sql','security/release/audit-postpone-version.sql'])
  assert.ok(installer.includes(createHash('sha256').update(read(p)).digest('hex').toUpperCase()),p);
 assert.match(installer,/#Requires -Version 7.4/);assert.match(installer,/-AsSecureString/);
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/Test-OrlReviewedCa/);
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 055'"));
 assert.match(installer,/--list \$partial/);assert.doesNotMatch(installer,/pg_restore.exe[^\n]+--dbname/);
 assert.match(installer,/\$env:PGPASSWORD=\$oldPassword;\$password=\$null/);
 assert.match(read('security/release/Pasang-055.cmd'),/pwsh.exe/);
 const audit=read('security/release/audit-postpone-version.sql');
 assert.match(audit,/begin read only/);assert.match(audit,/rollback;/);
 assert.match(audit,/exact_record_versions/);assert.match(audit,/recursive_versions/);
 assert.doesNotMatch(audit,/orl_get_schedule/); // schedule reads may prepare slots
});
