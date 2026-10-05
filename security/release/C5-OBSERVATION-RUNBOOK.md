# Package C5 — live observation

C5 has two observation steps and no database migration.

1. Verify the exact live GitHub Pages cache versions, protection flag, required
   assets and sanitized Edge missing/random-session denials.
2. Log in through the normal website RPC, read the role-scoped dashboard, current
   schedule, requests, postponed/deletion lists, holidays and account settings.
   Admin/Webmaster also read Settings; Webmaster reads Audit and Database Overview.

The helper validates populated `patient_ic` fields against the approved display mask,
prints no patient values and logs out its temporary session. It does not select Create,
Edit, Assign, Reassign, Postpone, Cancel, Reveal, Delete, Restore or settings writes.
The login/logout may add ordinary authentication audit entries.

The installed desktop/mobile browser regression remains the layout evidence because
Windows UI capture was unavailable during C5 (`failed to write kernel assets`). Actual
live public assets are still fetched and checked. Any user-reported display issue found
during observation remains a C5 fix rather than evidence for plaintext removal.
