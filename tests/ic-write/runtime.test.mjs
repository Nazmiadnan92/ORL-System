import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPayload } from '../../security/candidates/c1-create/handler.mjs';
import { createIcGateway } from '../../security/candidates/c1-create/gateway.mjs';
import { createBackendRpc } from '../../security/candidates/c1-create/backend.mjs';
import { convertLegacyBackup } from '../../security/candidates/c1-create/legacy-backup.mjs';
import { toBase64 } from '../../supabase/functions/_shared/ic-crypto.mjs';
import {
  C1_BACKUP_BODY_BYTES, C1_BACKUP_MAX_IDENTITIES, C1_BODY_TIMEOUT_MS,
  C1_RATE_MAX_REQUESTS, C1_RATE_WINDOW_SECONDS, C1_RPC_TIMEOUT_MS, C1_SMALL_BODY_BYTES, backupWithinRuntimePolicy,
} from '../../security/candidates/c1-create/runtime-policy.mjs';

const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const edgePath = process.env.ORL_EDGE_PATH || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
let browser;
async function edge() {
  if (browser) return browser;
  assert.ok(edgePath && existsSync(edgePath), 'Installed Microsoft Edge is required for C1.13 runtime verification');
  let playwright;
  try { playwright = await import('playwright'); }
  catch {
    const bundled = resolve(dirname(process.execPath), '..', 'node_modules', 'playwright', 'index.mjs');
    playwright = await import(pathToFileURL(bundled));
  }
  browser = await playwright.chromium.launch({ executablePath: edgePath, headless: true });
  return browser;
}
after(async () => { if (browser) await browser.close(); });

const docs = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
let server, baseUrl;
async function site() {
  if (baseUrl) return baseUrl;
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (!/^[a-z0-9._/-]+$/i.test(relative) || relative.includes('..')) throw new Error('Denied');
      const file = join(docs, relative);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.xlsx': 'application/octet-stream' };
      const content = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolveListen()));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}
after(async () => { if (server) await new Promise(resolveClose => server.close(resolveClose)); });

test('C1 Edge policy fixes small/backup byte caps, record cap and conservative deadlines', () => {
  assert.equal(C1_SMALL_BODY_BYTES, 32 * 1024);
  assert.equal(C1_BACKUP_BODY_BYTES, 8 * 1024 * 1024);
  assert.equal(C1_BACKUP_MAX_IDENTITIES, 2000);
  assert.equal(C1_RATE_WINDOW_SECONDS, 60);
  assert.equal(C1_RATE_MAX_REQUESTS, 30);
  assert.equal(C1_BODY_TIMEOUT_MS, 2000);
  assert.equal(C1_RPC_TIMEOUT_MS, 25000);
  assert.equal(backupWithinRuntimePolicy({ requests: Array(2000).fill({}), identities: [], creation_receipts: [] }), true);
  assert.equal(backupWithinRuntimePolicy({ requests: Array(2001).fill({}), identities: [], creation_receipts: [] }), false);
});

