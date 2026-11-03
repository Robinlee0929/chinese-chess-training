import test from 'node:test';
import assert from 'node:assert/strict';
import { baselinePlan, groups, nearestRank, summary, freezeGate } from './tools/idb-acceptance-contract.mjs';

test('AC-S2-v2.1 fixed 800 samples, eight groups and balanced five batches', () => {
  const plan = baselinePlan(); assert.equal(plan.length, 800); assert.deepEqual(plan, baselinePlan());
  assert.equal(new Set(plan.map(r => r.id)).size, 800);
  for (const g of groups()) for (let batch = 0; batch < 5; batch++) for (const op of ['save', 'read', 'rename', 'preferences', 'delete']) {
    assert.equal(plan.filter(r => r.group === g.id && r.batch === batch && r.op === op).length, 4);
  }
});
test('nearest rank keeps tails and is explicitly exploratory', () => {
  const values = Array.from({ length: 100 }, (_, i) => i + 1); values[99] = 6000;
  assert.equal(nearestRank(values, .5), 50); assert.equal(nearestRank(values, .95), 95); assert.equal(nearestRank(values, .99), 99);
  const result = summary(values.map(apiMs => ({ status: 'SUCCESS', apiMs })));
  assert.equal(result.api.maximum, 6000); assert.equal(result.api.over5000, 1); assert.equal(result.FORMAL_SLO, 'NOT_CERTIFIED');
});
test('failed pending and unknown records cannot vanish from denominator', () => {
  const result = summary([{ status: 'SUCCESS', apiMs: 1 }, { status: 'FAILED', apiMs: 6001 }, { status: 'PENDING' }, { status: 'UNKNOWN' }]);
  assert.equal(result.N, 4); assert.equal(result.successful, 1); assert.equal(result.failed, 1); assert.equal(result.pending, 1); assert.equal(result.unknown, 1);
  assert.equal(result.api.missing, 2); assert.equal(result.api.maximum, 6001);
});
test('freeze requires real injection safe commit and no A resume; 5000 boundary is inclusive', () => {
  const r = { injectionConfirmed: true, committed: true, safe: true, aFrozenUntilComplete: true, elapsedMs: 5000 };
  assert.equal(freezeGate(r), 'PASS'); assert.equal(freezeGate({ ...r, elapsedMs: 5000.01 }), 'FAIL');
  assert.equal(freezeGate({ ...r, committed: false }), 'FAIL'); assert.equal(freezeGate({ ...r, aFrozenUntilComplete: false }), 'FAIL');
  assert.equal(freezeGate({ ...r, injectionConfirmed: false }), 'INCONCLUSIVE');
});
