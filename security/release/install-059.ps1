#Requires -Version 7.4
$ErrorActionPreference='Stop'
$bin='C:\Program Files\PostgreSQL\18\bin'
$migration=Join-Path $PSScriptRoot '..\..\supabase\059_global_subspecialty_statistics.sql'
$auditFile=Join-Path $PSScriptRoot 'audit-global-statistics.sql'
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt'
$folder=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ORL-Private-Backups'
$oldPassword=$env:PGPASSWORD;$password=$null
function Get-ReviewedHash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path);$sha=[Security.Cryptography.SHA256]::Create()
 try{return [Convert]::ToHexString($sha.ComputeHash($stream))}finally{$stream.Dispose();$sha.Dispose()}
}
function Test-ReviewedFiles {
 if((Get-ReviewedHash $migration)-cne'EE0B6A2529AAADF6FB08B5FE8F6D4EDCC6AA777087355C4B6535916E5A8BF476'){throw 'Reviewed migration 059 changed.'}
 if((Get-ReviewedHash $auditFile)-cne'58495B7B0397A436F795EDA572C81D864CB6ABEBF8F2CC2EA249D5372A581997'){throw 'Reviewed statistics audit changed.'}
}
try {
 Test-ReviewedFiles
 . (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
 Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
 $cap=$ca.Replace('\','/').Replace("'","\'")
 $conn="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$cap' connect_timeout=20"
 Write-Host 'STATISTICS / 059: private full backup, then aggregate statistics for all users.' -ForegroundColor Yellow
 Write-Host 'Patient-detail permissions, View OT, IC protection and maintenance are unchanged. No patient is modified.'
 $secure=Read-Host 'Paste DATABASE password (hidden; NOT website password)' -AsSecureString
 try{$password=[Net.NetworkCredential]::new('',$secure).Password}finally{$secure.Dispose()}
 if([string]::IsNullOrEmpty($password)){throw 'Database password was empty.'}
 $env:PGPASSWORD=$password
 $preflight=@'
begin read only;
select jsonb_build_object(
 'recovery_ready',orl_private.c1_recovery_ready(),
 'cutover_clean',coalesce((orl_private.c6_stats()->>'cutover_complete')::boolean
  and (orl_private.c6_stats()->>'plaintext_rows')::integer=0 and (orl_private.c6_stats()->>'identity_mismatch')::integer=0,false),
 'statistics_baseline',coalesce((select md5(regexp_replace(replace(prosrc,chr(13),''),'^[ \t]+','','gn'))='7f35c275ba286e08b7e14da8358d2d59'
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
 if($null-eq$state-or@($state.PSObject.Properties).Count-ne5){throw 'Read-only preflight incomplete.'}
 foreach($p in $state.PSObject.Properties){if($p.Value-ne$true){throw "Preflight failed: $($p.Name). Nothing installed; inspect safely."}}
 New-Item -ItemType Directory -Force -Path $folder|Out-Null
 $stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$file=Join-Path $folder "ORL-before-059-$stamp.dump";$partial="$file.partial"
 Write-Host 'Creating fresh full private backup...'
 & "$bin\pg_dump.exe" --dbname=$conn --format=custom --file=$partial --no-password
 if($LASTEXITCODE-ne0){throw 'Backup failed. Nothing installed.'}
 & "$bin\pg_restore.exe" --list $partial|Out-Null
 if($LASTEXITCODE-ne0){throw 'Backup archive check failed. Nothing installed.'}
 Move-Item -LiteralPath $partial -Destination $file
 if((Read-Host 'Type INSTALL 059')-cne'INSTALL 059'){throw 'Cancelled before installation.'}
 Test-ReviewedFiles
 & "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -f $migration
 if($LASTEXITCODE-ne0){throw 'Installation failed or result uncertain. Inspect status before retrying.'}
 $lines=& "$bin\psql.exe" -X --dbname=$conn --no-password -v ON_ERROR_STOP=1 -At -f $auditFile
 if($LASTEXITCODE-ne0){throw 'Post-install audit failed. Do not publish the website yet.'}
 $audit=($lines|Where-Object{$_-match'^\{'}|Select-Object -Last 1)|ConvertFrom-Json
 if($null-eq$audit-or@($audit.PSObject.Properties).Count-ne7){throw 'Post-install audit incomplete.'}
 foreach($p in $audit.PSObject.Properties){if($p.Value-ne$true){throw "Post-install check failed: $($p.Name). Do not publish yet."}}
 [ordered]@{format='ORL-059-SANITIZED-REPORT';completed_at=(Get-Date).ToUniversalTime().ToString('o');
  backup_file=[IO.Path]::GetFileName($file);backup_sha256=(Get-ReviewedHash $file);
  migration059_sha256=(Get-ReviewedHash $migration);audit=$audit
 }|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $folder "ORL-059-report-$stamp.json") -Encoding utf8NoBOM
 Write-Host 'SUCCESS: 059 installed and audited. Global counts enabled; patient permissions unchanged.' -ForegroundColor Green
 Write-Host 'Tell GPT SUCCESS so the reviewed website update can be published. Keep backups private.'
}catch {
 Write-Host ('STOP: '+$_.Exception.Message) -ForegroundColor Red
 Write-Host 'No production Restore was run. Keep backups private; do not repeat an uncertain installation blindly.'
 exit 1
}finally{$env:PGPASSWORD=$oldPassword;$password=$null}
