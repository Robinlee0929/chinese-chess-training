import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { RED, BLACK, initialBoard } from './game.js';
import { createGameRecord, replayGameRecord } from './game-record.js';
import { createGameRecordStore } from './game-record-store.js';
import {
  createGameReview,
  firstGameReviewPly,
  previousGameReviewPly,
  nextGameReviewPly,
  lastGameReviewPly,
  selectGameReviewPly,
  createGameRecordLibraryView,
} from './game-review.js';
import {
  createGameReviewAiState,
  invalidateGameReviewAiState,
  beginGameReviewAiRequest,
  settleGameReviewAiResponse,
} from './game-review-ai.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./css/style.css', import.meta.url), 'utf8');

function functionSource(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `main.js function ${name} exists`);
  return match[0];
}

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function record(id = 'record-a', completedMinute = 1) {
  const board = emptyBoard();
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[9][8] = { type: 'R', side: RED };
  return createGameRecord({
    schemaVersion: 1,
    id,
    createdAt: `2026-08-31T01:0${completedMinute - 1}:00.000Z`,
    completedAt: `2026-08-31T01:0${completedMinute}:00.000Z`,
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
  });
}

function repetitionRecord(id = 'record-repetition') {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[4][3] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  const cycle = [
    [{ r: 9, c: 4 }, { r: 9, c: 5 }],
    [{ r: 4, c: 3 }, { r: 5, c: 3 }],
    [{ r: 9, c: 5 }, { r: 9, c: 4 }],
    [{ r: 5, c: 3 }, { r: 4, c: 3 }],
  ];
  return createGameRecord({
    schemaVersion: 1,
    id,
    createdAt: '2026-08-31T02:00:00.000Z',
    completedAt: '2026-08-31T02:08:00.000Z',
    initialPosition: { board, sideToMove: BLACK },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    mode: 'hard',
    result: { winner: null, terminationReason: 'threefold-repetition' },
  });
}

