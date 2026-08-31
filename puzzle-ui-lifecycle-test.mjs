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
import * as transfer from './puzzle-transfer.js';
import * as analytics from './puzzle-analytics.js';
import { PuzzleStoreError, createPuzzleStore } from './puzzle-store.js';

// Execute the real UI lifecycle functions with a deterministic clock and minimal
// rendering/DOM doubles. No browser globals are injected and no UI logic is copied.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `main.js function ${name} exists`);
  return match[0];
}
const noop = () => {};
function node() {
  const classes = new Set();
  return { classList: {
    add: (...keys) => keys.forEach((key) => classes.add(key)),
    remove: (...keys) => keys.forEach((key) => classes.delete(key)),
    toggle(key, force) {
      const enabled = force === undefined ? !classes.has(key) : force;
      if (enabled) classes.add(key); else classes.delete(key);
      return enabled;
    },
    contains: (key) => classes.has(key),
  }, removeAttribute(key) { delete this[key]; },
  style: {}, value: '', textContent: '', innerHTML: '', disabled: false };
}
const photoCanvasNames = ['calibrationCornerCanvas', 'calibrationRectifiedCanvas',
  'recognitionCanvas', 'recognitionTargetCanvas'];
function photoCanvas(width = 4, height = 3) {
  // Canvas dimension assignments reset pixels even when the dimension is unchanged.
  return {
    _width: width, height, pixels: new Uint8ClampedArray(width * height * 4), resets: 0,
    get width() { return this._width; },
    set width(value) {
      this._width = value;
      this.pixels = new Uint8ClampedArray(value * this.height * 4);
      this.resets++;
    },
  };
}
function vector(x = 0, y = 0, z = 0) {
  return { x, y, z, set(x, y, z) { Object.assign(this, { x, y, z }); },
    clone() { return vector(this.x, this.y, this.z); },
    lerpVectors(a, b, k) { this.set(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k); } };
}
function harness() {
  let analyticsSerialized = null;
  let analyticsWrites = 0;
  let analyticsTick = 0;
  const analyticsStorage = {
    getItem: () => analyticsSerialized,
    setItem: (_, value) => { analyticsWrites++; analyticsSerialized = value; },
    get writes() { return analyticsWrites; },
    get serialized() { return analyticsSerialized; },
  };
  const practiceAnalyticsStore = analytics.createPracticeAnalyticsStore({
    storage: analyticsStorage,
    now: () => new Date(Date.UTC(2026, 7, 30, 15, 0, analyticsTick++)).toISOString(),
  });
  const scene = { children: [], add(mesh) { this.children.push(mesh); mesh.parent = this; },
    remove(mesh) { this.children = this.children.filter((entry) => entry !== mesh); mesh.parent = null; } };
  const context = vm.createContext({
    ...game, ...editor, ...recorder, ...practice, ...review, ...photo, ...pieceTypes, ...transfer, ...analytics,
    PuzzleStoreError, Blob,
    scene, Y0: 0.18, pieces: [], tweens: [], clock: 0, timers: [], shownResults: [],
    board: game.initialBoard(), turn: game.RED, history: [],
    selected: null, legal: [],
    posHistory: [game.hashBoard(game.initialBoard())], capturedBy: { red: [], black: [] },
    repHistory: [{ key: game.hashBoard(game.initialBoard()) + '|red', mover: null, check: false }],
    busy: false, over: false, winner: null, aiToken: 0, aiThinking: false, undoCount: 0,
    AI_SIDE: game.BLACK, aiMoveStart: 0,
    practiceToken: 0, appState: 'NORMAL_GAME', editorState: null, recorderState: null,
    practiceState: null, activeSavedPuzzleId: null, practiceCompletionRecorded: false,
    practiceHintLevel: 0, practiceHint: null, practiceAttempt: null, hintMarkerRoles: [],
    practiceAnalyticsStore, analyticsStorage,
    recordedPuzzleResult: null, practiceReturnState: 'recorded', libraryViewPuzzle: null,
    recognitionSession: null, selectedRecognitionKey: null, recognitionUnresolvedOnly: false,
    photoLoadToken: 0, photoRecognitionVersion: 0, calibrationRecognitionVersion: 0,
    pieceTypeRecognitionVersion: 0, photoObjectUrl: null, pendingPhotoObjectUrl: null, createdUrls: [],
    savedCurrentPuzzleId: null,
    pendingPuzzleImport: null, puzzleImportToken: 0,
    photoReferenceState: photo.createPhotoReferenceState(), calibrationState: null,
    rectifiedPhotoPixels: null, confirmedCalibration: null, revoked: [],
    APP_STATE: Object.fromEntries(['NORMAL_GAME', 'PUZZLE_EDITOR', 'PUZZLE_CONFIRMED',
      'PUZZLE_RECORDING', 'PUZZLE_RECORDED', 'PUZZLE_PRACTICING', 'PUZZLE_PRACTICE_COMPLETE',
      'PUZZLE_LIBRARY', 'PUZZLE_VIEW'].map((state) => [state, state])),
    sfx: { move: noop, capture: noop, check: noop },
    clearSelection: noop, syncLastMoveMark: noop, refreshHUD: noop, addLog: noop,
    clearPracticeHintMarkers: () => { context.hintMarkerRoles = []; },
    syncPracticeHintMarkers: () => {
      context.hintMarkerRoles = [context.practiceHint?.from && 'source', context.practiceHint?.to && 'target'].filter(Boolean);
    },
    maybeAIMove: noop, showBanner: noop, stopConfetti: noop, toast: noop,
    setRecorderMessage: noop, setPracticeMessage: noop,
    syncRecorderUI: () => { if (context.practiceState && context.syncPracticeUI) context.syncPracticeUI(); },
    syncPhotoUI: noop, syncRecognitionUI: noop, markPracticeCompleted: noop,
    markPracticeStarted: () => true, isAI: () => false, setEditorTool: noop,
    setEditorMessage: noop, setPhotoImportMessage: noop, renderLibraryList: noop, openLibraryPuzzle: noop,
    decodePhotoObjectUrl: async () => ({ naturalWidth: 4, naturalHeight: 3 }),
    document: { querySelector: () => ({ checked: false }) },
    window: { confirm: () => false },
    performance: { now: () => context.clock },
    setTimeout: (callback) => context.timers.push(callback),
    showGameOver: (endReason) => context.shownResults.push(endReason),
    puzzleFlowActive: () => context.appState !== 'NORMAL_GAME',
    libraryActive: () => ['PUZZLE_LIBRARY', 'PUZZLE_VIEW'].includes(context.appState),
    practiceActive: () => ['PUZZLE_PRACTICING', 'PUZZLE_PRACTICE_COMPLETE'].includes(context.appState),
    URL: { revokeObjectURL: (url) => context.revoked.push(url),
      createObjectURL: () => { const url = `blob:new-${context.createdUrls.length}`; context.createdUrls.push(url); return url; } },
    Date,
    to3D: (r, c) => vector(c - 4, 0, 4.5 - r),
  });
  for (const name of ['appEl', 'editorPanel', 'recorderPanel', 'libraryPanel', 'banner',
    'overlay', 'logEl', 'logEmpty', 'photoPreviewImage', 'photoFileInput', 'puzzleImportFile',
    'libraryTransferStatus', 'libraryImportPreview', 'libraryImportPreviewText',
    'btnLibraryImportConfirm', 'recorderTitle', 'recorderSubtitle', 'recorderBadge',
    'practiceTurnText', 'practiceTurnDot', 'practiceProgress', 'practiceMistakes',
    'practiceMessage', 'practiceHintMessage', 'btnPracticeHint', 'btnPracticeRestart',
    'btnPracticeExit']) context[name] = node();
  for (const name of photoCanvasNames) context[name] = name === 'recognitionTargetCanvas'
    ? photoCanvas(112, 112) : photoCanvas();
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
    'formatPracticeCoordinate', 'formatPracticeHintMessage', 'practiceHintAvailable',
    'syncPracticeHintUI', 'clearPracticeHint', 'requestPracticeHint', 'setPracticeMessage',
    'beginPracticeAttempt', 'recordPracticeHintRequest', 'finalizePracticeAttempt',
    'syncPracticeUI', 'startPractice', 'startSavedPractice', 'doPracticeMove', 'exitPractice',
    'restartCurrentPractice', 'resetRecognitionReview', 'invalidateRecognition',
    'invalidateRecognitionForCalibrationChange', 'invalidateCalibration', 'releasePhotoReference',
    'enterEditor', 'exitEditor', 'enterLibrary', 'markEditorDirty', 'onAIResult',
    'loadSelectedPhoto', 'photoErrorMessage', 'storeErrorMessage', 'transferErrorMessage',
    'setLibraryTransferStatus', 'preparePuzzleImportPreview', 'clearPendingPuzzleImport',
    'downloadPuzzleTransfer', 'loadPuzzleImportFile', 'cancelPuzzleImport', 'confirmPuzzleImport'];
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
  same(ctx.repHistory, [{ key: game.hashBoard(game.initialBoard()) + '|red', mover: null, check: false }]);
});

