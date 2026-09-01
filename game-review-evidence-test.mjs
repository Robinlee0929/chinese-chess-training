import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  RED,
  BLACK,
  applyMove,
  getMoves,
  hashBoard,
  inCheck,
  legalMoves,
  repetitionVerdict,
} from './game.js';
import { createGameRecord } from './game-record.js';
import { createGameReview, selectGameReviewPly } from './game-review.js';
import {
  createGameReviewAiState,
  beginGameReviewAiRequest,
  settleGameReviewAiResponse,
} from './game-review-ai.js';
import { createGameReviewEvidence } from './game-review-evidence.js';

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function baseRecord({ id, board, sideToMove, moves, result }) {
  return createGameRecord({
    schemaVersion: 1,
    id,
    createdAt: '2026-09-01T01:00:00.000Z',
    completedAt: '2026-09-01T01:05:00.000Z',
    initialPosition: { board, sideToMove },
    moves,
    mode: 'pvp',
    result,
  });
}

function mateRecord(id = 'r3b-mate') {
  const board = emptyBoard();
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[4][1] = { type: 'N', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[9][8] = { type: 'R', side: RED };
  return baseRecord({
    id,
    board,
    sideToMove: RED,
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    result: { winner: RED, terminationReason: 'checkmate' },
  });
}

function stalemateRecord() {
  const board = emptyBoard();
  board[9][5] = { type: 'K', side: BLACK };
  board[0][5] = { type: 'K', side: RED };
  board[4][5] = { type: 'P', side: RED };
  board[7][5] = { type: 'N', side: RED };
  board[7][0] = { type: 'R', side: RED };
  return baseRecord({
    id: 'r3b-stalemate',
    board,
    sideToMove: RED,
    moves: [{ from: { r: 7, c: 0 }, to: { r: 8, c: 0 } }],
    result: { winner: RED, terminationReason: 'stalemate' },
  });
}

function cycleRecord({ id, perpetual = false }) {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[perpetual ? 7 : 4][perpetual ? 0 : 3] = { type: 'R', side: RED };
  board[perpetual ? 7 : 9][4] = { type: 'K', side: BLACK };
  if (!perpetual) board[4][1] = { type: 'N', side: BLACK };
  const cycle = perpetual ? [
    [{ r: 7, c: 4 }, { r: 8, c: 4 }],
    [{ r: 7, c: 0 }, { r: 8, c: 0 }],
    [{ r: 8, c: 4 }, { r: 7, c: 4 }],
    [{ r: 8, c: 0 }, { r: 7, c: 0 }],
  ] : [
    [{ r: 9, c: 4 }, { r: 9, c: 5 }],
    [{ r: 4, c: 3 }, { r: 5, c: 3 }],
    [{ r: 9, c: 5 }, { r: 9, c: 4 }],
    [{ r: 5, c: 3 }, { r: 4, c: 3 }],
  ];
  return baseRecord({
    id,
    board,
    sideToMove: BLACK,
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    result: perpetual
      ? { winner: BLACK, terminationReason: 'perpetual-check' }
      : { winner: null, terminationReason: 'threefold-repetition' },
  });
}

function pseudoLegalCaptureRecord() {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[4][3] = { type: 'R', side: RED };
  board[5][4] = { type: 'R', side: RED };
  board[5][6] = { type: 'N', side: RED };
  board[7][4] = { type: 'R', side: BLACK };
  board[9][4] = { type: 'K', side: BLACK };
  const cycle = [
    [{ r: 9, c: 4 }, { r: 9, c: 5 }],
    [{ r: 4, c: 3 }, { r: 5, c: 3 }],
    [{ r: 9, c: 5 }, { r: 9, c: 4 }],
    [{ r: 5, c: 3 }, { r: 4, c: 3 }],
  ];
  return baseRecord({
    id: 'r3b-pseudo-legal-capture',
    board,
    sideToMove: BLACK,
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    result: { winner: null, terminationReason: 'threefold-repetition' },
  });
}

function acceptedR3a(review, move, depth = 2) {
  const started = beginGameReviewAiRequest(createGameReviewAiState(), review);
  const settled = settleGameReviewAiResponse(started.state, review, {
    kind: 'review-candidate',
    recordId: started.request.recordId,
    ply: started.request.ply,
    revision: started.request.revision,
    result: { from: move.from, to: move.to, depth, score: 99999, pv: ['hidden'] },
  });
  assert.equal(settled.state.status, 'success');
  return settled.state;
}

function reviewAt(record, ply) {
  return selectGameReviewPly(createGameReview(record), ply);
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

test('ply zero and a distinctive middle ply map to GameRecord.moves[selectedPly]', () => {
  const record = cycleRecord({ id: 'r3b-mapping' });
  const opening = reviewAt(record, 0);
  const openingEvidence = createGameReviewEvidence(
    opening,
    acceptedR3a(opening, record.moves[0]),
  );
  assert.deepEqual(openingEvidence.played.move, record.moves[0]);

  const middle = reviewAt(record, 3);
  const candidate = { from: { r: 5, c: 3 }, to: { r: 5, c: 4 } };
  const evidence = createGameReviewEvidence(middle, acceptedR3a(middle, candidate));
  assert.deepEqual(evidence.played.move, record.moves[3]);
  assert.notDeepEqual(evidence.played.move, record.moves[2]);
  assert.notDeepEqual(evidence.played.move, record.moves[4]);
  assert.equal(evidence.comparison.status, 'DIFFERENT');

  const brokenOffByOne = record.moves[middle.selectedPly - 1];
  assert.notDeepEqual(brokenOffByOne, evidence.played.move,
    'BROKEN_R3B_PLAYED_MOVE_OFF_BY_ONE_WOULD_FAIL');
  const source = readFileSync(new URL('./game-review-evidence.js', import.meta.url), 'utf8');
  assert.match(source, /review\.record\.moves\[selectedPly\]/);
  assert.doesNotMatch(source, /review\.record\.moves\[selectedPly\s*-\s*1\]/);
});

test('final and canonical terminal Review plies are ineligible', () => {
  const record = cycleRecord({ id: 'r3b-final' });
  const source = reviewAt(record, 7);
  const state = acceptedR3a(source, record.moves[7]);
  assert.equal(createGameReviewEvidence(reviewAt(record, record.moves.length), state), null);
  assert.equal(createGameReviewEvidence(createGameReview(mateRecord()), state), null);
});

test('played and candidate facts use only the canonical pre-move Review board', () => {
  const record = cycleRecord({ id: 'r3b-source' });
  const review = reviewAt(record, 3);
  const candidate = { from: { r: 5, c: 3 }, to: { r: 5, c: 4 } };
  const liveBoard = emptyBoard();
  liveBoard[0][4] = { type: 'K', side: RED };
  liveBoard[5][3] = { type: 'N', side: BLACK };
  liveBoard[9][4] = { type: 'K', side: BLACK };
  const liveHistory = [{ from: { r: 5, c: 3 }, to: { r: 3, c: 2 } }];
  const evidence = createGameReviewEvidence(
    review,
    acceptedR3a(review, candidate),
    { board: liveBoard, turn: BLACK, history: liveHistory },
  );
  assert.deepEqual(evidence.played.move, record.moves[3]);
  assert.notDeepEqual(evidence.played.move, liveHistory[0],
    'BROKEN_R3B_PLAYED_MOVE_FROM_LIVE_HISTORY_WOULD_FAIL');
  assert.deepEqual(evidence.candidate.movedPiece, { side: RED, type: 'R', name: '俥' });
  assert.equal(evidence.source.sideToMove, RED);
  assert.notEqual(evidence.source.sideToMove, BLACK,
    'BROKEN_R3B_LIVE_TURN_SOURCE_WOULD_FAIL');
  assert.notDeepEqual(review.snapshot.board, liveBoard,
    'BROKEN_R3B_LIVE_BOARD_SOURCE_WOULD_FAIL fixture');
  assert.equal(evidence.played.notation, '俥六退一');
  assert.equal(evidence.candidate.notation, '俥六平五');
});

test('strict R3A record, ply, revision, preset, board, side and repetition identity fail closed', () => {
  const record = cycleRecord({ id: 'r3b-identity' });
  const review = reviewAt(record, 3);
  const state = acceptedR3a(review, record.moves[3]);
  const mutations = [
    (copy) => { copy.request.recordId = 'other'; },
    (copy) => { copy.request.ply++; },
    (copy) => { copy.request.revision++; },
    (copy) => { copy.revision++; },
    (copy) => { copy.request.analysisPreset = 'medium'; },
    (copy) => { copy.request.sideToMove = BLACK; },
    (copy) => { copy.request.board[5][3] = null; },
    (copy) => { copy.request.repetitionPrefix[0].check = true; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(state);
    mutate(copy);
    assert.equal(createGameReviewEvidence(review, copy), null);
  }

  const nextReview = reviewAt(record, 4);
  assert.equal(createGameReviewEvidence(nextReview, state), null,
    'BROKEN_R3B_CANDIDATE_FROM_STALE_PLY_WOULD_FAIL');
});

test('malformed or illegal played and candidate moves fail closed after revalidation', () => {
  const record = cycleRecord({ id: 'r3b-malformed' });
  const review = reviewAt(record, 3);
  const state = acceptedR3a(review, record.moves[3]);

  const malformedRecord = structuredClone(review.record);
  malformedRecord.moves[3] = { from: { r: 99, c: 0 }, to: { r: 0, c: 0 } };
  assert.equal(createGameReviewEvidence({ ...review, record: malformedRecord }, state), null);

  const malformedCandidate = structuredClone(state);
  malformedCandidate.candidate.from.r = -1;
  assert.equal(createGameReviewEvidence(review, malformedCandidate), null);
  const illegalCandidate = structuredClone(state);
  illegalCandidate.candidate.to = { r: 9, c: 8 };
  assert.equal(createGameReviewEvidence(review, illegalCandidate), null);
});

test('capture, checkmate, material counts and terminal reply suppression are canonical', () => {
  const record = mateRecord();
  const review = reviewAt(record, 0);
  const evidence = createGameReviewEvidence(review, acceptedR3a(review, record.moves[0]));
  assert.equal(evidence.comparison.status, 'MATCH');
  assert.equal(evidence.comparison.sameMove, true);
  assert.equal(evidence.played, evidence.candidate, 'MATCH computes and reuses one outcome');
  assert.deepEqual(evidence.played.movedPiece, { side: RED, type: 'R', name: '俥' });
  assert.deepEqual(evidence.played.capture, { side: BLACK, type: 'P', name: '卒' });
  assert.deepEqual(evidence.candidate.capture, { side: BLACK, type: 'P', name: '卒' });
  assert.equal(evidence.played.givesCheck, true);
  assert.equal(evidence.candidate.givesCheck, true);
  assert.deepEqual(evidence.played.terminal, { winner: RED, terminationReason: 'checkmate' });
  assert.equal(evidence.played.legalReplyCount, null);
  assert.equal(evidence.played.movedPieceCaptureReplies, null);
  assert.equal(evidence.materialBefore.red.R, 3);
  assert.equal(evidence.materialBefore.black.P, 1);
  assert.equal(evidence.played.materialAfter.black.P, 0);
  assert.deepEqual(evidence.played.materialDeltaBySide, { red: {}, black: { P: -1 } });
});

test('stalemate is preserved with no post-terminal reply evidence', () => {
  const record = stalemateRecord();
  const review = reviewAt(record, 0);
  const evidence = createGameReviewEvidence(review, acceptedR3a(review, record.moves[0]));
  assert.equal(evidence.played.givesCheck, false);
  assert.deepEqual(evidence.played.terminal, { winner: RED, terminationReason: 'stalemate' });
  assert.equal(evidence.played.legalReplyCount, null);
  assert.equal(evidence.played.movedPieceCaptureReplies, null);
});

test('canonical historical prefix produces repetition draw and perpetual-check evidence', () => {
  for (const [record, reason, verdict] of [
    [cycleRecord({ id: 'r3b-repetition' }), 'threefold-repetition', { result: 'draw', reason: '三次重複局面' }],
    [cycleRecord({ id: 'r3b-perpetual', perpetual: true }), 'perpetual-check', { result: 'loss', loser: RED, reason: '長將' }],
  ]) {
    const review = reviewAt(record, 7);
    const evidence = createGameReviewEvidence(review, acceptedR3a(review, record.moves[7]));
    assert.equal(evidence.played.terminal.terminationReason, reason);
    assert.deepEqual(evidence.played.repetitionVerdict, verdict);
    assert.equal(evidence.played.legalReplyCount, null);

    const board = structuredClone(review.snapshot.board);
    applyMove(board, record.moves[7].from, record.moves[7].to);
    const nextSide = review.snapshot.sideToMove === RED ? BLACK : RED;
    const fresh = [{
      key: `${hashBoard(board)}|${nextSide}`,
      mover: review.snapshot.sideToMove,
      check: inCheck(board, nextSide),
    }];
    assert.equal(repetitionVerdict(fresh, fresh[0].key), null,
      'BROKEN_R3B_FRESH_REPETITION_HISTORY_WOULD_FAIL');
  }
});

test('nonterminal branches enumerate replies and only factual moved-piece captures', () => {
  const record = cycleRecord({ id: 'r3b-replies' });
  const review = reviewAt(record, 3);
  const candidate = { from: { r: 5, c: 3 }, to: { r: 3, c: 3 } };
  const evidence = createGameReviewEvidence(review, acceptedR3a(review, candidate));
  assert.equal(evidence.comparison.status, 'DIFFERENT');
  assert.equal(evidence.played.terminal, null);
  assert.equal(evidence.candidate.terminal, null);
  const candidateBoard = structuredClone(review.snapshot.board);
  applyMove(candidateBoard, candidate.from, candidate.to);
  let expectedReplyCount = 0;
  for (let r = 0; r < candidateBoard.length; r++) {
    for (let c = 0; c < candidateBoard[r].length; c++) {
      if (candidateBoard[r][c]?.side === BLACK) expectedReplyCount += legalMoves(candidateBoard, r, c).length;
    }
  }
  assert.equal(evidence.candidate.legalReplyCount, expectedReplyCount);
  assert.ok(expectedReplyCount > 0);
  assert.ok(evidence.candidate.movedPieceCaptureReplies.some((reply) => (
    reply.move.from.r === 4 && reply.move.from.c === 1
      && reply.move.to.r === 3 && reply.move.to.c === 3
  )));
  assert.ok(evidence.candidate.movedPieceCaptureReplies.every((reply) => (
    reply.move.to.r === candidate.to.r && reply.move.to.c === candidate.to.c
  )));
  assert.ok(evidence.candidate.movedPieceCaptureReplies.every((reply) => (
    Object.keys(reply).join(',') === 'move,notation'
  )));
});

test('self-check makes a geometric moved-piece capture pseudo-legal and excludes it from evidence', () => {
  const record = pseudoLegalCaptureRecord();
  const review = reviewAt(record, 3);
  const candidate = { from: { r: 5, c: 6 }, to: { r: 7, c: 5 } };
  const evidence = createGameReviewEvidence(review, acceptedR3a(review, candidate));
  assert.ok(evidence, 'current production accepts the canonical nonterminal branch');

  const postMoveBoard = structuredClone(review.snapshot.board);
  applyMove(postMoveBoard, candidate.from, candidate.to);
  const pinnedCapture = { from: { r: 7, c: 4 }, to: { r: 7, c: 5 } };
  const isPinnedCapture = (reply) => {
    const move = reply.move ?? reply;
    return move.from.r === pinnedCapture.from.r
      && move.from.c === pinnedCapture.from.c
      && move.to.r === pinnedCapture.to.r
      && move.to.c === pinnedCapture.to.c;
  };
  const geometricTargets = getMoves(postMoveBoard, pinnedCapture.from.r, pinnedCapture.from.c);
  assert.ok(geometricTargets.some((to) => (
    to.r === pinnedCapture.to.r && to.c === pinnedCapture.to.c
  )), 'the black rook geometrically reaches the just-moved knight');
  const canonicalTargets = legalMoves(postMoveBoard, pinnedCapture.from.r, pinnedCapture.from.c);
  assert.equal(canonicalTargets.some((to) => (
    to.r === pinnedCapture.to.r && to.c === pinnedCapture.to.c
  )), false, 'moving the pinned rook would expose the black general to check');

  let canonicalReplyCount = 0;
  for (let r = 0; r < postMoveBoard.length; r++) {
    for (let c = 0; c < postMoveBoard[r].length; c++) {
      if (postMoveBoard[r][c]?.side === BLACK) {
        canonicalReplyCount += legalMoves(postMoveBoard, r, c).length;
      }
    }
  }
  assert.equal(evidence.candidate.legalReplyCount, canonicalReplyCount);
  assert.equal(evidence.candidate.movedPieceCaptureReplies.some(isPinnedCapture), false,
    'canonical evidence excludes the self-check capture');

  const brokenPseudoLegalReplies = [];
  for (let r = 0; r < postMoveBoard.length; r++) {
    for (let c = 0; c < postMoveBoard[r].length; c++) {
      if (postMoveBoard[r][c]?.side !== BLACK) continue;
      for (const to of getMoves(postMoveBoard, r, c)) {
        if (to.r === candidate.to.r && to.c === candidate.to.c) {
          brokenPseudoLegalReplies.push({ move: { from: { r, c }, to } });
        }
      }
    }
  }
  assert.ok(brokenPseudoLegalReplies.some(isPinnedCapture),
    'isolated mutation using geometric moves incorrectly includes the pinned capture');
  let detected = null;
  try {
    assert.equal(brokenPseudoLegalReplies.some(isPinnedCapture), false,
      'BROKEN_R3B_COUNTS_PSEUDO_LEGAL_CAPTURE');
  } catch (error) {
    detected = error;
  }
  assert.equal(detected?.code, 'ERR_ASSERTION');
  assert.match(detected.message, /BROKEN_R3B_COUNTS_PSEUDO_LEGAL_CAPTURE/);
});

test('source objects remain unchanged and every returned object is deeply frozen', () => {
  const record = cycleRecord({ id: 'r3b-freeze' });
  const review = reviewAt(record, 3);
  const state = acceptedR3a(review, { from: { r: 5, c: 3 }, to: { r: 5, c: 4 } });
  const reviewBefore = structuredClone(review);
  const stateBefore = structuredClone(state);
  const evidence = createGameReviewEvidence(review, state);
  assert.deepEqual(review, reviewBefore);
  assert.deepEqual(state, stateBefore);
  assertDeepFrozen(evidence);
  assert.throws(() => { evidence.played.move.from.r = 9; }, TypeError);
});
