import {
  createGameReviewAiState,
  beginGameReviewAiRequest,
  settleGameReviewAiResponse,
} from './game-review-ai.js?v=a0cadeb326';
import { createGameMoveEvidence } from './game-review-evidence.js?v=a0cadeb326';
import { deriveGameReviewTeaching } from './game-review-teaching.js?v=a0cadeb326';

export function createGameTeachingModeState(revision = 0) {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError('Teaching Mode revision must be a nonnegative integer.');
  }
  return freezeState({
    enabled: false,
    revision,
    status: 'idle',
    active: null,
    r3aState: null,
    evidence: null,
    message: null,
  });
}

export function setGameTeachingModeEnabled(state, enabled) {
  requireState(state);
  if (typeof enabled !== 'boolean') throw new TypeError('Teaching Mode enabled must be boolean.');
  if (state.enabled === enabled) return state;
  return emptyState(enabled, state.revision + 1);
}

export function invalidateGameTeachingMode(state) {
  requireState(state);
  return emptyState(state.enabled, state.revision + 1);
}

export function beginGameTeachingModeAnalysis(state, source) {
  requireState(state);
  if (!state.enabled) return Object.freeze({ scheduled: false, state, request: null });
  const active = freezeSource(source);
  const review = reviewFromSource(active);
  const started = beginGameReviewAiRequest(createGameReviewAiState(state.revision), review);
  return Object.freeze({
    scheduled: true,
    request: started.request,
    state: freezeState({
      enabled: true,
      revision: started.state.revision,
      status: 'loading',
      active,
      r3aState: started.state,
      evidence: null,
      message: null,
    }),
  });
}

export function settleGameTeachingModeAnalysis(state, response) {
  requireState(state);
  if (!state.enabled || state.status !== 'loading' || !state.active || !state.r3aState) {
    return Object.freeze({ accepted: false, state });
  }
  const settled = settleGameReviewAiResponse(
    state.r3aState,
    reviewFromSource(state.active),
    response,
  );
  if (!settled.accepted) return Object.freeze({ accepted: false, state });
  if (settled.state.status !== 'success') {
    return Object.freeze({ accepted: true, state: emptyState(true, state.revision) });
  }
  try {
    const evidence = createGameMoveEvidence(state.active, settled.state);
    const [message] = deriveGameReviewTeaching(evidence);
    return Object.freeze({
      accepted: true,
      state: freezeState({
        enabled: true,
        revision: state.revision,
        status: 'ready',
        active: state.active,
        r3aState: settled.state,
        evidence,
        message: message ?? null,
      }),
    });
  } catch {
    return Object.freeze({ accepted: true, state: emptyState(true, state.revision) });
  }
}

export function gameTeachingModeMatchesHistory(state, sessionId, moves) {
  if (!isState(state) || !state.enabled || !state.active
    || typeof sessionId !== 'string' || state.active.recordId !== sessionId
    || !Array.isArray(moves) || moves.length < state.active.movePly) return false;
  return sameMove(moves[state.active.movePly - 1], state.active.playedMove);
}

export function shouldScheduleGameTeachingMode({
  enabled,
  normalGame,
  computerGame,
  moverSide,
  computerSide,
}) {
  return enabled === true && normalGame === true && computerGame === true
    && typeof moverSide === 'string' && typeof computerSide === 'string'
    && moverSide !== computerSide;
}

function reviewFromSource(source) {
  return Object.freeze({
    record: Object.freeze({ id: source.recordId }),
    selectedPly: source.ply,
    snapshot: Object.freeze({
      board: source.board,
      sideToMove: source.sideToMove,
      repetitionHistory: source.repetitionHistory,
      terminal: null,
    }),
  });
}

function freezeSource(source) {
  if (!source || typeof source !== 'object'
    || typeof source.recordId !== 'string' || source.recordId.length === 0
    || !Number.isInteger(source.movePly) || source.movePly < 1
    || source.ply !== source.movePly - 1 || !source.playedMove
    || !Array.isArray(source.board) || !Array.isArray(source.repetitionHistory)
    || source.repetitionHistory.length === 0) {
    throw new TypeError('A valid committed human move source is required.');
  }
  return deepFreeze({
    recordId: source.recordId,
    movePly: source.movePly,
    ply: source.ply,
    board: structuredClone(source.board),
    sideToMove: source.sideToMove,
    repetitionHistory: structuredClone(source.repetitionHistory),
    playedMove: structuredClone(source.playedMove),
  });
}

function sameMove(left, right) {
  return !!left && !!right
    && left.from?.r === right.from?.r && left.from?.c === right.from?.c
    && left.to?.r === right.to?.r && left.to?.c === right.to?.c;
}

function emptyState(enabled, revision) {
  return freezeState({
    enabled,
    revision,
    status: 'idle',
    active: null,
    r3aState: null,
    evidence: null,
    message: null,
  });
}

function requireState(state) {
  if (!isState(state)) throw new TypeError('A valid Teaching Mode state is required.');
}

function isState(state) {
  return !!state && typeof state === 'object' && typeof state.enabled === 'boolean'
    && Number.isInteger(state.revision) && state.revision >= 0
    && ['idle', 'loading', 'ready'].includes(state.status);
}

function freezeState(state) {
  return Object.freeze({ ...state });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
