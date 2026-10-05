# Package C — controlled IC encryption rollout

## Checkpoint, 2026-10-01 Malaysia

**C1 production activation is complete.** Migration 046, the exact-project Edge gateway
and cache 073/config 025 were installed and published. Recovery, public-denial,
shared-rate and operator live-login/read-only checks passed without Restore or a test
patient mutation. Migration 047 was subsequently installed from a fresh verified private
backup to preserve the first six Malaysian IC digits and mask the final six; cache 074
contains the matching browser and Excel display policy.

Local source restore point: `restore/pre-ic-package-c1-20261001` at `2560f05`.
This is a Git source checkpoint, NOT a database backup or key backup.

## Work completed in this checkpoint

- Inspected the active creation, scheduled edit, postponed move, age, export/import and
  deletion definitions through 045, together with the browser's write calls.
- Prepared a **non-deployed** HTTP handler at `security/candidates/c1-create/handler.mjs`.
  It has no serving entrypoint, no website route, and defaults to disabled.
- Added a loopback-only SQL experiment at `tests/ic-write/candidate.sql`, deliberately
  outside the production migration directory. This is NOT migration 046. Installation
  and execution require the disposable runner's local database owner and loopback address.
- The test derives the reviewed clinical creation body from immutable migration 040,
  confirms that it matches the installed local function, and adds an explicit UUID to
  bind authenticated encryption to the new record before a single database commit.
  At this initial creation-only checkpoint, all 72 pre-existing public function bodies, grants and search paths remained unchanged
  (71 through 044 plus the 045 probe); pre-existing synthetic requests remain unchanged.
- A new request, encrypted shadow identity and audit events commit together. Constraint,
  validation or authorization failure rolls them back together. Sequence numbers may
  still have gaps after rollback, as in the existing PostgreSQL sequence workflow.
- AES-GCM/HMAC keys are ephemeral synthetic values in test memory only. Patient IC,
  session, key, ciphertext and search hash are not included in HTTP results or audit details.
- A valid session is required before crypto and checked again in the database write.
  Staff/Admin/Webmaster retain existing clinical and duplicate-override rules.
- Unsupported ICs are rejected rather than silently changed; optional blank IC keeps
  manual age, including zero years/six months. Missing keys never permit plaintext fallback.
- Timeouts after submission report an **unconfirmed save**, with no automatic retry.
  Reusing a UUID cannot overwrite a prior record. The final frontend still needs explicit
  recovery/reconciliation for a response lost after a successful commit.

**This candidate uses dual-write (encrypted shadow + original plaintext).** It is a
transition for reconciliation, not completed at-rest protection. The backend must see
plaintext to encrypt it; the SQL experiment trusts the backend to supply the matching
verified envelope. Clients have no EXECUTE permission on that service-only RPC. This
does not defend against a compromised backend/service credential.

## Follow-up: compatibility candidate (local only)

The next local checkpoint adds `tests/ic-write/compatibility.sql` and server-side
orchestration helpers in `security/candidates/c1-create/compatibility.mjs`:

- Explicit KEEP/SET identity semantics. KEEP excludes `patient_ic` entirely; SET
  requires Admin/Webmaster. Masked placeholders are rejected by the backend helper.
- Edit and Postpone share the existing sorted slot-lock order and expected-request
  checks. Clinical update, ciphertext/HMAC replacement and audit commit together.
- A private transaction-scoped permit (IDs only, **no plaintext IC**) lets the checked
  backend transaction update a protected IC. A database trigger blocks older RPCs from
  silently changing that IC without refreshing its shadow. It still allows clinical
  updates with unchanged IC. Permits are removed before return and roll back on error.
- Compatible permanent removal requires Webmaster plus password, deletes only the
  selected identities and then uses the existing checked removal/compaction workflow.
  A failure later in deletion restores the identities as part of transaction rollback.
- Version-2 backup includes encrypted identities, key IDs, and per-request coverage
  flags, **not key material**. Operational tables are read-locked with NOWAIT so an
  overlapping writer causes a busy refusal instead of an inconsistent snapshot.
- Backend verification decrypts every included identity, compares the exact original
  IC and recomputes its HMAC. Missing keys, corrupted ciphertext, swapped record binding,
  missing/duplicate/orphan identities or incomplete sections are refused. Verification
  returns its private cloned payload, not an object the caller can mutate during await.
- Compatible Restore revalidates Webmaster/password in the database, takes the existing
  restore lock and operational table locks, then restores operational rows and identities
  in one transaction. Missing sections, invalid links or envelope constraints roll back
  the attempted restore, including any preceding identity deletion.

The new service-only restore RPC **trusts the backend's cryptographic verification**;
SQL cannot validate AES-GCM without keys. A production HTTP adapter must authenticate
and verify before calling it, pass the verified clone, bound upload size/time, sanitize
errors and handle timeouts without automatic retries. That adapter is not deployed.

Version-1 backups are deliberately refused by this new restore path, not silently
converted. Existing version-1 files are NOT made invalid for the unchanged production
system; their future protected-restore conversion/recovery path still needs implementation
and testing before rollout. Original plaintext remains in version-2 shadow backups at
this phase; retain the existing encrypted `.orlbackup` file envelope and private storage.

## Follow-up: server-masked reads and browser/file adapters (local only)

`tests/ic-write/reads.sql` tests a controlled replacement of public read signatures:
Schedule, current patient search, Postponed, Deletions, Statistics, Database cancelled/
search/duplicates, Requests and Dashboard. Original filtering/session logic is retained
in non-callable private cores; the public wrappers mask structured IC before it leaves
the database. Database duplicate groups also mask `match_value` for IC groups. Original
plaintext is still used internally in this shadow phase to calculate age at OT date and
perform exact IC search; this is NOT the final HMAC-only search cutover.

The old MRN-only `orl_find_patient` body in migration 010 does not restrict Staff to
their own requests. The local candidate redirects that public signature through the
current scoped search, keeping exact MRN matching. Regression verifies Staff cannot
retrieve another user's request through that older route. This is not yet a production fix.

The new `browser.mjs` candidate includes a fixed Edge URL transport, no automatic retries
or fallback to plaintext writes, explicit KEEP/SET form handling and an unticked optional
Replace IC checkbox. Staff cannot enable replacement. It has no encryption keys. The
transport target `ic-requests` is planned, NOT deployed. HTTP dispatch was subsequently
implemented and tested as recorded below; main-page wiring and deployment remain pending.

Actual existing `docs/app.js` backup decoder functions were exercised against the same
ORLOMS1G + gzip + PBKDF2/AES-GCM file format. A synthetic version-2 file round-trips,
then passes server-side decrypt/compare/HMAC verification. Wrong passphrase and tampering
fail. Existing version-1 files still open; the candidate preview explicitly refuses
protected Restore until a safe conversion path exists. The existing production preview
still accepts version 1 only and has NOT been replaced by this candidate.

Limits: structured IC fields are masked; identifiers manually typed into clinical text,
remarks, audit details or history are not comprehensively redacted by this change.
Full-C1 entrypoint/grant inventory and old backup conversion remain release gates.
Form behavior is tested with a small DOM fixture, not a real desktop/mobile visual test.
`docs/` and its script/cache versions are unchanged. No deployed page imports these
candidate modules, so production users are not switched to an unavailable backend.

## Follow-up: full candidate HTTP gateway (still not deployed)

`gateway.mjs` dispatches CREATE, EDIT, MOVE, BACKUP_EXPORT and BACKUP_RESTORE to a
fixed allowlist of service-only RPCs. It defaults to disabled, rejects untrusted origins,
requires a valid unrestricted custom session before body processing, and never accepts
a caller-supplied role or arbitrary function name. Clinical payloads have strict field
and size checks; backend error details are not returned to clients.

`backend.mjs` keeps the service credential on the server and uses fixed HTTPS Supabase
RPC URLs, no redirects, no-store and bounded network requests. No environment secrets
were read or provisioned, and no live Deno serving entrypoint was deployed in this work.
`tests/ic-write/gateway.sql` supplies the local service-only session/password probes;
these return only role/boolean, never the user row or password hash.

Creation reuses the tested crypto handler. Edit/Postpone revalidate permissions and
expected patient inside the database transaction. KEEP does not require access to crypto
keys because it leaves the existing identity untouched. SET requires Admin/Webmaster
and fresh authenticated encryption. The database still checks role/session at commit.

Backup password verification occurs BEFORE cryptographic verification/decryption. Export
also decrypts-and-compares identities before distributing a new backup. Restore receives
only the private verified clone. Lost responses produce an explicitly unconfirmed outcome
and no automatic retry, including no fallback to legacy plaintext APIs.

Tests join browser transport → HTTP gateway → real local PostgreSQL for Create/Edit and
verified Backup/Restore, rather than testing only mocked successful RPCs. Additional unit
tests verify fixed backend URL/grant boundaries, forged roles/fields, missing keys,
password ordering, corrupt/legacy backup refusal, safe errors and absence of retries.

Latest result: foundation **9/9**, C1 database/integration **37/37**, browser/file **6/6**,
gateway **6/6** — **58 passing tests**, no skips in the synthetic local runner.

Release limitations remain: no main-page adapter wiring, no production Supabase Edge
Runtime/CORS/secret integration test, no version-1 conversion, no complete legacy
write/export entrypoint closure, no HMAC-only search, and no finalized production
timeout/upload/rate-limit sizing. The candidate body deadline is intentionally short;
large real backups require bounded size/time policy validation before deployment.
No full IC plaintext was deleted, and C1 is not being represented as installed or complete.

## Why production activation is still gated

The foundation intentionally uses `ON DELETE RESTRICT`. We reproduced the following
with synthetic records, rather than assuming old workflows will continue to work:

