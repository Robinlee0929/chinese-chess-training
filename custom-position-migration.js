import { createCustomPositionIDB } from './custom-position-idb.js?v=1eae6523bb';
import { validateCustomPositionEnvelope, CUSTOM_POSITION_STORAGE_KEY, CUSTOM_POSITION_MAX_BYTES } from './custom-position-store.js?v=1eae6523bb';

const frozen = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const fail = code => { throw Object.assign(new Error(code), { code }); };
export async function fingerprintLegacySource(raw) {
  const bytes = new TextEncoder().encode(raw);
  return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2,'0')).join('');
}

// Read-only legacy boundary. Never clear, remove, setItem, or partially salvage.
export async function readLegacyCustomPositions(storage) {
  let raw;
  try { raw = (typeof storage === 'function' ? storage() : storage).getItem(CUSTOM_POSITION_STORAGE_KEY); }
  catch { return frozen({ status: 'UNAVAILABLE', code: 'LEGACY_READ_FAILED' }); }
  if (raw === null) return frozen({ status: 'ABSENT', raw: null });
  try {
    if (typeof raw !== 'string') fail('INVALID_LEGACY_VALUE');
    if (new TextEncoder().encode(raw).length > CUSTOM_POSITION_MAX_BYTES) fail('STORAGE_SIZE_LIMIT');
    const envelope = validateCustomPositionEnvelope(JSON.parse(raw));
    const contents = envelope.positions.map(p => JSON.stringify([p.initialBoard,p.sideToMove]));
    // Do not silently discard either ID when preexisting duplicate content is found.
    if (new Set(contents).size !== contents.length) fail('DUPLICATE_POSITION_CONTENT');
    const sourceFingerprint = await fingerprintLegacySource(raw);
    return frozen({ status: 'VALID', raw, envelope, sourceFingerprint, migrationId: `legacy-v1:${sourceFingerprint}` });
  } catch (error) { return frozen({ status: 'BLOCKED', code: error.code || (error instanceof SyntaxError ? 'INVALID_JSON' : 'LEGACY_VALIDATION_FAILED'), raw }); }
}

/** Standalone Stage 2 facade; no formal UI, migration-on-resume or legacy writes.
 * inspect(): read-only classification and immutable confirmation/recovery plan.
 * initialize(): may create ACTIVE empty state ONLY after absence checks.
 * confirmMigration(plan,{confirmed:true,legacyWritersStopped:true}): explicit copy
 *   -> STAGED complete -> re-read -> source check -> ACTIVE complete.
 * A plan is local, single-use and lifecycle-bound. Reload/recovery requires a new
 * inspect() and explicit confirmation. Unknown outcomes never resubmit writes.
 * The stopped-writers flag is an Owner acknowledgement, not proof of a lock.
 */
