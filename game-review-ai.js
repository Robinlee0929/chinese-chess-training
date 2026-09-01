import { RED, BLACK, legalMoves, notation } from './game.js?v=4dd3e2c2ca';

export const GAME_REVIEW_AI_PRESET = 'review-v1';
export const GAME_REVIEW_AI_ERROR_MESSAGE = '暫時無法完成電腦搜尋，請再試一次。';

const SIDES = new Set([RED, BLACK]);

export class GameReviewAiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameReviewAiError';
    this.code = code;
  }
}

export function createGameReviewAiState(revision = 0) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError('Review AI revision must be a nonnegative integer.');
  }
  return freezeState({ status: 'idle', revision, request: null, candidate: null, message: '' });
}

export function invalidateGameReviewAiState(state) {
  requireState(state);
  return createGameReviewAiState(state.revision + 1);
}

export function beginGameReviewAiRequest(state, review) {
  requireState(state);
  requireReview(review);
  if (review.snapshot.terminal) {
    throw new GameReviewAiError('TERMINAL_SOURCE', 'A terminal Review position cannot be analyzed.');
  }
  const revision = state.revision + 1;
  const request = freezeRequest({
    kind: 'review-candidate',
    recordId: review.record.id,
    ply: review.selectedPly,
    revision,
    board: cloneBoard(review.snapshot.board),
    sideToMove: review.snapshot.sideToMove,
    repetitionPrefix: review.snapshot.repetitionHistory.map(cloneRepetitionEntry),
    analysisPreset: GAME_REVIEW_AI_PRESET,
  });
  return Object.freeze({
    request,
    state: freezeState({ status: 'loading', revision, request, candidate: null, message: '電腦搜尋中…' }),
  });
}

export function isCurrentGameReviewAiResponse(state, review, response) {
  if (!isState(state) || state.status !== 'loading' || !state.request
    || !isReview(review) || review.snapshot.terminal || !response || typeof response !== 'object') return false;
  return response.kind === 'review-candidate'
    && response.recordId === state.request.recordId
    && response.recordId === review.record.id
    && response.ply === state.request.ply
    && response.ply === review.selectedPly
    && response.revision === state.revision;
}

export function settleGameReviewAiResponse(state, review, response) {
  if (!isCurrentGameReviewAiResponse(state, review, response)) {
    return Object.freeze({ accepted: false, state });
  }
  if (response.error || !response.result) {
    return Object.freeze({ accepted: true, state: errorState(state) });
  }
  try {
    const candidate = candidateFromResult(state.request, response.result);
    return Object.freeze({
      accepted: true,
      state: freezeState({
        status: 'success',
        revision: state.revision,
        request: state.request,
        candidate,
        message: '',
      }),
    });
  } catch {
    return Object.freeze({ accepted: true, state: errorState(state) });
  }
}

function candidateFromResult(request, result) {
  const from = requireCoordinate(result.from);
  const to = requireCoordinate(result.to);
  if (!Number.isInteger(result.depth) || result.depth < 1 || result.depth > 3) {
    throw new GameReviewAiError('INVALID_DEPTH', 'Review AI returned an invalid completed depth.');
  }
  const piece = request.board[from.r][from.c];
  const legal = piece?.side === request.sideToMove
    && legalMoves(request.board, from.r, from.c).some(({ r, c }) => r === to.r && c === to.c);
  if (!legal) throw new GameReviewAiError('ILLEGAL_CANDIDATE', 'Review AI returned an illegal candidate.');
  return Object.freeze({
    from: Object.freeze(from),
    to: Object.freeze(to),
    notation: notation(request.board, from, to),
    depth: result.depth,
  });
}

function errorState(state) {
  return freezeState({
    status: 'error',
    revision: state.revision,
    request: state.request,
    candidate: null,
    message: GAME_REVIEW_AI_ERROR_MESSAGE,
  });
}

function requireCoordinate(value) {
  if (!value || typeof value !== 'object'
    || !Number.isInteger(value.r) || !Number.isInteger(value.c)
    || value.r < 0 || value.r >= 10 || value.c < 0 || value.c >= 9) {
    throw new GameReviewAiError('INVALID_COORDINATE', 'Review AI returned an invalid coordinate.');
  }
  return { r: value.r, c: value.c };
}

function requireReview(review) {
  if (!isReview(review)) throw new TypeError('A valid Game Review session is required.');
}

function isReview(review) {
  return !!review && typeof review === 'object' && !!review.record && !!review.snapshot
    && typeof review.record.id === 'string' && Number.isInteger(review.selectedPly)
    && Array.isArray(review.snapshot.board) && SIDES.has(review.snapshot.sideToMove)
    && Array.isArray(review.snapshot.repetitionHistory);
}

function requireState(state) {
  if (!isState(state)) throw new TypeError('A valid Review AI state is required.');
}

function isState(state) {
  return !!state && typeof state === 'object' && Number.isInteger(state.revision)
    && state.revision >= 0 && ['idle', 'loading', 'success', 'error'].includes(state.status);
}

function cloneBoard(board) {
  return board.map((row) => row.map((piece) => (piece ? { type: piece.type, side: piece.side } : null)));
}

function cloneRepetitionEntry(entry) {
  return { key: entry.key, mover: entry.mover, check: entry.check };
}

function freezeBoard(board) {
  return Object.freeze(board.map((row) => Object.freeze(row.map((piece) => (
    piece ? Object.freeze({ type: piece.type, side: piece.side }) : null
  )))));
}

function freezeRequest(request) {
  return Object.freeze({
    kind: request.kind,
    recordId: request.recordId,
    ply: request.ply,
    revision: request.revision,
    board: freezeBoard(request.board),
    sideToMove: request.sideToMove,
    repetitionPrefix: Object.freeze(request.repetitionPrefix.map((entry) => Object.freeze({ ...entry }))),
    analysisPreset: request.analysisPreset,
  });
}

function freezeState(state) {
  return Object.freeze({
    status: state.status,
    revision: state.revision,
    request: state.request,
    candidate: state.candidate,
    message: state.message,
  });
}