| Existing path | Observed dependency | Required before activation |
| --- | --- | --- |
| Create: `040`, line 38; browser request handler | Existing public RPC still accepts plaintext-only writes | Route new website submissions through backend; close bypass only with compatible deployment/recovery |
| Edit: `040`, line 105 | Original checked edit changes IC without refreshing shadow | Local atomic replacement + bypass guard tested; backend/frontend rollout pending |
| Postpone: `040`, line 185 | Can also change IC and calculated age | Local compatible path and slot race tested; backend/frontend rollout pending |
| Delete/remove: `039`, lines 151 and 176 | Private FK refuses legacy deletion of protected requests | Local atomic cleanup tested; routes and legacy entrypoint gating pending |
| Backup: `016`, line 4 | Version-1 export omits identities | Version-2 candidate tested; frontend encrypted-file integration and old export gating pending |
| Restore: `040`, line 389 | Legacy path does not handle identities | Local verified version-2 restore tested; old-backup recovery and backend/frontend integration pending |
| Schedule/search: `040`, lines 248 and 306; statistics `041` | Production still returns full IC | Server-masked candidate and age/scoped search tested locally; rollout, HMAC search and full entrypoint audit pending |

Other patient read RPCs, print/Excel, history, audit free-text and all obsolete accessible
RPC signatures must be exhaustively inventoried before the final read cutover. This
checkpoint is NOT that complete API audit. Do not backfill identities on production
or remove plaintext yet. Masking on the current webpage is not an API access control.

The required edit/delete/backup **compatibility implementation** moves ahead of production
C1 activation. C4 remains the full end-to-end verification phase, not the first time
backup compatibility is considered. Do not weaken the private FK just to unblock legacy
restore, and do not silently discard mismatched identities.

## Verification

Run on Windows with PostgreSQL 18 and Node on PATH:

```powershell
tests/ic-foundation/run-local.ps1 -IncludeC1
```

The runner creates a fresh loopback-only PostgreSQL instance on 55461, replays 001–017
and 019–045, and shuts the instance down in `finally`. It never reads a production dump,
database password or private recovery archive. Test artifacts remain in ignored
`.local-postgres/`. Migration 018's Supabase `http` extension is unavailable locally and
explicitly excluded; no holiday-fetch validation is claimed.

Initial checkpoint: foundation suite **9/9**, C1 creation suite **16/16**, no skipped tests with the local
runner. SQL foundation/grant preservation checks also passed. C1 tests include an actual
parallel duplicate-submission race, HTTP-to-PostgreSQL encryption round trip, HMAC lookup,
all three app roles, denied database-role access, session revocation before commit,
infant age, duplicate override reason, nonce collision and full transaction rollback.
The tests also demonstrate the legacy edit/deletion/export rollout blockers above.

Follow-up checkpoint: foundation **9/9**, expanded C1 suite **30/30**, no skipped tests.
The 14 additional tests cover private permits/API grants, KEEP/SET, actual legacy-edit
blocking, unchanged clinical edits, stale identity/role checks, Main-to-Special Postpone,
two requests racing for one slot, optional IC clearing with infant months, password-gated
removal, removal failure rollback and MRN-scoped removal, version-2 export/key retention,
cryptographic corruption/refusal, SQL restore rollback, busy-writer refusal, and verified
restore preserving requests, month precision, booking names and every encrypted identity.
Restore was run only inside a disposable synthetic database, not production. Final C4
recovery on a separate clean target with the actual portable-file format remains pending.

Latest checkpoint: foundation **9/9**, expanded C1 SQL/HTTP suites **35/35**, browser/file
adapter suite **6/6**: **50 passing tests**, no skips in the local runner. Five additional
SQL tests exercise direct public RPC masking and age, Staff ownership through both
search APIs, all covered structured read surfaces, private-core grant denial, and
blank/short identifiers. Six browser/file tests cover fixed transport/no fallback,
explicit replacement, form state, actual portable-file decoding with identity verification,
tamper/legacy-file handling, and the fact that production frontend wiring is unchanged.

The first sandboxed local start failed due to Windows restricted-token handling. The
same bounded synthetic runner succeeded outside that sandbox. No remote database was
used. These results are local evidence, not a production Supabase Edge Runtime test,
independent security certification or proof of readiness to encrypt all patient ICs.

## Remaining sequence / model plan

### Staged application wiring checkpoint

The actual local `docs/app.js` now has an explicit opt-in branch for
`cfg.icProtectionEnabled === true`. Production `docs/config.js`, the HTML cache
version and production deployment are unchanged. Do NOT enable this setting yet.
`docs/ic-client.mjs` contains the browser implementation; the earlier candidate
`browser.mjs` only re-exports it so there is one implementation to test.

- Existing Submit calls route to the protected gateway only when opted in.
- The active (last) Edit function and Postpone use explicit KEEP/SET. IC inputs
  blank and disable synchronously while controls load; failed loading blocks saving.
- Admin replacement is unticked by default; Staff cannot enable it. An explicit
  blank means intentional clearing. Unticking restores the original age fields.
- Edit -> Postpone carries a replacement in form memory, not the schedule cache,
  browser storage or an HTML attribute. Opening Postpone does not save anything.
- Protected backup export/restore preserves the existing file-encryption envelope.
  Version-1 files get a conversion-required message; failed previews clear stale
  restore selections. The preview no longer implies server verification is complete.
- Unready older edit/move and permanent-removal browser paths fail closed in this
  mode. This is NOT a substitute for server permission revocation at cutover.
- The default-off branch continues to use the existing RPCs. No fallback to those
  RPCs occurs after a protected operation or module-load failure.

Verification: **65 passed, 0 skipped** in a fresh localhost-only PostgreSQL runner:
foundation 9, SQL/HTTP integration 37, browser/file/router 7, actual-app function
wiring 6, gateway 6. The disposable server shut down successfully. JavaScript syntax
and diff whitespace checks passed. App tests execute the actual active functions
with synthetic DOM controls; they are NOT visual/mobile browser testing.

**Release blockers remain:** version-1 backup conversion/recovery; compatible permanent-removal gateway/UI;
complete inventory and database gating of legacy public write/export functions;
backup size/time/rate policy; real Supabase Edge Runtime and browser validation.
There is still no migration 046, deployed `ic-requests` function, live cutover,
patient backfill or plaintext deletion.

### Pending-save recovery checkpoint (local only)

The earlier CREATE response-loss blocker now has a staged implementation:

- The browser saves only the random request UUID, scoped to project and signed-in
  user ID, before sending CREATE. No clinical data, IC, encryption key or session
  token is written to this pending-reference store.
- Web Locks prevent two tabs in the same browser origin from concurrently starting
  a pending creation. Blocked/missing storage, unsupported locks, corrupt references
  and unexpected responses fail closed. Reloading retains the reference.
- The reference remains through confirmation. A lost CONFIRM response does not
  enable another CREATE. A successful confirmation clears only its matching reference.
- A new private receipt table records owner UUID plus CREATED/CANCELLED outcomes.
  It deliberately has no clinical data and survives request deletion. It is inaccessible
  to ordinary API roles and service-role direct table access.
- CREATE and RESOLVE_CREATE share a per-request transaction lock. Resolution returns
  only owner-scoped status/assignment metadata for a saved request. If no create has
  committed, resolution writes a permanent cancellation marker for that attempt.
  This does NOT cancel a patient request. It stops a still-delayed CREATE from arriving
  after a misleading “not saved” answer. A deleted saved record returns UNAVAILABLE.
- Submit/slot-request forms show Check Previous Save, then an explicit Resume Saved
  Request action. Hidden DRAFTs can be confirmed and resumed. Already-confirmed
  requests are not reconfirmed; assigned/terminal requests do not enter slot selection.
  No new CREATE or automatic slot assignment occurs during recovery.

Verification: **75 passed, 0 skipped**: foundation 9, SQL/HTTP integration 41,
browser/file/router 7, active-app wiring 6, pending-recovery/browser 6, gateway 6.
This includes real concurrent CREATE-versus-resolution transactions in the disposable
localhost database, rollback/deletion cases, cross-user denial, simulated response loss,
browser reload/storage/lock failures, and execution of the actual recovery panel function.
The runner shut down successfully. No production data or private backup was used.

Remaining recovery limits: real Web Locks/browser/mobile validation is not yet performed;
clearing browser storage, private browsing or changing devices can lose the local reference
and requires Webmaster investigation. Receipt retention policy and clean-target/cross-version
restore remain release gates. Version-2 receipt integration is implemented in the checkpoint
below. Restoring without the
cancellation markers must never permit old delayed creates to be resurrected. Do not
activate the default-OFF flag or treat the local receipt SQL as migration 046.

### Receipt-preserving backup/restore checkpoint (local only)

- Version-2 export now includes `creation_receipt_format: ORL_CREATE_RECEIPTS_V1`,
  all creation receipts (including cancelled attempts and deleted-request markers),
  and a per-request `creation_tracked` coverage flag.
- Backend verification checks receipt IDs, owners, outcomes, timestamps, uniqueness,
  coverage and consistency with existing request ownership before submitting Restore.
  SQL repeats structural/coverage checks. Missing manifests are refused, not silently
  treated as an empty set. Earlier local V2 drafts and production V1 backups need
  explicit conversion; unchanged production still uses its original V1 restore path.
- Export/restore locks include the receipt table. Import merges the backup markers into
  existing markers, never deletes newer local receipts merely because an older backup
  was selected. Old UUIDs remain fenced even if their requests disappear in Restore.
