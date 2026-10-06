# ORL OT Management System — Database Migrations

This directory contains the PostgreSQL migrations used by the ORL OT Management System.

## Current database version

- C7 COMPLETE, 2026-10-06: migration 052 repairs masked-DOB age
  calculation and scoped recovery deletes, including temporary reveal-lease cleanup
  during explicit application restore. Frontend cache 077 prevents masked-IC patient
  history collisions and handles visible DOB prefixes. See
  ../security/release/C7-FINAL-AUDIT.md for verification and operator gates.

- Latest migration applied to production: `052_ic_c7_age_and_recovery.sql` (operator SUCCESS, 2026-10-06). C7 live/restored access checks and isolated recovery of all 331 identities passed; sanitized reports independently reviewed. Website cache 077 is live. Final WEBMASTER observation passed with 156 masked identity fields, zero patient mutations/reveals and successful temporary-session logout. All C7 gates are complete. Do not reinstall 052 or repeat the successful recovery.
- C6 completed, 2026-10-06: after repair 051, the operator confirmed fresh verification/cutover SUCCESS and the separate post-C6 check/backup SUCCESS. That check requires a cutover receipt, zero operational plaintext IC rows and zero identity mismatches. The completed post-C6 dump was independently found and its archive listing checked without exposing data. This new dump has not yet been restore-tested. The earlier attempt failed atomically with SQLSTATE 21000 (`UPDATE requires a WHERE clause`); 051 scopes the four free-text updates without disabling safe-update protections. Historical pre-C6 backups still require private handling because they can retain plaintext. C7 final audit remains pending.
- Package B foundation/synthetic scope is COMPLETE as of 2026-10-01 (Malaysia). Migration 045 installation and key recovery/backup are operator-confirmed. Six secret names are verified present. `ic-readiness` is deployed at pinned commit `2d63db73d9f744820c441d43de4733ef2a5d4266`; legacy JWT is OFF with custom Webmaster authorization. Live Webmaster crypto checks and missing/unknown/revoked-session denial passed (operator log reviewed). Readiness is DISABLED again, independently verified by HTTP 503. Packages C1, C2 and C3 are complete.
- Phase 4 installation confirmed by the operator after the guarded installer reported SUCCESS. Restore was NOT executed on production. Production Postpone/Cancel workflow smoke testing remains pending; Phase 1 login was confirmed working by the operator.
- Phase 5 checked Reassign installation confirmed by the operator after guarded installer SUCCESS. Matching frontend uses cache version 049; live Reassign smoke testing remains pending.
- Phase 6 migration 035 installation confirmed by the operator after guarded installer SUCCESS. Matching frontend uses cache version 050. Live Cancel/deletion approval smoke testing remains pending; no real-patient cancellation was performed for testing.
- Phase 7 migration 036 installation confirmed by the operator after guarded installer SUCCESS. Matching frontend uses cache 051. Live Postpone/Clear smoke testing remains pending; no real-patient action was performed for testing.
- Phase 8 migration 037 installation confirmed by the operator after guarded installer SUCCESS. SQL only; frontend 051 remains compatible. Live workflow smoke testing remains pending.
- Phase 9 migrations 038 and 039 confirmed installed by the operator after guarded installer SUCCESS. Frontend cache 052. Synthetic local tests passed; production Restore/deletion was not run for testing.
- Migrations 040 and 041 installation confirmed by the operator after guarded installer SUCCESS on 2026-09-19. Matching frontend cache 053 adds years/months, Doctor/Specialist name formatting and scoped sub-specialty statistics. Synthetic local tests passed; no production Restore or real-patient workflow action was performed for testing.
- Migration 042 installation confirmed by the operator after guarded installer SUCCESS on 2026-09-21. Frontend cache 058 displays role-scoped Main/Special availability in the special-day directory. Synthetic local tests passed; no production patient actions were performed for testing.
- Migration 043 installation confirmed by the operator after guarded installer SUCCESS on 2026-09-21. Frontend cache 059 separates Main/Special availability in month tabs and daily summaries; Staff sees Main only. Synthetic local database and frontend tests passed. No production patient operation was performed for testing.
- Package C1 completed on 2026-10-05: corrected read-only preflight, separately held key recovery, verified private full dump, atomic migration 046, recovery-ready postcheck, Edge enable, sanitized missing/random-session denials, shared 30/minute live rate contract, exact-repository cache 073/config 025 publish and operator-confirmed normal login/read-only use. No Restore or test patient mutation was used. Migration 047 then changed display masking only; it did not decrypt, delete or rewrite stored patient IC values.
- Package C2 completed on 2026-10-05: migration 048 and the C2-capable Edge gateway were installed after a verified private dump. One punctuation-only legacy placeholder was backed up, cleared to the optional blank state and audited without logging its value. All 331 remaining nonblank legacy identities were encrypted in controlled batches and cryptographically reconciled before finalization. A verified full post-C2 private dump was saved. Plaintext IC remains in `orl_requests` pending separately approved Package C6.
- Package C3 completed on 2026-10-05: migration 049 and the C3-capable Edge gateway were installed after a fresh verified private dump. Admin/Webmaster Reveal requires the current account password and one permitted purpose; each one-record access is generation/version fenced, cryptographically verified, audited without the IC value, and displayed for at most 60 seconds. Staff has no Reveal access. Cache 075 publishes the matching UI. No patient IC was revealed merely for testing and plaintext remains pending Package C6.
- C1 legacy gates cover thirty-one entry-point names. Protected workflows and masked reads pass after gating; Database Repair is Webmaster/service-only and Restore-generation fenced. Audit/history/free-text output and generated OT lists defensively mask known identifiers. Administrative controls retain patient/identity records and refuse stale metadata snapshots or lock contention. The actual 018 parser is tested with synthetic HTTP responses only; live holiday-fetch accuracy remains an operational check.
- Package C4 verification completed on 2026-10-05: fresh full private dump, isolated local application-schema restore with ACLs, recovery fence/finalizer/session invalidation and recovered-key comparison of all 331 encrypted identities passed. Sanitized report and backup SHA-256 independently checked after operator SUCCESS; temporary restore removed. This is not a full Supabase infrastructure/Storage recovery. No new migration, production Restore or plaintext removal.
- Package C5 observation completed on 2026-10-05: exact live assets/protection state and sanitized Edge denials passed, followed by one temporary Webmaster read-only session. Core role-scoped reads passed, all 156 populated identity fields observed were masked, no Reveal/patient mutation ran, and logout was confirmed. The sanitized private report contains no patient value or secret. No migration or display fix was required; C6 remains a separate approval gate.
- No prepared migration remains pending for C6. Next unused migration number: `052`.
- Production migrations must be treated as immutable history. Do not rename, reorder or edit migrations that have already been applied.

