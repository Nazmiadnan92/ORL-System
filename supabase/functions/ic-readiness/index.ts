import { createReadinessHandler } from './handler.mjs';

const read = (name: string) => Deno.env.get(name) || '';
// New Supabase secret-key map is preferred; legacy service-role is server-only.
function backendKey(): string {
  const keys = read('SUPABASE_SECRET_KEYS');
  const value = keys ? JSON.parse(keys).default : read('SUPABASE_SERVICE_ROLE_KEY');
  if (typeof value !== 'string' || !value) throw new Error('Backend unavailable.');
  return value;
}
Deno.serve(createReadinessHandler({
  enabled: read('ORL_IC_READINESS_ENABLED') === 'true',
  origins: ['https://nazmiadnan92.github.io'],
  async authorize(token: string) {
    const base = new URL(read('SUPABASE_URL'));
    if (base.protocol !== 'https:') throw new Error('Backend unavailable.');
    const key = backendKey();
    const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
    if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
    const response = await fetch(new URL('/rest/v1/rpc/orl_ic_foundation_probe', base), {
      method: 'POST', headers, body: JSON.stringify({ p_session_token: token }),
      signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Readiness access denied.');
    return response.json();
  },
  cryptoConfig() {
    return {
      context: read('ORL_IC_CONTEXT'),
      activeEncryptionKey: read('ORL_IC_ACTIVE_ENCRYPTION_KEY'),
      activeSearchKey: read('ORL_IC_ACTIVE_SEARCH_KEY'),
      encryptionKeys: JSON.parse(read('ORL_IC_ENCRYPTION_KEYS')),
      searchKeys: JSON.parse(read('ORL_IC_SEARCH_KEYS')),
    };
  },
}));
