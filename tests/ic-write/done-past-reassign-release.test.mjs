import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url);
const file=p=>new URL(p,root);
const read=p=>readFileSync(file(p),'utf8');
const normalize=value=>value.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
const digest=value=>createHash('sha256').update(value).digest('hex').toUpperCase();
const auditKeys=['reviewed_definitions','service_only_gateway','private_core','historical_correction_preserved','ordinary_past_booking_guard','ordinary_move_preserved','lifecycle_preserved','restore_preserved','browser_tables_closed','identity_tables_closed','recovery_ready','masked_read_preserved','ic_storage_preserved'];
const migrationPath='supabase/067_done_past_reassign.sql',auditPath='security/release/audit-done-past-reassign.sql';
const installerPath='security/release/install-067.ps1';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const pwshPath=()=>read('security/release/Pasang-067.cmd').match(/^"([^"]+pwsh\.exe)"/m)?.[1];

test('067 migration and audit are pinned; installation is atomic, private-backup-first, and explicit',()=>{
 const installer=normalize(read(installerPath)),sql=normalize(read(migrationPath));
 for(const path of [migrationPath,auditPath])assert.ok(installer.includes(digest(readFileSync(file(path)))),path+' hash must be pinned');
 assert.doesNotMatch(installer,/PENDING_REVIEWED_|PENDING_BASELINE_/);
 assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 assert.match(sql,/set local lock_timeout='5s'/);
 const blocks=[...sql.matchAll(/do \$baseline\$([\s\S]*?)end \$baseline\$;/g)];assert.equal(blocks.length,1);
 assert.doesNotMatch(blocks[0][1],/\b(?:insert\s+into|update|delete\s+from|truncate|alter\s+table)\s+(?:public|orl_private)\./i);
 assert.match(installer,/sslmode=verify-full/);
 assert.match(installer,/user=postgres\.imrfmilqehcrvassuvuw/);
 assert.match(installer,/Test-OrlReviewedCa -Path \$ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'/);
 assert.match(installer,/-AsSecureString/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.match(installer,/begin read only/);assert.match(installer,/if\(\$alreadyInstalled\)/);
 assert.match(installer,/Type INSTALL 067/);assert.match(installer,/-cne'INSTALL 067'/);
 assert.ok(installer.indexOf('BASELINE_067_OK')<installer.indexOf('pg_dump.exe'));
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf('pg_restore.exe'));
 assert.ok(installer.indexOf('pg_restore.exe')<installer.indexOf('Type INSTALL 067'));
 assert.ok(installer.indexOf('Type INSTALL 067')<installer.indexOf('-f $migration'));
 assert.doesNotMatch(installer,/pg_restore\.exe[^\n]*(?:--dbname|-d\s)/);
 assert.doesNotMatch(installer,/git\s+(?:tag|push)|functions\s+deploy|Get-FileHash|secrets\s+(?:list|set|unset)/);
 assert.match(installer,/ORL-Private-Backups/);assert.match(installer,/ORL-Release-Reports/);
 assert.match(installer,/project_ref='imrfmilqehcrvassuvuw'/);
 assert.match(installer,/--format=custom --file=\$partial --no-password/);
 assert.match(installer,/Move-Item -LiteralPath \$partial -Destination \$backupFile/);
 assert.match(installer,/Test-Path -LiteralPath \$backupFile/);assert.match(installer,/Test-Path -LiteralPath \$partial/);
 assert.match(read('.gitattributes'),/\/supabase\/067_done_past_reassign\.sql text eol=lf/);
 assert.match(read('.gitattributes'),/\/security\/release\/audit-done-past-reassign\.sql text eol=lf/);
 const installedBranch=installer.slice(installer.indexOf('if($alreadyInstalled)'),installer.indexOf('}else{'));
 assert.match(installedBranch,/\$audit=Get-ValidatedAudit/);
 assert.doesNotMatch(installedBranch,/pg_dump|pg_restore|-f \$migration/);
});

test('067 read-only audit pins reviewed core, protects the existing gateway, and emits exact booleans only',()=>{
 const audit=normalize(read(auditPath)),installer=normalize(read(installerPath)),sql=normalize(read(migrationPath));
 assert.match(audit,/begin read only;/);assert.match(audit,/rollback;/);
 assert.doesNotMatch(audit,/PENDING_|select\s+(?:\*|patient_name|patient_ic)\s+from|\bUPDATE\s+public\./i);
 const auditBody=audit.slice(audit.indexOf('select jsonb_build_object('));
 const keys=[...auditBody.matchAll(/^\s*'([a-z_]+)',/gm)].map(x=>x[1]);
 assert.deepEqual(keys.sort(),[...auditKeys].sort());
 for(const key of auditKeys)assert.ok(installer.includes("'"+key+"'"),key);
 assert.match(installer,/Compare-Object \(\$checks\|Sort-Object\)/);
 assert.match(installer,/\$result\.\$name-isnot\[bool\]/);
 assert.match(installer,/Get-InstallationState \$state/);
 let core=normalize(read('supabase/034_checked_slot_reassignment.sql')).match(/as \$\$([\s\S]*?)\$\$;/)[1];
 const apply=([,oldPart,newPart])=>{assert.equal(core.split(oldPart).length,2,'each reviewed patch occurs once');core=core.replace(oldPart,newPart)};
 const lifecycle=normalize(read('supabase/064_ot_hold_completion.sql'));
 const completionPatch=lifecycle.match(/\('public\.orl_swap_slots_checked\(uuid,uuid,uuid,uuid,uuid\)',\s*\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$\)/);
 assert.ok(completionPatch);apply(completionPatch);
 assert.equal(createHash('md5').update(core).digest('hex'),'f3d2b7af8df7434acaf2d53985a5e589');
 const previous=normalize(read('supabase/066_closed_past_reassign.sql'));
 const previousPatches=[...previous.matchAll(/\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$/g)];
 assert.equal(previousPatches.length,5);previousPatches.forEach(apply);
 assert.equal(createHash('md5').update(core).digest('hex'),'777efc10480acfbbfb44688322a370f5');
 const patches=[...sql.matchAll(/\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$/g)];
 assert.equal(patches.length,5);patches.forEach(apply);
 const md5=createHash('md5').update(core).digest('hex');
 assert.ok(audit.includes("'"+md5+"'"),'audit must pin exact new core');
 assert.ok(installer.includes("'"+md5+"'"),'already-installed detection must pin exact new core');
 assert.match(audit,/2b4d1a321a41bed78ff559b3ec542d19/,'protected gateway generation fence preserved');
 assert.match(audit,/public\.orl_ic_c1_reassign\(uuid,uuid,uuid,uuid,uuid,uuid\)/);
 assert.match(audit,/has_function_privilege\('service_role'/);
 assert.match(audit,/array\['anon','authenticated','service_role'\]/);
 assert.match(audit,/historical_correction_preserved/);assert.match(audit,/past_case_save/);
});

test('067 installer parses without connecting or executing installation',t=>{
 const pwsh=pwshPath();if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const script="$tokens=$null;$parseErrors=$null;[System.Management.Automation.Language.Parser]::ParseFile("+quote(fileURLToPath(file(installerPath)))+
  ",[ref]$tokens,[ref]$parseErrors)|Out-Null;if($parseErrors.Count){$parseErrors|ForEach-Object Message;exit 1};exit 0";
 execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000});
 assert.match(read('security/release/Pasang-067.cmd'),/install-067\.ps1/);
 assert.doesNotMatch(read('security/release/Pasang-067.cmd'),/install-06[56]|deploy-edge/);
});