## Existing production database

Do **not** run migrations `001` to `051` again on the active database.

Editing or documenting files in this GitHub directory does not change the active Supabase database. A database changes only when SQL is deliberately executed against it.

## New database installation

For a completely new, empty database only:

1. Run the production SQL files once in exact numerical order. Migration 045 creates the empty IC foundation. Migration 046 additionally requires the reviewed C1 Edge/recovery procedure and must remain OFF until its release runbook prerequisites are satisfied. Migration 047 applies the approved final-six display mask. Migration 048 installs the controlled C2 backfill/reconciliation controls. Migration 049 installs purpose-bound Reveal leases; follow the matching release runbooks rather than invoking these controls ad hoc.
2. After migration `003`, create the first Webmaster manually in the private Supabase SQL Editor.
3. Replace every placeholder in the example below. Never save the completed statement, username or password in GitHub.

```sql
insert into public.orl_users
  (username, password_hash, display_name, role, is_active)
values
  ('CHOOSE_USERNAME', crypt('CHOOSE_A_LONG_UNIQUE_PASSWORD', gen_salt('bf', 12)),
   'CHOOSE_DISPLAY_NAME', 'WEBMASTER', true);
```

4. Confirm that login and the main modules work using test data before any real patient data is introduced.

## Migration order

| No. | File | Purpose |
| --- | --- | --- |
| 001 | `001_orl_schema.sql` | Core tables, indexes and system settings |
| 002 | `002_lock_down_tables.sql` | Table access restrictions and row-level security |
| 003 | `003_custom_login.sql` | Custom login and session management |
| 004 | `004_schedule_and_requests.sql` | Initial OT schedule, slots and request workflow |
| 005 | `005_request_management.sql` | Staff requests and management review |
| 006 | `006_full_management.sql` | Administration and slot management APIs |
| 007 | `007_schedule_parity.sql` | OT schedule controls and presentation parity |
| 008 | `008_postponed_deletion_management.sql` | Postponed and deletion management |
| 009 | `009_request_schedule_workflow.sql` | Request scheduling and postponement workflow |
| 010 | `010_cancel_and_patient_search.sql` | Cancellation slot release and patient search |
| 011 | `011_ot_day_titles.sql` | Special OT day titles |
| 012 | `012_database_management.sql` | Webmaster database management functions |
| 013 | `013_staff_cancel_review.sql` | Review requirement for Staff cancellations |
| 014 | `014_close_ot_slots.sql` | Close and reopen empty OT slots |
| 015 | `015_dashboard_upgrade.sql` | Role-aware dashboard data |
| 016 | `016_encrypted_backup_restore.sql` | Portable backup and restore |
| 017 | `017_account_settings_and_themes.sql` | Account settings and saved themes |
| 018 | `018_generate_malaysia_holidays.sql` | Malaysia and Kedah holiday management |
| 019 | `019_block_holiday_slots.sql` | Holiday slot blocking and authorised override |
| 020 | `020_year_based_ot_capacity.sql` | Year-based Main OT slot capacity |
| 021 | `021_schedule_list_and_cancellation.sql` | Detailed schedule and cancellation records |
| 022 | `022_request_age_and_staff_edit_permissions.sql` | Patient age and role-aware editing |
| 023 | `023_duplicate_request_protection.sql` | Duplicate active-request protection |
| 024 | `024_deletion_approval_repair.sql` | Deletion approval and slot compaction repair |
| 025 | `025_interactive_ot_schedule.sql` | Interactive schedule request origin |
| 026 | `026_restore_patient_age.sql` | Restore patient age from portable backups |
| 027 | `027_smart_patient_search.sql` | Secure search by MRN, IC/Passport or patient name |
| 028 | `028_slot_swap_unique_constraint_repair.sql` | Safe reassignment between occupied or available Main OT slots |
| 029 | `029_special_slot_reassignment.sql` | Admin/Webmaster reassignment between Main and Special OT slots |
| 030 | `030_login_null_password_guard.sql` | Reject NULL/empty credentials and compare password hashes safely |
| 031 | `031_postpone_staff_field_guard.sql` | Restrict Staff Postpone edits to surgery/diagnosis and reject NULL ownership |
| 032 | `032_staff_cancel_clinical_guard.sql` | Prevent clinical edits via Staff cancellation; reject NULL ownership for ordinary Staff edits |
| 033 | `033_restore_section_validation.sql` | Reject missing/malformed portable-backup sections before destructive restore |
| 034 | `034_checked_slot_reassignment.sql` | Reject stale Reassign selections after slot locking |
| 035 | `035_checked_cancellation_compaction.sql` | Checked Edit/Cancel identity, locked compaction and deletion approval |
| 036 | `036_checked_postpone_clear.sql` | Reject stale Postpone/Clear selections and retire unchecked entry points |
| 037 | `037_request_assignment_review_guards.sql` | Pending-review and assignment integrity; null-safe Staff ownership |
| 038 | `038_booking_history_snapshot.sql` | Preserve original booking names |
| 039 | `039_restore_and_removal_safety.sql` | Restore metadata, concurrency and removal safety |
| 040 | `040_age_months_doctor_names.sql` | Infant age precision, name formatting and age-aware backup restore |
| 041 | `041_subspecialty_statistics.sql` | Role-scoped, filtered and paginated sub-specialty statistics |
| 042 | `042_special_day_availability.sql` | Aggregate Main/Special availability and session status for titled OT days |
| 043 | `043_split_month_availability.sql` | Role-scoped split Main/Special monthly availability, retaining legacy total |
| 044 | `044_required_password_change.sql` | Optional next-login password change with server-enforced access blocking and password rules |
| 045 | `045_ic_encryption_foundation.sql` | Empty private encrypted-identity storage and service-only Webmaster readiness RPC; no patient migration |
| 046 | `046_ic_c1_guarded_cutover.sql` | Guarded C1 protected workflows, masked reads, backup V2, recovery fences and shared rate store; activation remains separate |
| 047 | `047_mask_ic_last_six.sql` | Preserve the first six Malaysian IC digits and mask the final six in structured and free-text outputs; no patient-data rewrite |
| 048 | `048_ic_c2_controlled_legacy_backfill.sql` | Controlled legacy identity encryption in version-fenced batches plus complete cryptographic reconciliation; plaintext retained pending C6 |
| 049 | `049_ic_c3_authorized_reveal.sql` | Purpose-bound, audited Admin/Webmaster Reveal |
| 050 | `050_ic_c6_plaintext_cutover.sql` | C6 preparation, encrypted-only writes/search/backup and separately invoked plaintext cutover |
| 051 | `051_ic_c6_scoped_updates.sql` | Repair four C6 free-text updates with change-specific WHERE predicates; does not itself execute cutover |

