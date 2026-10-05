# C7 final audit — database and recovery passed; website observation pending

Scope: IC access controls, post-C6 workflows and recovery of the application schemas.
This is not independent IT approval, a penetration test, or proof against all breaches.

## Repairs found by local regression

1. Masked Malaysian IC values were rejected by DOB age parsers. Migration 052 and
   frontend cache 077 accept the exact first-six-visible mask, preserving date
   validation and manual age fallback for passports. No full IC is revealed.
2. Patient-history grouping could merge different patients sharing a mask. It now
   uses matching MRN or the exact request ID; a mask alone never identifies a patient.
3. Application import and offline recovery contained unqualified DELETE statements.
   Migration 052 adds predicates on non-null primary keys without disabling protection.
4. Reveal leases blocked application restore and permanent removal through a
   foreign key. The authorized, locked import clears temporary leases before
   replacing requests. Authorized permanent removal clears leases only for the
   already-reviewed target IDs and retains the reveal audit. Persistent audit
   records follow the existing explicit backup restore policy during full import.

052 changes function definitions only. It does not run import, purge patient rows,
invalidate production sessions or rerun C6. It requires a completed C6 and exact
reviewed function-body hashes; a mismatch rolls back the whole migration.

## Operator sequence

Run Jalankan-C7.cmd on the authorized PC:

1. Enter DATABASE password privately. A fresh private backup is created. Type
   INSTALL 052 to install the reviewed repair and check access controls.
2. Enter DATABASE password again, then KEY RECOVERY passphrase. The verifier
   creates a fresh dump, restores public/orl_private into a disposable localhost
   database, checks restored access controls, tests fail-closed recovery, rotates
   only the local generation and invalidates only restored sessions.
3. Every restored IC/passport is authenticated/decrypted in memory, compared with
   its display mask and independently checked against its keyed search hash.
4. Enter WEBSITE username/password for a temporary live read-only observation.
   No patient creation, change, reveal, deletion or production Restore is performed.

Require all green SUCCESS messages and review the sanitized reports. If 052
already succeeded but a later check failed, use Sambung-C7-Semakan.cmd;
do not reinstall 052. If the installation result is uncertain, inspect status first.

Reports and dumps remain in the private local ORL-Private-Backups folder. Do not
upload them to the repository or chat. A failed .partial is not a verified backup.
The recovery-key archive is separate; keep both passwords and keys private.

## Verification and limitations

Local evidence, 2026-10-06: 99 core workflow tests passed; 118 browser, wiring,
crypto/backup and release tests passed; the separate shipped-definition C7 SQL
runner passed C2, C3 and the augmented C6/C7 integration. C7 recovery crypto and
mask-observer self-tests passed. The original combined runner first stopped at a
052 hash guard because C1's localhost-only fixture includes an extra runtime
guard; C7 now runs separately against shipped migrations, without relaxing any
production hash guard.

- Local synthetic SQL integration covers C2/C3/C6, 052 baseline/reinstall guards,
  unchanged patient rows during installation, age, access denials, authorized
  reveal, ciphertext application import, generation changes and recovery finalizer.
- Browser regressions cover DOB masking and patient-history mask collisions.
- Live access checks require zero structured operational plaintext IC, zero
  identity mismatches, closed private tables/functions, private RLS, C2 closure,
  browser denial of protected RPCs and an owner-only recovery finalizer.
- Production authenticated observation covers the role entered; synthetic tests
  cover additional roles. Live mutation workflows are not exercised on real patients.
- Full dump recovery rehearsal covers application schemas only, not Supabase
  Auth/Storage, hosted configuration, secrets provisioning or infrastructure failover.
- Masked IC still exposes DOB. Names, MRNs and clinical details remain sensitive.
  Historical backups may retain full IC; new full dumps still contain other patient
  information. Protect the entire backup, device and separately held recovery keys.
- Structured IC protection is not a guarantee that arbitrary free-text attachments
  or remarks never contain manually entered identifying information.

Confirmed 2026-10-06: operator installed 052 successfully. The private C7 sanitized
report completed at 2026-10-05T17:41:18Z was independently read: 332 requests,
331 identities, all 331 cryptographically verified after isolated restore;
zero structured plaintext IC rows and zero identity mismatches. Live and restored
security checks passed, restored sessions were invalidated, and temporary local
restore files were removed. No production Restore was performed.

Remaining gate: live website observation. The site still served cache 076 while
main contained 077; GitHub Actions had no build for commit 2f3f105. A Pages build
was explicitly requested using the existing authorized GitHub credential and
returned queued. The configured source remains main /docs; no hosting settings
were changed. Use Semak-C7-Website.cmd after publication, NOT the full C7 installer
or recovery runner. C7 is not closed until the authenticated live observation passes.

Publication follow-up: GitHub Pages run 37350619421 completed successfully for
2f3f105. The independent observe-c7.ps1 -PublicOnly check then passed: cache 077
and clinical 062 assets are live, protection is enabled, and missing/random
session requests are denied with safe headers. Only authenticated live observation
remains; Semak-C7-Website.cmd requests WEBSITE credentials only.