- Receipt owners follow the existing username-based account mapping. Ambiguous mappings
  or conflicts with retained/restored owners abort the entire transaction. Current
  accounts are not recreated or replaced. A restored request has a CREATED marker;
  the marker's primary key still prevents another CREATE with that same reference.
- A synthetic empty-receipt-table restore rehydrates the manifest, and rollback leaves
  the original database unchanged. This is not yet a full fresh-host recovery test.

Verification: **79 passing tests across the latest runs**, no skipped tests:
foundation 9 and SQL/HTTP integration 45 passed in the disposable PostgreSQL runner;
browser/file/router 7, active-app wiring 6, pending recovery 6 and gateway 6 passed
on rerun. An initial file-roundtrip assertion compared objects from different JavaScript
VM realms and failed despite identical content; the test now structured-clones before
comparison. No application change was needed for that test-fixture issue. The database
runner shut down successfully.

New cases cover cancelled/deleted receipt export, preservation of post-backup markers,
empty-receipt rehydration, remapped owners and full rollback on owner conflicts. Existing
malformed backup tests now cover missing/duplicate receipts, broken coverage and owner/
outcome errors. The actual encrypted .orlbackup file test round-trips both CREATED and
CANCELLED metadata without changing its outer encryption format.

Remaining: V1 conversion; fresh-host recovery and a restore-generation/fencing policy for
attempts absent from both the snapshot and local receipt table (including delayed Edge
requests); receipt retention limits; removal gateway; legacy RPC permissions; upload/time/
rate sizing; real browser and Supabase runtime verification. Known-receipt merging alone
does not solve every in-flight restore scenario. No production deployment or Restore
has been performed, and C1 remains default-OFF.

| Package | Status / next work | Model : intelligence |
| --- | --- | --- |
| A | Complete: backup and display masking only | Sol : Medium |
| B | Complete within documented foundation/synthetic scope | Astra : High |
| C1 | Complete: guarded 046/Edge/frontend activation plus display-only migration 047 | Astra : High |
| C2 | Complete 2026-10-05: 331 legacy identities encrypted and fully reconciled; post-C2 dump verified | GPT-5.6 Sol : High |
| C3 | Pending: explicitly authorized Reveal + audit policy | GPT-5.6 Sol : Medium |
| C4 | Pending: full workflow, recovery-key and restore verification | GPT-5.6 Sol : High |
| C5 | Pending: observation and minor display fixes | GPT-5.6 Sol : Medium |
| C6 | Pending: remove plaintext only after reconciliation and approval | GPT-5.6 Sol : High |
| C7 | Pending: final audit and new backup | GPT-5.6 Sol : High |

Next implementation after completed C2: C3 explicitly authorized Reveal and audit policy.
C2 completion does not authorize Reveal or plaintext removal; Package C6 remains a
separate approval gate.

## Restore-generation and local legacy-conversion checkpoint

**Still local, default-OFF, not committed/pushed/deployed.** Production remains 045.

CREATE now has a PREPARE_CREATE step that returns a non-secret generation UUID.
The browser retains its pending request reference before preparation and sends the
captured generation with the creation payload. It does not silently obtain a fresh
generation and retry a failed CREATE.

The private generation table starts with a random UUID on installation. CREATE takes
a shared transaction advisory lock and compares its supplied generation before any
receipt/request/identity insert. Protected Restore takes the corresponding exclusive
try-lock, refusing while a creation is active, and rotates the generation atomically
after successful restore. Failed restore rolls the generation back too. Generation
state is not included in portable V2 backups, so a restored snapshot never reinstates
its old generation. Delayed creates with no receipt in either the backup or current
database are now rejected. The local CREATE RPC signature gained a mandatory generation
argument; its grants, backend adapter, handler, browser client and fixtures were updated.

This guard currently covers CREATE versus the protected import path, not every legacy
mutation. Complete old-RPC gating, delayed Edit/Move policy, and a full database-dump
recovery procedure that rotates generation before reopening access remain release
work. A whole pg_dump contains private state unlike the portable V2 export. Do not
assume a fresh-host/full-dump restore is validated by these tests.

`security/candidates/c1-create/legacy-backup.mjs` adds a local conversion helper for
genuine V1 backups. It clones the input, requires complete sections and valid unique
request IDs, encrypts nonblank ICs with authenticated record binding, verifies the
result, preserves existing clinical/booking/age fields and marks legacy records as
having no historical creation receipt. It does not fabricate receipts, alter the source,
save a file or execute Restore. Masked/unsupported ICs, missing keys, malformed files
and protected files relabelled as V1 are refused. It is NOT exposed in HTTP or the UI;
Webmaster/password authorization, protected file download and full V1 -> conversion ->
Restore validation must be implemented before users can use it.

Latest full runner: **85 passed, 0 skipped**: foundation 9, SQL/HTTP 48, browser/file 7,
active app 6, pending recovery 7, legacy conversion 2, gateway 6. New tests demonstrate
an unknown delayed CREATE is rejected after a real local Restore, failed Restore keeps
the generation, an active shared generation lock blocks Restore without partial changes,
and the browser sends the exact prepared value. Conversion tests use synthetic fixtures.

The first integration attempt stopped safely because a local fixture guard still
referenced the previous CREATE signature; it was corrected and the complete runner
then passed. Both disposable database instances shut down. No real-patient IC, live
Restore, production key, deployment or remote SQL was used.

## Authorized legacy conversion and file recovery — 2026-10-02

**Local checkpoint complete; Package C1 overall remains IN PROGRESS.** Production is
still operator-confirmed 045. No commit, push, Edge deployment, live SQL, live Restore,
real backup, patient data, production key or production configuration was used/changed.
The preceding helper-only checkpoint is historical: the helper now has candidate
HTTP/frontend wiring, still behind the default-OFF gate.

- `BACKUP_CONVERT` accepts only authenticated Webmaster sessions and checks the
  Webmaster password before accessing keys. It checks authorization again before
  returning the converted payload. Staff/Admin, wrong password, revoked access,
  malformed files and relabelled protected files are refused. Conversion calls no
  clinical write/import/export RPC; session authorization may update session activity.
- The staged import preview offers a separate Convert and Download Copy form for a
  genuine V1 file. It requires explicit consent and a matching new passphrase of at
  least eight characters. That file passphrase is never sent to the server. The
  opened backup itself is sent over the protected HTTPS route for conversion.
- The browser downloads a uniquely named AES-GCM/PBKDF2/gzip `.orlbackup` copy using
  the existing ORLOMS1G format. It never overwrites the original, auto-restores,
  persists clinical fields/passwords to browser storage, or automatically selects the
  converted payload for Restore. Sensitive conversion form fields are cleared after
  the attempt; account/session or navigation changes suppress the download. Reopen
  the new file separately before any explicit Restore confirmation.
- The synthetic integration exercises a real SQL V1 export, authorized conversion,
  actual application file encoder/decoder, protected Restore and protected re-export.
  It verifies exact decrypted IC/search hashes, age/months, creator/booker attribution,
  identity coverage and preservation of existing local creation-recovery receipts.
  Conversion/file creation alone leaves operational/private database snapshots intact.
  The converted file still contains plaintext plus encrypted shadows INSIDE its
  encrypted outer file; plaintext removal remains a later, separately approved package.

Latest full runner: **91 passed, 0 skipped**: foundation 9, SQL/HTTP 49, browser/file 7,
active app 6, conversion UI/file 4, pending recovery 7, legacy conversion 2, gateway 7.
Application syntax and tracked diff whitespace checks also pass. All disposable
database runs stopped their servers. UI checks use synthetic DOM/VM, not real mobile
visual checks; actual Edge runtime/upload sizing remains unverified.

The first integration attempt hit the intentional small Staff/Admin payload limit;
the role-denial fixture was reduced without changing that guard. Later runs encountered
NOWAIT relation-lock refusal during repeated restore/re-export (including an explicit
`request_identity` lock error). Background autovacuum was a suspected source of timing
interference. The newly initialized disposable runner now disables only its own
autovacuum for deterministic fixtures; an explicit SHARE UPDATE EXCLUSIVE maintenance
lock and ordinary writer lock both demonstrate backup/restore refusal without partial
changes. The complete rerun passed. This does not recommend disabling production
autovacuum, relaxing NOWAIT, or automatically retrying an uncertain Restore.

Remaining C1 release gates are unchanged except for this completed local conversion
flow: removal gateway/UI compatibility; delayed Edit/Move versus Restore policy;
complete old-RPC permission gating; fresh-target/full-dump recovery (including generation
rotation); production upload/time/rate limits; browser/mobile and Edge validation;
then guarded migration/deployment with a fresh private backup. Do not enable C1 yet.

## Webmaster permanent-removal compatibility — 2026-10-02

**Local checkpoint complete, C1 overall still IN PROGRESS.** No production SQL,
deletion, key access, migration, commit, push or deployment. The main-page flag stays
OFF; production remains operator-confirmed migration 045.

- The fixed backend adapter now permits `orl_ic_c1_remove`; the candidate gateway's
  REMOVE operation accepts only exact REQUEST/MRN targets and a Webmaster password.
  Staff/Admin, malformed/blank targets and extra caller-controlled fields are refused.
  Password is checked before submission and checked again by the existing service-only
  SQL transaction, so revocation between the checks aborts the deletion.
- The browser's protected `orl_db_remove_patient` route no longer falls back to the
  legacy RPC. It uses REMOVE and accepts only a positive integer result. The actual
  Database Management action retains its initial single/all-MRN confirmation and the
  separate password/checkbox confirmation. The warning explains linked encrypted IC
  removal and retained audit/save-recovery history. Protected Staff/Admin UI calls are
  refused before opening the confirmation.
