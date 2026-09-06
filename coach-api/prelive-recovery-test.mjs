import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, modules, sqliteStorage, deferred, flush, response, request, input, variant } from './prelive-test-support.mjs';

const settle = async () => { await flush(); await new Promise((resolve) => setImmediate(resolve)); };
const name = modules.policy.COORDINATOR_NAME;
const recovery = (h) => h.rows('coach_recovery')[0];

async function reconstructed(m = modules, observation = {}) {
  const h = harness(m); const pending = deferred();
  try {
    h.state.fetch = async () => { if (h.state.calls === 1) await pending.promise; return response(); };
    const first = h.call(); await settle(); await h.clock.advance(3000); await first;
    h.restart();
    const storage = h.instance(name).storage;
    const b = m.budget.createDurableBudget(storage);
    const before = b.inspectRecovery();
    b.inspectRecovery(observation);
    h.state.date += 86400000; await h.clock.advance(86400000);
    await h.call();
    const result = { before, calls: h.state.calls, maximum: h.state.maximum,
      owner: h.rows('coach_slot')[0].owner, units: h.rows('coach_days').reduce((sum, r) => sum + r.units, 0) };
    pending.resolve(); await settle();
    result.afterDrain = b.inspectRecovery();
    result.reservations = h.rows('coach_reservations');
    return result;
  } finally { pending.resolve(); await settle(); h.close(); }
}

test('C1D idle reconstruction stays NORMAL and state survives actual SQLite reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coach-c1d-recovery-'));
  let s = sqliteStorage(new DatabaseSync(join(directory, 'state.sqlite')));
  try {
    let b = modules.budget.createDurableBudget(s);
    assert.deepEqual(b.inspectRecovery(), { state: 'NORMAL', owner: null });
    b = modules.budget.createDurableBudget(s);
    assert.deepEqual(b.inspectRecovery(), { state: 'NORMAL', owner: null });
    const id = b.reserve('2026-09-06', 1, 2); b.acquire(id); b.start(id); b.dispatched(id);
    assert.deepEqual(b.inspectRecovery(), { state: 'ACTIVE_PROVIDER', owner: id });
    s.db.close(); s = sqliteStorage(new DatabaseSync(join(directory, 'state.sqlite')));
    b = modules.budget.createDurableBudget(s);
    assert.deepEqual(b.inspectRecovery(), { state: 'RECOVERY_REQUIRED', owner: id });
    assert.equal(b.acquire(b.reserve('2026-09-07', 1, 2)), false);
    assert.equal(b.finalize(id, { attempted: false }), false);
    assert.equal(s.sql.exec('SELECT units FROM coach_days WHERE day = ?', '2026-09-06').toArray()[0].units, 1);
  } finally { s.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const observation of [{}, { ageMs: 864000000 }, { alarm: true }, { restart: true, aborted: true, proof: true }]) {
  test(`C1D unresolved reconstruction remains fenced: ${JSON.stringify(observation)}`, async () => {
    const r = await reconstructed(modules, observation);
    assert.equal(r.before.state, 'RECOVERY_REQUIRED');
    assert.equal(r.owner, r.before.owner); assert.equal(r.calls, 1); assert.equal(r.maximum, 1);
    assert.equal(r.units, 1);
    // Not lost-continuation recovery: the ORIGINAL trusted drain still exists.
    assert.deepEqual(r.afterDrain, { state: 'NORMAL', owner: null });
    assert.ok(r.reservations.every((row) => row.finalized === 1));
  });
}

test('C1D genuinely lost continuation never clears or refunds across repeated reconstruction', async () => {
  const h = harness();
  try {
    h.state.fetch = () => new Promise(() => {});
    const first = h.call(); await settle(); await h.clock.advance(3000); await first;
    for (let i = 0; i < 3; i++) {
      h.restart(); h.state.date += 86400000; await h.call();
      assert.equal(recovery(h).state, 'RECOVERY_REQUIRED');
      assert.equal(h.state.calls, 1); assert.equal(h.rows('coach_reservations')[0].finalized, 0);
      assert.equal(h.rows('coach_days')[0].units, 1);
    }
  } finally { h.close(); }
});

