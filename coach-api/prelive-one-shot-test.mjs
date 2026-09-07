import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from './test-support.mjs';
import { modules, sqliteStorage, response, input, request, payload, harness, deferred, flush, variant } from './prelive-test-support.mjs';
import * as operator from './prelive/operator-dispatch.js';

const implementation = { ...modules, 'operator-dispatch': operator };
const settle = async () => { await flush(); await new Promise(resolve => setImmediate(resolve)); };
const approve = async () => true; // SYNTHETIC TEST AUTHORITY, not live authentication.
function fixture(m = implementation, { authority = approve, env: overrides = {}, storage = sqliteStorage() } = {}) {
  const clock = new FakeClock();
  const state = { calls: 0, requests: [], fetch: null };
  const env = { COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_DAILY_UNITS: '20',
    OPENAI_API_KEY: 'C1E_SYNTHETIC_ONLY', COACH_REAL_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...overrides };
  const options = { clock, operatorAuthority: authority, utcNow: () => Date.UTC(2026, 8, 6),
    fetch: async (url, options) => {
      state.calls++; state.requests.push(JSON.parse(options.body));
      return state.fetch ? state.fetch(url, options) : response();
    } };
  let core = m.coordinator.createCoordinator(storage, env, options);
  return { storage, clock, env, state, get core() { return core; }, get op() { return core.operator; },
    row: () => storage.sql.exec('SELECT * FROM coach_one_shot').toArray()[0],
    set: value => storage.sql.exec('UPDATE coach_one_shot SET state = ?', value),
    restart() { core = m.coordinator.createCoordinator(storage, env, options); },
    close() { storage.db.close(); } };
}

test('C1E default DISARMED, explicit arming has zero calls; fixed economy E2E and bounded result', async () => {
  const h = fixture();
  try {
    assert.equal(h.row().state, 'DISARMED');
    assert.deepEqual(await h.op.dispatch(), { status: 'denied' });
    assert.deepEqual(await h.op.arm(), { status: 'armed' }); assert.equal(h.state.calls, 0);
    h.state.fetch = () => { assert.equal(h.row().state, 'CONSUMED'); return response(); };
    assert.deepEqual(await h.op.dispatch(), { status: 'completed', consumed: true });
    assert.equal(h.state.calls, 1); assert.equal(h.row().state, 'CONSUMED');
    const sent = h.state.requests[0];
    assert.equal(sent.model, 'gpt-5.6-luna'); assert.equal(sent.input, input().purpose);
    assert.equal(sent.store, false); assert.equal(sent.max_output_tokens, 128);
    assert.deepEqual(sent.reasoning, { effort: 'none' }); assert.equal(sent.tools, undefined);
    assert.deepEqual(await h.op.arm(), { status: 'denied' });
    assert.deepEqual(await h.op.dispatch(), { status: 'denied' }); assert.equal(h.state.calls, 1);
  } finally { h.close(); }
});

for (const [label, authority] of [['missing', null], ['false', () => false], ['throws', () => { throw Error('PRIVATE'); }],
  ['object', () => ({ approved: true })], ['string', () => 'true'], ['number', () => 1]]) {
  test(`C1E operator authorization denies ${label}`, async () => {
    const h = fixture(implementation, { authority });
    try { assert.deepEqual(await h.op.arm(), { status: 'denied' }); h.set('ARMED');
      assert.deepEqual(await h.op.dispatch(), { status: 'denied' }); assert.equal(h.state.calls, 0); }
    finally { h.close(); }
  });
}
for (const value of [{ operator: true }, { dispatchId: 'other' }, { modelProfile: 'quality' }, { prompt: 'private' },
  { headers: { 'X-Admin-Key': 'test' } }, { board: [] }, undefined]) {
  test(`C1E supplied arguments confer no arm/dispatch authority: ${JSON.stringify(value)}`, async () => {
    const h = fixture();
    try { assert.deepEqual(await h.op.arm(value), { status: 'denied' }); await h.op.arm();
      assert.deepEqual(await h.op.dispatch(value), { status: 'denied' }); assert.equal(h.state.calls, 0); }
    finally { h.close(); }
  });
}