- No crypto key loading or IC reveal is needed for removal. Existing tested SQL deletes
  the request and linked shadow atomically, releases/compacts slots and retains recovery
  receipts/audits. Failed SQL rolls back identity deletion as well. This is not a purge
  of historical backups or any free-text identifiers that might already be in audits.
- Gateway/SQL uncertain outcomes return a check-records/audit warning, not success.
  No automatic retry, recreation or legacy fallback occurs. A deleted request remains
  UNAVAILABLE to pending-save recovery. Browser transport failures also remain uncertain
  and are not retried automatically; staff must not infer that a network error means
  the deletion was rolled back.

Full synthetic localhost runner: **97 passed, 0 skipped**: foundation 9, SQL/HTTP 51,
browser/file 7, actual app 8, conversion UI/file 4, pending recovery 7, conversion 2,
gateway 9. New tests cover authenticated single-request and case/space-normalized MRN
removal, unrelated-record preservation, slot release, retained audit/receipts, wrong
roles/passwords, injected SQL failure rollback, revocation immediately before SQL,
and a lost response after committed deletion without retries or resurrection. Syntax
and tracked whitespace checks pass; the disposable PostgreSQL server stopped.

This completes the local Database Management removal route only. Old public deletion
entrypoints still need the overall grant/compatibility audit. MRN removal intentionally
retains the existing meaning of all matching requests at execution time: an explicit
expected-target/restore-generation policy is still needed for delayed destructive
requests, alongside Edit/Move fencing. NOWAIT locks prevent overlapping transactions
but do not alone reject an old request arriving after Restore. These remain release
gates, as do fresh-host/full-dump recovery, upload/time/rate limits, actual browser/mobile
and Edge runtime checks, and controlled installation. Do not enable or deploy C1 yet.

## Delayed mutation fencing and removal target snapshots — 2026-10-02

**Local checkpoint complete; C1 is NOT installed or complete overall.** No live SQL,
Restore, deletion, key access, production configuration change, commit or push.

The candidate EDIT/MOVE and REMOVE RPCs now require a generation argument, with no
unfenced overload retained in the fresh local fixture. A private helper takes a shared
transaction advisory lock on the existing restore-generation key before comparing the
supplied generation. The protected import uses the corresponding exclusive lock and
rotates generation on success. Thus a delayed mutation is rejected even when Restore
brings back exactly the same request and slot UUIDs. Session/role/password checks and
the previous clinical validation/slot locking remain in place. Missing generation is
not silently substituted with the current generation.

The staged browser captures the non-secret generation BEFORE loading schedule or
Database Management patient lists (find/cancelled/duplicate lists). It tags that in-memory
view, retains it in the opened form, carries it from Edit into Postpone, and sends it
unchanged. It never refreshes the generation at submission time. The existing service-only
PREPARE_CREATE endpoint is reused as the generation reader; it does not create a record.
A Restore between preparation and the data read can cause conservative rejection on
Save, not acceptance of stale data. Failed preparation/session change discards the view;
forms without context refuse submission. This is stale-action protection, not a
replacement for server-side authorization or an authentication secret.

Removal buttons also carry the request UUIDs displayed for that target. REQUEST requires
its single matching UUID; MRN requires the exact set of matching UUIDs, independent of
order. Under the existing exclusive table locks, SQL compares the complete live target
set with the submitted set before deleting any identity. Missing, duplicate, expanded
or reduced sets fail closed. The UI captures a copy of the set and session token before
the password confirmation. This avoids silently deleting a newly added same-MRN record
that was not present in the reviewed list. Large target sets remain subject to the
existing payload limit and the candidate's 1000-ID ceiling; no batching is automatic.

Full localhost runner: **102 passed, 0 skipped**: foundation 9, SQL/HTTP 53, browser/file 9,
actual app 9, conversion UI/file 4, pending recovery 7, conversion 2, gateway 9.
New tests perform a real synthetic Restore, reject old EDIT/MOVE/REQUEST-removal/MRN-removal
without changing clinical, slot, identity, receipt or audit state, then accept fresh
Edit/Postpone context. Tests also verify target-set drift rejection, pre-read preparation
ordering, no submit-time re-preparation, preservation of original form context across a
new view, and absent old candidate RPC signatures. Existing busy-lock/rollback tests
remain green. Test-only fixes included cross-VM array comparison and supplying the
required synthetic Postpone reason. The disposable database stopped successfully.

### Remaining legacy paths identified during this checkpoint

This is a targeted source review, NOT a completed production permission audit. The
production functions/grants have not changed, and the staged router still passes other
workflows through the legacy transport. In particular:

- The active Edit form still follows its clinical update with `orl_set_postpone_count`
  for Webmaster. That separate write needs atomic integration or its own captured-context
  guard; the new clinical-update fence does not cover a Restore between those two calls.
- `orl_confirm_request`, `orl_assign_slot`, reassign/slot administration and other
  workflow writes still need a complete compatibility/fencing inventory.
- Public legacy create/edit/move/remove/delete and V1 export/import entrypoints need
  coordinated database permission gating. Blocking an old name in browser code is not
  enough; direct calls must be checked. Existing private-FK/IC-update guards are not a
  substitute for that audit.

Same-generation edits to one unchanged request are not given a full record revision
check by this checkpoint; existing slot/request and role checks still apply. Full-dump
recovery must rotate generation before access reopens. These limitations, fresh-target
recovery, upload/runtime limits and real browser/Edge validation remain release gates.
Keep the staged flag OFF and do not promote local fixtures to migration 046 yet.

## Legacy IC entry-point gates — 2026-10-02 (local candidate)

`tests/ic-write/legacy-gates.sql` revokes direct PUBLIC/anon/authenticated/service-role
execution on ten existing create, edit, move, permanent-delete and V1 export/import
signatures. Clinical cores remain unchanged and executable by their owning definer
wrappers; the new service-only endpoints remain the intended entry points. The fixture
requires the disposable localhost test owner, C1 generation table and prior C1 wrappers.
It is NOT a production migration or a standalone installation script.

After the revokes, it checks every overload of those ten names for effective API-role
execution privileges. An unexpected callable overload or inherited grant aborts the
entire transaction, including prior revokes. This is a scoped gate, not a claim that
every legacy workflow or database privilege has been audited.

The protected browser router now also refuses direct `orl_db_import_locked` and
`orl_delete_request` calls without falling back. The old Request Management permanent
Delete shortcut is therefore intentionally unavailable in protected mode; Webmaster
removal is through the already-reviewed Database Management flow with password,
generation and exact target IDs. Resolving the shortcut presentation remains a rollout
UX task. With the production flag OFF, existing production behavior is unchanged.

Tests run these gates last, after the baseline/compatibility tests that intentionally
exercise historical calls. They verify rollback on an extra overload, direct-call
permission denial for all ten functions under all three API roles, and protected
create/edit/Main-to-Special move/V2 export/restore/removal after gating. No real patient
or production system is used. The first run correctly refused installation because
the new fixture referenced a temporary baseline marker from an earlier connection.
The guard now checks the persistent C1 generation table while retaining the localhost
and test-owner restrictions; positive-path tests cannot continue after failed gating.
The full re-run passed **105 tests, 0 skipped**: foundation 9, SQL/HTTP 56, browser/file 9,
actual app 9, conversion UI/file 4, pending recovery 7, conversion 2, gateway 9.
The disposable database stopped successfully. Existing production configuration and
cache versions remain unchanged.

Still required: atomic/fenced Webmaster postpone-count update, remaining workflow
inventory/fencing, full-dump recovery generation handling, fresh-target recovery,
runtime/browser/load checks and a coordinated production migration/rollout. No push,
Edge deployment, production SQL, encryption/backfill or plaintext removal in this step.

## Atomic manual postpone count — 2026-10-02 (local candidate)

Protected Webmaster Edit sends a changed manual count in the same request as clinical
and optional IC changes. The service-only mutation checks the captured restore generation,
expected patient/slot, current Webmaster permission, and a string integer in the existing
0–999 range. It removes the count from the clinical payload, then performs the manual
count write and a count-only audit entry in the same transaction, under the same locks.
Failure at the count write rolls back the clinical change, encrypted shadow and audits.
No new RPC signature or automatic retry was added.

Blank/unchanged count is omitted, so an ordinary Edit does not reset an intervening
automatic increment. MOVE rejects a supplied manual count and keeps its existing +1
behavior. If a Webmaster changes the count and selects Postpone in the Edit form, the
form refuses submission and explains to save the correction with Confirm first; it does
not silently discard the correction or overwrite the automatic increment.

Direct `orl_set_postpone_count` joins the database legacy gates (now eleven names).
The protected router also refuses this old standalone call; the compatible path is
Edit on the scheduled patient. Standalone correction for unscheduled requests and old
shortcut presentation still need a rollout decision; they are not silently rerouted
without patient/slot/generation context. Production mode stays unchanged while OFF.

Regression coverage adds Webmaster range/role checks at HTTP and SQL, synthetic failure
at the final count write with complete rollback, actual Edit form single-request wiring,
unchanged legacy-mode behavior, stale count rejection after Restore, automatic MOVE +1,
and successful combined Edit after revoking the old count RPC. Full localhost runner:
**109 passed, 0 skipped** (foundation 9, SQL/HTTP 57, browser/file 9, actual app 11,
conversion UI/file 4, pending recovery 7, conversion 2, gateway 10). The disposable
database stopped successfully. Production config/cache, database and Edge deployment
remain unchanged; nothing pushed. Next: inventory and fence the remaining confirm,
assign/reassign and slot administration workflows before any controlled rollout.

## Reassign generation fence and remaining booking inventory — 2026-10-02

