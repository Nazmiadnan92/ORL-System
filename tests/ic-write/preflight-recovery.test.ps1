param([Parameter(Mandatory=$true)][ValidateSet('Pre','Post')]$Phase)
$ErrorActionPreference='Stop'
$orlPsql=$env:ORL_IC_TEST_PSQL
$orlPort=$env:ORL_IC_TEST_PORT
if(!$orlPsql -or $orlPort-ne '55461'){throw 'Disposable C1 runner environment required.'}
. (Join-Path $PSScriptRoot '..\..\security\release\Get-OrlC1RecoveryGuardSql.ps1')
$orlArgs=@('-X','-qAt','-h','127.0.0.1','-p',$orlPort,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1')
function Invoke-OrlSql([string]$Sql,[bool]$ExpectSuccess=$true){
  $orlOutput=$Sql | & $orlPsql @orlArgs 2>&1
  $orlOk=$LASTEXITCODE-eq 0
  if($orlOk-ne $ExpectSuccess){throw "Unexpected recovery-guard result: $($orlOutput-join ' ')"}
  $orlOutput
}
if($Phase-eq 'Pre'){
  Invoke-OrlSql (Get-OrlC1RecoveryGuardSql -Expected046 $false) | Out-Null
  Write-Output 'PASS: pre-046 preflight does not resolve the absent recovery function.'
  return
}
Invoke-OrlSql (Get-OrlC1RecoveryGuardSql -Expected046 $true) | Out-Null
$orlGuard=Get-OrlC1RecoveryGuardSql -Expected046 $true
$orlClosed="begin; update orl_private.c1_database_identity set database_name='c1_closed_fixture'; $orlGuard rollback;"
Invoke-OrlSql $orlClosed $false | Out-Null
$orlReady=(Invoke-OrlSql 'select orl_private.c1_recovery_ready()') -join ''
if($orlReady-ne 't'){throw 'Closed-fence rollback did not preserve recovery readiness.'}
Write-Output 'PASS: post-046 open recovery passes and a closed recovery fence fails without persisting changes.'
