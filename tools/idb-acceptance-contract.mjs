import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { applyCustomPositionOperation } from '../custom-position-store.js';

export const ACCEPTANCE_VERSION = 'AC-S2-v2.1';
export const SEED = 0x5a21cafe;
export const OPERATIONS = ['save', 'read', 'rename', 'preferences', 'delete'];
export function groups() {
  return ['original', 'migration'].flatMap(metadata => ['default', 'strict'].flatMap(durability =>
    ['cold', 'reused'].map(connection => ({ id: `${metadata}-${durability}-${connection}`, metadata, durability, connection }))));
}
export function baselinePlan() {
  let state = SEED;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const shuffle = values => { const a = [...values]; for (let i = a.length - 1; i > 0; i--) { const j = random() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const plan = [];
  for (let batch = 0; batch < 5; batch++) {
    const order = shuffle(groups());
    for (let repeat = 0; repeat < 4; repeat++) for (const op of shuffle(OPERATIONS)) for (const group of order) {
      plan.push({ id: `B-${String(plan.length + 1).padStart(3, '0')}`, batch, repeat, op, ...{ group: group.id } });
    }
  }
  return plan;
}
export function migratedFixture(original) {
  const state = structuredClone(original), candidateJSON = JSON.stringify(state.metadata.baseEnvelope);
  const sourceFingerprint = createHash('sha256').update(candidateJSON).digest('hex');
  state.metadata.migration = { version: 1, state: 'ACTIVE', migrationId: 'legacy-v1:' + sourceFingerprint,
    sourceFingerprint, sourceRevision: 2, initialRevision: 2,
    stagedOperationId: '33333333-3333-4333-8333-333333333333', activatedOperationId: '44444444-4444-4444-8444-444444444444',
    stagedAt: '2026-11-02T00:00:00.000Z', activatedAt: '2026-11-02T00:00:00.000Z', candidateJSON };
  return state;
}
export function assertTransition(before, after, token) {
  if (!token) { assert.deepEqual(after, before); return; }
  const applied = applyCustomPositionOperation(before.envelope, token.command, { now: () => token.preparedAt, idFactory: () => token.positionId });
  const envelope = structuredClone(applied.envelope); envelope.revision = before.envelope.revision + 1;
  const key = applied.result.position?.id ?? token.command.id;
  const old = before.envelope.positions.findIndex(p => p.id === key), next = envelope.positions.findIndex(p => p.id === key);
  const metadata = structuredClone(before.metadata), receipt = after.metadata.commits.at(-1);
  assert.deepEqual(receipt.operation, token); assert.equal(receipt.revision, envelope.revision);
  assert.deepEqual(receipt.delta, { index: old < 0 ? next : old, before: before.envelope.positions[old] ?? null, after: envelope.positions[next] ?? null });
  assert.ok(Number.isFinite(Date.parse(receipt.committedAt)));
  metadata.commits.push(receipt);
  if (metadata.commits.length > 128) {
    const evicted = metadata.commits.shift(), d = evicted.delta, base = metadata.baseEnvelope;
    if (d.before !== null) { assert.deepEqual(base.positions[d.index], d.before); base.positions.splice(d.index, 1); }
    if (d.after !== null) base.positions.splice(d.index, 0, structuredClone(d.after));
    base.revision = evicted.revision;
  }
  metadata.committedOperationIds = metadata.commits.map(r => r.operation.operationId);
  metadata.lastCommit = { operationId: token.operationId, revision: envelope.revision, committedAt: receipt.committedAt };
  assert.deepEqual(after, { envelope, metadata }); assert.equal(metadata.commits.length, 128);
  assert.equal(new Set(metadata.committedOperationIds).size, 128);
}
export function nearestRank(values, p) {
  assert.ok(p > 0 && p <= 1); if (!values.length) return null;
  assert.ok(values.every(v => Number.isFinite(v) && v >= 0));
  return [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1];
}
export function distribution(samples, key) {
  const values = samples.map(s => s[key]).filter(v => Number.isFinite(v));
  return { measured: values.length, missing: samples.length - values.length, p50: nearestRank(values, .5), p95: nearestRank(values, .95),
    exploratoryP99: nearestRank(values, .99), maximum: values.length ? Math.max(...values) : null,
    over2000: values.filter(v => v > 2000).length, over3000: values.filter(v => v > 3000).length, over5000: values.filter(v => v > 5000).length };
}
export function freezeGate(record) {
  if (!record.injectionConfirmed) return 'INCONCLUSIVE';
  return record.committed && record.safe && record.aFrozenUntilComplete && Number.isFinite(record.elapsedMs) && record.elapsedMs <= 5000 ? 'PASS' : 'FAIL';
}
export function summary(samples) {
  return { N: samples.length, successful: samples.filter(s => s.status === 'SUCCESS').length,
    failed: samples.filter(s => s.status === 'FAILED').length, pending: samples.filter(s => s.status === 'PENDING').length,
    unknown: samples.filter(s => s.status === 'UNKNOWN').length,
    api: distribution(samples, 'apiMs'), transaction: distribution(samples, 'transactionMs'), external: distribution(samples, 'externalMs'),
    FORMAL_SLO: 'NOT_CERTIFIED' };
}