Local-only Reassign now uses `orl_ic_c1_reassign` through the fixed service adapter and
strict REASSIGN gateway operation. It rechecks the current Admin/Webmaster session,
takes the shared restore-generation transaction lock, checks the generation captured
when the schedule was read, and calls the unchanged 034 checked clinical core. That core
locks both slots in UUID order, verifies both expected patient IDs (NULL means empty),
and performs the detach/swap/relink and audit atomically. Identity ciphertext stays
attached to the request UUID and is neither moved to another patient nor re-encrypted.
The shared generation lock remains held until the whole transaction finishes.

The actual Reassign UI captures the source generation and login token together with
both patient selections. It never fetches a fresh generation at submit or substitutes
a newer cached schedule into the selection. Missing context or changed login prevents
submission. Protected failures clear the selection and reload the view; no automatic
retry, fallback to old RPC or success notification occurs after uncertainty. When the
feature flag is OFF, the original RPC argument shape remains unchanged.

Legacy `orl_swap_slots` and `orl_swap_slots_checked` join the local permission gates
(thirteen entry-point names). Only the new service endpoint is directly callable by the
service role; definer ownership keeps its internal call working. The gateway requires
explicit NULL for an empty destination and refuses missing/extra fields, malformed IDs,
same-slot moves and Staff access before SQL. Reassign does not load encryption keys.

Targeted source inventory (not a completed audit of all workflow writes):

| Workflow | Existing clinical guard | Remaining protection work |
| --- | --- | --- |
| Confirm request (`037`, `orl_confirm_request`) | Current session, Staff ownership, DRAFT-only, row lock | Still legacy. Carry original creation/recovery generation through normal and recovered confirmation; preserve lost-response recovery before gating old API. |
| Assign slot (`037`, `orl_assign_slot`) | Ownership, request status/unassigned check, destination lock, availability/holiday and Special permission | Still legacy. Bind pending request and selected slot to reviewed generation in both direct-slot submit and choose-slot flows; do not refresh generation at submit. |
| Reassign (`034`, checked swap) | Same day, expected source/target patients, closed target, ordered locks, unique-link-safe swap | Local generation fence and gateway/UI added in this checkpoint; not deployed. |

Approval (`orl_review_request`), Clear, session/slot administration and other remaining
write paths also need their own inventory/fencing. This change does not declare those
protected and does not change clinical eligibility rules in the historical swap core.
Full-dump recovery, fresh-target restore, runtime/browser/load checks and coordinated
deployment remain release gates. Keep C1 OFF; no production data or credentials used.

Full localhost regression: **114 passed, 0 skipped** (foundation 9, SQL/HTTP 59,
browser/file 9, actual app 13, conversion UI/file 4, pending recovery 7, conversion 2,
gateway 11). New checks include occupied Main/Special swap, empty target, competing
reassignments with only one commit, ciphertext preservation, stale selection rejection,
actual Restore fencing, closed-target refusal, final-audit failure rolling back all
links, and protected Reassign after legacy permission gates. UI tests cover original
snapshot retention, changed login/missing generation, no retry after uncertainty and
unchanged legacy mode. JavaScript syntax and whitespace checks pass. The disposable
database stopped. No push, deployment, production SQL, cache/config change or backfill.
Next checkpoint: Confirm/Assign generation handling including recovered pending creation.

## New remaining-work checklist: step 1 — Confirm Request (2026-10-02)

Scope is Confirm only, not Assign (step 2). Protected confirmation now routes through
the strict CONFIRM operation and `orl_ic_c1_confirm(uuid,uuid,uuid)`, a service-only
local fixture with empty search_path. It takes the restore-generation shared lock and
calls the unchanged 037 clinical core: current session, Staff ownership, DRAFT-only,
request row lock, original role-specific status and atomic audit all remain enforced.
The old public Confirm endpoint joins the API permission gates (fourteen names).

The pending-creation manager keeps the creation generation and current login token
in memory only. Persistent storage still contains just the random pending request UUID.
Successful CREATE retains its original generation for immediate Confirm. After reload
or an uncertain save, explicit Check Previous Save captures generation BEFORE its
recovery read. The DRAFT Resume button submits that reviewed context without obtaining
a new generation at submit. A changed login or mismatched reference/context blocks it.

Confirm consumes its in-memory context before sending. Lost/malformed responses keep
the persistent reference, cannot retry automatically and require another explicit check.
If the database committed but the response was lost, recovery sees the existing confirmed
request rather than creating or confirming it again. The actual panel resets to Check
Previous Save after uncertainty. A previously non-DRAFT view that becomes DRAFT is not
silently confirmed. Assign eligibility/generation handling remains step 2.

Regression additions cover role/status/ownership, revoked sessions, two simultaneous
Confirms with one commit/audit, Restore between CREATE and Confirm and between recovery
review and Confirm, final-audit failure rollback, lost-success recovery without a new
CREATE, no legacy fallback, unchanged UUID-only storage and actual recovery-panel wiring.
No production SQL, deployment, backfill, push or production config/cache changes.

Step 1 is complete **locally**: full runner **120 passed, 0 skipped** (foundation 9,
SQL/HTTP 61, browser/file 9, actual app 13, conversion UI/file 4, pending recovery 10,
conversion 2, gateway 12). Test database stopped; syntax/whitespace checks passed.
New 15-step remaining-work checklist progress: **1/15**, not overall C1 completion.
Next is step 2, Assign Slot; it remains legacy and was not changed in this step.

## 2026-10-02 — remaining-work step 2: Assign Slot (local only)

This checkpoint supersedes the earlier Assign-pending notes, not their historical
test results. Both direct-slot request and choose-after-submit now route through
strict ASSIGN and service-only `orl_ic_c1_assign(uuid,uuid,uuid,uuid,uuid)` in the
local fixture. No production migration, deployment, commit/push or flag/cache change.

The wrapper holds the shared Restore generation fence and requires both the saved
request generation and the displayed slot generation to agree with current state.
It delegates the unchanged 037 core for ownership, ready status, unassigned request,
active/non-holiday destination, slot locking and Staff Main-only permissions.
Clinical slot/request links and audit remain atomic; encrypted identities are untouched.
The legacy Assign RPC is now the fifteenth gated entry-point name.

Successful Confirm now retains the random persistent request UUID until Assign is
acknowledged. In-memory assignment context retains the reviewed generation and login.
Assignment consumes that context before sending; uncertain/malformed responses keep
the UUID but cannot automatically retry. Explicit recovery detects an already assigned
record (including Staff RESERVED) and does not assign it again or create a duplicate.
Ready but unassigned recovery retains the reference and returns to slot selection.
The direct form retains its opening slot generation even if the schedule cache changes.
The choose-slot handler captures the displayed generation, prevents concurrent clicks,
and opens the recovery form after uncertainty. Default-OFF legacy argument shapes remain
unchanged. Persistent storage never contains clinical data, IC or session tokens.

Added real localhost tests cover Staff/Admin/Webmaster and Main/Special permissions,
ownership, draft/rejected/cancelled requests, closed/cancelled/holiday/occupied slots,
revoked sessions, final-audit rollback, two requests competing for one slot, one request
competing for two slots, both stale-generation directions after Restore, lost successful
assignment and post-gate protected assignment. Browser/actual-function VM tests cover
both form paths, captured generation, changed login, recovery, no retries or legacy
fallback, strict payloads, sanitized errors and no crypto-key loading for Assign.

The first full run caught a synthetic fixture using HOLIDAY as a stored session status;
that is a derived display state, not a valid stored status. The fixture was corrected
to test CANCELLED and an active holiday record separately; application/database behavior
was not weakened to accommodate the test.

Final full runner: **131 passed, 0 skipped** (foundation 9, SQL/HTTP 66, browser/file 9,
actual app 16, conversion UI/file 4, pending recovery 12, conversion 2, gateway 13).
Disposable test server stopped; app syntax and tracked whitespace checks passed.
Evidence is synthetic/local, not live-browser or production validation. Existing C1
release gates still apply; Approve/Reject and remaining workflows are not claimed done.
Remaining-work progress: **2/15 complete locally**. Next: step 3, Approve / Reject.

## 2026-10-04 — remaining-work step 3: Approve / Reject (local only)

Both Request Management review and OT Schedule approval now route through strict
REVIEW and service-only local `orl_ic_c1_review(uuid,uuid,text,text,uuid,uuid)`.
The wrapper requires Admin/Webmaster, validates action/note, takes the shared Restore
generation fence, locks the displayed slot before the request, and checks the expected
slot (including explicit null for an unassigned request). The unchanged 037 core then
checks pending status and bidirectional reserved-slot links before atomic status, slot,
review metadata and audit writes. Reject releases the slot but retains request/identity;
neither operation reads crypto keys or changes encrypted identities.

Request-list reads now capture generation before fetching records, like schedule reads.
Both review surfaces bind their in-memory selection to the reading login session and
original generation/slot; submit never obtains a fresh generation to bless an old view.
Busy protection prevents overlapping clicks. Sending a protected review consumes both
cached review views until an explicit fresh read, even after an uncertain response.
There is no automatic retry or legacy fallback. Cancel on the optional-note prompt now
really cancels, rather than submitting an empty-note decision. Default-OFF legacy RPC
argument shapes are preserved. The old Review endpoint is the sixteenth gated name.

Additional tests cover Admin/WM approve/reject on reserved and unassigned requests,
Staff denial at both gateway and SQL, stale/null slot selections, newly assigned slots,
invalid status, inconsistent links, revoked session, pre-Restore decisions, final-audit
rollback for both outcomes, simultaneous opposite decisions with one commit/audit,
lost-success readback, post-gate positive reviews, strict payloads, no key loading,
captured browser context, cancellation, busy/repeat-click handling and changed login.