for (const state of ['DISARMED', 'CONSUMED', 'unknown', null]) test(`C1E state denial ${state}`, async () => {
  const h = fixture();
  try { if (state === null) h.storage.sql.exec('DELETE FROM coach_one_shot'); else h.set(state);
    h.restart(); assert.deepEqual(await h.op.dispatch(), { status: 'denied' });
    assert.equal(h.state.calls, 0); if (state === null) assert.equal(h.row(), undefined);
  } finally { h.close(); }
});

for (const [label, env] of [['disabled', { COACH_REAL_PROVIDER_ENABLED: 'false' }], ['secret', { OPENAI_API_KEY: undefined }],
  ['budget missing', { COACH_REAL_DAILY_UNITS: undefined }], ['budget zero', { COACH_REAL_DAILY_UNITS: '0' }],
  ['rate absent', { COACH_REAL_RATE_LIMITER: undefined }], ['rate denied', { COACH_REAL_RATE_LIMITER: { limit: async () => ({ success: false }) } }]]) {
  test(`C1E armed does not bypass ${label}`, async () => {
    const h = fixture(implementation, { env });
    try { await h.op.arm(); assert.deepEqual(await h.op.dispatch(), { status: 'failed', consumed: true });
      assert.equal(h.state.calls, 0); assert.equal(h.row().state, 'CONSUMED'); }
    finally { h.close(); }
  });
}

test('C1E exhausted budget, occupied slot and recovery dominate one-shot', async () => {
  for (const kind of ['budget', 'concurrency', 'recovery']) {
    const h = fixture();
    try {
      if (kind === 'budget') h.storage.sql.exec("INSERT INTO coach_days (day, units) VALUES ('2026-09-06', 20)");
      else h.storage.sql.exec('UPDATE coach_slot SET owner = 999');
      if (kind === 'recovery') h.restart();
      await h.op.arm(); await h.op.dispatch(); assert.equal(h.state.calls, 0);
      assert.equal(h.row().state, 'CONSUMED');
    } finally { h.close(); }
  }
});

test('C1E missing internal coordinator and failed durability barrier never start provider', async () => {
  const h = fixture();
  try {
    const op = operator.createOperatorDispatch(h.storage, { authorize: approve });
    await op.arm(); assert.deepEqual(await op.dispatch(), { status: 'denied' });
    h.storage.sync = async () => { throw Error('PRIVATE'); };
    assert.deepEqual(await h.op.dispatch(), { status: 'failed', consumed: true });
    assert.equal(h.state.calls, 0); assert.equal(h.row().state, 'CONSUMED');
  } finally { h.close(); }
});

async function race(m = implementation) {
  const h = fixture(m); const done = deferred();
  try {
    // Independent dispatch objects share only SQLite authority. The second sync
    // is adversarial scheduling, NOT a lock authorizing healthy consumption.
    // A broken read/await/write claim can run after A drains, exposing TWO starts
    // while the independent C1C concurrency=1 invariant remains intact.
    const secondStorage = { ...h.storage, sync: () => done.promise };
    const second = m['operator-dispatch'].createOperatorDispatch(secondStorage,
      { authorize: approve, execute: value => h.core.execute(value) });
    await h.op.arm();
    const a = h.op.dispatch().finally(() => done.resolve());
    const b = second.dispatch();
    const results = await Promise.all([a, b]);
    return { calls: h.state.calls, consumptions: results.filter(x => x.consumed).length };
  } finally { done.resolve(); h.close(); }
}
test('C1E independent concurrent dispatches atomically consume once', async () => {
  assert.deepEqual(await race(), { calls: 1, consumptions: 1 });
});

