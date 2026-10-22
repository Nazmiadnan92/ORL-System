import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const file=p=>new URL('../../'+p,import.meta.url),read=p=>readFileSync(file(p),'utf8');
const migrationPath='supabase/071_pending_request_assignment.sql',auditPath='security/release/audit-pending-assignment.sql';
const installer=read('security/release/install-071.ps1'),sql=read(migrationPath),audit=read(auditPath);
const sha=p=>createHash('sha256').update(readFileSync(file(p))).digest('hex').toUpperCase();
const auditKeys=['reviewed_assignment_definitions','reviewed_core_dependencies','assignment_rpc_grants','private_functions_closed','browser_tables_closed','private_tables_closed','protected_rls','same_date_guard_enabled'];
const pwsh=read('security/release/Pasang-071.cmd').match(/^"([^"]+pwsh\.exe)"/m)?.[1];
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const noStrings=source=>source.replace(/'(?:''|[^'])*'/g,"''").replace(/--[^\r\n]*/g,'');
const body=name=>{
 const match=sql.match(new RegExp('create or replace function public\\.'+name+'\\([\\s\\S]*?as \\$([a-z_]*)\\$([\\s\\S]*?)\\$\\1\\$;'));
 assert.ok(match,name+' must have a reviewable body');
 return createHash('md5').update(match[2].replace(/\r/g,'')).digest('hex');
};

