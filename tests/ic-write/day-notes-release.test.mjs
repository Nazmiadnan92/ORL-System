import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=p=>new URL('../../'+p,import.meta.url),read=p=>readFileSync(file(p),'utf8');
const migrationPath='supabase/070_ot_day_notes.sql',auditPath='security/release/audit-day-notes.sql';
const installer=read('security/release/install-070.ps1'),sql=read(migrationPath),audit=read(auditPath);
const sha=p=>createHash('sha256').update(readFileSync(file(p))).digest('hex').toUpperCase();
const auditKeys=['reviewed_definitions','day_note_columns','day_note_constraints','day_note_rpc_grants','private_guards_closed','browser_tables_closed','identity_tables_closed','restore_preserved','recovery_ready','ic_storage_preserved'];
const pwsh=read('security/release/Pasang-070.cmd').match(/^"([^"]+pwsh\.exe)"/m)?.[1];
const quote=value=>"'"+value.replaceAll("'","''")+"'";

test('070 pins an atomic additive migration and metadata-only preflight',()=>{
 for(const path of [migrationPath,auditPath])assert.ok(installer.includes(sha(path)),path+' must be exactly pinned');
 assert.doesNotMatch(installer,/PENDING_REVIEWED_/);
 assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 const baseline=[...sql.matchAll(/do \$baseline\$([\s\S]*?)end \$baseline\$;/g)];assert.equal(baseline.length,1);
 assert.doesNotMatch(baseline[0][1],/\b(?:insert\s+into|update|delete\s+from|truncate|alter\s+table)\s+(?:public|orl_private)\./i);
 assert.match(sql,/set local lock_timeout=/);
 assert.match(sql,/create function public\.orl_get_ot_day_notes\(/);
 assert.match(sql,/create function public\.orl_set_ot_day_note\(/);
 assert.match(read('.gitattributes'),/\/supabase\/070_ot_day_notes\.sql text eol=lf/);
 assert.match(read('.gitattributes'),/\/security\/release\/audit-day-notes\.sql text eol=lf/);
});

test('070 installer requires verified TLS, private archive validation and explicit confirmation before migration',()=>{
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/-AsSecureString/);
 assert.match(installer,/Test-OrlReviewedCa -Path \$ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.ok(installer.indexOf('BASELINE_070_OK')<installer.indexOf('pg_dump.exe'));
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf('pg_restore.exe'));
 assert.ok(installer.indexOf('pg_restore.exe')<installer.indexOf('Type INSTALL 070'));
 assert.ok(installer.indexOf('Type INSTALL 070')<installer.indexOf('-f $migration'));
 assert.match(installer,/--format=custom --file=\$partial --no-password/);
 assert.match(installer,/pg_restore\.exe" --list \$partial/);
 assert.match(installer,/Move-Item -LiteralPath \$partial -Destination \$backupFile/);
 assert.match(installer,/Test-Path -LiteralPath \$backupFile/);
 assert.doesNotMatch(installer,/pg_restore\.exe[^\n]*(?:--dbname|-d\s)|git\s+push|functions\s+deploy|secrets\s+(?:list|set|unset)/);
 assert.match(installer,/ORL-Private-Backups/);assert.match(installer,/ORL-Release-Reports/);
 assert.match(installer,/ORL-070-SANITIZED-REPORT/);assert.match(installer,/project_ref='imrfmilqehcrvassuvuw'/);
 const already=installer.slice(installer.indexOf('if($alreadyInstalled)'),installer.indexOf('}else{'));
 assert.match(already,/\$audit=Get-ValidatedAudit/);assert.doesNotMatch(already,/pg_dump|pg_restore|-f \$migration/);
 assert.match(read('security/release/Pasang-070.cmd'),/install-070\.ps1/);
});

test('070 audit returns only the complete required boolean checks and pins both new RPC bodies',()=>{
 assert.match(audit,/begin read only;/);assert.match(audit,/rollback;/);
 assert.doesNotMatch(audit,/PENDING_|select\s+(?:\*|patient_name|patient_ic|day_note)\s+from|\bUPDATE\s+public\./i);
 const keys=[...audit.slice(audit.indexOf('select jsonb_build_object(')).matchAll(/^\s*'([a-z_]+)',/gm)].map(x=>x[1]);
 assert.deepEqual(keys.sort(),[...auditKeys].sort());
 for(const key of auditKeys)assert.ok(installer.includes("'"+key+"'"),key);
 assert.match(installer,/Compare-Object \(\$checks\|Sort-Object\)/);assert.match(installer,/\$result\.\$name-isnot\[bool\]/);
 for(const name of ['orl_get_ot_day_notes','orl_set_ot_day_note']){
  const fn=sql.match(new RegExp('create function public\\.'+name+'\\([\\s\\S]*?as \\$([a-z_]*)\\$([\\s\\S]*?)\\$\\1\\$;'));
  assert.ok(fn,name+' must have a reviewable body');
  assert.ok(audit.includes(createHash('md5').update(fn[2].replace(/\r/g,'')).digest('hex')),name+' audit must pin the exact body');
 }
 assert.match(audit,/has_function_privilege\(client,f,'EXECUTE'\)/);
 assert.match(audit,/orl_private\.c1_check_generation\(uuid\)/);
 assert.match(audit,/public\.orl_db_import_locked\(uuid,text,jsonb\)/);
});

test('070 installer rejects every partial presence state and malformed metadata without executing installation',t=>{
 if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const fn=installer.slice(installer.indexOf('function Get-InstallationState'),installer.indexOf('\ntry {'));
 const names=['has_day_note','has_day_note_revision','has_read_rpc','has_write_rpc'];
 const cases=Array.from({length:16},(_,mask)=>[
  Object.fromEntries(names.map((name,index)=>[name,!!(mask&(1<<index))])),mask===0?'BASELINE':mask===15?'INSTALLED':'REJECTED'
 ]);
 cases.push([null,'REJECTED'],[{},'REJECTED'],[{...cases[0][0],has_read_rpc:'false'},'REJECTED'],
  [{...cases[15][0],has_read_rpc:1},'REJECTED'],[{...cases[15][0],unexpected:true},'REJECTED']);
 const script="$ErrorActionPreference='Stop';"+fn+'\n$cases='+quote(JSON.stringify(cases.map(x=>x[0])))+
  "|ConvertFrom-Json -Depth 10;foreach($item in $cases){try{Get-InstallationState $item}catch{'REJECTED'}}";
 const actual=execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim().split(/\r?\n/);
 assert.deepEqual(actual,cases.map(x=>x[1]));
});

test('070 PowerShell parses without running installer or connecting to a database',t=>{
 if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const script="$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile("+
  quote(fileURLToPath(file('security/release/install-070.ps1')))+",[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object Message;exit 1};'PARSED_ONLY'";
 assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),'PARSED_ONLY');
});