Package B design, key recovery requirements, tests and installation sequence are in
[`security/ic-protection-package-b.md`](../security/ic-protection-package-b.md).
The protected version-2 `.orlbackup` format includes encrypted identity envelopes and
creation-recovery receipts, but never includes encryption keys or Edge Function secrets.
Keep the recovery keys separately from both the backup file and its passphrase.

## Backup safety

The `.orlbackup` export contains operational information including patient requests, OT sessions, slots, holidays, settings and audit records. It also contains user identity mappings, but not user password hashes. Restore uses the accounts already present in the destination system.

- Store backup files privately in at least two secure locations.
- Keep the backup password separately from the backup file.
- Never commit an `.orlbackup` file to GitHub.
- Test restoration only in a separate test database first.
- Migration `026` must be present for stored patient age to be restored.

## Repository security

This repository may be public. SQL files must never contain real patient information, production credentials, API service keys or completed backup files.

## Full-IC OT Excel export (053)

Production migration, Edge deployment and website publication verified on
2026-10-06 (Asia/Kuala_Lumpur). Release commit: 69dfaa3; restore tag:
restore/pre-ot-export-20261006. Migration 053 report confirms all nine checks,
zero plaintext rows and zero identity mismatches; its private backup hash matches.
All 12 deployed Edge source files match the reviewed code (ic-requests version 9).
GitHub Pages run 37358412709 completed successfully; seven published assets,
including the unchanged workbook template, match the local release.
Existing Generate/Print stays Admin/Webmaster only and requires the current website
password and clinical-use acknowledgment. The server selects the OT-date patient
list, verifies encrypted identities and commits an OT_LIST_FULL_IC_GENERATED audit
before releasing full IC. The audit contains actor, role, server time, OT date,
patient count and export reference, not IC values. It records authorized release,
not proof of a completed download or physical printing.

