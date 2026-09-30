# IC protection: Package B design and deployment

## Status and scope

Package A is display masking only. Several existing RPC responses still carry full
`patient_ic` into browser memory and edit forms; masking is not an API access control
or encryption. Package B prepares and tests infrastructure. Real patient encryption
starts only in Package C. No existing request or IC is changed by migration 045.

Production 044 was reported successful by the operator. Migration 045 and the Edge
Function must be separately installed and verified; repository presence is not proof
of deployment. See the package status table at the end of this document.

## Design decisions

| Item | Decision |
| --- | --- |
| Encryption | AES-256-GCM, random 96-bit nonce per encryption, 128-bit authentication tag |
| Record binding | Authenticated additional data includes format version, project context, request UUID and encryption key ID |
| Exact IC/passport search | HMAC-SHA-256 with a separate random 256-bit key; never an unkeyed IC hash |
| Normalization | Version 1 ASCII letters/digits, lowercase, ignoring punctuation/spaces; matches current compact exact-search behavior |
| Original value | Encrypt the original ASCII string, including formatting; no lossy replacement of unsupported legacy values |
| Optional IC | Blank IC has no encrypted identity row; crypto refuses empty identifiers |
| Key location | Supabase Edge Function secrets, separate from the patient database and GitHub Pages |
| Ciphertext location | New `orl_private.request_identity` table, no client/service-role table grants, RLS enabled and forced |
| Public database API | One backend-only readiness RPC, itself requiring a valid unrestricted Webmaster session |
| Backend HTTP API | `ic-readiness`, disabled by default, synthetic tests only, no arbitrary encrypt/decrypt/search/reveal endpoint |

The private table replaces the initially proposed extra public-table columns.
Existing backup/RPC code uses `to_jsonb(row)` in multiple places. New public columns
could silently propagate ciphertext and search hashes. Separate storage avoids that
and keeps the public request row shape stable. No secrets are stored in either table.

Multiple bookings may have the same IC, so the search index is deliberately not unique.
The private table has a unique key-ID/nonce constraint as a second safeguard against
accidental nonce reuse. A future write must regenerate on collision.

Authenticated encryption detects altered ciphertext or copying it to another request
or project. It does not prevent a privileged attacker from deleting records, replacing
them with an older valid version for the same record, stealing a live authorized session,
or compromising an Edge Function that has access to keys. HMAC equality exposes which
encrypted records match one another. Minimum access, audit trails, recovery, and incident
response remain necessary. B does not claim to remediate unrelated existing RPC exposure.

## Sessions and roles

The application uses a custom opaque UUID session, not a Supabase Auth JWT.
`verify_jwt=false` is set only for `ic-readiness`. This does **not** make its result
public: every POST must send `x-orl-session`, and the server invokes the service-only
`orl_ic_foundation_probe` RPC. That RPC calls the migration-044 session validator and
checks WEBMASTER. Staff, Admin, expired/unknown sessions, disabled accounts and
required-password-change accounts are refused. No user-supplied role is trusted.

The service/secret key stays on the Edge Function. New Supabase secret-key maps are
supported, with the legacy service-role environment variable as fallback. A client
publishable/anon API key is not evidence of user identity. CORS is limited to the
existing website origin, but authentication is still required for nonbrowser callers.
Responses are `no-store`; no IC, key, search hash, ciphertext or token is logged or
returned. Request bodies and query strings are rejected. The readiness endpoint is
temporary; disable it after operator verification to reduce exposure and usage.

## Key custody and recovery

1. Generate two independent keys with a cryptographically secure random generator,
   32 bytes each, encoded as standard base64. Do not use an IC, password, project key,
   or one shared key for encryption and HMAC. The software rejects reused key material.
2. Keep a recoverable encrypted copy in an operator-controlled password manager or
   encrypted offline recovery archive before storing them in Supabase secrets. Record
   context and key IDs as well as key values. Do not send keys/passwords into chat.
3. Keep the recovery password separately and verify recovery using synthetic ciphertext.
   `.orlbackup`, a SQL dump and Git restore tags do not include Edge Function secrets.
4. Retain old encryption and search keys with their IDs during rotation. Switch active
   IDs only after tests. Retire keys only after all affected records and retained backups
   have been re-encrypted or a documented recovery path exists.
5. If keys are missing, fail closed. Never quietly write plaintext or replace ciphertext
   with blanks. Lost encryption keys can make encrypted ICs unrecoverable.

No production keys are generated, committed or printed by the test suite. Tests use
ephemeral random keys in process memory. The `.env.example` contains placeholders only.
Readiness can be deployed disabled before key provisioning, but that is not a completed
production encryption setup.

## Installation sequence

1. Run the prepared local `Pasang-045.cmd` installer. It makes a fresh full database dump,
   checks archive readability, checks the reviewed SQL hash, and installs 045 in a
   transaction. Enter the database password only into its hidden local prompt.
