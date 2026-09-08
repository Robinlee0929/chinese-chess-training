import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createForensicCaller } from './prelive/forensic-caller.js';
import { createForensicReader } from './prelive/forensic-reader.js';
import { forensicSnapshot } from './prelive/forensics.js';
import { sqliteStorage } from './prelive-test-support.mjs';
import { FakeClock, deferred, flush } from './test-support.mjs';

const require = createRequire(import.meta.url);
const ORIGIN = 'https://chinese-chess-coach-forensic-staging.robinlee700929.workers.dev';
const EMAIL = 'robinlee700929@gmail.com';
const AUDIENCE = 'synthetic-forensic-audience';
const FIXED_IDENTITY = 'review-coach-real-provider-global-v1';
const CONFIG_URL = new URL('./wrangler.forensic-caller.jsonc', import.meta.url);
const FORENSIC_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Forensic snapshot</title>
</head>
<body>
<form method="post" action="/__operator/forensics">
<button type="submit">Request forensic snapshot</button>
</form>
</body>
</html>`;
const snapshot = Object.freeze({
  version: 1,
  schema: { tablesPresent: { coach_days: true, coach_reservations: true, coach_slot: true,
    coach_recovery: true, coach_one_shot: true }, consistencyStatus: 'VALID' },
  raw: { oneShot: { rowPresent: true, state: 'DISARMED' }, slot: { rowPresent: true, ownerGeneration: null },
    recovery: { rowPresent: true, state: 'NORMAL', ownerGeneration: null }, budgetRows: [], reservations: [] },
  derived: { recoveryRequired: false, recoveryReason: 'NONE', accountingConsistency: 'CONSISTENT',
    attempted: 'UNKNOWN', providerFetchStarted: 'UNKNOWN', upstreamDelivery: 'UNKNOWN',
    transitionTimestamp: 'NOT_AVAILABLE', lastTransitionKind: 'NOT_AVAILABLE' },
  completeness: { truncated: false, budgetRows: 0, reservations: 0, readComplete: true },
});
const encodedSnapshot = value => JSON.stringify(value);
const context = (email = EMAIL, audience = AUDIENCE) => ({ access: { aud: audience,
  getIdentity: async () => ({ email }) } });

function fixture({ value = encodedSnapshot(snapshot), ctx = context(), envOverrides = {}, clock = new FakeClock(), methods = {} } = {}) {
  const state = { identities: [], args: [], calls: Object.create(null), envReads: [] };
  const called = name => { state.calls[name] = (state.calls[name] ?? 0) + 1; };
  const stub = {
    async forensicSnapshot(...args) { called('forensicSnapshot'); state.args.push(args); return value; },
    async execute() { called('execute'); }, async accessOperator(action) { called(action); },
    async recover() { called('recover'); }, async clearRecovery() { called('clearRecovery'); },
    async reserve() { called('reserve'); }, ...methods,
  };
  const target = { COACH_FORENSIC_ACCESS_AUD: AUDIENCE, COACH_REAL_FORENSICS: stub,
    OPENAI_API_KEY: 'PRIVATE_SECRET_SENTINEL',
    COACH_REAL_RATE_LIMITER: { limit: async () => { called('rate'); return { success: true }; } },
    COACH_PROVIDER: { execute: async () => { called('provider'); } },
    CALLER_KV: { put: async () => { called('storage'); } }, ...envOverrides };
  const env = new Proxy(target, { get(object, key, receiver) {
    state.envReads.push(String(key)); return Reflect.get(object, key, receiver);
  } });
  const handler = createForensicCaller({ clock });
  const send = (options = {}, suppliedContext = ctx) => {
    const { path = '/__operator/forensics', headers = {}, ...requestOptions } = options;
    return handler(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Origin: ORIGIN, ...headers },
      ...requestOptions }), env, suppliedContext);
  };
  return { state, stub, env, clock, handler, send };
}

async function expectFailure(h, options = {}, ctx, status = 403) {
  const response = await h.send(options, ctx);
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { status: 'failed' });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return response;
}

test('C1K P2B trusted exact operator makes one bounded forensic call', async () => {
  const h = fixture(); const response = await h.send();
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), snapshot);
  assert.equal(h.state.calls.forensicSnapshot, 1);
});
test('C1K B2 exact root GET returns one static form before Access or env lookup', async () => {
  let identityCalls = 0;
  const h = fixture();
  const response = await h.handler(new Request(`${ORIGIN}/`, { method: 'GET' }), h.env,
    { access: { aud: AUDIENCE, getIdentity: async () => { identityCalls++; return { email: EMAIL }; } } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('Content-Security-Policy'),
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  const body = await response.text();
  assert.equal(body, FORENSIC_PAGE);
  assert.equal((body.match(/<form\b/giu) ?? []).length, 1);
  assert.match(body, /<form method="post" action="\/__operator\/forensics">/u);
  assert.equal(/<script\b/iu.test(body), false);
  assert.equal(/<(?:input|select|textarea)\b/iu.test(body), false);
  assert.equal(/<(?:button|input|select|textarea)\b[^>]*\sname\s*=/iu.test(body), false);
  assert.equal(/\son[a-z]+\s*=/iu.test(body), false);
  assert.equal(/\s(?:src|href)\s*=/iu.test(body), false);
  assert.equal(/(?:\.submit|\.requestSubmit)\s*\(/iu.test(body), false);
  assert.equal(identityCalls, 0);
  assert.deepEqual(h.state.envReads, []);
  assert.deepEqual(Object.keys(h.state.calls), []);
});
test('C1K B2 every non-exact root request fails before Access or env lookup', async () => {
  for (const [method, path] of [['GET', '/?probe=1'], ['HEAD', '/'], ['POST', '/'],
    ['GET', '/__operator/forensics'], ['GET', '/other']]) {
    const h = fixture(); await expectFailure(h, { method, path });
    assert.deepEqual(h.state.envReads, [], `${method} ${path} env reads`);
    assert.deepEqual(Object.keys(h.state.calls), [], `${method} ${path} capability calls`);
  }
  const h = fixture();
  const response = await h.handler(new Request('https://foreign.invalid/', { method: 'GET' }), h.env, context());
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { status: 'failed' });
  assert.deepEqual(h.state.envReads, []); assert.deepEqual(Object.keys(h.state.calls), []);
});
test('C1K B2 browser-equivalent zero-control form POST preserves the exact forensic POST contract', async () => {
  const controls = new URLSearchParams();
  const request = new Request(`${ORIGIN}/__operator/forensics`, {
    method: 'POST', headers: { Origin: ORIGIN }, body: controls,
  });
  const inspected = request.clone();
  const url = new URL(request.url);
  const contentTypeParts = request.headers.get('Content-Type').split(';').map(part => part.trim());
  assert.equal(request.method, 'POST');
  assert.equal(url.pathname, '/__operator/forensics');
  assert.equal(url.search, '');
  assert.equal(request.headers.get('Origin'), ORIGIN);
  assert.equal(contentTypeParts.shift().toLowerCase(), 'application/x-www-form-urlencoded');
  assert.equal(contentTypeParts.every(parameter => /^charset=utf-8$/iu.test(parameter)), true);
  assert.equal([...controls].length, 0);
  assert.equal((await inspected.arrayBuffer()).byteLength, 0);
  const h = fixture(); const response = await h.handler(request, h.env, context());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), snapshot);
  assert.equal(h.state.calls.forensicSnapshot, 1);
  assert.deepEqual(h.state.args, [[]]);
});
test('C1K B2 nonempty browser form payload remains rejected before the binding', async () => {
  const h = fixture(); const body = new URLSearchParams({ action: 'execute' });
  await expectFailure(h, { body });
  assert.equal(body.toString(), 'action=execute');
  assert.equal(h.state.calls.forensicSnapshot ?? 0, 0);
});
test('C1K P2B unauthenticated request makes zero DO calls', async () => {
  const h = fixture(); await expectFailure(h, {}, {}); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B wrong email makes zero DO calls', async () => {
  const h = fixture(); await expectFailure(h, {}, context('other@example.invalid')); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B wrong audience makes zero DO calls', async () => {
  const h = fixture(); await expectFailure(h, {}, context(EMAIL, 'wrong')); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B raw X-User-Email cannot authorize', async () => {
  const h = fixture(); await expectFailure(h, { headers: { 'X-User-Email': EMAIL } }, {}); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B raw Cf-Access-Authenticated-User-Email cannot authorize', async () => {
  const h = fixture(); await expectFailure(h, { headers: { 'Cf-Access-Authenticated-User-Email': EMAIL } }, {}); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B plain Authorization text cannot authorize', async () => {
  const h = fixture(); await expectFailure(h, { headers: { Authorization: `Bearer ${AUDIENCE}` } }, {}); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B foreign origin makes zero DO calls', async () => {
  const h = fixture(); await expectFailure(h, { headers: { Origin: 'https://foreign.invalid' } }); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B missing origin makes zero DO calls', async () => {
  const h = fixture(); await expectFailure(h, { headers: { Origin: undefined } }); assert.equal(h.state.identities.length, 0);
});
for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) test(`C1K P2B ${method} is rejected before DO lookup`, async () => {
  const h = fixture(); await expectFailure(h, { method }); assert.equal(h.state.identities.length, 0);
});
for (const [name, body] of [['non-empty JSON', '{}'], ['arbitrary text', 'text'], ['action field', '{"action":"execute"}'],
  ['object identity field', '{"object":"client-selected"}'], ['RPC args field', '{"args":[]}'], ['SQL field', '{"sql":"SELECT 1"}'],
  ['method field', '{"method":"forensicSnapshot"}'], ['body email', `{"email":"${EMAIL}"}`]]) {
  test(`C1K P2B rejects ${name}`, async () => {
    const h = fixture(); await expectFailure(h, { body }); assert.equal(h.state.identities.length, 0);
  });
}
for (const query of ['?action=execute', `?email=${encodeURIComponent(EMAIL)}`, '?object=client-selected', '?method=forensicSnapshot']) {
  test(`C1K P2B rejects query selector ${query.split('=')[0]}`, async () => {
    const h = fixture(); await expectFailure(h, { path: `/__operator/forensics${query}` }); assert.equal(h.state.identities.length, 0);
  });
}
test('C1K P2B rejects every alternate path', async () => {
  const h = fixture();
  for (const path of ['/__operator/forensics/', '/__operator/one-shot/arm', '/__operator/one-shot/dispatch', '/api/review-coach']) {
    await expectFailure(h, { path });
  }
  assert.equal(h.state.identities.length, 0);
});
test('C1K P2B narrow reader selects only the fixed logical object and passes zero RPC arguments', async () => {
  const state = { identities: [], args: [] };
  const reader = createForensicReader({ COACH_REAL_COORDINATOR: { getByName(name) {
    state.identities.push(name); return { forensicSnapshot(...args) { state.args.push(args); return encodedSnapshot(snapshot); } };
  } } });
  assert.equal(await reader.forensicSnapshot(), encodedSnapshot(snapshot));
  assert.deepEqual(state.identities, [FIXED_IDENTITY]); assert.deepEqual(state.args, [[]]);
});
test('C1K P2B narrow reader rejects every RPC argument before DO lookup', async () => {
  let lookups = 0; const reader = createForensicReader({ COACH_REAL_COORDINATOR: { getByName() { lookups++; } } });
  await assert.rejects(reader.forensicSnapshot({ object: 'client-selected' }), /arguments denied/i);
  assert.equal(lookups, 0);
});
test('C1K P2B exposes no provider, ARM, DISPATCH, recovery, budget, rate, or storage operation', async () => {
  const h = fixture(); await h.send();
  for (const name of ['execute', 'arm', 'dispatch', 'recover', 'clearRecovery', 'reserve', 'rate', 'provider', 'storage']) {
    assert.equal(h.state.calls[name] ?? 0, 0, `${name} capability must remain unused`);
  }
});
test('C1K P2B never reads provider secret or provider configuration', async () => {
  const h = fixture(); await h.send();
  for (const key of ['OPENAI_API_KEY', 'COACH_REAL_PROVIDER_ENABLED', 'COACH_REAL_PROVIDER_PUBLIC_ENABLED',
    'COACH_REAL_DAILY_UNITS', 'COACH_REAL_RATE_LIMITER', 'COACH_PROVIDER', 'CALLER_KV']) assert.equal(h.state.envReads.includes(key), false);
});
test('C1K P2B returns the exact reviewed snapshot allowlist', async () => {
  const h = fixture(); const result = await (await h.send()).json();
  assert.deepEqual(Object.keys(result), ['version', 'schema', 'raw', 'derived', 'completeness']);
  assert.deepEqual(Object.keys(result.raw), ['oneShot', 'slot', 'recovery', 'budgetRows', 'reservations']);
});
test('C1K P2B rejects a raw extra response field', async () => {
  const h = fixture({ value: encodedSnapshot({ ...snapshot, secret: 'PRIVATE_SECRET_SENTINEL' }) });
  const response = await h.send(); const text = await response.text();
  assert.equal(response.status, 503); assert.deepEqual(JSON.parse(text), { status: 'failed' }); assert.equal(text.includes('PRIVATE'), false);
});
test('C1K P2B rejects a nested extra response field', async () => {
  const h = fixture({ value: encodedSnapshot({ ...snapshot, raw: { ...snapshot.raw, sql: 'SELECT private' } }) });
  await expectFailure(h, {}, undefined, 503);
});
test('C1K P2B never exposes a raw exception or stack', async () => {
  const h = fixture({ methods: { forensicSnapshot: async () => { h.state.calls.forensicSnapshot = 1; throw new Error('PRIVATE_STACK_SENTINEL'); } } });
  const response = await h.send(); const text = await response.text();
  assert.equal(response.status, 503); assert.deepEqual(JSON.parse(text), { status: 'failed' }); assert.equal(text.includes('PRIVATE'), false);
});
test('C1K P2B timeout makes no retry and ignores a late result', async () => {
  const pending = deferred(); const h = fixture({ methods: { forensicSnapshot: (...args) => {
    h.state.calls.forensicSnapshot = (h.state.calls.forensicSnapshot ?? 0) + 1; h.state.args.push(args); return pending.promise;
  } } });
  const responsePromise = h.send(); await flush(); assert.equal(h.state.calls.forensicSnapshot, 1);
  await h.clock.advance(3000); const response = await responsePromise; assert.equal(response.status, 503);
  pending.resolve(encodedSnapshot(snapshot)); await flush(); assert.equal(h.state.calls.forensicSnapshot, 1);
});
test('C1K P2B ambiguous downstream rejection makes no retry', async () => {
  const h = fixture({ methods: { forensicSnapshot: async () => {
    h.state.calls.forensicSnapshot = (h.state.calls.forensicSnapshot ?? 0) + 1; throw new Error('ambiguous');
  } } });
  await expectFailure(h, {}, undefined, 503); assert.equal(h.state.calls.forensicSnapshot, 1);
});
test('C1K P2B downstream 5xx-shaped value makes no retry', async () => {
  const h = fixture({ value: new Response('PRIVATE', { status: 500 }) });
  await expectFailure(h, {}, undefined, 503); assert.equal(h.state.calls.forensicSnapshot, 1);
});
test('C1K P2B malformed snapshot fails closed', async () => {
  const h = fixture({ value: '{"version":1}' }); await expectFailure(h, {}, undefined, 503);
});
test('C1K P2B noncanonical or duplicate-key snapshot fails closed', async () => {
  for (const value of [` ${encodedSnapshot(snapshot)}`, '{"version":1,"version":1}']) {
    const h = fixture({ value }); await expectFailure(h, {}, undefined, 503);
  }
});
test('C1K P2B oversized snapshot fails closed', async () => {
  const h = fixture({ value: 'x'.repeat(8193) }); await expectFailure(h, {}, undefined, 503);
});
test('C1K P2B bounded truncated snapshot is accepted without a consistency claim', async () => {
  const truncated = structuredClone(snapshot);
  truncated.raw.budgetRows = Array.from({ length: 8 }, (_, index) => ({ day: `2026-09-${String(index + 1).padStart(2, '0')}`, units: 0 }));
  truncated.completeness = { truncated: true, budgetRows: 9, reservations: 0, readComplete: true };
  truncated.derived = { ...truncated.derived, recoveryRequired: true, recoveryReason: 'INCOMPLETE_EVIDENCE', accountingConsistency: 'UNKNOWN' };
  const h = fixture({ value: encodedSnapshot(truncated) }); const result = await (await h.send()).json();
  assert.equal(result.completeness.truncated, true); assert.equal(result.derived.accountingConsistency, 'UNKNOWN');
  assert.equal(result.raw.budgetRows.length, 8);
});
test('C1K P2B accepts frozen C1J idle, invalid, truncated, and read-failure evidence shapes', async () => {
  const fixtures = [
    storage => forensicSnapshot(storage),
    storage => { storage.sql.exec("UPDATE coach_recovery SET state = 'PRIVATE'"); return forensicSnapshot(storage); },
    storage => { for (let index = 1; index <= 9; index++) storage.sql.exec('INSERT INTO coach_days VALUES (?, 0)',
      `2026-09-${String(index).padStart(2, '0')}`); return forensicSnapshot(storage); },
    storage => { storage.sql.exec = () => { throw new Error('read failed'); }; return forensicSnapshot(storage); },
  ];
  for (const make of fixtures) {
    const storage = sqliteStorage();
    try {
      const expected = make(storage); const response = await fixture({ value: JSON.stringify(expected) }).send();
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
    } finally { storage.db.close(); }
  }
});
test('C1K P2B incomplete snapshot cannot claim consistency', async () => {
  const incomplete = structuredClone(snapshot); incomplete.completeness.readComplete = false;
  const h = fixture({ value: encodedSnapshot(incomplete) }); await expectFailure(h, {}, undefined, 503);
});
test('C1K P2B Access identity lookup timeout fails before DO lookup', async () => {
  const clock = new FakeClock(); const pending = deferred(); const h = fixture({ clock,
    ctx: { access: { aud: AUDIENCE, getIdentity: () => pending.promise } } });
  const responsePromise = h.send(); await flush(); await clock.advance(1000);
  assert.equal((await responsePromise).status, 403); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B missing Access audience policy fails before DO lookup', async () => {
  const h = fixture({ envOverrides: { COACH_FORENSIC_ACCESS_AUD: undefined } });
  await expectFailure(h); assert.equal(h.state.identities.length, 0);
});
test('C1K P2B caller config has one exact method-scoped coordinator service binding', async () => {
  const config = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
  assert.deepEqual(config.services, [{ binding: 'COACH_REAL_FORENSICS', service: 'chinese-chess-coach-openai-staging',
    entrypoint: 'CoachRealForensicReader' }]);
  assert.equal(config.durable_objects, undefined);
});
test('C1K P2B caller config has no secret, rate, provider, budget, migration, or persistent storage capability', async () => {
  const config = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
  for (const key of ['vars', 'secrets', 'ratelimits', 'kv_namespaces', 'd1_databases', 'r2_buckets', 'queues',
    'workflows', 'migrations']) assert.equal(config[key], undefined, key);
  assert.equal(JSON.stringify(config).includes('OPENAI_API_KEY'), false);
  assert.equal(JSON.stringify(config).includes('COACH_REAL_PROVIDER'), false);
  assert.equal(JSON.stringify(config).includes('COACH_REAL_DAILY_UNITS'), false);
});
test('C1K P2B caller config exposes only explicit workers.dev ingress with previews disabled', async () => {
  const config = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
  assert.equal(config.name, 'chinese-chess-coach-forensic-staging'); assert.equal(config.main, 'prelive/forensic-caller.js');
  assert.equal(config.workers_dev, true); assert.equal(config.preview_urls, false);
  assert.equal(config.route, undefined); assert.equal(config.routes, undefined);
});
test('C1K P2B pinned Wrangler accepts the forensic caller config', async () => {
  assert.equal(require('./package.json').devDependencies.wrangler, '4.129.0');
  const parsed = require('wrangler').unstable_readConfig({ config: fileURLToPath(CONFIG_URL) });
  assert.equal(parsed.name, 'chinese-chess-coach-forensic-staging'); assert.equal(parsed.workers_dev, true);
  assert.equal(parsed.preview_urls, false); assert.equal(parsed.routes, undefined);
});
