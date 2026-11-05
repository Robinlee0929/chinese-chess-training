// Scheduling double for Session tests only; native IDB is covered in Browser suites.
import { applyCustomPositionOperation } from '../custom-position-store.js';
import { initialBoard } from '../game.js';
export const testPosition = () => ({ id: 'saved', title: 'saved', initialBoard: initialBoard(), sideToMove: 'red',
  playPreferences: { humanSide: 'red', difficulty: 'medium' }, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z' });
export function repositoryDouble(positions = [testPosition()]) {
  let snapshot = { envelope: { version: 1, revision: 1, positions }, metadata: { storageInstanceId: 'instance' } }, sequence = 0;
  const controls = { before: null, after: null, mode: 'ACTIVE', result: null, verify: null }, calls = [];
  const migration = () => ({ status: controls.mode === 'UNINITIALIZED' ? 'MIGRATION_REQUIRED' : controls.mode,
    migration: { state: controls.mode }, snapshot: controls.mode === 'UNINITIALIZED' ? null : structuredClone(snapshot),
    plan: ['STAGED','MIGRATION_REQUIRED'].includes(controls.mode) ? { count: snapshot.envelope.positions.length } : null });
  const repository = { createScope({ isCurrent = () => true } = {}) {
    let active = true; const scopeId = ++sequence, handles = new Map();
    function request(type, args = [], expected = {}) {
      const identity = { scopeId, requestId: ++sequence, operationId: 'operation-'+sequence, targetPositionId: args[0], ...expected };
      let cancelled = false, observed = null, committed = false;
      const completion = Promise.resolve().then(async () => {
        calls.push({ type, args, expected }); await controls.before?.(type, identity);
        let result;
        if (cancelled || !active || !isCurrent()) result = { status: 'CANCELLED_UI_INTENT' };
        else if (controls.result) result = controls.result;
        else if (type === 'inspectMigration') result = migration();
        else if (type === 'initialize' || type === 'confirmMigration') { controls.mode = 'ACTIVE'; result = migration(); }
        else if (controls.mode !== 'ACTIVE') result = migration();
        else if (expected.storageInstanceId && snapshot.metadata.storageInstanceId !== expected.storageInstanceId) result = { status: 'UNKNOWN', code: 'STORAGE_INSTANCE_CHANGED' };
        else if (expected.expectedRevision !== undefined && expected.expectedRevision !== snapshot.envelope.revision) result = { status: 'REVISION_CONFLICT', code: 'REVISION_CONFLICT' };
        else if (type === 'loadAll' || type === 'getPosition') {
          const position = snapshot.envelope.positions.find(p => p.id === args[0]);
          result = type === 'getPosition' && !position ? { status: 'INVALID_DATA', code: 'POSITION_NOT_FOUND' }
            : { ...migration(), status: 'SUCCESS', position: structuredClone(position) };
        } else {
          const command = type === 'savePosition' ? { type: 'save', position: args[0] }
            : type === 'renamePosition' ? { type: 'rename', id: args[0], title: args[1] }
              : type === 'updatePlayPreferences' ? { type: 'preferences', id: args[0], preferences: args[1] } : { type: 'delete', id: args[0] };
          const applied = applyCustomPositionOperation(snapshot.envelope, command, { idFactory: () => 'saved-'+sequence });
          snapshot = { ...snapshot, envelope: { ...applied.envelope, revision: snapshot.envelope.revision+1 } };
          committed = true; result = { status: 'SUCCESS', snapshot: structuredClone(snapshot), latestSnapshot: structuredClone(snapshot),
            revision: snapshot.envelope.revision, ...applied.result, persistence: { status: 'COMMITTED', nativeEvent: 'COMPLETE' } };
        }
        await controls.after?.(type, result);
        observed = { ...result, identity, uiIntent: cancelled || !active || !isCurrent() ? 'CANCELLED_UI_INTENT' : 'CURRENT' };
        if (observed.uiIntent !== 'CURRENT') observed.status = 'CANCELLED_UI_INTENT';
        return observed;
      });
      const handle = { identity, completion, cancel() { cancelled = true; },
        async verify() { await controls.before?.('verify'); return controls.verify ?? { status: committed ? 'COMMITTED' : 'UNKNOWN', nativeEvent: 'UNKNOWN' }; } };
      handles.set(handle, () => !cancelled && observed); return handle;
    }
    const scope = { identity: { scopeId }, close() { active = false; },
      canApply(h,r) { return active && isCurrent() && handles.get(h)?.() === r && r.status === 'SUCCESS'; } };
    for (const type of ['inspectMigration','initialize','confirmMigration','loadAll','getPosition','savePosition','renamePosition','updatePlayPreferences','deletePosition']) scope[type] = (...args) => {
      const expected = ['loadAll'].includes(type) ? args[0] : ['getPosition','savePosition','deletePosition'].includes(type) ? args[1] : args[2];
      return request(type, args, expected);
    };
    return scope;
  } };
  return { repository, controls, calls, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; } };
}
