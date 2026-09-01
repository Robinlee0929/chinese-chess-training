import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RED, BLACK, initialBoard } from './game.js';
import { createGameReview, selectGameReviewPly } from './game-review.js';
import { replayGameRecord } from './game-record.js';
import {
  createGameReviewPuzzleHandoff,
  GameReviewPuzzleHandoffError,
} from './game-review-puzzle-handoff.js';
import {
  confirmAuthoredPosition,
  moveEditorPiece,
  placeEditorPiece,
  removeEditorPiece,
} from './puzzle-editor.js';
import { createRecorder, finishRecording, recordMove } from './puzzle-recorder.js';
import { createPuzzleStore } from './puzzle-store.js';
import { createPracticeAnalyticsStore } from './puzzle-analytics.js';
import { createGameRecordStore } from './game-record-store.js';

const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./css/style.css', import.meta.url), 'utf8');

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function checkmateRecord(id = 'r4-record') {
  const board = emptyBoard();
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[9][8] = { type: 'R', side: RED };
  return {
    schemaVersion: 1,
    id,
    createdAt: '2026-09-01T01:00:00.000Z',
    completedAt: '2026-09-01T01:01:00.000Z',
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
  };
}

function assertEditorGraphIsDeeplyDistinct(editorBoard, reviewBoard) {
  assert.notStrictEqual(editorBoard, reviewBoard, 'editor board must not alias the Review board');
  for (let r = 0; r < reviewBoard.length; r++) {
    assert.notStrictEqual(editorBoard[r], reviewBoard[r], `editor row ${r} must not alias Review row ${r}`);
    for (let c = 0; c < reviewBoard[r].length; c++) {
      if (reviewBoard[r][c] !== null) {
        assert.notStrictEqual(
          editorBoard[r][c],
          reviewBoard[r][c],
          `editor piece ${r},${c} must not alias the Review piece`,
        );
      }
    }
  }
}

test('nonterminal handoff uses the exact canonical replay snapshot and side, never live state', () => {
  const source = checkmateRecord();
  const review = selectGameReviewPly(createGameReview(source), 0);
  const unrelatedLiveBoard = initialBoard();
  const unrelatedLiveTurn = BLACK;
  const handoff = createGameReviewPuzzleHandoff(review);

  assert.deepEqual(handoff.editorState.board, review.snapshot.board);
  assertEditorGraphIsDeeplyDistinct(handoff.editorState.board, review.snapshot.board);
  assert.equal(handoff.editorState.sideToMove, review.snapshot.sideToMove);
  assert.notDeepEqual(handoff.editorState.board, unrelatedLiveBoard,
    'a live-board source mutation would fail this assertion');
  assert.notEqual(handoff.editorState.sideToMove, unrelatedLiveTurn,
    'a live-turn source mutation would fail this assertion');
  assert.equal(handoff.sourceRecordId, source.id);
  assert.equal(handoff.sourcePly, 0);
  assert.equal('solution' in handoff.editorState, false);
  assert.equal(Object.isFrozen(handoff.editorState.board), true);
});

test('handoff is deeply isolated from GameRecord, review snapshot, stored record and live board', () => {
  const source = checkmateRecord();
  const sourceBefore = structuredClone(source);
  const review = selectGameReviewPly(createGameReview(source), 0);
  const reviewBefore = structuredClone(review.snapshot);
  const replayBefore = structuredClone(replayGameRecord(source, review.selectedPly).board);
  const liveBoard = initialBoard();
  const liveBefore = structuredClone(liveBoard);
  const memory = new Map();
  let gameRecordWrites = 0;
  const gameRecordStore = createGameRecordStore({ storage: {
    getItem: (key) => memory.get(key) ?? null,
    setItem(key, value) { gameRecordWrites++; memory.set(key, value); },
  } });
  gameRecordStore.saveGameRecord(source);
  const storedBefore = structuredClone(gameRecordStore.getGameRecord(source.id));
  const writesBeforeHandoff = gameRecordWrites;

  const handoff = createGameReviewPuzzleHandoff(review);
  assertEditorGraphIsDeeplyDistinct(handoff.editorState.board, review.snapshot.board);
  const moved = moveEditorPiece(handoff.editorState, { r: 9, c: 0 }, { r: 8, c: 0 });
  const removed = removeEditorPiece(moved, { r: 2, c: 4 });
  const replaced = placeEditorPiece(removed, { type: 'N', side: BLACK }, { r: 2, c: 4 });
  const edited = placeEditorPiece(replaced, { type: 'P', side: BLACK }, { r: 8, c: 1 });
  assert.notDeepEqual(edited.board, handoff.editorState.board,
    'the editor operation must create an isolated board');
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(review.snapshot, reviewBefore);
  assert.deepEqual(replayGameRecord(source, review.selectedPly).board, replayBefore);
  assert.deepEqual(gameRecordStore.getGameRecord(source.id), storedBefore);
  assert.deepEqual(liveBoard, liveBefore);
  assert.equal(gameRecordWrites, writesBeforeHandoff);
});

