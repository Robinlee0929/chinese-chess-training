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

function domNode(initiallyHidden = false) {
  const classes = new Set(initiallyHidden ? ['hidden'] : []);
  return {
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
    focusCalls: 0,
    focus() { this.focusCalls++; },
  };
}

function vector() {
  return { set() {} };
}

function harness({ records = [], serialized, readError, writeError, confirm = true, mode = 'pvp', turn = RED } = {}) {
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
  const context = vm.createContext({
    RED, BLACK,
    APP_STATE: Object.freeze({
      NORMAL_GAME: 'NORMAL_GAME',
      GAME_RECORD_LIBRARY: 'GAME_RECORD_LIBRARY',
      GAME_REVIEW: 'GAME_REVIEW',
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
    normalGameRecordSession: Object.freeze({ id: 'live-session', createdAt: '2026-08-31T03:00:00.000Z' }),
    lastCompletedGameRecord: records[0] || record('memory-only'),
    selected: { r: 0, c: 1 },
    legal: [{ r: 2, c: 0 }, { r: 2, c: 2 }],
    busy: false,
    mode,
    aiToken: 7,
    aiThinking: mode !== 'pvp' && turn === BLACK,
    aiRequests: 0,
    aiMaybeMoveCalls: 0,
    tweens: [],
    gameReviewSession: null,
    gameReviewReturnState: 'NORMAL_GAME',
    gameReviewInvoker: null,
    gameReviewStored: false,
    gameReviewLivePresentation: null,
    renderedBoard: liveBoard,
    renderCount: 0,
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
    appEl: domNode(),
    gameRecordPanel: domNode(true),
    gameRecordLibraryView: domNode(),
    gameReviewView: domNode(true),
    gameRecordLibraryHeading: domNode(),
    gameReviewHeading: domNode(),
    btnReviewGame: domNode(),
    btnGameRecords: domNode(),
    btnGameReviewDelete: domNode(true),
    overlay: domNode(true),
    banner: domNode(true),
    lastFromMark: { visible: true, position: vector() },
    lastToMark: { visible: true, position: vector() },
    document: { activeElement: null },
    window: { confirm: () => confirm },
    normalGameActive: () => context.appState === 'NORMAL_GAME',
    gameRecordFlowActive: () => ['GAME_RECORD_LIBRARY', 'GAME_REVIEW'].includes(context.appState),
    clearSelection: () => { context.selected = null; context.legal = []; },
    stopConfetti() {},
    rebuildPieceMeshes(board) {
      context.clearSelection();
      context.renderedBoard = structuredClone(board);
    },
    syncLastMoveMark() {
      context.lastFromMark.visible = context.lastToMark.visible = context.history.length > 0;
    },
    showMoveDots() {},
    renderGameReview() {
      context.renderCount++;
      context.renderedBoard = structuredClone(context.gameReviewSession.snapshot.board);
    },
    renderGameRecordLibrary() {
      context.libraryView = createGameRecordLibraryView(context.gameRecordStore.loadAll());
      return context.libraryView;
    },
    refreshHUD() {},
    checkBoardMeshInvariant: () => ({ ok: true, errors: [] }),
    toast: (message) => context.messages.push(message),
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
    'pauseLiveGameForGameRecords', 'restoreLiveGamePresentation',
    'enterGameRecordLibrary', 'showGameRecordLibrary', 'openGameReview',
    'openLastCompletedGameReview', 'openStoredGameReview', 'navigateGameReview',
    'deleteGameRecordFromLibrary', 'exitGameReview', 'exitGameRecordFlow',
  ];
  vm.runInContext(names.map(functionSource).join('\n'), context);
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
  });
}

test('just-completed in-memory record opens at the final board with zero persistence writes', () => {
  const completed = record('just-completed');
  const ctx = harness({ records: [] });
  ctx.lastCompletedGameRecord = completed;
  ctx.board = clone(replayGameRecord(completed, completed.moves.length).board);
  ctx.over = true;
  ctx.winner = RED;
  const before = liveSnapshot(ctx);
  assert.equal(ctx.openLastCompletedGameReview(ctx.btnReviewGame), true);
  assert.equal(ctx.appState, 'GAME_REVIEW');
  assert.equal(ctx.gameReviewSession.selectedPly, completed.moves.length);
  assert.deepEqual(ctx.renderedBoard, before.board);
  assert.equal(ctx.storage.writes, 0);
  assert.deepEqual(liveSnapshot(ctx), before);
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

test('source and DOM contain explicit read-only, accessibility and responsive guards', () => {
  assert.match(functionSource('doMove'), /if\s*\(!normalGameActive\(\)\)\s*return/);
  assert.match(source, /if \(gameRecordFlowActive\(\)\) return;\s*\n\s*const hit = pick\(e\)/);
  assert.doesNotMatch(functionSource('navigateGameReview'), /doMove|maybeAIMove|gameRecordStore/);
  assert.match(source, /createGameReview\(record\)/);
  assert.match(html, /id="gameReviewStatus"[^>]*aria-live="polite"/);
  assert.match(html, /id="btnGameReviewFirst"[^>]*type="button"/);
  assert.match(html, /id="btnGameReviewPrevious"[^>]*type="button"/);
  assert.match(source, /setAttribute\('aria-current', 'step'\)/);
  assert.match(source, /ArrowLeft: 'previous'/);
  assert.match(source, /ArrowRight: 'next'/);
  assert.match(source, /Home: 'first'/);
  assert.match(source, /End: 'last'/);
  assert.match(css, /@media \(max-width: 900px\)[^]*#gameRecordPanel/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /prefers-reduced-motion/);
});
