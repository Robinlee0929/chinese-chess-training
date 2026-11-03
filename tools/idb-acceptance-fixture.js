// Test page only. No production source transformation, timer, await, or promise
// is added to a transaction callback. API awaits remain outside callbacks.
import { createCustomPositionIDB, CUSTOM_POSITION_DATABASE } from '../custom-position-idb.js';
let measurement = null, currentOp = null, adapter;
const nativeTransaction = IDBDatabase.prototype.transaction, nativeOpen = IDBFactory.prototype.open;
let transactions = [], tokens = new Map(), operations = {}, lifecycle = [], probes = [];
const emit = (type, details = {}) => window.trace?.(JSON.stringify({ type, perf: performance.now(), ...details }));
IDBFactory.prototype.open = function(...args) {
  const target = measurement, entry = { start: performance.now() }, request = nativeOpen.apply(this, args);
  if (target) { target.opens.push(entry); request.addEventListener('success', () => { entry.complete = performance.now(); }); }
  return request;
};
IDBDatabase.prototype.transaction = function(...args) {
  const start = performance.now(), tx = nativeTransaction.apply(this, args), target = measurement;
  const entry = { id: crypto.randomUUID(), operationId: currentOp, phase: target?.phase ?? 'other', start,
    mode: args[1], durability: tx.durability, terminal: null, committing: false, abortRequested: false, requests: [] };
  transactions.push(entry); if (target) target.transactions.push(entry);
  const commit = tx.commit.bind(tx), abort = tx.abort.bind(tx), objectStore = tx.objectStore.bind(tx);
  tx.commit = () => { entry.commitCalled = performance.now(); commit(); entry.committing = true; };
  tx.abort = () => { abort(); entry.abortRequested = true; };
  tx.objectStore = name => { const store = objectStore(name), get = store.get.bind(store);
    store.get = key => { const r = get(key); entry.requests.push(r); return r; }; return store; };
  for (const [eventName, terminal] of [['complete', 'COMPLETE'], ['abort', 'ABORT']]) tx.addEventListener(eventName, event => {
    entry.end = performance.now(); entry.terminal = terminal; entry.trusted = event.isTrusted; entry.requests = [];
    emit('native-terminal', { caseId: target?.id ?? null, transactionId: entry.id, operationId: entry.operationId,
      terminal, trusted: event.isTrusted, phase: entry.phase, nativePerf: entry.end });
  });
  return tx;
};
const phases = () => Object.fromEntries(transactions.filter(t => t.operationId).map(t => [t.operationId,
  { phase: t.terminal ?? (t.committing ? 'committing' : 'read-pending'), committing: t.committing,
    requests: t.requests.map(r => r.readyState), abortRequested: t.abortRequested }]));
for (const [target, type] of [[document, 'freeze'], [document, 'resume'], [window, 'pagehide'], [window, 'pageshow']]) {
  target.addEventListener(type, event => { const item = { type, persisted: event.persisted ?? null, isTrusted: event.isTrusted, phases: phases() };
    lifecycle.push(item); emit(type, item); }, true);
}
window.addEventListener('error', event => emit('page-error', { message: event.message }));
window.addEventListener('unhandledrejection', event => emit('unhandled-rejection', { message: String(event.reason) }));
function create() { adapter = createCustomPositionIDB({ durability: new URLSearchParams(location.search).get('durability') || 'default' }); adapter.attachLifecycle(); }
create();
async function direct(envelope, metadata) {
  const db = await new Promise((resolve, reject) => { const r = nativeOpen.call(indexedDB, CUSTOM_POSITION_DATABASE, 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try { await new Promise((resolve, reject) => { const tx = nativeTransaction.call(db, 'state', 'readwrite');
    tx.objectStore('state').put(envelope, 'envelope'); tx.objectStore('state').put(metadata, 'metadata');
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.commit(); }); } finally { db.close(); }
}
async function prepare(command) { const r = await adapter.read(); if (!r.ok) throw Error(r.code); const t = adapter.prepare(r.snapshot, command); tokens.set(t.operationId, t); return t; }
function mutate(token) { const t = tokens.get(token.operationId); currentOp = token.operationId; operations[currentOp] = { token: t };
  adapter.write(t).then(result => { operations[t.operationId].result = result; currentOp = null;
    emit('outcome', { operationId: t.operationId, status: result.status, code: result.code, nativeEvent: result.nativeEvent }); }); return { operationId: t.operationId }; }
function probe(id) { const c = new MessageChannel(); c.port1.onmessage = () => { probes.push(id); emit('probe', { id }); c.port1.close(); c.port2.close(); }; c.port2.postMessage(id); }
window.poc = { direct, prepare, mutate, probe, read: () => adapter.read(), verify: t => adapter.verifyOutcome(t), resume: () => adapter.resume(),
  inspect: () => ({ phases: phases(), lifecycle, probes, operations, visibility: document.visibilityState }) };
window.ac = {
  reset: cold => { if (measurement) throw Error('Measurement still active'); transactions = []; currentOp = null; tokens.clear(); operations = {};
    if (cold) { adapter.dispose(); create(); } },
  warm: () => adapter.open(),
  run: async (id, command) => {
    if (measurement) throw Error('Overlapping operation');
    const m = { id, start: performance.now(), phase: command.type === 'read' ? 'read' : 'prepare', transactions: [], opens: [] };
    measurement = m; let result, token = null;
    try {
      const read = await adapter.read();
      if (!read.ok || command.type === 'read') result = read;
      else { token = adapter.prepare(read.snapshot, command); tokens.set(token.operationId, token); currentOp = token.operationId;
        m.phase = 'write'; result = await adapter.write(token); }
    } catch (error) { result = { status: 'FAILED', code: error.code ?? error.message }; }
    const end = performance.now(); measurement = null; currentOp = null;
    const txs = m.transactions.map(({ requests, ...entry }) => entry), primary = txs.at(-1);
    const measured = { id, token, result, start: m.start, end, apiMs: end - m.start,
      transactionMs: primary?.end - primary?.start, transactions: txs, opens: m.opens };
    window.acLast = measured; emit('api-complete', { caseId: id, apiMs: measured.apiMs, status: result.status ?? (result.ok ? 'READ_COMPLETE' : 'UNKNOWN') });
    return measured;
  },
  localOutcome: () => adapter.verifyOutcome(window.acLast.token)
};
window.ready = adapter.open();
