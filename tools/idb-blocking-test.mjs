import assert from 'node:assert/strict';
import { launch, deadline } from './idb-browser-harness.mjs';
import { capacityFixture, capacityBoard } from './idb-capacity-fixture.mjs';
import { applyCustomPositionOperation } from '../custom-position-store.js';

const profiling = process.env.IDB_PROFILE === '1';
const h = await launch(profiling ? 'blocking-profile' : 'blocking-regression', { persistentContexts: true });
const results = [];
const read = async tab => {
  const result = await h.evaluate(tab, 'poc.read()', true);
  assert.equal(result.ok, true, JSON.stringify(result)); return result.snapshot;
};
const prepare = (tab, command) => h.evaluate(tab, `poc.prepare(${JSON.stringify(command)})`, true);
async function pair(durability, variant = '') {
  return { a: await h.tab(undefined, `${h.origin}/?tab=A&durability=${durability}`),
    b: await h.tab(undefined, `${h.origin}/?tab=B&durability=${durability}&variant=${variant}`) };
}
async function seed(tab, fixture) {
  await h.evaluate(tab, `poc.direct(${JSON.stringify(fixture.envelope)},${JSON.stringify(fixture.metadata)})`, true);
  assert.deepEqual(await read(tab), fixture);
}
async function freezePending(durability, variant, fixture, caseId) {
  // External lifecycle injection can arrive before transaction creation or
  // after commit. Bound retries to phase misses only, before any B measurement;
  // never retry or discard a valid slow write. Preserve every missed injection.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const p = await pair(durability, variant);
    const openingMetrics = profiling ? await h.evaluate(p.b, 'idbMeasurements') : null;
    await seed(p.a, fixture);
    const aToken = await prepare(p.a, { type: 'rename', id: fixture.envelope.positions[0].id, title: 'A obsolete' });
    const pending = h.start(p.a, aToken), frozen = await h.freeze(p.a); await pending;
    if (frozen.freezeEvent?.phases[aToken.operationId]?.phase === 'read-pending' && frozen.probeDuringFreeze === null) {
      return { p, openingMetrics, aToken, frozen };
    }
    await h.save(`${caseId}-injection-miss-${attempt}`, { classification: 'INCONCLUSIVE_INJECTION', aToken, frozen });
    await h.resume(p.a); await h.evaluate(p.a, 'poc.resume()', true); await h.dispose(p);
  }
  assert.fail(`${caseId}: no read-pending freeze within 3 external injection attempts`);
}
function expectedAfter(before, token) {
  const next = structuredClone(applyCustomPositionOperation(before.envelope, token.command,
    { now: () => token.preparedAt, idFactory: () => token.positionId }));
  next.envelope.revision = before.envelope.revision + 1;
  const metadata = structuredClone(before.metadata), id = next.result.position?.id ?? token.command.id;
  const old = before.envelope.positions.findIndex(p => p.id === id), current = next.envelope.positions.findIndex(p => p.id === id);
  const delta = { index: old < 0 ? current : old, before: before.envelope.positions[old] ?? null,
    after: next.envelope.positions[current] ?? null };
  return { envelope: next.envelope, metadata, delta };
}
function assertTransition(before, after, token) {
  const expected = expectedAfter(before, token), receipt = after.metadata.commits.at(-1);
  assert.deepEqual(receipt.operation, token); assert.deepEqual(receipt.delta, expected.delta);
  assert.equal(receipt.revision, before.envelope.revision + 1);
  assert.ok(Number.isFinite(Date.parse(receipt.committedAt)));
  expected.metadata.commits.push(receipt);
  if (expected.metadata.commits.length > 128) {
    const oldest = expected.metadata.commits.shift(), d = oldest.delta, base = expected.metadata.baseEnvelope;
    if (d.before !== null) { assert.deepEqual(base.positions[d.index], d.before); base.positions.splice(d.index, 1); }
    if (d.after !== null) base.positions.splice(d.index, 0, structuredClone(d.after));
    base.revision = oldest.revision;
  }
  expected.metadata.committedOperationIds = expected.metadata.commits.map(r => r.operation.operationId);
  expected.metadata.lastCommit = { operationId: token.operationId, revision: receipt.revision, committedAt: receipt.committedAt };
  assert.deepEqual(after.envelope, expected.envelope); assert.deepEqual(after.metadata, expected.metadata);
}
async function timedWrite(tab, command) {
  const start = performance.now();
  const pipeline = (async () => {
    const token = await prepare(tab, command), writeStart = performance.now();
    await h.start(tab, token);
    const native = await h.until(e => e.sessionId === tab.sessionId && e.trace?.type === 'native-terminal'
      && e.trace.operationId === token.operationId, 20000);
    const outcome = await h.outcome(tab, token.operationId, 20000);
    return { token, native, outcome, totalMs: native.externalPerf - start,
      writeMs: native.externalPerf - writeStart };
  })();
  const gate = await deadline(pipeline, 2000);
  // A timeout never cancels a data transaction or becomes a successful sample.
  // Continue observing its actual result while A remains away, then fail the gate.
  const observed = gate.status === 'DEADLINE_EXCEEDED' ? await deadline(pipeline, 20000) : gate;
  return { gate: gate.status ?? 'COMPLETED', observed,
    pass: observed.native?.trace?.terminal === 'COMPLETE' && observed.outcome?.status === 'COMMITTED'
      && observed.totalMs < 2000 };
}
async function save(id, evidence, pass) {
  await h.save(id, evidence);
  results.push({ id, result: pass ? 'PASS' : 'FAIL', totalMs: evidence.timing?.observed?.totalMs,
    writeMs: evidence.timing?.observed?.writeMs });
  console.log(JSON.stringify(results.at(-1)));
}

