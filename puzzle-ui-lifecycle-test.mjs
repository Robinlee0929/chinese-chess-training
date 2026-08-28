import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as game from './game.js';
import * as editor from './puzzle-editor.js';
import * as recorder from './puzzle-recorder.js';
import * as practice from './puzzle-practice.js';
import * as review from './puzzle-photo-review.js';
import * as photo from './puzzle-photo.js';
import * as pieceTypes from './puzzle-photo-piece-types.js';
import { createPuzzleStore } from './puzzle-store.js';

// Execute the real UI lifecycle functions with a deterministic clock and minimal
// rendering/DOM doubles. No browser globals are injected and no UI logic is copied.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `main.js function ${name} exists`);
  return match[0];
}
const noop = () => {};
function node() {
  return { classList: { add: noop, remove: noop, toggle: noop }, removeAttribute: noop,
    style: {}, value: '', textContent: '', innerHTML: '' };
}
function vector(x = 0, y = 0, z = 0) {
  return { x, y, z, set(x, y, z) { Object.assign(this, { x, y, z }); },
    clone() { return vector(this.x, this.y, this.z); },
    lerpVectors(a, b, k) { this.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k); } };
}
function harness() {
  const scene = { children: [], add(mesh) { this.children.push(mesh); mesh.parent = this; },
    remove(mesh) { this.children = this.children.filter((entry) => entry !== mesh); mesh.parent = null; } };
  const context = vm.createContext({
    ...game, ...editor, ...recorder, ...practice, ...review, ...photo, ...pieceTypes,
    scene, Y0: 0.18, pieces: [], tweens: [], clock: 0, timers: [], shownResults: [],
    board: game.initialBoard(), turn: game.RED, history: [],
    posHistory: [game.hashBoard(game.initialBoard())], capturedBy: { red: [], black: [] },
    busy: false, over: false, winner: null, aiToken: 0, aiThinking: false, undoCount: 0,
    AI_SIDE: game.BLACK, aiMoveStart: 0,
    practiceToken: 0, appState: 'NORMAL_GAME', editorState: null, recorderState: null,
    practiceState: null, activeSavedPuzzleId: null, practiceCompletionRecorded: false,
    recognitionSession: null, selectedRecognitionKey: null, recognitionUnresolvedOnly: false,
    photoLoadToken: 0, photoRecognitionVersion: 0, calibrationRecognitionVersion: 0,
    pieceTypeRecognitionVersion: 0, photoObjectUrl: null, pendingPhotoObjectUrl: null,
    photoReferenceState: photo.createPhotoReferenceState(), calibrationState: null,
    rectifiedPhotoPixels: null, confirmedCalibration: null, revoked: [],
    APP_STATE: Object.fromEntries(['NORMAL_GAME', 'PUZZLE_EDITOR', 'PUZZLE_CONFIRMED',
      'PUZZLE_RECORDING', 'PUZZLE_RECORDED', 'PUZZLE_PRACTICING', 'PUZZLE_PRACTICE_COMPLETE',
      'PUZZLE_LIBRARY', 'PUZZLE_VIEW'].map((state) => [state, state])),
    sfx: { move: noop, capture: noop, check: noop },
    clearSelection: noop, syncLastMoveMark: noop, refreshHUD: noop, addLog: noop,
    maybeAIMove: noop, showBanner: noop, stopConfetti: noop, toast: noop,
    setRecorderMessage: noop, setPracticeMessage: noop, syncRecorderUI: noop,
    syncPhotoUI: noop, syncRecognitionUI: noop, markPracticeCompleted: noop,
    markPracticeStarted: () => true, isAI: () => false, setEditorTool: noop,
    setEditorMessage: noop, setPhotoImportMessage: noop,
    document: { querySelector: () => ({ checked: false }) },
    window: { confirm: () => false },
    performance: { now: () => context.clock },
    setTimeout: (callback) => context.timers.push(callback),
    showGameOver: (checked) => context.shownResults.push(checked),
    puzzleFlowActive: () => context.appState !== 'NORMAL_GAME',
    URL: { revokeObjectURL: (url) => context.revoked.push(url) },
    Date,
    to3D: (r, c) => vector(c - 4, 0, 4.5 - r),
  });
  for (const name of ['appEl', 'editorPanel', 'recorderPanel', 'libraryPanel', 'banner',
    'overlay', 'logEl', 'logEmpty', 'photoPreviewImage', 'photoFileInput']) context[name] = node();
  context.lastFromMark = { visible: false };
  context.lastToMark = { visible: false };
  context.makePiece = (piece, r, c) => ({
    userData: { r, c, piece }, visible: true, parent: null,
    position: vector(c - 4, context.Y0, 4.5 - r), scale: vector(1, 1, 1), rotation: { y: 0 },
    material: [{ shared: true }, { disposed: false, dispose() { this.disposed = true; },
      map: { disposed: false, dispose() { this.disposed = true; } } }, { shared: true }],
  });
  context.ease = (k) => k;
  const names = ['tween', 'stepTweens', 'pieceAt', 'releasePieceMesh', 'rebuildPieceMeshes', 'buildScene',
    'checkBoardMeshInvariant', 'syncEditorScene', 'syncRecorderScene', 'syncPracticeScene',
    'animateCapture', 'doMove', 'finishMove', 'undoPly', 'undo', 'newGame', 'resetTo',
    'doRecorderMove', 'finishRecorderMove', 'resetRecorder', 'undoRecorder',
    'animatePracticeMove', 'afterPracticeMove', 'queueOpponentReply', 'completePractice',
    'restartCurrentPractice', 'resetRecognitionReview', 'invalidateRecognition',
    'invalidateRecognitionForCalibrationChange', 'invalidateCalibration', 'releasePhotoReference',
    'enterEditor', 'exitEditor', 'onAIResult'];
  vm.runInContext(names.map(functionSource).join('\n'), context);
  context.flushAnimations = () => {
    let guard = 0;
    while (context.tweens.length) {
      assert.ok(++guard < 20, 'animations terminate');
      context.clock += 2000;
      context.stepTweens(context.clock);
    }
  };
  context.flushTimers = () => context.timers.splice(0).forEach((fn) => fn());
  return context;
}
const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
function invariant(ctx, board) {
  const result = ctx.checkBoardMeshInvariant(board);
  assert.equal(result.ok, true, result.errors.join(' '));
}
function fixture() {
  const board = editor.createEmptyEditorBoard();
  for (const [r, c, side, type] of [[9, 4, 'black', 'K'], [0, 3, 'red', 'K'],
    [8, 0, 'red', 'R'], [6, 8, 'red', 'R'], [5, 3, 'red', 'P'],
    [3, 0, 'red', 'P'], [5, 6, 'red', 'P'], [6, 6, 'black', 'P'], [9, 8, 'black', 'P']]) {
    board[r][c] = { side, type };
  }
  return { initialBoard: board, sideToMove: 'red', solution: [
    { side: 'red', from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
    { side: 'black', from: { r: 6, c: 6 }, to: { r: 5, c: 6 } },
    { side: 'red', from: { r: 6, c: 8 }, to: { r: 9, c: 8 } },
  ] };
}

test('normal move/capture and both undos preserve the existing mesh invariant', () => {
  const ctx = harness();
  const before = structuredClone(ctx.board);
  ctx.rebuildPieceMeshes(ctx.board);
  ctx.doMove({ r: 3, c: 4 }, { r: 4, c: 4 });
  ctx.flushAnimations();
  invariant(ctx, ctx.board);
  same(ctx.posHistory, [game.hashBoard(before), game.hashBoard(ctx.board)]);
  ctx.undo();
  invariant(ctx, ctx.board);
  same(ctx.board, before);
  same(ctx.posHistory, [game.hashBoard(before)]);
  ctx.doMove({ r: 2, c: 1 }, { r: 9, c: 1 });
  ctx.flushAnimations();
  invariant(ctx, ctx.board);
  ctx.undo();
  invariant(ctx, ctx.board);
  same(ctx.board, before);
  assert.ok(game.legalMoves(ctx.board, 9, 1).some(({ r, c }) => r === 7 && c === 2));
  same(ctx.posHistory, [game.hashBoard(before)]);
  ctx.resetTo(fixture().initialBoard, game.RED);
  same(ctx.posHistory, [game.hashBoard(ctx.board)]);
  ctx.newGame();
  same(ctx.posHistory, [game.hashBoard(game.initialBoard())]);
});

test('integration retains upstream stage controls and unique puzzle DOM hooks', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'DOM IDs remain unique');
  for (const id of ['stage', 'btnLock', 'btnLockText', 'turn', 'turnDot', 'turnText',
    'hudMore', 'btnMore', 'btnHelp', 'editorPanel', 'recorderPanel', 'libraryPanel', 'photoPanel']) {
    assert.ok(ids.includes(id), `${id} retained`);
  }
  assert.match(html, /id="stage">[^]*?id="btnLock"[^]*?id="turn" aria-live="polite"/);
  assert.match(source, /hasAnyLegalMove, name, notation, hashBoard,/);
  assert.match(source, /camera, renderer, scene, controls,/);
  assert.equal((source.match(/renderer\.setAnimationLoop\(tick\)/g) || []).length, 1);
});

