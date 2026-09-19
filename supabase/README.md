# ORL OT Management System — Database Migrations

This directory contains the PostgreSQL migrations used by the ORL OT Management System.

## Current database version

- Latest migration applied to production: `041_subspecialty_statistics.sql`
- Phase 4 installation confirmed by the operator after the guarded installer reported SUCCESS. Restore was NOT executed on production. Production Postpone/Cancel workflow smoke testing remains pending; Phase 1 login was confirmed working by the operator.
- Phase 5 checked Reassign installation confirmed by the operator after guarded installer SUCCESS. Matching frontend uses cache version 049; live Reassign smoke testing remains pending.
- Phase 6 migration 035 installation confirmed by the operator after guarded installer SUCCESS. Matching frontend uses cache version 050. Live Cancel/deletion approval smoke testing remains pending; no real-patient cancellation was performed for testing.
- Phase 7 migration 036 installation confirmed by the operator after guarded installer SUCCESS. Matching frontend uses cache 051. Live Postpone/Clear smoke testing remains pending; no real-patient action was performed for testing.
- Phase 8 migration 037 installation confirmed by the operator after guarded installer SUCCESS. SQL only; frontend 051 remains compatible. Live workflow smoke testing remains pending.
- Phase 9 migrations 038 and 039 confirmed installed by the operator after guarded installer SUCCESS. Frontend cache 052. Synthetic local tests passed; production Restore/deletion was not run for testing.
- Migrations 040 and 041 installation confirmed by the operator after guarded installer SUCCESS on 2026-09-19. Matching frontend cache 053 adds years/months, Doctor/Specialist name formatting and scoped sub-specialty statistics. Synthetic local tests passed; no production Restore or real-patient workflow action was performed for testing.
- Next migration number: `042`
- Production migrations must be treated as immutable history. Do not rename, reorder or edit migrations that have already been applied.

## Existing production database

Do **not** run migrations `001` to `041` again on the active database. New database changes must be placed in a new migration beginning with `042` and tested separately before being applied to production.

Editing or documenting files in this GitHub directory does not change the active Supabase database. A database changes only when SQL is deliberately executed against it.

## New database installation

For a completely new, empty database only:

1. Run the SQL files once in exact numerical order from `001` through `041`.
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

## Backup safety

The `.orlbackup` export contains operational information including patient requests, OT sessions, slots, holidays, settings and audit records. It also contains user identity mappings, but not user password hashes. Restore uses the accounts already present in the destination system.

- Store backup files privately in at least two secure locations.
- Keep the backup password separately from the backup file.
- Never commit an `.orlbackup` file to GitHub.
- Test restoration only in a separate test database first.
- Migration `026` must be present for stored patient age to be restored.

## Repository security

This repository may be public. SQL files must never contain real patient information, production credentials, API service keys or completed backup files.
