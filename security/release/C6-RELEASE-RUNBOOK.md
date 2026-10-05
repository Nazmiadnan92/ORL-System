# Package C6 — plaintext cutover

C6 has four guarded steps:

1. Migration 050 preflight plus a fresh private full dump. Installing 050 only
   prepares C6; it does not remove plaintext.
2. Deploy the C6-capable Edge gateway and cache 076 website.
3. Re-decrypt and compare every protected identity, verify its keyed search hash,
   then require the explicit phrase `REMOVE PLAINTEXT`. One SQL transaction scrubs
   known free-text copies and replaces operational full IC values with approved masks.
4. Confirm zero plaintext/mismatch rows and create a new full private dump.

New Create/Edit operations retain raw identity only transiently in the protected Edge
and SQL transaction. The committed request row stores only the display mask; the exact
value is in authenticated ciphertext. Exact IC search uses a keyed hash. Version-3
application backups contain masks plus ciphertext, never a parallel plaintext copy.

Do not retry a failed or uncertain cutover blindly. Read C6 status first. Keep all dump
files, recovery keys, database passwords and Webmaster tokens private.