test('editor place/move/delete and photo-review handoff share the mesh registry', () => {
  const ctx = harness();
  ctx.editorState = editor.placeEditorPiece(editor.createEditorState(), { type: 'R', side: 'red' }, { r: 0, c: 0 });
  ctx.syncEditorScene(); invariant(ctx, ctx.editorState.board);
  ctx.editorState = editor.moveEditorPiece(ctx.editorState, { r: 0, c: 0 }, { r: 8, c: 8 });
  ctx.syncEditorScene(); invariant(ctx, ctx.editorState.board);
  ctx.editorState = editor.removeEditorPiece(ctx.editorState, { r: 8, c: 8 });
  ctx.syncEditorScene(); invariant(ctx, ctx.editorState.board);
  const candidates = fixture().initialBoard.flatMap((row, r) => row.map((_, c) => ({
    r, c, occupancy: 'empty', occupancyConfidence: 0.9, suggestedSide: 'unknown', sideConfidence: 0,
  })));
  let state = review.acceptHighConfidenceEmpty(review.createReviewState(candidates));
  for (const [r, c, side] of [[0, 3, 'red'], [9, 4, 'black']]) {
    state = review.confirmPiece(state, `${r},${c}`, { type: 'K', side });
  }
  ctx.editorState = editor.createEditorState({ board: review.buildReviewedBoard(state) });
  ctx.syncEditorScene(); invariant(ctx, ctx.editorState.board);
});