function playNormal(ctx, from, to) {
  assert.equal(ctx.board[from.r][from.c].side, ctx.turn);
  assert.ok(game.legalMoves(ctx.board, from.r, from.c).some(m => m.r === to.r && m.c === to.c));
  ctx.doMove(from, to);
  ctx.flushAnimations();
  invariant(ctx, ctx.board);
  assert.equal(ctx.repHistory.length, ctx.history.length + 1);
  assert.equal(ctx.repHistory.at(-1).key, game.hashBoard(ctx.board) + '|' + ctx.turn);
}

function repetitionFixture(perpetual = false) {
  if (!perpetual) return { board: game.initialBoard(), turn: 'red', cycle: [
    [{ r: 0, c: 1 }, { r: 2, c: 2 }], [{ r: 9, c: 1 }, { r: 7, c: 2 }],
    [{ r: 2, c: 2 }, { r: 0, c: 1 }], [{ r: 7, c: 2 }, { r: 9, c: 1 }],
  ] };
  const board = editor.createEmptyEditorBoard();
  board[0][3] = { type: 'K', side: 'red' };
  board[7][0] = { type: 'R', side: 'red' };
  board[7][4] = { type: 'K', side: 'black' };
  return { board, turn: 'black', cycle: [
    [{ r: 7, c: 4 }, { r: 8, c: 4 }], [{ r: 7, c: 0 }, { r: 8, c: 0 }],
    [{ r: 8, c: 4 }, { r: 7, c: 4 }], [{ r: 8, c: 0 }, { r: 7, c: 0 }],
  ] };
}

for (const perpetual of [false, true]) {
  test(`normal ${perpetual ? 'perpetual check' : 'threefold draw'} adjudication, undo and reset`, () => {
    const ctx = harness();
    const setup = repetitionFixture(perpetual);
    ctx.resetTo(setup.board, setup.turn);
    same(ctx.repHistory, [{ key: game.hashBoard(ctx.board) + '|' + setup.turn, mover: null, check: false }]);
    for (const move of setup.cycle) playNormal(ctx, ...move);
    assert.equal(ctx.over, false, 'second occurrence is not terminal');
    for (const move of setup.cycle) playNormal(ctx, ...move);
    assert.equal(ctx.over, true);
    assert.equal(ctx.winner, perpetual ? 'black' : null);
    ctx.flushTimers();
    same(ctx.shownResults, [perpetual ? '長將' : '三次重複局面']);
    ctx.undo();
    assert.equal(ctx.over, false);
    assert.equal(ctx.winner, null);
    assert.equal(ctx.repHistory.length, 8);
    assert.equal(ctx.repHistory.at(-1).key, game.hashBoard(ctx.board) + '|' + ctx.turn);
    playNormal(ctx, ...setup.cycle.at(-1));
    assert.equal(ctx.over, true, 'replaying the undone move restores the verdict');
    ctx.newGame();
    ctx.flushTimers();
    assert.equal(ctx.over, false);
    same(ctx.shownResults, [perpetual ? '長將' : '三次重複局面'], 'new game cancels the old result');
    same(ctx.repHistory, [{ key: game.hashBoard(ctx.board) + '|red', mover: null, check: false }]);
  });
}

test('normal repetition history remains isolated across editor, recorder, practice and library', () => {
  const ctx = harness();
  ctx.newGame();
  for (const move of repetitionFixture().cycle) playNormal(ctx, ...move);
  const normalBoard = structuredClone(ctx.board);
  const normalHistory = structuredClone(ctx.repHistory);
  ctx.enterEditor();
  const puzzle = fixture();
  ctx.recorderState = recorder.createRecorder(puzzle);
  ctx.appState = 'PUZZLE_RECORDING';
  ctx.syncRecorderScene();
  for (const move of puzzle.solution) {
    ctx.doRecorderMove(move.from, move.to); ctx.flushAnimations();
  }
  ctx.practiceState = practice.createPractice(puzzle);
  ctx.appState = 'PUZZLE_PRACTICING';
  ctx.syncPracticeScene();
  const first = practice.attemptPracticeMove(ctx.practiceState, puzzle.solution[0].from, puzzle.solution[0].to);
  ctx.practiceState = first.practice; ctx.animatePracticeMove(first); ctx.flushAnimations();
  ctx.flushTimers(); ctx.flushAnimations();
  const last = practice.attemptPracticeMove(ctx.practiceState, puzzle.solution[2].from, puzzle.solution[2].to);
  ctx.practiceState = last.practice; ctx.animatePracticeMove(last); ctx.flushAnimations();
  assert.equal(ctx.appState, 'PUZZLE_PRACTICE_COMPLETE');
  same(ctx.repHistory, normalHistory);
  ctx.exitEditor();
  ctx.enterLibrary();
  same(ctx.repHistory, normalHistory);
  ctx.exitEditor();
  same(ctx.board, normalBoard);
  same(ctx.repHistory, normalHistory);
  for (const move of repetitionFixture().cycle) playNormal(ctx, ...move);
  assert.equal(ctx.over, true);
  assert.equal(ctx.winner, null, 'normal game resumes its own repetition count');
});

