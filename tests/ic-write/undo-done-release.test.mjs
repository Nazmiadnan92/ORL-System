import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../../',import.meta.url);
const file=p=>new URL(p,root);
const read=p=>readFileSync(file(p),'utf8');
const normalize=value=>value.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
const digest=value=>createHash('sha256').update(value).digest('hex').toUpperCase();
const auditKeys=['reviewed_definitions','undo_done_service_only','service_only_gateway','private_core','historical_correction_preserved','ordinary_past_booking_guard','ordinary_move_preserved','lifecycle_preserved','restore_preserved','browser_tables_closed','identity_tables_closed','recovery_ready','masked_read_preserved','ic_storage_preserved'];
const migrationPath='supabase/068_undo_done.sql',auditPath='security/release/audit-undo-done.sql';
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const pwshPath=()=>read('security/release/Pasang-068.cmd').match(/^"([^"]+pwsh\.exe)"/m)?.[1];

test('068 migration and audit are exactly pinned, atomic and installed only after private backup and explicit confirmation',()=>{
 const installer=normalize(read('security/release/install-068.ps1')),sql=normalize(read(migrationPath));
 for(const path of [migrationPath,auditPath])assert.ok(installer.includes(digest(readFileSync(file(path)))),path+' hash must be pinned');
 assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 assert.match(sql,/set local lock_timeout='5s'/);assert.match(sql,/do \$baseline\$/);
 const blocks=[...sql.matchAll(/do \$baseline\$([\s\S]*?)end \$baseline\$;/g)];assert.equal(blocks.length,1);
 assert.doesNotMatch(blocks[0][1],/\b(?:insert\s+into|update|delete\s+from|truncate|alter\s+table)\s+(?:public|orl_private)\./i);
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/Test-OrlReviewedCa -Path \$ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'/);
 assert.match(installer,/-AsSecureString/);assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.match(installer,/begin read only/);assert.match(installer,/if\(\$alreadyInstalled\)/);assert.match(installer,/Type INSTALL 068/);
 assert.match(installer,/Get-InstallationState \$state/);
 assert.ok(installer.indexOf('BASELINE_068_OK')<installer.indexOf('pg_dump.exe'));
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf('pg_restore.exe'));
 assert.ok(installer.indexOf('pg_restore.exe')<installer.indexOf('Type INSTALL 068'));
 assert.ok(installer.indexOf('Type INSTALL 068')<installer.indexOf('-f $migration'));
 assert.doesNotMatch(installer,/pg_restore\.exe[^\n]*(?:--dbname|-d\s)/);
 assert.doesNotMatch(installer,/git\s+tag|functions\s+deploy|Get-FileHash|secrets\s+(?:list|set|unset)/);
 assert.match(installer,/ORL-Private-Backups/);assert.match(installer,/ORL-Release-Reports/);
 assert.match(installer,/project_ref='imrfmilqehcrvassuvuw'/);
 assert.match(installer,/--format=custom --file=\$partial --no-password/);
 assert.match(installer,/Move-Item -LiteralPath \$partial -Destination \$backupFile/);
 assert.match(installer,/Test-Path -LiteralPath \$backupFile/);
 assert.match(read('.gitattributes'),/\/supabase\/068_undo_done\.sql text eol=lf/);
 assert.match(read('.gitattributes'),/\/security\/release\/audit-undo-done\.sql text eol=lf/);
});

