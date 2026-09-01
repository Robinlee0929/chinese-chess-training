import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { RED, BLACK, initialBoard, legalMoves, applyMove } from './game.js';
import { createGameRecord, replayGameRecord } from './game-record.js';
import { createGameReview, selectGameReviewPly } from './game-review.js';
import {
  createGameAnalysis,
  gameAnalysisLegalMoves,
  applyGameAnalysisMove,
  undoGameAnalysisMove,
  resetGameAnalysis,
} from './game-analysis.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./css/style.css', import.meta.url), 'utf8');

function functionSource(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `main.js function ${name} exists`);
  return match[0];
}

function boardClickHandlerSource() {
  const match = source.match(
    /renderer\.domElement\.addEventListener\('click', \(e\) => \{([^]*?)\r?\n\}\);\r?\n\r?\n\/\/ ---------------- 終局/,
  );
  assert.ok(match, 'main.js production canvas click handler exists');
  return `function dispatchBoardClick(e) {${match[1]}\n}`;
}

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

const cycle = [
  [{ r: 9, c: 4 }, { r: 9, c: 5 }],
  [{ r: 4, c: 3 }, { r: 5, c: 3 }],
  [{ r: 9, c: 5 }, { r: 9, c: 4 }],
  [{ r: 5, c: 3 }, { r: 4, c: 3 }],
];

function repetitionRecord(id = 'analysis-lifecycle-a') {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[4][3] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  return createGameRecord({
    schemaVersion: 1,
    id,
    createdAt: '2026-08-31T01:00:00.000Z',
    completedAt: '2026-08-31T01:08:00.000Z',
    initialPosition: { board, sideToMove: BLACK },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    mode: 'pvp',
    result: { winner: null, terminationReason: 'threefold-repetition' },
  });
}

function checkmateRecord(id = 'analysis-lifecycle-b') {
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
    createdAt: '2026-08-31T02:00:00.000Z',
    completedAt: '2026-08-31T02:01:00.000Z',
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
  });
}

function domNode(hidden = false) {
  const classes = new Set(hidden ? ['hidden'] : []);
  const attributes = new Map();
  return {
    children: [],
    disabled: false,
    scrollHeight: 120,
    scrollTop: 0,
    textContent: '',
    className: '',
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
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    focusCalls: 0,
    focus() { this.focusCalls++; },
  };
}