function domNode(initiallyHidden = false, tagName = 'div') {
  const classes = new Set(initiallyHidden ? ['hidden'] : []);
  const attributes = new Map();
  const node = {
    tagName: tagName.toUpperCase(),
    children: [],
    dataset: {},
    disabled: false,
    scrollTop: 0,
    textContent: '',
    className: '',
    type: '',
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    querySelector(selector) {
      const matches = (candidate) => selector === '[aria-current="step"]'
        && candidate.getAttribute?.('aria-current') === 'step';
      const visit = (candidate) => {
        if (matches(candidate)) return candidate;
        for (const child of candidate.children || []) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
    },
    focusCalls: 0,
    focus() { this.focusCalls++; },
  };
  return node;
}

function vector() {
  return { set() {} };
}

function harness({
  records = [], serialized, readError, writeError, confirm = true,
  mode = 'pvp', turn = RED, realRenderer = false, rendererMutation = null,
  reviewAiMutation = null, workerCreationError = false,
} = {}) {
  let stored = serialized === undefined
    ? (records.length ? JSON.stringify({ version: 1, records }) : null)
    : serialized;
  let reads = 0;
  let writes = 0;
  const storage = {
    getItem() {
      reads++;
      if (readError) throw readError;
      return stored;
    },
    setItem(_key, value) {
      writes++;
      if (writeError) throw writeError;
      stored = value;
    },
    get reads() { return reads; },
    get writes() { return writes; },
    get serialized() { return stored; },
  };
  const gameRecordStore = createGameRecordStore({ storage });
  const liveBoard = initialBoard();
  const reviewAiWorkers = [];
  class FakeReviewAiWorker {
    constructor() {
      this.messages = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      reviewAiWorkers.push(this);
    }
    postMessage(message) { this.messages.push(structuredClone(message)); }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage?.({ data }); }
    fail() { this.onerror?.({ preventDefault() {} }); }
  }
  const document = {
    activeElement: null,
    createElement: (tagName) => domNode(false, tagName),
  };
  const context = vm.createContext({
    RED, BLACK, structuredClone,
    APP_STATE: Object.freeze({
      NORMAL_GAME: 'NORMAL_GAME',
      GAME_RECORD_LIBRARY: 'GAME_RECORD_LIBRARY',
      GAME_REVIEW: 'GAME_REVIEW',
      GAME_ANALYSIS: 'GAME_ANALYSIS',
    }),
    appState: 'NORMAL_GAME',
    board: liveBoard,
    turn,
    history: [{ from: { r: 0, c: 1 }, to: { r: 2, c: 2 }, captured: null, nota: '傌八進七' }],
    posHistory: ['live-position-a', 'live-position-b'],
    repHistory: [{ key: 'live|red', mover: null, check: false }],
    capturedBy: { red: [{ side: BLACK, type: 'P' }], black: [] },
    over: false,
    winner: null,
    normalGameRecordSession: Object.freeze({
      id: 'live-session',
      createdAt: '2026-08-31T03:00:00.000Z',
      initialPosition: Object.freeze({ board: structuredClone(liveBoard), sideToMove: turn }),
      mode,
    }),
    lastCompletedGameRecord: records[0] || record('memory-only'),
    selected: { r: 0, c: 1 },
    legal: [{ r: 2, c: 0 }, { r: 2, c: 2 }],
    busy: false,
    mode,
    aiToken: 7,
    aiThinking: mode !== 'pvp' && turn === BLACK,
    aiMoveStart: 4321,
    aiWorker: Object.freeze({ kind: 'normal-worker' }),
    aiRequests: 0,
    aiMaybeMoveCalls: 0,
    tweens: [],
    gameReviewSession: null,
    gameReviewReturnState: 'NORMAL_GAME',
    gameReviewInvoker: null,
    gameReviewStored: false,
    gameReviewLivePresentation: null,
    gameAnalysisState: null,
    gameAnalysisSelected: null,
    gameAnalysisLegal: [],
    gameAnalysisNotice: '',
    gameReviewAiState: createGameReviewAiState(),
    gameReviewAiWorker: null,
    reviewAiWorkers,
    renderedBoard: liveBoard,
    renderCount: 0,
    productionRenderCallCount: 0,
    reviewRenderBoards: [],
    liveRenderBoards: [],
    normalDoMoveCalls: 0,
    libraryView: null,
    puzzleWrites: 0,
    analyticsWrites: 0,
    messages: [],
    gameRecordStore,
    storage,
    createGameReview,
    firstGameReviewPly,
    previousGameReviewPly,
    nextGameReviewPly,
    lastGameReviewPly,
    selectGameReviewPly,
    invalidateGameReviewAiState,
    beginGameReviewAiRequest,
    settleGameReviewAiResponse,
    GAME_RECORD_MODE_LABELS: Object.freeze({
      pvp: '雙人對弈', easy: '人機・簡單', medium: '人機・中等', hard: '人機・困難',
    }),
    GAME_RECORD_REASON_LABELS: Object.freeze({
      checkmate: '將死',
      stalemate: '困斃',
      'perpetual-check': '長將判負',
      'threefold-repetition': '三次重複局面',
      'mutual-perpetual-check': '雙方長將',
    }),
    appEl: domNode(),
    gameRecordPanel: domNode(true),
    gameRecordLibraryView: domNode(),
    gameReviewView: domNode(true),
    gameAnalysisView: domNode(true),
    gameRecordLibraryHeading: domNode(),
    gameReviewHeading: domNode(),
    gameReviewMeta: domNode(),
    gameReviewStatus: domNode(),
    gameReviewMoveCount: domNode(),
    gameReviewMoveList: domNode(),
    btnReviewGame: domNode(),
    btnGameRecords: domNode(),
    btnGameReviewFirst: domNode(),
    btnGameReviewPrevious: domNode(),
    btnGameReviewNext: domNode(),
    btnGameReviewLast: domNode(),
    btnGameReviewAnalyze: domNode(),
    btnGameReviewAiAnalyze: domNode(),
    gameReviewAiPanel: domNode(true),
    gameReviewAiHeading: domNode(),
    gameReviewAiDetail: domNode(),
    btnGameReviewCreatePuzzle: domNode(),
    btnGameReviewBack: domNode(),
    btnGameReviewDelete: domNode(true),
    overlay: domNode(true),
    banner: domNode(true),
    lastFromMark: { visible: true, position: vector() },
    lastToMark: { visible: true, position: vector() },
    document,
    window: { confirm: () => confirm },
    normalGameActive: () => context.appState === 'NORMAL_GAME',
    gameRecordFlowActive: () => ['GAME_RECORD_LIBRARY', 'GAME_REVIEW', 'GAME_ANALYSIS'].includes(context.appState),
    clearSelection: () => { context.selected = null; context.legal = []; },
    clearGameAnalysisSelection: () => {
      context.gameAnalysisSelected = null;
      context.gameAnalysisLegal = [];
    },
    stopConfetti() {},
    rebuildPieceMeshes(board) {
      context.clearSelection();
      context.renderedBoard = structuredClone(board);
      if (context.appState === 'GAME_REVIEW') {
        context.productionRenderCallCount++;
        context.reviewRenderBoards.push(structuredClone(board));
      } else {
        context.liveRenderBoards.push(structuredClone(board));
      }
    },
    syncLastMoveMark() {
      context.lastFromMark.visible = context.lastToMark.visible = context.history.length > 0;
    },
    to3D: (r, c) => ({ x: c, z: r }),
    showMoveDots() {},
    ...(!realRenderer ? {
      renderGameReview() {
        context.renderCount++;
        context.renderedBoard = structuredClone(context.gameReviewSession.snapshot.board);
      },
    } : {}),
    renderGameRecordLibrary() {
      context.libraryView = createGameRecordLibraryView(context.gameRecordStore.loadAll());
      return context.libraryView;
    },
    refreshHUD() {},
    checkBoardMeshInvariant: () => ({ ok: true, errors: [] }),
    toast: (message) => context.messages.push(message),
    createGameReviewAiWorker: () => {
      if (workerCreationError) throw new Error('worker unavailable');
      return new FakeReviewAiWorker();
    },
    doMove() { context.normalDoMoveCalls++; },
    maybeAIMove() {
      context.aiMaybeMoveCalls++;
      if (context.appState === 'NORMAL_GAME' && context.mode !== 'pvp'
        && !context.over && context.turn === BLACK && !context.aiThinking) {
        context.aiThinking = true;
        context.aiRequests++;
      }
    },
  });
  const names = [
    'terminateGameReviewAiWorker', 'invalidateGameReviewAi', 'renderGameReviewAi',
    'handleGameReviewAiResponse', 'requestGameReviewAiCandidate',
    'pauseLiveGameForGameRecords', 'restoreLiveGamePresentation',
    'enterGameRecordLibrary', 'showGameRecordLibrary', 'openGameReview',
    'openLastCompletedGameReview', 'openStoredGameReview', 'navigateGameReview',
    'deleteGameRecordFromLibrary', 'exitGameReview', 'exitGameRecordFlow',
  ];
  // In realRenderer mode these are byte-identical production functions from main.js.
  // Only low-level DOM, mesh rebuilding, HUD, audio/confetti, and storage boundaries are doubled.
  const rendererHelpers = realRenderer ? [
    'gameRecordModeLabel', 'gameRecordResultLabel', 'formatGameRecordCompletedAt',
    'appendGameReviewMeta', 'syncGameReviewMoveMark', 'gameReviewAnnouncement',
  ].map(functionSource) : [];
  let rendererSource = realRenderer ? functionSource('renderGameReview') : '';
  const mutations = {
    board: 'board = structuredClone(review.snapshot.board);',
    turn: 'turn = review.snapshot.sideToMove;',
    history: 'history = [];',
    captured: 'capturedBy = { [RED]: [], [BLACK]: [] };',
  };
  if (rendererMutation) {
    assert.ok(mutations[rendererMutation], `known renderer mutation: ${rendererMutation}`);
    rendererSource = rendererSource.replace(
      'const review = gameReviewSession;',
      `const review = gameReviewSession;\n  ${mutations[rendererMutation]}`,
    );
  }
  const mainFunctions = names.map(functionSource);
  if (reviewAiMutation === 'doMove') {
    const index = names.indexOf('handleGameReviewAiResponse');
    mainFunctions[index] = mainFunctions[index].replace(
      'gameReviewAiState = settled.state;',
      'gameReviewAiState = settled.state;\n  doMove({ r: 0, c: 0 }, { r: 0, c: 1 });',
    );
  }
  vm.runInContext([...rendererHelpers, rendererSource, ...mainFunctions].filter(Boolean).join('\n'), context);
  return context;
}