Full localhost runner passed **141 tests, 0 skipped**: foundation 9, SQL/HTTP 70,
browser/file 11, actual-function app VM 19, conversion UI/file 4, pending recovery 12,
conversion 2, gateway 14. Disposable test server stopped; syntax/whitespace checks passed.
No production SQL, live patient action, deployment, commit/push or config/cache change.
These are synthetic local results, not live-browser/production verification. Same-record
clinical edit versioning remains step 11; this step guards restore generation and slot
selection/status. Clear Slot and later release gates are not completed by this checkpoint.

Remaining-work progress: **3/15 complete locally**. Next: step 4, Clear Slot.

## 2026-10-04 — remaining-work step 4: Clear Slot (local only)

Clear now uses strict CLEAR and service-only local
`orl_ic_c1_clear(uuid,uuid,uuid,uuid)`. It requires Admin/Webmaster, holds the shared
Restore-generation fence and delegates unchanged 036 checked Clear: lock slot then
request, verify expected patient and both links, refuse cancelled/inconsistent requests,
release the selected slot, retain the request as APPROVED and atomically write the audit.
Patient clinical fields, encrypted identity and creation receipt are retained. No keys
are loaded, no patient deletion is introduced and no new compaction behavior is added.
Other slots remain unchanged, preserving current Clear semantics.

The UI captures displayed patient/generation before confirmation and checks the reading
login. Busy protection and a consumed selection prevent concurrent/repeated clicks after
an uncertain response until explicit fresh schedule loading. No automatic retry/fallback.
The confirmation and success messages explicitly state that the patient record remains.
Default-OFF legacy arguments remain unchanged. Both old Clear RPCs join the permission
gates, now eighteen names; protected Clear and re-assignment pass after gating.

New tests cover Main/Special and Staff-reserved slots; patient, identity, receipt and
unrelated-slot preservation; Staff/revoked-session denial; wrong/missing patient,
cancelled/inconsistent records; stale pre-Restore generation; final-audit rollback;
simultaneous Clear with one commit; lost-success recovery and reoccupied-slot protection;
strict gateway payload, no key loading, no legacy fallback, changed-login/cancel handling,
captured UI context and blocked retries. All data used was synthetic localhost data.

Full runner: **149 passed, 0 skipped** (foundation 9, SQL/HTTP 74, browser/file 12,
actual-function app VM 21, conversion UI/file 4, pending recovery 12, conversion 2,
gateway 15). Test server stopped. Syntax and tracked whitespace checks passed.
No production SQL, patient action, deployment, commit/push or production config/cache
change. Live-browser/runtime and other remaining release gates are still outstanding.

Remaining-work progress: **4/15 complete locally**. Next: step 5,
Request Delete / Deletion Approval; not implemented in this checkpoint.

## 2026-10-04 — remaining-work step 5: Request Delete / Deletion Approval (local only)

Cancellation requests and decisions now use strict DELETE_REQUEST/DELETE_RESOLVE and
service-only local `orl_ic_c1_deletion(uuid,text,uuid,uuid,timestamptz,uuid,text)`.
The wrapper enforces null-safe Staff ownership for requests and Admin/Webmaster-only
decisions, takes the shared Restore-generation fence, locks session slots in order
before the request, and checks both the displayed slot and exact request updated_at.
It delegates the existing request/035 resolution cores. Approval cancels the booking,
releases its slot and compacts Main slots around CLOSED slots; Special slots do not
compact Main. Rejection keeps the booking. Request, clinical fields, encrypted identity
and history remain; this is not the permanent Database Management removal operation.

Scoped request/deletion reads expose a deletion-only version marker without expanding
record access. Its timestamp is forwarded unchanged, preserving PostgreSQL microseconds.
This prevents an old decision from approving a newly re-requested cancellation after
rejection. General same-record clinical edit versioning remains step 11.
The UI captures the original login, generation, slot and version before prompting;
busy protection and consumed selection prevent repeats after uncertain responses until
explicit fresh loading. No automatic retry or legacy fallback; default-OFF argument
shapes remain unchanged. Both legacy cancellation RPCs are now gated, twenty names total.

New tests cover Staff ownership including null owners; request/decision role separation;
pending/closed rules; versioned scoped reads; scheduled Main/Special and unscheduled
cancellation; protected Staff Edit-to-cancellation flow; retained identities; Main
compaction around CLOSED slots; unchanged Special slots; reject/re-request stale decisions;
changed assignment, Restore generation and revoked sessions; final-audit rollback;
concurrent duplicate requests/opposite decisions; lost-success handling; strict payloads,
no crypto key loading, UI cancellation/session fencing and no blind retries.

Full localhost runner: **160 passed, 0 skipped** (foundation 9, SQL/HTTP 79,
browser/file 13, actual-function app VM 25, conversion UI/file 4, pending recovery 12,
conversion 2, gateway 16). Disposable server stopped. Synthetic data only; no production
SQL, patient actions, deployment, commit/push or config/cache changes. C1 remains OFF.
Live-browser/runtime validation and all remaining release gates remain outstanding.

Remaining-work progress: **5/15 complete locally**. Next: step 6,
OT/session/slot, holiday and relevant settings controls; not started in this checkpoint.

## 2026-10-04 — remaining-work step 6: administrative metadata controls (local only)

Staged CONTROL_VIEW/CONTROL route eight fixed actions through service-only functions:
session status/title, close/reopen empty slot, holiday save/delete/generate/clear-all,
and settings save. The server revalidates the session, role, payload, Restore generation
and scope-specific metadata revision under non-waiting table locks. Staff cannot write
these controls; clearing all holidays additionally requires Webmaster/password through
the unchanged core. Locks conservatively refuse contention instead of partially applying
an operation. Existing patient, identity and creation-receipt records are not removed.
Full production-size lock/runtime behavior still requires step 13 verification.

Session/slot actions prepare a current metadata view using the displayed schedule's
generation, then ask the operator to confirm the date, status and occupied-slot count.
Holiday/settings forms retain their loaded context, including an empty holiday list and
the original clear-all confirmation before password entry. Contexts are memory-only,
bound to the login/scope/target, and consumed before dispatch. Failed or lost responses
do not enable automatic retries or legacy fallback; refresh and inspection are required.
The default-OFF legacy path is retained. No production config/cache switch is changed.

Lazy schedule generation also participates in the Restore fence. Its direct legacy
entry point and seven administrative writer names join the gates (28 names total).
Existing masked schedule reads can still invoke the protected lazy writer as owner.
Migration 020 behavior is intentionally retained: Sunday/Wednesday, Main capacity 10
in 2026 and 5 thereafter; reducing configured capacity does not delete existing slots.
The settings screen now explains these existing limitations; this is not a new capacity
or OT-day policy. Holiday updates retain the existing override-reset trigger.

Local tests load the unchanged 018 holiday parser with ONLY its HTTP extension replaced
by a synthetic response provider. They exercise National/Kedah filtering, Friday-to-Sunday
replacement logic, existing-date preservation, malformed responses and HTTP failures.
No internet fetch or production database is used. Real Supabase HTTP availability,
external calendar accuracy and the existing 30-second fetch versus gateway timeouts
remain runtime/release verification items, not proven by these tests. Free-text titles,
descriptions and audit exposure remain in step 9.

Full localhost runner passed **175 tests, 0 skipped**: foundation 9, SQL/HTTP 87,
browser/file 15, actual-function app VM 28, conversion UI/file 4, pending recovery 12,
conversion 2, gateway 18. This includes role/payload denials, occupied/blocked slots,
holiday override behavior, stale snapshots, settings validation/capacity retention,
Restore invalidation, final-audit rollback, concurrent duplicate controls, lost-success
handling, busy-writer refusal, lazy-generation Restore fencing and post-gate functionality.
Disposable PostgreSQL stopped; JS syntax and tracked whitespace checks passed.
No production SQL, patient action, deployment, commit/push or config/cache change.

Remaining-work progress: **6/15 complete locally**. Next: step 7,
Database Repair compatibility; not started in this checkpoint.

## 2026-10-04 — remaining-work steps 7-9 (local only)

Database Repair now uses a Webmaster/service-only view and writer. The view captures the
Restore generation plus an exact revision of request/slot state; the writer rechecks both
under table locks before calling the unchanged repair core. Stale health screens, changed
records and pre-Restore confirmations are rejected. A failure while writing the final
audit entry rolls back all repair changes. Responses remain uncertain-safe: no automatic
retry or direct legacy fallback.

The legacy permission inventory now gates 31 patient-affecting entry-point names. It adds
direct Database Repair and the obsolete Postpone/update-slot shortcuts. Tests verify that
anon, authenticated and direct service-role calls cannot execute those legacy functions,
that private helpers stay inaccessible, every public SECURITY DEFINER fixes search_path,
and every C1 RPC has an explicit service-only classification. Protected workflows still
operate after the gates.

Structured `patient_ic` values continue through the recursive mask. History, deletion
reasons, remarks, review notes, descriptions and audit record/details now also redact exact
known IC/passport values and Malaysian IC-shaped text. Audit reads use the same masked
boundary. The generated OT list applies its own IC mask to cached data as a defensive final
layer. The application contains no Reveal function at this stage.

Full localhost runner passed **181 tests, 0 skipped**: foundation 9, SQL/HTTP 91,
browser/file 16, actual-function app VM 28, conversion UI/file 4, pending recovery 12,
conversion 2 and gateway 19. The disposable PostgreSQL server stopped. Syntax and tracked
whitespace checks passed. No production SQL, patient action, deployment, commit/push or
configuration/cache change occurred. C1 remains OFF.