Ordinary schedule views remain masked. No patient fields or keys are changed.
Excel layout is unchanged, with one row per patient. Saved full-IC files are
sensitive and must be stored and shared securely.

Release order: run security/release/Pasang-OT-Export.cmd, privately enter the
database password, then confirm INSTALL 053 after its fresh full backup.
The same window verifies the exact project and prompts DEPLOY OT EXPORT EDGE.
Inspect the sanitized ORL-053 report in the private backup folder before publishing
app/client 078 and ot-excel 067. This release sequence is now completed; do not
rerun the installer. Stop on failure; do not blindly reinstall.
The older website remains compatible with the additive backend.

Verification: 70 focused browser/gateway/release tests and four isolated database
integration suites passed, including migration 053. Synthetic workbook checks
cover 1, 3 and 8 rows; role/password denial, stale data, expired/replayed leases,
changed login, audit failure, blank IC, and no full IC in the schedule cache.

Live checks also confirmed missing/invalid sessions are denied, both direct
export RPCs reject public callers, and the published login page loads the
audited export implementation with no script errors. No real-patient export or
clinical mutation was performed during verification. Operator acceptance:
generate an authorized OT list and confirm its OT_LIST_FULL_IC_GENERATED entry
in Audit Log; keep the full-IC workbook private.