const clone = (value) => structuredClone(value);
function liveSnapshot(ctx) {
  return clone({
    board: ctx.board,
    turn: ctx.turn,
    history: ctx.history,
    posHistory: ctx.posHistory,
    repHistory: ctx.repHistory,
    capturedBy: ctx.capturedBy,
    over: ctx.over,
    winner: ctx.winner,
    normalGameRecordSession: ctx.normalGameRecordSession,
    lastCompletedGameRecord: ctx.lastCompletedGameRecord,
    mode: ctx.mode,
  });
}

function assertLiveStateUnchanged(ctx, before, stage) {
  const after = liveSnapshot(ctx);
  assert.deepEqual(after.board, before.board, `LIVE_BOARD_UNCHANGED after ${stage}`);
  assert.equal(after.turn, before.turn, `LIVE_TURN_UNCHANGED after ${stage}`);
  assert.deepEqual(after.history, before.history, `LIVE_HISTORY_UNCHANGED after ${stage}`);
  assert.deepEqual(after.posHistory, before.posHistory, `LIVE_POS_HISTORY_UNCHANGED after ${stage}`);
  assert.deepEqual(after.repHistory, before.repHistory, `LIVE_REP_HISTORY_UNCHANGED after ${stage}`);
  assert.deepEqual(after.capturedBy, before.capturedBy, `LIVE_CAPTURED_STATE_UNCHANGED after ${stage}`);
  assert.equal(after.over, before.over, `LIVE_RESULT_UNCHANGED after ${stage}: over`);
  assert.equal(after.winner, before.winner, `LIVE_RESULT_UNCHANGED after ${stage}: winner`);
  assert.deepEqual(
    after.normalGameRecordSession,
    before.normalGameRecordSession,
    `LIVE_SESSION_ID_UNCHANGED after ${stage}`,
  );
  assert.deepEqual(
    after.lastCompletedGameRecord,
    before.lastCompletedGameRecord,
    `LAST_COMPLETED_GAME_RECORD_UNCHANGED after ${stage}`,
  );
  assert.equal(after.mode, before.mode, `LIVE_MODE_UNCHANGED after ${stage}`);
}

