import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=p=>new URL('../../'+p,import.meta.url),read=p=>readFileSync(file(p),'utf8');
const installer=read('security/release/install-069.ps1'),sql=read('supabase/069_exact_identity_duplicates.sql'),audit=read('security/release/audit-exact-duplicates.sql');
const sha=p=>createHash('sha256').update(readFileSync(file(p))).digest('hex').toUpperCase();
const pwsh=read('security/release/Pasang-069.cmd').match(/^"([^"]+pwsh\.exe)"/m)[1];
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const ps=body=>execFileSync(pwsh,['-NoProfile','-Command',body],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
test('069 pins an atomic definition-only repair without new grants or clinical mutations',()=>{
 for(const path of ['supabase/069_exact_identity_duplicates.sql','security/release/audit-exact-duplicates.sql'])assert.ok(installer.includes(sha(path)),path);
 assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 assert.equal((sql.match(/create or replace function/g)||[]).length,1);
 assert.match(sql,/create or replace function orl_private\.c1_read_orl_db_duplicates\(p_session_token uuid\)/);
 assert.match(sql,/returns jsonb language plpgsql stable security definer set search_path=''/);
 assert.match(sql,/u\.role is distinct from 'WEBMASTER'/);assert.match(sql,/public\.orl_require_session\(p_session_token\)/);
 assert.doesNotMatch(sql,/^\s*(?:update\s|delete\s+from|insert\s+into|truncate\s|alter\s+table|grant\s)/gmi);
 assert.match(sql,/group by i\.search_key_id,i\.normalization_version,i\.search_hash having count\(\*\)>1/);
 assert.doesNotMatch(sql,/group by.*(?:patient_ic|display_ic)/i);
 assert.match(sql,/orl_private\.c1_mask_ic\(r\.patient_ic\)/);
 assert.match(sql,/Unable to verify full IC matches safely/);
 const body=sql.match(/as \$\$([\s\S]*?)end \$\$;/)[1]+'end ';
 assert.ok(audit.includes(createHash('md5').update(body).digest('hex')),'Audit pins the exact new function body');
 assert.match(read('.gitattributes'),/\/supabase\/069_exact_identity_duplicates\.sql text eol=lf/);
});
test('069 installation is TLS verified, private backup first, explicit confirmation and no production restore or website/Edge deployment',()=>{
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/AsSecureString/);
 assert.match(installer,/807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA/);
 assert.ok(installer.indexOf('BASELINE_069_OK')<installer.indexOf('pg_dump.exe'));
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf('pg_restore.exe'));
 assert.ok(installer.indexOf('pg_restore.exe')<installer.indexOf('Type INSTALL 069'));
 assert.ok(installer.indexOf('Type INSTALL 069')<installer.indexOf('-f $migration'));
 assert.match(installer,/pg_restore\.exe" --list \$partial/);
 assert.doesNotMatch(installer,/pg_restore\.exe.*(?:--dbname|-d\s)|git\s+push|functions\s+deploy|secrets\s+(?:list|set)/);
 assert.match(installer,/Get-InstallationState \$state/);assert.match(installer,/if\(\$alreadyInstalled\)/);
 assert.match(installer,/ORL-069-SANITIZED-REPORT/);assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 const keys=[...audit.matchAll(/^ '([a-z_]+)',/gm)].map(x=>x[1]);assert.equal(keys.length,9);
 for(const key of keys)assert.ok(installer.includes("'"+key+"'"));
 assert.match(installer,/\$result\.\$name-isnot\[bool\]/);assert.match(installer,/Compare-Object/);
 assert.match(audit,/begin read only;/);assert.match(audit,/rollback;/);
});
test('069 PowerShell parses without running the installer; state classification rejects unknown or partial installs',()=>{
 const path=quote(fileURLToPath(file('security/release/install-069.ps1')));
 const pre=`$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${path},[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};$fn=$ast.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'Get-InstallationState'},$true);Invoke-Expression $fn.Extent.Text;`;
 assert.equal(ps(pre+`Get-InstallationState ([pscustomobject]@{core_md5='7c022fabe4bef2ec57c4106a5d9dcaf2';wrapper_md5='60420accafe98c044b39a803a74b1e42'})`),'BASELINE');
 assert.equal(ps(pre+`Get-InstallationState ([pscustomobject]@{core_md5='53e0a9fd59a00d257ad5fe02e442a400';wrapper_md5='60420accafe98c044b39a803a74b1e42'})`),'INSTALLED');
 for(const value of ['$null',"[pscustomobject]@{}", "[pscustomobject]@{core_md5=$true;wrapper_md5='60420accafe98c044b39a803a74b1e42'}","[pscustomobject]@{core_md5='unknown';wrapper_md5='60420accafe98c044b39a803a74b1e42'}","[pscustomobject]@{core_md5='53e0a9fd59a00d257ad5fe02e442a400';wrapper_md5='changed'}"]){
  assert.equal(ps(pre+`try{Get-InstallationState (${value});throw 'TEST ACCEPTED INVALID STATE'}catch{if($_.Exception.Message-eq'TEST ACCEPTED INVALID STATE'){exit 1};'REJECTED'}`),'REJECTED');
 }
});
test('069 read-only UI has Webmaster guard, retains masking and does not dispatch mutations',()=>{
 const app=read('docs/app.js'),body=app.slice(app.indexOf('async function dbDuplicates()'),app.indexOf('async function dbHealth()'));
 assert.match(body,/user\?\.role!=='WEBMASTER'/);assert.ok(body.indexOf("user?.role!=='WEBMASTER'")<body.indexOf("rpc('orl_db_duplicates'"));
 assert.deepEqual([...body.matchAll(/rpc\('([^']+)'/g)].map(x=>x[1]),['orl_db_duplicates']);
 assert.match(body,/maskPatientIc\(g.match_value\)/);assert.match(body,/separate operations/);
 assert.match(body,/owner!==token/);assert.match(body,/target!==\$\('#dbResults'\)/);
 assert.match(read('docs/index.html'),/app\.js\?v=094/);
});