test('067 state inspection fails closed on unknown, mixed, incomplete, and incorrectly typed metadata',t=>{
 const pwsh=pwshPath();if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const installer=normalize(read(installerPath));
 const stateFunction=installer.slice(installer.indexOf('function Get-InstallationState'),installer.indexOf('\ntry {'));
 const cases=[
  [{baseline:true,installed:false},'BASELINE'],[{baseline:false,installed:true},'INSTALLED'],
  [{baseline:false,installed:false},'REJECTED'],[{baseline:true,installed:true},'REJECTED'],
  [{baseline:'true',installed:false},'REJECTED'],[{baseline:false,installed:1},'REJECTED'],
  [{baseline:true},'REJECTED'],[{},'REJECTED'],[null,'REJECTED'],
  [{baseline:false,installed:true,unexpected:true},'REJECTED'],
 ];
 const script="$ErrorActionPreference='Stop';"+stateFunction+'\n$cases='+quote(JSON.stringify(cases.map(x=>x[0])))+
  "|ConvertFrom-Json -Depth 10; foreach($item in $cases){try{Get-InstallationState $item}catch{'REJECTED'}}";
 assert.deepEqual(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim().split(/\r?\n/),cases.map(x=>x[1]));
});

test('067 local file pin validation runs safely before any password prompt or network access',t=>{
 const pwsh=pwshPath();if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const installer=normalize(read(installerPath));
 const validation=installer.slice(installer.indexOf('function Get-ReviewedHash'),installer.indexOf('function Get-ValidatedAudit'));
 const script="$ErrorActionPreference='Stop';"+validation+'\n$migration='+quote(fileURLToPath(file(migrationPath)))+
  ';$auditFile='+quote(fileURLToPath(file(auditPath)))+";Test-ReviewedFiles;'VALID_REVIEWED_FILES'";
 assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),'VALID_REVIEWED_FILES');
 const tryBlock=installer.slice(installer.indexOf('\ntry {'));
 assert.ok(tryBlock.indexOf('Test-ReviewedFiles')<tryBlock.indexOf('Paste DATABASE password'));
});
