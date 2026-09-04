# ORL website (migration build)

This is the new browser-based front end for the Supabase migration.

Before hosting it, copy `config.js.example` to `config.js` and add the project's public publishable (or legacy anon) key. Do not use a `service_role` key in browser code.

The login page already calls the custom `orl_login`, `orl_current_user`, and `orl_logout` database functions. The rest of the ORL modules will be migrated from the current Google Apps Script version next.
