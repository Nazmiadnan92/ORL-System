import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=p=>new URL('../../'+p,import.meta.url),read=p=>readFileSync(file(p),'utf8').replace(/\r/g,'');
const path='security/release/inspect-070-baseline.ps1',source=read(path);
const query=source.match(/return @'\n([\s\S]*?)\n'@/)[1];
const launcher=read('security/release/Semak-070.cmd'),pwsh=launcher.match(/^"([^"]+pwsh\.exe)"/m)[1];
const quote=value=>"'"+value.replaceAll("'","''")+"'";
test('070 diagnostic query is pinned, one bounded read-only transaction and catalog-only',()=>{
 assert.ok(source.includes(createHash('sha256').update(query).digest('hex').toUpperCase()));
 assert.equal((query.match(/^begin read only;$/gm)||[]).length,1);
 assert.equal((query.match(/^rollback;$/gm)||[]).length,1);
 assert.match(query,/set local statement_timeout='20s'/);
 const code=query.replace(/'(?:''|[^'])*'/g,"''");
 assert.doesNotMatch(code,/\b(?:insert|update|delete|truncate|alter|create|grant|revoke|copy|call|do|execute|commit)\b/i);
 assert.doesNotMatch(code,/\b(?:public|orl_private)\.orl_\w+\s*\(/);
 assert.doesNotMatch(query,/\b(?:from|join)\s+(?:public|orl_private)\./i);
 const tables=[...query.matchAll(/\b(?:from|join)\s+([a-z_]+)/gi)].map(x=>x[1]);
 assert.ok(tables.every(x=>['expected','functions','pg_proc','pg_attribute','pg_class','pg_namespace','aclexplode'].includes(x)),tables.join(','));
 assert.equal((query.match(/pg_get_functiondef\(/g)||[]).length,1);
 assert.match(query,/case when e\.signature='public\.orl_db_export\(uuid,text\)' and p\.oid is not null\s+then pg_get_functiondef\(p\.oid\) end as source_definition/);
 assert.equal((query.match(/^ \('(?:public|orl_private)\./gm)||[]).length,5);
});
test('070 diagnostic uses hidden credentials, reviewed TLS and private report without mutation or automatic retry',()=>{
 assert.match(source,/sslmode=verify-full/);assert.match(source,/-AsSecureString/);
 assert.match(source,/807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA/);
 assert.match(source,/ORL-Release-Reports/);assert.match(source,/ORL-070-BASELINE-DIAGNOSTIC/);
 assert.match(source,/project_ref='imrfmilqehcrvassuvuw'/);assert.match(source,/query_sha256=\$queryHash;metadata=\$metadata/);
 assert.match(source,/ON_ERROR_STOP=1 -Atq/);assert.equal((source.match(/& "\$bin\\psql\.exe"/g)||[]).length,1);
 assert.match(source,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.doesNotMatch(source,/pg_dump|pg_restore|git\s+push|functions\s+deploy|Start-Process|Test-ReviewedFiles|INSTALL 070/);
 assert.doesNotMatch(source,/Write-Host[^\n]*(?:source_definition|\$query\b|\$metadata\b|\$password\b|Exception\.Message)/);
 assert.doesNotMatch(source,/(?:Write-Host|Write-Output|Out-Host)[^\n]*\$(?:metadata|diagnosticLines|jsonLines|query|password)\b/);
 assert.match(source,/ConvertTo-Json -Depth 20\|Set-Content -LiteralPath \$reportPath/);
 assert.match(launcher,/inspect-070-baseline\.ps1/);assert.doesNotMatch(launcher,/install-070\.ps1/);
});
test('070 diagnostic PowerShell parses; query function returns the exact pinned text without running the script',()=>{
 const script='$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('+quote(fileURLToPath(file(path)))+
  ',[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object Message;exit 1};'+
  "foreach($name in @('Get-DiagnosticQuery','Get-QueryDigest')){$fn=$ast.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq$name},$true);Invoke-Expression $fn.Extent.Text};Get-QueryDigest (Get-DiagnosticQuery)";
 assert.equal(execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim(),createHash('sha256').update(query).digest('hex').toUpperCase());
});
test('070 diagnostic rejects incomplete metadata and missing or unexpected source without printing it',()=>{
 const signatures=['public.orl_require_session(uuid)','orl_private.c1_check_generation(uuid)','orl_private.c1_redact_text(text)','public.orl_db_export(uuid,text)','public.orl_db_import_locked(uuid,text,jsonb)'];
 const metadata={functions:signatures.map(signature=>({signature,present:true,normalized_body_md5:'0'.repeat(32),normalized_body_length:100,security_definer:true,configuration:['search_path=public, extensions'],owner:'synthetic_owner',
  access:{public_execute:false,anon_execute:false,authenticated_execute:false,service_role_execute:false},source_definition:signature==='public.orl_db_export(uuid,text)'?'CREATE OR REPLACE FUNCTION public.orl_db_export() RETURNS void AS $body$ BEGIN END $body$ LANGUAGE plpgsql;':null})),
  presence:{has_day_note:false,has_day_note_revision:false,has_read_rpc:false,has_write_rpc:false}};
 const variant=change=>{const value=structuredClone(metadata);change(value);return value};
 const cases=[[metadata,'VALID'],[null,'REJECTED'],[{},'REJECTED'],
  [variant(x=>x.functions.pop()),'REJECTED'],[variant(x=>x.functions[3].source_definition=null),'REJECTED'],
  [variant(x=>delete x.functions[3].source_definition),'REJECTED'],[variant(x=>x.functions[0].source_definition='Unexpected source'),'REJECTED'],
  [variant(x=>x.functions[3].present=false),'REJECTED'],[variant(x=>x.presence.has_read_rpc='false'),'REJECTED'],
  [variant(x=>delete x.functions[0].access.anon_execute),'REJECTED']];
 const script='$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile('+quote(fileURLToPath(file(path)))+
  ",[ref]$tokens,[ref]$errors);$fn=$ast.Find({param($n)$n-is[Management.Automation.Language.FunctionDefinitionAst]-and$n.Name-eq'Test-DiagnosticMetadata'},$true);Invoke-Expression $fn.Extent.Text;"+
  '$cases='+quote(JSON.stringify(cases.map(x=>x[0])))+"|ConvertFrom-Json -Depth 20;foreach($item in $cases){try{Test-DiagnosticMetadata $item;'VALID'}catch{'REJECTED'}}";
 const result=execFileSync(pwsh,['-NoProfile','-Command',script],{encoding:'utf8',timeout:15000}).trim().split(/\r?\n/);
 assert.deepEqual(result,cases.map(x=>x[1]));
});
