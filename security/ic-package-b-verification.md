# Package B verification record — 2026-09-30

Baseline: `5d92c8a` (Package A), restore tag `restore/pre-ic-encryption-package-b-20260930`.

## Verified locally

- PostgreSQL 18: fresh empty loopback cluster; no production dump or patient data used.
- Replayed migrations 001-017 and 019-044, then candidate 045.
- One fabricated existing request and all 71 pre-existing public functions preserved
  by migration 045 (including function source, permissions and search-path settings).
- Private schema/table privileges denied to anon, authenticated and service_role;
  RLS enabled and forced, with no public policies.
- Service-only readiness RPC requires a real valid Webmaster session in the synthetic
  database. Admin, Staff, NULL/unknown/expired sessions, disabled accounts and pending
  password-change accounts rejected. Anonymous direct RPC/table access rejected.
- Reinstall refused by the guard without overwriting the foundation.
- AES-GCM round trip preserves original IC/passport formatting. Ciphertext randomized.
  Wrong keys, altered data, wrong request/project and invalid envelope rejected.
- Independent HMAC exact search matches formatting variants; different ICs differ.
- Key rotation reads old ciphertext with retained old key; missing keys fail closed.
- HTTP readiness tests validate disabled mode, CORS, methods, absent session, payload
  rejection, authorization-before-crypto, generic errors and no-store boolean results.
- Actual TypeScript Edge adapter executed under Node 24 type stripping with mocked
  Deno/fetch; verifies fixed RPC URL, session forwarding, new/legacy backend keys,
  HTTPS enforcement and backend denial handling.
- Actual encrypted bytes persisted to PostgreSQL and found by HMAC using differently
  formatted synthetic IC; decrypted value matches. Test transaction rolled back.
- Local test server stopped after completion; no production mutations or live patient
  actions were performed. Test keys were ephemeral and not saved.
- Installer PowerShell syntax and reviewed normalized SQL SHA-256 checked.

The first complete database run passed all seven then-existing Node groups including
PostgreSQL integration. A subsequent adapter group passed along with the six crypto/
HTTP groups; PostgreSQL integration was skipped in that standalone Node invocation.
Eight distinct groups have therefore been exercised, not eight live Supabase checks.

## Live deployment verification — 2026-09-30

- Deployed `ic-readiness` through the Supabase Dashboard after specific operator approval.
- Entry imports the exact reviewed commit `62c329b6e4bacaeba15f17a80da7536e1e46c8ac`.
- Function details page and endpoint appeared after deployment.
- Dashboard POST with empty body and no application session returned HTTP 503,
  `Readiness check disabled.` This confirms the actual live handler loads and its
  disabled guard works; it does not verify crypto, database probe or role enforcement.
- Dashboard deployment initially retained legacy JWT verification ON. After explicit
  operator approval, switched it OFF for `ic-readiness` only and saved successfully.
  A body-free POST without credentials returned HTTP 503 `Readiness check disabled.`
  This verifies disabled behavior without the gateway JWT, not enabled role checks.
- No production encryption keys provisioned, patient ICs encrypted or data deleted.

## Limits and next verification

- Migration 018's external holiday retrieval needs Supabase's `http` extension and was
  explicitly excluded. Holiday fetching was not tested or modified in this package.
- Actual Supabase Edge Runtime deployment and disabled response are verified as above.
  Live crypto and role/session verification remain pending; local Node tests are not
  a substitute for those enabled runtime checks.
- The operator confirmed migration 045 installer SUCCESS after its TLS correction.
  Production database state has not been independently re-queried. Production
  secret/recovery provisioning and enabled Webmaster readiness checks remain pending.
- The successful installer requires a fresh full dump and archive readability check
  before installation; no production restore was performed. Recovery of future encrypted identities needs both ciphertext
  and separately secured keys; current portable backup does not cover the new table.
- No patient encryption, backfill, Reveal IC or plaintext removal implemented or tested
  as a production workflow. These remain Package C tasks.

Migration SHA-256 (UTF-8, normalized LF):
`E1C3190A0C18A3FDCF6866696A3DA8965CA22A374BA44FF347E7A6C07343CE40`