test('negative controls expose direct, row-array and piece-object handoff aliases', () => {
  const canonicalReview = selectGameReviewPly(createGameReview(checkmateRecord()), 0);
  const reviewBoard = canonicalReview.snapshot.board;

  assert.throws(
    () => assertEditorGraphIsDeeplyDistinct(reviewBoard, reviewBoard),
    (error) => error?.code === 'ERR_ASSERTION'
      && /editor board must not alias/.test(error.message),
  );
  assert.throws(
    () => assertEditorGraphIsDeeplyDistinct([...reviewBoard], reviewBoard),
    (error) => error?.code === 'ERR_ASSERTION'
      && /editor row 0 must not alias/.test(error.message),
  );
  assert.throws(
    () => assertEditorGraphIsDeeplyDistinct(reviewBoard.map((row) => [...row]), reviewBoard),
    (error) => error?.code === 'ERR_ASSERTION'
      && /editor piece 0,4 must not alias/.test(error.message),
  );

  const mutableReview = structuredClone(canonicalReview);
  const sourceBefore = structuredClone(mutableReview.snapshot.board);
  const shallowMutantBoard = [...mutableReview.snapshot.board];
  shallowMutantBoard[9][0] = null;
  shallowMutantBoard[2][3] = { type: 'N', side: RED };
  shallowMutantBoard[8][1] = { type: 'P', side: BLACK };

  assert.throws(
    () => assert.deepEqual(
      mutableReview.snapshot.board,
      sourceBefore,
      'SOURCE_REVIEW_SNAPSHOT_IMMUTABLE after shallow-clone editor mutation',
    ),
    (error) => error?.code === 'ERR_ASSERTION'
      && /SOURCE_REVIEW_SNAPSHOT_IMMUTABLE/.test(error.message),
  );
  assert.equal(mutableReview.snapshot.board[9][0], null, 'source cell 9,0 was removed');
  assert.deepEqual(
    mutableReview.snapshot.board[2][3],
    { type: 'N', side: RED },
    'source piece 2,3 was replaced',
  );
  assert.deepEqual(
    mutableReview.snapshot.board[8][1],
    { type: 'P', side: BLACK },
    'source cell 8,1 was altered',
  );
});

test('terminal review positions are rejected without creating editor state', () => {
  const terminal = createGameReview(checkmateRecord());
  assert.equal(terminal.snapshot.terminal?.terminationReason, 'checkmate');
  assert.throws(
    () => createGameReviewPuzzleHandoff(terminal),
    (error) => error instanceof GameReviewPuzzleHandoffError
      && error.code === 'TERMINAL_REVIEW_POSITION',
  );
});

test('transferred positions retain editor validation and recorder legality/checkmate requirements', () => {
  const review = selectGameReviewPly(createGameReview(checkmateRecord()), 0);
  const handoff = createGameReviewPuzzleHandoff(review);

  const invalid = removeEditorPiece(handoff.editorState, { r: 0, c: 4 });
  assert.equal(confirmAuthoredPosition(invalid).ok, false);
  assert.equal(confirmAuthoredPosition(invalid).error.code, 'MISSING_RED_KING');

  const confirmed = confirmAuthoredPosition(handoff.editorState);
  assert.equal(confirmed.ok, true);
  const recorder = createRecorder(confirmed.position);
  assert.throws(
    () => recordMove(recorder, { r: 2, c: 3 }, { r: 3, c: 4 }),
    (error) => error.code === 'ILLEGAL_MOVE',
  );
  const nonmate = recordMove(recorder, { r: 0, c: 4 }, { r: 0, c: 3 });
  assert.equal(finishRecording(nonmate).checkmate, false);

  const mate = recordMove(recorder, { r: 2, c: 3 }, { r: 2, c: 4 });
  const finished = finishRecording(mate);
  assert.equal(finished.ok, true);
  assert.equal(finished.checkmate, true);
});

