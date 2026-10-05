import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('052 is pinned, backs up before install and never executes production restore',()=>{
  const sql=read('supabase/052_ic_c7_age_and_recovery.sql'),installer=read('security/release/install-052.ps1');
  const digest=createHash('sha256').update(sql).digest('hex').toUpperCase();
  assert.ok(installer.includes(digest));
  assert.match(sql,/md5\(source\) is distinct from item.expected_md5/);
  assert.match(sql,/where lease_id is not null/);
  assert.match(sql,/where request_id is not null/);
  assert.match(sql,/where id is not null/);
  assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf('Type INSTALL 052'));
  assert.match(installer,/--list \$partial/);assert.doesNotMatch(installer,/pg_restore.exe[^\n]+--dbname/);
});
test('C7 restore uses masked source plus authenticated plaintext hash, retained ACLs and isolated target',()=>{
  const s=read('security/release/verify-c7.ps1');
  assert.match(s,/Get-OrlC7Mask \$raw/);assert.match(s,/UTF8.GetString\(\$plain\)/);
  assert.match(s,/FixedTimeEquals\(\$actualHash,\$expectedHash\)/);
  assert.match(s,/Assert-OrlC7Audit \$liveAudit/);assert.match(s,/Assert-OrlC7Audit \$restoredAudit/);
  assert.match(s,/127.0.0.1/);assert.match(s,/--schema=public --schema=orl_private/);
  assert.doesNotMatch(s,/--no-acl/);assert.match(s,/Read-Host \$Prompt -AsSecureString/);
  assert.match(s,/\$localStatus.sessions-ne0/);assert.match(s,/StartsWith\(\$orlResolvedRoot/);
  assert.match(s,/Private error details are not printed/);
});