test('real result presenter treats draws neutrally and reports long-check loser correctly', () => {
  for (const [mode, winner, reason, title] of [
    ['pvp', null, '三次重複局面', '和局'], ['medium', null, '雙方長將', '和局'],
    ['pvp', 'black', '長將', '黑方勝'], ['medium', 'black', '長將', '惜敗…'],
  ]) {
    const ctx = harness();
    const calls = [];
    Object.assign(ctx, { mode, winner, history: Array(8).fill({}), gameStartTime: Date.now(),
      DIFF: { medium: { label: '中等', stars: 2 } }, SITE_URL: 'http://127.0.0.1:8000/',
      isAI: () => mode !== 'pvp', fmtTime: () => '0:01',
      startConfetti: () => calls.push('confetti'), stopConfetti: () => calls.push('stop'),
      sfx: { win: () => calls.push('win'), lose: () => calls.push('lose') },
    });
    for (const id of ['ovCard', 'ovBadge', 'ovTitle', 'ovStars', 'ovSub', 'ovReason',
      'stRounds', 'stTime', 'stCaps', 'stUndo', 'btnShare']) ctx[id] = node();
    const classes = {};
    ctx.ovCard.classList.toggle = (key, value) => { classes[key] = value; };
    vm.runInContext(functionSource('showGameOver'), ctx);
    ctx.showGameOver(reason);
    assert.equal(ctx.ovTitle.textContent, title);
    assert.equal(ctx.lastResult.draw, winner === null);
    if (winner === null) {
      assert.equal(ctx.ovStars.style.display, 'none');
      assert.equal(ctx.btnShare.style.display, 'none');
      assert.equal(classes.win, false); assert.equal(classes.lose, false);
      assert.equal(ctx.ovReason.textContent, `${reason}，判和`);
      assert.equal(ctx.lastResult.reasonChars, '和棋');
      assert.deepEqual(calls, ['stop']);
    } else {
      assert.match(ctx.ovReason.textContent, /長將.*判負/);
      assert.equal(ctx.lastResult.reasonChars, '長將');
    }
  }
});

test('integration retains upstream stage controls and unique puzzle DOM hooks', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'DOM IDs remain unique');
  for (const id of ['stage', 'btnLock', 'btnLockText', 'turn', 'turnDot', 'turnText',
    'hudMore', 'btnMore', 'btnHelp', 'editorPanel', 'recorderPanel', 'libraryPanel', 'photoPanel',
    'btnPracticeHint', 'practiceHintMessage', 'libraryAnalyticsHeading', 'libraryAnalyticsStatus',
    'libraryAnalyticsSummary', 'libraryRecentAttempts']) {
    assert.ok(ids.includes(id), `${id} retained`);
  }
  assert.match(html, /id="stage">[^]*?id="btnLock"[^]*?id="turn" aria-live="polite"/);
  assert.match(html, /id="practiceHintMessage"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<section class="library-analytics"[^>]*aria-labelledby="libraryAnalyticsHeading"/);
  assert.match(html, /id="libraryAnalyticsStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<ol id="libraryRecentAttempts"[^>]*aria-label="[^"]+"/);
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

function beginHintPractice(ctx, puzzle = fixture()) {
  ctx.practiceState = practice.createPractice(puzzle);
  ctx.appState = 'PUZZLE_PRACTICING';
  ctx.syncPracticeScene();
  ctx.clearPracticeHint();
  return puzzle;
}

test('practice hints progress from piece to source, target and notation without early disclosure', () => {
  const ctx = harness();
  ctx.recordedPuzzleResult = fixture();
  ctx.appState = 'PUZZLE_RECORDED';
  ctx.startPractice();
  assert.equal(ctx.practiceHintLevel, 0);
  assert.equal(ctx.practiceHint, null);
  assert.equal(ctx.practiceHintMessage.textContent, '');
  assert.equal(ctx.practiceHintMessage.classList.contains('hidden'), true);
  assert.equal(ctx.btnPracticeHint.textContent, '提示');
  assert.equal(ctx.btnPracticeHint.disabled, false);

  ctx.requestPracticeHint();
  assert.equal(ctx.practiceHintLevel, 1);
  assert.equal(ctx.btnPracticeHint.textContent, '再提示');
  assert.match(ctx.practiceHintMessage.textContent, /請考慮「兵」/);
  assert.doesNotMatch(ctx.practiceHintMessage.textContent, /起點|目標|答案|兵九進一/);
  same(ctx.hintMarkerRoles, []);

  ctx.requestPracticeHint();
  assert.equal(ctx.practiceHintLevel, 2);
  assert.match(ctx.practiceHintMessage.textContent, /起點：紅方視角，自底線起第 4 橫列、自左側起第 1 直路/);
  assert.doesNotMatch(ctx.practiceHintMessage.textContent, /目標|答案|兵九進一/);
  same(ctx.hintMarkerRoles, ['source']);
  assert.equal(ctx.selected, null);
  same(ctx.legal, []);

  ctx.requestPracticeHint();
  assert.equal(ctx.practiceHintLevel, 3);
  assert.match(ctx.practiceHintMessage.textContent, /目標：紅方視角，自底線起第 5 橫列、自左側起第 1 直路/);
  assert.doesNotMatch(ctx.practiceHintMessage.textContent, /答案|兵九進一/);
  same(ctx.hintMarkerRoles, ['source', 'target']);
  assert.equal(ctx.btnPracticeHint.textContent, '顯示答案');

  ctx.requestPracticeHint();
  assert.equal(ctx.practiceHintLevel, 4);
  assert.match(ctx.practiceHintMessage.textContent, /答案：兵九進一/);
  assert.equal(ctx.btnPracticeHint.textContent, '已顯示答案');
  assert.equal(ctx.btnPracticeHint.disabled, true);
  const shown = ctx.practiceHint;
  ctx.requestPracticeHint();
  assert.equal(ctx.practiceHint, shown, 'disabled max-level click is inert');
});

test('wrong moves preserve the requested hint; a correct move clears it before opponent reply', () => {
  const ctx = harness();
  const puzzle = beginHintPractice(ctx);
  ctx.requestPracticeHint();
  ctx.requestPracticeHint();
  const hintText = ctx.practiceHintMessage.textContent;
  ctx.doPracticeMove({ r: 8, c: 0 }, { r: 7, c: 0 });
  assert.equal(ctx.practiceState.mistakes, 1);
  assert.equal(ctx.practiceHintLevel, 2);
  assert.equal(ctx.practiceHintMessage.textContent, hintText);
  same(ctx.hintMarkerRoles, ['source']);

  ctx.doPracticeMove(puzzle.solution[0].from, puzzle.solution[0].to);
  assert.equal(ctx.practiceHintLevel, 0, 'cleared synchronously before animation/reply');
  assert.equal(ctx.practiceHint, null);
  same(ctx.hintMarkerRoles, []);
  assert.equal(ctx.btnPracticeHint.disabled, true);
  ctx.flushAnimations();
  assert.equal(ctx.timers.length, 1);
  assert.equal(ctx.btnPracticeHint.disabled, true, 'opponent turn remains guarded');
  ctx.requestPracticeHint();
  assert.equal(ctx.practiceHintLevel, 0, 'disabled opponent-turn click is inert');
  ctx.flushTimers();
  ctx.flushAnimations();
  assert.equal(ctx.practiceState.currentPly, 2);
  assert.equal(ctx.practiceHintLevel, 0);
  assert.equal(ctx.btnPracticeHint.textContent, '提示');
  assert.equal(ctx.btnPracticeHint.disabled, false);
});

test('restart, completion and exit clear hint text, markers and level', () => {
  const ctx = harness();
  beginHintPractice(ctx);
  ctx.requestPracticeHint(); ctx.requestPracticeHint(); ctx.requestPracticeHint();
  ctx.restartCurrentPractice();
  assert.equal(ctx.practiceHintLevel, 0);
  assert.equal(ctx.practiceHintMessage.textContent, '');
  same(ctx.hintMarkerRoles, []);

  ctx.requestPracticeHint();
  ctx.practiceReturnState = 'library';
  ctx.exitPractice();
  assert.equal(ctx.practiceHintLevel, 0);
  assert.equal(ctx.practiceHint, null);
  same(ctx.hintMarkerRoles, []);

  const captureMate = fixture();
  captureMate.solution = [captureMate.solution[2]];
  beginHintPractice(ctx, captureMate);
  ctx.requestPracticeHint();
  ctx.doPracticeMove(captureMate.solution[0].from, captureMate.solution[0].to);
  assert.equal(ctx.practiceHintLevel, 0);
  ctx.flushAnimations();
  assert.equal(ctx.appState, 'PUZZLE_PRACTICE_COMPLETE');
  assert.equal(ctx.btnPracticeHint.disabled, true);
  assert.equal(ctx.practiceHintMessage.textContent, '');
  same(ctx.hintMarkerRoles, []);
});

test('stale opponent callbacks cannot restore hints after restart or a different puzzle start', () => {
  const ctx = harness();
  const puzzle = beginHintPractice(ctx);
  ctx.requestPracticeHint();
  ctx.doPracticeMove(puzzle.solution[0].from, puzzle.solution[0].to);
  ctx.flushAnimations();
  assert.equal(ctx.timers.length, 1);
  ctx.restartCurrentPractice();
  ctx.requestPracticeHint();
  assert.equal(ctx.practiceHintLevel, 1);
  ctx.flushTimers(); ctx.flushAnimations();
  assert.equal(ctx.practiceState.currentPly, 0);
  assert.equal(ctx.practiceHintLevel, 1);
  assert.match(ctx.practiceHintMessage.textContent, /請考慮「兵」/);

  const replacement = fixture();
  replacement.initialBoard[9][8] = null;
  let serialized = null;
  ctx.puzzleStore = createPuzzleStore({ storage: {
    getItem: () => serialized,
    setItem: (_, value) => { serialized = value; },
  } });
  const saved = ctx.puzzleStore.savePuzzle({ title: 'replacement', ...replacement });
  ctx.busy = false;
  ctx.startSavedPractice(saved.id);
  assert.equal(ctx.practiceHintLevel, 0);
  assert.equal(ctx.practiceHint, null);
  assert.equal(ctx.practiceHintMessage.textContent, '');
});

test('all four saved-practice hint requests cause zero localStorage writes', () => {
  const ctx = harness();
  const memory = new Map();
  let writes = 0;
  ctx.puzzleStore = createPuzzleStore({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem(key, value) { writes++; memory.set(key, value); },
    },
    now: () => '2026-08-30T06:00:00.000Z',
  });
  const saved = ctx.puzzleStore.savePuzzle({ title: 'hint storage', ...fixture() });
  ctx.markPracticeStarted = (id) => !!ctx.puzzleStore.markPracticeStarted(id);
  ctx.startSavedPractice(saved.id);
  assert.equal(ctx.practiceHintLevel, 0);
  assert.equal(ctx.practiceHintMessage.textContent, '');
  const writesAfterStart = writes;
  const storageAfterStart = memory.get('chinese-chess-training:puzzles:v1');
  for (let level = 1; level <= practice.PRACTICE_HINT_MAX_LEVEL; level++) ctx.requestPracticeHint();
  assert.equal(writes, writesAfterStart);
  assert.equal(memory.get('chinese-chess-training:puzzles:v1'), storageAfterStart);
  assert.equal('hint' in ctx.puzzleStore.getPuzzle(saved.id), false);
  const exported = JSON.parse(transfer.serializePuzzleExport([ctx.puzzleStore.getPuzzle(saved.id)])).puzzles[0];
  for (const key of ['hint', 'hintLevel', 'practiceHint', 'practiceHintLevel']) assert.equal(key in exported, false);
});

