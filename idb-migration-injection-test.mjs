import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReadPending, classifyFreeze, boundedInjection } from './tools/idb-migration-injection.mjs';
const event = () => ({ isTrusted: true, perf: 12, phases: { tx: { operationId: 'stage', phase: 'read-pending',
  readKeys: ['envelope', 'metadata'], requests: ['pending', 'pending'], readCallbacks: 0, commitPerf: null } } });
test('exact STAGED operation with two pending reads is captured', () => {
  assert.equal(classifyReadPending(event(), 'stage').hit, true);
});
test('the original committing injection miss is INCOMPLETE', () => {
  const e = event(); Object.assign(e.phases.tx, { phase: 'committing', requests: ['done', 'done'], readCallbacks: 2, commitPerf: 11 });
  assert.equal(classifyReadPending(e, 'stage').result, 'INCOMPLETE');
});
test('unrelated read-pending transactions cannot satisfy the STAGED precondition', () => {
  assert.equal(classifyReadPending(event(), 'another-operation').hit, false);
});
test('one completed read or a delivered callback is not the specified injection point', () => {
  const e = event(); e.phases.tx.requests[0] = 'done'; assert.equal(classifyReadPending(e, 'stage').hit, false);
  e.phases.tx.requests[0] = 'pending'; e.phases.tx.readCallbacks = 1; assert.equal(classifyReadPending(e, 'stage').hit, false);
});
test('synthetic lifecycle events cannot certify a native injection', () => {
  const e = event(); e.isTrusted = false; assert.equal(classifyReadPending(e, 'stage').hit, false);
});
test('freeze needs both CDP acknowledgement and a suppressed freezable task', () => {
  const f = { freezeEvent: event(), commandAcknowledged: true, probeDuringFreeze: null };
  assert.equal(classifyFreeze(f, 'stage').hit, true);
  assert.equal(classifyFreeze({ ...f, commandAcknowledged: false }, 'stage').hit, false);
  assert.equal(classifyFreeze({ ...f, probeDuringFreeze: {} }, 'stage').hit, false);
});
test('twelve misses are all retained, never execute crash/discard and stop INCOMPLETE', async () => {
  const saved = []; let actions = 0;
  const r = await boundedInjection(async n => ({ attemptId: n, capture: { hit: false } }),
    async (n, e) => saved.push(e.attemptId), async () => actions++);
  assert.deepEqual(saved, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(actions, 0); assert.deepEqual(r, { result: 'INCOMPLETE', attempts: 12 });
});
test('valid precondition is recorded before the action, with no attempts after success', async () => {
  const order = [];
  const r = await boundedInjection(async n => ({ capture: { hit: n === 2 } }),
    async n => order.push('save-' + n), async n => order.push('action-' + n));
  assert.deepEqual(order, ['save-1', 'save-2', 'action-2']); assert.equal(r.attempts, 2);
});
test('continuing a harness repair preserves the original twelve-attempt budget', async () => {
  const numbers = [];
  const r = await boundedInjection(async n => ({ capture: { hit: false } }), async n => numbers.push(n), async () => assert.fail(), 10);
  assert.deepEqual(numbers, [11, 12]); assert.equal(r.result, 'INCOMPLETE');
});
test('exhausted budget cannot be restarted by a continuation', async () => {
  const r = await boundedInjection(async () => assert.fail(), async () => assert.fail(), async () => assert.fail(), 12);
  assert.equal(r.result, 'INCOMPLETE');
});