function reviewAiIsolationSnapshot(ctx) {
  return clone({
    live: liveSnapshot(ctx),
    aiToken: ctx.aiToken,
    aiThinking: ctx.aiThinking,
    aiMoveStart: ctx.aiMoveStart,
    aiRequests: ctx.aiRequests,
    aiMaybeMoveCalls: ctx.aiMaybeMoveCalls,
    normalDoMoveCalls: ctx.normalDoMoveCalls,
    storageWrites: ctx.storage.writes,
    puzzleWrites: ctx.puzzleWrites,
    analyticsWrites: ctx.analyticsWrites,
  });
}

function successfulReviewAiResponse(worker, result = {}) {
  const request = worker.messages[0];
  return {
    kind: 'review-candidate',
    recordId: request.recordId,
    ply: request.ply,
    revision: request.revision,
    result: {
      from: { r: 2, c: 3 },
      to: { r: 2, c: 4 },
      depth: 2,
      score: 99998,
      pv: ['must-not-surface'],
      ...result,
    },
  };
}

test('just-completed in-memory record opens at the final board with zero persistence writes', () => {
  const completed = record('just-completed');
  const ctx = harness({ records: [], realRenderer: true });
  ctx.lastCompletedGameRecord = completed;
  ctx.board = clone(replayGameRecord(completed, completed.moves.length).board);
  ctx.over = true;
  ctx.winner = RED;
  const before = liveSnapshot(ctx);
  assert.equal(ctx.openLastCompletedGameReview(ctx.btnReviewGame), true);
  assert.equal(ctx.appState, 'GAME_REVIEW');
  assert.equal(ctx.gameReviewSession.selectedPly, completed.moves.length);
  assert.equal(ctx.btnGameReviewAnalyze.disabled, true);
  assert.deepEqual(ctx.renderedBoard, before.board);
  assert.equal(ctx.productionRenderCallCount, 1);
  assertLiveStateUnchanged(ctx, before, 'just-completed final render');
  assert.equal(ctx.navigateGameReview('previous'), true);
  assert.equal(ctx.btnGameReviewAnalyze.disabled, false);
  assert.equal(ctx.productionRenderCallCount, 2);
  assert.deepEqual(ctx.renderedBoard, replayGameRecord(completed, 0).board);
  assertLiveStateUnchanged(ctx, before, 'just-completed previous render');
  assert.equal(ctx.navigateGameReview('last'), true);
  assert.equal(ctx.productionRenderCallCount, 3);
  assert.deepEqual(ctx.renderedBoard, before.board);
  assertLiveStateUnchanged(ctx, before, 'just-completed final rerender');
  assert.equal(ctx.storage.writes, 0);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assertLiveStateUnchanged(ctx, before, 'just-completed review exit');
});

