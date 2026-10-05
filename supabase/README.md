# ORL OT Management System — Database Migrations

This directory contains the PostgreSQL migrations used by the ORL OT Management System.

## Current database version

- Latest migration applied to production: `049_ic_c3_authorized_reveal.sql` (guarded installer, fresh private dump and read-only role/privilege postcheck reported SUCCESS on 2026-10-05).
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
- Next new migration number: `050`.
- Production migrations must be treated as immutable history. Do not rename, reorder or edit migrations that have already been applied.

## Existing production database

Do **not** run migrations `001` to `049` again on the active database.

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
