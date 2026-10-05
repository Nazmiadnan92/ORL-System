# IC protection — remaining-work checklist

This is the user-agreed checklist for the C1 work. C1 is now installed, published and
operator-verified in production. No production Restore or synthetic patient mutation was
used for activation.

## C1: 15/15 steps complete

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Confirm Request, including interrupted-save recovery | Complete locally: 120-test full runner passed, 2026-10-02 |
| 2 | Assign Slot, both direct-slot and choose-after-submit flows | Complete locally: 131-test full runner passed, 2026-10-02 |
| 3 | Approve / Reject | Complete locally: 141-test full runner passed, 2026-10-04 |
| 4 | Clear Slot | Complete locally: 149-test full runner passed, 2026-10-04 |
| 5 | Request Delete / Deletion Approval | Complete locally: 160-test full runner passed, 2026-10-04 |
| 6 | OT/session/slot, holiday and relevant settings controls | Complete locally: 175-test full runner passed, 2026-10-04; holiday HTTP mocked, live runtime still gated |
| 7 | Database Repair compatibility | Complete locally: exact reviewed snapshot, Restore fence and atomic rollback tested; 181-test runner passed, 2026-10-04 |
| 8 | Complete legacy API and role/permission inventory and closure | Complete locally: 31 legacy entry points gated; service/private role inventory passed, 2026-10-04 |
| 9 | Print/Excel, history, audit and free-text IC exposure review | Complete locally: structured and free-text masking plus OT-list defensive mask tested, 2026-10-04 |
| 10 | Old Delete shortcut and unscheduled manual-count UX | Complete locally: permanent-delete shortcut removed; cancellation retained; unscheduled count is Webmaster-only, snapshot/version fenced and audited; 191-test runner passed, 2026-10-04 |
| 11 | Same-record concurrent-edit review and necessary protection | Complete locally: exact request revision carried through masked reads/Edit/Postpone and checked under row lock; concurrent/stale writes tested, 2026-10-04 |
| 12 | Fresh-target/full-dump recovery and missing/old reference handling | Complete locally: actual synthetic pg_dump/restore to a fresh target, pre-open gate, generation rotation/session invalidation and conservative reference resolution tested; 196-test runner passed, 2026-10-04 |
| 13 | Desktop/mobile/Edge runtime and size/time/rate verification | Complete locally: installed Edge desktop/mobile viewports, browser APIs/module, 8 MiB/2,000-record backup policy, 2 s body/25 s RPC deadlines and mandatory 30/min shared-rate contract tested; 204-test runner passed, 2026-10-04 |
| 14 | Guarded migration/deployment/cache/backup/rollback preparation | Complete locally: generated/hash-pinned 046, real shared PostgreSQL rate store and Edge entrypoint, cache 073/config 025 default-OFF, guarded private-backup installer, preflight and recovery runbook; actual disposable 046 install/reinstall refusal plus 207-test runner passed, 2026-10-04 |
| 15 | Separately approved controlled installation and activation | Complete, 2026-10-05: preflight/key recovery, verified private dump, atomic 046, recovery postcheck, exact-project Edge enable, sanitized public smoke and 30/minute rate smoke passed. Cache 073/config 025 was published at `9a70640`; the operator confirmed normal live login/read-only use. Migration 047 was then installed from a fresh verified backup to display Malaysian IC as first six digits plus `**-****`; cache 074 publishes the matching defensive browser/Excel mask. |

## C2: 4/4 steps complete

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Inventory and guarded migration 048 | Complete, 2026-10-05: exact-project preflight, fresh verified private dump, atomic install and private privilege postcheck passed |
| 2 | Controlled encryption backfill | Complete: one punctuation-only placeholder was backed up/cleared to optional blank; all 331 supported nonblank identities were encrypted in batches of at most 40 |
| 3 | Complete cryptographic reconciliation | Complete: every encrypted identity was decrypted and exactly compared with its source plus keyed search hash; version/current-generation receipts covered all 331 rows before finalization |
| 4 | Production completion and recovery copy | Complete: C2 finalization was recorded, plaintext was retained for C6, and a verified full post-C2 private dump was saved |

## C3: 3/3 steps complete

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Explicit Reveal policy and guarded migration 049 | Complete, 2026-10-05: Admin/Webmaster only, current-password and fixed-purpose checks, one-record two-minute authorization lease, 60-second display expiry, fresh verified private dump and production postcheck |
| 2 | Cryptographic Reveal gateway and audit | Complete: exact envelope plus keyed search hash are verified before release; commit is one-time, generation/version fenced and writes an audit row without the IC value; C3 Edge deployment reported SUCCESS |
| 3 | Safe responsive UI and verification | Complete: cache 075 supplies explicit Reveal, auto-hide on timeout/tab hiding, no browser persistence and no Staff button; 221 local tests passed. No real patient Reveal was performed merely for testing |

## C4: 4/4 verification steps complete

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Protected workflow regression | Complete locally: 224 tests plus synthetic C4 crypto passed; targeted checks rerun after restore-runner fixes |
| 2 | Recovery-key usability | Complete, 2026-10-05: operator entered the recovery passphrase privately; recovered keys verified all 331 restored identities and search hashes |
| 3 | Isolated actual-backup restore | Complete: public/orl_private restored with ACLs; fresh target started closed; local owner finalization rotated generation and invalidated restored sessions |
| 4 | Reconciliation and fresh private backup | Complete: 332 requests, 331 protected identities and 1 blank identity; sanitized report and matching dump SHA-256 independently checked; temporary restore removed |

This verifies the application schemas locally, with ownership mapped to the local
owner. It is not a full Supabase infrastructure/Storage recovery or production Restore
test. No production writes or plaintext removal occurred.

## C5: 2/2 observation steps complete

| Step | Scope | Status |
| --- | --- | --- |
| 1 | Public live-release and safe-denial observation | Complete, 2026-10-05: exact cache assets, enabled protection, absence of a public service-role variable, and sanitized missing/random-session Edge denials passed |
| 2 | Authenticated role-scoped read-only observation | Complete: Webmaster core reads succeeded; 156 populated identity fields were masked, no Reveal or patient mutation ran, and the temporary session logged out |

The sanitized private C5 report contains counts and control outcomes only. No patient
value, password, token or encryption key is recorded. No display correction or migration
was required.

Remaining later packages: C6 plaintext cutover/removal (4) and C7 final audit/backup
(3). Per the current model-cost preference, use GPT-5.6 Sol High for C6/C7. Full
technical evidence and limits: `ic-protection-package-c.md`.
