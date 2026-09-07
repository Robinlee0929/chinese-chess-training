import assert from 'node:assert/strict';
import test from 'node:test';
import './prelive-forensics-runtime-test.mjs';
import { sqliteStorage, modules, variant, input, response } from './prelive-test-support.mjs';
import * as forensics from './prelive/forensics.js';
import { provisionCoordinator, INITIAL_PROVISIONING } from './prelive/provision.js';
const implementation = { ...modules, forensics };
const dump = s => s.db.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all().map(row => ({ ...row,
  rows: row.sql?.startsWith('CREATE TABLE') ? s.db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all() : [] }));
function measured(s) {
  const counts = { writes: 0, reserve: 0, provider: 0, rate: 0, arm: 0, dispatch: 0, initialize: 0, finalize: 0, acquire: 0, clear: 0 };
  const original = s.sql.exec;
  s.sql.exec = (query, ...args) => {
    // Fail by observation, not by syntax/import/fixture failure: mutants really write.
    if (!/^\s*SELECT\b/iu.test(query) || /;\s*\S/u.test(query)) counts.writes++;
    return original(query, ...args);
  };
  s.testAuthorities = Object.fromEntries(Object.keys(counts).filter(k => k !== 'writes').map(k => [k, () => { counts[k]++; }]));
  return counts;
}
function reservation(s, state = 'started', { owner = true, finalized = false } = {}) {
  s.sql.exec("INSERT INTO coach_days VALUES ('2026-09-07', 1)");
  s.sql.exec('INSERT INTO coach_reservations (id, day, units, state, terminated, finalized) VALUES (1, ?, 1, ?, ?, ?)',
    '2026-09-07', state, finalized ? 1 : 0, finalized ? 1 : 0);
  if (owner) { s.sql.exec('UPDATE coach_slot SET owner = 1'); s.sql.exec("UPDATE coach_recovery SET owner = 1, state = 'ACTIVE_PROVIDER'"); }
}
const fixtures = [
  ['idle', () => {}],
  ['armed', s => s.sql.exec("UPDATE coach_one_shot SET state = 'ARMED'")],
  ['consumed', s => s.sql.exec("UPDATE coach_one_shot SET state = 'CONSUMED'")],
  ['missing one-shot row', s => s.sql.exec('DELETE FROM coach_one_shot')],
  ['missing one-shot table', s => s.sql.exec('DROP TABLE coach_one_shot')],
  ...['reserved', 'dispatching', 'started'].map(state => [state, s => reservation(s, state)]),
  ['finalized', s => reservation(s, 'consumed', { owner: false, finalized: true })],
  ['unresolved owner', s => reservation(s)],
  ['raw NORMAL active owner', s => { reservation(s); s.sql.exec("UPDATE coach_recovery SET state = 'NORMAL'"); }],
  ['mismatched owner', s => { reservation(s); s.sql.exec('UPDATE coach_recovery SET owner = 9'); }],
  ['RECOVERY_REQUIRED', s => { reservation(s); s.sql.exec("UPDATE coach_recovery SET state = 'RECOVERY_REQUIRED'"); }],
  ['invalid recovery enum', s => s.sql.exec("UPDATE coach_recovery SET state = 'PRIVATE_PROVIDER_CONTENT'")],
  ['invalid reservation enum', s => reservation(s, 'PRIVATE_PROVIDER_CONTENT')],
  ['missing slot row', s => s.sql.exec('DELETE FROM coach_slot')],
  ['missing recovery row', s => s.sql.exec('DELETE FROM coach_recovery')],
  ['cross-day', s => { reservation(s); s.sql.exec("INSERT INTO coach_days VALUES ('2026-09-08', 0)"); }],
  ['budget overflow', s => { for (let i = 1; i <= 9; i++) s.sql.exec('INSERT INTO coach_days VALUES (?, 0)', `2026-09-${String(i).padStart(2, '0')}`); }],
  ['reservation overflow', s => { s.sql.exec("INSERT INTO coach_days VALUES ('2026-09-07', 17)"); for (let i = 1; i <= 17; i++) s.sql.exec("INSERT INTO coach_reservations (day, units, state) VALUES ('2026-09-07', 1, 'reserved')"); }],
  ['lost continuation', s => { reservation(s); s.sql.exec("UPDATE coach_one_shot SET state = 'CONSUMED'"); }],
  ['late generation evidence', s => { reservation(s); s.sql.exec("INSERT INTO coach_reservations (day, units, state) VALUES ('2026-09-07', 1, 'reserved')"); s.sql.exec('UPDATE coach_days SET units = 2'); s.sql.exec('UPDATE coach_slot SET owner = 2'); }],
  ['invalid column schema', s => s.sql.exec('ALTER TABLE coach_days ADD COLUMN extra TEXT')],
  ['invalid day', s => s.sql.exec("INSERT INTO coach_days VALUES ('PRIVATE_PROVIDER_CONTENT', 0)")],
  ['invalid finalized flag', s => { reservation(s); s.sql.exec('UPDATE coach_reservations SET finalized = 9'); }],
  ['invalid owner generation', s => s.sql.exec("UPDATE coach_slot SET owner = 'PRIVATE_PROVIDER_CONTENT'")],
  ['missing budget table', s => s.sql.exec('DROP TABLE coach_days')],
  ['missing reservation table', s => s.sql.exec('DROP TABLE coach_reservations')],
];

