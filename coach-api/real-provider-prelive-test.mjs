import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fakeWorker from './src/index.js';
import './prelive-runtime-test.mjs';
import { harness, modules, input, response, framing, SENTINEL, sqliteStorage, deferred, flush, request, payload, variant } from './prelive-test-support.mjs';

const settle = async () => { await flush(); await new Promise((resolve) => setImmediate(resolve)); };
const used = (h) => h.rows('coach_days').reduce((total, row) => total + row.units, 0);
const count = (h) => h.state.calls;

test('C1C end-to-end outer contexts use one named coordinator and preserve C1A bounds', async () => {
  const h = harness();
  try {
    const reply = await h.call();
    assert.equal(reply.status, 200);
    assert.deepEqual((await reply.json()).framing, framing);
    assert.equal(count(h), 1);
    assert.deepEqual(h.state.identities, ['review-coach-real-provider-global-v1']);
    const sent = h.state.requests[0];
    assert.equal(sent.url, 'https://api.openai.com/v1/responses');
    assert.equal(sent.body.model, 'gpt-5.6-luna');
    assert.equal(sent.body.max_output_tokens, 128);
    assert.deepEqual(sent.body.reasoning, { effort: 'none' });
    assert.equal(sent.body.store, false);
    assert.equal(sent.body.tools, undefined);
    assert.equal(sent.body.input, input().purpose);
    assert.equal(JSON.stringify(sent.body).includes(SENTINEL), false);
    assert.deepEqual(Object.keys(sent.body).sort(), ['model', 'store', 'reasoning', 'max_output_tokens', 'instructions', 'input', 'text'].sort());
    assert.equal(used(h), 1);
    assert.equal(h.rows('coach_reservations')[0].state, 'consumed');
    assert.equal(h.rows('coach_reservations')[0].finalized, 1);
  } finally { h.close(); }
});

for (const [name, overrides] of [
  ['disabled', { COACH_REAL_PROVIDER_ENABLED: 'false' }],
  ['missing enable', { COACH_REAL_PROVIDER_ENABLED: undefined }],
  ['missing secret', { OPENAI_API_KEY: undefined }],
  ['missing rate limiter', { COACH_REAL_RATE_LIMITER: undefined }],
  ['denied rate', { COACH_REAL_RATE_LIMITER: { limit: async () => ({ success: false }) } }],
  ['throwing rate', { COACH_REAL_RATE_LIMITER: { limit: async () => { throw new Error(SENTINEL); } } }],
  ['missing coordinator', { COACH_REAL_COORDINATOR: undefined }],
  ['missing budget', { COACH_REAL_DAILY_UNITS: undefined }],
  ['zero budget', { COACH_REAL_DAILY_UNITS: '0' }],
  ['invalid budget', { COACH_REAL_DAILY_UNITS: '-1' }],
]) test(`C1C zero-call denial: ${name}`, async () => {
  const h = harness(modules, overrides);
  try { const result = await h.call(); assert.notEqual(result.status, 200); assert.equal(await result.text(), ''); assert.equal(count(h), 0); }
  finally { h.close(); }
});

test('C1C invalid profiles, extra input, query and headers cannot select provider or identity', async () => {
  const h = harness();
  try {
    assert.equal((await h.call('unknown')).status, 400);
    for (const extra of [{ model: 'client-model' }, { provider: 'openai' }, { real: true }, { budgetWeight: 0 }, { coordinatorId: 'new' }]) {
      assert.equal((await h.call('economy', extra)).status, 400);
    }
    const disabled = modules.outer.createRealStagingHandler({ ...h.env, COACH_REAL_PROVIDER_ENABLED: 'false' }, { clock: h.clock });
    assert.equal((await disabled(request({ path: '/api/review-coach?real=true' }))).status, 400);
    assert.equal((await disabled(request({ headers: { 'X-Real-Provider': 'true' } }))).status, 503);
    await assert.rejects(h.instance(modules.policy.COORDINATOR_NAME).core.execute({ ...input(), board: [] }));
    assert.equal(count(h), 0);
  } finally { h.close(); }
});

test('C1C storage errors and exhausted budget deny before fetch', async () => {
  const h = harness(modules, { COACH_REAL_DAILY_UNITS: '1' });
  try {
    assert.equal((await h.call()).status, 200);
    assert.notEqual((await h.call()).status, 200);
    const entry = h.instance(modules.policy.COORDINATOR_NAME);
    entry.storage.sql.exec = () => { throw new Error(SENTINEL); };
    assert.notEqual((await h.call()).status, 200);
    assert.equal(count(h), 1);
  } finally { h.close(); }
});