function savedAnalyticsHarness() {
  const ctx = harness();
  const memory = new Map();
  const writes = new Map();
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem(key, value) { writes.set(key, (writes.get(key) || 0) + 1); memory.set(key, value); },
  };
  let tick = 0;
  let puzzleId = 0;
  ctx.puzzleStore = createPuzzleStore({
    storage,
    now: () => new Date(Date.UTC(2026, 7, 30, 14, 0, tick++)).toISOString(),
    idFactory: () => `saved-analytics-${++puzzleId}`,
  });
  const analyticsStore = analytics.createPracticeAnalyticsStore({
    storage,
    now: () => new Date(Date.UTC(2026, 7, 30, 15, 0, tick++)).toISOString(),
  });
  ctx.practiceAnalyticsStore = Object.freeze({
    ...analyticsStore,
    recordAttempt: (attempt) => analyticsStore.recordAttempt({ ...attempt }),
  });
  ctx.markPracticeStarted = (id) => !!ctx.puzzleStore.markPracticeStarted(id);
  ctx.markPracticeCompleted = (id) => { if (id) ctx.puzzleStore.markPracticeCompleted(id); };
  const saved = ctx.puzzleStore.savePuzzle({ title: 'analytics', ...fixture() });
  return { ctx, saved, memory, writes };
}

function installAnalyticsStorage(ctx, storage) {
  let tick = 0;
  const store = analytics.createPracticeAnalyticsStore({
    storage,
    now: () => new Date(Date.UTC(2026, 7, 30, 16, 0, tick++)).toISOString(),
  });
  ctx.practiceAnalyticsStore = Object.freeze({
    ...store,
    recordAttempt: (attempt) => store.recordAttempt({ ...attempt }),
  });
  return store;
}

function assertPuzzleContentPreserved(before, after) {
  for (const key of ['id', 'title', 'initialBoard', 'sideToMove', 'solution', 'tags', 'notes', 'createdAt']) {
    same(after[key], before[key]);
  }
}

function finishPractice(ctx, puzzle) {
  ctx.doPracticeMove(puzzle.solution[0].from, puzzle.solution[0].to);
  ctx.flushAnimations(); ctx.flushTimers(); ctx.flushAnimations();
  ctx.doPracticeMove(puzzle.solution[2].from, puzzle.solution[2].to);
  ctx.flushAnimations();
}

test('saved completion finalizes one compact attempt with canonical mistakes and cross-ply hints', () => {
  const { ctx, saved, writes } = savedAnalyticsHarness();
  const analyticsKey = analytics.PRACTICE_ANALYTICS_KEY;
  ctx.startSavedPractice(saved.id);
  assert.equal(ctx.puzzleStore.getPuzzle(saved.id).practiceCount, 1, 'existing start counter unchanged');
  assert.equal(writes.get(analyticsKey) || 0, 0, 'start does not persist analytics');
  same(ctx.practiceAttempt, {
    puzzleId: saved.id, startedAt: '2026-08-30T15:00:02.000Z', hintRequests: 0, maxHintLevel: 0,
  });

  ctx.requestPracticeHint();
  ctx.requestPracticeHint();
  assert.equal(ctx.practiceAttempt.hintRequests, 2);
  assert.equal(ctx.practiceAttempt.maxHintLevel, 2);
  assert.equal(writes.get(analyticsKey) || 0, 0, 'hint reveal does not persist immediately');
  ctx.doPracticeMove({ r: 8, c: 0 }, { r: 7, c: 0 });
  assert.equal(ctx.practiceState.mistakes, 1);
  ctx.doPracticeMove(saved.solution[0].from, saved.solution[0].to);
  ctx.flushAnimations(); ctx.flushTimers(); ctx.flushAnimations();
  ctx.requestPracticeHint();
  assert.equal(ctx.practiceAttempt.hintRequests, 3);
  assert.equal(ctx.practiceAttempt.maxHintLevel, 2, 'maximum survives per-ply UI reset');
  ctx.doPracticeMove(saved.solution[2].from, saved.solution[2].to);
  ctx.flushAnimations();

  assert.equal(ctx.appState, 'PUZZLE_PRACTICE_COMPLETE');
  assert.equal(ctx.practiceAttempt, null);
  assert.equal(writes.get(analyticsKey), 1, 'completion is one analytics write');
  const entry = ctx.practiceAnalyticsStore.getPuzzleAnalytics(saved.id);
  assert.equal(entry.aggregate.attemptCount, 1);
  assert.equal(entry.aggregate.completedCount, 1);
  assert.equal(entry.aggregate.abandonedCount, 0);
  assert.equal(entry.aggregate.totalMistakes, 1);
  assert.equal(entry.aggregate.totalHintRequests, 3);
  same(entry.recentAttempts[0], {
    startedAt: '2026-08-30T15:00:02.000Z', endedAt: '2026-08-30T15:00:04.000Z',
    outcome: 'completed', mistakes: 1, hintRequests: 3, maxHintLevel: 2,
  });
  const writesAfterComplete = writes.get(analyticsKey);
  ctx.exitPractice();
  assert.equal(writes.get(analyticsKey), writesAfterComplete, 'exit after completion cannot double-finalize');
});

