import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { launch, deadline } from './idb-browser-harness.mjs';
import { capacityFixture } from './idb-capacity-fixture.mjs';
import { ACCEPTANCE_VERSION, SEED, groups, baselinePlan, migratedFixture, assertTransition, summary, freezeGate } from './idb-acceptance-contract.mjs';

const evidence = process.env.IDB_EVIDENCE_DIR, historicalPath = process.env.IDB_TARGET_CASE;
const mode = process.argv[2]; assert.ok(evidence && historicalPath); assert.ok(['freeze', 'baseline'].includes(mode));
const historical = JSON.parse(await readFile(historicalPath, 'utf8'));
const originalAdd = historical.before, addCommand = historical.timing.observed.token.command;
assert.deepEqual(originalAdd, capacityFixture(98)); assert.equal(Buffer.byteLength(JSON.stringify(originalAdd.envelope)), 129033);
const full = capacityFixture(100, true), fixtures = {};
for (const metadata of ['original', 'migration']) for (const [load, value] of [['add', originalAdd], ['full', full]]) {
  const f = metadata === 'migration' ? migratedFixture(value) : structuredClone(value);
  fixtures[`${metadata}-${load}`] = f;
}
const configurations = ['original', 'migration'].flatMap(metadata => ['default', 'strict'].map(durability => ({ metadata, durability, id: `${metadata}-${durability}` })));
const planned = mode === 'baseline' ? baselinePlan() : Array.from({ length: 12 }, (_, round) => configurations.map(c => ({ ...c, round, op: ['rename', 'preferences', 'delete', 'save'][round % 4] }))).flat();
const plan = { version: ACCEPTANCE_VERSION, mode, seed: SEED, groups: mode === 'baseline' ? groups() : configurations,
  samples: mode === 'baseline' ? 800 : 48, maxFreezeAttemptsPerConfiguration: 24, order: planned,
  targetPath: historicalPath, historicalFailuresMs: [2122.5354, 2928.8247, 2239.8040],
  freezeLimitMs: 5000, observationLimitMs: 20000, FORMAL_SLO: 'NOT_CERTIFIED',
  timing: { api: 'Page monotonic before adapter.read/prepare/open to completed result', transaction: 'Before native db.transaction call through its trusted native complete listener',
    external: 'External monotonic CDP dispatch to api-complete binding delivery; roundtrip also retained', freeze: 'External dispatch of complete B pipeline to trusted final transaction COMPLETE binding' },
  isolation: 'Isolated disk Chrome profile, localhost; no trace or CPU sampling; every case independently reseeded; sequential operations',
  stop: 'Immediate stop on safety failure, valid freeze >5000ms, incomplete operation or exhausted injection budget; no replenishment of valid samples' };
