// Server-only Package C2 helpers. Patient identity values are accepted only
// from service-role RPC results and are never returned to the browser.
import { createIdentityCrypto } from '../ic-crypto.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const fail = () => { throw new Error('C2 identity verification failed.'); };

function validBaseRow(row) {
  return exact(row, ['request_id', 'patient_ic', 'expected_request_updated_at'])
    && uuid.test(row.request_id || '') && typeof row.patient_ic === 'string'
    && row.patient_ic.length >= 1 && row.patient_ic.length <= 128
    && timestamp(row.expected_request_updated_at);
}

export async function prepareC2Backfill(rows, cryptoConfig) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 40
      || rows.some(row => !validBaseRow(row))) return fail();
  const engine = await createIdentityCrypto(cryptoConfig);
  return Promise.all(rows.map(async row => {
    const requestId = row.request_id.toLowerCase();
    const envelope = await engine.encrypt(row.patient_ic, requestId);
    const search = await engine.searchHash(row.patient_ic);
    if (await engine.decrypt(envelope, requestId) !== row.patient_ic) return fail();
    const check = await engine.searchHash(row.patient_ic, search.key_id);
    if (check.hash !== search.hash || check.normalization_version !== search.normalization_version) return fail();
    return { request_id: requestId, expected_request_updated_at: row.expected_request_updated_at,
      envelope, search };
  }));
}

export async function verifyC2Identities(rows, cryptoConfig) {
  const keys = ['request_id', 'patient_ic', 'expected_request_updated_at',
    'expected_identity_updated_at', 'envelope', 'search'];
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 40 || rows.some(row =>
    !exact(row, keys) || !uuid.test(row.request_id || '') || typeof row.patient_ic !== 'string'
    || row.patient_ic.length < 1 || row.patient_ic.length > 128
    || !timestamp(row.expected_request_updated_at) || !timestamp(row.expected_identity_updated_at)
    || !object(row.envelope) || !object(row.search))) return fail();
  const engine = await createIdentityCrypto(cryptoConfig);
  return Promise.all(rows.map(async row => {
    const requestId = row.request_id.toLowerCase();
    if (await engine.decrypt(row.envelope, requestId) !== row.patient_ic) return fail();
    const check = await engine.searchHash(row.patient_ic, row.search.key_id);
    if (check.hash !== row.search.hash || check.normalization_version !== row.search.normalization_version) return fail();
    return { request_id: requestId, expected_request_updated_at: row.expected_request_updated_at,
      expected_identity_updated_at: row.expected_identity_updated_at };
  }));
}
