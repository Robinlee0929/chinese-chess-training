import { profileSource } from './idb-profile-source.mjs';
import { performanceProfile } from './idb-performance-profile.mjs';
import { tailProfile } from './idb-tail-profile.mjs';
import { crudTargetProfile } from './idb-crud-target-profile.mjs';
// Test server only. No mutant is written to or imported by the production graph.
export function variantSource(source, variant) {
  if (variant === 'profile') return profileSource(source);
  if (variant === 'diagnose') return performanceProfile(source);
  if (variant === 'tail') return tailProfile(source);
  if (variant === 'crud-target') return crudTargetProfile(source);
  const replace = (from, to) => { if (!source.includes(from)) throw Error('Mutation anchor missing: '+variant); source = source.replaceAll(from,to); };
  if (variant === 'operation-id-events') {
    replace('let attemptSequence = 0;', 'let attemptSequence = 0; const legacyNative = new Map();');
    replace('attempt.nativeEvent = event;', 'attempt.nativeEvent = event; legacyNative.set(entry.token.operationId, event);');
    replace("prepared.get(token)?.attempt?.nativeEvent || 'UNKNOWN'", "legacyNative.get(token?.operationId) || 'UNKNOWN'");
  }
  if (variant === 'no-freeze-abort') replace('if (!entry.committing && !entry.abortRequested)', 'if (false && !entry.committing && !entry.abortRequested)');
  if (variant === 'skip-revision') replace('if (state.envelope.revision !== token.expectedRevision)', 'if (false && state.envelope.revision !== token.expectedRevision)');
  if (variant === 'stale-replay') {
    replace('if (!accepting || local.generation !== generation || disposed)', 'if (disposed)');
    replace('transact(db, local.generation, token,', 'transact(db, generation, token,');
  }
  if (variant === 'premature') replace("store.put(envelope, 'envelope'); store.put(metadata, 'metadata');", "store.put(envelope, 'envelope').onsuccess = () => { if (token) settle(entry, {status:'COMMITTED', code:'WRONG_REQUEST_SUCCESS', nativeEvent:'UNKNOWN'}); }; store.put(metadata, 'metadata');");
  return source;
}