test('restart and exit finalize separate abandoned attempts while stale reply stays inert', () => {
  const { ctx, saved, writes } = savedAnalyticsHarness();
  const analyticsKey = analytics.PRACTICE_ANALYTICS_KEY;
  ctx.startSavedPractice(saved.id);
  ctx.requestPracticeHint(); ctx.requestPracticeHint();
  ctx.doPracticeMove({ r: 8, c: 0 }, { r: 7, c: 0 });
  ctx.doPracticeMove(saved.solution[0].from, saved.solution[0].to);
  ctx.flushAnimations();
  assert.equal(ctx.timers.length, 1);
  ctx.restartCurrentPractice();
  assert.equal(writes.get(analyticsKey), 1);
  assert.equal(ctx.practiceState.currentPly, 0);
  assert.equal(ctx.practiceAttempt.hintRequests, 0);
  assert.equal(ctx.practiceAttempt.maxHintLevel, 0);
  assert.equal(ctx.puzzleStore.getPuzzle(saved.id).practiceCount, 2);
  ctx.flushTimers(); ctx.flushAnimations();
  assert.equal(writes.get(analyticsKey), 1, 'stale reply did not finalize or mutate new run');
  assert.equal(ctx.practiceState.currentPly, 0);
  ctx.requestPracticeHint();
  ctx.exitPractice();
  assert.equal(writes.get(analyticsKey), 2);
  const entry = ctx.practiceAnalyticsStore.getPuzzleAnalytics(saved.id);
  assert.equal(entry.aggregate.attemptCount, 2);
  assert.equal(entry.aggregate.completedCount, 0);
  assert.equal(entry.aggregate.abandonedCount, 2);
  assert.equal(entry.recentAttempts[0].hintRequests, 1);
  assert.equal(entry.recentAttempts[0].maxHintLevel, 1);
  assert.equal(entry.recentAttempts[1].mistakes, 1);
  assert.equal(entry.recentAttempts[1].hintRequests, 2);
  assert.equal(entry.recentAttempts[1].maxHintLevel, 2);
});

test('two saved puzzles keep lifecycle analytics and stale callbacks isolated by puzzle identity', () => {
  const { ctx, saved: puzzleA, writes } = savedAnalyticsHarness();
  const puzzleB = ctx.puzzleStore.savePuzzle({ title: 'analytics B', tags: ['second'], notes: 'unrelated', ...fixture() });
  const analyticsKey = analytics.PRACTICE_ANALYTICS_KEY;

  ctx.startSavedPractice(puzzleA.id);
  ctx.requestPracticeHint(); ctx.requestPracticeHint();
  ctx.doPracticeMove({ r: 8, c: 0 }, { r: 7, c: 0 });
  ctx.doPracticeMove(puzzleA.solution[0].from, puzzleA.solution[0].to);
  ctx.flushAnimations();
  assert.equal(ctx.timers.length, 1, 'puzzle A has one queued opponent callback');
  ctx.exitPractice();
  const puzzleAAfterExit = ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleA.id);
  assert.equal(puzzleAAfterExit.puzzleId, puzzleA.id);
  same(puzzleAAfterExit.aggregate, {
    attemptCount: 1, completedCount: 0, abandonedCount: 1, cleanCompletionCount: 0,
    hintedCompletionCount: 0, totalMistakes: 1, totalHintRequests: 2,
    lastAttemptAt: puzzleAAfterExit.recentAttempts[0].endedAt, lastCompletedAt: null,
  });
  assert.equal(puzzleAAfterExit.recentAttempts[0].outcome, 'abandoned');
  assert.equal(ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleB.id), null, 'puzzle A exit cannot create puzzle B analytics');

  ctx.startSavedPractice(puzzleB.id);
  assert.equal(ctx.practiceAttempt.puzzleId, puzzleB.id);
  ctx.requestPracticeHint();
  ctx.restartCurrentPractice();
  const puzzleBAfterRestart = ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleB.id);
  assert.equal(puzzleBAfterRestart.puzzleId, puzzleB.id);
  assert.equal(puzzleBAfterRestart.aggregate.attemptCount, 1);
  assert.equal(puzzleBAfterRestart.aggregate.abandonedCount, 1);
  assert.equal(puzzleBAfterRestart.aggregate.totalHintRequests, 1);
  same(ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleA.id), puzzleAAfterExit);

  const writesBeforeStaleCallback = writes.get(analyticsKey);
  ctx.flushTimers(); ctx.flushAnimations();
  assert.equal(writes.get(analyticsKey), writesBeforeStaleCallback, 'stale puzzle A callback cannot write puzzle B analytics');
  assert.equal(ctx.practiceAttempt.puzzleId, puzzleB.id);
  assert.equal(ctx.practiceState.currentPly, 0);
  same(ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleA.id), puzzleAAfterExit);
  same(ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleB.id), puzzleBAfterRestart);

  finishPractice(ctx, puzzleB);
  assert.equal(ctx.appState, 'PUZZLE_PRACTICE_COMPLETE');
  const puzzleBAfterCompletion = ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleB.id);
  same(puzzleBAfterCompletion.aggregate, {
    attemptCount: 2, completedCount: 1, abandonedCount: 1, cleanCompletionCount: 1,
    hintedCompletionCount: 0, totalMistakes: 0, totalHintRequests: 1,
    lastAttemptAt: puzzleBAfterCompletion.recentAttempts[0].endedAt,
    lastCompletedAt: puzzleBAfterCompletion.recentAttempts[0].endedAt,
  });
  same(ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleA.id), puzzleAAfterExit);
  const writesAfterCompletion = writes.get(analyticsKey);
  ctx.exitPractice();
  assert.equal(writes.get(analyticsKey), writesAfterCompletion, 'exit after puzzle B completion cannot mutate either puzzle');
  same(ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleA.id), puzzleAAfterExit);
  same(ctx.practiceAnalyticsStore.getPuzzleAnalytics(puzzleB.id), puzzleBAfterCompletion);

  ctx.recordedPuzzleResult = fixture();
  ctx.savedCurrentPuzzleId = null;
  ctx.appState = 'PUZZLE_RECORDED';
  ctx.startPractice();
  ctx.requestPracticeHint();
  ctx.exitPractice();
  assert.equal(writes.get(analyticsKey), writesAfterCompletion, 'unsaved practice creates no analytics write');
  same(ctx.practiceAnalyticsStore.loadAll().puzzles.map((entry) => entry.puzzleId).sort(), [puzzleA.id, puzzleB.id].sort());
});