function harness(record, ply, {
  moveMutation = null,
  undoMutation = false,
  routerMutation = false,
} = {}) {
  const review = selectGameReviewPly(createGameReview(record), ply);
  const liveBoard = initialBoard();
  const context = vm.createContext({
    RED,
    BLACK,
    structuredClone,
    APP_STATE: Object.freeze({
      NORMAL_GAME: 'NORMAL_GAME',
      GAME_RECORD_LIBRARY: 'GAME_RECORD_LIBRARY',
      GAME_REVIEW: 'GAME_REVIEW',
      GAME_ANALYSIS: 'GAME_ANALYSIS',
      PUZZLE_PRACTICING: 'PUZZLE_PRACTICING',
      PUZZLE_PRACTICE_COMPLETE: 'PUZZLE_PRACTICE_COMPLETE',
      PUZZLE_RECORDING: 'PUZZLE_RECORDING',
      PUZZLE_RECORDED: 'PUZZLE_RECORDED',
    }),
    appState: 'GAME_REVIEW',
    gameReviewSession: review,
    gameAnalysisState: null,
    gameAnalysisSelected: null,
    gameAnalysisLegal: [],
    gameAnalysisNotice: '',
    liveBoard,
    board: liveBoard,
    turn: RED,
    history: [{ from: { r: 6, c: 0 }, to: { r: 5, c: 0 } }],
    posHistory: ['live-a', 'live-b'],
    repHistory: [{ key: 'live|red', mover: null, check: false }],
    capturedBy: { [RED]: [], [BLACK]: [{ type: 'P', side: RED }] },
    over: false,
    winner: null,
    normalGameRecordSession: { id: 'live-session-b' },
    mode: 'medium',
    aiToken: 17,
    aiThinking: true,
    AI_SIDE: BLACK,
    busy: false,
    selected: null,
    legal: [],
    inputHits: [],
    normalDoMoveCalls: 0,
    normalUndoCalls: 0,
    analysisApplyCalls: 0,
    aiRequests: 0,
    renderedBoard: null,
    reviewRenderCount: 0,
    persistenceWrites: 0,
    resultAudioCalls: 0,
    reviewAiInvalidations: 0,
    createGameAnalysis,
    gameAnalysisLegalMoves,
    applyGameAnalysisMove(...args) {
      context.analysisApplyCalls++;
      return applyGameAnalysisMove(...args);
    },
    undoGameAnalysisMove,
    resetGameAnalysis,
    invalidateGameReviewAi() { context.reviewAiInvalidations++; },
    GAME_RECORD_REASON_LABELS: Object.freeze({
      checkmate: '將死',
      stalemate: '困斃',
      'perpetual-check': '長將判負',
      'threefold-repetition': '三次重複局面',
      'mutual-perpetual-check': '雙方長將',
    }),
    document: { createElement: () => domNode() },
    btnGameReviewAnalyze: domNode(),
    gameRecordPanel: domNode(),
    gameReviewView: domNode(),
    gameAnalysisView: domNode(true),
    gameAnalysisHeading: domNode(),
    gameAnalysisMeta: domNode(),
    gameAnalysisStatus: domNode(),
    gameAnalysisMoveCount: domNode(),
    gameAnalysisMoveList: domNode(),
    btnGameAnalysisUndo: domNode(),
    btnGameAnalysisReset: domNode(),
    lastFromMark: { visible: false, position: { set() {} } },
    lastToMark: { visible: false, position: { set() {} } },
    selRing: { visible: false },
    clearFX() {},
    clearSelection() { context.selected = null; context.legal = []; },
    to3D: (r, c) => ({ x: c, z: r }),
    rebuildPieceMeshes(board) { context.renderedBoard = structuredClone(board); },
    showMoveDots() {},
    checkBoardMeshInvariant: () => ({ ok: true, errors: [] }),
    refreshHUD() {},
    renderGameReview() {
      context.reviewRenderCount++;
      context.renderedBoard = structuredClone(context.gameReviewSession.snapshot.board);
    },
    toast() {},
    pick() { return context.inputHits.shift() ?? null; },
    libraryActive: () => false,
    authoringActive: () => false,
    isAI: () => false,
    practiceState: null,
    handlePracticeBoardClick() {},
    handleRecorderBoardClick() {},
    handleEditorBoardClick() {},
    select(r, c) {
      context.selected = { r, c };
      context.legal = legalMoves(context.board, r, c).map(({ r: toR, c: toC }) => ({ r: toR, c: toC }));
    },
    doMove(from, to) {
      context.normalDoMoveCalls++;
      const piece = context.board[from.r]?.[from.c];
      const legal = piece?.side === context.turn
        && legalMoves(context.board, from.r, from.c).some(({ r, c }) => r === to.r && c === to.c);
      if (!legal) return false;
      const captured = applyMove(context.board, from, to);
      context.history.push({ from: { ...from }, to: { ...to }, captured });
      context.turn = context.turn === RED ? BLACK : RED;
      context.selected = null;
      context.legal = [];
      return true;
    },
    undo() { context.normalUndoCalls++; },
    downXY: null,
  });
  const names = [
    'appendGameReviewMeta', 'gameAnalysisTerminalLabel', 'clearGameAnalysisSelection',
    'syncGameAnalysisMoveMark', 'gameAnalysisAnnouncement', 'renderGameAnalysis',
    'enterGameAnalysis', 'makeGameAnalysisMove', 'undoGameAnalysis',
    'resetGameAnalysisToSource', 'returnToGameReview', 'selectGameAnalysisPiece',
    'handleGameAnalysisBoardClick',
  ];
  let functions = names.map(functionSource);
  if (moveMutation) {
    const index = names.indexOf('makeGameAnalysisMove');
    const mutations = {
      board: 'gameAnalysisState = applyGameAnalysisMove(gameAnalysisState, from, to);\n    board = gameAnalysisState.currentBoard;',
      doMove: 'gameAnalysisState = applyGameAnalysisMove(gameAnalysisState, from, to);\n    doMove(from, to);',
    };
    assert.ok(mutations[moveMutation], `known move mutation: ${moveMutation}`);
    functions[index] = functions[index].replace(
      'gameAnalysisState = applyGameAnalysisMove(gameAnalysisState, from, to);',
      mutations[moveMutation],
    );
  }
  if (undoMutation) {
    const index = names.indexOf('undoGameAnalysis');
    functions[index] = functions[index].replace(
      'gameAnalysisState = undoGameAnalysisMove(gameAnalysisState);',
      'gameAnalysisState = undoGameAnalysisMove(gameAnalysisState);\n  undo();',
    );
  }
  let router = boardClickHandlerSource();
  if (routerMutation) {
    router = router.replace(
      'handleGameAnalysisBoardClick(hit);',
      'handleGameAnalysisBoardClick(hit);\n    doMove({ r: 3, c: 0 }, { r: 4, c: 0 });',
    );
  }
  functions.push(router);
  vm.runInContext(functions.join('\n'), context);
  return context;
}