export function createCustomPositionMigration({ storage = () => globalThis.localStorage,
  indexedDB = () => globalThis.indexedDB, durability = 'default', randomUUID = () => globalThis.crypto.randomUUID(),
  now = () => new Date().toISOString() } = {}) {
  const adapter = createCustomPositionIDB({ indexedDB, durability, randomUUID, now, initializeEmpty: false });
  const plans = new WeakMap(); let epoch = 0, accepting = true, disposed = false, detach = null;
  const guard = captured => { if (captured !== epoch || !accepting || disposed) fail('STALE_LIFECYCLE'); };
  const failure = (code, extra = {}) => frozen({ state: 'BLOCKED', code, crossSourceAtomic: false, ...extra });
  function dbFailure(result) {
    const unavailable = ['IDB_UNAVAILABLE','SecurityError','UnknownError','OPEN_BLOCKED','VersionError','SUSPENDED','STALE_LIFECYCLE','DISPOSED'].includes(result.code);
    return failure(result.code === 'VersionError' ? 'UNSUPPORTED_IDB_VERSION' : result.code,
      { state: unavailable ? 'UNAVAILABLE' : 'BLOCKED', outcome: result.status, nativeEvent: result.nativeEvent });
  }
  async function source(captured) { const result = await readLegacyCustomPositions(storage); guard(captured); return result; }
  function planFor(legacy, snapshot, captured) {
    const plan = frozen({ migrationId: legacy.migrationId, sourceFingerprint: legacy.sourceFingerprint,
      storageInstanceId: snapshot?.metadata.storageInstanceId ?? randomUUID(), sourceRevision: legacy.envelope.revision,
      count: legacy.envelope.positions.length, envelope: legacy.envelope, sourceRaw: legacy.raw,
      warning: 'Stop legacy tabs before confirming. This acknowledgement cannot make localStorage and IndexedDB atomic.' });
    plans.set(plan, { epoch: captured, used: false }); return plan;
  }
  function matches(snapshot, plan) {
    const m = snapshot?.metadata.migration;
    return m?.migrationId === plan.migrationId && m.sourceFingerprint === plan.sourceFingerprint
      && m.candidateJSON === JSON.stringify(plan.envelope) && snapshot.metadata.storageInstanceId === plan.storageInstanceId;
  }
  async function inspect() {
    const captured = epoch;
    try {
      guard(captured); const result = await adapter.read(); guard(captured);
      if (!result.ok) return dbFailure(result);
      const legacy = await source(captured), snapshot = result.snapshot, m = snapshot?.metadata.migration;
      if (snapshot && !m) return failure('UNMANAGED_IDB_DATA', { snapshot, legacy });
      if (m?.state === 'ACTIVE') return frozen({ state: 'ACTIVE', snapshot, legacy, outcome: 'COMMITTED_OBSERVED', nativeEvent: 'UNKNOWN', crossSourceAtomic: false,
        warnings: legacy.status === 'ABSENT' ? [] : [legacy.status === 'VALID' && legacy.sourceFingerprint === m.sourceFingerprint ? 'LEGACY_RETAINED' : 'LEGACY_SOURCE_DIFFERS_OR_UNREADABLE'] });
      if (legacy.status === 'UNAVAILABLE') return failure(legacy.code, { state: 'UNAVAILABLE', snapshot, legacy });
      if (legacy.status === 'BLOCKED') return failure(legacy.code, { snapshot, legacy });
      if (m?.state === 'STAGED') {
        if (legacy.status !== 'VALID' || legacy.migrationId !== m.migrationId || JSON.stringify(legacy.envelope) !== m.candidateJSON) return failure('SOURCE_CHANGED', { snapshot, legacy });
        return frozen({ state: 'STAGED', snapshot, legacy, plan: planFor(legacy, snapshot, captured), crossSourceAtomic: false });
      }
      return legacy.status === 'ABSENT' ? frozen({ state: 'UNINITIALIZED', snapshot: null, legacy, crossSourceAtomic: false })
        : frozen({ state: 'MIGRATION_REQUIRED', snapshot: null, legacy, plan: planFor(legacy, null, captured), crossSourceAtomic: false });
    } catch (error) { return failure(error.code || 'INSPECTION_FAILED', { state: 'UNAVAILABLE', outcome: 'UNKNOWN', nativeEvent: 'UNKNOWN' }); }
  }
  async function sourceMatches(plan, captured) {
    const current = await source(captured);
    if (current.status !== 'VALID' || current.raw !== plan.sourceRaw || current.sourceFingerprint !== plan.sourceFingerprint) fail(current.status === 'UNAVAILABLE' ? 'LEGACY_READ_FAILED' : 'SOURCE_CHANGED');
  }
  async function initialize() {
    const captured = epoch; let operation = null;
    try {
      const state = await inspect(); guard(captured);
      if (state.state !== 'UNINITIALIZED') return state;
      if ((await source(captured)).status !== 'ABSENT') return failure('SOURCE_CHANGED');
      operation = adapter.prepareMigration(null, { type: 'initialize', migrationId: 'empty-v1', sourceFingerprint: null,
        envelope: { version: 1, revision: 0, positions: [] } });
      guard(captured); const result = await adapter.write(operation); guard(captured);
      if (result.status !== 'COMMITTED') return failure(result.code, { outcome: result.status, nativeEvent: result.nativeEvent, operation });
      if ((await source(captured)).status !== 'ABSENT') return failure('SOURCE_CHANGED_AFTER_INITIALIZATION', { targetState: 'ACTIVE', outcome: 'COMMITTED', operation });
      return frozen({ state: 'ACTIVE', snapshot: result.snapshot, outcome: 'COMMITTED', nativeEvent: result.nativeEvent, operation, crossSourceAtomic: false });
    } catch (error) { return failure(error.code || 'INITIALIZATION_FAILED', { outcome: 'UNKNOWN', nativeEvent: 'UNKNOWN', operation }); }
  }
  async function confirmMigration(plan, { confirmed = false, legacyWritersStopped = false } = {}) {
    const captured = epoch, local = plans.get(plan); let operation = null;
    try {
      guard(captured);
      if (!confirmed || !legacyWritersStopped) return failure('EXPLICIT_CONFIRMATION_REQUIRED');
      if (!local || local.used || local.epoch !== captured) return failure('STALE_MIGRATION_PLAN');
      local.used = true;
      await sourceMatches(plan, captured);
      let current = await adapter.read(); guard(captured);
      if (!current.ok) return dbFailure(current);
      if (current.snapshot) {
        if (!matches(current.snapshot, plan)) return failure('MIGRATION_TARGET_CONFLICT', { snapshot: current.snapshot });
        if (current.snapshot.metadata.migration.state === 'ACTIVE') return frozen({ state: 'ACTIVE', snapshot: current.snapshot, outcome: 'COMMITTED_OBSERVED', nativeEvent: 'UNKNOWN', crossSourceAtomic: false });
      } else {
        operation = adapter.prepareMigration(null, { type: 'stage', migrationId: plan.migrationId,
          sourceFingerprint: plan.sourceFingerprint, envelope: plan.envelope }, { storageInstanceId: plan.storageInstanceId });
        guard(captured); const staged = await adapter.write(operation); guard(captured);
        if (staged.status !== 'COMMITTED') return failure(staged.code, { outcome: staged.status, nativeEvent: staged.nativeEvent, operation });
      }
      // A separate completed transaction confirms the complete staged copy.
      current = await adapter.read(); guard(captured);
      if (!current.ok) return dbFailure(current);
      if (!matches(current.snapshot, plan) || current.snapshot.metadata.migration.state !== 'STAGED') return failure('STAGED_VERIFICATION_FAILED', { operation });
      await sourceMatches(plan, captured);
      operation = adapter.prepareMigration(current.snapshot, { type: 'activate', migrationId: plan.migrationId,
        sourceFingerprint: plan.sourceFingerprint, envelope: plan.envelope });
      guard(captured); const activated = await adapter.write(operation); guard(captured);
      if (activated.status !== 'COMMITTED') return failure(activated.code, { outcome: activated.status, nativeEvent: activated.nativeEvent, operation });
      try { await sourceMatches(plan, captured); }
      catch (error) { return failure(error.code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED_AFTER_ACTIVATION' : error.code,
        { targetState: 'ACTIVE', outcome: 'COMMITTED', nativeEvent: activated.nativeEvent, operation }); }
      return frozen({ state: 'ACTIVE', snapshot: activated.snapshot, outcome: 'COMMITTED', nativeEvent: activated.nativeEvent, operation, crossSourceAtomic: false });
    } catch (error) { return failure(error.code || 'MIGRATION_FAILED', { outcome: 'UNKNOWN', nativeEvent: 'UNKNOWN', operation }); }
  }
  function suspend(reason) { accepting = false; epoch++; return adapter.suspend(reason); }
  async function resume() {
    if (disposed) return failure('DISPOSED', { state: 'UNAVAILABLE' });
    accepting = false; const captured = ++epoch, result = await adapter.resume();
    if (captured !== epoch || disposed) return failure('STALE_LIFECYCLE');
    if (!result.ok) return dbFailure(result);
    accepting = true; return inspect(); // Read only: never replay or initialize.
  }
  function attachLifecycle({ document: doc = globalThis.document, window: win = globalThis.window } = {}) {
    detach?.();
    const stop = e => suspend(e.type), restore = () => { if (!accepting && !disposed) void resume(); };
    doc.addEventListener('freeze',stop,true); win.addEventListener('pagehide',stop,true);
    doc.addEventListener('resume',restore,true); win.addEventListener('pageshow',restore,true);
    const remove = () => { doc.removeEventListener('freeze',stop,true); win.removeEventListener('pagehide',stop,true);
      doc.removeEventListener('resume',restore,true); win.removeEventListener('pageshow',restore,true); if(detach===remove)detach=null; };
    detach=remove; return remove;
  }
  function dispose() { suspend('dispose'); disposed=true; detach?.(); adapter.dispose(); }
  return Object.freeze({ inspect, initialize, confirmMigration, verifyMigrationOutcome: adapter.verifyMigrationOutcome,
    suspend, resume, attachLifecycle, dispose });
}
