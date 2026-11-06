import { validateCustomPositionEnvelope } from './custom-position-store.js?v=e8a9f5c59a';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const uuid = value => { if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) fail('INVALID_MIGRATION_ID'); };
const time = value => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('INVALID_MIGRATION_TIME'); };
const rev = value => { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_MIGRATION_REVISION'); };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const fields = (object, names) => { if (!object || Array.isArray(object) || Object.keys(object).sort().join('|') !== [...names].sort().join('|')) fail('INVALID_MIGRATION_FIELDS'); };
const empty = () => ({ version: 1, revision: 0, positions: [] });

// Called only after the adapter's data-only copy and complete state validation.
export function validateMigrationState(envelope, metadata) {
  const m = metadata.migration;
  fields(m, ['version','state','migrationId','sourceFingerprint','sourceRevision','initialRevision',
    'stagedOperationId','activatedOperationId','stagedAt','activatedAt','candidateJSON']);
  if (m.version !== 1 || !['STAGED','ACTIVE'].includes(m.state)) fail('INVALID_MIGRATION_STATE');
  rev(m.initialRevision);
  let candidate;
  try { candidate = validateCustomPositionEnvelope(JSON.parse(m.candidateJSON)); }
  catch { fail('MIGRATION_DATA_MISMATCH'); }
  if (JSON.stringify(candidate) !== m.candidateJSON || candidate.revision !== m.initialRevision) fail('MIGRATION_DATA_MISMATCH');
  const contents = candidate.positions.map(p => JSON.stringify([p.initialBoard,p.sideToMove]));
  if (new Set(contents).size !== contents.length) fail('DUPLICATE_POSITION_CONTENT');
  if (m.initialRevision > metadata.baseEnvelope.revision) fail('MIGRATION_DATA_MISMATCH');
  if (m.initialRevision === metadata.baseEnvelope.revision && !same(candidate, validateCustomPositionEnvelope(metadata.baseEnvelope))) fail('MIGRATION_DATA_MISMATCH');
  if (m.sourceFingerprint === null) {
    if (m.migrationId !== 'empty-v1' || m.sourceRevision !== null || m.initialRevision !== 0
      || m.stagedOperationId !== null || m.stagedAt !== null || m.state !== 'ACTIVE') fail('INVALID_MIGRATION_STATE');
    if (!same(candidate, empty())) fail('MIGRATION_DATA_MISMATCH');
  } else {
    if (!/^[0-9a-f]{64}$/.test(m.sourceFingerprint) || m.migrationId !== `legacy-v1:${m.sourceFingerprint}`) fail('INVALID_MIGRATION_ID');
    rev(m.sourceRevision); uuid(m.stagedOperationId); time(m.stagedAt);
    if (m.initialRevision !== m.sourceRevision) fail('MIGRATION_DATA_MISMATCH');
  }
  if (m.state === 'STAGED') {
    if (m.activatedOperationId !== null || m.activatedAt !== null || metadata.commits.length
      || envelope.revision !== m.initialRevision || !same(envelope, validateCustomPositionEnvelope(metadata.baseEnvelope))) fail('MIGRATION_DATA_MISMATCH');
  } else { uuid(m.activatedOperationId); time(m.activatedAt);
    if (m.activatedOperationId === m.stagedOperationId) fail('INVALID_MIGRATION_ID'); }
}

// Pure transition only: the adapter executes it inside its existing transaction.
// It cannot access localStorage, schedule work, open IDB or acquire another lock.
export function applyMigrationTransition(state, token) {
  fields(token, ['operationId','storageInstanceId','expectedRevision','preparedAt','command']);
  uuid(token.operationId); uuid(token.storageInstanceId); time(token.preparedAt);
  const c = token.command;
  fields(c, ['type','migrationId','sourceFingerprint','envelope']);
  if (!['initialize','stage','activate'].includes(c.type)) fail('INVALID_MIGRATION_OPERATION');
  const candidate = validateCustomPositionEnvelope(c.envelope);
  const contents = candidate.positions.map(p => JSON.stringify([p.initialBoard,p.sideToMove]));
  if (new Set(contents).size !== contents.length) fail('DUPLICATE_POSITION_CONTENT');
  if (c.type === 'initialize') {
    if (c.migrationId !== 'empty-v1' || c.sourceFingerprint !== null || !same(candidate, empty())) fail('INVALID_MIGRATION_SOURCE');
  } else if (typeof c.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(c.sourceFingerprint)
    || c.migrationId !== `legacy-v1:${c.sourceFingerprint}`) fail('INVALID_MIGRATION_SOURCE');

  if (c.type !== 'activate') {
    if (token.expectedRevision !== null || state !== null) fail('MIGRATION_TARGET_EXISTS');
    const active = c.type === 'initialize';
    const migration = { version: 1, state: active ? 'ACTIVE' : 'STAGED', migrationId: c.migrationId,
      sourceFingerprint: c.sourceFingerprint, sourceRevision: active ? null : candidate.revision,
      initialRevision: candidate.revision, stagedOperationId: active ? null : token.operationId,
      activatedOperationId: active ? token.operationId : null, stagedAt: active ? null : token.preparedAt,
      activatedAt: active ? token.preparedAt : null, candidateJSON: JSON.stringify(candidate) };
    return { envelope: candidate, metadata: { version: 1, storageInstanceId: token.storageInstanceId,
      baseEnvelope: candidate, commits: [], committedOperationIds: [], lastCommit: null, migration } };
  }
  if (!state || state.metadata.storageInstanceId !== token.storageInstanceId) fail('STORAGE_INSTANCE_CHANGED');
  if (state.envelope.revision !== token.expectedRevision) fail('REVISION_CONFLICT');
  const m = state.metadata.migration;
  if (m?.state !== 'STAGED') fail('MIGRATION_NOT_STAGED');
  if (m.stagedOperationId === token.operationId) fail('OPERATION_ID_COLLISION');
  if (m.migrationId !== c.migrationId || m.sourceFingerprint !== c.sourceFingerprint
    || !same(state.envelope, candidate)) fail('MIGRATION_SOURCE_CONFLICT');
  return { envelope: state.envelope, metadata: { ...state.metadata, migration: { ...m,
    state: 'ACTIVE', activatedOperationId: token.operationId, activatedAt: token.preparedAt } } };
}

// Migration receipts persist with their instance, independently of the bounded
// normal CRUD history. Missing evidence alone never fabricates a native abort.
export function observeMigration(state, token) {
  const result = (status, code) => ({ status, code, nativeEvent: 'UNKNOWN' });
  fields(token, ['operationId','storageInstanceId','expectedRevision','preparedAt','command']);
  fields(token.command, ['type','migrationId','sourceFingerprint','envelope']);
  uuid(token.operationId); uuid(token.storageInstanceId); time(token.preparedAt);
  if (!state || state.metadata.storageInstanceId !== token.storageInstanceId) return result('UNKNOWN','STORAGE_INSTANCE_CHANGED');
  const m = state.metadata.migration;
  if (!m || m.migrationId !== token.command.migrationId || m.sourceFingerprint !== token.command.sourceFingerprint) return result('UNKNOWN','MIGRATION_SOURCE_CONFLICT');
  const id = token.command.type === 'stage' ? m.stagedOperationId : m.activatedOperationId;
  if (!['initialize','stage','activate'].includes(token.command.type)) return result('UNKNOWN','INVALID_MIGRATION_OPERATION');
  if ((token.command.type === 'initialize') !== (m.sourceFingerprint === null)) return result('UNKNOWN','MIGRATION_INTENT_MISMATCH');
  const expectedRevision = token.command.type === 'activate' ? m.initialRevision : null;
  const preparedAt = token.command.type === 'stage' ? m.stagedAt : m.activatedAt;
  if (JSON.stringify(validateCustomPositionEnvelope(token.command.envelope)) !== m.candidateJSON
    || token.expectedRevision !== expectedRevision || id === token.operationId && token.preparedAt !== preparedAt) return result('UNKNOWN','MIGRATION_INTENT_MISMATCH');
  if (id === token.operationId) return result('COMMITTED','COMMITTED_OBSERVED');
  if (id !== null) return result('NOT_COMMITTED_OBSERVED','MIGRATION_FENCED');
  return result('UNKNOWN','NO_COMMIT_FENCE');
}