function dispatchBoardMove(context, from, to, sourceBoard) {
  const sourcePiece = sourceBoard[from.r][from.c];
  const destinationPiece = sourceBoard[to.r][to.c];
  assert.ok(sourcePiece, `source ${from.r},${from.c} contains a piece`);
  context.inputHits.push({ userData: { r: from.r, c: from.c, piece: structuredClone(sourcePiece) } });
  context.inputHits.push(destinationPiece
    ? { userData: { r: to.r, c: to.c, piece: structuredClone(destinationPiece) } }
    : { r: to.r, c: to.c });
  context.dispatchBoardClick({ clientX: 10, clientY: 10 });
  context.dispatchBoardClick({ clientX: 10, clientY: 10 });
}

function liveSnapshot(context) {
  return structuredClone({
    board: context.liveBoard,
    canonicalBoard: context.board,
    turn: context.turn,
    history: context.history,
    posHistory: context.posHistory,
    repHistory: context.repHistory,
    capturedBy: context.capturedBy,
    over: context.over,
    winner: context.winner,
    normalGameRecordSession: context.normalGameRecordSession,
    mode: context.mode,
    aiToken: context.aiToken,
    aiThinking: context.aiThinking,
  });
}

test('production entry and renderer branch from the exact canonical review position without live or record mutation', () => {
  const record = repetitionRecord();
  const original = structuredClone(record);
  const context = harness(record, 4);
  const live = liveSnapshot(context);

  assert.equal(context.enterGameAnalysis(), true);
  assert.equal(context.reviewAiInvalidations, 1, 'entering R2 invalidates pending Review AI');
  assert.equal(context.appState, 'GAME_ANALYSIS');
  assert.deepEqual(context.gameAnalysisState.anchorBoard, replayGameRecord(record, 4).board);
  assert.equal(context.gameAnalysisState.anchorSideToMove, replayGameRecord(record, 4).sideToMove);
  assert.equal(context.gameAnalysisState.sourcePly, 4);
  assert.deepEqual(context.renderedBoard, replayGameRecord(record, 4).board);
  assert.equal(context.gameReviewView.classList.contains('hidden'), true);
  assert.equal(context.gameAnalysisView.classList.contains('hidden'), false);

  assert.equal(context.makeGameAnalysisMove(...cycle[0]), true);
  assert.equal(context.gameAnalysisState.moves.length, 1);
  assert.deepEqual(context.renderedBoard, context.gameAnalysisState.currentBoard);
  assert.notDeepEqual(context.renderedBoard, replayGameRecord(record, 4).board);
  assert.deepEqual(record, original);
  assert.deepEqual(liveSnapshot(context), live);
  assert.equal(context.persistenceWrites, 0);
  assert.equal(context.normalDoMoveCalls, 0);
  assert.equal(context.normalUndoCalls, 0);
  assert.equal(context.aiRequests, 0);
});

