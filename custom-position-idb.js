import { validateCustomPositionEnvelope, applyCustomPositionOperation } from './custom-position-store.js?v=66a2321529';
import { validateMigrationState, applyMigrationTransition, observeMigration } from './custom-position-migration-state.js?v=66a2321529';

export const CUSTOM_POSITION_DATABASE = 'chinese-chess-training:custom-positions';
export const CUSTOM_POSITION_DATABASE_VERSION = 1;
export const CUSTOM_POSITION_WITNESS_LIMIT = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const empty = () => ({ version: 1, revision: 0, positions: [] });
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const deeplyFrozen = new WeakSet(), validatedStates = new WeakSet();
const freeze = value => {
  if (value && typeof value === 'object' && !deeplyFrozen.has(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value); deeplyFrozen.add(value);
  }
  return value;
};
// Only objects validated and deeply frozen by this module are reusable. Copies,
// caller-frozen objects and every fresh IDB read still receive full validation.
const validatedState = state => validatedStates.has(state) ? state
  : validateCustomPositionIDBState(state.envelope, state.metadata);

// Reject accessors/cycles/non-data before copying. Stable order is used for
// exact intent comparison, not a lossy hash or an operation-ID collision guess.
function data(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) fail('INVALID_DATA');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_DATA');
  if (Array.isArray(value) && (Object.keys(value).length !== value.length
    || Object.keys(value).some(k => !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= value.length))) fail('INVALID_DATA');
  seen.add(value); const result = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value).sort()) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_DATA');
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(d, 'value')) fail('INVALID_DATA');
    result[key] = data(d.value, seen);
  }
  seen.delete(value); return result;
}
const exact = value => JSON.stringify(data(value));
function fields(value, names) { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join('|') !== [...names].sort().join('|')) fail('INVALID_METADATA'); }
function revision(n) { if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_REVISION'); }
function uuid(id) { if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_ID'); return id.toLowerCase(); }
function timestamp(s) { if (typeof s !== 'string' || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) fail('INVALID_TIMESTAMP'); return s; }
function tokenData(raw) {
  const t = data(raw);
  fields(t, ['storageInstanceId', 'expectedRevision', 'operationId', 'command', 'preparedAt', 'positionId']);
  uuid(t.storageInstanceId); uuid(t.positionId); revision(t.expectedRevision); timestamp(t.preparedAt);
  const prefix = `${t.storageInstanceId}/${t.expectedRevision}/`;
  if (typeof t.operationId !== 'string' || !t.operationId.startsWith(prefix)) fail('INVALID_OPERATION_ID');
  uuid(t.operationId.slice(prefix.length));
  return t;
}
function initialMetadata(id) {
  return { version: 1, storageInstanceId: id, baseEnvelope: empty(), committedOperationIds: [], commits: [], lastCommit: null };
}
function applyDelta(envelope, receipt) {
  // Internal only: callers supply a private positions array. Records are never
  // mutated; they belong to the detached metadata or a validated frozen base.
  const next = envelope, d = receipt.delta;
  fields(d, ['index', 'before', 'after']);
  if (!Number.isInteger(d.index) || d.index < 0 || d.index > next.positions.length) fail('INVALID_WITNESS');
  if (d.before !== null) {
    if (exact(next.positions[d.index] ?? null) !== exact(d.before)) fail('WITNESS_DATA_MISMATCH');
    next.positions.splice(d.index, 1);
  }
  if (d.after !== null) next.positions.splice(d.index, 0, d.after);
  next.revision = receipt.revision; return next;
}

function validateReceipt(replay, receipt, storageInstanceId) {
  const r = receipt; fields(r, ['operation', 'revision', 'committedAt', 'delta']);
  const t = tokenData(r.operation); timestamp(r.committedAt); revision(r.revision);
  if (t.storageInstanceId !== storageInstanceId || t.expectedRevision !== replay.revision
    || r.revision !== replay.revision + 1) fail('INVALID_WITNESS');
  const d = r.delta; fields(d, ['index', 'before', 'after']);
  const check = applyCustomPositionOperation({ version: 1, revision: replay.revision,
    positions: d.before === null ? [] : [d.before] }, t.command,
  { now: () => t.preparedAt, idFactory: () => t.positionId });
  if (t.command.type === 'delete' && !check.result.deleted) fail('INVALID_WITNESS');
  if (exact(check.envelope.positions) !== exact(d.after === null ? [] : [d.after])) fail('WITNESS_INTENT_MISMATCH');
  if (d.before === null && d.index !== replay.positions.length) fail('INVALID_WITNESS');
  applyDelta(replay, r); return t.operationId;
}

export function validateCustomPositionIDBState(rawEnvelope, rawMetadata) {
  const envelope = validateCustomPositionEnvelope(data(rawEnvelope)), metadata = data(rawMetadata);
  fields(metadata, ['version', 'storageInstanceId', 'baseEnvelope', 'committedOperationIds', 'commits', 'lastCommit',
    ...(Object.hasOwn(metadata, 'migration') ? ['migration'] : [])]);
  if (metadata.version !== 1) fail('UNSUPPORTED_METADATA_VERSION'); uuid(metadata.storageInstanceId);
  const base = validateCustomPositionEnvelope(metadata.baseEnvelope);
  if (!Array.isArray(metadata.commits) || !Array.isArray(metadata.committedOperationIds)
    || metadata.commits.length > CUSTOM_POSITION_WITNESS_LIMIT
    || metadata.committedOperationIds.length !== metadata.commits.length) fail('INVALID_WITNESS');
  const replay = { ...base, positions: [...base.positions] }, ids = new Set();
  for (let i = 0; i < metadata.commits.length; i++) {
    const id = validateReceipt(replay, metadata.commits[i], metadata.storageInstanceId);
    if (ids.has(id) || metadata.committedOperationIds[i] !== id) fail('INVALID_WITNESS');
    ids.add(id);
  }
  if (exact(replay) !== exact(envelope)) fail('WITNESS_DATA_MISMATCH');
  const last = metadata.commits.at(-1);
  const expectedLast = last ? { operationId: last.operation.operationId, revision: last.revision, committedAt: last.committedAt } : null;
  if (exact(expectedLast) !== exact(metadata.lastCommit)) fail('INVALID_WITNESS');
  if (Object.hasOwn(metadata, 'migration')) validateMigrationState(envelope, metadata);
  const state = freeze({ envelope, metadata });
  validatedStates.add(state); return state;
}

// A private extension of the fully validated state read INSIDE this transaction.
// The immutable prefix is reused by identity, never fetched from a revision cache.
// The complete new envelope comes from the domain operation's full validation;
// its only subsequent change is the checked revision increment. Reuse those
// immutable records while verifying the new intent/delta/sequence. The old
// prefix and its eviction base were already verified; no external metadata enters.
function appendValidatedReceipt(previous, envelope, receipt) {
  if (!validatedStates.has(previous)) fail('INVALID_WITNESS');
  const replay = { ...previous.envelope, positions: [...previous.envelope.positions] };
  const id = validateReceipt(replay, receipt, previous.metadata.storageInstanceId);
  if (previous.metadata.committedOperationIds.includes(id)) fail('INVALID_WITNESS');
  if (exact(replay) !== exact(envelope)) fail('WITNESS_DATA_MISMATCH');
  const commits = [...previous.metadata.commits, receipt];
  let baseEnvelope = previous.metadata.baseEnvelope;
  if (commits.length > CUSTOM_POSITION_WITNESS_LIMIT) {
    baseEnvelope = { ...baseEnvelope, positions: [...baseEnvelope.positions] };
    applyDelta(baseEnvelope, commits.shift());
  }
  const metadata = { ...previous.metadata, baseEnvelope, commits,
    committedOperationIds: commits.map(r => r.operation.operationId),
    lastCommit: { operationId: id, revision: receipt.revision, committedAt: receipt.committedAt } };
  const state = freeze({ envelope, metadata }); validatedStates.add(state); return state;
}

// Independent observation does not fabricate a native event. An absent witness
// is conclusive only while fully covered AND a later revision fences this token.
export function observeCustomPositionOperation(state, rawToken) {
  const nativeEvent = 'UNKNOWN'; // Persistence alone cannot establish event delivery.
  try {
    const t = tokenData(rawToken), s = validatedState(state);
    const outcome = (status, code, receipt) => freeze({ status, code, nativeEvent, receipt });
    if (t.storageInstanceId !== s.metadata.storageInstanceId) return outcome('UNKNOWN', 'STORAGE_INSTANCE_CHANGED');
    const r = s.metadata.commits.find(r => r.operation.operationId === t.operationId);
    if (r) return exact(r.operation) === exact(t) ? outcome('COMMITTED', 'COMMITTED_OBSERVED', r) : outcome('UNKNOWN', 'OPERATION_ID_COLLISION');
    if (t.expectedRevision < s.metadata.baseEnvelope.revision) return outcome('UNKNOWN', 'WITNESS_EXPIRED');
    if (s.envelope.revision > t.expectedRevision) return outcome('NOT_COMMITTED_OBSERVED', 'REVISION_FENCED');
    return outcome('UNKNOWN', 'NO_COMMIT_FENCE');
  } catch (error) { return freeze({ status: 'UNKNOWN', code: error.code || 'INVALID_DATA', nativeEvent }); }
}

/**
 * Standalone adapter; it does not bind events or migrate localStorage by default.
 * await open()/read() -> {ok:true,snapshot} or FAILED.
 * prepare(snapshot, command) -> immutable, single-use, generation-bound token.
 * await write(token) -> COMMITTED / ABORTED_OBSERVED / REVISION_CONFLICT / FAILED
 *   (UNKNOWN when disposal/recovery occurs before delivery of the native event).
 * await verifyOutcome(token) reads a fresh transaction; another adapter/tab can
 * independently reconcile the same serializable token without replaying it.
 * Every accepted command, including a domain no-op, advances revision and records
 * a receipt. Legacy Store no-op semantics and its public API are unchanged.
 * Operation IDs bind instance + expected revision + nonce, so an evicted ID
 * cannot be reused at a new revision. UNKNOWN is never automatically retried.
 * Stage 2 uses initializeEmpty:false: absent keys remain absent (snapshot:null),
 * and CRUD requires ACTIVE migration metadata. The legacy default is retained
 * only for the standalone Stage 1 contract, not for the Stage 2 facade.
 * prepareMigration()/verifyMigrationOutcome() share this transaction/lifecycle
 * runner; localStorage confirmation belongs to createCustomPositionMigration.
 */
export function createCustomPositionIDB({ indexedDB = () => globalThis.indexedDB,
  randomUUID = () => globalThis.crypto.randomUUID(), now = () => new Date().toISOString(), durability = 'default', initializeEmpty = true } = {}) {
  if (!['default', 'strict'].includes(durability)) fail('INVALID_DURABILITY');
  if (typeof initializeEmpty !== 'boolean') fail('INVALID_OPTIONS');
  let connection = null, opening = null, recovery = null, recoveryGeneration = null, generation = 0, accepting = true, disposed = false, unbind = null;
  const active = new Set(), prepared = new WeakMap();
  let attemptSequence = 0;
  const errorResult = error => freeze({ status: 'FAILED', code: error.code || error.name || 'IDB_FAILED', nativeEvent: 'UNKNOWN' });
  function remember(entry, event) {
    const attempt = entry.attempt;
    if (!attempt || attempt.transaction !== entry.tx) return;
    attempt.nativeEvent = event;
    attempt.transaction = null;
  }
  // operationId identifies persistence; token/attempt/transaction identity
  // identifies native delivery. Serialized or foreign tokens have no local event.
  const nativeEventFor = token => prepared.get(token)?.attempt?.nativeEvent || 'UNKNOWN';
  function settle(entry, value) { if (!entry.settled) { entry.settled = true; entry.resolve(freeze(value)); } }
  function closeConnection() { connection?.close(); connection = null; }
  function suspend(reason = 'freeze') {
    accepting = false; generation++;
    const attempts = [];
    for (const entry of active) {
      const attempt = { operationId: entry.token?.operationId ?? null, committing: entry.committing, abortRequested: false };
      if (!entry.committing && !entry.abortRequested) {
        try { entry.tx.abort(); entry.abortRequested = true; attempt.abortRequested = true; }
        catch (error) { attempt.error = error.name; }
      }
      attempts.push(attempt);
    }
    return freeze({ reason, generation, attempts });
  }
  function connect() {
    if (disposed) return Promise.reject(Object.assign(new Error('Disposed'), { code: 'DISPOSED' }));
    if (connection) return Promise.resolve(connection);
    if (opening) return opening;
    const captured = generation;
    const pending = new Promise((resolve, reject) => {
      let request, abandoned = false;
      const rejectOpen = error => { abandoned = true; reject(error); };
      try { const factory = typeof indexedDB === 'function' ? indexedDB() : indexedDB; if (!factory) fail('IDB_UNAVAILABLE'); request = factory.open(CUSTOM_POSITION_DATABASE, 1); }
      catch (error) { rejectOpen(error); return; }
      request.onblocked = () => rejectOpen(Object.assign(new Error('Database open blocked'), { code: 'OPEN_BLOCKED' }));
      request.onerror = () => rejectOpen(request.error || new Error('Open failed'));
      request.onupgradeneeded = event => {
        if (abandoned || captured !== generation || disposed || event.oldVersion !== 0) { request.transaction.abort(); return; }
        request.result.createObjectStore('state');
      };
      request.onsuccess = () => {
        const db = request.result;
        if (abandoned || captured !== generation || disposed) { db.close(); rejectOpen(Object.assign(new Error('Stale open'), { code: 'STALE_LIFECYCLE' })); return; }
        if (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('state')) { db.close(); rejectOpen(Object.assign(new Error('Invalid database stores'), { code: 'INVALID_DATABASE' })); return; }
        connection = db;
        db.onversionchange = () => { suspend('versionchange'); closeConnection(); };
        db.onclose = () => { if (connection === db) { suspend('connection-closed'); connection = null; } };
        resolve(db);
      };
    });
    opening = pending; pending.finally(() => { if (opening === pending) opening = null; }).catch(() => {}); return pending;
  }
  // All IDB callbacks below are synchronous. No task delay, promise await,
  // external lock, or lifecycle-dependent timer extends an acquired transaction.
  function transact(db, captured, token, initializeId, submittedAt) {
    return new Promise(resolve => {
      let tx; try { tx = db.transaction('state', 'readwrite', { durability }); } catch (error) { resolve(errorResult(error)); return; }
      const attempt = token ? prepared.get(token).attempt : null;
      if (attempt) attempt.transaction = tx;
      const entry = { tx, token, attempt, resolve, committing: false, abortRequested: false, settled: false, failure: null, result: null };
      active.add(entry);
      tx.oncomplete = () => {
        active.delete(entry); remember(entry, 'COMPLETE');
        settle(entry, token ? { status: 'COMMITTED', code: 'TRANSACTION_COMPLETE', nativeEvent: 'COMPLETE', snapshot: entry.result }
          : { ok: true, snapshot: entry.result, nativeEvent: 'COMPLETE' });
      };
      tx.onabort = () => {
        active.delete(entry); remember(entry, 'ABORT');
        const error = entry.failure || tx.error;
        settle(entry, { status: error?.code === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT' : error ? 'FAILED' : 'ABORTED_OBSERVED',
          code: error?.code || error?.name || 'NATIVE_ABORT', nativeEvent: 'ABORT' });
      };
      const store = tx.objectStore('state'); let envelope, metadata, reads = 0;
      function loaded() {
        if (++reads !== 2) return;
        try {
          if (captured !== generation || disposed) fail('STALE_LIFECYCLE');
          if (envelope === undefined && metadata === undefined && !token && initializeEmpty) {
            envelope = empty(); metadata = initialMetadata(initializeId);
            store.put(envelope, 'envelope'); store.put(metadata, 'metadata');
          }
          const absent = envelope === undefined && metadata === undefined;
          const state = absent ? null : validateCustomPositionIDBState(envelope, metadata);
          if (token && prepared.get(token).kind === 'migration') {
            const next = applyMigrationTransition(state, token);
            entry.result = validateCustomPositionIDBState(next.envelope, next.metadata);
            ({ envelope, metadata } = entry.result);
            store.put(envelope, 'envelope'); store.put(metadata, 'metadata');
          } else if (token) {
            if (!state || state.metadata.migration?.state === 'STAGED'
              || !initializeEmpty && state.metadata.migration?.state !== 'ACTIVE') fail('MIGRATION_NOT_ACTIVE');
            if (token.storageInstanceId !== state.metadata.storageInstanceId) fail('STORAGE_INSTANCE_CHANGED');
            const duplicate = state.metadata.commits.find(r => r.operation.operationId === token.operationId);
            if (duplicate) fail(exact(duplicate.operation) === exact(token) ? 'DUPLICATE_OPERATION' : 'OPERATION_ID_COLLISION');
            if (state.envelope.revision !== token.expectedRevision) fail('REVISION_CONFLICT');
            if (token.expectedRevision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED');
            const applied = applyCustomPositionOperation(state.envelope, token.command, { now: () => token.preparedAt, idFactory: () => token.positionId });
            if (token.command.type === 'delete' && !applied.result.deleted) fail('POSITION_NOT_FOUND');
            // applyCustomPositionOperation fully validates and freezes both
            // its input and output. Only the safe revision changes here; do not
            // clone/revalidate all 100 boards twice again to build the receipt.
            envelope = { ...applied.envelope, revision: token.expectedRevision + 1 };
            const id = applied.result.position?.id ?? token.command.id;
            const oldIndex = state.envelope.positions.findIndex(p => p.id === id), newIndex = envelope.positions.findIndex(p => p.id === id);
            // Timestamp of submission, captured outside the IDB callback. The
            // actual completion is evidenced by complete/witness, not this clock.
            const receipt = { operation: token, revision: envelope.revision, committedAt: submittedAt,
              delta: { index: oldIndex >= 0 ? oldIndex : newIndex, before: state.envelope.positions[oldIndex] ?? null, after: envelope.positions[newIndex] ?? null } };
            entry.result = appendValidatedReceipt(state, envelope, receipt);
            ({ envelope, metadata } = entry.result);
            store.put(envelope, 'envelope'); store.put(metadata, 'metadata');
          } else entry.result = state;
          tx.commit(); entry.committing = true;
        } catch (error) { entry.failure = error; try { tx.abort(); } catch { settle(entry, { status: 'UNKNOWN', code: 'ABORT_NOT_CONFIRMED', nativeEvent: 'UNKNOWN' }); } }
      }
      store.get('envelope').onsuccess = event => { envelope = event.target.result; loaded(); };
      store.get('metadata').onsuccess = event => { metadata = event.target.result; loaded(); };
    });
  }
  async function readInternal(captured) {
    try { const id = uuid(randomUUID()), db = await connect(); if (captured !== generation || disposed) fail('STALE_LIFECYCLE'); return await transact(db, captured, null, id); }
    catch (error) { return errorResult(error); }
  }
  function read() { return accepting && !disposed ? readInternal(generation) : Promise.resolve(errorResult({ code: 'SUSPENDED' })); }
  function prepare(snapshot, command, { nonce = randomUUID() } = {}) {
    if (!accepting || disposed) fail('SUSPENDED');
    const state = validatedState(snapshot), copy = data(command);
    if (state.metadata.migration?.state === 'STAGED'
      || !initializeEmpty && state.metadata.migration?.state !== 'ACTIVE') fail('MIGRATION_NOT_ACTIVE');
    const t = tokenData({ storageInstanceId: state.metadata.storageInstanceId, expectedRevision: state.envelope.revision,
      operationId: `${state.metadata.storageInstanceId}/${state.envelope.revision}/${uuid(nonce)}`, command: copy,
      preparedAt: timestamp(now()), positionId: uuid(randomUUID()) });
    applyCustomPositionOperation(state.envelope, t.command, { now: () => t.preparedAt, idFactory: () => t.positionId });
    freeze(t); prepared.set(t, { generation, used: false, attempt: null }); return t;
  }
  function prepareMigration(snapshot, command, { storageInstanceId = snapshot?.metadata.storageInstanceId ?? randomUUID() } = {}) {
    if (!accepting || disposed) fail('SUSPENDED');
    const state = snapshot === null ? null : validatedState(snapshot);
    const token = freeze({ operationId: uuid(randomUUID()), storageInstanceId: uuid(storageInstanceId),
      expectedRevision: state?.envelope.revision ?? null, preparedAt: timestamp(now()), command: data(command) });
    applyMigrationTransition(state, token);
    prepared.set(token, { generation, used: false, attempt: null, kind: 'migration' }); return token;
  }
  async function write(token) {
    const local = prepared.get(token);
    try {
      if (!local || local.used) fail('INVALID_OR_USED_OPERATION');
      local.used = true;
      local.attempt = { attemptId: ++attemptSequence, transaction: null, nativeEvent: 'UNKNOWN' };
      if (!accepting || local.generation !== generation || disposed) fail('STALE_LIFECYCLE');
      const db = await connect();
      if (!accepting || local.generation !== generation || disposed) fail('STALE_LIFECYCLE');
      return await transact(db, local.generation, token, undefined, timestamp(now()));
    } catch (error) { return errorResult(error); }
  }
  async function verifyOutcome(token) {
    const readResult = await read();
    if (!readResult.ok) return freeze({ status: 'UNKNOWN', code: readResult.code, nativeEvent: nativeEventFor(token) });
    return freeze({ ...observeCustomPositionOperation(readResult.snapshot, token), nativeEvent: nativeEventFor(token) });
  }
  async function verifyMigrationOutcome(token) {
    const result = await read();
    try {
      return freeze({ ...(result.ok ? observeMigration(result.snapshot, data(token))
        : { status: 'UNKNOWN', code: result.code }), nativeEvent: nativeEventFor(token) });
    } catch (error) { return freeze({ status: 'UNKNOWN', code: error.code || 'INVALID_DATA', nativeEvent: nativeEventFor(token) }); }
  }
  function resume() {
    if (disposed) return Promise.resolve(errorResult({ code: 'DISPOSED' }));
    if (recovery) return recoveryGeneration === generation ? recovery : recovery.then(() => resume());
    accepting = false; const captured = ++generation;
    recoveryGeneration = captured;
    for (const entry of active) settle(entry, { status: 'UNKNOWN', code: 'EVENT_NOT_OBSERVED', nativeEvent: 'UNKNOWN' });
    closeConnection();
    recovery = (async () => {
      // An old open request cannot be cancelled. Let it close its stale result
      // before opening for this generation; never reuse its connection.
      if (opening) await opening.catch(() => {});
      if (captured !== generation || disposed) return errorResult({ code: 'STALE_LIFECYCLE' });
      const result = await readInternal(captured);
      if (captured === generation && result.ok && !disposed) accepting = true;
      return result;
    })().finally(() => { recovery = null; });
    return recovery;
  }
  function attachLifecycle({ document: doc = globalThis.document, window: win = globalThis.window } = {}) {
    unbind?.();
    const stop = event => { suspend(event.type); }, restore = () => { if (!accepting && !disposed) void resume(); };
    doc.addEventListener('freeze', stop, true); win.addEventListener('pagehide', stop, true);
    doc.addEventListener('resume', restore, true); win.addEventListener('pageshow', restore, true);
    const detach = () => { doc.removeEventListener('freeze', stop, true); win.removeEventListener('pagehide', stop, true); doc.removeEventListener('resume', restore, true); win.removeEventListener('pageshow', restore, true); if (unbind === detach) unbind = null; };
    unbind = detach; return detach;
  }
  function dispose() { suspend('dispose'); disposed = true; unbind?.(); closeConnection();
    for (const entry of active) settle(entry, { status: 'UNKNOWN', code: 'DISPOSED_BEFORE_EVENT', nativeEvent: 'UNKNOWN' }); }
  return Object.freeze({ open: read, read, prepare, write, verifyOutcome, prepareMigration, verifyMigrationOutcome, suspend, resume, attachLifecycle, dispose });
}