for (const [name, setup] of fixtures) test(`C1J reconstruction and repeated concurrent snapshot preserve ${name}`, async () => {
  const s = sqliteStorage();
  try {
    setup(s); const before = dump(s); const counts = measured(s);
    const secretEnv = new Proxy({}, { get() { throw new Error('ENV MUST NOT BE READ'); } });
    const core = modules.coordinator.createCoordinator(s, secretEnv);
    assert.deepEqual(Object.keys(core), ['execute', 'operator']);
    const snapshots = await Promise.all(Array.from({ length: 3 }, () => Promise.resolve(forensics.forensicSnapshot(s))));
    assert.deepEqual(snapshots[0], snapshots[1]);
    const snapshot = snapshots[0];
    assert.ok(snapshot.raw.budgetRows.length <= 8 && snapshot.raw.reservations.length <= 16);
    if (name.includes('overflow')) { assert.equal(snapshot.completeness.truncated, true); assert.notEqual(snapshot.derived.accountingConsistency, 'CONSISTENT'); }
    if (name.includes('invalid')) assert.equal(snapshot.schema.consistencyStatus, 'INVALID');
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE_PROVIDER_CONTENT'), false);
    assert.equal(snapshot.derived.providerFetchStarted, 'UNKNOWN'); assert.equal(snapshot.derived.attempted, 'UNKNOWN');
    if (['unresolved owner', 'raw NORMAL active owner', 'mismatched owner', 'RECOVERY_REQUIRED', 'lost continuation'].includes(name)) {
      assert.equal(snapshot.derived.recoveryRequired, true);
      assert.equal(modules.budget.createDurableBudget(s).inspectRecovery().state, 'RECOVERY_REQUIRED');
    }
    assert.ok(Object.values(counts).every(value => value === 0));
    assert.deepEqual(dump(s), before);
  } finally { s.db.close(); }
});

for (const [name, setup] of fixtures.filter(([name]) => /missing|invalid|overflow/u.test(name))) test(`C1J invalid/incomplete storage denies execution without repair: ${name}`, async () => {
  const s = sqliteStorage(); let calls = 0;
  try {
    setup(s); const before = dump(s); const counts = measured(s);
    const env = { COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_DAILY_UNITS: '1', OPENAI_API_KEY: 'LOCAL_ONLY',
      COACH_REAL_RATE_LIMITER: { limit: async () => ({ success: true }) } };
    const core = modules.coordinator.createCoordinator(s, env, { fetch: async () => { calls++; return response(); }, operatorAuthority: () => true });
    await assert.rejects(core.execute(input()));
    assert.deepEqual(await core.operator.arm(), { status: 'denied' });
    assert.deepEqual(await core.operator.dispatch(), { status: 'denied' });
    assert.equal(calls, 0); assert.equal(counts.writes, 0); assert.deepEqual(dump(s), before);
  } finally { s.db.close(); }
});