async function failure(m = implementation, kind = 'network') {
  const h = fixture(m); const pending = deferred();
  try {
    h.state.fetch = kind === 'timeout' ? async () => { await pending.promise; return response(); } : () => { throw Error('PRIVATE'); };
    await h.op.arm(); const first = h.op.dispatch(); await settle();
    if (kind === 'timeout') await h.clock.advance(3000);
    await first;
    // Settle the ORIGINAL mocked provider drain before isolating illegal rearm.
    // Clearing only the owner would now create a correctly fenced orphan.
    if (kind === 'timeout') {
      pending.resolve(); await settle();
      assert.equal(h.storage.sql.exec('SELECT owner FROM coach_slot').toArray()[0].owner, null);
      assert.equal(h.storage.sql.exec('SELECT finalized FROM coach_reservations').toArray()[0].finalized, 1);
    }
    h.state.fetch = () => response(); await h.op.dispatch();
    return h.state.calls;
  } finally { pending.resolve(); await settle(); h.close(); }
}
for (const kind of ['network', 'timeout']) test(`C1E ${kind} never rearms or retries`, async () => {
  assert.equal(await failure(implementation, kind), 1);
});
for (const [label, fetch] of [['429', () => response('', 429)], ['500', () => response('', 500)],
  ['cancellation', () => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('mock abort', 'AbortError')); } }))],
  ['parser', () => new Response('not json')], ['validator', () => response(JSON.stringify({ leadIn: 'private forbidden', encouragement: '' }))]]) {
  test(`C1E ${label} failure stays consumed and redacted`, async () => {
    const h = fixture();
    try { h.state.fetch = fetch; await h.op.arm(); assert.deepEqual(await h.op.dispatch(), { status: 'failed', consumed: true });
      await h.op.dispatch(); assert.equal(h.state.calls, 1); assert.equal(h.row().state, 'CONSUMED'); }
    finally { h.close(); }
  });
}

test('C1E lost continuation survives reconstruction consumed and fenced without refund', async () => {
  const h = fixture();
  try {
    h.state.fetch = () => new Promise(() => {}); await h.op.arm();
    const first = h.op.dispatch(); await settle(); await h.clock.advance(3000); await first;
    h.restart(); await h.op.arm(); await h.op.dispatch();
    assert.equal(h.state.calls, 1); assert.equal(h.row().state, 'CONSUMED');
    assert.equal(h.storage.sql.exec('SELECT state FROM coach_recovery').toArray()[0].state, 'ACTIVE_PROVIDER');
    assert.equal(modules.budget.createDurableBudget(h.storage).inspectRecovery().state, 'RECOVERY_REQUIRED');
    assert.equal(h.storage.sql.exec('SELECT units FROM coach_days').toArray()[0].units, 1);
  } finally { h.close(); }
});

test('C1E consumed state survives actual SQLite close/reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coach-c1e-'));
  let h = fixture(implementation, { storage: sqliteStorage(new DatabaseSync(join(directory, 'state.sqlite'))) });
  try {
    await h.op.arm(); h.close();
    h = fixture(implementation, { storage: sqliteStorage(new DatabaseSync(join(directory, 'state.sqlite'))) });
    assert.equal(h.row().state, 'ARMED'); await h.op.dispatch(); h.close();
    h = fixture(implementation, { storage: sqliteStorage(new DatabaseSync(join(directory, 'state.sqlite'))) });
    assert.equal(h.row().state, 'CONSUMED'); await h.op.arm(); await h.op.dispatch(); assert.equal(h.state.calls, 0);
  } finally { h.close(); rmSync(directory, { recursive: true, force: true }); }
});

async function publicProbe(m = implementation, options = {}) {
  const h = harness(m, { COACH_REAL_PROVIDER_PUBLIC_ENABLED: undefined });
  try {
    const handle = m.outer.createRealStagingHandler(h.env, { clock: h.clock });
    const result = await handle(request(options));
    return { calls: h.state.calls, status: result.status, text: await result.text() };
  } finally { h.close(); }
}
test('C1E public path stays disabled with all other gates approving', async () => {
  assert.deepEqual(await publicProbe(), { calls: 0, status: 503, text: '' });
});
test('C1E public authority absent, false and malformed values fail closed', async () => {
  for (const value of [undefined, 'false', true, false, 1, 'TRUE', ' true', {}, null]) {
    const h = harness(implementation, { COACH_REAL_PROVIDER_PUBLIC_ENABLED: value });
    try { const r = await h.call(); assert.equal(r.status, 503); assert.equal(await r.text(), ''); assert.equal(h.state.calls, 0); }
    finally { h.close(); }
  }
});
for (const options of [{ headers: { 'X-Admin-Key': 'test' } }, { headers: { COACH_REAL_PROVIDER_PUBLIC_ENABLED: 'true' } },
  { path: '/api/review-coach?COACH_REAL_PROVIDER_PUBLIC_ENABLED=true' },
  { data: { operator: true, COACH_REAL_PROVIDER_PUBLIC_ENABLED: 'true' } }, { path: '/api/first-live' }, { path: '/api/admin/dispatch' }]) {
  test(`C1E client cannot enable public path ${JSON.stringify(options)}`, async () => {
    const r = await publicProbe(implementation, options); assert.equal(r.calls, 0); assert.notEqual(r.status, 200); assert.equal(r.text, '');
  });
}

