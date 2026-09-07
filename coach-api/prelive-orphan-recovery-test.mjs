import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteStorage, modules, variant, input, response } from './prelive-test-support.mjs';
import * as forensics from './prelive/forensics.js';

const implementation = { ...modules, forensics };
const oldDay = '2026-09-06';
const dump = s => s.db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all().map(row => ({ ...row,
  rows: row.sql?.startsWith('CREATE TABLE') ? s.db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all() : [] }));
function add(s, state, { terminated = 0, finalized = 0 } = {}) {
  s.sql.exec('INSERT OR IGNORE INTO coach_days VALUES (?, 0)', oldDay);
  if (state !== 'released') s.sql.exec('UPDATE coach_days SET units = units + 1 WHERE day = ?', oldDay);
  return s.sql.exec('INSERT INTO coach_reservations (day, units, state, terminated, finalized) VALUES (?, 1, ?, ?, ?) RETURNING id',
    oldDay, state, terminated, finalized).toArray()[0].id;
}
function own(s, id, state = 'ACTIVE_PROVIDER') {
  s.sql.exec('UPDATE coach_slot SET owner = ?', id);
  s.sql.exec('UPDATE coach_recovery SET owner = ?, state = ?', id, state);
}
const orphan = s => add(s, 'started');
const laterOrphan = s => { add(s, 'consumed', { terminated: 1, finalized: 1 }); orphan(s); };
const wrongOwner = s => { orphan(s); own(s, add(s, 'reserved')); };

// Same trusted core.execute boundary as the independent review, not an ARM or
// DISPATCH request. Synthetic key, rate approval and fetch only; no real I/O.
async function probe(m = implementation, setup = orphan) {
  const s = sqliteStorage();
  try {
    setup(s);
    const before = dump(s);
    let readWrites = 0; let measuringReads = true; let calls = 0;
    const exec = s.sql.exec;
    s.sql.exec = (sql, ...args) => {
      if (measuringReads && (!/^\s*SELECT\b/iu.test(sql) || /;\s*\S/u.test(sql))) readWrites++;
      return exec(sql, ...args);
    };
    const env = { COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_PROVIDER_PUBLIC_ENABLED: 'false',
      COACH_REAL_DAILY_UNITS: '1', OPENAI_API_KEY: 'ORPHAN_SYNTHETIC_ONLY',
      COACH_REAL_RATE_LIMITER: { limit: async () => ({ success: true }) } };
    const core = m.coordinator.createCoordinator(s, env, { utcNow: () => Date.UTC(2026, 8, 7),
      fetch: async () => { calls++; return response(); } });
    const budget = m.budget.createDurableBudget(s);
    const snapshot = m.forensics.forensicSnapshot(s);
    assert.deepEqual(m.forensics.forensicSnapshot(s), snapshot);
    const recovery = budget.inspectRecovery();
    assert.equal(readWrites, 0, 'constructor and snapshot must not attempt even same-value writes');
    assert.deepEqual(dump(s), before, 'full schema/rows including sequence preserved during reads');
    measuringReads = false;
    let completed = false;
    try { await core.execute(input()); completed = true; } catch (error) { assert.equal(error.code, 'provider_unavailable'); }
    // Normal denial may reserve/settle its OWN new generation. Existing incident
    // rows and old-day charge must remain byte-for-byte equal; never call that
    // operational path a zero-write snapshot.
    for (const table of ['coach_slot', 'coach_recovery', 'coach_one_shot']) {
      assert.deepEqual(dump(s).find(row => row.name === table), before.find(row => row.name === table));
    }
    const oldRows = before.find(row => row.name === 'coach_reservations').rows;
    assert.deepEqual(s.db.prepare('SELECT * FROM coach_reservations WHERE id <= ? ORDER BY id').all(oldRows.at(-1)?.id ?? 0), oldRows);
    assert.deepEqual(s.db.prepare('SELECT * FROM coach_days WHERE day = ?').all(oldDay), before.find(row => row.name === 'coach_days').rows);
    return { required: snapshot.derived.recoveryRequired, accounting: snapshot.derived.accountingConsistency,
      reason: snapshot.derived.recoveryReason, recovery: recovery.state, calls, completed,
      truncated: snapshot.completeness.truncated, visible: snapshot.raw.reservations.length };
  } finally { s.db.close(); }
}

const cases = [
  ['orphaned started', orphan, true, 'INVALID', 0],
  ['orphaned dispatching', s => add(s, 'dispatching'), true, 'INVALID', 0],
  ['terminated started awaiting finalization still requires owner', s => add(s, 'started', { terminated: 1 }), true, 'INVALID', 0],
  ['terminated dispatching awaiting finalization still requires owner', s => add(s, 'dispatching', { terminated: 1 }), true, 'INVALID', 0],
  ['reserved before acquisition', s => add(s, 'reserved'), false, 'CONSISTENT', 1],
  ['released finalized history', s => add(s, 'released', { finalized: 1 }), false, 'CONSISTENT', 1],
  ['consumed completed history', s => add(s, 'consumed', { terminated: 1, finalized: 1 }), false, 'CONSISTENT', 1],
  ['valid started owner', s => own(s, add(s, 'started')), true, 'CONSISTENT', 0],
  ['valid dispatching owner', s => own(s, add(s, 'dispatching')), true, 'CONSISTENT', 0],
  ['valid terminated owner before finalize', s => own(s, add(s, 'started', { terminated: 1 })), true, 'CONSISTENT', 0],
  ['valid recovery-required owner', s => own(s, add(s, 'started'), 'RECOVERY_REQUIRED'), true, 'CONSISTENT', 0],
  ['wrong owner generation', wrongOwner, true, 'INVALID', 0],
  ['benign completed row before orphan', laterOrphan, true, 'INVALID', 0],
  ['owner without corresponding reservation', s => own(s, 9), true, 'INVALID', 0],
  ['invalid reservation enum', s => add(s, 'UNKNOWN_PRIVATE_STATE'), true, 'INVALID', 0],
];
for (const [name, setup, required, accounting, calls] of cases) test(`C1J orphan recovery: ${name}`, async () => {
  const r = await probe(implementation, setup);
  assert.equal(r.required, required); assert.equal(r.accounting, accounting);
  assert.equal(r.recovery, required ? 'RECOVERY_REQUIRED' : 'NORMAL');
  assert.equal(r.calls, calls); assert.equal(r.completed, calls === 1);
});