test('production entry rejects a canonical terminal review ply without state change', () => {
  const record = repetitionRecord();
  const context = harness(record, record.moves.length);
  assert.equal(context.enterGameAnalysis(), false);
  assert.equal(context.appState, 'GAME_REVIEW');
  assert.equal(context.gameAnalysisState, null);
  assert.deepEqual(context.renderedBoard, null);
});

test('production undo, reset and terminal rendering are local and play no result presentation', () => {
  const record = repetitionRecord();
  const context = harness(record, 4);
  const live = liveSnapshot(context);
  context.enterGameAnalysis();
  for (const move of cycle.slice(0, 3)) assert.equal(context.makeGameAnalysisMove(...move), true);
  const expectedAfterUndo = context.gameAnalysisState;
  assert.equal(context.makeGameAnalysisMove(...cycle[3]), true);

  assert.deepEqual(context.gameAnalysisState.terminal, {
    winner: null,
    terminationReason: 'threefold-repetition',
  });
  assert.equal(context.gameAnalysisStatus.classList.contains('terminal'), true);
  assert.match(context.gameAnalysisStatus.textContent, /分析終止.*三次重複局面/);
  assert.equal(context.makeGameAnalysisMove(...cycle[0]), false);
  assert.equal(context.resultAudioCalls, 0);

  const normalUndoCountBefore = context.normalUndoCalls;
  assert.equal(context.undoGameAnalysis(), true);
  assert.equal(context.gameAnalysisState.moves.length, 3);
  assert.deepEqual(context.gameAnalysisState.currentBoard, expectedAfterUndo.currentBoard);
  assert.equal(context.gameAnalysisState.currentSide, expectedAfterUndo.currentSide);
  assert.deepEqual(context.gameAnalysisState.repetitionHistory, expectedAfterUndo.repetitionHistory);
  assert.equal(context.gameAnalysisState.terminal, null);
  assert.equal(context.normalUndoCalls, normalUndoCountBefore);
  assert.equal(context.normalUndoCalls, 0);
  assert.deepEqual(liveSnapshot(context), live);
  assert.match(context.gameAnalysisStatus.textContent, /已悔棋/);
  assert.equal(context.resetGameAnalysisToSource(), true);
  assert.equal(context.gameAnalysisState.moves.length, 0);
  assert.deepEqual(context.gameAnalysisState.currentBoard, replayGameRecord(record, 4).board);
  assert.match(context.gameAnalysisStatus.textContent, /已重置到來源局面/);
});

test('production canvas click dispatch separates normal, review and analysis routes at runtime', () => {
  const record = repetitionRecord();
  const normalFrom = { r: 3, c: 0 };
  const normalTo = { r: 4, c: 0 };

  const normal = harness(record, 4);
  normal.appState = 'NORMAL_GAME';
  normal.aiThinking = false;
  normal.mode = 'pvp';
  const normalHistoryLength = normal.history.length;
  dispatchBoardMove(normal, normalFrom, normalTo, normal.board);
  assert.equal(normal.normalDoMoveCalls, 1);
  assert.equal(normal.analysisApplyCalls, 0);
  assert.equal(normal.history.length, normalHistoryLength + 1);
  assert.deepEqual(normal.board[normalTo.r][normalTo.c], { type: 'P', side: RED });

  const review = harness(record, 4);
  const reviewBefore = review.gameReviewSession;
  dispatchBoardMove(review, normalFrom, normalTo, review.board);
  assert.equal(review.normalDoMoveCalls, 0);
  assert.equal(review.analysisApplyCalls, 0);
  assert.equal(review.gameReviewSession, reviewBefore);

  const analysis = harness(record, 4);
  const live = liveSnapshot(analysis);
  assert.equal(analysis.enterGameAnalysis(), true);
  dispatchBoardMove(analysis, ...cycle[0], analysis.gameAnalysisState.currentBoard);
  assert.equal(analysis.gameAnalysisState.moves.length, 1);
  assert.equal(analysis.analysisApplyCalls, 1);
  assert.equal(analysis.normalDoMoveCalls, 0);
  assert.deepEqual(liveSnapshot(analysis), live);
  dispatchBoardMove(analysis, ...cycle[1], analysis.gameAnalysisState.currentBoard);
  assert.equal(analysis.gameAnalysisState.moves.length, 2);
  assert.equal(analysis.analysisApplyCalls, 2);
  assert.equal(analysis.normalDoMoveCalls, 0);
  assert.deepEqual(liveSnapshot(analysis), live);
});