test('071 pins the exact two-function atomic migration and catalog-only preflight',()=>{
 for(const path of [migrationPath,auditPath])assert.ok(installer.includes(sha(path)),path+' must be exactly pinned');
 assert.doesNotMatch(installer+audit,/PENDING_REVIEWED_|PENDING_/);
 assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 assert.match(sql,/set local lock_timeout=/);
 const replacements=[...sql.matchAll(/create or replace function ([a-z_.]+)\(/gi)].map(x=>x[1]);
 assert.deepEqual(replacements,['public.orl_booking_assign_view','public.orl_booking_assign_existing']);
 const baseline=[...sql.matchAll(/do \$baseline\$([\s\S]*?)end \$baseline\$;/g)];assert.equal(baseline.length,1);
 const executable=noStrings(baseline[0][1]);
 assert.doesNotMatch(executable,/\b(?:insert|update|delete|truncate|alter|create|drop|execute)\b/i);
 assert.doesNotMatch(executable,/\b(?:from|join)\s+(?:public|orl_private)\.|\b(?:public|orl_private)\.[a-z_]+\s*\(/i);
 const installOnly=noStrings(sql.replace(/do \$baseline\$[\s\S]*?end \$baseline\$;/,'')
  .replace(/create or replace function public\.[\s\S]*?as \$([a-z_]*)\$[\s\S]*?\$\1\$;/g,''));
 assert.doesNotMatch(installOnly,/\b(?:insert|update|delete|truncate|alter|create|drop|execute|perform)\b/i);
 assert.doesNotMatch(installOnly,/\b(?:public|orl_private)\.[a-z_]+\s*\(/i);
 assert.match(read('.gitattributes'),/\/supabase\/071_pending_request_assignment\.sql text eol=lf/);
 assert.match(read('.gitattributes'),/\/security\/release\/audit-pending-assignment\.sql text eol=lf/);
});

test('071 installer enforces TLS, hidden password, fresh private archive and explicit confirmation',()=>{
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/-AsSecureString/);
 assert.match(installer,/Test-OrlReviewedCa -Path \$ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.ok(installer.indexOf('BASELINE_071_OK')<installer.indexOf('pg_dump.exe'));
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf('pg_restore.exe'));
 assert.ok(installer.indexOf('pg_restore.exe')<installer.indexOf('Type INSTALL 071'));
 assert.ok(installer.indexOf('Type INSTALL 071')<installer.indexOf('-f $migration'));
 assert.match(installer,/--format=custom --file=\$partial --no-password/);
 assert.match(installer,/pg_restore\.exe" --list \$partial/);
 assert.match(installer,/Move-Item -LiteralPath \$partial -Destination \$backupFile/);
 assert.match(installer,/Test-Path -LiteralPath \$backupFile/);
 assert.doesNotMatch(installer,/pg_restore\.exe[^\n]*(?:--dbname|-d\s)|git\s+push|functions\s+deploy|secrets\s+(?:list|set|unset)/);
 assert.match(installer,/ORL-Private-Backups/);assert.match(installer,/ORL-Release-Reports/);
 assert.match(installer,/ORL-071-SANITIZED-REPORT/);assert.match(installer,/project_ref='imrfmilqehcrvassuvuw'/);
 assert.match(installer,/migration071_sha256=\(Get-ReviewedHash \$migration\)/);
 const already=installer.slice(installer.indexOf('if($alreadyInstalled)'),installer.indexOf('}else{'));
 assert.match(already,/\$audit=Get-ValidatedAudit/);assert.doesNotMatch(already,/pg_dump|pg_restore|-f \$migration/);
 assert.match(read('security/release/Pasang-071.cmd'),/install-071\.ps1/);
});

test('071 baseline and audit retain the exact reviewed dependencies and effective owner safeguards',()=>{
 const baseline=sql.match(/do \$baseline\$([\s\S]*?)end \$baseline\$;/)[1];
 const rows=source=>Object.fromEntries([...source.matchAll(/\('([^']+)','([0-9a-f]{32})','(search_path=[^']+)'\)/g)]
  .map(([,signature,md5,config])=>[signature,{md5,config}]));
 const empty='search_path=""',publicPath='search_path=public, extensions';
 const core={
  'public.orl_require_session(uuid)':{md5:'ba9d29923e7269729c8025bf1e266208',config:empty},
  'orl_private.c1_check_generation(uuid)':{md5:'5c654a99ad55c29ba66b9b74371c8239',config:empty},
  'orl_private.c1_redact_text(text)':{md5:'aea30f10772d86163fb1aa4e2362fac3',config:empty},
  'public.orl_review_request(uuid,uuid,text,text)':{md5:'eb02cd973d9cd40b054d6b00795a1508',config:publicPath},
  'public.orl_assign_slot(uuid,uuid,uuid)':{md5:'b924d46e7bcac41332c9470521a72080',config:publicPath},
  'orl_private.booking_same_date_guard()':{md5:'30be1c5fe983f12238591fd2f3661b44',config:empty}
 };
 assert.deepEqual(rows(baseline),{...core,
  'public.orl_booking_assign_view(uuid,uuid)':{md5:'060a6404455ba9f9ddbc78a2a19bfac4',config:empty},
  'public.orl_booking_assign_existing(uuid,uuid,uuid,timestamptz,uuid)':{md5:'e54fa0d43ffd4b4e4d4178b2a814609a',config:empty}});
 assert.deepEqual(rows(audit),core);
 assert.doesNotMatch(baseline+audit,/regexp_replace|\b(?:btrim|ltrim|rtrim|trim)\s*\(/i);
 assert.match(baseline,/proconfig=array\[item\.configuration\]/);
 assert.match(baseline,/proowner/);assert.match(audit,/p\.proowner is distinct from \(select proowner from pg_proc where oid=to_regprocedure\('public\.orl_require_session\(uuid\)'\)\)/);
 assert.match(baseline,/is_grantable/);assert.match(audit,/is_grantable/);
 for(const table of ['public.orl_settings','public.orl_holidays','orl_private.request_identity']){
  assert.ok(baseline.includes(table));assert.ok(audit.includes(table));
 }
});

test('071 audit reads catalog metadata only and returns the exact required boolean contract',()=>{
 assert.match(audit,/begin read only;/);assert.match(audit,/set local statement_timeout='30s';/);assert.match(audit,/rollback;/);
 const executable=noStrings(audit);
 assert.doesNotMatch(executable,/\b(?:insert|update|delete|truncate|alter|create|drop|execute)\b/i);
 assert.doesNotMatch(executable,/\b(?:from|join)\s+(?:public|orl_private)\.|\b(?:public|orl_private)\.[a-z_]+\s*\(/i);
 const keys=[...audit.slice(audit.indexOf('select jsonb_build_object(')).matchAll(/^\s*'([a-z_]+)',/gm)].map(x=>x[1]);
 assert.deepEqual(keys.sort(),[...auditKeys].sort());
 for(const key of auditKeys)assert.ok(installer.includes("'"+key+"'"),key);
 assert.match(installer,/Compare-Object \(\$checks\|Sort-Object\)/);assert.match(installer,/\$result\.\$name-isnot\[bool\]/);
 for(const name of ['orl_booking_assign_view','orl_booking_assign_existing']){
  assert.ok(audit.includes(body(name)),name+' audit must pin the exact body');
  assert.ok(installer.includes(body(name)),name+' installed-state check must pin the exact body');
 }
 assert.match(audit,/has_function_privilege/);assert.match(audit,/has_table_privilege/);
 assert.match(audit,/orl_private\.c1_check_generation\(uuid\)/);
 assert.match(audit,/public\.orl_review_request\(uuid,uuid,text,text\)/);
 assert.match(audit,/public\.orl_assign_slot\(uuid,uuid,uuid\)/);
 assert.match(audit,/tgfoid=to_regprocedure\('orl_private\.booking_same_date_guard\(\)'\)/);
});

test('071 state gate rejects mixed, unknown, missing and malformed function metadata',t=>{
 if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const fn=installer.slice(installer.indexOf('function Get-InstallationState'),installer.indexOf('\ntry {'));
 const old={view_md5:'060a6404455ba9f9ddbc78a2a19bfac4',assign_md5:'e54fa0d43ffd4b4e4d4178b2a814609a'};
 const installed={view_md5:body('orl_booking_assign_view'),assign_md5:body('orl_booking_assign_existing')};
 const cases=[[old,'BASELINE'],[installed,'INSTALLED'],[{...old,assign_md5:installed.assign_md5},'REJECTED'],
  [{...installed,assign_md5:old.assign_md5},'REJECTED'],[null,'REJECTED'],[{},'REJECTED'],
  [{...old,view_md5:null},'REJECTED'],[{...old,assign_md5:1},'REJECTED'],
  [{...old,view_md5:'0'.repeat(32)},'REJECTED'],[{...installed,unexpected:true},'REJECTED'],
  [{view_md5:installed.view_md5},'REJECTED'],[{...old,view_md5:old.view_md5.toUpperCase()},'REJECTED']];
 const script="$ErrorActionPreference='Stop';"+fn+'\n$cases='+quote(JSON.stringify(cases.map(x=>x[0])))+
  "|ConvertFrom-Json -Depth 10;foreach($item in $cases){try{Get-InstallationState $item}catch{'REJECTED'}}";
 const actual=execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim().split(/\r?\n/);
 assert.deepEqual(actual,cases.map(x=>x[1]));
});

test('071 inspection and report expose metadata only; installer parses without execution',t=>{
 const inspection=installer.match(/\$inspection=@'([\s\S]*?)'@/)[1];
 assert.match(inspection,/begin read only;/);assert.match(inspection,/rollback;/);
 assert.doesNotMatch(noStrings(inspection),/\b(?:from|join)\s+(?:public|orl_private)\.|\b(?:public|orl_private)\.[a-z_]+\s*\(/i);
 assert.doesNotMatch(installer,/Write-(?:Host|Output)[^\r\n]*(?:\$password|\$env:PGPASSWORD|\$secure|\$auditLines|\$migrationText)/i);
 const report=installer.slice(installer.indexOf("[ordered]@{format='ORL-071"),installer.indexOf('Write-Host $resultMessage'));
 assert.doesNotMatch(report,/password|patient|prosrc|definition|note|session_token/i);
 assert.match(report,/ConvertTo-Json -Depth 4\|Set-Content -LiteralPath/);
 if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const script="$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile("+
  quote(fileURLToPath(file('security/release/install-071.ps1')))+",[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){$errors|ForEach-Object Message;exit 1};'PARSED_ONLY'";
 assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),'PARSED_ONLY');
});