test('C1J empty storage is never implicitly provisioned; explicit capability only and never repair', () => {
  const s = sqliteStorage(undefined, { provision: false });
  try {
    const before = dump(s); const counts = measured(s);
    modules.coordinator.createCoordinator(s, {});
    assert.equal(forensics.forensicSnapshot(s).schema.consistencyStatus, 'INVALID');
    assert.deepEqual(dump(s), before); assert.equal(counts.writes, 0);
    assert.throws(() => provisionCoordinator(s, true), /denied/);
    provisionCoordinator(s, INITIAL_PROVISIONING);
    assert.equal(forensics.forensicSnapshot(s).raw.oneShot.state, 'DISARMED');
    const initialized = dump(s); assert.throws(() => provisionCoordinator(s, INITIAL_PROVISIONING), /Existing/);
    assert.deepEqual(dump(s), initialized);
  } finally { s.db.close(); }
});
test('C1J constructor read failure and snapshot fail closed with zero writes', () => {
  const s = sqliteStorage();
  try { const before = dump(s); const counts = measured(s); s.sql.exec = () => { throw new Error('PRIVATE'); };
    modules.coordinator.createCoordinator(s, {});
    const result = forensics.forensicSnapshot(s);
    assert.equal(result.completeness.readComplete, false); assert.equal(result.derived.recoveryRequired, true);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(counts.writes, 0); assert.deepEqual(dump(s), before);
  } finally { s.db.close(); }
});
for (const action of ['provider', 'rearm', 'clear', 'finalize', 'initialize', 'object-id']) test(`C1J snapshot cannot ${action}`, () => {
  const s = sqliteStorage();
  try { reservation(s); const before = dump(s); const counts = measured(s);
    assert.throws(() => forensics.forensicSnapshot(s, { action }), /arguments denied/);
    forensics.forensicSnapshot(s);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0); assert.deepEqual(dump(s), before);
  } finally { s.db.close(); }
});

async function probe(m, kind, setup = () => {}) {
  const s = sqliteStorage();
  try {
    setup(s); const counts = measured(s);
    if (kind === 'constructor') m.budget.createDurableBudget(s);
    else m.forensics.forensicSnapshot(s);
    return { counts, text: JSON.stringify(m.forensics.forensicSnapshot(s)) };
  } finally { s.db.close(); }
}
const constructorSite = '  const initial = forensicSnapshot(storage);';
const snapshotSite = '  const tablesPresent =';
const writeMutants = [
  ['recovery update', "UPDATE coach_recovery SET state = 'RECOVERY_REQUIRED'", s => reservation(s)],
  ['slot clear', 'UPDATE coach_slot SET owner = NULL', s => reservation(s)],
  ['refund', 'UPDATE coach_days SET units = 0', s => reservation(s)],
  ['missing singleton insert', 'INSERT INTO coach_slot VALUES (1, NULL)', s => s.sql.exec('DELETE FROM coach_slot')],
  ['missing schema create', 'CREATE TABLE coach_days (day TEXT PRIMARY KEY, units INTEGER)', s => s.sql.exec('DROP TABLE coach_days')],
  ['one-shot change', "UPDATE coach_one_shot SET state = 'CONSUMED'", () => {}],
];
const gates = writeMutants.map(([name, sql, setup]) => ({ name, target: 'budget', before: constructorSite,
  after: `  storage.sql.exec(${JSON.stringify(sql)});\n${constructorSite}`, observe: async m => (await probe(m, 'constructor', setup)).counts.writes, good: 0, bad: 1 }));
for (const [name, sql] of [['same-value update', 'UPDATE coach_slot SET owner = owner'], ['snapshot insert', "INSERT INTO coach_days VALUES ('2099-01-01', 0)"]]) {
  gates.push({ name, target: 'forensics', before: snapshotSite, after: `  storage.sql.exec(${JSON.stringify(sql.replace('INSERT INTO', 'INSERT OR IGNORE INTO'))});\n${snapshotSite}`,
    observe: async m => (await probe(m, 'snapshot')).counts.writes, good: 0, bad: 2 });
}
for (const action of ['reserve', 'provider', 'rate', 'arm', 'dispatch', 'initialize', 'finalize', 'acquire', 'clear']) gates.push({ name: `snapshot invokes ${action}`, target: 'forensics',
  before: snapshotSite, after: `  storage.testAuthorities.${action}();\n${snapshotSite}`,
  observe: async m => (await probe(m, 'snapshot')).counts[action], good: 0, bad: 2 });
