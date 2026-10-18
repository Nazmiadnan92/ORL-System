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
const digest=(value)=>createHash('sha256').update(value).digest('hex').toUpperCase();

test('064 migration and audit are exactly pinned, atomic, and never create another backup or deploy from the SQL installer',()=>{
 const installer=read('security/release/install-064.ps1'),sql=read('supabase/064_ot_hold_completion.sql');
 for(const path of ['supabase/064_ot_hold_completion.sql','security/release/audit-ot-lifecycle.sql'])
  assert.ok(installer.includes(digest(readFileSync(file(path)))),path+' hash must be pinned');
 assert.equal((sql.match(/^begin;$/gm)||[]).length,1);assert.equal((sql.match(/^commit;$/gm)||[]).length,1);
 assert.match(sql,/set local lock_timeout='5s'/);assert.match(sql,/do \$baseline\$/);assert.match(sql,/md5\(replace\(prosrc,chr\(13\),''\)\)=item.expected_md5/);
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/Test-OrlReviewedCa -Path \$ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'/);
 assert.match(installer,/-AsSecureString/);assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.match(installer,/begin read only/);assert.match(installer,/if\(\$alreadyInstalled\)/);assert.match(installer,/Type INSTALL 064/);
 assert.doesNotMatch(installer,/pg_dump|pg_restore|git\s+tag|functions\s+deploy|Get-FileHash/);
 assert.ok(installer.indexOf('BASELINE_064_OK')<installer.indexOf('Type INSTALL 064'));
 assert.match(installer,/ORL-Release-Reports/);assert.match(installer,/project_ref='imrfmilqehcrvassuvuw'/);
 assert.doesNotMatch(sql,/^\s*(?:select|perform) public\.orl_ic_ot_lifecycle\(/m);
 assert.match(read('.gitattributes'),/\/supabase\/064_ot_hold_completion\.sql text eol=lf/);
 assert.match(read('.gitattributes'),/\/security\/release\/audit-ot-lifecycle\.sql text eol=lf/);
});

test('064 role boundaries, stale versions, slot pinning, export eligibility and restore metadata remain in the reviewed migration',()=>{
 const sql=read('supabase/064_ot_hold_completion.sql'),audit=read('security/release/audit-ot-lifecycle.sql');
 assert.match(sql,/revoke all on function public\.orl_ic_ot_lifecycle\(uuid,uuid,uuid,text,text,uuid,timestamptz\) from public,anon,authenticated,service_role/);
 assert.match(sql,/grant execute on function public\.orl_ic_ot_lifecycle\(uuid,uuid,uuid,text,text,uuid,timestamptz\) to service_role/);
 assert.match(sql,/u\.role not in\('ADMIN','WEBMASTER'\)/);assert.match(sql,/r\.updated_at is distinct from p_expected_version/);
 assert.match(sql,/perform orl_private\.c1_check_generation\(p_generation\)/);
 assert.match(sql,/or r\.status not in\('SCHEDULED','CONFIRMED'\)/);assert.match(sql,/status='COMPLETED'/);
 assert.match(sql,/not coalesce\(r.ot_hold,false\) and coalesce\(r.status,''\)<>'COMPLETED'/);
 assert.match(sql,/and r.status<>'CANCELLED' and not r.ot_hold/);
 assert.match(sql,/insert into public.orl_requests\(ot_hold,ot_hold_reason,ot_hold_at,ot_hold_by,completed_at,completed_by,booked_by_name/);
 assert.match(sql,/coalesce\(r.ot_hold,false\)/);assert.match(sql,/mapped_holder/);assert.match(sql,/mapped_completer/);
 assert.match(audit,/begin read only/);assert.doesNotMatch(audit,/PENDING_|patient_name|patient_ic|\bUPDATE\s+public\./i);
 assert.match(audit,/'orl_private.ot_export_snapshot\(uuid\)'[^\n]+false/);
 assert.match(audit,/'ic_storage_preserved'/);
});

test('superseded 064 manifest remains immutable and its deployer refuses changed current sources',t=>{
 // 065 supersedes the 064 gateway. Keep historical release pins unchanged:
 // the 065 release test below is responsible for exact current-source coverage.
 const manifestText=normalize(read('security/release/edge-064-inputs.json'));
 const manifest=JSON.parse(manifestText),deploy=normalize(read('security/release/deploy-edge-064.ps1'));
 const historicalDigest='2D43499E9E56FC762D6E3DE6D27953038BCAFE647E23E190E07556CBCE9A3BEA';
 assert.equal(digest(manifestText),historicalDigest);assert.ok(deploy.includes(historicalDigest));
 assert.equal(manifest.format,'ORL-064-EDGE-INPUTS');assert.equal(manifest.normalization,'UTF8-NO-BOM-LF');
 assert.equal(manifest.project_ref,'imrfmilqehcrvassuvuw');assert.equal(manifest.function,'ic-requests');
 assert.equal(manifest.files.length,13);assert.equal(new Set(manifest.files.map(x=>x.path)).size,13);
 const changed=manifest.files.filter(entry=>digest(normalize(read(entry.path)))!==entry.sha256);
 assert.ok(changed.length>0,'065 must not silently repin the historical 064 release manifest');
 assert.doesNotMatch(deploy,/docs\//);assert.doesNotMatch(deploy,/Get-FileHash|secrets\s+(?:list|set|unset)|pg_dump|pg_restore/);
 assert.match(deploy,/Unreviewed Deno configuration/);assert.match(deploy,/Compare-Object \(\$known/);
 const pwsh=read('security/release/Pasang-Edge-064.cmd').match(/^"([^"]+pwsh\.exe)"/m)?.[1];
 if(!pwsh||!existsSync(pwsh)){t.skip('Historical manifest verified; pinned PowerShell unavailable for refusal execution');return}
 // Execute definitions only, not the outer deploy routine or any network command.
 const functions=deploy.slice(deploy.indexOf('function Get-FileDigest'),deploy.indexOf('function Get-VerifiedInstallReport'));
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 const script="$ErrorActionPreference='Stop';"+functions+"\n"+
  '$root='+quote(fileURLToPath(root))+';$manifestFile='+quote(fileURLToPath(file('security/release/edge-064-inputs.json')))+
  ";$manifestHash='"+historicalDigest+"';$orlProjectRef='imrfmilqehcrvassuvuw';"+
  "try{Test-ReviewedEdgeInputs;throw 'Historical deployer incorrectly accepted current inputs.'}catch{if($_.Exception.Message-notlike 'Reviewed Edge input changed:*'){throw};'REFUSED_CHANGED_INPUTS'}";
 assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),'REFUSED_CHANGED_INPUTS');
});

test('064 Edge release requires fresh sanitized installation evidence, exact project, pinned CLI and explicit separate deployment confirmation',()=>{
 const deploy=read('security/release/deploy-edge-064.ps1');
 assert.match(deploy,/#Requires -Version 7.4/);assert.match(deploy,/param\(\[switch\]\$PreflightOnly\)/);
 assert.match(deploy,/\$version='2.119.0'/);assert.match(deploy,/971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F/);
 assert.match(deploy,/ORL-Release-Reports/);assert.match(deploy,/-Filter 'ORL-064-report-\*\.json'/);
 assert.match(deploy,/ORL-064-SANITIZED-REPORT/);assert.match(deploy,/\$report\.migration064_sha256-cne\$migrationHash/);
 assert.match(deploy,/\$report\.audit_sha256-cne\$auditHash/);assert.match(deploy,/AddHours\(-24\)/);
 assert.match(deploy,/\$report.audit.\$name-isnot\[bool\]/);assert.match(deploy,/Type DEPLOY 064 EDGE/);
 const dispatch=deploy.indexOf('functions deploy ic-requests');
 assert.ok(dispatch>deploy.indexOf('Type DEPLOY 064 EDGE'));
 assert.ok(deploy.lastIndexOf('Test-ReviewedEdgeInputs',dispatch)>deploy.indexOf('Type DEPLOY 064 EDGE'));
 assert.ok(deploy.lastIndexOf('Get-VerifiedInstallReport',dispatch)>deploy.indexOf('Type DEPLOY 064 EDGE'));
 assert.match(deploy,/functions deploy ic-requests --project-ref \$orlProjectRef --no-verify-jwt --workdir \$root/);
 for(const path of ['supabase/064_ot_hold_completion.sql','security/release/audit-ot-lifecycle.sql'])assert.ok(deploy.includes(digest(readFileSync(file(path)))));
 const launcher=read('security/release/Pasang-Edge-064.cmd');assert.match(launcher,/deploy-edge-064.ps1/);assert.doesNotMatch(launcher,/install-064/);
});

test('both 064 PowerShell scripts parse without executing installer or deployment actions',t=>{
 const launcher=read('security/release/Pasang-064.cmd'),pwsh=launcher.match(/^"([^"]+pwsh\.exe)"/m)?.[1];
 if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 for(const path of ['security/release/install-064.ps1','security/release/deploy-edge-064.ps1']){
  const target=fileURLToPath(file(path)).replaceAll("'","''");
  const script=`$tokens=$null;$parseErrors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${target}',[ref]$tokens,[ref]$parseErrors)|Out-Null;if($parseErrors.Count){$parseErrors|ForEach-Object Message;exit 1};exit 0`;
  execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8'});
 }
});

test('064 report freshness validates the original ISO timestamp across PowerShell JSON conversion and Malaysian locale',t=>{
 const pwsh=read('security/release/Pasang-064.cmd').match(/^"([^"]+pwsh\.exe)"/m)?.[1];
 if(!pwsh||!existsSync(pwsh)){t.skip('Pinned local PowerShell unavailable');return}
 const deploy=normalize(read('security/release/deploy-edge-064.ps1'));
 const functions=deploy.slice(deploy.indexOf('function Get-FileDigest'),deploy.indexOf('function Test-ReviewedEdgeInputs'))+
  deploy.slice(deploy.indexOf('function Get-VerifiedInstallReport'),deploy.indexOf('\ntry {'));
 const folder=mkdtempSync(join(tmpdir(),'orl-064-report-test-'));
 const migration=digest(readFileSync(file('supabase/064_ot_hold_completion.sql'))),auditHash=digest(readFileSync(file('security/release/audit-ot-lifecycle.sql')));
 const keys=['reviewed_definitions','lifecycle_columns','lifecycle_constraints','lifecycle_index','protected_action_acl','held_read_acl','private_helpers','browser_tables_closed','recovery_ready','masked_wrapper_preserved','export_lease_protected','ic_storage_preserved'];
 const report={format:'ORL-064-SANITIZED-REPORT',project_ref:'imrfmilqehcrvassuvuw',checked_at:new Date().toISOString(),already_installed:false,migration064_sha256:migration,audit_sha256:auditHash,audit:Object.fromEntries(keys.map(k=>[k,true]))};
 const script="$ErrorActionPreference='Stop';[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('ms-MY');"+
  functions+"\n$reportFolder='"+folder.replaceAll("'","''")+"';$orlProjectRef='imrfmilqehcrvassuvuw';$migrationHash='"+migration+"';$auditHash='"+auditHash+"';try{Get-VerifiedInstallReport|Out-Null;'VALID'}catch{'REJECTED'}";
 const cases=[
  [report,'VALID'],
  [{...report,checked_at:new Date().toISOString().replace('Z','1234Z')},'VALID'],
  [{...report,checked_at:new Date(Date.now()-25*3600000).toISOString()},'REJECTED'],
  [{...report,checked_at:new Date(Date.now()+10*60000).toISOString()},'REJECTED'],
  [{...report,checked_at:'10/16/2026 14:20:41'},'REJECTED'],
  [{...report,checked_at:'invalid'},'REJECTED'],
  [{...report,audit:{...report.audit,ic_storage_preserved:false}},'REJECTED'],
  [{...report,project_ref:'another-project'},'REJECTED']
 ];
 try{
  for(const [value,expected] of cases){
   writeFileSync(join(folder,'ORL-064-report-synthetic.json'),JSON.stringify(value));
   assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),expected);
  }
 }finally{
  if(dirname(resolve(folder))!==resolve(tmpdir())||!folder.includes('orl-064-report-test-'))throw Error('Unexpected test cleanup target');
  rmSync(folder,{recursive:true,force:true});
 }
});
