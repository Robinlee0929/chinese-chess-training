import assert from 'node:assert/strict';
import test from 'node:test';
import { initialBoard, RED, BLACK } from './game.js';
import {
  canStartGameFromReview, createReviewContinuationPosition,
  defaultContinuationDifficulty, defaultContinuationHumanSide,
  validateContinuationConfiguration,
} from './game-review-continuation.js';

const review = () => ({ sourceKind: 'completed', snapshot: {
  board: initialBoard(), sideToMove: BLACK, terminal: null,
} });
test('completed nonterminal review is eligible', () => assert.equal(canStartGameFromReview(review()), true));
test('terminal review is ineligible', () => {
  const r = review(); r.snapshot.terminal = { winner: RED };
  assert.equal(canStartGameFromReview(r), false);
  assert.throws(() => createReviewContinuationPosition(r));
});
test('live teaching review is ineligible', () => {
  const r = review(); r.sourceKind = 'live-teaching';
  assert.equal(canStartGameFromReview(r), false);
});
test('branch board equals selected snapshot', () => {
  const r = review(); assert.deepEqual(createReviewContinuationPosition(r).board, r.snapshot.board);
});
test('branch turn equals selected snapshot', () => {
  assert.equal(createReviewContinuationPosition(review()).sideToMove, BLACK);
});
test('branch cells and rows are independent of source board', () => {
  const r = review(); const before = structuredClone(r);
  const branch = createReviewContinuationPosition(r);
  branch.board[0][0].type = 'P'; branch.board[0][1] = null;
  assert.deepEqual(r, before);
});
for (const mode of ['easy', 'medium', 'hard']) {
  test(`difficulty inherits ${mode}`, () => assert.equal(defaultContinuationDifficulty(mode), mode));
}
test('pvp defaults to medium', () => assert.equal(defaultContinuationDifficulty('pvp'), 'medium'));
test('default human side is side to move', () => {
  for (const side of [RED, BLACK]) assert.equal(defaultContinuationHumanSide(side), side);
});
for (const side of [RED, BLACK]) {
  test(`explicit player ${side} accepted`, () => {
    assert.deepEqual(validateContinuationConfiguration({ difficulty: 'hard', humanSide: side }),
      { difficulty: 'hard', humanSide: side });
  });
}
test('invalid side rejected', () => {
  assert.throws(() => validateContinuationConfiguration({ difficulty: 'medium', humanSide: 'white' }));
  const r = review(); r.snapshot.sideToMove = 'white';
  assert.equal(canStartGameFromReview(r), false);
});
test('invalid difficulty rejected including pvp', () => {
  for (const difficulty of ['pvp', 'invalid', null]) {
    assert.throws(() => validateContinuationConfiguration({ difficulty, humanSide: RED }));
  }
});
test('missing review, snapshot and malformed boards fail closed', () => {
  for (const r of [null, {}, { sourceKind: 'completed' },
    { ...review(), snapshot: { ...review().snapshot, board: [] } }]) {
    assert.equal(canStartGameFromReview(r), false);
  }
  for (const mutate of [b => { b[0][0].side = 'white'; }, b => { b[0][4] = null; },
    b => { b[0][0].type = 'X'; }, b => { b[0].pop(); }]) {
    const r = review(); mutate(r.snapshot.board);
    assert.equal(canStartGameFromReview(r), false);
  }
});
