import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialBoard, hashBoard } from './game.js';
import { createNewGameConfirmation, needsNewGameConfirmation } from './new-game-confirmation.js';
import { createPointerSafety } from './pointer-safety.js';

function opening(mode = 'medium') {
  const board = initialBoard(), hash = hashBoard(board);
  return { active: true, session: { id: 'source', mode, humanSide: 'red', modeRevision: 1,
    initialPosition: { board: initialBoard(), sideToMove: 'red' } },
  mode, humanSide: 'red', modeRevision: 1, revision: 0, board, turn: 'red', history: [],
  positionHashes: [hash], repetitionHistory: [{ key: hash + '|red', mover: null, check: false }],
  busy: false, aiThinking: false, over: false, winner: null, recordError: null,
  completedRecord: null, completedSessionId: null, customContext: null };
}
function harness(source = opening()) {
  const nodes = new Map(), closeQueue = [], commits = [], notices = [];
  let focused, syncs = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, open: false, isConnected: true, disabled: false,
      listeners: {}, getClientRects: () => [{}], focus() { focused = id; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      emit(name, init = {}) {
        const event = { type: name, target: this, detail: 0, preventDefault() {}, ...init };
        document.emit(name, event); this.listeners[name]?.(event);
      },
      showModal() { this.open = true; }, close() { this.open = false; closeQueue.push(() => this.emit('close')); },
    });
    return nodes.get(id);
  };
  const document = { listeners: {}, getElementById: node,
    addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener() {},
    emit(type, event) { this.listeners[type]?.(event); },
    querySelector: () => [...nodes.values()].find(n => n.open) ?? null };
  const pointerSafety = createPointerSafety({ document, window: { addEventListener() {}, removeEventListener() {} } });
  const guard = createNewGameConfirmation({ document, pointerSafety, readSource: () => source,
    commit: settings => commits.push(settings), syncSelection: () => syncs++, notify: message => notices.push(message) });
  return { source, guard, node, commits, notices, closeQueue, document,
    request: (choice = { mode: 'easy', humanSide: 'red' }) => guard.request(choice, node('invoker')),
    confirm: () => { node('btnNewGameConfirm').emit('click'); node('newGameConfirmForm').emit('submit'); },
    cancel: () => node('btnNewGameCancel').emit('click'), focused: () => focused, syncs: () => syncs };
}

for (const mode of ['easy', 'medium', 'hard', 'pvp', 'experimental-b']) {
  test(`untouched standard ${mode} opening skips dialog`, () => {
    const h = harness(opening(mode)); assert.equal(needsNewGameConfirmation(h.source), false);
    h.request(); assert.equal(h.commits.length, 1); assert.equal(h.node('newGameConfirmDialog').open, false);
  });
}
const protectedChanges = {
  history: s => s.history.push({ from: {r:3,c:0}, to: {r:4,c:0} }),
  customZeroPly: s => { s.customContext = { root: {} }; },
  customInitialBoard: s => { s.session.initialPosition.board[3][0] = null; },
  blackFirst: s => { s.session.initialPosition.sideToMove = 'black'; },
  sourceRecord: s => { s.session.sourceRecordId = 'original'; },
  liveBoardMismatch: s => { s.board[3][0] = null; },
  missingSession: s => { s.session = null; },
  recordError: s => { s.recordError = { code: 'unknown' }; },
  unknownCompletedOwner: s => { s.completedSessionId = 'different-session'; },
  revisionMismatch: s => { s.session.modeRevision++; },
  modeMismatch: s => { s.session.mode = 'pvp'; },
  sideMismatch: s => { s.session.humanSide = 'black'; },
  unknownHistory: s => { s.history = null; },
  repetitionMismatch: s => { s.repetitionHistory = []; },
  aiThinking: s => { s.aiThinking = true; },
  animation: s => { s.busy = true; },
  completedChallenge: s => { s.mode = s.session.mode = 'experimental-b'; s.over = true;
    s.completedSessionId = s.session.id; s.completedRecord = { id: s.session.id, moves: [{}] }; },
};
for (const [name, change] of Object.entries(protectedChanges)) test(`${name}: request and cancel preserve source`, () => {
  const h = harness(); change(h.source); const before = structuredClone(h.source), owner = h.source.session;
  assert.equal(needsNewGameConfirmation(h.source), true); assert.equal(h.request(), true);
  assert.equal(h.node('newGameConfirmDialog').open, true); assert.equal(h.focused(), 'btnNewGameCancel');
  assert.deepEqual(h.source, before); assert.equal(h.source.session, owner); assert.equal(h.commits.length, 0);
  h.cancel(); assert.equal(h.commits.length, 0); assert.deepEqual(h.source, before); assert.equal(h.focused(), 'invoker');
});
test('confirmation consumes exactly once, including duplicate submit and queued close', () => {
  const h = harness(); h.source.history.push({}); h.request({ mode: 'hard', humanSide: 'black' });
  h.confirm(); h.confirm(); for (const close of h.closeQueue) close(); h.confirm();
  assert.deepEqual(h.commits, [{ mode: 'hard', humanSide: 'black' }]);
});

test('bare requestSubmit cannot authorize discarding a protected game', () => {
  const h = harness(); h.source.history.push({}); h.request();
  h.node('newGameConfirmForm').emit('submit');
  assert.equal(h.commits.length, 0); assert.equal(h.node('newGameConfirmDialog').open, true);
  h.confirm(); assert.equal(h.commits.length, 1);
});

