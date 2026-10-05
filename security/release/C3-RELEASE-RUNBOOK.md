# C3 authorized IC Reveal release

1. Run `Pasang-049.cmd`. It performs a read-only C2/recovery preflight, creates and
   verifies a fresh private full dump, then installs migration 049 only after the exact
   phrase `INSTALL 049`.
2. Run `Pasang-Edge-C3.cmd`; confirm `DEPLOY C3 EDGE`. Existing encryption/search keys
   and the enabled C1 flag are reused and never printed.
3. Publish the reviewed `docs/` cache 075 commit. Sign in as Admin or Webmaster, open one
   scheduled record and choose **Reveal IC**. Use a permitted purpose and the current
   account password. Confirm the number hides within 60 seconds and an `IC_FULL_REVEAL`
   audit row exists without the IC value.

Staff must not see the Reveal button and direct RPC privileges remain service-role only.
Do not use a real patient reveal merely as a test unless the operator has a genuine
authorized clinical purpose. A lost/uncertain response must not be blindly retried.
