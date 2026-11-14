import { createCustomPositionIDB } from './custom-position-idb.js?v=151972aca4';
import { createCustomPositionMigration } from './custom-position-migration.js?v=151972aca4';

const unavailable = new Set(['IDB_UNAVAILABLE', 'OPEN_BLOCKED', 'SecurityError', 'UnknownError',
  'VersionError', 'QuotaExceededError', 'SUSPENDED', 'STALE_LIFECYCLE', 'DISPOSED']);
const error = code => Object.assign(new Error(code), { code });
const classify = raw => raw.code === 'STORAGE_INSTANCE_CHANGED' ? 'UNKNOWN' : raw.status === 'COMMITTED' ? 'SUCCESS'
  : raw.status === 'UNKNOWN' || raw.status === 'NOT_COMMITTED_OBSERVED' ? 'UNKNOWN'
    : raw.status === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT'
      : raw.status === 'ABORTED_OBSERVED' ? 'UNAVAILABLE'
        : unavailable.has(raw.code) ? 'UNAVAILABLE' : 'INVALID_DATA';

/**
 * Sole async storage boundary for the saved-position UI. Game/DOM actions
 * remain in the host Session; this module never starts a game.
 *
 * createScope({uiGeneration, dialogIdentity, gameSessionIdentity, isCurrent})
 * owns UI intent, NOT persistence. Operations return a single-use handle:
 * { identity, completion, cancel(), verify() }. Await completion; immediately
 * before any UI/game transition call scope.canApply(handle, result). Identity
 * objects supplied by the caller are opaque references, never frozen/mutated.
 * Closing a scope invalidates every intent, including completed preferences.
 * It cannot roll back an already committing transaction.
 *
 * CRUD requires {snapshot, storageInstanceId, expectedRevision}. prepare()
 * validates/detaches input synchronously, using that ORIGINAL snapshot/revision.
 * A fresh migration inspection is a prerequisite, not a revision rebase. The
 * adapter rechecks instance/revision/ACTIVE within its atomic transaction.
 *
 * SUCCESS is backed by the adapter's COMMITTED result/receipt. The original
 * persistence result and nativeEvent remain separate from CANCELLED_UI_INTENT.
 * verify() is an independent read: nativeEvent may correctly remain UNKNOWN.
 * No timeout, automatic retry, localStorage fallback or game callback exists.
 */
