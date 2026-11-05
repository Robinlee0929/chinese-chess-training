import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCustomPositionRepository } from './custom-position-repository.js';
import { createCustomPositionIDB, validateCustomPositionIDBState, observeCustomPositionOperation } from './custom-position-idb.js';
import { applyCustomPositionOperation } from './custom-position-store.js';
import { applyMigrationTransition } from './custom-position-migration-state.js';
import { initialBoard } from './game.js';

const source = readFileSync(new URL('./custom-position-repository.js', import.meta.url), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-11-04T00:00:00.000Z';
const position = () => ({ title: '局面', initialBoard: initialBoard(), sideToMove: 'red', playPreferences: { humanSide: 'black', difficulty: 'hard' } });
function activeState(instance = id(1)) {
  const command = { type: 'initialize', migrationId: 'empty-v1', sourceFingerprint: null, envelope: { version: 1, revision: 0, positions: [] } };
  const s = applyMigrationTransition(null, { operationId: id(2), storageInstanceId: instance, expectedRevision: null, preparedAt: time, command });
  return validateCustomPositionIDBState(s.envelope, s.metadata);
}
const expected = snapshot => ({ snapshot, storageInstanceId: snapshot.metadata.storageInstanceId, expectedRevision: snapshot.envelope.revision });

// Unit scheduling double only. Native IDB atomicity/cancellation are exercised
// separately by tools/custom-position-repository-browser-test.mjs.
function harness(mutateSource = s => s) {
  let state = activeState(), sequence = 10, writeCount = 0, inspectCount = 0;
  const controls = { beforeWrite: null, afterCommit: null, writeResult: null, inspectResult: null, beforeInspect: null };
  const adapters = [], pending = [], calls = [], legacy = { writes: 0, getItem: () => null, setItem() { this.writes++; assert.fail('legacy write'); } };
  const uuid = () => id(sequence++);
  function adapter(options) {
    assert.equal(options.initializeEmpty, false);
    const real = createCustomPositionIDB({ initializeEmpty: false, randomUUID: uuid, now: () => time });
    const used = new WeakSet(); let suspended = false;
    const a = { prepare: real.prepare, dispose() { suspended = true; real.dispose(); }, suspend() { suspended = true; real.suspend(); return { attempts: [] }; },
      async write(t) {
        writeCount++; calls.push(t); if (used.has(t)) return { status: 'FAILED', code: 'INVALID_OR_USED_OPERATION', nativeEvent: 'UNKNOWN' }; used.add(t);
        await controls.beforeWrite?.(a, t);
        if (suspended) return { status: 'ABORTED_OBSERVED', code: 'NATIVE_ABORT', nativeEvent: 'ABORT' };
        if (controls.writeResult) return controls.writeResult;
        if (t.storageInstanceId !== state.metadata.storageInstanceId) return { status: 'FAILED', code: 'STORAGE_INSTANCE_CHANGED', nativeEvent: 'ABORT' };
        if (t.expectedRevision !== state.envelope.revision) return { status: 'REVISION_CONFLICT', code: 'REVISION_CONFLICT', nativeEvent: 'ABORT' };
        const old = state, applied = applyCustomPositionOperation(old.envelope, t.command, { now: () => t.preparedAt, idFactory: () => t.positionId });
        const envelope = { ...applied.envelope, revision: old.envelope.revision + 1 }, key = applied.result.position?.id ?? t.command.id;
        const i = old.envelope.positions.findIndex(p => p.id === key), j = envelope.positions.findIndex(p => p.id === key);
        const receipt = { operation: t, revision: envelope.revision, committedAt: time, delta: { index: i < 0 ? j : i, before: old.envelope.positions[i] ?? null, after: envelope.positions[j] ?? null } };
        state = validateCustomPositionIDBState(envelope, { ...old.metadata, commits: [...old.metadata.commits, receipt], committedOperationIds: [...old.metadata.committedOperationIds, t.operationId], lastCommit: { operationId: t.operationId, revision: envelope.revision, committedAt: time } });
        const result = { status: 'COMMITTED', code: 'TRANSACTION_COMPLETE', nativeEvent: 'COMPLETE', snapshot: state };
        await controls.afterCommit?.(a, t); return result;
      },
      verifyOutcome: async t => observeCustomPositionOperation(state, t),
      verifyMigrationOutcome: async () => ({ status: 'UNKNOWN', nativeEvent: 'UNKNOWN' }) };
    adapters.push(a); return a;
  }
  function migration() {
    return { async inspect() { inspectCount++; await controls.beforeInspect?.(); return controls.inspectResult ?? { state: 'ACTIVE', snapshot: state, warnings: [] }; },
      suspend() { return { attempts: [] }; }, dispose() {}, initialize: async () => ({ state: 'ACTIVE', snapshot: state, outcome: 'COMMITTED', nativeEvent: 'COMPLETE' }),
      confirmMigration: async () => ({ state: 'ACTIVE', snapshot: state, outcome: 'COMMITTED', nativeEvent: 'COMPLETE' }) };
  }
  const factory = new Function('createCustomPositionIDB', 'createCustomPositionMigration',
    mutateSource(source).replace(/^import .*;\r?\n/gm, '').replace('export function', 'function') + '\nreturn createCustomPositionRepository;')(adapter, migration);
  const repository = factory({ randomUUID: uuid, storage: legacy }), scope = repository.createScope();
  return { repository, scope, controls, adapters, pending, calls, legacy, get state() { return state; }, set state(value) { state = value; },
    get writes() { return writeCount; }, get reads() { return inspectCount; }, expected: () => expected(state) };
}
async function seed(h) { const handle = h.scope.savePosition(position(), h.expected()), result = await handle.completion; assert.equal(result.status, 'SUCCESS'); return result.position.id; }

test('Repository UI cutover leaves legacy synchronous session/coordinator disconnected', () => {
  for (const file of ['saved-position-session.js', 'custom-position-coordinator.js']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /custom-position-repository/);
  for (const file of ['main.js', 'saved-position-ui.js', 'saved-position-async-session.js']) assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /from ['"].*(custom-position-coordinator|saved-position-session)\.js/);
  assert.doesNotMatch(source, /startConfiguredNormalGame\(|new Worker\(|setItem\(|setTimeout\(/);
});
test('CRUD maps to the actual adapter commands and returns authoritative receipts', async () => {
  const h = harness(), saved = h.scope.savePosition(position(), h.expected());
  const r = await saved.completion; assert.equal(r.status, 'SUCCESS'); assert.equal(r.revision, 1); assert.equal(r.receipt.operation.operationId, saved.identity.operationId);
  assert.equal(r.position.initialBoard.flat().length, 90); assert.equal(h.scope.canApply(saved, r), true);
  assert.equal((await h.scope.getPosition(r.position.id, h.expected()).completion).position.title, '局面');
  await h.scope.renamePosition(r.position.id, '新名稱', h.expected()).completion;
  await h.scope.updatePlayPreferences(r.position.id, { humanSide: 'red', difficulty: 'easy' }, h.expected()).completion;
  await h.scope.deletePosition(r.position.id, h.expected()).completion;
  assert.deepEqual(h.calls.map(t => t.command.type), ['save', 'rename', 'preferences', 'delete']);
  assert.equal((await h.scope.loadAll().completion).snapshot.envelope.positions.length, 0); assert.equal(h.state.envelope.revision, 4); assert.equal(h.legacy.writes, 0);
});
test('no-op receipts still advance revision and witness', async () => {
  const h = harness(), id = await seed(h), r = await h.scope.renamePosition(id, '局面', h.expected()).completion;
  assert.equal(r.revision, 2); assert.equal(h.state.metadata.commits.length, 2); assert.deepEqual(r.receipt.delta.before, r.receipt.delta.after);
});
test('input boards are synchronously detached, returned records are immutable', async () => {
  const h = harness(), input = position(), handle = h.scope.savePosition(input, h.expected()); input.initialBoard[0][0] = null;
  const r = await handle.completion; assert.equal(r.position.initialBoard[0][0].type, 'R'); assert.throws(() => r.position.initialBoard[0][0].type = 'P', TypeError);
});
for (const mutate of [o => delete o.expectedRevision, o => delete o.storageInstanceId, o => o.expectedRevision++, o => o.snapshot = null]) test('explicit original snapshot fence required: '+mutate, async () => {
  const h = harness(), options = h.expected(); mutate(options); const r = await h.scope.savePosition(position(), options).completion; assert.equal(r.status, 'INVALID_DATA'); assert.equal(h.writes, 0);
});
test('stale revision is not silently replaced after a fresh inspection', async () => {
  const h = harness(), before = h.expected(); await seed(h); const r = await h.scope.savePosition(position(), before).completion;
  assert.equal(r.status, 'REVISION_CONFLICT'); assert.equal(h.calls.at(-1).expectedRevision, 0); assert.equal(h.state.envelope.revision, 1);
});
test('instance replacement after commit rejects the UI result but preserves COMMITTED', async () => {
  const h = harness(); h.controls.afterCommit = () => { h.state = activeState(id(500)); };
  const handle = h.scope.savePosition(position(), h.expected()), r = await handle.completion;
  assert.equal(r.status, 'UNKNOWN'); assert.equal(r.code, 'STORAGE_INSTANCE_CHANGED'); assert.equal(r.persistence.status, 'COMMITTED'); assert.equal(h.scope.canApply(handle, r), false);
});
test('cancelling before submission never writes and has no fabricated native abort', async () => {
  const h = harness(), handle = h.scope.savePosition(position(), h.expected()); handle.cancel(); const r = await handle.completion;
  assert.equal(r.status, 'CANCELLED_UI_INTENT'); assert.equal(r.nativeEvent, 'UNKNOWN'); assert.equal(r.persistence, null); assert.equal(h.writes, 0);
});
test('detected instance replacement also invalidates older successful handles', async () => {
  const h = harness(), handle = h.scope.savePosition(position(), h.expected()), result = await handle.completion;
  assert.equal(h.scope.canApply(handle,result),true); h.state=activeState(id(500));
  assert.equal((await h.scope.loadAll().completion).status,'UNKNOWN'); assert.equal(h.scope.canApply(handle,result),false);
  assert.equal((await h.scope.savePosition(position(),h.expected()).completion).code,'STORAGE_INSTANCE_CHANGED'); assert.equal(h.writes,1);
});
test('precommit cancellation aborts only this operation; another scope can commit', async () => {
  const h = harness(); let a; h.controls.beforeWrite = () => { a.cancel(); h.controls.beforeWrite = null; };
  a = h.scope.savePosition(position(), h.expected()); const r = await a.completion;
  assert.equal(r.persistence.status, 'ABORTED_OBSERVED'); assert.equal(h.state.envelope.revision, 0);
  const other = h.repository.createScope(), b = await other.savePosition(position(), h.expected()).completion; assert.equal(b.status, 'SUCCESS'); assert.equal(h.state.envelope.revision, 1);
});
test('disappeared database invalidates prior successful handles without implicit initialization', async () => {
  const h = harness(), handle = h.scope.savePosition(position(), h.expected()), result = await handle.completion;
  h.controls.inspectResult = { state: 'UNINITIALIZED', snapshot: null };
  assert.equal((await h.scope.loadAll().completion).code, 'STORAGE_INSTANCE_CHANGED');
  assert.equal(h.scope.canApply(handle, result), false); assert.equal(h.writes, 1);
});
test('cancellation after commit does not claim rollback or permit challenge', async () => {
  const h = harness(); let handle; h.controls.afterCommit = () => handle.cancel(); handle = h.scope.savePosition(position(), h.expected());
  const r = await handle.completion; assert.equal(r.status, 'CANCELLED_UI_INTENT'); assert.equal(r.persistence.status, 'COMMITTED'); assert.equal(r.nativeEvent, 'COMPLETE'); assert.equal(h.scope.canApply(handle, r), false); assert.equal(h.state.envelope.revision, 1);
});
test('completed preferences are not continuing user consent after scope close', async () => {
  const h = harness(), key = await seed(h), handle = h.scope.updatePlayPreferences(key, { humanSide: 'red', difficulty: 'easy' }, h.expected()), r = await handle.completion;
  assert.equal(h.scope.canApply(handle, r), true); h.scope.close(); assert.equal(h.scope.canApply(handle, r), false); assert.equal(r.persistence.status, 'COMMITTED');
});
test('old generation/dialog/session context cannot apply a late result to new session', async () => {
  const h = harness(), gameSession = {}, dialog = {}; let generation = 1, starts = 0;
  const scope = h.repository.createScope({ uiGeneration: 1, dialogIdentity: dialog, gameSessionIdentity: gameSession, isCurrent: c => c.uiGeneration === generation });
  h.controls.afterCommit = () => { generation++; };
  const handle = scope.savePosition(position(), h.expected()), r = await handle.completion;
  if (scope.canApply(handle, r)) starts++; assert.equal(starts, 0); assert.equal(r.persistence.status, 'COMMITTED'); assert.equal(handle.identity.context.gameSessionIdentity, gameSession); assert.equal(Object.isFrozen(gameSession), false);
});
test('UNKNOWN is not abort and explicit verification never replays', async () => {
  const h = harness(); h.controls.writeResult = { status: 'UNKNOWN', code: 'EVENT_NOT_OBSERVED', nativeEvent: 'UNKNOWN' };
  const handle = h.scope.savePosition(position(), h.expected()), r = await handle.completion;
  assert.equal(r.status, 'UNKNOWN'); assert.equal(r.persistence.status, 'UNKNOWN'); assert.equal((await handle.verify()).status, 'UNKNOWN'); assert.equal(h.writes, 1);
});
test('serialized verification keeps nativeEvent UNKNOWN after confirmed persistence', async () => {
  const h = harness(), handle = h.scope.savePosition(position(), h.expected()), r = await handle.completion;
  const observed = await h.repository.verifyOutcome(JSON.parse(JSON.stringify(r.token)));
  assert.equal(observed.status, 'COMMITTED'); assert.equal(observed.nativeEvent, 'UNKNOWN'); assert.equal(r.nativeEvent, 'COMPLETE'); assert.equal(h.writes, 1);
});
for (const state of ['STAGED', 'MIGRATION_REQUIRED', 'UNINITIALIZED', 'UNAVAILABLE']) test('fail-closed without empty initialization: '+state, async () => {
  const h = harness(); h.controls.inspectResult = { state, snapshot: null };
  assert.equal((await h.scope.loadAll().completion).status, state === 'UNINITIALIZED' ? 'MIGRATION_REQUIRED' : state);
  assert.notEqual((await h.scope.savePosition(position(), h.expected()).completion).status, 'SUCCESS'); assert.equal(h.writes, 0);
});
test('ACTIVE plus legacy mismatch is blocked, no overwrite/fallback', async () => {
  const h = harness(); h.controls.inspectResult = { state: 'ACTIVE', snapshot: h.state, warnings: ['LEGACY_SOURCE_DIFFERS_OR_UNREADABLE'] };
  const r = await h.scope.savePosition(position(), h.expected()).completion; assert.equal(r.status, 'UNAVAILABLE'); assert.equal(h.writes, 0); assert.equal(h.legacy.writes, 0);
});
test('unavailable real IDB cannot initialize or write localStorage implicitly', async () => {
  const r = createCustomPositionRepository({ indexedDB: () => undefined, storage: { getItem() { assert.fail('fallback'); }, setItem() { assert.fail('fallback'); } } });
  assert.equal((await r.createScope().loadAll().completion).status, 'UNAVAILABLE'); r.dispose();
});
test('same completion promise cannot submit a command twice', async () => {
  const h = harness(), handle = h.scope.savePosition(position(), h.expected()); const [a,b] = await Promise.all([handle.completion, handle.completion]); assert.equal(a,b); assert.equal(h.writes,1);
});
test('lifecycle suspends old scope; recovery reads and never resubmits', async () => {
  const h = harness(), handle = h.scope.savePosition(position(), h.expected()); h.repository.suspend('freeze'); await handle.completion;
  await h.repository.resume(); assert.equal(h.writes,0); assert.equal((await h.scope.loadAll().completion).status,'CANCELLED_UI_INTENT'); assert.equal((await h.repository.createScope().loadAll().completion).status,'SUCCESS');
});
test('lifecycle also disposes an independent witness verifier and forbids frozen verification', async () => {
  const h = harness(), handle = h.scope.savePosition(position(), h.expected()), result = await handle.completion;
  const pending = handle.verify(), verifier = h.adapters.at(-1); let disposed = 0;
  const original = verifier.dispose; verifier.dispose = () => { disposed++; original(); };
  h.repository.suspend('freeze'); assert.ok(disposed > 0); await pending;
  assert.equal((await h.repository.verifyOutcome(result.token)).code, 'SUSPENDED'); assert.equal(h.writes, 1);
});

const mutants = {
  'false-success': s => s.replace("unavailable.has(raw.code) ? 'UNAVAILABLE' : 'INVALID_DATA'", "'SUCCESS'"),
  'replace-stale-revision': s => s.replace('entry.persistence = await adapter.write(entry.token);', 'entry.token = adapter.prepare(raw.snapshot, entry.token.command); entry.persistence = await adapter.write(entry.token);'),
  'cancel-replay': s => s.replace("if (entry.cancelled || !current()) return { status: 'CANCELLED_UI_INTENT' };", "if (entry.cancelled || !current()) { const retry = newAdapter(); await retry.write(retry.prepare(raw.snapshot, entry.token.command)); return {status:'CANCELLED_UI_INTENT'}; }"),
  'unknown-is-abort': s => s.replace('entry.persistence = await adapter.write(entry.token);', "entry.persistence = await adapter.write(entry.token); if (entry.persistence.status === 'UNKNOWN') entry.persistence = {...entry.persistence,status:'ABORTED_OBSERVED'};"),
  'accept-old-instance': s => s.replaceAll("instanceLost = true; throw error('STORAGE_INSTANCE_CHANGED');", 'return;'),
};
for (const [name, mutation] of Object.entries(mutants)) test('behavioral negative control: '+name, async () => {
  assert.notEqual(mutation(source),source); const h=harness(mutation); let handle, result;
  if(name==='false-success') { h.controls.writeResult={status:'FAILED',code:'INVALID_DATA',nativeEvent:'ABORT'}; result=await h.scope.savePosition(position(),h.expected()).completion; assert.throws(()=>assert.notEqual(result.status,'SUCCESS'),{code:'ERR_ASSERTION'}); }
  if(name==='replace-stale-revision') { const before=h.expected();await seed(h);result=await h.scope.savePosition(position(),before).completion;assert.throws(()=>assert.equal(result.status,'REVISION_CONFLICT'),{code:'ERR_ASSERTION'}); }
  if(name==='cancel-replay') { h.controls.beforeWrite=()=>{handle.cancel();h.controls.beforeWrite=null;};handle=h.scope.savePosition(position(),h.expected());await handle.completion;assert.throws(()=>assert.equal(h.state.envelope.revision,0),{code:'ERR_ASSERTION'}); }
  if(name==='unknown-is-abort') {h.controls.writeResult={status:'UNKNOWN',nativeEvent:'UNKNOWN'};result=await h.scope.savePosition(position(),h.expected()).completion;assert.throws(()=>assert.equal(result.persistence.status,'UNKNOWN'),{code:'ERR_ASSERTION'});}
  if(name==='accept-old-instance') {h.controls.afterCommit=()=>{h.state=activeState(id(500));};result=await h.scope.savePosition(position(),h.expected()).completion;assert.throws(()=>assert.equal(result.status,'UNKNOWN'),{code:'ERR_ASSERTION'});}
});
