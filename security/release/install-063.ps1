#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\063_staff_shared_postpone.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-shared-postpone.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'3565DF241EAD22CDF11A3F1DD483FEAE416ED8B3FB8A3F9AF9B31B4ECB518D91'){throw 'Reviewed migration 063 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'CB6F08D9800BF2D0F9E8BA346672FBA6FEDD06139E856019647E8C90F96DAE9E'){throw 'Reviewed shared postpone audit changed.'}
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'SHARED POSTPONE / 063: private full backup, then allow Staff to postpone patients from any account to MAIN.' -ForegroundColor Yellow
 Write-Host 'Future Staff postponements reserve the new MAIN slot for Admin approval. Cross-owner patient details, IC, Edit permissions and Special booking restrictions stay protected. No patient is moved by installation.'
 $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
 try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
 if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
 $env:PGPASSWORD=$password
 $preflight=@'
-- Sanitized read-only checks: no patient values returned.
begin read only;
set local statement_timeout='30s';
select jsonb_build_object(
 'special_slots_visible',coalesce((select md5(replace(prosrc,chr(13),''))='0f922b237c5c2a89976c3b4c22345ae7' and prosecdef from pg_proc where oid=to_regprocedure('orl_private.c1_read_schedule(uuid,integer,integer)')),false),
 'special_days_counts_visible',coalesce((select md5(replace(prosrc,chr(13),''))='be9cc43e84ccd5837ef94b01b9f309d1' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_get_special_ot_days(uuid,integer)')),false),
 'special_month_counts_visible',coalesce((select md5(replace(prosrc,chr(13),''))='373d33d3fdd1abc3aed2e73ff3c22930' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_get_year_month_counts(uuid,integer)')),false),
 'mask_wrapper_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='176cc950c7c8a75b13e85bb1addbae03' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_get_schedule(uuid,integer,integer)')),false) and coalesce((select md5(replace(prosrc,chr(13),''))='f47cec01cc6028c6320a2b8bc8fb2115' and prosecdef from pg_proc where oid=to_regprocedure('orl_private.c1_mask_json(jsonb,date)')),false) and coalesce((select proconfig @> array['search_path=""'] from pg_proc where oid=to_regprocedure('public.orl_get_schedule(uuid,integer,integer)')),false),
 'special_destination_guard_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='b924d46e7bcac41332c9470521a72080' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_assign_slot(uuid,uuid,uuid)')),false) and coalesce((select md5(replace(prosrc,chr(13),''))='be1940a8970dbf808fff9ada9ea0bd5f' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)')),false),
 'session_gate_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),false),
 'private_access_closed',not exists(select 1 from unnest(array['anon','authenticated','service_role']) r cross join unnest(array['orl_private.c1_read_schedule(uuid,integer,integer)','orl_private.c1_mask_json(jsonb,date)','public.orl_require_session(uuid)','public.orl_assign_slot(uuid,uuid,uuid)','public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)']) f where has_function_privilege(r,f,'EXECUTE')),
 'public_reads_available',not exists(select 1 from unnest(array['anon','authenticated']) r cross join unnest(array['public.orl_get_schedule(uuid,integer,integer)','public.orl_get_special_ot_days(uuid,integer)','public.orl_get_year_month_counts(uuid,integer)']) f where not has_function_privilege(r,f,'EXECUTE')),
 'shared_postpone_enabled',coalesce((select md5(replace(prosrc,chr(13),''))='be1940a8970dbf808fff9ada9ea0bd5f' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)')),false),
 'edit_permissions_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='1b0ee59e8b8e3dbf12d92d0805fd33a5' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_edit_scheduled_request_checked(uuid,uuid,jsonb,text,uuid)')),false),
 'mutation_guards_preserved',coalesce((select md5(replace(prosrc,chr(13),''))='9369627b09c1739c304e1c7256b3eaa7' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_ic_c1_mutate(uuid,text,uuid,uuid,uuid,jsonb,text,text,text,jsonb,jsonb,uuid,timestamptz)')),false),
 'recovery_ready',orl_private.c1_recovery_ready(),
 'ic_storage_preserved',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false)
);
rollback;
'@
 $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
 if($LASTEXITCODE-ne0){throw 'Read-only preflight failed. Nothing installed.'}
 $state=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$state-or@($state.PSObject.Properties).Count-ne13){throw 'Read-only preflight incomplete.'}
 foreach($p in $state.PSObject.Properties){if($p.Value-ne$true){throw "Preflight failed: $($p.Name). Nothing installed; inspect safely."}}
 New-Item -ItemType Directory -Force -Path $folder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-063-$stamp.dump";$partial="$file.partial"
 Write-Host 'Creating fresh full private backup...'
 & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
 if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
 & "$bin\pg_restore.exe" --list $partial|Out-Null
 if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
 Move-Item -LiteralPath $partial -Destination $file
 if((Read-Host 'Type INSTALL 063')-cne'INSTALL 063'){throw 'Cancelled before installation.'}
 Test-ReviewedFiles
 & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
 if($LASTEXITCODE-ne0){throw 'Installation failed or result uncertain. Inspect status before retrying.'}
 $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Post-install audit failed. Do not publish the website yet.'}
 $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$audit-or@($audit.PSObject.Properties).Count-ne13){throw 'Post-install audit incomplete.'}
 foreach($p in $audit.PSObject.Properties){if($p.Value-ne$true){throw "Post-install check failed: $($p.Name). Do not publish yet."}}
 [ordered]@{format='ORL-063-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');
  backup_file=[IO.Path]::GetFileName($file);backup_sha256=(Get-ReviewedHash $file);
  migration063_sha256=(Get-ReviewedHash $migration);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $folder "ORL-063-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host 'SUCCESS: 063 installed and audited. Staff may postpone patients from any account to MAIN; shared clinical edits and Special booking remain blocked.' -ForegroundColor Green
 Write-Host 'Tell GPT SUCCESS so the reviewed website update can be published. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
