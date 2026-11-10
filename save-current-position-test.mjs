import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { initialBoard } from './game.js';
import { validateCustomPlayPosition } from './custom-position-play.js';
import { createAsyncSavedPositionSession } from './saved-position-async-session.js';
import { repositoryDouble } from './tools/saved-position-session-double.mjs';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function harness() {
  const db = repositoryDouble([]);
  let modal = false, saves = 0, resumes = 0, starts = 0;
  const ctx = vm.createContext({
    appState: 'NORMAL_GAME', mode: 'medium', humanSide: 'red', turn: 'red',
    board: initialBoard(), history: [{ from: { r: 3, c: 0 }, to: { r: 4, c: 0 } }],
    normalGameRecordSession: Object.freeze({ id: 'original', mode: 'medium', modeRevision: 1, humanSide: 'red' }),
    normalGameModeRevision: 1, normalGameRecordError: null, hashBoard: board => JSON.stringify(board),
    editorState: null, confirmedPosition: null,
    over: false, busy: false, aiThinking: false, customRematchRequest: null,
    normalGameActive: () => ctx.appState === 'NORMAL_GAME' && !modal,
    isAI: () => ctx.mode !== 'pvp', document: { querySelector: () => modal ? {} : null },
    validateCustomPlayPosition, toast() {},
  });
  const host = {
    context: () => ({ session: ctx.normalGameRecordSession, appState: ctx.appState, editor: null, confirmed: null }),
    canOpen: () => !ctx.busy && !modal,
    pause() {}, resume() { resumes++; }, start() { starts++; },
  };
  const session = createAsyncSavedPositionSession({ repository: db.repository, host,
    onChange: state => { modal = state.active; } });
  ctx.savedPositionsUI = { openSave(position, button, preferences, options) {
    saves++; return session.openSave(position, preferences, options);
  } };
  for (const name of ['normalGameRecordMatches', 'currentPositionSaveUnavailableReason', 'saveCurrentGamePosition']) {
    const fn = source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'));
    assert.ok(fn); vm.runInContext(fn[0], ctx);
  }
  return { ctx, db, session, get saves() { return saves; }, get resumes() { return resumes; }, get starts() { return starts; } };
}
for (const turn of ['red', 'black']) for (const humanSide of ['red', 'black']) for (const mode of ['easy', 'medium', 'hard', 'experimental-b']) {
  test('current save retains independent turn/player/difficulty: ' + [turn, humanSide, mode].join('/'), async () => {
    const h = harness(); Object.assign(h.ctx, { turn, humanSide, mode });
    h.ctx.normalGameRecordSession = Object.freeze({ ...h.ctx.normalGameRecordSession, mode, humanSide });
    const persistedDifficulty = mode === 'experimental-b' ? 'hard' : mode;
    const before = JSON.stringify({ board: h.ctx.board, history: h.ctx.history, session: h.ctx.normalGameRecordSession });
    assert.equal(h.ctx.saveCurrentGamePosition({}), true); await h.session.whenReady();
    assert.equal(h.session.state().form.humanSide, humanSide); assert.equal(h.session.state().form.difficulty, persistedDifficulty);
    h.session.edit({ title: '現在的棋面' }); assert.equal(await h.session.submit(), true);
    const saved = h.db.snapshot.envelope.positions[0];
    assert.deepEqual(saved.initialBoard, h.ctx.board); assert.equal(saved.sideToMove, turn);
    assert.deepEqual(saved.playPreferences, { humanSide, difficulty: persistedDifficulty });
    if (mode === 'experimental-b') assert.match(h.session.state().notice, /下次預設為困難級/);
    assert.deepEqual(Object.keys(saved).sort(), ['id', 'title', 'initialBoard', 'sideToMove', 'createdAt', 'updatedAt', 'playPreferences'].sort());
    h.session.close(); assert.equal(h.resumes, 1); assert.equal(h.starts, 0);
    assert.equal(JSON.stringify({ board: h.ctx.board, history: h.ctx.history, session: h.ctx.normalGameRecordSession }), before);
  });
}
for (const [label, changes] of [
  ['animation', { busy: true }], ['AI search', { aiThinking: true }], ['terminal', { over: true }],
  ['two-player', { mode: 'pvp' }], ['editor', { appState: 'PUZZLE_EDITOR' }],
  ['review', { appState: 'GAME_REVIEW' }], ['no move', { history: [] }],
  ['no session', { normalGameRecordSession: null }], ['rematch confirmation', { customRematchRequest: {} }],
]) test('current save rejects ' + label + ' before touching the manager', () => {
  const h = harness(); Object.assign(h.ctx, changes);
  assert.equal(h.ctx.saveCurrentGamePosition({}), false); assert.equal(h.saves, 0); assert.equal(h.db.calls.length, 0);
});
test('current save rejects an invalid board without opening a dialog', () => {
  const h = harness(); h.ctx.board[0][4] = null;
  assert.equal(h.ctx.saveCurrentGamePosition({}), false); assert.equal(h.saves, 0);
});
test('snapshot rows, pieces and preferences cannot follow live mutations', async () => {
  const h = harness(); const original = structuredClone(h.ctx.board);
  h.ctx.saveCurrentGamePosition({}); await h.session.whenReady();
  const draft = h.session.state().form;
  assert.notEqual(draft.position.initialBoard, h.ctx.board);
  for (let r = 0; r < 10; r++) {
    assert.notEqual(draft.position.initialBoard[r], h.ctx.board[r]);
    for (let c = 0; c < 9; c++) if (h.ctx.board[r][c]) assert.notEqual(draft.position.initialBoard[r][c], h.ctx.board[r][c]);
  }
  h.ctx.board[0][0].type = 'P'; h.ctx.board[3][0] = null; h.ctx.turn = 'black'; h.ctx.mode = 'hard';
  assert.deepEqual(draft.position.initialBoard, original); assert.equal(draft.position.sideToMove, 'red'); assert.equal(draft.difficulty, 'medium');
});
test('cancel and double entry preserve current session and never save', async () => {
  const h = harness(), before = JSON.stringify(h.ctx.history), origin = h.ctx.normalGameRecordSession;
  h.ctx.saveCurrentGamePosition({}); assert.equal(h.ctx.saveCurrentGamePosition({}), false);
  await h.session.whenReady(); h.session.close();
  assert.equal(h.db.snapshot.envelope.positions.length, 0); assert.equal(h.ctx.normalGameRecordSession, origin);
  assert.equal(JSON.stringify(h.ctx.history), before); assert.equal(h.resumes, 1); assert.equal(h.starts, 0);
});
test('late committed save is not applied to a replacement game and is not retried', async () => {
  const h = harness(); h.ctx.saveCurrentGamePosition({}); await h.session.whenReady();
  let release, entered; const seen = new Promise(resolve => { entered = resolve; });
  h.db.controls.after = type => type === 'savePosition' && new Promise(resolve => { release = resolve; entered(); });
  h.session.edit({ title: '獨立快照' }); const pending = h.session.submit(); await seen;
  h.ctx.normalGameRecordSession = Object.freeze({ id: 'replacement' }); h.session.close(); release(); await pending;
  assert.equal(h.db.snapshot.envelope.positions.length, 1); assert.equal(h.resumes, 0); assert.equal(h.starts, 0);
  assert.equal(h.db.calls.filter(c => c.type === 'savePosition').length, 1);
});
test('current save conflict preserves input without accepting a newer revision', async () => {
  const h = harness(); h.ctx.saveCurrentGamePosition({}); await h.session.whenReady();
  h.session.edit({ title: '不可覆寫' }); h.db.snapshot.envelope.revision++;
  assert.equal(await h.session.submit(), false); assert.equal(h.session.state().form.title, '不可覆寫');
  assert.equal(h.session.state().form.stale, true); assert.equal(h.db.snapshot.envelope.positions.length, 0);
});
test('UNKNOWN current save never automatically retries', async () => {
  const h = harness(); h.ctx.saveCurrentGamePosition({}); await h.session.whenReady();
  h.session.edit({ title: '查證' }); h.db.controls.result = { status: 'UNKNOWN', persistence: { status: 'UNKNOWN' } };
  assert.equal(await h.session.submit(), false); await h.session.verifyPending();
  assert.equal(h.db.calls.filter(c => c.type === 'savePosition').length, 1); assert.equal(h.starts, 0);
});
test('editor save defaults are unchanged, explicit defaults are isolated', async () => {
  const h = harness(), position = { initialBoard: initialBoard(), sideToMove: 'black' };
  h.session.openSave(position); await h.session.whenReady();
  assert.equal(h.session.state().form.humanSide, 'black'); assert.equal(h.session.state().form.difficulty, 'medium');
  h.session.close(); const preferences = { humanSide: 'red', difficulty: 'hard' };
  h.session.openSave(position, preferences); preferences.humanSide = 'black';
  assert.equal(h.session.state().form.humanSide, 'red');
});