test('unsaved practice creates no tracker and causes no analytics write', () => {
  const ctx = harness();
  ctx.recordedPuzzleResult = fixture();
  ctx.appState = 'PUZZLE_RECORDED';
  ctx.startPractice();
  assert.equal(ctx.practiceAttempt, null);
  ctx.requestPracticeHint();
  ctx.doPracticeMove({ r: 8, c: 0 }, { r: 7, c: 0 });
  ctx.exitPractice();
  assert.equal(ctx.analyticsStorage.writes, 0);
});

test('disabled and failed hint requests do not increment attempt analytics', () => {
  const ctx = harness();
  beginHintPractice(ctx);
  ctx.beginPracticeAttempt('saved');
  for (let level = 1; level <= practice.PRACTICE_HINT_MAX_LEVEL; level++) ctx.requestPracticeHint();
  const beforeDisabled = structuredClone(ctx.practiceAttempt);
  ctx.requestPracticeHint();
  same(ctx.practiceAttempt, beforeDisabled);
  ctx.practiceHintLevel = 0;
  ctx.practiceHint = null;
  ctx.practiceState = practice.exportPracticeSnapshot(ctx.practiceState);
  ctx.practiceState.currentBoard[3][0] = null;
  const beforeFailed = structuredClone(ctx.practiceAttempt);
  ctx.requestPracticeHint();
  same(ctx.practiceAttempt, beforeFailed);
  assert.equal(ctx.analyticsStorage.writes, 0);
});

test('analytics read failure leaves core completion and saved-puzzle metadata intact without writing', () => {
  const { ctx, saved, writes } = savedAnalyticsHarness();
  const unrelated = ctx.puzzleStore.savePuzzle({ title: 'read failure control', tags: ['keep'], notes: 'untouched', ...fixture() });
  const savedBefore = ctx.puzzleStore.getPuzzle(saved.id);
  const unrelatedBefore = ctx.puzzleStore.getPuzzle(unrelated.id);
  let analyticsReads = 0;
  let analyticsWrites = 0;
  const failedStore = installAnalyticsStorage(ctx, {
    getItem() { analyticsReads++; throw new Error('read denied'); },
    setItem() { analyticsWrites++; },
  });

  ctx.startSavedPractice(saved.id);
  ctx.requestPracticeHint();
  finishPractice(ctx, saved);
  assert.equal(ctx.appState, 'PUZZLE_PRACTICE_COMPLETE');
  assert.equal(ctx.practiceAttempt, null);
  assert.ok(analyticsReads >= 1);
  assert.equal(analyticsWrites, 0, 'failed analytics read cannot trigger a write');
  assert.throws(() => failedStore.getPuzzleAnalytics(saved.id),
    (error) => error instanceof analytics.PracticeAnalyticsError && error.code === 'STORE_READ_FAILED');
  const savedAfter = ctx.puzzleStore.getPuzzle(saved.id);
  assertPuzzleContentPreserved(savedBefore, savedAfter);
  assert.equal(savedAfter.practiceCount, 1);
  assert.equal(savedAfter.completedCount, 1);
  same(ctx.puzzleStore.getPuzzle(unrelated.id), unrelatedBefore);
  assert.equal(writes.get(analytics.PRACTICE_ANALYTICS_KEY) || 0, 0);
});

test('corrupt analytics fail closed without rewrite while restart and exit preserve puzzle metadata', () => {
  const { ctx, saved, memory, writes } = savedAnalyticsHarness();
  const unrelated = ctx.puzzleStore.savePuzzle({ title: 'corrupt control', tags: ['keep'], notes: 'untouched', ...fixture() });
  const savedBefore = ctx.puzzleStore.getPuzzle(saved.id);
  const unrelatedBefore = ctx.puzzleStore.getPuzzle(unrelated.id);
  const analyticsKey = analytics.PRACTICE_ANALYTICS_KEY;
  memory.set(analyticsKey, '{');

  assert.throws(() => ctx.practiceAnalyticsStore.getPuzzleAnalytics(saved.id),
    (error) => error instanceof analytics.PracticeAnalyticsError && error.code === 'INVALID_JSON');
  assert.equal(memory.get(analyticsKey), '{');
  assert.equal(writes.get(analyticsKey) || 0, 0);
  ctx.startSavedPractice(saved.id);
  ctx.requestPracticeHint();
  ctx.restartCurrentPractice();
  assert.equal(ctx.appState, 'PUZZLE_PRACTICING');
  assert.equal(ctx.practiceState.currentPly, 0);
  ctx.exitPractice();
  assert.equal(ctx.practiceState, null);
  assert.equal(memory.get(analyticsKey), '{', 'corrupt analytics are not destructively rewritten');
  assert.equal(writes.get(analyticsKey) || 0, 0, 'corrupt-store write count');
  const savedAfter = ctx.puzzleStore.getPuzzle(saved.id);
  assertPuzzleContentPreserved(savedBefore, savedAfter);
  assert.equal(savedAfter.practiceCount, 2);
  assert.equal(savedAfter.completedCount, 0);
  same(ctx.puzzleStore.getPuzzle(unrelated.id), unrelatedBefore);
});

test('analytics quota failure does not retry or damage completed and unrelated saved puzzles', () => {
  const { ctx, saved, writes } = savedAnalyticsHarness();
  const unrelated = ctx.puzzleStore.savePuzzle({ title: 'quota control', tags: ['keep'], notes: 'untouched', ...fixture() });
  const savedBefore = ctx.puzzleStore.getPuzzle(saved.id);
  const unrelatedBefore = ctx.puzzleStore.getPuzzle(unrelated.id);
  let analyticsWriteAttempts = 0;
  installAnalyticsStorage(ctx, {
    getItem: () => null,
    setItem() { analyticsWriteAttempts++; throw new Error('quota exceeded'); },
  });

  ctx.startSavedPractice(saved.id);
  ctx.requestPracticeHint();
  finishPractice(ctx, saved);
  assert.equal(ctx.appState, 'PUZZLE_PRACTICE_COMPLETE');
  assert.equal(ctx.practiceAttempt, null);
  assert.equal(analyticsWriteAttempts, 1, 'completion makes one analytics commit attempt');
  const savedAfter = ctx.puzzleStore.getPuzzle(saved.id);
  assertPuzzleContentPreserved(savedBefore, savedAfter);
  assert.equal(savedAfter.practiceCount, 1);
  assert.equal(savedAfter.completedCount, 1);
  same(ctx.puzzleStore.getPuzzle(unrelated.id), unrelatedBefore);
  ctx.exitPractice();
  assert.equal(analyticsWriteAttempts, 1, 'exit after completion cannot retry failed analytics');
  assert.equal(writes.get(analytics.PRACTICE_ANALYTICS_KEY) || 0, 0);
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

function seedPhotoSession(ctx) {
  ctx.photoObjectUrl = 'blob:current';
  ctx.photoPreviewImage.src = ctx.photoObjectUrl;
  ctx.photoReferenceState = photo.createPhotoReferenceState({ name: 'old.png', type: 'image/png', size: 100 });
  ctx.calibrationState = {}; ctx.confirmedCalibration = {};
  ctx.calibrationMode = 'recognition';
  ctx.rectifiedPhotoPixels = { data: new Uint8ClampedArray([10, 20, 30, 255]) };
  ctx.recognitionSession = { typeLibrary: { templates: ['old'] }, typePatches: { old: [10, 20, 30] } };
  ctx.selectedRecognitionKey = '0,0';
  ctx.recognitionUnresolvedOnly = true;
  for (const name of photoCanvasNames) ctx[name].pixels.fill(255);
}

function assertPhotoPixelsCleared(ctx, names = photoCanvasNames) {
  for (const name of names) {
    assert.ok(ctx[name].resets > 0, `${name} buffer explicitly reset`);
    assert.ok(ctx[name].pixels.every((value) => value === 0), `${name} has no old pixels`);
    assert.ok(ctx[name].width > 0 && ctx[name].height > 0, `${name} remains drawable`);
  }
  assert.equal(ctx.recognitionTargetCanvas.width, 112);
  assert.equal(ctx.recognitionTargetCanvas.height, 112);
  for (const key of ['rectifiedPhotoPixels', 'recognitionSession', 'selectedRecognitionKey']) assert.equal(ctx[key], null);
  assert.equal(ctx.recognitionUnresolvedOnly, false);
}

function clickSourceHandler(ctx, id) {
  const match = source.match(new RegExp(`document\\.getElementById\\('${id}'\\)\\.addEventListener\\('click', \\(\\) => \\{([^]*?)^}\\);`, 'm'));
  assert.ok(match, `${id} real click handler exists`);
  vm.runInContext(`(() => {${match[1]}\n})()`, ctx);
}

test('photo canvas inventory covers every persistent photo-bearing HTML canvas', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/<canvas id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids.filter((id) => id !== 'confettiCv').sort(), [...photoCanvasNames].sort());
});