test('C1C UTC buckets and global usage ceiling survive coordinator restart', async () => {
  const h = harness(modules, { COACH_REAL_DAILY_UNITS: '2' });
  try {
    assert.equal((await h.call('balanced')).status, 200);
    h.restart();
    assert.notEqual((await h.call()).status, 200);
    assert.equal(count(h), 1);
    h.state.date += 86400000;
    assert.equal((await h.call()).status, 200);
    assert.deepEqual(h.rows('coach_days').map((r) => [r.day, r.units]), [['2026-09-06', 2], ['2026-09-07', 1]]);
  } finally { h.close(); }
});

test('C1C reservation state machine refuses double finalization and started refunds', () => {
  const storage = sqliteStorage();
  try {
    const budget = modules.budget.createDurableBudget(storage);
    const first = budget.reserve('2026-09-06', 2, 10);
    assert.equal(budget.finalize(first, { attempted: false }), true);
    assert.equal(budget.finalize(first, { attempted: false }), false);
    const second = budget.reserve('2026-09-06', 2, 10);
    assert.equal(budget.acquire(second), true); assert.equal(budget.start(second), true);
    assert.equal(budget.dispatched(second), true);
    assert.equal(budget.cancelBeforeDispatch(second), false);
    assert.equal(budget.finalize(second, { attempted: false }), false);
    assert.equal(budget.terminate(second), true);
    assert.equal(budget.finalize(second, { attempted: false }), false);
    assert.equal(budget.finalize(second, { attempted: true }), true);
    assert.equal(budget.finalize(second, { attempted: true }), false);
    assert.equal(storage.sql.exec('SELECT units FROM coach_days').toArray()[0].units, 2);
  } finally { storage.db.close(); }
});

