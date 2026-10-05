import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('051 repair pins the reviewed baseline and installer, and leaves cutover operator-controlled',()=>{
  const migration=read('supabase/051_ic_c6_scoped_updates.sql');
  const install=read('security/release/install-051.ps1');
  const original=read('supabase/050_ic_c6_plaintext_cutover.sql').replaceAll('\r','');
  const body=original.match(/create function public\.orl_ic_c6_cutover\([\s\S]*?as \$\$([\s\S]*?)\$\$;/)[1];
  assert.ok(migration.includes(createHash('md5').update(body).digest('hex')));
  assert.ok(install.includes(createHash('sha256').update(migration).digest('hex').toUpperCase()));
  assert.ok(install.indexOf('pg_dump.exe')<install.indexOf('INSTALL 051'));
  assert.doesNotMatch(migration,/safeupdate\s*=|set\s+.*safeupdate|where\s+true/i);
  assert.doesNotMatch(install,/select\s+public\.orl_ic_c6_cutover\s*\(/i);
});
test('C6 release pins migration 050, backs up first and requires explicit cutover phrase',()=>{
  const migration=read('supabase/050_ic_c6_plaintext_cutover.sql'),hash=createHash('sha256').update(Buffer.from(migration)).digest('hex').toUpperCase();
  const install=read('security/release/install-050.ps1'),run=read('security/release/run-c6.ps1');
  assert.match(install,new RegExp(hash));assert.ok(install.indexOf('pg_dump.exe')<install.indexOf('INSTALL 050'));
  assert.match(run,/REMOVE PLAINTEXT/);assert.match(run,/C2_VERIFY_START/);assert.match(run,/C2_FINALIZE/);assert.match(run,/C6_CUTOVER/);
  assert.doesNotMatch([migration,install,run].join('\n'),/sb_secret_|service_role\s*[=:]\s*['"][A-Za-z0-9]/i);
});
test('C6 migration and gateway keep exact identity in ciphertext, hash exact search and publish cache 078',()=>{
  const migration=read('supabase/050_ic_c6_plaintext_cutover.sql'),gateway=read('supabase/functions/_shared/c1/gateway.mjs');
  const html=read('docs/index.html'),app=read('docs/app.js');
  assert.match(migration,/patient_ic=orl_private\.c1_mask_ic\(patient_ic\)/);assert.match(migration,/plaintext_rows/);
  assert.match(migration,/ORL_IC_ENCRYPTED_V1/);assert.match(gateway,/prepareC6Backup/);assert.match(gateway,/searchHash/);
  assert.match(html,/app\.js\?v=078/);assert.match(app,/ic-client\.mjs\?v=078/);
  assert.doesNotMatch(gateway,/console\.(?:log|error)[^\n]*patient_ic/i);
});