test('authoring and the canonical single save do not write GameRecords or Puzzle Analytics', () => {
  let gameRecordWrites = 0;
  let puzzleWrites = 0;
  let analyticsWrites = 0;
  const gameRecordStore = createGameRecordStore({ storage: {
    getItem: () => null,
    setItem: () => { gameRecordWrites++; },
  } });
  const puzzleStore = createPuzzleStore({ storage: {
    getItem: () => null,
    setItem: () => { puzzleWrites++; },
  }, idFactory: () => 'saved-r4' });
  createPracticeAnalyticsStore({ storage: {
    getItem: () => null,
    setItem: () => { analyticsWrites++; },
  } });
  const source = checkmateRecord();
  gameRecordStore.saveGameRecord(source);
  const baselineGameRecordWrites = gameRecordWrites;
  const handoff = createGameReviewPuzzleHandoff(selectGameReviewPly(createGameReview(source), 0));
  const confirmed = confirmAuthoredPosition(handoff.editorState);
  const finished = finishRecording(recordMove(
    createRecorder(confirmed.position),
    { r: 2, c: 3 },
    { r: 2, c: 4 },
  ));

  assert.equal(puzzleWrites, 0);
  assert.equal(analyticsWrites, 0);
  assert.equal(gameRecordWrites, baselineGameRecordWrites);
  const saved = puzzleStore.savePuzzle({ id: 'candidate', title: 'R4 殺局', ...finished.result });
  assert.equal(saved.id, 'saved-r4');
  assert.equal(puzzleWrites, 1);
  assert.equal(analyticsWrites, 0);
  assert.equal(gameRecordWrites, baselineGameRecordWrites);
  for (const forbidden of ['sourceGameRecordId', 'sourcePly', 'reviewSource', 'analysisLine']) {
    assert.equal(forbidden in saved, false);
  }
});

test('record switching creates independent source metadata without leaking the prior handoff', () => {
  const a = createGameReview(checkmateRecord('record-a'), { selectedPly: 'first' });
  const b = createGameReview(checkmateRecord('record-b'), { selectedPly: 'first' });
  const handoffA = createGameReviewPuzzleHandoff(a);
  const handoffB = createGameReviewPuzzleHandoff(b);
  assert.deepEqual([handoffA.sourceRecordId, handoffA.sourcePly], ['record-a', 0]);
  assert.deepEqual([handoffB.sourceRecordId, handoffB.sourcePly], ['record-b', 0]);
  assert.notEqual(handoffA.editorState, handoffB.editorState);
});

test('Review UI exposes one accessible action with terminal gating and no Analysis placement', () => {
  assert.equal((html.match(/id="btnGameReviewCreatePuzzle"/g) || []).length, 1);
  assert.match(html, /<button id="btnGameReviewCreatePuzzle" type="button"[^>]*>建立殺局題<\/button>/);
  const analysisView = html.match(/<section id="gameAnalysisView"[^]*?<\/section>/)?.[0] || '';
  assert.doesNotMatch(analysisView, /btnGameReviewCreatePuzzle|建立殺局題/);
  assert.match(mainSource, /btnGameReviewCreatePuzzle\.disabled = !!review\.snapshot\.terminal/);
  assert.match(mainSource, /appState !== APP_STATE\.GAME_REVIEW[^]*?gameReviewSession\.snapshot\.terminal/);
  assert.match(mainSource, /editorHeading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(mainSource, /reviewReturn\.invoker\?\.focus\?\.\(\{ preventScroll: true \}\)/);
  assert.match(css, /\.game-review-actions button \{[^}]*min-height: 44px/);
});