Remaining-work progress: **9/15 complete locally**. Next: step 10, old Delete shortcut
and unscheduled manual-count UX.

## 2026-10-04 — remaining-work step 10: Delete shortcut and unscheduled count UX (local only)

Request Management no longer renders the Webmaster permanent `Delete` shortcut. All
eligible roles, including Webmaster, use `Request Cancel`, preserving the existing
request/approval flow and retained clinical/identity record. Password-protected permanent
removal remains confined to Database Management and is not added to the daily list.

Scheduled patient counts continue to use the atomic protected Edit path. An unassigned
request now exposes `Edit Count` to Webmaster only and sends the exact displayed
`updated_at` plus Restore generation to service-only
`orl_ic_c1_unscheduled_count(uuid,uuid,integer,timestamptz,uuid)`. The writer locks and
rechecks the request, refuses assigned or closed records, validates 0–999, delegates the
unchanged count core, and writes its audit in the same transaction. A stale view, changed
login, Restore, final-audit failure or uncertain response cannot be retried from the old
selection. No encryption keys are read and the encrypted identity is unchanged.

Tests cover the active UI, default-OFF legacy arguments, role/value/location checks,
consumed uncertain selections, strict gateway/router/backend allowlists, exact-version
rejection, scheduled/closed/Restore-stale records, atomic audit rollback, identity
preservation and operation after all 31 legacy gates. The full localhost runner passed
**191 tests, 0 skipped**: foundation 9, SQL/HTTP 94, browser/file 17, active-function app
VM 33, conversion UI/file 4, pending recovery 12, conversion 2 and gateway 20. The
disposable PostgreSQL server stopped. Syntax and whitespace checks passed. A Windows
launcher check was also made robust against a stale redirected-process ExitCode by
verifying the exact temporary data directory before continuing.

No production SQL, patient action, deployment, commit/push or production config/cache
change occurred. C1 remains OFF.

Remaining-work progress: **10/15 complete locally**. Next: step 11, same-record
concurrent-edit review and necessary protection.

## 2026-10-04 — remaining-work steps 11–12 (local only)

Same-record Edit and Postpone now carry the exact request `updated_at` captured by the
server-masked schedule read. The staged browser keeps that value with the opening form,
including Edit-to-Postpone, and never obtains a newer version at submit. The router and
gateway require an exact timestamp, and service-only `orl_ic_c1_mutate` checks it after
locking the request. A stale same-generation form therefore cannot overwrite another
clinical, status, count or identity change. Concurrent edits from the same snapshot
produce one commit and one refusal. Failures remain uncertain-safe: no retry or legacy
fallback was added. The default-OFF legacy argument path remains unchanged, and the
revision adds no plaintext IC to browser responses, payload metadata or audit details.

Fresh/full-dump recovery is represented by a separate localhost-only candidate and was
tested with an actual custom-format `pg_dump`, a newly created target database and
`pg_restore`. A private installation identity combines PostgreSQL system identifier,
database OID and name. A restored fresh target therefore rejects all common session
checks and new session writes before access can reopen. Its offline database-owner-only
finalizer is absent from HTTP/backend allowlists and has no API-role grant. Under an
exclusive Restore-generation lock and table locks it checks private identity/receipt
links, verifies the reviewed old generation (or an explicitly reviewed missing row),
invalidates all restored sessions, rotates generation and records the target identity
atomically. A wrong confirmation, generation mismatch, inconsistent private reference
or lock contention changes nothing.

After finalization, a newly authenticated synthetic session resolves an existing request
as `CREATED`, a retained receipt for a deleted request as `UNAVAILABLE`, and a missing
old browser reference as `CANCELLED`. The missing UUID is fenced durably; it is never
recreated or retried. A delayed CREATE carrying the dumped generation is rejected before
clinical/identity insertion. Request, encrypted-shadow and receipt coverage counts are
unchanged across dump/restore/finalization. No key, ciphertext, hash, plaintext IC or
patient identifier is returned by the finalizer.

Full localhost runner: **196 passed, 0 skipped** (foundation 9, SQL/HTTP 99,
browser/file 17, active-function app VM 33, conversion UI/file 4, pending recovery 12,
conversion 2 and gateway 20). The first full run exposed four test fixtures using the
human `psql` timestamp form where the strict HTTP contract requires ISO JSON; the
fixtures were corrected without weakening validation. The complete rerun passed and
both disposable source and fresh-target databases were removed/stopped.

Limitations remain explicit. The fresh target used another database in the same local
PostgreSQL cluster; cross-host/system-identifier detection is implemented but not yet
runtime-tested. A dump restored over the same database identity cannot be detected
automatically and requires the finalizer's separate explicit same-target acknowledgement
before reopening access. Production-size dump duration, live privileges, crash recovery,
real browser/mobile/Edge behavior and upload/time/rate policy remain steps 13–14. This
candidate is not migration 046 and no production database, deployment, configuration,
commit or push was touched. C1 stays OFF.

Remaining-work progress: **12/15 complete locally**. Next: step 13,
desktop/mobile/Edge runtime and size/time/rate verification; not started here.

## 2026-10-04 — remaining-work step 13: browser/runtime and bounded-work policy (local only)

The disabled C1 candidate now has one explicit runtime policy. Ordinary requests are
limited to 32 KiB; Webmaster Restore/Convert uploads and generated protected backups are
limited to 8 MiB and at most 2,000 requests, identities or creation receipts. Streamed
request bodies must complete within 2 seconds and every backend RPC uses a 25-second
abort signal. The smaller backup boundary replaces the earlier unsafe 100 MiB gateway
allowance: verification/conversion holds parsed and cloned structures in memory, while
the hosted Edge platform currently documents 256 MB memory and 2 seconds CPU per request.
The database's older 100 MB structural ceiling remains a second-line refusal, not the
Edge policy. Files beyond the new boundary fail before password crypto/import work and
must not be split or retried automatically.

Every protected request also requires an injected shared rate decision of no more than
30 requests per session in 60 seconds. Missing/failed enforcement returns a sanitized
503; an exhausted allowance returns 429 with `Retry-After: 60`, before reading the body.
The gateway deliberately does not contain an isolate-local counter because parallel or
restarted Edge isolates would bypass one. Step 14 must supply the reviewed shared-state
implementation; until then the candidate cannot serve requests and remains safely OFF.

Actual installed Microsoft Edge was launched headlessly against a loopback-only server.
The unchanged page/CSS rendered at 1440×900 without horizontal overflow. A 390×844 touch
viewport kept 44 px controls, the bottom-sheet dialog and horizontally scrollable wide
tables inside the viewport. The browser also loaded the actual `ic-client.mjs` and exposed
Web Crypto, Web Locks and CompressionStream. This is a real Edge engine check with mobile
emulation, not a physical-phone/device-matrix test. The attached browser-control surface
had no available browser, so the repeatable Playwright check used the installed Edge
binary directly.

Local runtime boundaries passed: exact/oversized/encoded/never-ending request streams,
mandatory and denied rate decisions, record caps before password/crypto, the fixed RPC
abort signal, and a maximum 2,000-record synthetic legacy conversion. That conversion
completed in about 0.75 seconds wall time on this workstation. This is useful local
headroom evidence, not a claim that Node wall time equals hosted Deno CPU accounting.

The full localhost runner passed **204 tests, 0 skipped**: foundation 9, SQL/HTTP 99,
browser/file 17, active-function app VM 33, conversion UI/file 4, pending recovery 12,
conversion 2, gateway 20 and runtime/browser policy 8. The disposable PostgreSQL server
stopped and syntax/whitespace checks passed. No production credentials, data, function,
configuration, deployment, commit or push was used.

Production-only evidence remains explicitly blocked and moves to the guarded preparation
and installation gates: hosted Supabase/Deno CPU-memory behavior, the shared rate-store
wiring, production backup row/byte counts, live latency/concurrency, physical phones and
the live holiday HTTP call. Those checks cannot be truthfully simulated as production
success here. C1 remains disabled and not deployable until step 14 supplies the missing
runtime entrypoint/rate backend and rollback package, followed by separately approved
step 15 installation.

Remaining-work progress: **13/15 complete locally**. Next: step 14, guarded
migration/deployment/cache/backup/rollback preparation; not started here.

## 2026-10-04 — remaining-work step 14: guarded release preparation (local only)

Migration `046_ic_c1_guarded_cutover.sql` is now a generated, hash-pinned production
candidate rather than a renamed localhost fixture. Its builder accepts only the exact
reviewed hashes of all nine C1 SQL fixtures, removes their localhost-only gates, binds
the derived Create core to the exact migration-040 function MD5 and wraps the entire
cutover in one transaction. It requires the 045 foundation, migration-018 holiday RPC
and service role, refuses an existing/conflicting 046, sets lock/statement deadlines and
does not backfill identities, delete plaintext IC, set secrets or enable the website.

The migration also supplies the previously missing shared rate backend. It stores only
a SHA-256 session reference and fixed minute bucket in the private schema, accepts the
first 30 protected requests per session/minute and refuses the 31st atomically. The
service role has only EXECUTE on the fixed rate RPC and no table rights. An actual
disposable PostgreSQL installation completed, recovery readiness was true, all 22 C1
RPCs were present, reinstall was refused by the guard, and a clean isolated rate test
returned exactly `30|1`.

The deployable `ic-requests` Edge entrypoint uses the fixed backend adapter, existing
private crypto secrets, the SQL rate decision and `ORL_IC_C1_ENABLED=true` only when
explicitly activated. Its Supabase custom-session JWT setting is explicit. The staged
website is cache 073/config 025 and remains `icProtectionEnabled:false`. Release tests
execute the actual TypeScript entrypoint and verify authorization, shared throttling and
dispatch order; no service key or encryption key is included in the browser bundle.

