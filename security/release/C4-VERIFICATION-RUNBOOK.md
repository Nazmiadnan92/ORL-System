# Package C4 — full workflow, recovery-key and isolated Restore verification

C4 is verification only. It does not install a migration, remove plaintext IC, change
production data or run Restore against production.

## Operator procedure

1. Run the complete local regression suite and require every test to pass.
2. Open `Jalankan-C4.cmd` on the authorized Windows PC.
3. Enter the Supabase **database password** in the first hidden prompt.
4. Enter the separate **key-recovery passphrase** in the second hidden prompt.
5. Require the final green `SUCCESS` message. Never send either secret in chat.

The verifier performs a read-only protected-workflow inventory, creates a new full
private `pg_dump`, checks its archive, restores only `public` and `orl_private` into a
new disposable localhost PostgreSQL cluster, and checks counts/recovery state. It then
uses the separately held encrypted recovery archive to decrypt every restored identity
and compare it exactly with its retained source and keyed search hash without printing
values. A fresh target must initially remain closed; the verifier then runs the offline
owner finalizer locally, rotates generation, invalidates restored sessions and confirms
the recovered target safely reopens. The disposable cluster is stopped and removed
after the check.

The successful `.dump` and sanitized JSON report stay under the private local backup
folder. A failure leaves a `.partial` file private and does not authorize C6. Do not
press the website Restore button merely to test recovery.

## Safety boundaries

- No production Restore, SQL write, patient mutation or Edge/frontend deployment.
- No database password, recovery passphrase, encryption key or patient IC in output.
- The recovery archive and database backup remain separate private artifacts.
- Plaintext remains in production until separately approved Package C6.

## Local diagnosis, 2026-10-05

The latest existing C4 archive reproduced `Offline recovery finalizer privilege
check failed`. The runner had used `pg_restore --no-privileges`, dropping the
archive's ACLs and reverting functions to default PUBLIC EXECUTE. The corrected
local restore keeps ACLs and creates the referenced `postgres` and `supabase_admin`
roles as NOLOGIN placeholders in the disposable cluster. Ownership is still
mapped to the local test owner, so this is not a full Supabase role/owner replica.

`verify-c4.ps1 -LocalStructureOnly` reuses the latest private C4 `.partial` archive
without connecting to production or requesting keys. Actual restore, closed
recovery fence, finalizer privileges, generation rotation and session invalidation
passed. This diagnostic does not promote the archive or certify C4: key-backed
verification of every identity still requires the ordinary operator run.
Success reports are now written only after temporary restored data is removed.
