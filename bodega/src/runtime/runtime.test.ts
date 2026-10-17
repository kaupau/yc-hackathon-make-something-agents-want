import test from 'node:test';
import assert from 'node:assert/strict';
import { MockCatalog } from '../mocks/catalog.js';
import { MockLedger } from '../mocks/ledger.js';
import { MockVault } from '../mocks/vault.js';
import { createTrialRuntime, createSimulatedSandboxBackend, createProxyHandler, createBlaxelSandboxBackend, type SandboxBackend, type BlaxelSDK } from './index.js';
import type { Listing, Trial } from '../contracts/index.js';

function fixtures() {
  const catalog = new MockCatalog(); const ledger = new MockLedger(catalog); const vault = new MockVault();
  return { catalog, ledger, vault };
}
async function activeTrial(services: ReturnType<typeof fixtures>, limit = 1): Promise<Trial> {
  const trial: Trial = { id: 'trial-test', listing_id: 'primitive-email', session_id: 'test', sandbox_id: 'sbox', status: 'active', used: 0, limit, unit: 'api_calls', token: 'bdg_trial_testtoken', started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() };
  await services.ledger.createTrial(trial); return trial;
}
const request = (token: string, path = '/send-mail', headers?: HeadersInit) => new Request(`https://bodega.test/proxy/${token}${path}`, { headers });

test('sandbox receives only Bodega token; end/reaper revoke and destroy', async () => {
  const services = fixtures(); let now = Date.now(); let env: Record<string, string> = {}; const destroyed: string[] = [];
  const backend: SandboxBackend = { mode: 'blaxel', async create(input) { env = input.env; return input.id; }, async exec() { return { exitCode: 0, stdout: 'x'.repeat(200), stderr: '' }; }, async destroy(id) { destroyed.push(id); } };
  const runtime = createTrialRuntime(services, { backend, publicBaseUrl: 'https://bodega.test', reaperIntervalMs: 0, now: () => now, maxOutputBytes: 30 });
  const listing = await services.catalog.get('primitive-email') as Listing;
  const [first, duplicate] = await Promise.all([runtime.start(listing, 's1'), runtime.start(listing, 's1')]);
  assert.equal(first.id, duplicate.id); assert.deepEqual(Object.keys(env).sort(), ['BODEGA_TOOL_BASE_URL', 'BODEGA_TOOL_KEY']);
  assert.match(env.BODEGA_TOOL_KEY, /^bdg_trial_/); assert.ok(!JSON.stringify(env).includes('mock-primitive-email-key'));
  const output = await runtime.run({ trial_id: first.id, command: 'anything' }); assert.equal(output.stdout.length, 30);
  await assert.rejects(runtime.run({ trial_id: first.id, file: { path: '/etc/secret', content: '' } }), /under/);
  now += 31 * 60000; await runtime.reapExpired(); assert.equal(destroyed.length, 1); assert.ok(services.vault.revoked.has(first.id));
  assert.equal((await services.ledger.getTrial(first.id))?.status, 'expired');
  await assert.rejects(runtime.start(listing, 's1'), /does not reset/); await runtime.close();
});

test('run timeout destroys detached workloads and returns bounded error', async () => {
  const services = fixtures(); let destroyed = false;
  const runtime = createTrialRuntime(services, { publicBaseUrl: 'https://bodega.test', reaperIntervalMs: 0, backend: { mode: 'blaxel', async create() { return 'sbox'; }, async exec() { return new Promise(() => {}); }, async destroy() { destroyed = true; } } });
  const trial = await runtime.start(await services.catalog.get('primitive-email') as Listing, 'test');
  const result = await runtime.run({ trial_id: trial.id, command: 'untrusted', timeout_s: 0.01 });
  assert.equal(result.exit_code, 124); assert.ok(destroyed); assert.equal((await services.ledger.getTrial(trial.id))?.status, 'ended'); await runtime.close();
});