OT export hotfix (2026-10-06): the production backend RPC adapter was missing
the two export RPC allowlist entries, causing authenticated exports to fail
before reaching the database. Added only orl_ic_ot_export_view and
orl_ic_ot_export_commit; no migration, credential, patient or frontend changes.
A regression test reproduces the old HTTP 403 through the actual production
adapter and verifies Admin/Webmaster success, Staff denial, audit-failure
non-disclosure and rejection of unreviewed RPCs after the fix. All 71 focused
tests pass. Edge version 9 was deployed and its 12 source files verified.
Real-patient download and Audit Log acceptance still require operator confirmation.

### Session helper API lockdown — 054 (2026-10-06)

Status: installed and verified in production on 2026-10-06 at 09:43 MYT.
This addresses re-audit finding 1 only. Login
throttling and the Reveal modal race are separate, unchanged findings.

The internal `orl_require_session(uuid)` returns an account row including its
password hash. Revoking PUBLIC alone in 004 did not remove explicit client
EXECUTE grants. Migration 054 revokes PUBLIC, anon, authenticated and service_role
access to this exact helper, retaining trusted SECURITY DEFINER owner calls.
It changes no function bodies, accounts, sessions, patient data or keys. It is
repeat-safe but refuses unexpected overloads, residual inherited access or loss
of trusted caller privileges. Do not restore the insecure grants as a shortcut.

Run `security/release/Pasang-054.cmd`, enter the DATABASE password privately and
confirm `INSTALL 054` only after the fresh private full backup succeeds. TLS and
reviewed-file hashes are checked; the final six-check audit and backup hash are
saved in an `ORL-054-SANITIZED-REPORT` under the existing private backup folder.
No Edge or website publication is needed. On uncertain results inspect the
read-only audit before retrying. After success, verify the public helper RPC
rejects a fabricated session with permission-denied code 42501 (or is absent
from the API schema), rather than executing and returning session error 28000.
Do not use a real session to test hash disclosure.

Production verification: ORL-054-report-20261006-094319.json reports all six
checks true. Its migration hash matches the reviewed 054 file, and the private
backup hash matches the recorded archive. A direct public RPC request using a
fabricated session now returns HTTP 401 / PostgreSQL 42501 (permission denied),
instead of executing the helper. The website returns HTTP 200. No real account
token, password hash or patient record was read during the live check. A real
user login was not performed; role/login compatibility was tested synthetically.
No Edge or frontend deployment was required; do not rerun the installer.

Verification: `tests/ic-write/run-c7-local.ps1 -WithSessionHelperGuard` passed
five isolated database suites, with Supabase-style explicit public-schema
function grants enabled from the initial replay. Coverage includes inherited
grant rollback, repeat installation, unchanged data/function bodies/other ACLs,
Staff/Admin/Webmaster login via anon and authenticated, direct helper denial even
with valid synthetic tokens, internal Edge/public reads, required password
change, logout/deactivation and audited OT export after the lockdown. Six focused
release/export browser/gateway tests also passed. The full local runner now
includes this guarded replay. These are synthetic tests, not real-patient access.

## 055 — Postpone missing record revision

Installed and verified in production on 2026-10-06. Sanitized receipt
`ORL-055-report-20261006-162116.json` reports all six checks true; the actual
private backup and migration file hashes match the receipt. The exact and
recursive record revisions, reviewed function body, private access, recovery
readiness and completed cutover passed. No real patient was moved by this
verification; user acceptance of Postpone after refreshing remains pending.
Do not rerun the installer after this successful installation.
The final 046 `c1_mask_json` replacement retained free-text redaction but omitted
the earlier `_ic_edit_version` enrichment. Consequently actual schedule rows
lacked the exact `orl_requests.updated_at` token required by protected Postpone.
The browser correctly stopped before sending MOVE. The independent read fixture
already included the token, which had hidden this shipped-definition regression.

055 replaces only the uniquely identified insertion point in the hash-reviewed
masker body. It restores authoritative microsecond-precision timestamps for
valid request IDs without changing patient data, encryption, ACLs or stale-write
validation. It refuses an unexpected/already-patched body and rolls back if
private helper access is not closed. No frontend or Edge deployment is required.