test('C1C SQLite persistence survives database close/reopen with pending ownership intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coach-c1c-sqlite-'));
  let storage = sqliteStorage(new DatabaseSync(join(directory, 'coordinator.sqlite')));
  try {
    const first = modules.budget.createDurableBudget(storage);
    const id = first.reserve('2026-09-06', 1, 1);
    first.acquire(id); first.start(id); first.dispatched(id);
    storage.db.close();
    storage = sqliteStorage(new DatabaseSync(join(directory, 'coordinator.sqlite')));
    const restarted = modules.budget.createDurableBudget(storage);
    assert.equal(restarted.reserve('2026-09-06', 1, 1), null);
    const nextDay = restarted.reserve('2026-09-07', 1, 1);
    assert.equal(restarted.acquire(nextDay), false);
    assert.equal(restarted.finalize(nextDay, { attempted: false }), true);
    restarted.terminate(id); restarted.finalize(id, { attempted: true });
    assert.deepEqual(storage.sql.exec('SELECT units FROM coach_days ORDER BY day').toArray(), [{ units: 1 }, { units: 0 }]);
  } finally { storage.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('C1C cancellation during dispatch persistence releases the proven unstarted reservation', async () => {
  const h = harness(); const pending = deferred();
  try {
    h.instance(modules.policy.COORDINATOR_NAME).storage.sync = () => pending.promise;
    const first = h.call(); await settle();
    assert.equal(h.rows('coach_reservations')[0].state, 'dispatching');
    await h.clock.advance(3000); await first;
    assert.equal(count(h), 0); assert.equal(h.rows('coach_reservations')[0].finalized, 0);
    pending.resolve(); await settle();
    assert.equal(count(h), 0); assert.equal(used(h), 0);
    assert.equal(h.rows('coach_reservations')[0].state, 'released');
    assert.equal(h.rows('coach_reservations')[0].finalized, 1);
    assert.equal((await h.call()).status, 200);
  } finally { h.close(); }
});

test('C1C coordinator deadline prevents provider start after a stalled rate gate', async () => {
  const pending = deferred();
  const h = harness(modules, { COACH_REAL_RATE_LIMITER: { limit: () => pending.promise } });
  try {
    const core = h.instance(modules.policy.COORDINATOR_NAME).core;
    const first = assert.rejects(core.execute(input())); await settle();
    await h.clock.advance(3000); await first;
    pending.resolve({ success: true }); await settle();
    assert.equal(count(h), 0); assert.equal(h.rows('coach_reservations').length, 0);
  } finally { h.close(); }
});

test('C1C provider failures cannot leak content, budget identifiers or logs', async (t) => {
  const logs = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  const h = harness();
  try {
    h.state.fetch = () => { throw new Error(`${SENTINEL}:budget=999:reservation=private:prompt=private`); };
    const reply = await h.call(); assert.equal(reply.status, 502); assert.equal(await reply.text(), '');
    assert.equal([...reply.headers].some(([, value]) => value.includes(SENTINEL)), false);
    assert.deepEqual(logs, []);
  } finally { h.close(); }
});

test('C1C RPC transport rejects duplicate keys, extra fields, objects and diagnostic text', async () => {
  for (const value of [framing, SENTINEL, 'x'.repeat(1025),
    JSON.stringify({ ...framing, reservationId: SENTINEL }),
    '{"leadIn":"請慢慢看看提示。","leadIn":"請看看提示。","encouragement":"繼續學習。"}']) {
    const h = harness(modules, { COACH_REAL_COORDINATOR: { getByName: () => ({ execute: async () => value }) } });
    try { const reply = await h.call(); assert.equal(reply.status, 502); assert.equal(await reply.text(), ''); assert.equal(count(h), 0); }
    finally { h.close(); }
  }
});

test('C1C caller cancellation cannot release coordinator-owned pending work', async () => {
  const h = harness(); const pending = deferred(); const controller = new AbortController();
  try {
    h.state.fetch = async () => { await pending.promise; return response(); };
    const handle = modules.outer.createRealStagingHandler({ ...h.env }, { clock: h.clock });
    const first = handle(request({ signal: controller.signal })); await settle();
    controller.abort(); assert.equal((await first).status, 504);
    assert.notEqual((await h.call()).status, 200); assert.equal(count(h), 1);
    assert.equal(h.rows('coach_reservations')[0].finalized, 0);
    pending.resolve(); await settle(); h.state.fetch = null;
    assert.equal((await h.call()).status, 200);
    assert.ok(h.rows('coach_reservations').every((r) => r.finalized === 1));
  } finally { h.close(); }
});

for (const mode of ['network', '429', '500', 'malformed', 'parser', 'framing']) {
  test(`C1C started ${mode} failure consumes units once and recovers`, async () => {
    const h = harness();
    try {
      h.state.fetch = () => {
        if (mode === 'network') throw new Error(SENTINEL);
        if (mode === 'malformed') return new Response('{}');
        if (mode === 'parser') return response('{invalid');
        if (mode === 'framing') return response(JSON.stringify({ ...framing, leadIn: '這步將軍。' }));
        return response('{}', Number(mode));
      };
      const failed = await h.call();
      assert.equal(failed.status, 502); assert.equal(await failed.text(), '');
      assert.equal(used(h), 1); assert.equal(count(h), 1);
      h.state.fetch = null;
      assert.equal((await h.call()).status, 200);
      assert.equal(used(h), 2);
      assert.ok(h.rows('coach_reservations').every((r) => r.finalized === 1));
    } finally { h.close(); }
  });
}

export async function overlap(implementation = modules, mode = 'late-success', profiles = ['economy', 'economy']) {
  const h = harness(implementation);
  const pending = deferred();
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on('unhandledRejection', listener);
  try {
    h.state.fetch = async (_url, { signal }) => {
      if (h.state.calls === 1) {
        if (mode === 'cooperative') signal.addEventListener('abort', () => pending.reject(new Error(SENTINEL)), { once: true });
        await pending.promise;
      }
      return response();
    };
    const first = h.call(profiles[0]); await settle();
    await h.clock.advance(3000); await first; await settle();
    const before = { calls: count(h), active: h.state.active, reservations: h.rows('coach_reservations') };
    if (mode === 'restart') h.restart();
    const second = await h.call(profiles[1]);
    const secondFetches = count(h) - before.calls;
    if (mode === 'late-failure') pending.reject(new Error(SENTINEL)); else pending.resolve();
    await settle();
    const third = await h.call();
    return { before, secondStatus: second.status, thirdStatus: third.status, secondFetches,
      maximum: h.state.maximum, calls: count(h), units: used(h), reservations: h.rows('coach_reservations'), unhandled };
  } finally { process.removeListener('unhandledRejection', listener); h.close(); }
}

for (const mode of ['late-success', 'late-failure', 'cooperative', 'restart']) {
  test(`C1C global timeout ownership across independent callers: ${mode}`, async () => {
    const result = await overlap(modules, mode);
    assert.equal(result.maximum, 1); assert.equal(result.thirdStatus, 200);
    assert.deepEqual(result.unhandled, []);
    assert.ok(result.reservations.every((r) => r.finalized === 1));
    if (mode !== 'cooperative') {
      assert.equal(result.before.active, 1);
      assert.equal(result.before.reservations[0].finalized, 0);
      assert.equal(result.before.reservations[0].state, 'started');
      assert.equal(result.secondFetches, 0); assert.notEqual(result.secondStatus, 200);
      assert.equal(result.units, 2);
    }
  });
}

test('C1C pending body cancellation holds persistent slot and budget through UTC rollover', async () => {
  const h = harness(); const drain = deferred(); let cancels = 0;
  try {
    h.state.fetch = () => new Response(new ReadableStream({ cancel() { cancels++; return drain.promise; } }));
    const first = h.call(); await settle(); await h.clock.advance(3000); await first;
    assert.equal(cancels, 1);
    h.state.date += 86400000;
    assert.notEqual((await h.call()).status, 200); assert.equal(count(h), 1);
    assert.equal(h.rows('coach_reservations')[0].finalized, 0);
    drain.resolve(); await settle(); h.state.fetch = null;
    assert.equal((await h.call()).status, 200);
    assert.deepEqual(h.rows('coach_days').map((r) => r.units), [1, 1]);
  } finally { h.close(); }
});

test('C1C indefinite active work stays fenced after new coordinator initialization', async () => {
  const h = harness();
  try {
    h.state.fetch = () => new Promise(() => {});
    const first = h.call(); await settle(); await h.clock.advance(3000); await first;
    h.restart(); h.state.date += 86400000; await h.clock.advance(86400000);
    assert.notEqual((await h.call()).status, 200); assert.equal(count(h), 1);
    assert.equal(h.rows('coach_reservations')[0].finalized, 0);
    assert.notEqual(h.rows('coach_slot')[0].owner, null);
  } finally { h.close(); }
});

const realConfig = JSON.parse(await readFile(new URL('./wrangler.real-prelive.jsonc', import.meta.url), 'utf8'));
const fakeConfig = JSON.parse((await readFile(new URL('./wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));

test('C1C committed config resolves isolated disabled Worker with SQLite migration and no key', async () => {
  assert.equal(realConfig.name, 'chinese-chess-coach-openai-staging');
  assert.equal(realConfig.main, 'prelive/worker.js');
  assert.deepEqual(realConfig.migrations[0].new_sqlite_classes, ['CoachRealProviderCoordinator']);
  assert.equal(realConfig.ratelimits, undefined, 'account-wide namespace number deferred to deployment gate');
  const h = harness(modules, realConfig.vars);
  try { assert.notEqual((await h.call()).status, 200); assert.equal(count(h), 0); }
  finally { h.close(); }
  assert.equal((await fakeWorker.fetch(request(), fakeConfig.env.staging.vars)).status, 200);
});

const callsFor = async (implementation, overrides = {}, extra = {}) => {
  const h = harness(implementation, overrides);
  try { await h.call('economy', extra); return count(h); } finally { h.close(); }
};
const restartBudget = async (implementation) => {
  const h = harness(implementation, { COACH_REAL_DAILY_UNITS: '1' });
  try { await h.call(); h.restart(); await h.call(); return count(h); } finally { h.close(); }
};
const definitions = [
  { name: 'DEFAULT_ENABLED', target: 'policy', before: 'const DEFAULT_ENABLED = false;', after: 'const DEFAULT_ENABLED = true;', expected: 0,
    probe: (m) => callsFor(m, { COACH_REAL_PROVIDER_ENABLED: undefined }) },
  { name: 'CLIENT_ENABLES_PROVIDER', target: 'outer', before: 'return handler;',
    after: "return (request) => { if (request.headers.get('X-Real-Provider') === 'true') env.COACH_REAL_PROVIDER_ENABLED = 'true'; return handler(request); };", expected: 0,
    probe: async (m) => { const h = harness(m, { COACH_REAL_PROVIDER_ENABLED: 'false' }); try {
      // A hostile request header must never change the effective server enable policy.
      const handle = m.outer.createRealStagingHandler(h.env, { clock: h.clock });
      await handle(request({ headers: { 'X-Real-Provider': 'true' } })); return count(h);
    } finally { h.close(); } } },
  { name: 'MISSING_SECRET_FAILS_OPEN', target: 'policy', before: "return typeof key === 'string' && /^[\\x21-\\x7e]{1,512}$/u.test(key) ? key : null;",
    after: "return typeof key === 'string' && /^[\\x21-\\x7e]{1,512}$/u.test(key) ? key : 'MUTANT_SYNTHETIC_ONLY';", expected: 0,
    probe: (m) => callsFor(m, { OPENAI_API_KEY: undefined }) },
  { name: 'MISSING_RATE_FAILS_OPEN', target: 'policy', before: "if (typeof env?.COACH_REAL_RATE_LIMITER?.limit !== 'function') return 'unavailable';",
    after: "if (typeof env?.COACH_REAL_RATE_LIMITER?.limit !== 'function') return 'allowed';", expected: 0,
    probe: (m) => callsFor(m, { COACH_REAL_RATE_LIMITER: undefined }) },
  { name: 'RATE_AS_BUDGET', target: 'coordinator', before: 'reservation = budget.reserve(day, PROFILE_UNITS[input.modelProfile], limit);',
    after: 'reservation = budget.reserve(day, PROFILE_UNITS[input.modelProfile], 999999999);', expected: 1, probe: restartBudget },
  { name: 'CLIENT_COORDINATOR_ID', target: 'outer', before: 'getByName(COORDINATOR_NAME)', after: 'getByName(input.modelProfile)', expected: 1,
    probe: async (m) => (await overlap(m, 'late-success', ['economy', 'balanced'])).maximum },
  { name: 'VOLATILE_BUDGET', target: 'coordinator', before: 'const budget = createDurableBudget(storage);',
    after: 'const durable = createDurableBudget(storage); let used = 0; const budget = { ...durable, reserve(day, units, limit) { if (used + units > limit) return null; used += units; return durable.reserve(day, units, 999999999); } };', expected: 1, probe: restartBudget },
  { name: 'MISSING_BUDGET_FAILS_OPEN', target: 'policy', before: 'if (raw === undefined) return null;', after: 'if (raw === undefined) return 20;', expected: 0,
    probe: (m) => callsFor(m, { COACH_REAL_DAILY_UNITS: undefined }) },
  { name: 'ZERO_BUDGET_FAILS_OPEN', target: 'policy', before: 'if (limit === 0) return null;', after: 'if (limit === 0) return 20;', expected: 0,
    probe: (m) => callsFor(m, { COACH_REAL_DAILY_UNITS: '0' }) },
  { name: 'OUTSIDE_COORDINATOR', target: 'outer', before: 'const payload = await stub.execute(input);', after: 'const payload = JSON.stringify(await env.OUTSIDE_PROVIDER(input));', expected: 0,
    probe: async (m) => { let outside = 0; const h = harness(m, { OUTSIDE_PROVIDER: async () => { outside++; return framing; } });
      try { await h.call(); return outside; } finally { h.close(); } } },
  { name: 'GLOBAL_CONCURRENCY_BYPASS', target: 'budget', before: 'WHERE singleton = 1 AND owner IS NULL RETURNING owner',
    after: 'WHERE singleton = 1 RETURNING owner', expected: 1, probe: async (m) => (await overlap(m)).maximum },
  { name: 'PROVIDER_BEFORE_RESERVATION', target: 'coordinator', before: 'reservation = budget.reserve(day, PROFILE_UNITS[input.modelProfile], limit);',
    after: "await fetchImpl('https://api.openai.com/v1/responses', { signal: new AbortController().signal, body: '{}' }); reservation = budget.reserve(day, PROFILE_UNITS[input.modelProfile], limit);", expected: 0,
    probe: async (m) => { const h = harness(m); let early = 0; try {
      h.state.fetch = () => { if (h.rows('coach_reservations').length === 0) early++; return response(); };
      await h.call(); return early;
    } finally { h.close(); } } },
  { name: 'REFUND_STARTED_TIMEOUT', target: 'budget', before: 'if (!started) sql.exec', after: 'if (true) sql.exec', expected: 2,
    probe: async (m) => (await overlap(m)).units },
  { name: 'DOUBLE_FINALIZATION', target: 'budget', before: 'if (!reservation || reservation.finalized !== 0) return false;',
    after: 'if (!reservation) return false;', expected: false,
    probe: async (m) => { const s = sqliteStorage(); try { const b = m.budget.createDurableBudget(s);
      const id = b.reserve('2026-09-06', 1, 2); b.acquire(id); b.start(id); b.terminate(id); b.finalize(id, { attempted: true });
      return b.finalize(id, { attempted: true }); } finally { s.db.close(); } } },
  { name: 'AUTOMATIC_RETRY', target: 'coordinator', before: 'return fetchImpl(url, options);',
    after: 'try { return await fetchImpl(url, options); } catch { return fetchImpl(url, options); }', expected: 1,
    probe: async (m) => { const h = harness(m); try { h.state.fetch = () => { throw new Error(SENTINEL); }; await h.call(); return count(h); } finally { h.close(); } } },
];

const brokenOutcomes = {
  DEFAULT_ENABLED: 1, CLIENT_ENABLES_PROVIDER: 1, MISSING_SECRET_FAILS_OPEN: 1,
  MISSING_RATE_FAILS_OPEN: 1, RATE_AS_BUDGET: 2, CLIENT_COORDINATOR_ID: 2,
  VOLATILE_BUDGET: 2, MISSING_BUDGET_FAILS_OPEN: 1, ZERO_BUDGET_FAILS_OPEN: 1,
  OUTSIDE_COORDINATOR: 1, GLOBAL_CONCURRENCY_BYPASS: 2, PROVIDER_BEFORE_RESERVATION: 1,
  REFUND_STARTED_TIMEOUT: 0, DOUBLE_FINALIZATION: true, AUTOMATIC_RETRY: 2,
};
for (const definition of definitions) for (const eol of ['\n', '\r\n']) {
  test(`C1C mutation ${definition.name} ${eol === '\n' ? 'LF' : 'CRLF'}`, async () => {
    const invariant = (actual) => assert.deepEqual(actual, definition.expected);
    invariant(await definition.probe(modules));
    const mutated = await variant(definition.target, definition.before, definition.after, eol);
    const actual = await definition.probe(mutated);
    assert.deepEqual(actual, brokenOutcomes[definition.name], 'the exact intended broken behavior executed');
    assert.notDeepEqual(actual, definition.expected);
    assert.throws(() => invariant(actual), { code: 'ERR_ASSERTION', name: 'AssertionError' });
  });
}

for (const eol of ['\n', '\r\n']) for (const name of ['FAKE_STAGING_OVERWRITTEN', 'COMMITTED_ENABLED', 'SECRET_IN_VARS']) {
  test(`C1C config mutation ${name} ${eol === '\n' ? 'LF' : 'CRLF'}`, async () => {
    const before = structuredClone(name === 'FAKE_STAGING_OVERWRITTEN' ? fakeConfig : realConfig);
    const after = structuredClone(before);
    if (name === 'FAKE_STAGING_OVERWRITTEN') after.main = 'prelive/worker.js';
    if (name === 'COMMITTED_ENABLED') after.vars.COACH_REAL_PROVIDER_ENABLED = 'true';
    if (name === 'SECRET_IN_VARS') after.vars.OPENAI_API_KEY = SENTINEL;
    const probe = async (config) => {
      if (name === 'FAKE_STAGING_OVERWRITTEN') {
        const worker = config.main === 'src/index.js' ? fakeWorker : (await import('./prelive/outer.js')).default;
        return (await worker.fetch(request(), config.env.staging.vars)).status;
      }
      // Execute effective bindings from parsed deployment config; vary only the
      // policy under test, supply every other dependency explicitly in the fixture.
      const overrides = name === 'COMMITTED_ENABLED'
        ? { COACH_REAL_PROVIDER_ENABLED: config.vars.COACH_REAL_PROVIDER_ENABLED }
        : { OPENAI_API_KEY: config.vars.OPENAI_API_KEY };
      return callsFor(modules, overrides);
    };
    const baseline = await probe(before);
    const parsed = JSON.parse(JSON.stringify(after, null, 2).replace(/\n/g, eol));
    const actual = await probe(parsed);
    assert.equal(baseline, name === 'FAKE_STAGING_OVERWRITTEN' ? 200 : 0);
    assert.equal(actual, name === 'FAKE_STAGING_OVERWRITTEN' ? 503 : 1, 'the exact broken deployment behavior executed');
    assert.notEqual(actual, baseline);
    assert.throws(() => assert.equal(actual, baseline), { code: 'ERR_ASSERTION', name: 'AssertionError' });
  });
}

assert.equal(definitions.length + 3, 18);