test('production renderGameReview keeps a different live game immutable across every navigation route', () => {
  const saved = repetitionRecord('production-renderer-a');
  const ctx = harness({ records: [saved], mode: 'hard', turn: RED, realRenderer: true });
  assert.equal(
    ctx.renderGameReview.toString(),
    functionSource('renderGameReview'),
    'critical regression executes the byte-identical production renderer function',
  );
  const before = liveSnapshot(ctx);
  const selectedBefore = clone(ctx.selected);
  const legalBefore = clone(ctx.legal);
  const tokenBefore = ctx.aiToken;

  const assertReviewRender = (ply, expectedCallCount, stage) => {
    const expected = replayGameRecord(saved, ply);
    assert.equal(ctx.gameReviewSession.selectedPly, ply, `selected ply after ${stage}`);
    assert.equal(ctx.productionRenderCallCount, expectedCallCount, `real render count after ${stage}`);
    assert.deepEqual(ctx.reviewRenderBoards.at(-1), expected.board, `review snapshot rendered after ${stage}`);
    assert.deepEqual(ctx.renderedBoard, expected.board, `visible board after ${stage}`);
    assert.notDeepEqual(ctx.renderedBoard, before.board, `review board differs from live board after ${stage}`);
    assertLiveStateUnchanged(ctx, before, stage);
    const selectedMove = ctx.gameReviewMoveList.querySelector('[aria-current="step"]');
    assert.equal(selectedMove?.dataset.reviewPly ?? null, ply === 0 ? null : String(ply));
    assert.match(ctx.gameReviewStatus.textContent, new RegExp(`第 ${ply} / ${saved.moves.length} 著`));
    assert.equal(ctx.btnGameReviewFirst.disabled, ply === 0);
    assert.equal(ctx.btnGameReviewPrevious.disabled, ply === 0);
    assert.equal(ctx.btnGameReviewNext.disabled, ply === saved.moves.length);
    assert.equal(ctx.btnGameReviewLast.disabled, ply === saved.moves.length);
    assert.equal(ctx.storage.writes, 0);
    assert.equal(ctx.normalDoMoveCalls, 0);
    assert.equal(ctx.aiRequests, 0);
    assert.equal(ctx.aiMaybeMoveCalls, 0);
    assert.equal(ctx.puzzleWrites, 0);
    assert.equal(ctx.analyticsWrites, 0);
  };

  assert.equal(ctx.enterGameRecordLibrary(ctx.btnGameRecords), true);
  assert.equal(ctx.aiToken, tokenBefore + 1, 'entry invalidates pending live AI work');
  assert.equal(ctx.openStoredGameReview(saved.id), true);
  assertReviewRender(8, 1, 'open final');
  assert.equal(ctx.navigateGameReview('previous'), true);
  assertReviewRender(7, 2, 'previous');
  assert.notDeepEqual(ctx.reviewRenderBoards[0], ctx.reviewRenderBoards[1], 'selected ply changes review rendering');
  assert.equal(ctx.navigateGameReview('first'), true);
  assertReviewRender(0, 3, 'first');
  assert.equal(ctx.navigateGameReview('next'), true);
  assertReviewRender(1, 4, 'next');
  assert.equal(ctx.navigateGameReview(5), true);
  assertReviewRender(5, 5, 'direct jump');
  assert.equal(ctx.navigateGameReview('last'), true);
  assertReviewRender(8, 6, 'last');

  ctx.exitGameReview();
  assert.equal(ctx.appState, 'GAME_RECORD_LIBRARY');
  assert.equal(ctx.productionRenderCallCount, 6, 'exit does not rerun the review renderer');
  assert.deepEqual(ctx.renderedBoard, before.board, 'library exit renders the preserved live board');
  assertLiveStateUnchanged(ctx, before, 'return to record library');
  ctx.exitGameRecordFlow();
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assert.deepEqual(ctx.renderedBoard, before.board, 'normal-game exit renders the preserved live board');
  assertLiveStateUnchanged(ctx, before, 'return to normal game');
  assert.deepEqual(clone(ctx.selected), selectedBefore, 'live selection restored');
  assert.deepEqual(clone(ctx.legal), legalBefore, 'live legal moves restored');
  assert.equal(ctx.storage.writes, 0);
  assert.equal(ctx.normalDoMoveCalls, 0);
  assert.equal(ctx.aiRequests, 0);
  assert.equal(ctx.aiMaybeMoveCalls, 1, 'exit invokes only the normal resume check');
});

test('production-renderer negative controls detect forbidden live-state assignments', () => {
  const saved = repetitionRecord('production-renderer-negative');
  const mutations = [
    ['board', 'LIVE_BOARD_UNCHANGED'],
    ['turn', 'LIVE_TURN_UNCHANGED'],
    ['history', 'LIVE_HISTORY_UNCHANGED'],
    ['captured', 'LIVE_CAPTURED_STATE_UNCHANGED'],
  ];
  for (const [rendererMutation, expectedFailure] of mutations) {
    const ctx = harness({ records: [saved], realRenderer: true, rendererMutation });
    const before = liveSnapshot(ctx);
    assert.equal(ctx.enterGameRecordLibrary(), true);
    assert.equal(ctx.openStoredGameReview(saved.id), true);
    let detected = null;
    try {
      assertLiveStateUnchanged(ctx, before, `${rendererMutation} negative control`);
    } catch (error) {
      detected = error;
    }
    assert.equal(detected?.code, 'ERR_ASSERTION', `${rendererMutation} mutation must fail an assertion`);
    assert.match(detected.message, new RegExp(expectedFailure));
    assert.equal(ctx.productionRenderCallCount, 1, 'negative control still executes the real renderer');
    assert.deepEqual(
      ctx.reviewRenderBoards.at(-1),
      replayGameRecord(saved, saved.moves.length).board,
      'negative control failure is not caused by an invalid renderer fixture',
    );
  }
});

test('save failure does not prevent last-completed review', () => {
  const ctx = harness({ writeError: new Error('quota') });
  const completed = record('memory-after-failure');
  ctx.lastCompletedGameRecord = completed;
  assert.equal(ctx.openLastCompletedGameReview(), true);
  assert.equal(ctx.gameReviewSession.record.id, 'memory-after-failure');
  assert.equal(ctx.gameReviewSession.atLast, true);
  assert.equal(ctx.storage.writes, 0);
});

test('historical review navigation and exit preserve a different live game exactly', () => {
  const saved = record('saved-a');
  const ctx = harness({ records: [saved] });
  const before = liveSnapshot(ctx);
  const selectedBefore = clone(ctx.selected);
  const legalBefore = clone(ctx.legal);
  const tokenBefore = ctx.aiToken;
  assert.equal(ctx.enterGameRecordLibrary(ctx.btnReviewGame), true);
  assert.equal(ctx.openStoredGameReview(saved.id), true);
  assert.equal(ctx.navigateGameReview('first'), true);
  assert.equal(ctx.navigateGameReview('next'), true);
  assert.equal(ctx.navigateGameReview('last'), true);
  assert.equal(ctx.storage.writes, 0);
  assert.equal(ctx.puzzleWrites, 0);
  assert.equal(ctx.analyticsWrites, 0);
  assert.deepEqual(liveSnapshot(ctx), before);
  assert.equal(ctx.aiToken, tokenBefore + 1, 'entry invalidates stale live AI only once');
  ctx.exitGameReview();
  assert.equal(ctx.appState, 'GAME_RECORD_LIBRARY');
  assert.deepEqual(ctx.renderedBoard, before.board);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assert.deepEqual(liveSnapshot(ctx), before);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.selected)), selectedBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.legal)), legalBefore);
  assert.equal(ctx.storage.writes, 0);
});