test('returning restores the exact review source and a later record opens uncontaminated', () => {
  const recordA = repetitionRecord();
  const recordB = checkmateRecord();
  const context = harness(recordA, 4);
  const sourceA = context.gameReviewSession;
  context.enterGameAnalysis();
  context.makeGameAnalysisMove(...cycle[0]);

  assert.equal(context.returnToGameReview(), true);
  assert.equal(context.appState, 'GAME_REVIEW');
  assert.equal(context.gameReviewSession, sourceA);
  assert.equal(context.gameReviewSession.selectedPly, 4);
  assert.deepEqual(context.renderedBoard, replayGameRecord(recordA, 4).board);
  assert.equal(context.gameAnalysisState, null);

  context.gameReviewSession = selectGameReviewPly(createGameReview(recordB), 0);
  assert.equal(context.enterGameAnalysis(), true);
  assert.equal(context.gameAnalysisState.sourceRecordId, recordB.id);
  assert.equal(context.gameAnalysisState.sourcePly, 0);
  assert.equal(context.gameAnalysisState.moves.length, 0);
  assert.deepEqual(context.gameAnalysisState.currentBoard, replayGameRecord(recordB, 0).board);
  assert.equal(context.persistenceWrites, 0);
});

test('analysis UI exposes native accessible controls, terminal gating and responsive safeguards', () => {
  assert.match(html, /id="btnGameReviewAnalyze"[^>]*type="button"/);
  assert.match(html, /id="gameAnalysisStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="btnGameAnalysisUndo"[^>]*type="button"/);
  assert.match(html, /id="btnGameAnalysisReset"[^>]*type="button"/);
  assert.match(html, /id="btnGameAnalysisReturn"[^>]*type="button"/);
  assert.match(functionSource('renderGameReview'), /btnGameReviewAnalyze\.disabled = !!review\.snapshot\.terminal/);
  assert.doesNotMatch(functionSource('makeGameAnalysisMove'), /doMove|sfx|gameRecordStore|puzzleStore|maybeAIMove/);
  assert.match(css, /\.game-analysis-actions button \{ min-height: 44px/);
  assert.match(css, /@media \(max-width: 900px\)[^]*#gameAnalysisMoveList/);
  assert.match(css, /prefers-reduced-motion[^]*\.game-analysis-view/);
});

test('negative controls detect live-board assignment and normal doMove reuse', () => {
  const record = repetitionRecord();
  const liveMutation = harness(record, 4, { moveMutation: 'board' });
  const liveBefore = liveSnapshot(liveMutation);
  liveMutation.enterGameAnalysis();
  liveMutation.makeGameAnalysisMove(...cycle[0]);
  assert.notDeepEqual(liveSnapshot(liveMutation), liveBefore);

  const normalMoveMutation = harness(record, 4, { moveMutation: 'doMove' });
  normalMoveMutation.enterGameAnalysis();
  normalMoveMutation.makeGameAnalysisMove(...cycle[0]);
  assert.equal(normalMoveMutation.normalDoMoveCalls, 1);
});
