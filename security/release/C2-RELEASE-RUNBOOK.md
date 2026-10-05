# Package C2 controlled legacy IC backfill

C2 creates encrypted private identity shadows for every existing nonblank patient
IC and verifies every shadow by decrypting it in the Edge Function and comparing
the exact plaintext and keyed search hash. C2 does **not** remove or rewrite the
legacy plaintext column; that remains a separately approved Package C6 action.

## Controlled production order

1. Run `Pasang-048.cmd`. It performs a read-only prerequisite check, creates and
   validates a fresh private full dump, requires the exact `INSTALL 048`
   confirmation, installs atomically, and checks private grants.
2. Run `Pasang-Edge-C2.cmd`. It uses the hash-pinned Supabase CLI, confirms access
   to the exact project, and requires `DEPLOY C2 EDGE`. It does not read secrets or
   alter the existing C1 enable flag.
3. Sign in as Webmaster in the website. Copy the current session token locally
   from the browser console with
   `copy(sessionStorage.getItem('orl_session_token'))`. Never send it in chat.
4. Run `Jalankan-C2.cmd`. Paste the session token and Webmaster password only into
   the private prompts, review the count-only inventory, then type `START C2`.
5. Treat any uncertain network result as a stop. The runner never retries a write
   automatically. Reopen status only after review.
6. After the exact C2 success message, run `Backup-Selepas-C2.cmd` and keep its
   verified archive private. Do not Restore it merely as a production test.

## Safety properties

- Maximum 40 records per batch; the current shared 30/minute Edge limit remains.
- Webmaster session and password are rechecked by SQL on every batch.
- Restore generation, inventory revision, request version and identity version
  fence stale or concurrent work.
- Encryption is immediately decrypted and compared before commit. Finalization
  requires current verification receipts for every identity row.
- Raw IC values, passwords, tokens and cryptographic keys are never logged or
  returned to the browser. Audit entries contain counts only.
- Unsupported legacy values or blank/identity mismatches stop the process without
  exposing the affected values.

## Production outcome — 2026-10-05

The guarded installer, Edge deployment, controlled runner and post-C2 backup all
reported success. The initial inventory found one one-character punctuation-only
placeholder; a separate guarded data-correction script created a fresh verified
backup, cleared it to the optional blank state and wrote a value-free audit entry.
The rerun encrypted and reconciled all 331 supported nonblank identities before
finalization. The verified post-C2 full dump is private and is not stored in Git.
