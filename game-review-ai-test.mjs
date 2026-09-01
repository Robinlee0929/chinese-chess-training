import assert from 'node:assert/strict';
import test from 'node:test';
import { RED, BLACK, legalMoves, notation } from './game.js';
import { createGameRecord } from './game-record.js';
import { createGameReview, selectGameReviewPly } from './game-review.js';
import {
  GameReviewAiError,
  createGameReviewAiState,
  invalidateGameReviewAiState,
  beginGameReviewAiRequest,
  isCurrentGameReviewAiResponse,
  settleGameReviewAiResponse,
} from './game-review-ai.js';

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function completedRecord(id = 'review-ai-record-a') {
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
    createdAt: '2026-09-01T01:00:00.000Z',
    completedAt: '2026-09-01T01:01:00.000Z',
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
  });
}

function sourceReview(id = 'review-ai-record-a') {
  return selectGameReviewPly(createGameReview(completedRecord(id)), 0);
}

function firstLegalCandidate(request) {
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const piece = request.board[r][c];
      if (!piece || piece.side !== request.sideToMove) continue;
      const [to] = legalMoves(request.board, r, c);
      if (to) return { from: { r, c }, to: { r: to.r, c: to.c }, depth: 2, score: 314, pv: ['forbidden'] };
    }
  }
  throw new Error('Fixture has no legal move.');
}

test('captures the exact canonical Review source, side and repetition prefix with deep isolation', () => {
  const review = sourceReview();
  const liveBoard = emptyBoard();
  liveBoard[0][3] = { type: 'K', side: RED };
  liveBoard[9][5] = { type: 'K', side: BLACK };
  const liveTurn = BLACK;
  const started = beginGameReviewAiRequest(createGameReviewAiState(), review);
  const { request } = started;

  assert.equal(request.kind, 'review-candidate');
  assert.equal(request.recordId, review.record.id);
  assert.equal(request.ply, review.selectedPly);
  assert.equal(request.sideToMove, review.snapshot.sideToMove);
  assert.notEqual(request.sideToMove, liveTurn, 'historical side deliberately differs from live turn');
  assert.deepEqual(request.board, review.snapshot.board);
  assert.notDeepEqual(request.board, liveBoard, 'canonical Review board deliberately differs from live board');
  assert.deepEqual(request.repetitionPrefix, review.snapshot.repetitionHistory);
  assert.notEqual(request.board, review.snapshot.board);
  assert.notEqual(request.board[0], review.snapshot.board[0]);
  assert.notEqual(request.repetitionPrefix, review.snapshot.repetitionHistory);
  assert.notEqual(request.repetitionPrefix[0], review.snapshot.repetitionHistory[0]);
  assert.equal(request.analysisPreset, 'review-v1');
  assert.equal(Object.isFrozen(request.board[0][4]), true);
  assert.equal(Object.isFrozen(request.repetitionPrefix[0]), true);
});

test('accepts one legal current result, derives notation from the captured board, and discards score and PV', () => {
  const review = sourceReview();
  const started = beginGameReviewAiRequest(createGameReviewAiState(), review);
  const engineResult = firstLegalCandidate(started.request);
  const response = {
    kind: 'review-candidate',
    recordId: started.request.recordId,
    ply: started.request.ply,
    revision: started.request.revision,
    result: engineResult,
  };
  assert.equal(isCurrentGameReviewAiResponse(started.state, review, response), true);
  const settled = settleGameReviewAiResponse(started.state, review, response);

  assert.equal(settled.accepted, true);
  assert.equal(settled.state.status, 'success');
  assert.deepEqual(Object.keys(settled.state.candidate), ['from', 'to', 'notation', 'depth']);
  assert.equal(
    settled.state.candidate.notation,
    notation(started.request.board, engineResult.from, engineResult.to),
  );
  assert.equal(settled.state.candidate.depth, 2);
  assert.equal('score' in settled.state.candidate, false);
  assert.equal('pv' in settled.state.candidate, false);
});

test('rejects malformed, illegal, null and worker-error results as retryable errors', () => {
  const review = sourceReview();
  const cases = [
    { result: { from: { r: -1, c: 0 }, to: { r: 0, c: 0 }, depth: 2 } },
    { result: { from: { r: 0, c: 4 }, to: { r: 9, c: 4 }, depth: 2 } },
    { result: { ...firstLegalCandidate(beginGameReviewAiRequest(createGameReviewAiState(), review).request), depth: 0 } },
    { result: null },
    { error: 'worker failed' },
  ];
  for (const fields of cases) {
    const started = beginGameReviewAiRequest(createGameReviewAiState(), review);
    const settled = settleGameReviewAiResponse(started.state, review, {
      kind: 'review-candidate',
      recordId: started.request.recordId,
      ply: started.request.ply,
      revision: started.request.revision,
      ...fields,
    });
    assert.equal(settled.accepted, true);
    assert.equal(settled.state.status, 'error');
    assert.equal(settled.state.candidate, null);
    assert.match(settled.state.message, /請再試一次/);
  }
});

test('ignores stale record, ply and revision identities without overwriting loading state', () => {
  const review = sourceReview();
  const started = beginGameReviewAiRequest(createGameReviewAiState(), review);
  const base = {
    kind: 'review-candidate',
    recordId: started.request.recordId,
    ply: started.request.ply,
    revision: started.request.revision,
    result: firstLegalCandidate(started.request),
  };
  for (const response of [
    { ...base, recordId: 'review-ai-record-b' },
    { ...base, ply: base.ply + 1 },
    { ...base, revision: base.revision + 1 },
  ]) {
    const settled = settleGameReviewAiResponse(started.state, review, response);
    assert.equal(settled.accepted, false);
    assert.equal(settled.state, started.state);
  }

  const invalidated = invalidateGameReviewAiState(started.state);
  assert.equal(invalidated.status, 'idle');
  assert.equal(invalidated.revision, started.state.revision + 1);
  assert.equal(settleGameReviewAiResponse(invalidated, review, base).accepted, false);
});

test('rejects canonical terminal Review sources', () => {
  const terminal = createGameReview(completedRecord());
  assert.ok(terminal.snapshot.terminal);
  assert.throws(
    () => beginGameReviewAiRequest(createGameReviewAiState(), terminal),
    (error) => error instanceof GameReviewAiError && error.code === 'TERMINAL_SOURCE',
  );
});