export function createCustomPositionRepository({ indexedDB = () => globalThis.indexedDB,
  storage = () => globalThis.localStorage, durability = 'default',
  randomUUID = () => globalThis.crypto.randomUUID(), now = () => new Date().toISOString() } = {}) {
  const options = { indexedDB, storage, durability, randomUUID, now };
  const scopes = new Set(), verifiers = new Set(); let stopped = false, disposed = false, detach = null;
  const newAdapter = () => createCustomPositionIDB({ ...options, initializeEmpty: false });
  const newMigration = () => createCustomPositionMigration(options);

  // Notifications are intentionally omitted. A future advisory notification
  // must trigger loadAll()/inspectMigration(), never replace these snapshots.
  function createScope({ uiGeneration = null, dialogIdentity = null, gameSessionIdentity = null,
    isCurrent = () => true, storageInstanceId = null } = {}) {
    const scopeId = randomUUID(), context = Object.freeze({ uiGeneration, dialogIdentity, gameSessionIdentity });
    const entries = new Map(), plans = new WeakMap(), retained = new Set();
    let active = !stopped && !disposed, instance = storageInstanceId, instanceLost = false;
    function current() { try { return active && !stopped && !disposed && isCurrent(context) === true; } catch { return false; } }
    function observeInstance(snapshot, expected = instance) {
      if (!snapshot) {
        if (expected !== null || instance !== null) { instanceLost = true; throw error('STORAGE_INSTANCE_CHANGED'); }
        return;
      }
      const found = snapshot.metadata.storageInstanceId;
      if ((expected !== null && found !== expected) || (instance !== null && found !== instance)) {
        instanceLost = true; throw error('STORAGE_INSTANCE_CHANGED');
      }
      instance ??= found;
    }
    function cancelEntry(entry, reason = 'cancel') {
      entry.cancelled = true;
      // One adapter/manager belongs to this operation only. suspend() attempts
      // synchronous pre-commit abort and reports committing attempts honestly.
      const attempts = entry.resources.map(r => r.suspend(reason));
      return Object.freeze({ status: 'CANCELLED_UI_INTENT', attempts, persistence: entry.result?.persistence ?? null });
    }
    function checkpoint(entry) {
      if (instanceLost) throw error('STORAGE_INSTANCE_CHANGED');
      if (entry.cancelled || !current()) { cancelEntry(entry, 'stale-ui-intent'); throw error('CANCELLED_UI_INTENT'); }
    }
    function migrationResult(raw) {
      const blockedActive = raw.state === 'ACTIVE' && raw.warnings?.includes('LEGACY_SOURCE_DIFFERS_OR_UNREADABLE');
      return { status: blockedActive ? 'UNAVAILABLE' : ['ACTIVE', 'STAGED', 'MIGRATION_REQUIRED', 'UNAVAILABLE'].includes(raw.state)
        ? raw.state : raw.state === 'UNINITIALIZED' ? 'MIGRATION_REQUIRED' : 'UNAVAILABLE',
      code: blockedActive ? 'LEGACY_SOURCE_DIFFERS_OR_UNREADABLE' : raw.code ?? raw.state, migration: raw,
      snapshot: raw.snapshot ?? null, plan: raw.plan ?? null };
    }
    function operation(kind, run, setup, targetPositionId = null, expected = {}) {
      const entry = { cancelled: false, resources: [], token: null, result: null, persistence: null };
      const requestId = randomUUID();
      const identity = Object.freeze({ scopeId, requestId, context,
        get targetPositionId() { return targetPositionId ?? (entry.token?.command.type === 'save' ? entry.token.positionId : null); },
        storageInstanceId: expected.storageInstanceId ?? instance, expectedRevision: expected.expectedRevision ?? null,
        get operationId() { return entry.token?.operationId ?? null; } });
      let setupError;
      try { checkpoint(entry); setup?.(entry); } catch (e) { setupError = e; }
      const completion = Promise.resolve().then(async () => {
        let value;
        try { if (setupError) throw setupError; checkpoint(entry); value = await run(entry); }
        catch (e) {
          value = { status: e.code === 'CANCELLED_UI_INTENT' ? 'CANCELLED_UI_INTENT'
            : e.code === 'STORAGE_INSTANCE_CHANGED' ? 'UNKNOWN'
              : e.code === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT' : unavailable.has(e.code) ? 'UNAVAILABLE' : 'INVALID_DATA',
          code: e.code || 'REPOSITORY_FAILED' };
        }
        const cancelled = entry.cancelled || !current();
        if (cancelled) cancelEntry(entry, 'stale-ui-intent');
        const result = Object.freeze({ ...value, status: cancelled ? 'CANCELLED_UI_INTENT' : value.status,
          uiIntent: cancelled ? 'CANCELLED_UI_INTENT' : 'CURRENT', identity,
          persistence: entry.persistence, token: entry.token,
          nativeEvent: entry.persistence?.nativeEvent ?? value.migration?.nativeEvent ?? 'UNKNOWN' });
        entry.result = result;
        for (const resource of entry.resources) if (!retained.has(resource)) resource.dispose();
        return result;
      });
      const handle = Object.freeze({ identity, completion, cancel: reason => cancelEntry(entry, reason),
        // Query only; never send the old command again, even after cancellation.
        verify: () => verify(entry.token, kind === 'initialize' || kind === 'migrate') });
      entries.set(handle, entry); return handle;
    }
    async function inspect(entry) {
      const manager = newMigration(); entry.resources.push(manager);
      const raw = await manager.inspect(); checkpoint(entry);
      observeInstance(raw.snapshot);
      return { raw, manager };
    }
    function loadAll(expected = {}) {
      return operation('read', async entry => {
        const { raw } = await inspect(entry); checkpoint(entry);
        const view = migrationResult(raw);
        if (view.status !== 'ACTIVE') return view;
        observeInstance(raw.snapshot, expected.storageInstanceId ?? instance);
        if (expected.expectedRevision !== undefined && raw.snapshot.envelope.revision !== expected.expectedRevision) throw error('REVISION_CONFLICT');
        return { ...view, status: 'SUCCESS' };
      }, null, null, expected);
    }
    function getPosition(id, expected = {}) {
      return operation('read-position', async entry => {
        const { raw } = await inspect(entry); checkpoint(entry);
        const view = migrationResult(raw);
        if (view.status !== 'ACTIVE') return view;
        observeInstance(raw.snapshot, expected.storageInstanceId ?? instance);
        if (expected.expectedRevision !== undefined && raw.snapshot.envelope.revision !== expected.expectedRevision) throw error('REVISION_CONFLICT');
        const position = raw.snapshot.envelope.positions.find(p => p.id === id);
        if (!position) throw error('POSITION_NOT_FOUND');
        return { ...view, status: 'SUCCESS', position };
      }, null, id, expected);
    }
    function mutate(command, expected = {}) {
      let adapter;
      return operation('write', async entry => {
        const { raw } = await inspect(entry); checkpoint(entry);
        const view = migrationResult(raw);
        if (view.status !== 'ACTIVE') return view;
        observeInstance(raw.snapshot, entry.token.storageInstanceId);
        // Do not replace the caller's revision with this fresh read. Adapter
        // write receives the exact original token, including for duplicate IDs.
        entry.persistence = await adapter.write(entry.token);
        if (entry.persistence.code === 'STORAGE_INSTANCE_CHANGED') instanceLost = true;
        if (entry.cancelled || !current()) return { status: 'CANCELLED_UI_INTENT' };
        const result = entry.persistence;
        if (result.status !== 'COMMITTED') return { status: classify(result), code: result.code };
        observeInstance(result.snapshot, entry.token.storageInstanceId);
        const receipt = result.snapshot.metadata.commits.find(r => r.operation.operationId === entry.token.operationId);
        // A second authoritative inspection detects replacement/legacy conflict
        // before presenting a result. A failure here does NOT undo COMMITTED.
        const fresh = await inspect(entry); checkpoint(entry);
        const currentView = migrationResult(fresh.raw);
        if (currentView.status !== 'ACTIVE') return { ...currentView, receipt };
        return { status: 'SUCCESS', code: result.code, snapshot: result.snapshot,
          latestSnapshot: fresh.raw.snapshot, receipt, revision: receipt.revision,
          position: receipt.delta.after, created: receipt.delta.before === null && receipt.delta.after !== null };
      }, entry => {
        adapter = newAdapter(); entry.resources.push(adapter);
        if (!expected.snapshot || expected.expectedRevision !== expected.snapshot.envelope.revision
          || expected.storageInstanceId !== expected.snapshot.metadata.storageInstanceId) throw error('EXPECTED_SNAPSHOT_REQUIRED');
        entry.token = adapter.prepare(expected.snapshot, command, expected.nonce === undefined ? undefined : { nonce: expected.nonce });
        observeInstance(expected.snapshot, entry.token.storageInstanceId);
      }, command.id ?? null, expected);
    }
    function inspectMigration() {
      return operation('inspect-migration', async entry => {
        const { raw, manager } = await inspect(entry); checkpoint(entry);
        if (raw.plan) { retained.add(manager); plans.set(raw.plan, { manager, entry, used: false }); }
        return migrationResult(raw);
      });
    }
    function initialize() {
      return operation('initialize', async entry => {
        const manager = newMigration(); entry.resources.push(manager);
        const raw = await manager.initialize();
        entry.token = raw.operation ?? null;
        entry.persistence = Object.freeze({ status: raw.outcome ?? 'UNKNOWN', nativeEvent: raw.nativeEvent ?? 'UNKNOWN', code: raw.code });
        checkpoint(entry); observeInstance(raw.snapshot); return migrationResult(raw);
      });
    }
    function confirmMigration(plan, confirmation) {
      let local;
      return operation('migrate', async entry => {
        const raw = await local.manager.confirmMigration(plan, confirmation);
        entry.token = raw.operation ?? null;
        entry.persistence = Object.freeze({ status: raw.outcome ?? 'UNKNOWN', nativeEvent: raw.nativeEvent ?? 'UNKNOWN', code: raw.code });
        checkpoint(entry); observeInstance(raw.snapshot); return migrationResult(raw);
      }, entry => {
        local = plans.get(plan);
        if (!local || local.used || local.entry.cancelled) throw error('STALE_MIGRATION_PLAN');
        local.used = true; retained.delete(local.manager); entry.resources.push(local.manager);
        // Transfer ownership; cancelling the old inspection cannot abort this
        // separately identified confirmation intent.
        local.entry.resources = local.entry.resources.filter(r => r !== local.manager);
      });
    }
    function close(reason = 'scope-closed') {
      active = false;
      for (const entry of entries.values()) {
        cancelEntry(entry, reason);
        // A departed scope may never receive terminal events. Disposal settles
        // outstanding adapter operations as UNKNOWN, not as a fictitious abort.
        for (const resource of entry.resources) resource.dispose();
      }
      for (const resource of retained) resource.dispose();
      retained.clear(); scopes.delete(scope);
    }
    const scope = Object.freeze({ identity: Object.freeze({ scopeId, context }), loadAll, getPosition,
      savePosition: (position, expected) => mutate({ type: 'save', position }, expected),
      renamePosition: (id, title, expected) => mutate({ type: 'rename', id, title }, expected),
      updatePlayPreferences: (id, preferences, expected) => mutate({ type: 'preferences', id, preferences }, expected),
      deletePosition: (id, expected) => mutate({ type: 'delete', id }, expected),
      inspectMigration, initialize, confirmMigration, close,
      canApply(handle, result) { const entry = entries.get(handle); return !!entry && entry.result === result
        && !entry.cancelled && !instanceLost && current() && result.status === 'SUCCESS' && result.uiIntent === 'CURRENT'; } });
    scopes.add(scope); return scope;
  }
  async function verify(token, migration = false) {
    if (stopped || disposed) return Object.freeze({ status: 'UNKNOWN', code: disposed ? 'DISPOSED' : 'SUSPENDED', nativeEvent: 'UNKNOWN' });
    if (!token) return Object.freeze({ status: 'UNKNOWN', code: 'NO_OPERATION_TOKEN', nativeEvent: 'UNKNOWN' });
    const adapter = newAdapter(); verifiers.add(adapter);
    try { return await (migration ? adapter.verifyMigrationOutcome(token) : adapter.verifyOutcome(token)); }
    finally { verifiers.delete(adapter); adapter.dispose(); }
  }
  function suspend(reason = 'freeze') {
    stopped = true; for (const scope of [...scopes]) scope.close(reason);
    // Independent witness reads are also native transactions. They must not
    // retain a readwrite lock in a frozen/departed document.
    for (const adapter of verifiers) { adapter.suspend(reason); adapter.dispose(); }
  }
  function resume() {
    if (disposed) return Promise.resolve(Object.freeze({ status: 'UNAVAILABLE', code: 'DISPOSED' }));
    stopped = false; const scope = createScope(), handle = scope.inspectMigration();
    return handle.completion.finally(() => scope.close('read-only-recovery'));
  }
  function attachLifecycle({ document: doc = globalThis.document, window: win = globalThis.window } = {}) {
    detach?.(); const stop = e => suspend(e.type), restore = () => { if (stopped && !disposed) void resume(); };
    doc.addEventListener('freeze', stop, true); win.addEventListener('pagehide', stop, true);
    doc.addEventListener('resume', restore, true); win.addEventListener('pageshow', restore, true);
    const remove = () => { doc.removeEventListener('freeze', stop, true); win.removeEventListener('pagehide', stop, true);
      doc.removeEventListener('resume', restore, true); win.removeEventListener('pageshow', restore, true); if (detach === remove) detach = null; };
    detach = remove; return remove;
  }
  function dispose() { disposed = true; suspend('dispose'); detach?.(); }
  return Object.freeze({ createScope, verifyOutcome: token => verify(token), verifyMigrationOutcome: token => verify(token, true),
    suspend, resume, attachLifecycle, dispose });
}