await writeFile(path.join(evidence, `${mode}-plan.json`), JSON.stringify(plan, null, 2), { flag: 'wx' });
const h = await launch(`ac-${mode}`, { persistentContexts: true, fixture: 'idb-acceptance-fixture.js' });
const results = [], attempts = Object.fromEntries(configurations.map(c => [c.id, 0]));
let finalStatus = 'INCOMPLETE';
const bytes = value => Buffer.byteLength(JSON.stringify(value));
for (const [key, value] of Object.entries(fixtures)) await h.save('fixture-' + key, { sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'), envelopeBytes: bytes(value.envelope), state: value });
function command(op, f) {
  const id = f.envelope.positions[0].id;
  return op === 'save' ? structuredClone(addCommand) : op === 'read' ? { type: 'read' }
    : op === 'rename' ? { type: 'rename', id, title: '🀄'.repeat(59) + 'B' }
      : op === 'preferences' ? { type: 'preferences', id, preferences: { humanSide: 'red', difficulty: 'hard' } } : { type: 'delete', id };
}
async function page(durability) { return h.tab(undefined, `${h.origin}/?durability=${durability}`); }
async function read(tab) { const r = await h.evaluate(tab, 'poc.read()', true); assert.equal(r.ok, true, JSON.stringify(r)); return r.snapshot; }
async function seed(tab, f) { await h.evaluate(tab, `poc.direct(${JSON.stringify(f.envelope)},${JSON.stringify(f.metadata)})`, true); }
async function measure(tab, id, cmd) {
  const eventIndex = h.events.length, start = performance.now();
  const pending = h.evaluate(tab, `ac.run(${JSON.stringify(id)},${JSON.stringify(cmd)})`, true);
  const measured = await deadline(pending, 20000), received = performance.now();
  const events = h.events.slice(eventIndex).filter(e => e.sessionId === tab.sessionId && e.trace?.caseId === id);
  const apiEvent = events.find(e => e.trace.type === 'api-complete');
  const primary = measured.transactions?.at(-1), native = events.find(e => e.trace.type === 'native-terminal' && e.trace.transactionId === primary?.id);
  return { ...measured, externalStart: start, externalMs: apiEvent ? apiEvent.externalPerf - start : null,
    externalNativeMs: native ? native.externalPerf - start : null, externalRoundtripMs: received - start, native, events };
}
function assertMeasurement(m, op, connection) {
  assert.ok(Number.isFinite(m.apiMs) && m.apiMs >= 0); assert.ok(Number.isFinite(m.transactionMs) && m.transactionMs >= 0);
  assert.ok(Number.isFinite(m.externalMs)); assert.equal(m.result.nativeEvent, 'COMPLETE');
  if (op === 'read') assert.equal(m.result.ok, true); else assert.equal(m.result.status, 'COMMITTED');
  assert.equal(m.transactions.length, op === 'read' ? 1 : 2);
  for (const t of m.transactions) { assert.equal(t.terminal, 'COMPLETE'); assert.equal(t.trusted, true); assert.ok(t.start <= t.commitCalled && t.commitCalled <= t.end); }
  assert.equal(m.events.filter(e => e.trace.type === 'native-terminal').length, m.transactions.length);
  assert.equal(m.native.trace.trusted, true);
  if (connection) assert.equal(m.opens.length, connection === 'cold' ? 1 : 0);
}
function compact(m) { return { ...m, result: m.result ? { ...m.result, snapshot: undefined } : undefined }; }
async function persist() {
  await h.save('results', { version: ACCEPTANCE_VERSION, status: finalStatus, planned: plan.samples, attempts, results,
    groups: mode === 'baseline' ? Object.fromEntries(groups().map(g => [g.id, summary(results.filter(r => r.group === g.id))])) : null,
    FORMAL_SLO: 'NOT_CERTIFIED' });
}
try {
  if (mode === 'baseline') {
    const helper = await page('default'), workers = new Map();
    for (const g of groups()) workers.set(g.id, await page(g.durability));
    for (const step of planned) {
      const g = groups().find(g => g.id === step.group), tab = workers.get(g.id), fixtureKey = `${g.metadata}-${step.op === 'save' ? 'add' : 'full'}`;
      const f = fixtures[fixtureKey], cmd = command(step.op, f); let observed = null, after = null;
      const record = { ...step, fixtureKey, envelopeBytes: bytes(f.envelope), beforeRevision: f.envelope.revision, beforeWitness: f.metadata.commits.length, status: 'PENDING' };
      try {
        await seed(helper, f); await h.evaluate(tab, `ac.reset(${g.connection === 'cold'})`);
        if (g.connection === 'reused') assert.equal((await h.evaluate(tab, 'ac.warm()', true)).ok, true);
        observed = await measure(tab, step.id, cmd);
        Object.assign(record, { apiMs: observed.apiMs, transactionMs: observed.transactionMs, externalMs: observed.externalMs,
          externalNativeMs: observed.externalNativeMs, externalRoundtripMs: observed.externalRoundtripMs, operationId: observed.token?.operationId ?? null });
        if (observed.status === 'DEADLINE_EXCEEDED') throw Object.assign(Error('Observation deadline; transaction not cancelled'), { pending: true });
        if (observed.result?.status === 'UNKNOWN') throw Object.assign(Error('UNKNOWN outcome'), { unknown: true });
        assertMeasurement(observed, step.op, g.connection);
        assert.equal(observed.transactions.at(-1).durability, g.durability);
        after = await read(helper); assertTransition(f, after, observed.token); assert.deepEqual(observed.result.snapshot, after);
        Object.assign(record, { status: 'SUCCESS', revision: after.envelope.revision, witness: after.metadata.commits.length, safe: true });
        await h.save(step.id, { record, command: cmd, observed: compact(observed), after }); results.push(record);
        if (results.length % 20 === 0) { await persist(); console.log(JSON.stringify({ mode, completed: results.length, last: record, partial: summary(results) })); }
      } catch (error) {
        record.status = error.pending ? 'PENDING' : error.unknown ? 'UNKNOWN' : 'FAILED'; record.error = error.message;
        results.push(record); await h.save(step.id, { record, command: cmd, observed: observed && compact(observed), after }); throw error;
      }
    }
    assert.equal(results.length, 800); finalStatus = 'PASS';
  } else {
    for (const step of planned) {
      const fixtureKey = `${step.metadata}-${step.op === 'save' ? 'add' : 'full'}`, f = fixtures[fixtureKey];
      let pair, frozen, aToken, injected = false;
      while (attempts[step.id] < 24 && !injected) {
        const attempt = ++attempts[step.id]; pair = { a: await page(step.durability), b: await page(step.durability) };
        await seed(pair.a, f);
        aToken = await h.evaluate(pair.a, `poc.prepare(${JSON.stringify({ type: 'rename', id: f.envelope.positions[0].id, title: 'A obsolete' })})`, true);
        const started = h.start(pair.a, aToken); frozen = await h.freeze(pair.a); await started;
        const phase = frozen.freezeEvent?.phases[aToken.operationId];
        injected = frozen.commandAcknowledged && frozen.freezeEvent?.isTrusted === true && phase?.phase === 'read-pending'
          && phase.requests.length === 2 && phase.requests.every(s => s === 'pending') && frozen.probeDuringFreeze === null;
        await h.save(`injection-${step.id}-${attempt}`, { step, attempt, injected, frozen, aToken });
        if (!injected) { await h.resume(pair.a); await h.dispose(pair); }
      }
      if (!injected) throw Object.assign(Error(`INCOMPLETE injection budget ${step.id}`), { incomplete: true });
      const id = `F-${step.id}-${String(step.round + 1).padStart(2, '0')}`, cmd = command(step.op, f);
      let observed = null, after = null;
      const record = { id, group: step.id, round: step.round, op: step.op, fixtureKey, envelopeBytes: bytes(f.envelope), injectionConfirmed: true, status: 'PENDING' };
      try {
        const beforeEvents = h.events.length;
        observed = await measure(pair.b, id, cmd); record.elapsedMs = observed.externalNativeMs;
        Object.assign(record, { apiMs: observed.apiMs, transactionMs: observed.transactionMs, externalMs: observed.externalMs,
          over2000: record.elapsedMs > 2000, over3000: record.elapsedMs > 3000, over5000: record.elapsedMs > 5000,
          committed: observed.result?.status === 'COMMITTED', operationId: observed.token?.operationId });
        if (observed.status === 'DEADLINE_EXCEEDED') throw Object.assign(Error('B still pending at observation deadline'), { pending: true });
        assertMeasurement(observed, step.op);
        // B independently reads while A is still frozen. No resume occurs before the gate or verification.
        after = await read(pair.b); assertTransition(f, after, observed.token); assert.deepEqual(after, observed.result.snapshot);
        const probeId = `${id}-after`; await h.evaluate(pair.a, `poc.probe(${JSON.stringify(probeId)})`);
        const probe = await h.until(e => e.sessionId === pair.a.sessionId && e.trace?.type === 'probe' && e.trace.id === probeId, 100, beforeEvents);
        record.aFrozenUntilComplete = !h.events.slice(beforeEvents).some(e => e.sessionId === pair.a.sessionId && e.trace?.type === 'resume') && !probe.trace;
        const inspect = await h.evaluate(pair.a, 'poc.inspect()'); record.aFrozen = { before: frozen, after: inspect, afterProbe: probe };
        Object.assign(record, { safe: true, revision: after.envelope.revision, witness: after.metadata.commits.length });
        record.gate = freezeGate(record); record.status = record.gate === 'PASS' ? 'SUCCESS' : 'FAILED';
        // Record the true outcome even when the approved timing gate fails, then stop.
        await h.save(id, { record, observed: compact(observed), after, aToken });
        if (record.gate !== 'PASS') throw Error('Freeze gate failed');
        await h.resume(pair.a); assert.equal((await h.evaluate(pair.a, 'poc.resume()', true)).ok, true);
        assert.deepEqual(await read(pair.a), after);
        const old = await h.evaluate(pair.b, `poc.verify(${JSON.stringify(aToken)})`, true);
        assert.equal(old.status, 'NOT_COMMITTED_OBSERVED'); assert.equal(old.nativeEvent, 'UNKNOWN');
        record.resumeSafe = true; record.oldOutcome = old; results.push(record);
        await h.save(id, { record, observed: compact(observed), after, aToken }); await persist();
        console.log(JSON.stringify({ mode, completed: results.length, id, elapsedMs: record.elapsedMs, over2000: record.over2000, gate: record.gate, attempts: attempts[step.id] }));
        await h.dispose(pair);
      } catch (error) {
        record.status = error.pending ? 'PENDING' : 'FAILED'; record.error = error.message; if (!results.includes(record)) results.push(record);
        await h.save(id, { record, observed: observed && compact(observed), after, aToken }); throw error;
      }
    }
    assert.equal(results.length, 48); finalStatus = 'PASS';
  }
} catch (error) {
  finalStatus = error.incomplete ? 'INCOMPLETE' : 'BLOCKED';
  await h.save('failure', { status: finalStatus, error: error.message, stack: error.stack, completed: results.length }); process.exitCode = 1;
} finally {
  const errors = h.events.filter(e => e.method === 'Runtime.exceptionThrown' || ['page-error', 'unhandled-rejection'].includes(e.trace?.type));
  await h.save('console-errors', errors); if (errors.length) { finalStatus = 'BLOCKED'; process.exitCode = 1; }
  await persist(); console.log(JSON.stringify({ mode, status: finalStatus, completed: results.length, attempts, FORMAL_SLO: 'NOT_CERTIFIED' })); await h.close();
}
