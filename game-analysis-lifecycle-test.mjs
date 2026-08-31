import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { RED, BLACK, initialBoard } from './game.js';
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

function harness(record, ply, { moveMutation = null } = {}) {
  const review = selectGameReviewPly(createGameReview(record), ply);
  const liveBoard = initialBoard();
  const context = vm.createContext({
    RED,
    BLACK,
    structuredClone,
    APP_STATE: Object.freeze({ GAME_REVIEW: 'GAME_REVIEW', GAME_ANALYSIS: 'GAME_ANALYSIS' }),
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
    normalDoMoveCalls: 0,
    normalUndoCalls: 0,
    aiRequests: 0,
    renderedBoard: null,
    reviewRenderCount: 0,
    persistenceWrites: 0,
    resultAudioCalls: 0,
    createGameAnalysis,
    gameAnalysisLegalMoves,
    applyGameAnalysisMove,
    undoGameAnalysisMove,
    resetGameAnalysis,
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
    clearSelection() {},
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
    doMove() { context.normalDoMoveCalls++; },
    undo() { context.normalUndoCalls++; },
  });
  const names = [
    'appendGameReviewMeta', 'gameAnalysisTerminalLabel', 'clearGameAnalysisSelection',
    'syncGameAnalysisMoveMark', 'gameAnalysisAnnouncement', 'renderGameAnalysis',
    'enterGameAnalysis', 'makeGameAnalysisMove', 'undoGameAnalysis',
    'resetGameAnalysisToSource', 'returnToGameReview',
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
  vm.runInContext(functions.join('\n'), context);
  return context;
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
  context.enterGameAnalysis();
  for (const move of cycle) assert.equal(context.makeGameAnalysisMove(...move), true);

  assert.deepEqual(context.gameAnalysisState.terminal, {
    winner: null,
    terminationReason: 'threefold-repetition',
  });
  assert.equal(context.gameAnalysisStatus.classList.contains('terminal'), true);
  assert.match(context.gameAnalysisStatus.textContent, /分析終止.*三次重複局面/);
  assert.equal(context.makeGameAnalysisMove(...cycle[0]), false);
  assert.equal(context.resultAudioCalls, 0);

  assert.equal(context.undoGameAnalysis(), true);
  assert.equal(context.gameAnalysisState.moves.length, 3);
  assert.equal(context.gameAnalysisState.terminal, null);
  assert.match(context.gameAnalysisStatus.textContent, /已悔棋/);
  assert.equal(context.resetGameAnalysisToSource(), true);
  assert.equal(context.gameAnalysisState.moves.length, 0);
  assert.deepEqual(context.gameAnalysisState.currentBoard, replayGameRecord(record, 4).board);
  assert.match(context.gameAnalysisStatus.textContent, /已重置到來源局面/);
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