test('C1J orphan beyond presentation bound cannot hide recovery or enable runtime', async () => {
  const r = await probe(implementation, s => {
    for (let i = 0; i < 16; i++) add(s, 'consumed', { terminated: 1, finalized: 1 });
    orphan(s);
  });
  assert.equal(r.truncated, true); assert.equal(r.visible, 16);
  assert.equal(r.required, true); assert.equal(r.accounting, 'UNKNOWN');
  assert.equal(r.calls, 0); assert.equal(r.completed, false);
});

test('C1J original terminated continuation can finalize without changing C1D lifetime', () => {
  const s = sqliteStorage();
  try {
    const b = modules.budget.createDurableBudget(s);
    const id = b.reserve(oldDay, 1, 1); assert.equal(b.acquire(id), true);
    assert.equal(b.start(id), true); assert.equal(b.dispatched(id), true);
    assert.equal(b.terminate(id), true);
    assert.equal(forensics.forensicSnapshot(s).derived.accountingConsistency, 'CONSISTENT');
    assert.equal(b.inspectRecovery().state, 'ACTIVE_PROVIDER');
    assert.equal(b.finalize(id, { attempted: true }), true);
    assert.equal(forensics.forensicSnapshot(s).derived.recoveryRequired, false);
    assert.equal(forensics.forensicSnapshot(s).raw.reservations[0].state, 'consumed');
  } finally { s.db.close(); }
});

const reverse = "      valid &&= reservations.every(row => !['dispatching', 'started'].includes(row.state)\n        || row.finalized !== 0 || row.generation === owner);";
const outcome = async (m, setup = orphan) => {
  const r = await probe(m, setup);
  return { required: r.required, calls: r.calls, completed: r.completed };
};
const safe = { required: true, calls: 0, completed: false };
const unsafe = { required: false, calls: 1, completed: true };
const gates = [
  { name: 'remove reverse owner check', target: 'forensics', before: reverse, after: '',
    observe: m => outcome(m), good: safe, bad: unsafe },
  { name: 'ownerless started treated safe', target: 'forensics', before: '|| row.finalized !== 0 || row.generation === owner',
    after: '|| row.finalized !== 0 || owner === null || row.generation === owner', observe: m => outcome(m), good: safe, bad: unsafe },
  { name: 'only inspect first reservation', target: 'forensics', before: reverse,
    after: reverse.replace('reservations.every', 'reservations.slice(0, 1).every'), observe: m => outcome(m, laterOrphan), good: safe, bad: unsafe },
  { name: 'wrong generation accepted as matching', target: 'forensics', before: '|| row.finalized !== 0 || row.generation === owner',
    after: '|| row.finalized !== 0 || owner !== null',
    // Occupied slot independently blocks execution. Kill the incorrect observed
    // ownership-consistency classification; do not pretend this mutant starts I/O.
    observe: async m => (await probe(m, wrongOwner)).accounting, good: 'INVALID', bad: 'CONSISTENT' },
  { name: 'snapshot fence ignored by runtime', target: 'budget',
    before: "if (this.inspectRecovery().state === 'RECOVERY_REQUIRED') return false;", after: 'if (false) return false;',
    observe: m => outcome(m), good: safe, bad: { required: true, calls: 1, completed: true } },
  { name: 'dispatch intent excluded from reverse check', target: 'forensics', before: "!['dispatching', 'started'].includes(row.state)",
    after: "!['started'].includes(row.state)", observe: m => outcome(m, s => add(s, 'dispatching')), good: safe, bad: unsafe },
  { name: 'terminated prematurely releases ownership requirement', target: 'forensics', before: '|| row.finalized !== 0 || row.generation === owner',
    after: '|| row.terminated === 1 || row.finalized !== 0 || row.generation === owner',
    observe: m => outcome(m, s => add(s, 'started', { terminated: 1 })), good: safe, bad: unsafe },
];
for (const g of gates) for (const eol of ['\n', '\r\n']) test(`C1J orphan viable mutation ${g.name} ${JSON.stringify(eol)}`, async () => {
  const invariant = value => assert.deepEqual(value, g.good);
  invariant(await g.observe(implementation));
  const mutant = await variant(g.target, g.before, g.after, eol);
  const broken = await g.observe(mutant);
  assert.deepEqual(broken, g.bad, 'intended broken behavior must actually execute');
  assert.throws(() => invariant(broken), { name: 'AssertionError', code: 'ERR_ASSERTION' });
});
assert.equal(gates.length, 7);