// Every mutation below is executable source replacement, not static inspection.
// Baseline probe runs first; broken observation is required before the intended
// assertion is required to throw ERR_ASSERTION. Import/setup errors fail the test.
const opTarget = 'operator-dispatch';
const claim = `const consume = () => sql.exec("UPDATE coach_one_shot SET state = 'CONSUMED' WHERE id = ? AND state = 'ARMED' RETURNING id", DISPATCH_ID).toArray().length === 1;`;
async function dispatchCount(m, env = {}, setup = () => {}) {
  const h = fixture(m, { env });
  try { setup(h); await h.op.arm(); await h.op.dispatch(); return h.state.calls; } finally { h.close(); }
}
async function publicOperator(m, header = false) {
  const h = fixture(m);
  try {
    const env = { ...h.env, TEST_ONLY_OPERATOR: h.op };
    const handler = m.outer.createRealStagingHandler(env, { clock: h.clock });
    await handler(request(header ? { headers: { 'X-Admin-Key': 'synthetic' } } : {}));
    return h.state.calls;
  } finally { h.close(); }
}
async function late(m) {
  const h = fixture(m); const pending = deferred();
  try {
    h.state.fetch = async () => { await pending.promise; return response(); };
    await h.op.arm(); const a = h.op.dispatch(); await settle();
    // Hostile local-only fixture of future generation state, NOT a rearm API.
    h.set('DISARMED'); pending.resolve(); await a; await settle();
    return h.row().state;
  } finally { pending.resolve(); h.close(); }
}
const gates = [
  ['default armed', opTarget, 'const sql = storage.sql;', `const sql = storage.sql; sql.exec("UPDATE coach_one_shot SET state = 'ARMED' WHERE state = 'DISARMED'");`, async m => { const h = fixture(m); try { await h.op.dispatch(); return h.state.calls; } finally { h.close(); } }, 0, 1],
  ['client arms', opTarget, "args.length === 0 && typeof authorize", "typeof authorize", async m => { const h = fixture(m); try { await h.op.arm({ operator: true }); return h.row().state; } finally { h.close(); } }, 'DISARMED', 'ARMED'],
  ['client identity', opTarget, ['const DISPATCH_ID =', "args.length === 0 && typeof authorize", 'if (!await consume()) return denied();', ' && storageValid(storage)'], ['let DISPATCH_ID =', 'typeof authorize', "DISPATCH_ID = args[0]?.dispatchId ?? DISPATCH_ID; if (!await consume()) return denied();", ''], async m => { const h = fixture(m); try { h.storage.sql.exec("INSERT INTO coach_one_shot (id, state) VALUES ('client', 'ARMED')"); await h.op.dispatch({ dispatchId: 'client' }); return h.storage.sql.exec("SELECT state FROM coach_one_shot WHERE id = 'client'").toArray()[0].state; } finally { h.close(); } }, 'ARMED', 'CONSUMED'],
  ['client quality', opTarget, ["args.length === 0 && typeof authorize", 'await execute(INPUT);'], ['typeof authorize', 'await execute({ ...INPUT, modelProfile: args[0]?.modelProfile ?? INPUT.modelProfile });'], async m => { const h = fixture(m); try { await h.op.arm(); await h.op.dispatch({ modelProfile: 'quality' }); return h.state.requests[0]?.model ?? null; } finally { h.close(); } }, null, 'gpt-5.6-sol'],
  ['operator prompt', opTarget, ["args.length === 0 && typeof authorize", 'await execute(INPUT);'], ['typeof authorize', 'await execute({ ...INPUT, purpose: args[0]?.prompt ?? INPUT.purpose });'], async m => { const h = fixture(m); let observed = null; try { const op = m['operator-dispatch'].createOperatorDispatch(h.storage, { authorize: approve, execute: value => { observed = value.purpose; return h.core.execute(value); } }); await op.arm(); await op.dispatch({ prompt: 'arbitrary' }); return observed; } finally { h.close(); } }, null, 'arbitrary'],
  ['before consumption', opTarget, 'if (!await consume()) return denied();', 'await execute(INPUT); if (!await consume()) return denied();', async m => { const h = fixture(m); let early = 0; try { h.state.fetch = () => { if (h.row().state !== 'CONSUMED') early++; return response(); }; await h.op.arm(); await h.op.dispatch(); return early; } finally { h.close(); } }, 0, 1],
  ['non-atomic', opTarget, claim, `const consume = async () => { const armed = sql.exec('SELECT state FROM coach_one_shot WHERE id = ?', DISPATCH_ID).toArray()[0]?.state === 'ARMED'; await Promise.resolve(); if (!armed) return false; sql.exec("UPDATE coach_one_shot SET state = 'CONSUMED' WHERE id = ?", DISPATCH_ID); return true; };`, async m => (await race(m)).calls, 1, 2],
  ['failure rearm', opTarget, 'return consumed ? Object.freeze', `sql.exec("UPDATE coach_one_shot SET state = 'ARMED'"); return consumed ? Object.freeze`, m => failure(m), 1, 2],
  ['timeout rearm', opTarget, 'return consumed ? Object.freeze', `sql.exec("UPDATE coach_one_shot SET state = 'ARMED'"); return consumed ? Object.freeze`, m => failure(m, 'timeout'), 1, 2],
  ['consumed second call', opTarget, "AND state = 'ARMED' RETURNING id", "AND state IN ('ARMED', 'CONSUMED') RETURNING id", async m => { const h = fixture(m); try { await h.op.arm(); await h.op.dispatch(); await h.op.dispatch(); return h.state.calls; } finally { h.close(); } }, 1, 2],
  ['retry', opTarget, 'await execute(INPUT);', 'try { await execute(INPUT); } catch { await execute(INPUT); }', async m => { const h = fixture(m); try { h.state.fetch = () => { throw Error('mock'); }; await h.op.arm(); await h.op.dispatch(); return h.state.calls; } finally { h.close(); } }, 1, 2],
  ['success promotion', 'coordinator', 'authorize: operatorAuthority, execute', "authorize: operatorAuthority, execute: async value => { const result = await execute(value); env.COACH_REAL_PROVIDER_PUBLIC_ENABLED = 'true'; return result; }", async m => { const h = fixture(m); try { await h.op.arm(); await h.op.dispatch(); return h.env.COACH_REAL_PROVIDER_PUBLIC_ENABLED ?? null; } finally { h.close(); } }, null, 'true'],
  ['stale completion rearms', opTarget, "return Object.freeze({ status: 'completed', consumed: true });", `sql.exec("UPDATE coach_one_shot SET state = 'ARMED'"); return Object.freeze({ status: 'completed', consumed: true });`, late, 'DISARMED', 'ARMED'],
  ['secret bypass', 'policy', 'const key = env?.OPENAI_API_KEY;', "const key = env?.OPENAI_API_KEY ?? 'MUTANT_SYNTHETIC';", m => dispatchCount(m, { OPENAI_API_KEY: undefined }), 0, 1],
  ['budget bypass', 'budget', 'if (used + units > limit) return null;', 'if (false) return null;', m => dispatchCount(m, {}, h => {
    h.storage.sql.exec("INSERT INTO coach_days (day, units) VALUES ('2026-09-06', 20)");
    h.storage.sql.exec("INSERT INTO coach_reservations (day, units, state, terminated, finalized) VALUES ('2026-09-06', 20, 'consumed', 1, 1)");
  }), 0, 1],
  ['rate bypass', 'policy', "if (typeof env?.COACH_REAL_RATE_LIMITER?.limit !== 'function') return 'unavailable';", "if (typeof env?.COACH_REAL_RATE_LIMITER?.limit !== 'function') return 'allowed';", m => dispatchCount(m, { COACH_REAL_RATE_LIMITER: undefined }), 0, 1],
  ['recovery bypass', 'budget', "if (this.inspectRecovery().state === 'RECOVERY_REQUIRED') return false;", 'if (false) return false;', m => dispatchCount(m, {}, h => h.storage.sql.exec("UPDATE coach_recovery SET state = 'RECOVERY_REQUIRED'")), 0, 1],
  ['global coordinator bypass', 'coordinator', 'authorize: operatorAuthority, execute', "authorize: operatorAuthority, execute: async () => fetchImpl('https://api.openai.com/v1/responses', { body: '{}' })", m => dispatchCount(m, { COACH_REAL_DAILY_UNITS: '0' }), 0, 1],
  ['public API invokes one-shot', 'outer', 'return handler;', 'return async request => { await env.TEST_ONLY_OPERATOR.arm(); await env.TEST_ONLY_OPERATOR.dispatch(); return handler(request); };', m => publicOperator(m), 0, 1],
  ['static public admin header', 'outer', 'return handler;', "return async request => { if (request.headers.get('X-Admin-Key') === 'synthetic') { await env.TEST_ONLY_OPERATOR.arm(); await env.TEST_ONLY_OPERATOR.dispatch(); } return handler(request); };", m => publicOperator(m, true), 0, 1],
  ['public defaults open', 'policy', "return env?.COACH_REAL_PROVIDER_PUBLIC_ENABLED === 'true';", 'return true;', async m => (await publicProbe(m)).calls, 0, 1],
  ['provider enable implies public', 'policy', "return env?.COACH_REAL_PROVIDER_PUBLIC_ENABLED === 'true';", "return env?.COACH_REAL_PROVIDER_ENABLED === 'true';", async m => (await publicProbe(m)).calls, 0, 1],
  ['secret implies public', 'policy', "return env?.COACH_REAL_PROVIDER_PUBLIC_ENABLED === 'true';", 'return providerSecret(env) !== null;', async m => (await publicProbe(m)).calls, 0, 1],
  ['budget implies public', 'policy', "return env?.COACH_REAL_PROVIDER_PUBLIC_ENABLED === 'true';", 'return dailyLimit(env) !== null;', async m => (await publicProbe(m)).calls, 0, 1],
  ['client header enables public', 'outer', 'return handler;', "return request => { if (request.headers.get('X-Public-Enable') === 'true') env.COACH_REAL_PROVIDER_PUBLIC_ENABLED = 'true'; return handler(request); };", async m => (await publicProbe(m, { headers: { 'X-Public-Enable': 'true' } })).calls, 0, 1],
  ['client query enables public', 'outer', 'return handler;', "return request => { const url = new URL(request.url); if (url.searchParams.get('enable') === 'true') { env.COACH_REAL_PROVIDER_PUBLIC_ENABLED = 'true'; url.search = ''; request = new Request(url, request); } return handler(request); };", async m => (await publicProbe(m, { path: '/api/review-coach?enable=true' })).calls, 0, 1],
  ['client body enables public', 'outer', 'return handler;', "return async request => { const body = await request.clone().json(); if (body.publicEnable === true) { env.COACH_REAL_PROVIDER_PUBLIC_ENABLED = 'true'; delete body.publicEnable; request = new Request(request, { body: JSON.stringify(body) }); } return handler(request); };", async m => (await publicProbe(m, { data: payload({ publicEnable: true }) })).calls, 0, 1],
  ['missing authority bypass', opTarget, "args.length === 0 && typeof authorize === 'function' && await authorize(action) === true", 'true', async m => { const h = fixture(m, { authority: null }); try { await h.op.arm(); await h.op.dispatch(); return h.state.calls; } finally { h.close(); } }, 0, 1],
];
for (const [label, target, before, after, probe, healthy, broken] of gates) for (const eol of ['\n', '\r\n']) {
  test(`C1E viable mutation ${label} ${eol.length === 1 ? 'LF' : 'CRLF'}`, async () => {
    assert.deepEqual(await probe(implementation), healthy);
    const m = await variant(target, before, after, eol);
    const actual = await probe(m); assert.deepEqual(actual, broken, 'intended broken path executed');
    assert.throws(() => assert.deepEqual(actual, healthy), { code: 'ERR_ASSERTION' });
  });
}