test('068 release audit is sanitized and requires every expected named boolean check',()=>{
 const audit=normalize(read(auditPath)),installer=normalize(read('security/release/install-068.ps1'));
 assert.match(audit,/begin read only;/);assert.match(audit,/rollback;/);
 assert.doesNotMatch(audit,/PENDING_|select\s+(?:\*|patient_name|patient_ic)\s+from|\bUPDATE\s+public\./i);
 const auditBody=audit.slice(audit.indexOf('select jsonb_build_object('));
 const keys=[...auditBody.matchAll(/^\s*'([a-z_]+)',/gm)].map(x=>x[1]);
 assert.deepEqual(keys.sort(),[...auditKeys].sort());
 for(const key of auditKeys)assert.ok(installer.includes("'"+key+"'"),key);
 assert.match(installer,/Compare-Object \(\$checks\|Sort-Object\)/);
 assert.match(installer,/\$result\.\$name-isnot\[bool\]/);
 assert.match(installer,/has_undo_done.*orl_ic_undo_done\(uuid,text,uuid,uuid,text,uuid,timestamptz\)/);
 assert.doesNotMatch(installer,/PENDING_REVIEWED_/);
 const sql=normalize(read(migrationPath));
 const fn=sql.match(/create function public\.orl_ic_undo_done\([\s\S]*?as \$([a-z_]*)\$([\s\S]*?)\$\1\$;/);
 assert.ok(fn,'New protected Undo Done endpoint must have a reviewable body');
 const md5=createHash('md5').update(fn[2]).digest('hex');assert.ok(audit.includes("'"+md5+"'"));
 assert.match(sql,/revoke all on function public\.orl_ic_undo_done\(uuid,text,uuid,uuid,text,uuid,timestamptz\) from public,anon,authenticated,service_role/);
 assert.match(sql,/grant execute on function public\.orl_ic_undo_done\(uuid,text,uuid,uuid,text,uuid,timestamptz\) to service_role/);
 assert.match(sql,/u:=public\.orl_require_webmaster_password\(p_session_token,p_password\)/);
 assert.match(sql,/perform orl_private\.c1_check_generation\(p_generation\)/);
 assert.match(sql,/r\.updated_at is distinct from p_expected_version/);
});

test('068 installer classifies only exact boolean presence metadata; installed state still requires full audit',t=>{
 const pwsh=pwshPath();if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const installer=normalize(read('security/release/install-068.ps1'));
 const stateFunction=installer.slice(installer.indexOf('function Get-InstallationState'),installer.indexOf('\ntry {'));
 const cases=[
  [{has_undo_done:false},'BASELINE'],[{has_undo_done:true},'INSTALLED'],
  [{has_undo_done:'true'},'REJECTED'],[{has_undo_done:1},'REJECTED'],[{has_undo_done:null},'REJECTED'],
  [{},'REJECTED'],[null,'REJECTED'],[{has_undo_done:true,unexpected:true},'REJECTED'],
 ];
 const script="$ErrorActionPreference='Stop';"+stateFunction+'\n$cases='+quote(JSON.stringify(cases.map(x=>x[0])))+
  "|ConvertFrom-Json -Depth 10; foreach($item in $cases){try{Get-InstallationState $item}catch{'REJECTED'}}";
 assert.deepEqual(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim().split(/\r?\n/),cases.map(x=>x[1]));
 const installedBranch=installer.slice(installer.indexOf('if($alreadyInstalled)'),installer.indexOf('}else{'));
 assert.match(installedBranch,/\$audit=Get-ValidatedAudit/);
 assert.doesNotMatch(installedBranch,/pg_dump|pg_restore|-f \$migration/);
});

test('068 Edge manifest pins every current actual input and every transitive source import',()=>{
 const manifest=JSON.parse(read('security/release/edge-068-inputs.json')),deploy=normalize(read('security/release/deploy-edge-068.ps1'));
 assert.equal(manifest.format,'ORL-068-EDGE-INPUTS');assert.equal(manifest.normalization,'UTF8-NO-BOM-LF');
 assert.equal(manifest.project_ref,'imrfmilqehcrvassuvuw');assert.equal(manifest.function,'ic-requests');
 assert.equal(manifest.files.length,14);assert.equal(new Set(manifest.files.map(x=>x.path)).size,14);
 assert.ok(deploy.includes(digest(normalize(read('security/release/edge-068-inputs.json')))),'manifest itself must be pinned');
 const known=new Set(manifest.files.map(x=>x.path));
 const walk=p=>readdirSync(file(p),{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(p+'/'+x.name):[p+'/'+x.name]);
 assert.deepEqual([...known].sort(),['supabase/config.toml',...walk('supabase/functions/_shared'),...walk('supabase/functions/ic-requests')].sort());
 for(const entry of manifest.files){
  assert.match(entry.sha256,/^[A-F0-9]{64}$/);const contents=read(entry.path);
  assert.equal(digest(normalize(contents)),entry.sha256,entry.path);
  assert.equal(digest(normalize(contents.replace(/\r?\n/g,'\r\n'))),entry.sha256,'Windows line endings must not affect normalized pin');
  for(const match of contents.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)){
   assert.ok(match[1].startsWith('.'),'Remote/package imports need separate review');
   const imported=new URL(match[1],file(entry.path));
   const path=fileURLToPath(imported).slice(fileURLToPath(root).length).replaceAll('\\','/');
   assert.ok(known.has(path),'Unpinned imported source: '+path);
  }
 }
 assert.doesNotMatch(deploy,/docs\//);assert.doesNotMatch(deploy,/Get-FileHash|secrets\s+(?:list|set|unset)|pg_dump|pg_restore/);
 assert.match(deploy,/Unreviewed Deno configuration/);assert.match(deploy,/Compare-Object \(\$known/);
 assert.doesNotMatch(deploy,/PENDING_REVIEWED_/);
});

test('068 Edge release requires fresh exact sanitized installation evidence, project, pinned CLI and separate explicit confirmation',()=>{
 const deploy=normalize(read('security/release/deploy-edge-068.ps1'));
 assert.match(deploy,/#Requires -Version 7.4/);assert.match(deploy,/param\(\[switch\]\$PreflightOnly\)/);
 assert.match(deploy,/\$version='2.119.0'/);assert.match(deploy,/971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F/);
 assert.match(deploy,/ORL-Release-Reports/);assert.match(deploy,/-Filter 'ORL-068-report-\*\.json'/);
 assert.match(deploy,/ORL-068-SANITIZED-REPORT/);assert.match(deploy,/\$report\.migration068_sha256-cne\$migrationHash/);
 assert.match(deploy,/\$report\.audit_sha256-cne\$auditHash/);assert.match(deploy,/AddHours\(-24\)/);
 assert.match(deploy,/\$report.audit.\$name-isnot\[bool\]/);assert.match(deploy,/Type DEPLOY 068 EDGE/);
 const dispatch=deploy.indexOf('functions deploy ic-requests');
 assert.ok(dispatch>deploy.indexOf('Type DEPLOY 068 EDGE'));
 assert.ok(deploy.lastIndexOf('Test-ReviewedEdgeInputs',dispatch)>deploy.indexOf('Type DEPLOY 068 EDGE'));
 assert.ok(deploy.lastIndexOf('Get-VerifiedInstallReport',dispatch)>deploy.indexOf('Type DEPLOY 068 EDGE'));
 assert.match(deploy,/functions deploy ic-requests --project-ref \$orlProjectRef --no-verify-jwt --workdir \$root/);
 for(const path of [migrationPath,auditPath])assert.ok(deploy.includes(digest(readFileSync(file(path)))));
 for(const key of auditKeys)assert.ok(deploy.includes("'"+key+"'"),key);
 const launcher=read('security/release/Pasang-Edge-068.cmd');assert.match(launcher,/deploy-edge-068.ps1/);assert.doesNotMatch(launcher,/install-068/);
 assert.match(read('security/release/Pasang-068.cmd'),/install-068.ps1/);
});

test('both 068 PowerShell scripts parse without running installation or deployment',t=>{
 const pwsh=pwshPath();if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 for(const path of ['security/release/install-068.ps1','security/release/deploy-edge-068.ps1']){
  const script="$tokens=$null;$parseErrors=$null;[System.Management.Automation.Language.Parser]::ParseFile("+quote(fileURLToPath(file(path)))+
   ",[ref]$tokens,[ref]$parseErrors)|Out-Null;if($parseErrors.Count){$parseErrors|ForEach-Object Message;exit 1};exit 0";
  execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000});
 }
});

test('068 report verifier rejects stale, wrong-project, mismatched, missing and non-boolean audit evidence across Malaysian locale',t=>{
 const pwsh=pwshPath();if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const deploy=normalize(read('security/release/deploy-edge-068.ps1'));
 const functions=deploy.slice(deploy.indexOf('function Get-FileDigest'),deploy.indexOf('function Test-ReviewedEdgeInputs'))+
  deploy.slice(deploy.indexOf('function Get-VerifiedInstallReport'),deploy.indexOf('\ntry {'));
 const folder=mkdtempSync(join(tmpdir(),'orl-068-report-test-'));
 const migration=digest(readFileSync(file(migrationPath))),auditHash=digest(readFileSync(file(auditPath)));
 const report={format:'ORL-068-SANITIZED-REPORT',project_ref:'imrfmilqehcrvassuvuw',checked_at:new Date().toISOString(),already_installed:false,
  backup_file:'ORL-before-068-20261018-000000-000.dump',backup_sha256:'0'.repeat(64),migration068_sha256:migration,audit_sha256:auditHash,audit:Object.fromEntries(auditKeys.map(k=>[k,true]))};
 const script="$ErrorActionPreference='Stop';[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('ms-MY');"+
  functions+"\n$reportFolder="+quote(folder)+";$orlProjectRef='imrfmilqehcrvassuvuw';$migrationHash='"+migration+"';$auditHash='"+auditHash+
  "';try{Get-VerifiedInstallReport|Out-Null;'VALID'}catch{'REJECTED'}";
 const cases=[
  [report,'VALID'],[{...report,already_installed:true,backup_file:null,backup_sha256:null},'VALID'],
  [{...report,checked_at:new Date().toISOString().replace('Z','1234Z')},'VALID'],
  [{...report,checked_at:new Date(Date.now()-25*3600000).toISOString()},'REJECTED'],
  [{...report,checked_at:new Date(Date.now()+10*60000).toISOString()},'REJECTED'],
  [{...report,checked_at:'10/18/2026 14:20:41'},'REJECTED'],[{...report,checked_at:'invalid'},'REJECTED'],
  [{...report,audit:{...report.audit,[auditKeys[0]]:false}},'REJECTED'],
  [{...report,audit:{...report.audit,[auditKeys[0]]:'true'}},'REJECTED'],
  [{...report,audit:{...report.audit,unexpected:true}},'REJECTED'],[{...report,audit:{}},'REJECTED'],
  [{...report,project_ref:'another-project'},'REJECTED'],[{...report,already_installed:'false'},'REJECTED'],
  [{...report,backup_file:null},'REJECTED'],[{...report,backup_file:'../private.dump'},'REJECTED'],
  [{...report,backup_sha256:'invalid'},'REJECTED'],[{...report,already_installed:true},'REJECTED'],
  [{...report,migration068_sha256:'0'.repeat(64)},'REJECTED'],[{...report,audit_sha256:'0'.repeat(64)},'REJECTED']
 ];
 try{
  for(const [value,expected] of cases){
   writeFileSync(join(folder,'ORL-068-report-synthetic.json'),JSON.stringify(value));
   assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),expected);
  }
 }finally{
  if(dirname(resolve(folder))!==resolve(tmpdir())||!folder.includes('orl-068-report-test-'))throw Error('Unexpected test cleanup target');
  rmSync(folder,{recursive:true,force:true});
 }
});

test('068 manifest validator accepts reviewed current input without invoking CLI or reading private reports',t=>{
 const pwsh=pwshPath();if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const deploy=normalize(read('security/release/deploy-edge-068.ps1'));
 const functions=deploy.slice(deploy.indexOf('function Get-FileDigest'),deploy.indexOf('function Get-VerifiedInstallReport'));
 const script="$ErrorActionPreference='Stop';"+functions+"\n"+
  '$root='+quote(fileURLToPath(root))+
  ';$manifestFile='+quote(fileURLToPath(file('security/release/edge-068-inputs.json')))+
  ";$manifestHash='"+digest(normalize(read('security/release/edge-068-inputs.json')))+"';$orlProjectRef='imrfmilqehcrvassuvuw';"+
  "$migrationHash='"+digest(readFileSync(file(migrationPath)))+"';$auditHash='"+digest(readFileSync(file(auditPath)))+
  "';Test-ReviewedEdgeInputs;'VALID_REVIEWED_INPUTS'";
 assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),'VALID_REVIEWED_INPUTS');
});