test('review entry and navigation never start AI; exit resumes one legitimate request', () => {
  const saved = record('saved-ai');
  const ctx = harness({ records: [saved], mode: 'hard', turn: BLACK });
  const staleToken = ctx.aiToken;
  assert.equal(ctx.enterGameRecordLibrary(), true);
  assert.equal(ctx.aiToken, staleToken + 1);
  assert.equal(ctx.aiThinking, false);
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  ctx.navigateGameReview('last');
  assert.equal(ctx.aiRequests, 0);
  assert.equal(ctx.aiMaybeMoveCalls, 0);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.aiMaybeMoveCalls, 1);
  assert.equal(ctx.aiRequests, 1);
});

test('deleting an open saved record preserves its immutable review and never resaves it', () => {
  const saved = record('delete-open');
  const other = record('keep-other', 2);
  const ctx = harness({ records: [saved, other] });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  const reviewBefore = ctx.gameReviewSession;
  assert.equal(ctx.deleteGameRecordFromLibrary(saved.id), true);
  assert.equal(ctx.storage.writes, 1);
  assert.equal(ctx.gameReviewSession, reviewBefore);
  assert.equal(ctx.gameReviewStored, false);
  assert.equal(ctx.navigateGameReview('first'), true);
  assert.equal(ctx.gameRecordStore.getGameRecord(saved.id), null);
  assert.equal(ctx.gameRecordStore.getGameRecord(other.id).id, other.id);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.storage.writes, 1);
});

test('delete cancellation and write failure are non-destructive and leave review usable', () => {
  const saved = record('delete-safe');
  const cancelled = harness({ records: [saved], confirm: false });
  cancelled.enterGameRecordLibrary();
  cancelled.openStoredGameReview(saved.id);
  assert.equal(cancelled.deleteGameRecordFromLibrary(saved.id), false);
  assert.equal(cancelled.storage.writes, 0);
  assert.equal(cancelled.gameReviewSession.record.id, saved.id);

  const failed = harness({ records: [saved], writeError: new Error('quota') });
  const serializedBefore = failed.storage.serialized;
  failed.enterGameRecordLibrary();
  failed.openStoredGameReview(saved.id);
  assert.equal(failed.deleteGameRecordFromLibrary(saved.id), false);
  assert.equal(failed.storage.writes, 1);
  assert.equal(failed.storage.serialized, serializedBefore);
  assert.equal(failed.navigateGameReview('first'), true);
  assert.equal(failed.gameReviewSession.record.id, saved.id);
});

test('empty, multiple, corrupt and read-failed library loads never rewrite storage', () => {
  const empty = harness();
  empty.enterGameRecordLibrary();
  assert.equal(empty.libraryView.status, 'empty');
  assert.equal(empty.storage.writes, 0);

  const multiple = harness({ records: [record('a'), record('b', 2)] });
  multiple.enterGameRecordLibrary();
  assert.equal(multiple.libraryView.status, 'ready');
  assert.deepEqual(multiple.libraryView.records.map(({ id }) => id), ['a', 'b']);
  assert.equal(multiple.storage.writes, 0);

  const corrupt = harness({ serialized: '{broken' });
  corrupt.enterGameRecordLibrary();
  assert.equal(corrupt.libraryView.status, 'warning');
  assert.equal(corrupt.storage.writes, 0);

  const unavailable = harness({ readError: new Error('blocked') });
  unavailable.enterGameRecordLibrary();
  assert.equal(unavailable.libraryView.status, 'unavailable');
  assert.equal(unavailable.storage.writes, 0);
  unavailable.exitGameRecordFlow();
  assert.equal(unavailable.appState, 'NORMAL_GAME');
});

