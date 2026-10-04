function Test-OrlReviewedCa {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][string]$ExpectedDerSha256
  )
  if (!(Test-Path -LiteralPath $Path)) { throw 'Reviewed Supabase CA certificate is missing.' }
  $orlCertificate=New-Object Security.Cryptography.X509Certificates.X509Certificate2($Path)
  $orlSha=[Security.Cryptography.SHA256]::Create()
  try {
    $orlFingerprint=[BitConverter]::ToString($orlSha.ComputeHash($orlCertificate.RawData)).Replace('-','')
    if ($orlFingerprint -ne $ExpectedDerSha256) { throw 'Reviewed Supabase CA certificate changed.' }
    $orlNow=[DateTime]::UtcNow
    if ($orlNow -lt $orlCertificate.NotBefore.ToUniversalTime() -or $orlNow -ge $orlCertificate.NotAfter.ToUniversalTime()) {
      throw 'Reviewed Supabase CA certificate is outside its validity period.'
    }
  } finally {
    $orlSha.Dispose()
    $orlCertificate.Dispose()
  }
}