test('simulation is explicit and comparison normalizes failures without recommending fake timing', async () => {
  const services = fixtures(); const runtime = createTrialRuntime(services, { backend: createSimulatedSandboxBackend(), publicBaseUrl: 'https://bodega.test', reaperIntervalMs: 0 });
  const report = await runtime.compare(['primitive-email', 'postpigeon-email', 'missing'], 'email.roundtrip', 'test');
  assert.equal(report.results.length, 3); assert.equal(report.results[0].ok, true); assert.match(report.results[0].logs_tail, /SIMULATED/); assert.equal(report.results[1].ok, false); assert.equal(report.results[2].ok, false); assert.equal(report.suggestion, null);
  assert.ok((await services.ledger.listTrials('test')).every(t => t.status === 'ended')); await runtime.close();
});

test('proxy allows exactly final quota call, replaces credentials and redacts reflected secrets', async () => {
  const services = fixtures(); const trial = await activeTrial(services); let calls = 0;
  const proxy = createProxyHandler(services, { fetch: async (_url, init) => { calls++; const headers = new Headers(init?.headers); assert.equal(headers.get('authorization'), 'Bearer mock-primitive-email-key'); assert.equal(headers.get('x-api-key'), null); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('x-forwarded-host'), null); assert.equal(init?.redirect, 'manual'); return new Response('{"echo":"mock-primitive-email-key"}', { headers: { 'content-type': 'application/json', 'set-cookie': 'evil' } }); } });
  const response = await proxy(request(trial.token, '/send-mail', { authorization: 'Bearer attacker', 'X-API-Key': 'attacker', cookie: 'secret', 'x-forwarded-host': 'evil.test' }));
  assert.equal(response?.status, 200); assert.equal(response?.headers.get('set-cookie'), null); assert.match(await response!.text(), /redacted/);
  assert.equal((await proxy(request(trial.token)))?.status, 402); assert.equal(calls, 1);
});

test('atomic ledger rejection never forwards; last accepted unit still forwards', async () => {
  const services = fixtures(); const trial = await activeTrial(services, 10); let calls = 0;
  services.ledger.recordUsage = async () => { throw Object.assign(new Error('pool empty'), { code: 'QUOTA_EXCEEDED' }); };
  const proxy = createProxyHandler(services, { fetch: async () => { calls++; return new Response('{}'); } });
  assert.equal((await proxy(request(trial.token)))?.status, 402); assert.equal(calls, 0);
  services.ledger.recordUsage = async () => ({ used: 10, limit: 10, exhausted: true });
  assert.equal((await proxy(request(trial.token)))?.status, 200); assert.equal(calls, 1);
});

test('proxy denies missing policies, private upstreams, unsafe paths, redirects and expired trials', async () => {
  const services = fixtures(); const trial = await activeTrial(services, 20); let calls = 0;
  const proxy = createProxyHandler(services, { fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }); } });
  for (const path of ['/admin', '//evil.test', '/send-mail/%252e%252e', '/send-mail/%2fsecret', '/send-mail/%5csecret']) assert.ok([400, 403].includes((await proxy(request(trial.token, path)))!.status));
  assert.equal(calls, 0); assert.equal((await proxy(request(trial.token)))?.status, 502); assert.equal(calls, 1);
  services.vault.upstream = async () => ({ listing_id: trial.listing_id, base_url: 'http://127.0.0.1/admin', auth: { header: 'Authorization', format: 'Bearer {key}' }, credential: { kind: 'pooled_key', env_var: 'NO_KEY' } });
  assert.equal((await proxy(request(trial.token)))?.status, 403);
  await services.ledger.updateTrial(trial.id, { expires_at: new Date(0).toISOString() }); assert.equal((await proxy(request(trial.token)))?.status, 403);
});