2. Keep `orl_private` out of Supabase's exposed schemas. Do not grant direct table access
   or add RLS policies for anon/authenticated/service_role. Package C will introduce
   narrowly scoped checked write operations; Package B intentionally has none.
3. Deploy `ic-readiness` using `supabase/config.toml`. Repository push alone does not
   deploy Edge Functions. Supabase CLI (when installed and authenticated):

   ```text
   supabase functions deploy ic-readiness --project-ref imrfmilqehcrvassuvuw
   ```

4. After securely backing up keys, provision the six `ORL_IC_*` environment values
   listed in `supabase/functions/.env.example` through Supabase Edge Function Secrets
   or an ignored private env file passed to `supabase secrets set --env-file`.
   Set `ORL_IC_READINESS_ENABLED=true` only for controlled verification.
5. Verify using a current Webmaster session in `x-orl-session`, HTTP POST, no request
   body, against `/functions/v1/ic-readiness`. Do not paste a real session into chat,
   source code, a URL, shell history, or a screenshot. The response must report
   `ready:true`, five passing synthetic checks, and `patient_encryption_active:false`.
   Verify denied access separately. Disable readiness again afterwards.
6. Update `supabase/README.md` production status only after installation confirmation.

No frontend deployment/cache bump is needed for Package B. Ordinary bookings continue
through the existing APIs. Do not populate the private table on production until C.

## Rollback and Package C requirements

For Package B rollback, disable the readiness endpoint. Empty private storage can remain
without changing existing workflows. Do not drop keys or tables after they hold identities.
The foreign key uses RESTRICT, so accidental legacy deletion/restore is blocked if the
private table is populated before a compatible Package C release. This is why patient
backfill must not be started early.

Before C1/C2, cover **all** existing write and read paths, not just the webpage:

- Validate sessions and record permissions server-side before encryption or decryption.
- Preserve age-at-OT calculations currently derived from IC; derived birth dates remain
  sensitive. Define how age is updated without sending full IC to the browser.
- Keep request creation, identity writes, edit concurrency checks and audit metadata in
  atomic database transactions. Stage encryption before committing; retry safely on
  stale edits and avoid orphaned identity records.
- Stop legacy RPCs from bypassing encrypted writes; a frontend switch is insufficient.
- Maintain exact IC search via keyed indexes and name/MRN search via their existing paths.
  Inventory unsupported/empty legacy values and normalization collisions before backfill.
- Apply role/record limits before returning search results; do not expose HMACs to clients.
- Change every patient read RPC to return masked IC by default. Approve a separate reveal
  policy (roles, purpose, expiry and audit) before C3 exposes full IC.
- Extend backup/restore to include identity records and compatible key metadata, keeping
  keys separately recoverable. Test restore in a separate database. Current portable
  backup version 1 excludes `orl_private` and cannot restore encrypted identities alone.
- Cover postpone history, audit details, duplicate tools, deletion, printed/Excel reports,
  cached responses and old exports. Historical plaintext copies do not disappear when
  the main `patient_ic` column is cleared.
- Reconcile row counts, decrypt-and-compare every migrated nonblank supported IC, verify
  search and restore, then monitor before C6 removes plaintext. Never delete legacy ICs
  merely because ciphertext exists.

## Reproducible verification

Run `node --test tests/ic-foundation/crypto.test.mjs` for crypto and HTTP tests.
Run `tests/ic-foundation/run-local.ps1` for a new loopback-only PostgreSQL 18 cluster,
migrations 001-017 and 019-044, migration 045, original-data/function preservation, database grants,
role/session tests, duplicate-install refusal, and real PostgreSQL ciphertext round trip
with HMAC lookup. The runner uses no production dump, secret, or real patient record.
Migration 018's external holiday fetch requires Supabase's `http` extension, unavailable
in this local PostgreSQL installation; it is explicitly excluded, not simulated as a pass.
This package does not validate holiday fetching. The runner shuts down its temporary server.
Its output is evidence of local testing only;
Supabase Edge Runtime and production configuration still need their own verification.

## Package plan

| Package | Work | Model : intelligence |
| --- | --- | --- |
| A1-A3 | Backup, display masking, frontend/search/export tests | Sol : Medium |
| B1 | Encryption, HMAC and key-custody design | Astra : High |
| B2 | Backend/Edge Function and secrets setup | Astra : High |
| B3 | Add private storage without deleting original IC | Astra : High |
| B4 | Synthetic encryption/decryption/search tests | Astra : High |
| C1 | New-record encryption | Astra : High |
| C2 | Controlled legacy IC backfill | Astra : High |
| C3 | Authorized Reveal IC and audit | Sol : Medium |
| C4 | Full workflow and backup/restore validation | Astra : High |
| C5 | Observation and small display fixes | Sol : Medium |
| C6 | Remove plaintext after verification | Astra : High |
| C7 | Final security audit and new backup | Astra : High |

## References

- [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)
- [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration)
- [Supabase database function privileges](https://supabase.com/docs/guides/database/functions)
- [Web Crypto encryption and AES-GCM](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)