Run `security/release/Pasang-055.cmd`, privately enter the DATABASE password,
then type `INSTALL 055` after a fresh full private backup succeeds. The installer
pins migration/audit files and verifies TLS. Its read-only six-check audit
checks the resulting function hash, exact and recursive revision enrichment,
private access, recovery readiness and the completed plaintext cutover. It
returns only boolean checks, not patient values. The sanitized receipt and
backup remain in the private backup folder. On uncertain results inspect the
read-only audit before retrying; do not blindly reinstall. After success refresh
the OT Schedule and reopen the form; already-open forms still lack the token.

Verification: `tests/ic-write/run-c7-local.ps1 -WithPostponeVersion` passed six
isolated integration suites replaying the shipped migrations with Supabase-style
explicit grants. The new test reproduces the failure before 055, then exercises
actual schedule output through the app form helpers, browser router, Edge gateway
and SQL MOVE with synthetic Webmaster/Admin/Staff accounts. Cross-date moves,
Staff special-slot denial, microsecond stale-write rejection, replay rejection,
unchanged encrypted identity, postpone audit, masking and the production audit
all passed. Installation leaves request/identity/slot/session data unchanged.
Eight focused release/export tests also passed. No real patient was moved during
testing. The full local runner now includes this shipped-definition regression.

## 056 — Webmaster maintenance mode

Server migration verified in production on 2026-10-06 using sanitized receipt
`ORL-056-report-20261006-180955.json`: all six checks passed, and backup/migration
file hashes match the receipt. A separate public status request confirmed OFF,
revision 0 and no estimated end. Do not rerun the installer. Frontend release
uses app cache 080 and maintenance.js/css 001. Do not publish the frontend
first: an unavailable status is treated as unavailable access for non-Webmasters.
No Edge deployment is required. Never turn production maintenance ON just to test
this release; all toggle tests used disposable synthetic data.

Run `security/release/Pasang-056.cmd`, privately enter the DATABASE password,
then type `INSTALL 056` after the fresh full private backup. TLS/certificate and
reviewed-file hashes are verified. Installation defaults OFF and does not alter
patients, encrypted identities or sessions. The six-boolean sanitized receipt
is saved under ORL-Private-Backups. On success verify the receipt/archive hashes,
confirm public `orl_maintenance_status` reports OFF, then publish the frontend.
On uncertain outcomes inspect the read-only audit; do not repeat installation.

Webmaster Settings includes ON/OFF, a public notice (no patient details), optional
estimated completion in Malaysia time, website-password confirmation and an
explicit warning about unsaved work. Estimates do not automatically reopen the
system. Stale revision, wrong password, inactive/password-change-required accounts
and Admin/Staff control requests are denied by SQL. ON/OFF records actor, role,
time and notice in Audit Log. An uncertain save is never retried automatically.

The existing private session helper retains recovery/password/session guards
and denies protected reads and writes to non-Webmasters during maintenance.
It holds a shared maintenance-row lock for these transactions: enabling ON waits
for already-authorized work to commit/rollback. A lock timeout leaves the switch
unchanged. Webmaster remains able to work and turn maintenance OFF. Public notice,
login/profile/logout and required-password-change flows remain accessible; they
do not grant clinical access. The private state table cannot be read or modified
directly by client/service roles. Portable operational .orlbackup import does not
reset this separate control; full database backups include it.

UI polls every 30 seconds and on focus, hides the clinical view, closes forms,
and blocks further dispatch/results when maintenance is observed. Older cached
clients still encounter the server gate but need refresh for the new notice.
Data already downloaded/printed cannot be recalled; this is not backup, key
rotation, protection from a compromised Webmaster, or an OS/server outage mode.

Verification: seven shipped-definition isolated SQL suites pass, including the
new OFF/ON/OFF, role/password/revision, fresh and existing session, lock-draining,
unchanged patient/ciphertext, audit and inherited-access tests. Browser tests cover
actual app bootstrap/RPC hooks, open-form removal, Webmaster Settings, public login,
mobile viewport, text-only notice rendering, changed login and status failure.
All 138 broader frontend/gateway/release tests pass. Production installation is
verified; website assets must be checked against this release after publication.
