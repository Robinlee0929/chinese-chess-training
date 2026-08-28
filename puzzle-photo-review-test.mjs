import assert from 'node:assert/strict';
import {
  UNREVIEWED, CONFIRMED_EMPTY, CONFIRMED_PIECE, HIGH_CONFIDENCE_EMPTY_THRESHOLD,
  PuzzlePhotoReviewError, createReviewState, buildReviewQueue, selectReviewCandidate,
  confirmEmpty, confirmPiece, nextUnresolved, nextCandidate, previousCandidate,
  eligibleEmptyKeys, acceptHighConfidenceEmpty, undoBulkEmpty, resetReview,
  rescanReview, unresolvedCount, reviewProgress, confirmedSelections, buildReviewedBoard,
} from './puzzle-photo-review.js';

let passed = 0;
let failed = 0;
function test(label, run) {
  try { run(); passed++; console.log(`  ✓ ${label}`); }
  catch (error) { failed++; console.error(`  ✗ ${label}`, error); }
}
function candidates() {
  return Array.from({ length: 90 }, (_, index) => ({
    r: 9 - Math.floor(index / 9), c: index % 9,
    displayRow: Math.floor(index / 9), displayCol: index % 9,
    occupancy: index === 0 ? 'occupied' : index === 1 ? 'uncertain' : 'empty',
    occupancyConfidence: index === 2 ? 0.69 : 0.85,
    suggestedSide: 'unknown', sideConfidence: 0.2,
  }));
}
const red = { type: 'K', side: 'red' };
const black = { type: 'K', side: 'black' };
const initial = () => createReviewState(candidates());
function resolved() {
  let state = acceptHighConfidenceEmpty(initial());
  state = confirmPiece(state, '9,0', red);
  state = confirmPiece(state, '9,1', black);
  return confirmEmpty(state, '9,2');
}
function errorCode(run, code) {
  assert.throws(run, (error) => error instanceof PuzzlePhotoReviewError && error.code === code);
}

