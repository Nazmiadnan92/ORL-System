import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=path=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
test('C3 release pins 049 and remains present under the later C6 cache',()=>{
  const migration=read('supabase/049_ic_c3_authorized_reveal.sql'),hash=createHash('sha256').update(Buffer.from(migration)).digest('hex').toUpperCase();
  const install=read('security/release/install-049.ps1'),html=read('docs/index.html'),app=read('docs/app.js');
  assert.match(install,new RegExp(hash));assert.ok(install.indexOf('pg_dump.exe')<install.indexOf('INSTALL 049'));
  assert.match(html,/app\.js\?v=082/);assert.match(app,/ic-client\.mjs\?v=078/);
  assert.doesNotMatch([migration,install,read('security/release/deploy-edge-c3.ps1')].join('\n'),/sb_secret_|service_role\s*[=:]\s*['"][A-Za-z0-9]/i);
});
test('C3 policy is role, password, purpose, expiry and value-free audit bound',()=>{
  const migration=read('supabase/049_ic_c3_authorized_reveal.sql'),app=read('docs/app.js');
  assert.match(migration,/ADMIN','WEBMASTER/);assert.match(migration,/extensions\.crypt/);assert.match(migration,/60 seconds/);
  for(const purpose of ['CLINICAL_VERIFICATION','PATIENT_IDENTIFICATION','DATA_CORRECTION'])assert.match(migration,new RegExp(purpose));
  assert.match(migration,/IC_FULL_REVEAL/);assert.doesNotMatch(migration,/details[^;]+patient_ic/is);
  assert.match(app,/document\.hidden/);assert.doesNotMatch(app,/localStorage\.setItem\([^\n]+patient_ic/i);
});