test('recorder moves/captures/undo/reset preserve mesh and logical board agreement', () => {
  const ctx = harness();
  const puzzle = fixture();
  ctx.appState = 'PUZZLE_RECORDING';
  ctx.recorderState = recorder.createRecorder(puzzle);
  ctx.syncRecorderScene();
  for (const move of puzzle.solution) {
    ctx.doRecorderMove(move.from, move.to); ctx.flushAnimations();
    invariant(ctx, ctx.recorderState.board);
  }
  ctx.undoRecorder(); invariant(ctx, ctx.recorderState.board);
  assert.equal(ctx.recorderState.board[9][8].side, 'black');
  ctx.resetRecorder(); invariant(ctx, ctx.recorderState.board);
  same(ctx.recorderState.board, puzzle.initialBoard);
});

test('saved puzzle load, automatic reply capture, user capture and restart retain meshes', () => {
  const ctx = harness();
  let serialized = null;
  const store = createPuzzleStore({ storage: { getItem: () => serialized, setItem: (_, value) => { serialized = value; } } });
  const saved = store.savePuzzle({ title: 'release', ...fixture() });
  const loaded = store.getPuzzle(saved.id);
  ctx.rebuildPieceMeshes(loaded.initialBoard); invariant(ctx, loaded.initialBoard);
  ctx.appState = 'PUZZLE_PRACTICING';
  ctx.practiceState = practice.createPractice(loaded);
  ctx.syncPracticeScene();
  const first = practice.attemptPracticeMove(ctx.practiceState, loaded.solution[0].from, loaded.solution[0].to);
  ctx.practiceState = first.practice; ctx.animatePracticeMove(first); ctx.flushAnimations();
  invariant(ctx, ctx.practiceState.currentBoard);
  ctx.flushTimers(); ctx.flushAnimations();
  invariant(ctx, ctx.practiceState.currentBoard);
  assert.equal(ctx.practiceState.currentBoard[5][6].side, 'black');
  const final = practice.attemptPracticeMove(ctx.practiceState, loaded.solution[2].from, loaded.solution[2].to);
  ctx.practiceState = final.practice; ctx.animatePracticeMove(final); ctx.flushAnimations();
  invariant(ctx, ctx.practiceState.currentBoard);
  assert.equal(ctx.appState, 'PUZZLE_PRACTICE_COMPLETE');
  ctx.restartCurrentPractice(); invariant(ctx, ctx.practiceState.currentBoard);
  same(ctx.practiceState.currentBoard, loaded.initialBoard);
});