test('proxy timeout cancels network and bounded request bodies do not consume quota', async () => {
  const services = fixtures(); const trial = await activeTrial(services, 20);
  const proxy = createProxyHandler(services, { timeoutMs: 10, maxRequestBytes: 2, fetch: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  const large = new Request(`https://bodega.test/proxy/${trial.token}/send-mail`, { method: 'POST', body: 'large' });
  assert.equal((await proxy(large))?.status, 413); assert.equal((await services.ledger.getTrial(trial.id))?.used, 0);
  assert.equal((await proxy(request(trial.token)))?.status, 504);
});

test('purchased keys use injected paid-credit resolver and fail closed when depleted', async () => {
  const services = fixtures(); let allowed = true; let calls = 0;
  const proxy = createProxyHandler(services, { resolvePurchasedKey: async token => token === 'bdg_live_test' ? { listing_id: 'primitive-email', lease_id: 'paid-id', expires_at: new Date(Date.now() + 60000).toISOString(), consume: async () => allowed } : null, fetch: async () => { calls++; return new Response('{}'); } });
  assert.equal((await proxy(request('bdg_live_test')))?.status, 200); allowed = false;
  assert.equal((await proxy(request('bdg_live_test')))?.status, 402); assert.equal(calls, 1);
});

test('Blaxel backend uses seconds, keepAlive, only supplied env, and kills on failure', async () => {
  const records: Record<string, unknown>[] = []; const killed: string[] = [];
  const sandbox = { fs: { async write() {} }, process: { async exec(input: Record<string, unknown>) { records.push(input); throw new Error('remote failure'); }, async kill(name: string) { killed.push(name); } } };
  const sdk: BlaxelSDK = { SandboxInstance: { async create(input) { records.push(input); return sandbox; }, async get() { return sandbox; }, async delete() {} } };
  const backend = await createBlaxelSandboxBackend(sdk); await backend.create({ id: 'test', image: 'image', env: { BODEGA_TOOL_KEY: 'opaque' }, ttlSeconds: 60 });
  await assert.rejects(backend.exec('test', { command: 'code', timeoutMs: 1200 })); assert.equal(records[1].timeout, 2); assert.equal(records[1].keepAlive, true); assert.equal(killed.length, 1); assert.deepEqual(records[0].envs, [{ name: 'BODEGA_TOOL_KEY', value: 'opaque' }]);
});

test('parallel requests cannot overrun atomic vendor pool across two trial tokens', async () => {
  const services = fixtures(); const first = await activeTrial(services, 20);
  const second = { ...first, id: 'trial-second', token: 'bdg_trial_secondtoken' }; await services.ledger.createTrial(second);
  let pool = 0; let forwarded = 0;
  services.ledger.recordUsage = async id => {
    // This synchronous critical section represents the ledger transaction across trials.
    if (pool >= 5) throw Object.assign(new Error('vendor pool empty'), { code: 'QUOTA_EXCEEDED' });
    pool++;
    return { used: pool, limit: 20, exhausted: pool === 5 };
  };
  const proxy = createProxyHandler(services, { fetch: async () => { forwarded++; return new Response('{}'); } });
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => proxy(request(i % 2 ? first.token : second.token))));
  assert.equal(responses.filter(r => r?.status === 200).length, 5);
  assert.equal(responses.filter(r => r?.status === 402).length, 15);
  assert.equal(pool, 5); assert.equal(forwarded, 5);
});

test('redirects and thrown upstream failures never expose credentials', async () => {
  const services = fixtures(); const trial = await activeTrial(services, 10);
  const redirect = createProxyHandler(services, { fetch: async () => new Response('mock-primitive-email-key', { status: 302, headers: { location: 'https://evil.test/mock-primitive-email-key' } }) });
  const response = await redirect(request(trial.token));
  assert.equal(response?.status, 502); assert.ok(!(await response!.text()).includes('mock-primitive-email-key')); assert.equal(response?.headers.get('location'), null);
  const failure = createProxyHandler(services, { fetch: async () => { throw new Error('mock-primitive-email-key'); } });
  const failed = await failure(request(trial.token)); assert.equal(failed?.status, 502); assert.ok(!(await failed!.text()).includes('mock-primitive-email-key'));
});

test('vendor HTML cannot execute on the Bodega origin or leak bearer URLs via referrers', async () => {
  const services = fixtures(); const trial = await activeTrial(services, 10);
  const proxy = createProxyHandler(services, { fetch: async () => new Response('<script>fetch("https://evil.test")</script>', { headers: { 'content-type': 'text/html' } }) });
  const response = await proxy(request(trial.token));
  assert.equal(response?.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response?.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(response?.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response?.headers.get('x-content-type-options'), 'nosniff');
});