for (const sentinel of ['SECRET_SENTINEL', 'PRIVATE_PROVIDER_CONTENT']) gates.push({ name: `exposes ${sentinel}`, target: 'forensics',
  before: '  return result;', after: `  result.leak = '${sentinel}';\n  return result;`,
  observe: async m => (await probe(m, 'snapshot')).text.includes(sentinel), good: false, bad: true });
gates.push({ name: 'truncated claims consistency', target: 'forensics', before: "result.completeness.truncated ? 'UNKNOWN' : 'CONSISTENT'", after: "'CONSISTENT'",
  observe: async m => JSON.parse((await probe(m, 'snapshot', fixtures.find(([n]) => n === 'budget overflow')[1])).text).derived.accountingConsistency, good: 'UNKNOWN', bad: 'CONSISTENT' });
gates.push({ name: 'invalid enum normalized', target: 'forensics', before: "values.includes(value) ? value : 'INVALID'", after: 'values.includes(value) ? value : values[0]',
  observe: async m => JSON.parse((await probe(m, 'snapshot', fixtures.find(([n]) => n === 'invalid recovery enum')[1])).text).raw.recovery.state, good: 'INVALID', bad: 'NORMAL' });
gates.push({ name: 'client object selection', target: 'outer', before: 'return handler;',
  after: "return request => { env.COACH_REAL_COORDINATOR.getByName(new URL(request.url).searchParams.get('object')); return new Response(null, { status: 403 }); };",
  observe: async m => { const ids = []; const handler = m.outer.createRealStagingHandler({ COACH_REAL_COORDINATOR: { getByName(id) { ids.push(id); } } });
    await handler(new Request('https://local.invalid/__forensic?object=client-selected')); return ids.length; }, good: 0, bad: 1 });
gates.push({ name: 'derived recovery fence removed', target: 'budget',
  before: "if (this.inspectRecovery().state === 'RECOVERY_REQUIRED') return false;", after: 'if (false) return false;',
  observe: async m => { const s = sqliteStorage(); try { s.sql.exec("UPDATE coach_recovery SET state = 'RECOVERY_REQUIRED'");
    const b = m.budget.createDurableBudget(s); return b.acquire(b.reserve('2026-09-07', 1, 1)); } finally { s.db.close(); } }, good: false, bad: true });
gates.push({ name: 'old generation clears new owner', target: 'budget',
  before: "sql.exec('UPDATE coach_slot SET owner = NULL WHERE singleton = 1 AND owner = ?', id);", after: "sql.exec('UPDATE coach_slot SET owner = NULL WHERE singleton = 1');",
  observe: async m => { const s = sqliteStorage(); try { const b = m.budget.createDurableBudget(s); const old = b.reserve('2026-09-07', 1, 3); b.acquire(old); b.start(old); b.dispatched(old);
    const next = b.reserve('2026-09-07', 1, 3); s.sql.exec('UPDATE coach_slot SET owner = ?', next); s.sql.exec('UPDATE coach_recovery SET owner = ?', next);
    b.terminate(old); b.finalize(old, { attempted: true }); return s.sql.exec('SELECT owner FROM coach_slot').toArray()[0].owner; } finally { s.db.close(); } }, good: 2, bad: null });

for (const g of gates) for (const eol of ['\n', '\r\n']) test(`C1J viable mutation ${g.name} ${JSON.stringify(eol)}`, async () => {
  const invariant = value => assert.deepEqual(value, g.good);
  invariant(await g.observe(implementation));
  const mutant = await variant(g.target, g.before, g.after, eol);
  const broken = await g.observe(mutant);
  assert.deepEqual(broken, g.bad, 'intended broken behavior must execute');
  assert.throws(() => invariant(broken), { name: 'AssertionError', code: 'ERR_ASSERTION' });
});
assert.equal(gates.length, 24);
