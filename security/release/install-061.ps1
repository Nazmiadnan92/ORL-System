#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\061_past_ot_booking_guard.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-past-ot.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'D16ED4CC8BB3E0ED8B78423C8E1C83D9AED7F7731CD2EC8216606036A839967B'){throw 'Reviewed migration 061 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'FD0FB02A425E33E89A5C2EABBF45B089CDB84FA7B8FFC204E84BAC86394959A0'){throw 'Reviewed statistics audit changed.'}
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'PAST OT / 061: private full backup, then close past dates to new bookings.' -ForegroundColor Yellow
 Write-Host 'Today remains bookable in Malaysia time. Historical patient data, View OT, Print and IC protection stay unchanged.'
 $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
 try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
 if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
 $env:PGPASSWORD=$password
 $preflight=@'
begin read only;
select jsonb_build_object(
 'booking_baseline',coalesce((select md5(replace(prosrc,chr(13),''))='3b5a97307623ee4747ff66c0b6d61ecd' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_assign_slot(uuid,uuid,uuid)')),false)
 and coalesce((select md5(replace(prosrc,chr(13),''))='9d6a636c394b7a774f37a7084a5aa581' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_move_postponed_checked(uuid,uuid,uuid,jsonb,text,uuid)')),false)
 and coalesce((select md5(replace(prosrc,chr(13),''))='1769924c9e73acc96660bb3338593847' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_booking_move_request(uuid,uuid,date,text,uuid,timestamptz,uuid)')),false)
 and coalesce((select md5(replace(prosrc,chr(13),''))='488b5a16ad3fe7be54f34d59f3006766' and prosecdef from pg_proc where oid=to_regprocedure('public.orl_booking_move_review(uuid,uuid,text,uuid,timestamptz,timestamptz,uuid)')),false),
 'recovery_ready',orl_private.c1_recovery_ready(),
 'cutover_clean',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false),
 'statistics_baseline',coalesce((select md5(replace(prosrc,chr(13),''))='64e70a5570ead5b4e40de6e9cbcc8dce'
  from pg_proc where oid=to_regprocedure('orl_private.c1_read_orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)')),false),
 'session_gate',coalesce((select md5(replace(prosrc,chr(13),''))='ba9d29923e7269729c8025bf1e266208'
  from pg_proc where oid=to_regprocedure('public.orl_require_session(uuid)')),false),
 'mask_wrapper',coalesce((select prosrc='select orl_private.c1_mask_json(orl_private.c1_read_orl_subspecialty_statistics(p_session_token,p_from,p_to,p_sub,p_specialist,p_status,p_assignment,p_offset),null)'
  and prosecdef and proconfig @> array['search_path=""'] from pg_proc
  where oid=to_regprocedure('public.orl_subspecialty_statistics(uuid,date,date,text,text,text,text,integer)')),false)
);
rollback;
'@
 $lines=$preflight|& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At
 if($LASTEXITCODE-ne0){throw 'Read-only preflight failed. Nothing installed.'}
 $state=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$state-or@($state.PSObject.Properties).Count-ne6){throw 'Read-only preflight incomplete.'}
 foreach($p in $state.PSObject.Properties){if($p.Value-ne$true){throw "Preflight failed: $($p.Name). Nothing installed; inspect safely."}}
 New-Item -ItemType Directory -Force -Path $folder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-061-$stamp.dump";$partial="$file.partial"
 Write-Host 'Creating fresh full private backup...'
 & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
 if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
 & "$bin\pg_restore.exe" --list $partial|Out-Null
 if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
 Move-Item -LiteralPath $partial -Destination $file
 if((Read-Host 'Type INSTALL 061')-cne'INSTALL 061'){throw 'Cancelled before installation.'}
 Test-ReviewedFiles
 & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
 if($LASTEXITCODE-ne0){throw 'Installation failed or result uncertain. Inspect status before retrying.'}
 $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Post-install audit failed. Do not publish the website yet.'}
 $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$audit-or@($audit.PSObject.Properties).Count-ne9){throw 'Post-install audit incomplete.'}
 foreach($p in $audit.PSObject.Properties){if($p.Value-ne$true){throw "Post-install check failed: $($p.Name). Do not publish yet."}}
 [ordered]@{format='ORL-061-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');
  backup_file=[IO.Path]::GetFileName($file);backup_sha256=(Get-ReviewedHash $file);
  migration061_sha256=(Get-ReviewedHash $migration);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $folder "ORL-061-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host 'SUCCESS: 061 installed and audited. New bookings cannot target past OT dates. Historical records are unchanged.' -ForegroundColor Green
 Write-Host 'Tell GPT SUCCESS so the reviewed website update can be published. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
