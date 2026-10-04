# IC protection — remaining-work checklist

This is the user-agreed NEW checklist for remaining work, not a restart of earlier
C1 implementation. Baseline was 114 passing local tests. Production remains unchanged;
completed implementation steps below mean locally implemented and tested, not deployed.

## C1: 14/15 steps complete locally

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
| 15 | Separately approved controlled installation and activation | In progress: preflight/key recovery, disabled Edge, private dump, atomic 046 and post-install gates passed. Exact-project Edge ENABLE and independent sanitized 401/403 public smoke passed. Operator reports hidden-local-token rate smoke passed 30 safe HTTP 400 validations then HTTP 429 with Retry-After 60, without a patient workflow. Cache 073/config 025 is staged ON; completion still requires exact-repository publish and live login/read-only role verification |

Do not advance steps merely because a related earlier test exists. Keep each step
scoped to the user's requested number; finish verification before marking it complete.
Remaining later packages: C2 legacy IC encryption (4 steps), C3 Reveal (3), C4 end-to-end
verification (4), C5 observation (2), C6 plaintext cutover/removal (4), C7 final audit and
backup (3). Full technical evidence and limits: `ic-protection-package-c.md`.