test('old pointer cannot authorize submit; a fresh button gesture can', () => {
  const h = harness(); h.source.history.push({});
  const e = { pointerId: 9, pointerType: 'touch', isPrimary: true, button: 0,
    clientX: 100, clientY: 100, target: h.node('board') };
  h.document.emit('pointerdown', e); h.request();
  h.document.emit('pointerup', { ...e, type: 'pointerup' });
  h.node('btnNewGameConfirm').emit('click', { ...e, target: h.node('btnNewGameConfirm'), detail: 1 });
  h.node('newGameConfirmForm').emit('submit'); assert.equal(h.commits.length, 0);
  const fresh = { ...e, pointerId: 10, target: h.node('btnNewGameConfirm') };
  h.document.emit('pointerdown', fresh); h.document.emit('pointerup', { ...fresh, type: 'pointerup' });
  h.node('btnNewGameConfirm').emit('click', { ...fresh, detail: 1 });
  h.node('newGameConfirmForm').emit('submit'); h.node('newGameConfirmForm').emit('submit');
  assert.equal(h.commits.length, 1);
});
const invalidations = {
  session: s => { s.session = structuredClone(s.session); },
  modeRevision: s => s.modeRevision++,
  revisionABA: s => s.revision++,
  board: s => { s.board[3][0] = null; },
  historySameLength: s => { s.history[0] = { from: {r:3,c:2} }; },
  turn: s => { s.turn = 'black'; },
  mode: s => { s.mode = 'hard'; },
  side: s => { s.humanSide = 'black'; },
  inactive: s => { s.active = false; },
  recordFailure: s => { s.recordError = { code: 'lost' }; },
  aiReply: s => { s.history.push({ from:{r:6,c:0},to:{r:5,c:0} }); s.aiThinking = false; },
  animationSettled: s => { s.busy = !s.busy; },
  completedRecord: s => { s.completedRecord = { id: s.session.id }; },
  customRoot: s => { s.customContext = { root: {} }; },
};
for (const [name, change] of Object.entries(invalidations)) test(`stale ${name} cannot confirm`, () => {
  const h = harness(); h.source.history.push({}); h.request(); change(h.source);
  h.confirm(); assert.equal(h.commits.length, 0); assert.equal(h.node('newGameConfirmDialog').open, false);
  assert.equal(h.notices.length, 1);
});
test('AI remains active on cancel and its natural reply invalidates a pending operation', () => {
  const h = harness(); h.source.aiThinking = true; h.request(); h.cancel();
  assert.equal(h.source.aiThinking, true); assert.equal(h.source.revision, 0);
  h.request(); h.source.history.push({}); h.source.revision++; h.guard.refresh(); h.confirm();
  assert.equal(h.commits.length, 0); assert.equal(h.source.history.length, 1);
});
test('Escape followed by immediate reopen ignores the old asynchronous close and retains focus', () => {
  const h = harness(); h.source.history.push({}); h.request();
  h.node('newGameConfirmDialog').emit('cancel'); assert.equal(h.focused(), 'invoker');
  h.request({ mode: 'hard', humanSide: 'black' }); h.closeQueue.shift()();
  assert.equal(h.node('newGameConfirmDialog').open, true); assert.equal(h.focused(), 'btnNewGameCancel');
  h.confirm(); assert.deepEqual(h.commits, [{ mode: 'hard', humanSide: 'black' }]);
});
test('another modal and duplicate requests cannot replace pending intent', () => {
  const h = harness(); h.source.history.push({}); h.node('exportDialog').open = true;
  assert.equal(h.request(), false); h.node('exportDialog').open = false;
  h.request(); assert.equal(h.request({mode:'hard',humanSide:'black'}), false); h.confirm();
  assert.deepEqual(h.commits, [{mode:'easy',humanSide:'red'}]);
});
test('page invalidation and programmatic close cancel without creating a session', () => {
  const h = harness(); h.source.history.push({}); h.request(); h.guard.invalidate(); h.confirm();
  h.request(); h.node('newGameConfirmDialog').close(); for (const fn of h.closeQueue) fn(); h.confirm();
  assert.equal(h.commits.length, 0);
});
test('missing mixed-version dialog fails closed', () => {
  assert.equal(createNewGameConfirmation({document:{getElementById:()=>null}}), null);
});
test('all four user entry points use guard, internal initialization remains non-interactive', () => {
  const source = readFileSync(new URL('./main.js',import.meta.url),'utf8');
  const fn = name => source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0];
  assert.match(fn('changeNormalGameMode'), /requestNormalNewGame/);
  assert.match(fn('changeHumanSide'), /requestNormalNewGame/);
  assert.match(source, /btnNew\.addEventListener\('click', \(\) => requestNormalNewGame/);
  assert.match(source, /getElementById\('btnAgain'\)\.addEventListener\('click', event =>\s*requestNormalNewGame/);
  for(const name of ['newGame','initializeNormalGamePosition']) assert.doesNotMatch(fn(name), /requestNormalNewGame|showModal|confirm\(/);
  assert.match(source, /getElementById\('newGameConfirmDialog'\)\?\.open\) return/);
});