// Hostile *local fixture only*: model a future newer generation without claiming
// that replacement itself is authorized recovery or that external A terminated.
function lateGeneration(m = modules) {
  const s = sqliteStorage();
  try {
    const a = m.budget.createDurableBudget(s);
    const old = a.reserve('2026-09-06', 1, 10); a.acquire(old); a.start(old); a.dispatched(old);
    const current = m.budget.createDurableBudget(s);
    const next = current.reserve('2026-09-06', 2, 10);
    s.sql.exec('UPDATE coach_slot SET owner = ? WHERE singleton = 1', next);
    s.sql.exec("UPDATE coach_recovery SET state = 'RECOVERY_REQUIRED', owner = ? WHERE singleton = 1", next);
    const before = s.sql.exec('SELECT * FROM coach_reservations WHERE id = ?', next).toArray();
    a.terminate(old); a.finalize(old, { attempted: true });
    const result = { owner: s.sql.exec('SELECT owner FROM coach_slot').toArray()[0].owner,
      expected: next, recovery: current.inspectRecovery(), before,
      after: s.sql.exec('SELECT * FROM coach_reservations WHERE id = ?', next).toArray(),
      units: s.sql.exec('SELECT units FROM coach_days').toArray()[0].units };
    a.terminate(old); a.finalize(old, { attempted: true });
    assert.deepEqual(s.sql.exec('SELECT * FROM coach_reservations WHERE id = ?', next).toArray(), result.after);
    return result;
  } finally { s.db.close(); }
}

test('C1D obsolete operation cannot clear newer ownership, settle newer units, or change its incident', () => {
  const r = lateGeneration();
  assert.equal(r.owner, r.expected);
  assert.deepEqual(r.recovery, { state: 'RECOVERY_REQUIRED', owner: r.expected });
  assert.deepEqual(r.after, r.before); assert.equal(r.units, 3);
});

async function clientRecovery(m = modules) {
  let invoked = 0;
  const h = harness(m, { RECOVERY_ADMIN: () => { invoked++; } });
  try {
    const handle = m.outer.createRealStagingHandler(h.env, { clock: h.clock });
    const reply = await handle(request({ path: '/api/recover' }));
    return { invoked, status: reply.status, calls: h.state.calls };
  } finally { h.close(); }
}

test('C1D HTTP and RPC cannot accept recovery, generation or proof authority', async () => {
  assert.deepEqual(await clientRecovery(), { invoked: 0, status: 404, calls: 0 });
  const h = harness();
  try {
    for (const field of ['recovery', 'generation', 'terminationProof']) {
      assert.equal((await h.call('economy', { [field]: 99 })).status, 400);
      await assert.rejects(h.instance(name).core.execute({ ...input(), [field]: 99 }));
    }
    const handle = modules.outer.createRealStagingHandler(h.env, { clock: h.clock });
    assert.equal((await handle(request({ path: '/api/review-coach?recover=true' }))).status, 400);
    assert.equal(h.state.calls, 0);
    // An unknown header does not change server-owned IDs or enable policy.
    const disabled = modules.outer.createRealStagingHandler({ ...h.env, COACH_REAL_PROVIDER_ENABLED: 'false' }, { clock: h.clock });
    assert.equal((await disabled(request({ headers: { 'X-Recovery': 'clear', 'X-Generation': '999' } }))).status, 503);
    assert.equal(h.state.calls, 0);
    assert.deepEqual(Object.keys(h.instance(name).core), ['execute']);
  } finally { h.close(); }
});

async function callsWith(m, overrides) {
  const h = harness(m, overrides);
  try { await h.call(); return h.state.calls; } finally { h.close(); }
}

for (const [label, overrides] of [
  ['secret alone', { COACH_REAL_PROVIDER_ENABLED: 'false', COACH_REAL_DAILY_UNITS: '0' }],
  ['budget alone', { COACH_REAL_PROVIDER_ENABLED: 'false', OPENAI_API_KEY: undefined }],
  ['enable alone', { OPENAI_API_KEY: undefined, COACH_REAL_DAILY_UNITS: '0', COACH_REAL_RATE_LIMITER: undefined }],
]) test(`C1D live gate separation: ${label}`, async () => assert.equal(await callsWith(modules, overrides), 0));