for (const action of ['remove', 'exitEditor', 'enterEditor', 'enterLibrary', 'btnEditorClear', 'btnEditorStandard']) {
  test(`${action} clears photo canvases, URLs and state without retaining stale renders`, () => {
    const ctx = harness();
    ctx.appState = action === 'enterEditor' ? 'NORMAL_GAME' : action === 'enterLibrary' ? 'PUZZLE_RECORDED' : 'PUZZLE_EDITOR';
    ctx.editorState = editor.createEditorState({ board: fixture().initialBoard, sideToMove: 'black' });
    const editorBefore = ctx.editorState;
    seedPhotoSession(ctx);
    ctx.pendingPhotoObjectUrl = 'blob:pending';
    const token = ctx.photoLoadToken;
    if (action === 'remove') clickSourceHandler(ctx, 'btnPhotoRemove');
    else if (action.startsWith('btn')) clickSourceHandler(ctx, action);
    else ctx[action]();
    assertPhotoPixelsCleared(ctx);
    assert.deepEqual(ctx.revoked, ['blob:current', 'blob:pending']);
    assert.ok(ctx.photoLoadToken > token);
    for (const key of ['photoObjectUrl', 'pendingPhotoObjectUrl', 'calibrationState', 'confirmedCalibration']) assert.equal(ctx[key], null);
    assert.equal(ctx.photoReferenceState.photo, null);
    assert.equal(ctx.photoPreviewImage.src, undefined);
    // Previously queued UI draws must remain inert after full invalidation.
    for (const name of ['renderCalibrationAdjustment', 'renderRectifiedPreview', 'syncRecognitionUI']) {
      vm.runInContext(`(${functionSource(name)})()`, ctx);
    }
    assertPhotoPixelsCleared(ctx);
    if (action === 'remove') assert.equal(ctx.editorState, editorBefore, 'photo removal does not change the board');
    if (action.startsWith('btn')) {
      same(ctx.editorState.board, action === 'btnEditorClear' ? editor.createEmptyEditorBoard() : game.initialBoard());
      assert.equal(ctx.editorState.sideToMove, 'black');
      invariant(ctx, ctx.editorState.board);
    }
  });
}

test('successful photo replacement clears all old pixels and preserves the editor board', async () => {
  const ctx = harness();
  seedPhotoSession(ctx);
  ctx.editorState = editor.createEditorState({ board: fixture().initialBoard });
  const boardBefore = ctx.editorState;
  await ctx.loadSelectedPhoto({ name: 'new.png', type: 'image/png', size: 100 });
  assertPhotoPixelsCleared(ctx);
  assert.ok(ctx.revoked.includes('blob:current'));
  assert.equal(ctx.photoObjectUrl, 'blob:new-0');
  assert.equal(ctx.photoPreviewImage.src, 'blob:new-0');
  assert.equal(ctx.photoReferenceState.photo.name, 'new.png');
  assert.equal(ctx.editorState, boardBefore);
  assert.equal(ctx.pendingPhotoObjectUrl, null);
});

test('derived invalidation clears old rectification/review pixels but retains the current photo', () => {
  const ctx = harness();
  seedPhotoSession(ctx);
  ctx.invalidateRecognitionForCalibrationChange();
  assertPhotoPixelsCleared(ctx, photoCanvasNames.slice(1));
  assert.equal(ctx.calibrationCornerCanvas.resets, 0, 'current source adjustment canvas retained');
  assert.equal(ctx.photoObjectUrl, 'blob:current');
  assert.deepEqual(ctx.revoked, []);
});

test('failed replacement and picker cancellation preserve the current photo and pixels', async () => {
  const ctx = harness();
  seedPhotoSession(ctx);
  const session = ctx.recognitionSession;
  ctx.decodePhotoObjectUrl = async () => { throw new Error('decode failed'); };
  await ctx.loadSelectedPhoto({ name: 'bad.png', type: 'image/png', size: 100 });
  await ctx.loadSelectedPhoto({ name: 'bad.svg', type: 'image/svg+xml', size: 100 });
  await ctx.loadSelectedPhoto(null);
  assert.deepEqual(ctx.revoked, ['blob:new-0']);
  assert.equal(ctx.photoObjectUrl, 'blob:current');
  assert.equal(ctx.recognitionSession, session);
  for (const name of photoCanvasNames) {
    assert.equal(ctx[name].resets, 0);
    assert.ok(ctx[name].pixels.every((value) => value === 255));
  }
});

test('late decode after exit cannot restore cleared pixels or photo state', async () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_EDITOR';
  seedPhotoSession(ctx);
  let finish;
  ctx.decodePhotoObjectUrl = () => new Promise((resolve) => { finish = resolve; });
  const pending = ctx.loadSelectedPhoto({ name: 'late.png', type: 'image/png', size: 100 });
  ctx.exitEditor();
  finish({ naturalWidth: 4, naturalHeight: 3 });
  await pending;
  assertPhotoPixelsCleared(ctx);
  assert.equal(ctx.photoObjectUrl, null);
  assert.equal(ctx.photoPreviewImage.src, undefined);
  assert.equal(ctx.photoReferenceState.photo, null);
  assert.ok(ctx.revoked.includes('blob:new-0'));
});

