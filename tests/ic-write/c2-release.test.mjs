import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
test('C2 release pins migration and keeps secrets out of artifacts',()=>{
  const migration=read('supabase/048_ic_c2_controlled_legacy_backfill.sql');
  const hash=createHash('sha256').update(Buffer.from(migration)).digest('hex').toUpperCase();
  const install=read('security/release/install-048.ps1');
  assert.match(install,new RegExp(hash));assert.match(install,/pg_dump\.exe/);assert.match(install,/INSTALL 048/);
  assert.doesNotMatch([migration,install,read('security/release/run-c2.ps1')].join('\n'),/sb_secret_|service_role\s*[=:]\s*['"][A-Za-z0-9]/i);
});
test('C2 operator flow never auto-retries and keeps plaintext until C6',()=>{
  const run=read('security/release/run-c2.ps1'),migration=read('supabase/048_ic_c2_controlled_legacy_backfill.sql');
  assert.equal((run.match(/C2_BACKFILL/g)||[]).length,1);assert.equal((run.match(/C2_VERIFY';/g)||[]).length,1);
  assert.match(run,/do not repeat blindly/i);assert.match(migration,/Plaintext patient_ic remains in place/i);
  assert.doesNotMatch(migration,/update\s+public\.orl_requests\s+set\s+patient_ic\s*=/i);
});
test('placeholder correction is backup-first, exact-count guarded and value-free',()=>{
  const fix=read('security/release/clear-c2-placeholder.ps1');
  assert.match(fix,/count\(\*\)=1/);assert.match(fix,/character_length\(r\.patient_ic\)=1/);
  assert.match(fix,/pg_dump\.exe/);assert.ok(fix.indexOf('pg_dump.exe')<fix.indexOf('CLEAR PLACEHOLDER'));
  assert.match(fix,/IC_PLACEHOLDER_CLEARED/);assert.match(fix,/no identifier value logged/);
  assert.doesNotMatch(fix,/REQ-\d{4}-\d{6}/);
});
