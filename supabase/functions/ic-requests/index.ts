import { createBackendRpc } from '../_shared/c1/backend.mjs';
import { createIcGateway } from '../_shared/c1/gateway.mjs';
import { C1_RATE_MAX_REQUESTS, C1_RATE_WINDOW_SECONDS } from '../_shared/c1/runtime-policy.mjs';

const read = (name: string): string => Deno.env.get(name) || '';
function backendKey(): string {
  const encoded = read('SUPABASE_SECRET_KEYS');
  const value = encoded ? JSON.parse(encoded).default : read('SUPABASE_SERVICE_ROLE_KEY');
  if (typeof value !== 'string' || !value) throw new Error('Backend unavailable.');
  return value;
}
function cryptoConfig() {
  return {
    context: read('ORL_IC_CONTEXT'),
    activeEncryptionKey: read('ORL_IC_ACTIVE_ENCRYPTION_KEY'),
    activeSearchKey: read('ORL_IC_ACTIVE_SEARCH_KEY'),
    encryptionKeys: JSON.parse(read('ORL_IC_ENCRYPTION_KEYS')),
    searchKeys: JSON.parse(read('ORL_IC_SEARCH_KEYS')),
  };
}

const rpc = createBackendRpc({ baseUrl: read('SUPABASE_URL'), secretKey: backendKey() });
const gateway = createIcGateway({
  enabled: read('ORL_IC_C1_ENABLED') === 'true',
  origins: ['https://nazmiadnan92.github.io'],
  rpc,
  cryptoConfig,
  async rateLimit({ token, limit, windowSeconds }: { token: string; limit: number; windowSeconds: number }) {
    if (limit !== C1_RATE_MAX_REQUESTS || windowSeconds !== C1_RATE_WINDOW_SECONDS) throw new Error('Policy mismatch.');
    return await rpc('orl_ic_c1_rate_limit', { p_session_token: token }) === true;
  },
});

Deno.serve(gateway);