const clear = "sql.exec('UPDATE coach_slot SET owner = NULL WHERE singleton = 1'); sql.exec(\"UPDATE coach_recovery SET state = 'NORMAL', owner = NULL WHERE singleton = 1\");";
const definitions = [
  { name: 'RESTART_CLEARS_OWNER', target: 'budget',
    before: '  const row = (id) =>', after: `  ${clear}\n  const row = (id) =>`,
    probe: async (m) => (await reconstructed(m)).calls, expected: 1, broken: 2 },
  // There is no runtime alarm/timer. These viable mutants turn the local read-only
  // inspector into unsafe age/alarm-triggered administration; the live SQL fence
  // and subsequent provider calls, not a source-string check, kill them.
  { name: 'AGE_OBSERVATION_CLEARS_OWNER', target: 'budget', before: 'inspectRecovery() {',
    after: `inspectRecovery(observation = {}) { if (observation.ageMs > 3000) { ${clear} }`,
    probe: async (m) => (await reconstructed(m, { ageMs: 864000000 })).calls, expected: 1, broken: 2 },
  { name: 'ALARM_OBSERVATION_CLEARS_OWNER', target: 'budget', before: 'inspectRecovery() {',
    after: `inspectRecovery(observation = {}) { if (observation.alarm === true) { ${clear} }`,
    probe: async (m) => (await reconstructed(m, { alarm: true })).calls, expected: 1, broken: 2 },
  { name: 'CLIENT_RECOVERY_ROUTE', target: 'outer', before: 'return handler;',
    after: "return (request) => { if (new URL(request.url).pathname === '/api/recover') { env.RECOVERY_ADMIN(); return new Response(null, { status: 204 }); } return handler(request); };",
    probe: async (m) => (await clientRecovery(m)).invoked, expected: 0, broken: 1 },
  { name: 'CLIENT_GENERATION', target: 'coordinator', before: 'const input = providerInput(value);',
    after: "const { generation, ...rest } = value; const input = providerInput(rest); if (generation !== undefined) storage.sql.exec('UPDATE coach_slot SET owner = ? WHERE singleton = 1', generation);",
    probe: async (m) => { const h = harness(m); try {
      await assert.rejects(h.instance(name).core.execute({ ...input(), generation: 999 }));
      return h.rows('coach_slot')[0].owner;
    } finally { h.close(); } }, expected: null, broken: 999 },
  { name: 'OLD_GENERATION_CLEARS_NEW_OWNER', target: 'budget',
    before: "sql.exec('UPDATE coach_slot SET owner = NULL WHERE singleton = 1 AND owner = ?', id);",
    after: "sql.exec('UPDATE coach_slot SET owner = NULL WHERE singleton = 1');",
    probe: async (m) => { const r = lateGeneration(m); return r.owner === r.expected; }, expected: true, broken: false },
  { name: 'LOST_STARTED_REFUND', target: 'budget', before: 'if (!started) sql.exec', after: 'if (true) sql.exec',
    probe: async (m) => lateGeneration(m).units, expected: 3, broken: 2 },
  { name: 'SECRET_IMPLICIT_ENABLE', target: 'policy', before: "return env?.COACH_REAL_PROVIDER_ENABLED === 'true'",
    after: "return providerSecret(env) !== null || env?.COACH_REAL_PROVIDER_ENABLED === 'true'",
    probe: (m) => callsWith(m, { COACH_REAL_PROVIDER_ENABLED: 'false' }), expected: 0, broken: 1 },
  { name: 'BUDGET_IMPLICIT_ENABLE', target: 'policy', before: "return env?.COACH_REAL_PROVIDER_ENABLED === 'true'",
    after: "return dailyLimit(env) !== null || env?.COACH_REAL_PROVIDER_ENABLED === 'true'",
    probe: (m) => callsWith(m, { COACH_REAL_PROVIDER_ENABLED: 'false' }), expected: 0, broken: 1 },
  { name: 'ENABLE_BYPASSES_SECRET', target: 'policy', before: 'const key = env?.OPENAI_API_KEY;',
    after: "const key = env?.OPENAI_API_KEY ?? (enabled(env) ? 'MUTANT_SYNTHETIC_ONLY' : undefined);",
    probe: (m) => callsWith(m, { OPENAI_API_KEY: undefined }), expected: 0, broken: 1 },
];

for (const d of definitions) for (const eol of ['\n', '\r\n']) {
  test(`C1D mutation ${d.name} ${eol === '\n' ? 'LF' : 'CRLF'}`, async () => {
    const invariant = (value) => assert.deepEqual(value, d.expected);
    invariant(await d.probe(modules));
    const mutant = await variant(d.target, d.before, d.after, eol);
    const actual = await d.probe(mutant);
    assert.deepEqual(actual, d.broken, 'exact intended broken behavior must execute');
    assert.throws(() => invariant(actual), { name: 'AssertionError', code: 'ERR_ASSERTION' });
  });
}
assert.equal(definitions.length, 10);
