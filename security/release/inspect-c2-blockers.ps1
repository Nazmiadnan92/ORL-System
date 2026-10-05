$ErrorActionPreference='Stop';$bin='C:\Program Files\PostgreSQL\18\bin';$passwordPtr=[IntPtr]::Zero;$plainPassword=$null
$ca=Join-Path $PSScriptRoot '..\..\..\ic-encryption-package-b\certs\supabase-prod-ca-2021.crt';$caParam=$ca.Replace('\','/').Replace("'","\'")
$connection="host=aws-0-ap-southeast-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.imrfmilqehcrvassuvuw sslmode=verify-full sslrootcert='$caParam' connect_timeout=20"
. (Join-Path $PSScriptRoot 'Test-OrlReviewedCa.ps1')
try{
  Test-OrlReviewedCa -Path $ca -ExpectedDerSha256 '807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA'
  Write-Host 'READ-ONLY C2 blocker inspection. No IC, name, MRN or clinical details are returned.' -ForegroundColor Yellow
  $securePassword=Read-Host 'Paste DATABASE password here using Ctrl+V, then press Enter (input is hidden)' -AsSecureString
  $passwordPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword);$plainPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  if([string]::IsNullOrEmpty($plainPassword)){throw 'Database password is required.'};$env:PGPASSWORD=$plainPassword
  $query=@"
begin read only;
select request_number,status,character_length(patient_ic) as characters,octet_length(patient_ic) as bytes,
 case when length(trim(patient_ic))>128 then 'LONGER_THAN_128'
      when patient_ic~'[^ -~]' then 'NON_ASCII_OR_HIDDEN_CHARACTER'
      when patient_ic!~'[A-Za-z0-9]' then 'NO_ASCII_LETTER_OR_DIGIT'
      else 'OTHER_UNSUPPORTED_FORMAT' end as blocker
from public.orl_requests r left join orl_private.request_identity i on i.request_id=r.id
where i.request_id is null and trim(coalesce(r.patient_ic,''))<>'' and not orl_private.c2_supported(r.patient_ic)
order by request_number;
rollback;
"@
  $query|& "$bin\psql.exe" -X --dbname=$connection --no-password -v ON_ERROR_STOP=1 -P pager=off
  if($LASTEXITCODE-ne 0){throw 'Read-only blocker inspection failed.'}
  Write-Host 'SUCCESS: inspection completed without returning the IC value.' -ForegroundColor Green
}catch{Write-Host $_.Exception.Message -ForegroundColor Red;exit 1}
finally{$env:PGPASSWORD=$null;$plainPassword=$null;if($passwordPtr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)}}
