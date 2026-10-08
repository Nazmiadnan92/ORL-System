import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('schedule baseline compatibility accepts only two reviewed exact hashes; the deployed difference is indentation-only',()=>{
 const extract=s=>s.match(/as \$\$([\s\S]*?)\$\$;/i)[1].replaceAll('\r','');
 const original=extract(read('supabase/020_year_based_ot_capacity.sql'));
 const deployed=extract(read('tests/ic-write/fixtures/schedule-020-deployed-indentation.sql'));
 const md5=s=>createHash('md5').update(s).digest('hex');
 assert.equal(md5(original),'a3466ebff4648c78b6f1582beffb7d3c');
 assert.equal(md5(deployed),'544c5dfd927bef55e7b53eb56b84c598');
 assert.equal(original.replace(/^[ \t]+/gm,''),deployed.replace(/^[ \t]+/gm,''));
 assert.notEqual(original,deployed);
 for(const file of ['security/release/install-057-058.ps1','supabase/058_six_special_slots_2027.sql']){
  assert.ok(read(file).includes("'a3466ebff4648c78b6f1582beffb7d3c','544c5dfd927bef55e7b53eb56b84c598'"),file);
 }
});
test('057+058 release is backup-first, reviewed, atomic and does not expose secrets or mutate patients during installation',()=>{
 const installer=read('security/release/install-057-058.ps1');
 for(const file of ['supabase/057_booking_move_requests.sql','supabase/058_six_special_slots_2027.sql','security/release/audit-booking-workflow.sql']){
  const hash=createHash('sha256').update(readFileSync(new URL('../../'+file,import.meta.url))).digest('hex').toUpperCase();assert.ok(installer.includes(hash),file);
 }
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 057 058'"));
 assert.ok(installer.indexOf("Read-Host 'Type INSTALL 057 058'")<installer.indexOf('$sql=[string]::Join'));
 assert.match(installer,/AsSecureString/);assert.match(installer,/sslmode=verify-full/);assert.match(installer,/--no-password/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.match(installer,/@\('begin;',\(Get-MigrationBody \$migration057\),\(Get-MigrationBody \$migration058\),'commit;'\)/);
 assert.doesNotMatch(installer,/PGSSLMODE\s*=\s*['"]?(?:disable|require)|pg_restore\.exe".*--dbname|PIN057|PIN058|PINAUDIT/);
 const capacity=read('supabase/058_six_special_slots_2027.sql');
 assert.doesNotMatch(capacity,/update\s+public\.orl_requests|delete\s+from\s+public\.orl_ot_slots/i);
 assert.match(capacity,/v_special:=6/);assert.match(capacity,/p_year>=2027/);
});