test('queue contains occupied candidates', () => assert.ok(buildReviewQueue(initial()).includes('9,0')));
test('queue contains uncertain candidates', () => assert.ok(buildReviewQueue(initial()).includes('9,1')));
test('high-confidence empty excluded initially', () => assert.ok(!buildReviewQueue(initial()).includes('9,3')));
test('low-confidence empty requires review', () => assert.ok(buildReviewQueue(initial()).includes('9,2')));
test('all 90 intersections start explicitly unreviewed', () => {
  assert.equal(unresolvedCount(initial()), 90);
  assert.ok(Object.values(initial().entries).every((entry) => entry.status === UNREVIEWED));
});
test('confirm empty', () => assert.equal(confirmEmpty(initial(), '9,0').entries['9,0'].status, CONFIRMED_EMPTY));
test('confirm red piece', () => assert.deepEqual(confirmPiece(initial(), '9,0', red).entries['9,0'].piece, red));
test('confirm black piece', () => assert.deepEqual(confirmPiece(initial(), '9,0', black).entries['9,0'].piece, black));
test('human confirmation immutable against opposite machine suggestion', () => {
  const state = confirmPiece(initial(), '9,0', red);
  const nextCandidates = candidates();
  nextCandidates[0].suggestedSide = 'black';
  nextCandidates[0].occupancy = 'empty';
  assert.deepEqual(rescanReview(state, nextCandidates).entries['9,0'].piece, red);
});
test('next unresolved wraps and skips confirmed candidates', () => {
  const state = confirmEmpty(initial(), '9,1');
  assert.equal(nextUnresolved(state, '9,0'), '9,2');
  assert.equal(nextUnresolved(state, '9,2'), '9,0');
});
test('previous candidate wraps deterministically', () => assert.equal(previousCandidate(initial()), '9,2'));
test('next candidate works', () => assert.equal(nextCandidate(initial()), '9,1'));
test('confirmation automatically advances', () => assert.equal(confirmEmpty(initial(), '9,0').currentKey, '9,1'));
test('progress counts queue rather than all 90 points', () => {
  const progress = reviewProgress(confirmEmpty(initial(), '9,0'));
  assert.equal(progress.queueSize, 3);
  assert.equal(progress.confirmed, 1);
  assert.equal(progress.remaining, 2);
});
test('unresolved count includes empties not yet explicitly accepted', () => assert.equal(unresolvedCount(confirmEmpty(initial(), '9,0')), 89));
test('bulk marks eligible high-confidence empty points only', () => {
  const state = acceptHighConfidenceEmpty(initial());
  assert.equal(reviewProgress(state).bulkEmpty, 87);
  assert.equal(unresolvedCount(state), 3);
  assert.equal(state.entries['9,3'].status, CONFIRMED_EMPTY);
});
test('uncertain point is never bulk-confirmed', () => assert.equal(acceptHighConfidenceEmpty(initial()).entries['9,1'].status, UNREVIEWED));
test('occupied point is never bulk-confirmed', () => assert.equal(acceptHighConfidenceEmpty(initial()).entries['9,0'].status, UNREVIEWED));
test('existing confirmed piece is not overwritten by bulk', () => {
  const state = acceptHighConfidenceEmpty(confirmPiece(initial(), '9,3', red));
  assert.equal(state.entries['9,3'].status, CONFIRMED_PIECE);
  assert.deepEqual(state.entries['9,3'].piece, red);
  assert.equal(reviewProgress(state).bulkEmpty, 86);
});
test('unresolved filter is deterministic and preserves state', () => {
  const state = confirmEmpty(initial(), '9,1');
  assert.deepEqual(buildReviewQueue(state, { unresolvedOnly: true }), ['9,0', '9,2']);
  assert.equal(buildReviewQueue(state).length, 3);
});
test('board is exactly 10 by 9', () => {
  const board = buildReviewedBoard(resolved());
  assert.equal(board.length, 10);
  assert.ok(board.every((row) => row.length === 9));
});
test('confirmed empty maps to null', () => assert.equal(buildReviewedBoard(resolved())[9][2], null));
test('confirmed piece maps to exact side and type', () => assert.deepEqual(buildReviewedBoard(resolved())[9][0], red));
test('unresolved review blocks final handoff', () => errorCode(() => buildReviewedBoard(initial()), 'UNRESOLVED_REVIEW'));
test('resolved queue plus explicit empty acceptance permits handoff', () => assert.equal(reviewProgress(resolved()).canApply, true));
test('resolved queue does not silently accept excluded empty points', () => {
  let state = initial();
  for (const key of buildReviewQueue(state)) state = confirmEmpty(state, key);
  assert.equal(reviewProgress(state).remaining, 0);
  assert.equal(reviewProgress(state).unresolved, 87);
  errorCode(() => buildReviewedBoard(state), 'UNRESOLVED_REVIEW');
});
test('red king count summary', () => assert.equal(reviewProgress(resolved()).redKings, 1));
test('black king count summary', () => assert.equal(reviewProgress(resolved()).blackKings, 1));
test('multiple kings remain a warning for authoritative editor validation', () => {
  const state = confirmPiece(resolved(), '9,2', red);
  assert.equal(reviewProgress(state).redKings, 2);
  assert.equal(reviewProgress(state).canApply, true);
});
test('input review state is not mutated', () => {
  const state = initial();
  confirmEmpty(state, '9,0');
  acceptHighConfidenceEmpty(state);
  assert.equal(unresolvedCount(state), 90);
});
test('candidate input is defensively isolated', () => {
  const input = candidates();
  const state = createReviewState(input);
  input[0].occupancy = 'empty';
  assert.equal(state.candidates[0].occupancy, 'occupied');
});
test('piece input and returned state are defensively isolated', () => {
  const input = { ...red };
  const state = confirmPiece(initial(), '9,0', input);
  input.type = 'R';
  assert.equal(state.entries['9,0'].piece.type, 'K');
  assert.throws(() => { state.entries['9,0'].piece.type = 'R'; }, TypeError);
});
test('returned board does not alias review state', () => {
  const state = resolved();
  const board = buildReviewedBoard(state);
  board[9][0].type = 'R';
  assert.equal(buildReviewedBoard(state)[9][0].type, 'K');
});
test('reset clears manual and bulk review and flags', () => {
  const state = resetReview(resolved());
  assert.equal(unresolvedCount(state), 90);
  assert.ok(Object.values(state.entries).every((entry) => !entry.flagged && entry.source === null));
});
test('rescan preserves both confirmed empty and piece choices', () => {
  const state = rescanReview(resolved(), candidates().reverse());
  assert.deepEqual(confirmedSelections(state), confirmedSelections(resolved()));
  assert.deepEqual(buildReviewQueue(state), buildReviewQueue(resolved()));
});
test('P9 unknown suggestions do not affect human state', () => {
  const input = candidates();
  input[0].typeSuggestion = { status: 'unknown', type: null };
  const state = rescanReview(resolved(), input);
  assert.deepEqual(buildReviewedBoard(state), buildReviewedBoard(resolved()));
  assert.ok(!Object.hasOwn(state.candidates[0], 'typeSuggestion'));
});
test('directly tapped excluded point enters review queue', () => {
  const state = selectReviewCandidate(initial(), '8,8');
  assert.ok(buildReviewQueue(state).includes('8,8'));
  assert.equal(state.currentKey, '8,8');
});
test('bulk undo is bounded and preserves later manual overrides', () => {
  let state = acceptHighConfidenceEmpty(initial());
  state = confirmPiece(state, '9,3', red);
  state = confirmEmpty(state, '9,4');
  state = undoBulkEmpty(state);
  assert.deepEqual(state.entries['9,3'].piece, red);
  assert.equal(state.entries['9,4'].status, CONFIRMED_EMPTY);
  assert.equal(state.entries['9,5'].status, UNREVIEWED);
});
test('threshold is inclusive and centralized', () => {
  const input = candidates();
  input[2].occupancyConfidence = HIGH_CONFIDENCE_EMPTY_THRESHOLD;
  assert.equal(eligibleEmptyKeys(createReviewState(input)).length, 88);
});
test('empty queue handles navigation without invalid coordinates', () => {
  const state = createReviewState(candidates().map((candidate) => ({ ...candidate, occupancy: 'empty', occupancyConfidence: 0.9 })));
  assert.equal(nextCandidate(state), null);
  assert.equal(previousCandidate(state), null);
  assert.equal(nextUnresolved(state), null);
  assert.equal(reviewProgress(acceptHighConfidenceEmpty(state)).canApply, true);
});
test('completed queue has no next unresolved', () => assert.equal(nextUnresolved(resolved()), null));
test('bulk acceptance retains an unresolved current target', () => assert.equal(acceptHighConfidenceEmpty(initial()).currentKey, '9,0'));
test('rescan selects newly relevant candidates when the old queue was empty', () => {
  const state = createReviewState(candidates().map((candidate) => ({ ...candidate, occupancy: 'empty', occupancyConfidence: 0.9 })));
  assert.equal(state.currentKey, null);
  assert.equal(rescanReview(state, candidates()).currentKey, '9,0');
});
test('malformed display coordinates fail closed', () => {
  const input = candidates(); input[0].displayRow = NaN;
  errorCode(() => createReviewState(input), 'INVALID_DISPLAY_GRID');
});
test('duplicate coordinates fail closed', () => {
  const input = candidates(); input[1] = { ...input[0] };
  errorCode(() => createReviewState(input), 'DUPLICATE_CANDIDATE');
});
test('malformed candidate count fails closed', () => errorCode(() => createReviewState([]), 'INVALID_CANDIDATES'));
test('invalid confidence fails closed', () => {
  const input = candidates(); input[0].occupancyConfidence = NaN;
  errorCode(() => createReviewState(input), 'INVALID_CANDIDATE');
});
test('invalid exact piece is rejected', () => errorCode(() => confirmPiece(initial(), '9,0', { type: 'X', side: 'red' }), 'INVALID_PIECE'));
test('unknown review coordinate is rejected', () => errorCode(() => confirmEmpty(initial(), '10,0'), 'INVALID_COORDINATE'));
test('exported machine integration selections are isolated', () => {
  const state = resolved();
  const selections = confirmedSelections(state);
  selections['9,0'].type = 'R';
  assert.equal(state.entries['9,0'].piece.type, 'K');
});
console.log(`\n${passed} puzzle-photo-review tests passed; ${failed} failed.`);
process.exit(failed ? 1 : 0);