test('restarting or exiting practice cancels a queued opponent capture', () => {
  for (const exit of [false, true]) {
    const ctx = harness();
    const puzzle = fixture();
    ctx.appState = 'PUZZLE_PRACTICING';
    ctx.practiceState = practice.attemptPracticeMove(practice.createPractice(puzzle), puzzle.solution[0].from, puzzle.solution[0].to).practice;
    ctx.queueOpponentReply();
    if (exit) ctx.exitEditor(); else ctx.restartCurrentPractice();
    ctx.flushTimers(); ctx.flushAnimations();
    if (exit) {
      assert.equal(ctx.appState, 'NORMAL_GAME'); invariant(ctx, ctx.board);
    } else {
      assert.equal(ctx.practiceState.currentPly, 0);
      invariant(ctx, ctx.practiceState.currentBoard);
    }
  }
});

test('delayed game-over result cannot cross new-game, undo or puzzle-entry boundaries', () => {
  for (const action of ['newGame', 'undo', 'enterEditor']) {
    const ctx = harness();
    const puzzle = fixture();
    ctx.board = structuredClone(puzzle.initialBoard);
    for (const move of puzzle.solution) game.applyMove(ctx.board, move.from, move.to);
    ctx.rebuildPieceMeshes(ctx.board);
    ctx.turn = 'red';
    ctx.finishMove('mate', null);
    assert.equal(ctx.over, true);
    if (action === 'undo') {
      const move = puzzle.solution[2];
      ctx.history = [{ ...move, nota: 'mate', captured: { type: 'P', side: 'black' } }];
    }
    ctx[action]();
    ctx.flushTimers();
    assert.equal(ctx.shownResults.length, 0, `${action} must cancel old result`);
  }
});

test('native review-reset cancellation preserves state; confirmation clears decisions', () => {
  const ctx = harness();
  const candidates = Array.from({ length: 90 }, (_, i) => ({
    r: Math.floor(i / 9), c: i % 9, occupancy: 'empty', occupancyConfidence: 0.9,
    suggestedSide: 'unknown', sideConfidence: 0,
  }));
  const confirmed = review.confirmPiece(review.acceptHighConfidenceEmpty(review.createReviewState(candidates)), '0,3', { type: 'K', side: 'red' });
  ctx.recognitionSession = { review: confirmed, typeLibrary: { templates: ['sentinel'] }, typeSuggestions: { test: 'sentinel' } };
  ctx.resetRecognitionReview();
  assert.equal(ctx.recognitionSession.review, confirmed);
  assert.deepEqual(ctx.recognitionSession.typeLibrary.templates, ['sentinel']);
  ctx.window.confirm = () => true;
  ctx.resetRecognitionReview();
  assert.equal(review.unresolvedCount(ctx.recognitionSession.review), 90);
  assert.equal(pieceTypes.listTemplates(ctx.recognitionSession.typeLibrary).length, 0);
  assert.equal(Object.keys(ctx.recognitionSession.typeSuggestions).length, 0);
});

