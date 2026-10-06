import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('054 is an ACL-only, backup-first, hash-pinned repair with no frontend deployment',()=>{
 const installer=read('security/release/install-054.ps1'),migration=read('supabase/054_session_helper_private.sql');
 for(const p of ['supabase/054_session_helper_private.sql','security/release/audit-session-helper.sql'])
  assert.ok(installer.includes(createHash('sha256').update(read(p)).digest('hex').toUpperCase()));
 assert.match(migration,/revoke all on function public\.orl_require_session\(uuid\) from public,anon,authenticated,service_role;/);
 assert.doesNotMatch(migration,/\b(?:update|delete from|insert into|create (?:or replace )?function|drop function)\b/i);
 assert.match(migration,/has_function_privilege/);assert.match(migration,/notify pgrst/);
 assert.match(installer,/#Requires -Version 7.4/);assert.match(installer,/-AsSecureString/);
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/Test-OrlReviewedCa/);
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 054'"));
 assert.match(installer,/--list \$partial/);assert.doesNotMatch(installer,/pg_restore.exe[^\n]+--dbname/);
 assert.match(installer,/\$env:PGPASSWORD=\$oldPassword;\$password=\$null/);
 const launcher=read('security/release/Pasang-054.cmd');assert.match(launcher,/pwsh.exe/);assert.doesNotMatch(launcher,/deploy-edge/);
});
