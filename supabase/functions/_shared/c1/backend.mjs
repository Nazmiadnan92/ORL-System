// Server-only fixed-RPC adapter; never import into the browser bundle.
import { C1_RPC_TIMEOUT_MS } from './runtime-policy.mjs';
const allowed = new Set(['orl_ic_ot_export_view','orl_ic_ot_export_commit','orl_ic_c6_status','orl_ic_c6_cutover','orl_ic_c6_find_patient','orl_ic_c3_reveal_view','orl_ic_c3_reveal_commit','orl_ic_c2_status','orl_ic_c2_backfill_view','orl_ic_c2_backfill_commit','orl_ic_c2_verify_start','orl_ic_c2_verify_view','orl_ic_c2_verify_commit','orl_ic_c2_finalize','orl_ic_c1_rate_limit','orl_ic_c1_unscheduled_count','orl_ic_c1_repair_view','orl_ic_c1_repair','orl_ic_c1_control_view','orl_ic_c1_control','orl_ic_c1_authorize', 'orl_ic_c1_check_password', 'orl_ic_c1_create',
  'orl_ic_c1_mutate', 'orl_ic_c1_confirm', 'orl_ic_c1_assign', 'orl_ic_c1_review', 'orl_ic_c1_clear', 'orl_ic_c1_deletion', 'orl_ic_c1_reassign', 'orl_ic_c1_remove', 'orl_ic_c1_export', 'orl_ic_c1_import', 'orl_ic_c1_resolve_create', 'orl_ic_c1_prepare_create']);
export function createBackendRpc({ baseUrl, secretKey, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(base.hostname)
      || base.username || base.password || base.port || base.search || base.hash || base.pathname !== '/')
    throw new Error('Backend configuration invalid.');
  if (typeof secretKey !== 'string' || !secretKey || secretKey.startsWith('sb_publishable_')) throw new Error('Backend configuration invalid.');
  return async (name, args) => {
    if (!allowed.has(name)) throw new Error('Unsupported backend operation.');
    const headers = { 'Content-Type': 'application/json', apikey: secretKey };
    if (!secretKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secretKey}`;
    const response = await fetchImpl(new URL('/rest/v1/rpc/' + name, base), { method: 'POST', headers,
      body: JSON.stringify(args), redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(C1_RPC_TIMEOUT_MS) });
    if (!response.ok) throw new Error('Backend operation unavailable.');
    return response.json();
  };
}
