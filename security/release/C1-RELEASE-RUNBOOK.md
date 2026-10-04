# C1 release runbook (migration 046)

Prepared scope: guarded migration 046, disabled-by-default `ic-requests` Edge gateway,
shared PostgreSQL rate decisions, frontend cache 073/config 025, private backup prerequisite,
preflight, activation and recovery instructions. None of these files changes production by
being present in the repository.

TLS identity uses two complementary checks: the bundled **Supabase Root 2021 CA** is
pinned by SHA-256 over the certificate's DER (`RawData`) and checked for validity, while
libpq uses `sslmode=verify-full` to verify the live chain and exact pooler hostname. The
live leaf certificate is deliberately not pinned, so legitimate leaf renewal does not
break deployment. `check-production-tls.mjs` repeats the hostname/chain handshake without
a database password, authentication or SQL and prints certificate metadata only.

## Fixed safety order

1. Keep `docs/config.js` `icProtectionEnabled: false` and `ORL_IC_C1_ENABLED=false`.
2. Run `Semak-C1.cmd` (or `preflight-c1.ps1`) read-only. Enter the database password
   only in its local hidden prompt, never in chat. It must show 045 present, 046 absent, the reviewed
   040 MD5, no pre-C1 identities and no more than 2,000 requests.
3. Confirm the six existing `ORL_IC_*` key secrets remain present and their separately
   held recovery copy is accessible. Never print or paste values into logs/chat.
4. Install the checksum-pinned portable CLI with `Install-SupabaseCli-C1.ps1`, then deploy
   `ic-requests` in **disabled** state with `Pasang-Edge-C1-Off.cmd`. The launcher authenticates
   locally if needed, verifies access to the exact production project, sets only
   `ORL_IC_C1_ENABLED=false`, and deploys with JWT gateway verification disabled because C1
   performs its own custom-session authorization. Never paste the CLI token into chat.
   Verify an unauthenticated empty request returns the disabled 503 response.
5. Run `Pasang-046.cmd`. It creates a new full private custom-format database dump,
   verifies archive readability, requires an exact operator phrase, installs atomically,
   and performs a read-only post-check. The dump is not Restore-tested on production.
6. Run `Semak-C1-Selepas-046.cmd` (equivalent to `preflight-c1.ps1 -PostInstall`).
   Do not continue if the recovery fence is closed.
7. Enable Edge only with `Pasang-Edge-C1-On.cmd`; the website flag remains OFF. Then run
   `Uji-Edge-C1-Public.cmd` (or `Test-EdgeC1PublicSmoke.ps1`) and require exact sanitized
   401/403 denials for missing and random sessions plus no-store/nosniff headers. Verify a
   current custom session and the 30/minute shared-rate contract with
   `Uji-Edge-C1-Rate.cmd`; its token prompt is local and hidden. Never paste a session
   token into chat. The rate smoke sends only an empty JSON object and calls no patient
   workflow: the first 30 requests must fail body validation and the 31st must return 429.
   Use only synthetic/non-patient requests. Do not run Restore or delete a patient as a test.
8. Publish frontend cache 073/config 025 with `icProtectionEnabled: true`, then verify a
   fresh browser loads those exact versions. Only now are normal writes routed to C1.
9. Retain the pre-046 dump, its preflight report and the separately held keys in private,
   separate locations. Record exact Edge deployment and website commit identifiers.

## Stop conditions

Stop before mutation for a baseline/hash mismatch, more than 2,000 requests, non-empty
identity storage before 046, missing key recovery, missing CLI/dashboard authorization,
failed private dump/archive check, uncertain command result, or unexpected live schema.
Never blindly retry a database, Edge-secret, deploy, or website-publish command.

## Rollback and recovery

- Before migration 046: set Edge disabled and leave the website flag false.
- After 046 but before website activation: keep Edge disabled while investigating. Legacy
  protected write RPCs are deliberately gated, so this is a safe write outage, not a
  functional legacy fallback.
- After activation: first set the website flag false and disable Edge to stop new protected
  writes. Do not execute an ad-hoc SQL down migration; 046 replaced public read wrappers,
  gates and recovery/session boundaries as one reviewed unit.
- A source-code rollback may redeploy the last verified C1 Edge/frontend artifacts without
  changing the database. Abandoning 046 requires a separately reviewed restore of the fresh
  pre-046 full dump during a controlled outage. Restore must never be used as a production test.
- Any full-dump recovery to another target remains closed until the offline database owner
  runs `orl_ic_c1_finalize_full_dump_recovery` with the reviewed old generation and exact
  confirmation. That finalizer invalidates all restored sessions and rotates generation.

Migration SHA-256 (normalized LF):
`F7CD04881D13A5D88E3ECF3B36D266D3A58DF9AD1C97EACF4C32507EBEF7B154`