try {
  for (const durability of ['default', 'strict']) {
    const samples = profiling ? [false] : [false, false, false, true];
    for (let i = 0; i < samples.length; i++) {
      const wide = samples[i], fixture = capacityFixture(100, wide);
      const { p, openingMetrics, aToken, frozen } = await freezePending(durability, profiling ? 'profile' : '', fixture, `PERF-${durability}-${i}`);
      const id = fixture.envelope.positions[0].id;
      if (profiling) await h.evaluate(p.b, 'idbMeasurements.length = 0');
      const command = i === 1 ? { type: 'preferences', id, preferences: { humanSide: 'red', difficulty: 'hard' } }
        : i === 2 ? { type: 'delete', id } : { type: 'rename', id, title: wide ? '🀄'.repeat(59) + 'B' : 'B fresh' };
      const timing = await timedWrite(p.b, command);
      const metrics = profiling ? await h.evaluate(p.b, 'idbMeasurements') : null;
      const after = await read(p.b); assertTransition(fixture, after, timing.observed.token);
      const observation = await h.evaluate(p.b, `poc.verify(${JSON.stringify(aToken)})`, true);
      assert.equal(observation.status, 'NOT_COMMITTED_OBSERVED');
      assert.equal(h.events.filter(e => e.sessionId === p.a.sessionId && e.trace?.type === 'resume').length, 0);
      const evidence = { durability, wide, fixture, fixtureBytes: Buffer.byteLength(JSON.stringify(fixture.envelope)),
        aToken, frozen, timing, metrics, openingMetrics, after, observation, aResumedBeforeBComplete: false };
      await save(`PERF-${durability}-${i}`, evidence, timing.pass);
      await h.resume(p.a); await h.evaluate(p.a, 'poc.resume()', true);
      assert.deepEqual(await read(p.a), after); await h.dispose(p);
    }
    if (!profiling) {
      const p = await pair(durability), fixture = capacityFixture(98); await seed(p.a, fixture);
      let before = fixture;
      for (const i of [98, 99]) {
        const command = { type: 'save', position: { title: 'added ' + i, initialBoard: capacityBoard(i), sideToMove: 'red',
          playPreferences: { humanSide: 'black', difficulty: 'hard' } } };
        const timing = await timedWrite(p.b, command), after = await read(p.a);
        assertTransition(before, after, timing.observed.token); assert.equal(after.envelope.positions.length, i + 1);
        await save(`PERF-growth-${durability}-${i + 1}`, { timing, before, after }, timing.pass); before = after;
      }
      const overLimit = await h.evaluate(p.b, "poc.prepare({type:'save',position:poc.position(101)}).then(()=>null,e=>e.code)", true);
      assert.equal(overLimit, 'POSITION_LIMIT'); assert.deepEqual(await read(p.a), before); await h.dispose(p);
    }
  }

  if (!profiling) {
    // A prepare-time proof must never substitute for validation of fresh IDB data.
    { const p = await pair('default'), fixture = capacityFixture(); await seed(p.a, fixture);
      const t = await prepare(p.a, { type: 'rename', id: 'seed-0', title: 'must not overwrite corruption' });
      const corrupt = structuredClone(fixture); corrupt.metadata.commits[0].delta.after.title = 'corrupt retained history';
      await h.evaluate(p.b, `poc.direct(${JSON.stringify(corrupt.envelope)},${JSON.stringify(corrupt.metadata)})`, true);
      const result = await h.write(p.a, t); assert.equal(result.result.status, 'FAILED'); assert.equal(result.result.nativeEvent, 'ABORT');
      const raw = await h.evaluate(p.b, `new Promise((resolve,reject)=>{const r=indexedDB.open(poc.api.CUSTOM_POSITION_DATABASE,1);
        r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('state','readonly'),s=tx.objectStore('state'),v={};
          s.get('envelope').onsuccess=e=>v.envelope=e.target.result;s.get('metadata').onsuccess=e=>v.metadata=e.target.result;
          tx.oncomplete=()=>{db.close();resolve(v)};tx.onabort=()=>{db.close();reject(tx.error)};};})`, true);
      assert.deepEqual(raw, corrupt); await save('fresh-IDB-corruption-after-prepare', { result, original: fixture, corrupt, raw }, true);
      // The adapter deliberately preserves corruption. Reset only this synthetic
      // fixture through the test helper before the next isolated scenario.
      await seed(p.b, fixture); await h.dispose(p);
    }
    for (const variant of ['', 'operation-id-events']) {
      const a = await h.tab(undefined, `${h.origin}/?variant=${variant}`), b = await h.tab();
      await h.evaluate(a, 'poc.seed(1)', true);
      const setup = await h.evaluate(a, `(async()=>{window.before=(await poc.read()).snapshot;
        window.first=await poc.prepare({type:'rename',id:'seed-0',title:'first'});return first;})()`, true);
      const written = await h.write(a, setup); assert.equal(written.result.status, 'COMMITTED');
      const firstObservation = await h.evaluate(a, 'poc.verify(first)', true); assert.equal(firstObservation.nativeEvent, 'COMPLETE');
      const collisions = [];
      for (let i = 0; i < 3; i++) {
        const collision = await h.evaluate(a, `(async()=>{const token=poc.adapter.prepare(before,
          {type:'rename',id:'seed-0',title:'collision ${i}'},{nonce:first.operationId.split('/').at(-1)});
          const rejected=await poc.adapter.write(token);return{token,rejected,own:await poc.verify(token),first:await poc.verify(first)};})()`, true);
        assert.equal(collision.rejected.code, 'OPERATION_ID_COLLISION'); assert.equal(collision.rejected.nativeEvent, 'ABORT');
        assert.equal(collision.own.nativeEvent, 'ABORT'); assert.equal(collision.first.status, 'COMMITTED');
        collisions.push(collision);
        if (variant) break;
        assert.equal(collision.first.nativeEvent, 'COMPLETE', 'EVENT-04: original complete must survive collision');
      }
      if (variant) {
        assert.equal(collisions[0].first.nativeEvent, 'ABORT');
        assert.throws(() => assert.equal(collisions[0].first.nativeEvent, 'COMPLETE'), { code: 'ERR_ASSERTION' });
        await save('N-operation-id-events', { written, firstObservation, collisions, detected: true }, true);
      } else {
        const stale = await h.evaluate(a, `(async()=>{const t=poc.adapter.prepare(before,{type:'rename',id:'seed-0',title:'stale'});
          const rejected=await poc.adapter.write(t);return{rejected,own:await poc.verify(t)};})()`, true);
        assert.equal(stale.rejected.status, 'REVISION_CONFLICT'); assert.equal(stale.own.nativeEvent, 'ABORT');
        const aborted = await prepare(a, { type: 'rename', id: 'seed-0', title: 'abort' });
        await h.evaluate(a, 'poc.faults({abortRead:true})'); const abortedResult = await h.write(a, aborted);
        assert.equal(abortedResult.result.status, 'ABORTED_OBSERVED');
        await h.evaluate(a, 'poc.faults({});poc.resume()', true);
        const next = await prepare(a, { type: 'rename', id: 'seed-0', title: 'next completed' });
        assert.equal((await h.write(a, next)).result.nativeEvent, 'COMPLETE');
        const original = await h.evaluate(a, 'poc.verify(first)', true);
        const serialized = await h.evaluate(a, 'poc.verify(JSON.parse(JSON.stringify(first)))', true);
        const foreign = await h.evaluate(b, `poc.verify(${JSON.stringify(setup)})`, true);
        assert.equal(original.nativeEvent, 'COMPLETE'); assert.equal(original.status, 'COMMITTED');
        assert.equal(serialized.nativeEvent, 'UNKNOWN'); assert.equal(foreign.nativeEvent, 'UNKNOWN');
        assert.equal(serialized.status, 'COMMITTED'); assert.equal(foreign.status, 'COMMITTED');
        const after = await read(b); assert.equal(after.envelope.revision, 2); assert.equal(after.envelope.positions[0].title, 'next completed');
        await save('EVENT-01-through-08', { written, firstObservation, collisions, stale, abortedResult, original, serialized, foreign, after }, true);
      }
      await h.dispose({ a, b });
    }
  }
  await h.save('summary', { profiling, results, maxMs: Math.max(...results.map(r => r.totalMs ?? 0)), failures: results.filter(r => r.result === 'FAIL') });
  assert.equal(results.filter(r => r.result === 'FAIL').length, 0, 'Every required sample must satisfy 2000 ms');
} catch (error) {
  await h.save('failure', { message: error.message, stack: error.stack, results }); throw error;
} finally {
  await h.save('console-errors', h.events.filter(e => e.method === 'Runtime.exceptionThrown' || ['page-error','unhandled-rejection'].includes(e.trace?.type)));
  await h.close();
}
