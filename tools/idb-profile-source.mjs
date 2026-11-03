// Test-server instrumentation only. Synchronous measurements do not keep an
// IndexedDB transaction alive across tasks or add hooks to the production API.
export function profileSource(source) {
  const replace = (from, to) => {
    if (!source.includes(from)) throw Error('Profile anchor missing: ' + from);
    source = source.replaceAll(from, to);
  };
  replace('import { validateCustomPositionEnvelope, applyCustomPositionOperation }',
    'import { validateCustomPositionEnvelope as rawEnvelope, applyCustomPositionOperation as rawOperation }');
  source += `
const measurements = globalThis.idbMeasurements = [];
function measured(phase, fn, args) {
  const start = performance.now();
  try { return fn(...args); }
  finally { measurements.push({phase, start, end:performance.now()}); }
}
function tick(phase, operationId) { measurements.push({phase, operationId, at:performance.now()}); }
function validateCustomPositionEnvelope(...args) { return measured('canonical-envelope', rawEnvelope, args); }
function applyCustomPositionOperation(...args) { return measured('domain-modification', rawOperation, args); }
export function validateCustomPositionIDBState(...args) { return measured('full-state-validation', rawState, args); }
function applyDelta(...args) { return measured('delta-replay', rawDelta, args); }
function connect(...args) {
  const start = performance.now();
  return rawConnect(...args).finally(() => measurements.push({phase:'open-or-reuse',start,end:performance.now()}));
}
`;
  replace('export function validateCustomPositionIDBState(', 'function rawState(');
  // Restore the wrapper's exported public name after the declaration replacement.
  replace("function rawState(...args) { return measured('full-state-validation'", "export function validateCustomPositionIDBState(...args) { return measured('full-state-validation'");
  replace('function applyDelta(envelope, receipt)', 'function rawDelta(envelope, receipt)');
  replace('function connect() {', 'function rawConnect() {');
  // connect must stay inside the adapter closure.
  const wrapper = source.slice(source.lastIndexOf('function connect(...args)'));
  source = source.slice(0, source.lastIndexOf('function connect(...args)'));
  replace('function rawConnect() {', wrapper + '\n  function rawConnect() {');
  replace('active.add(entry);', "active.add(entry); tick('transaction-created', token?.operationId);");
  replace("tx.oncomplete = () => {", "tx.oncomplete = () => { tick('transaction-complete', token?.operationId);");
  replace('envelope = event.target.result; loaded();', "tick('envelope-read-event', token?.operationId); envelope = event.target.result; tick('envelope-read-delivered', token?.operationId); loaded();");
  replace('metadata = event.target.result; loaded();', "tick('metadata-read-event', token?.operationId); metadata = event.target.result; tick('metadata-read-delivered', token?.operationId); loaded();");
  replace('const id = applied.result.position?.id ?? token.command.id;', "tick('receipt-build-start', token.operationId); const id = applied.result.position?.id ?? token.command.id;");
  if (source.includes('entry.result = appendValidatedReceipt(state, envelope, receipt);')) {
    replace('entry.result = appendValidatedReceipt(state, envelope, receipt);', "tick('receipt-build-end', token.operationId); entry.result = measured('append-validation', appendValidatedReceipt, [state, envelope, receipt]);");
  } else {
    replace('entry.result = validateCustomPositionIDBState(envelope, metadata);', "tick('receipt-build-end', token.operationId); entry.result = validateCustomPositionIDBState(envelope, metadata);");
  }
  replace("store.put(envelope, 'envelope'); store.put(metadata, 'metadata');", "tick('writes-start', token?.operationId); store.put(envelope, 'envelope'); store.put(metadata, 'metadata'); tick('writes-queued', token?.operationId);");
  replace('tx.commit(); entry.committing = true;', "tx.commit(); entry.committing = true; tick('commit-called', token?.operationId);");
  return source;
}
