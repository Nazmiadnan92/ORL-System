import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const script=readFileSync(new URL('../../security/release/verify-c4.ps1',import.meta.url),'utf8');
const cmd=readFileSync(new URL('../../security/release/Jalankan-C4.cmd',import.meta.url),'utf8');
const runbook=readFileSync(new URL('../../security/release/C4-VERIFICATION-RUNBOOK.md',import.meta.url),'utf8');

test('C4 release is a read-only production backup plus isolated localhost restore',()=>{
  assert.match(script,/begin read only;/i);
  assert.match(script,/pg_dump\.exe/);
  assert.match(script,/pg_restore\.exe/);
  assert.match(script,/127\.0\.0\.1/);
  assert.match(script,/--schema=public --schema=orl_private/);
  assert.match(script,/validate the restored snapshot internally/i);
  assert.match(script,/\$restoredStatus\.identities-ne\[int\]\$restoredStatus\.nonblank/);
  assert.match(script,/\$restoredStatus\.recovery_ready/);
  assert.match(script,/orl_ic_c1_finalize_full_dump_recovery/);
  assert.match(script,/ROTATE C1 GENERATION AND INVALIDATE SESSIONS/);
  assert.match(script,/\$localStatus\.sessions-ne0/);
  assert.doesNotMatch(script,/orl_ic_c1_import\s*\(/i);
  assert.match(runbook,/No production Restore/i);
});

test('C4 validates recovery key, every restored envelope and search hash without value output',()=>{
  assert.match(script,/ConvertFrom-OrlRecovery/);
  assert.match(script,/Test-OrlIdentityRows/);
  assert.match(script,/FixedTimeEquals/);
  assert.match(script,/HMACSHA256/);
  assert.match(script,/No patient IC or encryption key was printed/);
  assert.doesNotMatch(script,/Write-Host\s+\$raw/);
  assert.doesNotMatch(script,/Write-(?:Host|Output).*patient_ic_b64/);
});

test('C4 uses hidden prompts, reviewed TLS and guarded cleanup',()=>{
  assert.match(script,/Read-Host \$Prompt -AsSecureString/);
  assert.match(script,/sslmode=verify-full/);
  assert.match(script,/ExpectedDerSha256 '807025AD/);
  assert.match(script,/StartsWith\(\$orlResolvedRoot/);
  assert.match(script,/Remove-Item -LiteralPath \$candidate -Recurse -Force/);
  assert.match(cmd,/verify-c4\.ps1/);
});