for (const changes of [
  { mode: 'experimental-b' }, { humanSide: 'black' }, { normalGameModeRevision: 2 },
  { normalGameRecordError: { code: 'GAME_RECORD_SESSION_MISMATCH', sessionId: 'original' } },
]) test('inconsistent source cannot open a snapshot save: ' + JSON.stringify(changes), () => {
  const h = harness(); Object.assign(h.ctx, changes);
  assert.equal(h.ctx.saveCurrentGamePosition({}), false);
  assert.equal(h.saves, 0); assert.equal(h.db.calls.length, 0);
});

for (const mutate of [
  h => { h.ctx.mode = 'hard'; }, h => { h.ctx.normalGameModeRevision++; },
  h => { h.ctx.normalGameRecordError = { code: 'GAME_RECORD_POSITION_MISMATCH' }; },
  h => { h.ctx.board[3][0] = null; }, h => { h.ctx.turn = 'black'; },
  h => { h.ctx.history.push({}); }, h => { h.ctx.humanSide = 'black'; },
]) test('expired snapshot cannot write after storage initialization: ' + mutate.toString(), async () => {
  const h = harness(); h.ctx.saveCurrentGamePosition({}); await h.session.whenReady();
  const before = JSON.stringify(h.db.snapshot);
  h.session.edit({ title: '不得寫入' }); mutate(h);
  assert.equal(await h.session.submit(), false);
  assert.equal(JSON.stringify(h.db.snapshot), before);
  assert.equal(h.db.calls.some(c => c.type === 'savePosition'), false);
});

test('B snapshot fixes persistent preferences even for direct form changes; duplicate preserves old data', async () => {
  const h = harness();
  h.ctx.saveCurrentGamePosition({}); await h.session.whenReady();
  h.session.edit({ title: '既有中等局面' }); await h.session.submit(); h.session.close();
  const before = JSON.stringify(h.db.snapshot.envelope.positions);
  h.ctx.mode = 'experimental-b';
  h.ctx.normalGameRecordSession = Object.freeze({ ...h.ctx.normalGameRecordSession, mode: 'experimental-b' });
  h.ctx.saveCurrentGamePosition({}); await h.session.whenReady();
  h.session.edit({ title: '新名稱', humanSide: 'black', difficulty: 'experimental-b' });
  assert.equal(h.session.state().form.difficulty, 'hard');
  assert.equal(h.session.state().form.humanSide, 'red');
  assert.equal(await h.session.submit(), true);
  assert.match(h.session.state().notice, /棋面已存在.*偏好未變更/);
  assert.equal(JSON.stringify(h.db.snapshot.envelope.positions), before);
});