The release package includes a TLS/hash-pinned read-only preflight, a database installer
that first records non-identifying counts, creates a fresh private custom-format dump,
checks archive readability and requires an exact operator phrase, a disabled/enabled
Edge deploy wrapper, and a rollback/full-dump recovery runbook. Rollback never uses
Restore as a test or an ad-hoc down migration. Uncertain database, Edge-secret, deploy
or website results must be inspected and must not be blindly retried.

Full localhost runner: **207 passed, 0 skipped** (foundation 9, SQL/HTTP 99,
browser/file 17, active-function app VM 33, conversion UI/file 4, pending recovery 12,
conversion 2, gateway 20, runtime/browser policy 8 and release artifacts 3). The
disposable server stopped; PowerShell syntax and normalized migration SHA-256 checks
passed. Migration 046 SHA-256 is
`F7CD04881D13A5D88E3ECF3B36D266D3A58DF9AD1C97EACF4C32507EBEF7B154`.

During the step-15 access audit, one TLS `verify-full` connection attempt reached the
production pooler but deliberately supplied no password and stopped before authentication
with `no password supplied`; no SQL ran. No production dump, Edge secret/function change,
website publish, patient operation, commit or push occurred. Production still reports latest migration
045 and C1 remains OFF. Step 15 cannot start safely without authorized database and
Supabase CLI/Dashboard access, a passing production preflight, confirmation that the
separately held key recovery remains usable, disabled Edge deployment and the fresh
private dump/archive check. Those are operator evidence, not facts inferred locally.

Remaining-work progress: **14/15 complete locally**. Next: step 15, separately approved
controlled production installation and activation; blocked before mutation on the
explicit production prerequisites above.

The same access audit found no Supabase CLI executable/session, no access-token/database-
password environment variable or PostgreSQL passfile, and no controllable browser or
existing Dashboard session. `security/release/Semak-C1.cmd` is the exact read-only
operator entrypoint; its database password must be entered only into the local hidden
prompt and never sent through chat.

The first operator preflight stopped locally with a certificate-changed message before
any database authentication. Diagnosis found a deterministic verifier bug: the expected
`807025...` value is the SHA-256 fingerprint of the certificate DER, while the new C1
scripts had compared it to the PEM file bytes (`700723...`). Package B had already used
the correct `X509Certificate2.RawData` calculation. Both C1 preflight and installer now
share that DER calculation and enforce the root certificate validity period. Regression
proves PEM LF/CRLF changes preserve the same pin and altered certificate data is refused.

A separate no-password/no-SQL PostgreSQL TLS handshake to the exact configured production
pooler passed TLS 1.3 chain and hostname authorization using the reviewed Supabase Root
2021 CA. The current leaf is `*.pooler.supabase.com`, issued by Supabase Intermediate
2021 CA, valid 2025-03-12 through 2030-03-11. Its fingerprint is recorded only as live
metadata, not pinned: pinning a renewable leaf would be brittle. The durable controls are
the reviewed root DER plus `sslmode=verify-full` hostname/chain validation. C1 flags
remain OFF and step 15 still awaits the password-backed read-only preflight.

## 2026-10-05 — C1.15 preflight guard correction (production read-only)

The operator reran the corrected-CA preflight and authenticated successfully. Its
read-only evidence showed migration 045 present, 046 absent, 332 request rows, zero
identity rows and the exact reviewed migration-040 Create MD5. It then failed before
completion because PL/pgSQL resolves a directly named absent function while compiling
the block, even when the expression is behind `if has_046 and ...`. The transaction was
read-only and no production mutation occurred.

The recovery check is now emitted by one shared helper. It checks whether 046 exists and
uses dynamic SQL to resolve `orl_private.c1_recovery_ready()` only inside the true branch.
The installer preflight has no recovery-function reference. Its post-install check and
the `-PostInstall` preflight intentionally require the function after a successful 046
and fail closed if it is absent or returns false.

An actual disposable database regression now runs inside the full suite: a pre-046
foundation with no recovery function passes; an open post-046 database passes; a
deliberately closed recovery identity is rejected and rolls back without leaving the
test database closed. The full suite again passed **207/207**, with both additional
pre/post recovery-guard checks passing, and the disposable server stopped. Targeted
release/CA tests and PowerShell syntax also pass. C1.15 remains incomplete until the
operator reruns `Semak-C1.cmd` to a clean PASS and all later prerequisites remain met.

The subsequent corrected authenticated read-only preflight completed successfully and is
accepted as the production baseline evidence: 045 present, 046 absent, 332 requests, zero
identities and the reviewed 040 Create MD5. Package B already records a successful
key-recovery exercise and separately saved recovery copy, so no secret values need to be
re-entered or exposed for this gate.

For the next gate, the official Windows x64 Supabase CLI 2.119.0 release archive is pinned
to SHA-256 `DB4A6EC26D182408CA605EFC0D0D938720BD2D8D39541E79C7D69043897AFFB9`;
the extracted executable is also pinned to
`971F439CC4B774F43181593551E0E34E29F399D5E82CBE3508E87537EC13E29F`.
`Pasang-Edge-C1-Off.cmd` uses that local binary, verifies access to the exact production
project, sets only `ORL_IC_C1_ENABLED=false` and deploys `ic-requests`. The read-only access
probe found no authenticated CLI session and stopped before mutation. The operator must
authenticate locally through that launcher and must never paste the token into chat. No
Edge, database, frontend, patient-data, commit or push mutation has occurred yet.

The operator subsequently reported `Pasang-Edge-C1-Off.cmd` SUCCESS. This is accepted as
trusted evidence that `ic-requests` was deployed to the exact production project after
setting `ORL_IC_C1_ENABLED=false`. An independent unauthenticated empty POST returned HTTP
503 with `Protected operations are not enabled.`, confirming the deployed gateway remains
closed. This Edge deployment and false flag are the only production mutations so far.

The next controlled entrypoint is `Pasang-046.cmd`. Its migration hash remains
`F7CD04881D13A5D88E3ECF3B36D266D3A58DF9AD1C97EACF4C32507EBEF7B154`; PowerShell syntax
passes, the reviewed CA check remains in place, PostgreSQL 18.6 client tools are present,
and the private backup target has more than 54 GiB free. The launcher repeats read-only
preflight, creates a fresh full custom-format dump, verifies its archive listing, then
requires `INSTALL C1 046` before the atomic migration. Edge and website remain disabled;
Restore is not run.

The operator then reported `Pasang-046.cmd` SUCCESS. This is accepted as trusted evidence
that the launcher repeated preflight, created a fresh private full custom-format dump,
verified the archive listing, installed migration 046 atomically and passed its immediate
read-only postcheck. Edge and website remained OFF throughout; Restore was not run. A new
independent empty POST after installation still returned the expected disabled HTTP 503.

`Semak-C1-Selepas-046.cmd` is the next exact operator entrypoint. It runs
`preflight-c1.ps1 -PostInstall` in a read-only transaction, requires 046, verifies the
recovery fence dynamically and returns only non-patient counts/metadata. The database
password is entered only into its hidden local prompt. Edge enablement remains blocked
until this separate post-install check reports PASS.

The operator reported `Semak-C1-Selepas-046.cmd` SUCCESS. This is accepted as trusted
evidence that migration 046 is present, the recovery fence is ready and the expected
post-install empty identity state holds. The check was read-only. A separate CLI project
listing confirms the authenticated session still has unique access to the exact production
project, and `docs/config.js` remains `icProtectionEnabled:false`.

`Pasang-Edge-C1-On.cmd` is the next guarded entrypoint. It uses the same hash-pinned CLI,
rechecks the exact project, requires `SET EDGE ENABLED`, changes only
`ORL_IC_C1_ENABLED=true` and redeploys the reviewed `ic-requests`; it does not publish the
website. `Test-EdgeC1PublicSmoke.ps1` then requires exact sanitized 401/403 responses for
missing/random sessions plus JSON, no-store and nosniff headers. `Test-EdgeC1Rate.ps1`
accepts a current session token only through a hidden local prompt and sends 31 empty JSON
objects: the first 30 must reach safe body rejection and the 31st must return 429 with a
60-second retry value. It calls no patient workflow and never prints the token. Both smoke
scripts pass PowerShell syntax checks; the public smoke currently fails closed on the
expected disabled 503, confirming that activation has not happened early.

The operator then reported `Pasang-Edge-C1-On.cmd` SUCCESS. This is accepted as trusted
evidence that the exact-project secret flag was set true and the pinned function was
redeployed. With the website still OFF, an independent public production smoke returned
the exact reviewed responses: HTTP 401 for a missing session and HTTP 403 for a fresh
random UUID. Both were JSON, no-store and nosniff, and contained no forbidden internal
names or secret material. The endpoint therefore no longer returns the disabled 503.

The shared live rate contract remains a required pre-frontend gate because missing/random
sessions are rejected before the limiter. The safe test uses the current website only to
obtain an already valid custom-session UUID locally, then `Uji-Edge-C1-Rate.cmd` accepts it
through a hidden prompt. The token must never enter chat or command-line history. Its 31
requests contain only `{}`; no patient operation is selected. The first 30 must be safe
HTTP 400 body-validation failures and the 31st must be HTTP 429 with Retry-After 60.

The operator reported this hidden-local-token rate smoke SUCCESS: 30 exact safe HTTP 400
body-validation responses followed by HTTP 429 with Retry-After 60. No patient operation
was selected and the session token was not sent through chat. The clipboard should be
cleared after the local test. All pre-frontend Edge gates have therefore passed; cache
073/config 025 is staged ON for exact-repository publication and subsequent live
login/read-only verification.