test('late AI results and delayed AI moves cannot enter a puzzle or later game', () => {
  for (const transition of ['enterEditor', 'newGame']) {
    const ctx = harness();
    ctx.rebuildPieceMeshes(ctx.board);
    ctx.turn = 'black';
    ctx.aiToken = 7; ctx.aiThinking = true;
    const result = { from: { r: 6, c: 0 }, to: { r: 5, c: 0 } };
    ctx.onAIResult({ token: 7, result });
    ctx[transition]();
    ctx.flushTimers(); ctx.flushAnimations();
    ctx.onAIResult({ token: 7, result });
    assert.equal(ctx.history.length, 0);
    assert.equal(ctx.timers.length, 0);
    assert.equal(ctx.aiThinking, false);
    invariant(ctx, transition === 'enterEditor' ? ctx.editorState.board : ctx.board);
  }
});

test('authoring exit revokes both photo URLs and invalidates recognition/session state', () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_EDITOR';
  ctx.photoObjectUrl = 'blob:current'; ctx.pendingPhotoObjectUrl = 'blob:pending';
  ctx.photoReferenceState = photo.createPhotoReferenceState({ name: 'local.png', type: 'image/png', size: 100 });
  ctx.calibrationState = {}; ctx.confirmedCalibration = {}; ctx.rectifiedPhotoPixels = { data: [1] };
  ctx.recognitionSession = { typeLibrary: { templates: ['private'] } };
  const token = ctx.photoLoadToken;
  ctx.exitEditor();
  assert.deepEqual(ctx.revoked, ['blob:current', 'blob:pending']);
  assert.ok(ctx.photoLoadToken > token);
  for (const key of ['photoObjectUrl', 'pendingPhotoObjectUrl', 'calibrationState', 'confirmedCalibration', 'rectifiedPhotoPixels', 'recognitionSession']) assert.equal(ctx[key], null);
  assert.equal(ctx.photoReferenceState.photo, null);
});

test('mesh checker detects off-square, zero-scale and unregistered scene ghosts', () => {
  const ctx = harness();
  ctx.rebuildPieceMeshes(ctx.board);
  const piece = ctx.pieces[0];
  piece.position.x += 2;
  assert.equal(ctx.checkBoardMeshInvariant(ctx.board).ok, false, 'off-square');
  piece.position.x -= 2;
  piece.scale.set(0, 0, 0);
  assert.equal(ctx.checkBoardMeshInvariant(ctx.board).ok, false, 'zero-scale');
  piece.scale.set(1, 1, 1);
  ctx.scene.add(ctx.makePiece(piece.userData.piece, piece.userData.r, piece.userData.c));
  assert.equal(ctx.checkBoardMeshInvariant(ctx.board).ok, false, 'unregistered duplicate');
});

test('blocked localStorage getter does not prevent UI store construction', () => {
  const match = source.match(/const puzzleStore = createPuzzleStore\([^]*?\);/);
  assert.ok(match);
  const window = Object.defineProperty({}, 'localStorage', { get() { throw new Error('SecurityError'); } });
  const context = vm.createContext({ window, createPuzzleStore });
  vm.runInContext(`${match[0]}\nthis.store = puzzleStore;`, context);
  assert.equal(context.store.loadAll().issues[0].code, 'STORE_READ_FAILED');
});

test('rebuild and capture release per-piece GPU resources, preserving shared materials', () => {
  const ctx = harness();
  ctx.rebuildPieceMeshes(ctx.board);
  const oldMeshes = [...ctx.pieces];
  ctx.rebuildPieceMeshes(ctx.board);
  for (const mesh of oldMeshes) {
    assert.equal(mesh.material[1].disposed, true);
    assert.equal(mesh.material[1].map.disposed, true);
    assert.equal(mesh.material[0].shared, true);
    assert.equal(mesh.material[2].shared, true);
  }
  const captured = ctx.pieceAt(9, 1);
  ctx.doMove({ r: 2, c: 1 }, { r: 9, c: 1 }); ctx.flushAnimations();
  assert.equal(captured.material[1].disposed, true);
  assert.equal(captured.material[1].map.disposed, true);
});