test('streamed body reader enforces bytes, encoding and the two-second deadline', async () => {
  const exact = JSON.stringify({ value: 'x'.repeat(100) });
  assert.deepEqual(await readPayload(new Request('https://local.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact }), exact.length), JSON.parse(exact));
  await assert.rejects(readPayload(new Request('https://local.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact }), exact.length - 1));
  await assert.rejects(readPayload(new Request('https://local.test', { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: exact })));
  const never = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); } });
  const started = performance.now();
  await assert.rejects(readPayload(new Request('https://local.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: never, duplex: 'half' })));
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1800 && elapsed < 3500, `body deadline observed at ${elapsed} ms`);
});

test('gateway rate enforcement is mandatory, fail-closed and precedes body parsing', async () => {
  let calls = 0;
  const rpc = async name => { calls++; assert.equal(name, 'orl_ic_c1_authorize'); return { role: 'STAFF' }; };
  const request = () => new Request('https://synthetic.supabase.co/functions/v1/ic-requests', { method: 'POST', headers: {
    origin: 'https://nazmiadnan92.github.io', 'content-type': 'application/json', 'content-length': String(C1_SMALL_BODY_BYTES + 1), 'x-orl-session': token,
  }, body: '{}' });
  const options = { enabled: true, origins: ['https://nazmiadnan92.github.io'], rpc, cryptoConfig: () => assert.fail('No crypto') };
  const missing = await createIcGateway(options)(request());
  assert.equal(missing.status, 503);
  const denied = await createIcGateway({ ...options, rateLimit: async policy => {
    assert.deepEqual(policy, { token, role: 'STAFF', limit: 30, windowSeconds: 60 }); return false;
  } })(request());
  assert.equal(denied.status, 429); assert.equal(calls, 2);
  const unavailable = await createIcGateway({ ...options, rateLimit: async () => { throw new Error('private'); } })(request());
  assert.equal(unavailable.status, 503); assert.doesNotMatch(await unavailable.text(), /private/);
});

test('maximum 2,000-record legacy conversion remains below two seconds on the local runtime', async () => {
  const randomKey = () => toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const keys = { context: 'c1-runtime-synthetic', activeEncryptionKey: 'enc', activeSearchKey: 'search',
    encryptionKeys: { enc: randomKey() }, searchKeys: { search: randomKey() } };
  const requests = Array.from({ length: C1_BACKUP_MAX_IDENTITIES }, (_, index) => ({
    id: crypto.randomUUID(), patient_ic: `SYNTHETIC-${index}`, age: 10, age_months: 0,
  }));
  const backup = { format: 'ORLOMS_BACKUP', version: 1, requests, users: [], settings: [], holidays: [], ot_sessions: [], ot_slots: [], audit_log: [] };
  const started = performance.now();
  const converted = await convertLegacyBackup(backup, keys);
  const elapsed = performance.now() - started;
  assert.equal(converted.identities.length, C1_BACKUP_MAX_IDENTITIES);
  assert.equal(backupWithinRuntimePolicy(converted), true);
  assert.ok(elapsed < C1_BODY_TIMEOUT_MS, `local conversion took ${elapsed} ms`);
});

test('backup record policy rejects excess work before password or crypto processing', async () => {
  let passwordChecks = 0, cryptoCalls = 0;
  const run = createIcGateway({ enabled: true, origins: [], rateLimit: async () => true,
    cryptoConfig: () => { cryptoCalls++; throw new Error('stop'); },
    rpc: async name => {
      if (name === 'orl_ic_c1_authorize') return { role: 'WEBMASTER' };
      if (name === 'orl_ic_c1_check_password') { passwordChecks++; return true; }
      throw new Error('unexpected');
    } });
  const send = requests => run(new Request('https://synthetic.supabase.co/functions/v1/ic-requests', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-orl-session': token,
  }, body: JSON.stringify({ operation: 'BACKUP_CONVERT', password: 'SYNTHETIC', backup: {
    format: 'ORLOMS_BACKUP', version: 1, requests, users: [], settings: [], holidays: [], ot_sessions: [], ot_slots: [], audit_log: [],
  } }) }));
  assert.equal((await send(Array(2001).fill({}))).status, 400);
  assert.equal(passwordChecks, 0); assert.equal(cryptoCalls, 0);
  assert.equal((await send(Array(2000).fill({}))).status, 400);
  assert.equal(passwordChecks, 1); assert.equal(cryptoCalls, 1);
});

test('backend adapter applies the fixed 25-second abort signal', async () => {
  const original = AbortSignal.timeout;
  let timeout;
  AbortSignal.timeout = milliseconds => { timeout = milliseconds; return new AbortController().signal; };
  try {
    const rpc = createBackendRpc({ baseUrl: 'https://synthetic.supabase.co', secretKey: 'sb_secret_SYNTHETIC', fetchImpl: async (_, init) => {
      assert.ok(init.signal instanceof AbortSignal); return Response.json(true);
    } });
    await rpc('orl_ic_c1_check_password', { p_session_token: token, p_password: 'SYNTHETIC' });
    assert.equal(timeout, C1_RPC_TIMEOUT_MS);
  } finally { AbortSignal.timeout = original; }
});

test('installed Microsoft Edge renders the actual desktop login without overflow', async () => {
  const context = await (await edge()).newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(await site(), { waitUntil: 'load' });
  const result = await page.evaluate(() => ({
    title: document.title, overflow: document.documentElement.scrollWidth - innerWidth,
    form: document.querySelector('.login-card').getBoundingClientRect().toJSON(),
    usernameHeight: document.querySelector('#username').getBoundingClientRect().height,
  }));
  assert.equal(result.title, 'ORL OT Management System'); assert.ok(result.overflow <= 0);
  assert.ok(result.form.x >= 0 && result.form.x + result.form.width <= 1440); assert.ok(result.usernameHeight >= 40);
  await context.close();
});

test('installed Microsoft Edge mobile viewport keeps controls usable and supports required browser APIs/modules', async () => {
  const context = await (await edge()).newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(await site(), { waitUntil: 'load' });
  await page.evaluate(() => {
    document.querySelector('#login').hidden = true; document.querySelector('#app').hidden = false;
    document.querySelector('#content').innerHTML = `<div class="toolbar"><button>Refresh</button></div><div class="table-wrap"><table><thead><tr>${'<th>Field</th>'.repeat(9)}</tr></thead><tbody><tr>${'<td>TEST</td>'.repeat(9)}</tr></tbody></table></div>`;
    document.querySelector('#modal').hidden = false; document.querySelector('#modalBody').innerHTML = '<h2>Protected action</h2><div class="actions"><button>Cancel</button><button>Continue</button></div>';
  });
  const result = await page.evaluate(async base => {
    const module = await import(base + '/ic-client.mjs');
    const button = document.querySelector('.toolbar button').getBoundingClientRect();
    const wrap = document.querySelector('.table-wrap'); const dialog = document.querySelector('.dialog').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth - innerWidth, buttonHeight: button.height,
      tableScrollable: wrap.scrollWidth > wrap.clientWidth, dialogBottom: dialog.bottom,
      subtle: !!crypto.subtle, locks: !!navigator.locks, compression: typeof CompressionStream === 'function',
      module: typeof module.createIcTransport === 'function' };
  }, baseUrl);
  assert.ok(result.overflow <= 0); assert.ok(result.buttonHeight >= 44); assert.equal(result.tableScrollable, true);
  assert.ok(result.dialogBottom <= 844); assert.deepEqual([result.subtle, result.locks, result.compression, result.module], [true, true, true, true]);
  await context.close();
});