test('superseded decode cannot replace or clear the newer photo session', async () => {
  const ctx = harness();
  seedPhotoSession(ctx);
  let finishOld;
  ctx.decodePhotoObjectUrl = (url) => url === 'blob:new-0'
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ naturalWidth: 4, naturalHeight: 3 });
  const old = ctx.loadSelectedPhoto({ name: 'slow.png', type: 'image/png', size: 100 });
  await ctx.loadSelectedPhoto({ name: 'newest.png', type: 'image/png', size: 100 });
  assertPhotoPixelsCleared(ctx);
  for (const name of photoCanvasNames) ctx[name].pixels.fill(42);
  finishOld({ naturalWidth: 4, naturalHeight: 3 });
  await old;
  assert.equal(ctx.photoObjectUrl, 'blob:new-1');
  assert.equal(ctx.photoReferenceState.photo.name, 'newest.png');
  for (const name of photoCanvasNames) assert.ok(ctx[name].pixels.every((value) => value === 42));
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
  const match = source.match(/const browserStorage = \{[^]*?const puzzleStore = createPuzzleStore\([^]*?\);/);
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

function portableFixture(id = 'ui-transfer', title = 'UI 匯入題') {
  return { id, title, ...fixture(), tags: ['UI'], notes: '<img onerror=alert(1)> 純文字' };
}

function transferText(puzzles) {
  return transfer.serializePuzzleExport(puzzles, { now: () => '2026-08-30T04:00:00.000Z' });
}

test('real preview selector reports valid, importable and collision counts without mutation', () => {
  const ctx = harness();
  const incoming = [portableFixture('existing'), portableFixture('new')];
  const preview = ctx.preparePuzzleImportPreview(incoming, [{ id: 'existing' }]);
  same(preview, {
    totalValidCount: 2, importableCount: 1, skippedCollisionCount: 1, skippedIds: ['existing'],
  });
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.skippedIds), true);
});

test('file preview is non-mutating, repeatable for the same file and renders imported text safely', async () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_LIBRARY';
  let writes = 0;
  const memory = new Map();
  ctx.puzzleStore = createPuzzleStore({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem(key, value) { writes++; memory.set(key, value); },
    },
  });
  const text = transferText([portableFixture()]);
  const file = { size: new TextEncoder().encode(text).byteLength, text: async () => text };
  ctx.puzzleImportFile.value = 'chosen.json';
  await ctx.loadPuzzleImportFile(file);
  assert.equal(ctx.pendingPuzzleImport.preview.totalValidCount, 1);
  assert.equal(ctx.pendingPuzzleImport.preview.importableCount, 1);
  assert.equal(ctx.puzzleImportFile.value, '');
  assert.equal(writes, 0);
  assert.equal(ctx.libraryImportPreviewText.textContent.includes('可匯入 1 題'), true);
  assert.equal(ctx.libraryImportPreviewText.innerHTML, '');
  await ctx.loadPuzzleImportFile(file);
  assert.equal(ctx.pendingPuzzleImport.puzzles[0].notes, '<img onerror=alert(1)> 純文字');
  assert.equal(writes, 0, 're-selecting the same file only refreshes preview');
});

test('noncanonical imported ID is rejected before preview or storage mutation', async () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_LIBRARY';
  let writes = 0;
  const memory = new Map();
  ctx.puzzleStore = createPuzzleStore({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem(key, value) { writes++; memory.set(key, value); },
    },
  });
  const transferEnvelope = JSON.parse(transferText([portableFixture('abc')]));
  transferEnvelope.puzzles[0].id = ' abc ';
  const text = JSON.stringify(transferEnvelope);
  await ctx.loadPuzzleImportFile({
    size: new TextEncoder().encode(text).byteLength,
    text: async () => text,
  });
  assert.equal(ctx.pendingPuzzleImport, null);
  assert.equal(ctx.libraryTransferStatus.textContent, '檔案內含無效的殺局題目。');
  assert.equal(writes, 0);
});

test('cancel leaves exact storage unchanged and clears pending import', async () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_LIBRARY';
  const memory = new Map();
  let writes = 0;
  ctx.puzzleStore = createPuzzleStore({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem(key, value) { writes++; memory.set(key, value); },
    },
    now: () => '2026-08-30T03:00:00.000Z',
  });
  ctx.puzzleStore.importPuzzles([portableFixture('existing')]);
  const before = memory.get('chinese-chess-training:puzzles:v1');
  writes = 0;
  const text = transferText([portableFixture()]);
  await ctx.loadPuzzleImportFile({ size: text.length, text: async () => text });
  ctx.cancelPuzzleImport();
  assert.equal(ctx.pendingPuzzleImport, null);
  assert.equal(writes, 0);
  assert.equal(memory.get('chinese-chess-training:puzzles:v1'), before);
  assert.equal(ctx.libraryTransferStatus.textContent.includes('未變更'), true);
});

test('confirm calls the real atomic store path once and refreshes status', async () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_LIBRARY';
  const memory = new Map();
  let writes = 0;
  ctx.puzzleStore = createPuzzleStore({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem(key, value) { writes++; memory.set(key, value); },
    },
    now: () => '2026-08-30T05:00:00.000Z',
  });
  const text = transferText([portableFixture()]);
  await ctx.loadPuzzleImportFile({ size: text.length, text: async () => text });
  ctx.confirmPuzzleImport();
  assert.equal(writes, 1);
  assert.equal(ctx.pendingPuzzleImport, null);
  assert.equal(ctx.puzzleStore.getPuzzle('ui-transfer').practiceCount, 0);
  assert.equal(ctx.libraryTransferStatus.textContent, '匯入完成：新增 1 題，略過既有 ID 0 題。');
});

test('exact-ID collision preview and store result agree without a write', async () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_LIBRARY';
  const memory = new Map();
  let writes = 0;
  ctx.puzzleStore = createPuzzleStore({
    storage: {
      getItem: (key) => memory.get(key) ?? null,
      setItem(key, value) { writes++; memory.set(key, value); },
    },
    now: () => '2026-08-30T05:00:00.000Z',
  });
  ctx.puzzleStore.importPuzzles([portableFixture()]);
  writes = 0;
  const text = transferText([portableFixture()]);
  await ctx.loadPuzzleImportFile({ size: text.length, text: async () => text });
  assert.equal(ctx.pendingPuzzleImport.preview.totalValidCount, 1);
  assert.equal(ctx.pendingPuzzleImport.preview.importableCount, 0);
  assert.equal(ctx.pendingPuzzleImport.preview.skippedCollisionCount, 1);
  assert.equal(ctx.btnLibraryImportConfirm.disabled, true);
  const result = ctx.puzzleStore.importPuzzles(ctx.pendingPuzzleImport.puzzles);
  assert.deepEqual(result, {
    importedCount: 0, skippedCount: 1, importedIds: [], skippedIds: ['ui-transfer'],
  });
  ctx.confirmPuzzleImport();
  assert.equal(writes, 0);
});

test('download creates and revokes one local object URL', () => {
  const ctx = harness();
  let clicked = 0;
  let appended = 0;
  ctx.document = {
    ...ctx.document,
    body: { appendChild() { appended++; } },
    createElement: (tag) => {
      assert.equal(tag, 'a');
      return { href: '', download: '', hidden: false, click() { clicked++; }, remove: noop };
    },
  };
  const text = ctx.downloadPuzzleTransfer([portableFixture()], 'puzzle.json');
  assert.equal(JSON.parse(text).puzzles.length, 1);
  assert.equal(appended, 1);
  assert.equal(clicked, 1);
  assert.deepEqual(ctx.createdUrls, ['blob:new-0']);
  assert.deepEqual(ctx.revoked, []);
  ctx.flushTimers();
  assert.deepEqual(ctx.revoked, ['blob:new-0']);
});

test('late file read after leaving the library cannot restore pending import state', async () => {
  const ctx = harness();
  ctx.appState = 'PUZZLE_LIBRARY';
  ctx.puzzleStore = createPuzzleStore({ storage: { getItem: () => null, setItem: noop } });
  let finish;
  const pending = ctx.loadPuzzleImportFile({
    size: 1,
    text: () => new Promise((resolve) => { finish = resolve; }),
  });
  ctx.exitEditor();
  finish(transferText([portableFixture()]));
  await pending;
  assert.equal(ctx.pendingPuzzleImport, null);
  assert.equal(ctx.appState, 'NORMAL_GAME');
});
