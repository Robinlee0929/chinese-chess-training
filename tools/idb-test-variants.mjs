// Test server only. No mutant is written to or imported by the production graph.
export function variantSource(source, variant) {
  const replace = (from, to) => { if (!source.includes(from)) throw Error('Mutation anchor missing: '+variant); source = source.replaceAll(from,to); };
  if (variant === 'no-freeze-abort') replace('if (!entry.committing && !entry.abortRequested)', 'if (false && !entry.committing && !entry.abortRequested)');
  if (variant === 'skip-revision') replace('if (state.envelope.revision !== token.expectedRevision)', 'if (false && state.envelope.revision !== token.expectedRevision)');
  if (variant === 'stale-replay') {
    replace('if (!accepting || local.generation !== generation || disposed)', 'if (disposed)');
    replace('transact(db, local.generation, token,', 'transact(db, generation, token,');
  }
  if (variant === 'premature') replace("store.put(envelope, 'envelope'); store.put(metadata, 'metadata');", "store.put(envelope, 'envelope').onsuccess = () => { if (token) settle(entry, {status:'COMMITTED', code:'WRONG_REQUEST_SUCCESS', nativeEvent:'UNKNOWN'}); }; store.put(metadata, 'metadata');");
  return source;
}