test('explicit Review AI request uses only canonical Review context and renders one inert score-free candidate', () => {
  const saved = record('review-ai-lifecycle');
  const originalRecord = clone(saved);
  const ctx = harness({ records: [saved], mode: 'medium', turn: BLACK, realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  const review = ctx.gameReviewSession;
  const before = reviewAiIsolationSnapshot(ctx);
  const normalWorker = ctx.aiWorker;

  assert.equal(ctx.reviewAiWorkers.length, 0, 'analysis is explicit, never automatic on Review render/navigation');
  assert.equal(ctx.requestGameReviewAiCandidate(), true);
  assert.equal(ctx.gameReviewAiState.status, 'loading');
  assert.equal(ctx.gameReviewAiHeading.textContent, '電腦搜尋中…');
  assert.equal(ctx.reviewAiWorkers.length, 1);
  const worker = ctx.reviewAiWorkers[0];
  const request = worker.messages[0];
  assert.deepEqual(request.board, review.snapshot.board);
  assert.notDeepEqual(request.board, ctx.board, 'live board is deliberately different');
  assert.equal(request.sideToMove, review.snapshot.sideToMove);
  assert.notEqual(request.sideToMove, ctx.turn, 'live turn is deliberately opposite');
  assert.deepEqual(request.repetitionPrefix, review.snapshot.repetitionHistory);
  assert.equal(request.analysisPreset, 'review-v1');
  assert.deepEqual(reviewAiIsolationSnapshot(ctx), before);
  assert.equal(ctx.aiWorker, normalWorker, 'persistent normal worker identity is unchanged');

  worker.emit(successfulReviewAiResponse(worker));
  assert.equal(ctx.gameReviewAiState.status, 'success');
  assert.equal(ctx.gameReviewAiState.candidate.notation, '俥六平五');
  assert.equal(ctx.gameReviewAiState.candidate.depth, 2);
  assert.equal(worker.terminated, true);
  assert.equal(ctx.gameReviewAiWorker, null);
  assert.match(ctx.gameReviewAiHeading.textContent, /^AI 候選著法：/);
  assert.equal(ctx.gameReviewAiDetail.textContent, '搜尋深度：2');
  assert.doesNotMatch(`${ctx.gameReviewAiHeading.textContent}${ctx.gameReviewAiDetail.textContent}`, /99998|score|PV|最佳著/);
  assert.deepEqual(ctx.gameReviewSession.snapshot.board, review.snapshot.board);
  assert.deepEqual(ctx.gameReviewSession.record, originalRecord);
  assert.deepEqual(reviewAiIsolationSnapshot(ctx), before);
  assert.equal(ctx.normalDoMoveCalls, 0);
  assert.equal(ctx.storage.writes, 0);
  assert.equal(ctx.puzzleWrites, 0);
  assert.equal(ctx.analyticsWrites, 0);
});

test('Review AI error is retryable and worker construction has no main-thread fallback', () => {
  const saved = record('review-ai-error');
  const ctx = harness({ records: [saved], workerCreationError: true, realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');

  assert.equal(ctx.requestGameReviewAiCandidate(), true);
  assert.equal(ctx.gameReviewAiState.status, 'error');
  assert.match(ctx.gameReviewAiHeading.textContent, /請再試一次/);
  assert.equal(ctx.btnGameReviewAiAnalyze.disabled, false);
  assert.equal(ctx.reviewAiWorkers.length, 0);
  assert.doesNotMatch(functionSource('requestGameReviewAiCandidate'), /aiModule|findBestMove|setTimeout/);
  assert.equal(ctx.requestGameReviewAiCandidate(), true, 'retry remains explicit and available');
  assert.equal(ctx.gameReviewAiState.status, 'error');
});

test('new request, ply navigation and record switch reject stale revision and old-worker results', () => {
  const recordA = record('review-ai-record-a');
  const recordB = record('review-ai-record-b', 2);
  const ctx = harness({ records: [recordA, recordB], realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(recordA.id);
  ctx.navigateGameReview('first');

  ctx.requestGameReviewAiCandidate();
  const firstWorker = ctx.reviewAiWorkers.at(-1);
  const firstRevision = firstWorker.messages[0].revision;
  ctx.requestGameReviewAiCandidate();
  const secondWorker = ctx.reviewAiWorkers.at(-1);
  assert.equal(firstWorker.terminated, true);
  firstWorker.emit(successfulReviewAiResponse(firstWorker));
  assert.equal(ctx.gameReviewAiState.status, 'loading', 'old worker cannot settle the replacement request');
  secondWorker.emit({ ...successfulReviewAiResponse(secondWorker), revision: firstRevision });
  assert.equal(ctx.gameReviewAiState.status, 'loading', 'wrong revision remains ignored');
  secondWorker.emit(successfulReviewAiResponse(secondWorker));
  assert.equal(ctx.gameReviewAiState.status, 'success');

  ctx.requestGameReviewAiCandidate();
  const plyWorker = ctx.reviewAiWorkers.at(-1);
  ctx.navigateGameReview('last');
  assert.equal(plyWorker.terminated, true);
  assert.equal(ctx.gameReviewAiState.status, 'idle');
  assert.equal(ctx.gameReviewAiPanel.classList.contains('hidden'), true);
  plyWorker.emit(successfulReviewAiResponse(plyWorker, { from: { r: 0, c: 4 }, to: { r: 0, c: 5 } }));
  assert.equal(ctx.gameReviewAiState.status, 'idle', 'stale ply response remains ignored');

  ctx.navigateGameReview('first');
  ctx.requestGameReviewAiCandidate();
  const recordWorker = ctx.reviewAiWorkers.at(-1);
  ctx.openStoredGameReview(recordB.id);
  assert.equal(recordWorker.terminated, true);
  recordWorker.emit(successfulReviewAiResponse(recordWorker));
  assert.equal(ctx.gameReviewSession.record.id, recordB.id);
  assert.equal(ctx.gameReviewAiState.status, 'idle', 'stale Record A response cannot surface on Record B');
  assert.equal(ctx.normalDoMoveCalls, 0);
  assert.equal(ctx.storage.writes, 0);
});

test('Review exit invalidates pending results and normal AI resumes through its existing scheduler only', () => {
  const saved = record('review-ai-exit');
  const ctx = harness({ records: [saved], mode: 'hard', turn: BLACK, realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  const tokenAfterReviewEntry = ctx.aiToken;
  ctx.requestGameReviewAiCandidate();
  const worker = ctx.reviewAiWorkers.at(-1);
  assert.equal(ctx.aiToken, tokenAfterReviewEntry);
  ctx.exitGameRecordFlow();
  assert.equal(worker.terminated, true);
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assert.equal(ctx.aiToken, tokenAfterReviewEntry + 1, 'only the existing Review exit invalidation advances normal token');
  assert.equal(ctx.aiRequests, 1, 'normal scheduler resumes one normal AI request');
  worker.emit(successfulReviewAiResponse(worker));
  assert.equal(ctx.gameReviewAiState.status, 'idle');
  assert.equal(ctx.normalDoMoveCalls, 0);
});

test('terminal and GAME_ANALYSIS contexts gate Review AI, while R2/R4 production entries invalidate it', () => {
  const saved = record('review-ai-gating');
  const ctx = harness({ records: [saved], realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  assert.ok(ctx.gameReviewSession.snapshot.terminal);
  assert.equal(ctx.btnGameReviewAiAnalyze.disabled, true);
  assert.equal(ctx.requestGameReviewAiCandidate(), false);
  ctx.navigateGameReview('first');
  ctx.appState = 'GAME_ANALYSIS';
  assert.equal(ctx.requestGameReviewAiCandidate(), false);
  assert.equal(ctx.reviewAiWorkers.length, 0);
  assert.match(functionSource('enterGameAnalysis'), /invalidateGameReviewAi\(\)/);
  assert.match(functionSource('createPuzzleFromGameReview'), /invalidateGameReviewAi\(\)/);
  assert.doesNotMatch(
    html.match(/<section id="gameAnalysisView"[^]*?<\/section>/)?.[0] || '',
    /btnGameReviewAiAnalyze|AI 分析/,
  );
});

test('negative control detects forbidden doMove reuse in the real Review AI result route', () => {
  const saved = record('review-ai-do-move-mutation');
  const ctx = harness({ records: [saved], realRenderer: true, reviewAiMutation: 'doMove' });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  ctx.requestGameReviewAiCandidate();
  const worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker));
  let detected = null;
  try {
    assert.equal(ctx.normalDoMoveCalls, 0, 'REVIEW_AI_DO_MOVE_COUNT');
  } catch (error) {
    detected = error;
  }
  assert.equal(detected?.code, 'ERR_ASSERTION');
  assert.match(detected.message, /REVIEW_AI_DO_MOVE_COUNT/);
});

test('source and DOM contain explicit read-only, accessibility and responsive guards', () => {
  assert.match(functionSource('doMove'), /if\s*\(!normalGameActive\(\)\)\s*return/);
  assert.match(source, /if \(appState === APP_STATE\.GAME_RECORD_LIBRARY \|\| appState === APP_STATE\.GAME_REVIEW\) return;\s*\n\s*const hit = pick\(e\)/);
  assert.match(source, /if \(appState === APP_STATE\.GAME_ANALYSIS\) \{\s*\n\s*handleGameAnalysisBoardClick\(hit\)/);
  assert.doesNotMatch(functionSource('navigateGameReview'), /doMove|maybeAIMove|gameRecordStore/);
  assert.match(source, /createGameReview\(record\)/);
  assert.match(html, /id="gameReviewStatus"[^>]*aria-live="polite"/);
  assert.match(html, /id="btnGameReviewFirst"[^>]*type="button"/);
  assert.match(html, /id="btnGameReviewPrevious"[^>]*type="button"/);
  assert.match(html, /id="btnGameReviewAiAnalyze"[^>]*type="button"[^>]*aria-label="分析目前複盤局面"/);
  assert.match(html, /id="gameReviewAiPanel"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(source, /setAttribute\('aria-current', 'step'\)/);
  assert.match(source, /ArrowLeft: 'previous'/);
  assert.match(source, /ArrowRight: 'next'/);
  assert.match(source, /Home: 'first'/);
  assert.match(source, /End: 'last'/);
  assert.match(css, /@media \(max-width: 900px\)[^]*#gameRecordPanel/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /prefers-reduced-motion/);
});
