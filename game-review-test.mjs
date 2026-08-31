import assert from 'node:assert/strict';
import test from 'node:test';
import { RED, BLACK } from './game.js';
import {
  GAME_REVIEW_INITIAL_PLY,
  createGameRecordLibraryView,
  createGameReview,
  firstGameReviewPly,
  previousGameReviewPly,
  nextGameReviewPly,
  lastGameReviewPly,
  selectGameReviewPly,
} from './game-review.js';

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function checkmateRecord(id = 'review-checkmate') {
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
    createdAt: '2026-08-31T01:00:00.000Z',
    completedAt: '2026-08-31T01:01:00.000Z',
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
  };
}

function mutualPerpetualRecord(id = 'review-cycle') {
  const board = emptyBoard();
  board[0][3] = { type: 'R', side: RED };
  board[1][4] = { type: 'K', side: RED };
  board[2][4] = { type: 'C', side: RED };
  board[3][4] = { type: 'N', side: BLACK };
  board[5][6] = { type: 'N', side: BLACK };
  board[5][8] = { type: 'R', side: RED };
  board[7][4] = { type: 'C', side: BLACK };
  board[8][3] = { type: 'K', side: BLACK };
  const cycle = [
    [{ r: 3, c: 4 }, { r: 5, c: 3 }],
    [{ r: 2, c: 4 }, { r: 2, c: 3 }],
    [{ r: 5, c: 3 }, { r: 3, c: 4 }],
    [{ r: 2, c: 3 }, { r: 2, c: 4 }],
  ];
  return {
    schemaVersion: 1,
    id,
    createdAt: '2026-08-31T02:00:00.000Z',
    completedAt: '2026-08-31T02:05:00.000Z',
    initialPosition: { board, sideToMove: BLACK },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    mode: 'hard',
    result: { winner: null, terminationReason: 'mutual-perpetual-check' },
  };
}

test('opens a valid record at the final ply by the documented default', () => {
  const review = createGameReview(mutualPerpetualRecord());
  assert.equal(GAME_REVIEW_INITIAL_PLY, 'last');
  assert.equal(review.selectedPly, 8);
  assert.equal(review.totalPlies, 8);
  assert.equal(review.atLast, true);
  assert.deepEqual(review.snapshot.terminal, {
    winner: null,
    terminationReason: 'mutual-perpetual-check',
  });
});

test('defensively clones and freezes the source record', () => {
  const source = checkmateRecord();
  const review = createGameReview(source);
  source.id = 'mutated';
  source.moves[0].from.r = 9;
  source.initialPosition.board[0][4] = null;
  assert.equal(review.record.id, 'review-checkmate');
  assert.deepEqual(review.record.moves[0].from, { r: 2, c: 3 });
  assert.deepEqual(review.record.initialPosition.board[0][4], { type: 'K', side: RED });
  assert.equal(Object.isFrozen(review), true);
  assert.equal(Object.isFrozen(review.record), true);
  assert.throws(() => { review.record.id = 'nope'; }, TypeError);
});

test('supports explicit first-ply entry with initial side and no current move', () => {
  const review = createGameReview(mutualPerpetualRecord(), { selectedPly: 'first' });
  assert.equal(review.selectedPly, 0);
  assert.equal(review.atFirst, true);
  assert.equal(review.snapshot.sideToMove, BLACK);
  assert.equal(review.currentMove, null);
  assert.equal(review.snapshot.terminal, null);
});

test('first, previous, next and last navigation never wrap', () => {
  let review = createGameReview(mutualPerpetualRecord());
  review = firstGameReviewPly(review);
  assert.equal(previousGameReviewPly(review).selectedPly, 0);
  review = nextGameReviewPly(review);
  assert.equal(review.selectedPly, 1);
  assert.equal(previousGameReviewPly(review).selectedPly, 0);
  review = lastGameReviewPly(review);
  assert.equal(nextGameReviewPly(review).selectedPly, 8);
});

test('direct jump clamps boundaries and synchronizes current move', () => {
  const opened = createGameReview(mutualPerpetualRecord());
  const middle = selectGameReviewPly(opened, 4);
  assert.equal(middle.selectedPly, 4);
  assert.equal(middle.currentMove.ply, 4);
  assert.equal(middle.currentMove, middle.moves[3]);
  assert.equal(selectGameReviewPly(middle, -20).selectedPly, 0);
  assert.equal(selectGameReviewPly(middle, 200).selectedPly, 8);
  assert.throws(() => selectGameReviewPly(middle, 1.5), TypeError);
});

test('move notation and side-to-move come from canonical replay metadata', () => {
  const first = selectGameReviewPly(createGameReview(checkmateRecord()), 1);
  assert.equal(first.moves.length, 1);
  assert.equal(first.moves[0].notation, '俥六平五');
  assert.equal(first.moves[0].side, RED);
  assert.equal(first.snapshot.sideToMove, BLACK);
  assert.deepEqual(first.snapshot.terminal, first.record.result);
});

test('switching records creates isolated state and resets the selected ply', () => {
  const recordA = mutualPerpetualRecord('record-a');
  const recordB = checkmateRecord('record-b');
  const navigatedA = selectGameReviewPly(createGameReview(recordA), 3);
  const openedB = createGameReview(recordB);
  assert.equal(navigatedA.record.id, 'record-a');
  assert.equal(navigatedA.selectedPly, 3);
  assert.equal(openedB.record.id, 'record-b');
  assert.equal(openedB.selectedPly, 1);
  assert.equal(openedB.totalPlies, 1);
  assert.notDeepEqual(openedB.snapshot.board, navigatedA.snapshot.board);
});

test('navigation never mutates the original record or prior review snapshots', () => {
  const source = mutualPerpetualRecord();
  const before = structuredClone(source);
  const final = createGameReview(source);
  const first = firstGameReviewPly(final);
  const next = nextGameReviewPly(first);
  const last = lastGameReviewPly(next);
  assert.deepEqual(source, before);
  assert.equal(final.selectedPly, 8);
  assert.equal(first.selectedPly, 0);
  assert.equal(next.selectedPly, 1);
  assert.equal(last.selectedPly, 8);
});

test('library view distinguishes empty, ready, warning and unavailable states', () => {
  assert.equal(createGameRecordLibraryView({ records: [], issues: [] }).status, 'empty');
  assert.equal(createGameRecordLibraryView({ records: [checkmateRecord()], issues: [] }).status, 'ready');
  const warning = createGameRecordLibraryView({
    records: [checkmateRecord()],
    issues: [{ code: 'INVALID_GAME_RECORD', message: 'invalid' }],
  });
  assert.equal(warning.status, 'warning');
  assert.equal(warning.records.length, 1);
  const unavailable = createGameRecordLibraryView({
    records: [],
    issues: [{ code: 'STORE_READ_FAILED', message: 'blocked' }],
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(Object.isFrozen(unavailable), true);
  assert.equal(Object.isFrozen(unavailable.issues), true);
});

test('library view supports multiple records without changing canonical store order', () => {
  const oldest = checkmateRecord('oldest');
  const newest = checkmateRecord('newest');
  newest.createdAt = '2026-08-31T03:00:00.000Z';
  newest.completedAt = '2026-08-31T03:01:00.000Z';
  const view = createGameRecordLibraryView({ records: [oldest, newest], issues: [] });
  assert.deepEqual(view.records.map(({ id }) => id), ['oldest', 'newest']);
  assert.throws(() => { view.records[0].id = 'mutated'; }, TypeError);
});
