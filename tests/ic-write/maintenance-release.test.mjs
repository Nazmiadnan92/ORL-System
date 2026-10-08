import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('maintenance deployment is backup first, hash pinned, OFF and contains no patient mutation',()=>{
 const installer=read('security/release/install-056.ps1'),sql=read('supabase/056_webmaster_maintenance.sql');
 for(const path of ['supabase/056_webmaster_maintenance.sql','security/release/audit-maintenance.sql'])assert.ok(installer.includes(createHash('sha256').update(read(path)).digest('hex').toUpperCase()),path);
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 056'"));
 assert.match(installer,/-AsSecureString/);assert.match(installer,/sslmode=verify-full/);assert.match(installer,/#Requires -Version 7.4/);
 assert.match(sql,/enabled boolean not null default false/);assert.match(sql,/for share/);assert.match(sql,/for update/);
 assert.match(sql,/c1_recovery_ready/);assert.match(sql,/c1_require_session_core/);assert.match(sql,/orl_require_webmaster_password/);
 assert.match(sql,/p_expected_revision/);assert.match(sql,/MAINTENANCE_ON/);assert.match(sql,/MAINTENANCE_OFF/);
 assert.doesNotMatch(sql,/(?:update|delete from|insert into) (?:public.orl_requests|orl_private.request_identity)/i);
 const html=read('docs/index.html');assert.match(html,/app\.js\?v=083/);assert.match(html,/maintenance\.js\?v=005/);assert.match(html,/maintenance\.css\?v=003/);assert.match(html,/portal\.css\?v=001/);
 const app=read('docs/app.js');assert.match(app,/maintenance\?\.before\(name\)/);assert.match(app,/maintenance\?\.after\(name\)/);assert.match(app,/mountSettings\(c\)/);
});
