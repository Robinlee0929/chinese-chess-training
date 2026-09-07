import { RED, hashBoard } from './game.js?v=e6fa54af94';
import { createGameTimeline, replayGameTimeline } from './game-record.js?v=e6fa54af94';
import { createLiveGameReview } from './game-review.js?v=e6fa54af94';
import { createGameAnalysisFromPosition } from './game-analysis.js?v=e6fa54af94';

export const GAME_LIVE_REVIEW_HANDOFF_KIND = 'live-teaching-review-handoff';
export const GAME_LIVE_REVIEW_HANDOFF_VERSION = 1;

const HANDOFF_FIELDS = Object.freeze([
  'kind', 'version', 'recordId', 'anchorPly', 'movePly', 'positionKey',
  'teachingRevision', 'historyIdentity', 'timeline', 'r3aState', 'evidence', 'message',
]);
const COMPUTER_GAME_MODES = new Set(['easy', 'medium', 'hard']);

export class GameLiveReviewHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameLiveReviewHandoffError';
    this.code = code;
  }
}

export function createGameLiveReviewHandoff({ teachingState, session, history }) {
  if (!teachingState?.enabled || teachingState.status !== 'ready' || !teachingState.message) {
    return null;
  }
  const source = validateCurrentAuthority(teachingState, session, history);
  const timeline = createGameTimeline({
    id: session.id,
    createdAt: session.createdAt,
    initialPosition: session.initialPosition,
    moves: history.slice(0, source.movePly).map(canonicalMove),
    mode: session.mode,
  });
  const anchor = replayGameTimeline(timeline, source.ply);
  validateAnchor(source, anchor);
  validateAcceptedArtifacts(teachingState, source, anchor);
  const historyIdentity = createHistoryIdentity(timeline.moves, source.movePly);
  return deepFreeze({
    kind: GAME_LIVE_REVIEW_HANDOFF_KIND,
    version: GAME_LIVE_REVIEW_HANDOFF_VERSION,
    recordId: source.recordId,
    anchorPly: source.ply,
    movePly: source.movePly,
    positionKey: anchor.repetitionHistory.at(-1).key,
    teachingRevision: teachingState.revision,
    historyIdentity,
    timeline: structuredClone(timeline),
    r3aState: structuredClone(teachingState.r3aState),
    evidence: structuredClone(teachingState.evidence),
    message: structuredClone(teachingState.message),
  });
}

export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {
  try {
    validateHandoffShape(handoff);
    const source = validateCurrentAuthority(teachingState, session, history);
    if (handoff.recordId !== source.recordId
      || handoff.anchorPly !== source.ply
      || handoff.movePly !== source.movePly
      || handoff.movePly !== handoff.anchorPly + 1
      || handoff.teachingRevision !== teachingState.revision) {
      fail('STALE_AUTHORITY', 'The live Teaching authority changed before Review opened.');
    }
    // One appended black computer reply is allowed; a later red human move is not.
    if (history.length < handoff.movePly || history.length > handoff.movePly + 1) {
      fail('STALE_HISTORY', 'The live move history is no longer at the taught turn.');
    }
    if (createHistoryIdentity(history, handoff.movePly) !== handoff.historyIdentity) {
      fail('HISTORY_IDENTITY_MISMATCH', 'The taught move history identity changed.');
    }
    const timeline = createGameTimeline(handoff.timeline);
    if (timeline.id !== session.id || timeline.mode !== session.mode
      || timeline.createdAt !== session.createdAt
      || !sameValue(timeline.initialPosition, session.initialPosition)
      || timeline.moves.length !== handoff.movePly
      || createHistoryIdentity(timeline.moves, handoff.movePly) !== handoff.historyIdentity) {
      fail('TIMELINE_IDENTITY_MISMATCH', 'The immutable live timeline identity is inconsistent.');
    }
    const anchor = replayGameTimeline(timeline, handoff.anchorPly);
    validateAnchor(source, anchor);
    if (handoff.positionKey !== anchor.repetitionHistory.at(-1).key) {
      fail('POSITION_KEY_MISMATCH', 'The Review anchor position key changed.');
    }
    validateAcceptedArtifacts({
      ...teachingState,
      r3aState: handoff.r3aState,
      evidence: handoff.evidence,
      message: handoff.message,
    }, source, anchor);
    if (!sameValue(teachingState.r3aState, handoff.r3aState)
      || !sameValue(teachingState.evidence, handoff.evidence)
      || !sameValue(teachingState.message, handoff.message)) {
      fail('ACCEPTED_RESULT_MISMATCH', 'The accepted Teaching results changed.');
    }
    const teachingTarget = {
      recordId: handoff.recordId,
      anchorPly: handoff.anchorPly,
      movePly: handoff.movePly,
      positionKey: handoff.positionKey,
      teachingRevision: handoff.teachingRevision,
      ruleId: handoff.message.ruleId,
      move: canonicalMove(timeline.moves[handoff.movePly - 1]),
    };
    const review = createLiveGameReview(timeline, {
      anchorPly: handoff.anchorPly,
      movePly: handoff.movePly,
      teachingTarget,
    });
    return deepFreeze({
      accepted: true,
      review,
      r3aState: structuredClone(handoff.r3aState),
      evidence: structuredClone(handoff.evidence),
      message: structuredClone(handoff.message),
    });
  } catch (error) {
    if (!(error instanceof GameLiveReviewHandoffError)) {
      return Object.freeze({ accepted: false, error: Object.freeze({
        code: 'INVALID_HANDOFF', message: 'The live Review handoff is invalid.',
      }) });
    }
    return Object.freeze({ accepted: false, error: Object.freeze({
      code: error.code, message: error.message,
    }) });
  }
}

export function createGameLiveReviewAnalysis(review) {
  if (!review || review.sourceKind !== 'live-teaching' || !review.record || !review.snapshot
    || !Number.isInteger(review.selectedPly) || review.snapshot.terminal) {
    fail('INVALID_LIVE_REVIEW', 'A nonterminal live Teaching Review snapshot is required.');
  }
  return createGameAnalysisFromPosition({
    sourceRecordId: review.record.id,
    sourcePly: review.selectedPly,
    board: review.snapshot.board,
    sideToMove: review.snapshot.sideToMove,
    repetitionHistory: review.snapshot.repetitionHistory,
  });
}

function validateCurrentAuthority(teachingState, session, history) {
  if (!teachingState || typeof teachingState !== 'object' || teachingState.enabled !== true
    || teachingState.status !== 'ready' || !Number.isInteger(teachingState.revision)
    || teachingState.revision < 0 || !teachingState.active || !teachingState.r3aState
    || !teachingState.evidence || !teachingState.message) {
    fail('NO_TEACHING_AUTHORITY', 'A ready Teaching state with a selected message is required.');
  }
  if (!session || typeof session !== 'object' || typeof session.id !== 'string'
    || typeof session.createdAt !== 'string' || !session.initialPosition
    || !COMPUTER_GAME_MODES.has(session.mode) || !Array.isArray(history)) {
    fail('INVALID_LIVE_SESSION', 'A current computer-game session is required.');
  }
  const source = teachingState.active;
  if (source.recordId !== session.id || source.sideToMove !== RED
    || !Number.isInteger(source.ply) || source.ply < 0
    || source.movePly !== source.ply + 1 || history.length < source.movePly
    || !sameMove(history[source.movePly - 1], source.playedMove)) {
    fail('SOURCE_IDENTITY_MISMATCH', 'Teaching does not identify the current committed human move.');
  }
  return source;
}

function validateAnchor(source, anchor) {
  const expectedKey = `${hashBoard(anchor.board)}|${anchor.sideToMove}`;
  if (anchor.selectedPly !== source.ply || anchor.sideToMove !== source.sideToMove
    || !sameValue(anchor.board, source.board)
    || !sameValue(anchor.repetitionHistory, source.repetitionHistory)
    || anchor.repetitionHistory.at(-1)?.key !== expectedKey) {
    fail('ANCHOR_IDENTITY_MISMATCH', 'The pre-move Review anchor cannot be reconstructed exactly.');
  }
}

function validateAcceptedArtifacts(state, source, anchor) {
  const r3a = state.r3aState;
  const evidence = state.evidence;
  const message = state.message;
  const positionKey = anchor.repetitionHistory.at(-1).key;
  if (r3a?.status !== 'success' || !r3a.request || !r3a.candidate
    || r3a.request.kind !== 'review-candidate'
    || r3a.request.recordId !== source.recordId || r3a.request.ply !== source.ply
    || r3a.request.revision !== r3a.revision || r3a.revision !== state.revision
    || r3a.request.analysisPreset !== 'review-v1'
    || r3a.request.sideToMove !== anchor.sideToMove
    || !sameValue(r3a.request.board, anchor.board)
    || !sameValue(r3a.request.repetitionPrefix, anchor.repetitionHistory)) {
    fail('R3A_IDENTITY_MISMATCH', 'The accepted R3A result does not match the Review anchor.');
  }
  if (evidence?.kind !== 'review-move-comparison' || evidence.evidenceType !== 'CANONICAL_FACT'
    || evidence.source?.recordId !== source.recordId || evidence.source?.ply !== source.ply
    || evidence.source?.sideToMove !== source.sideToMove
    || evidence.source?.positionKey !== positionKey
    || evidence.source?.r3aRevision !== state.revision) {
    fail('R3B_IDENTITY_MISMATCH', 'The accepted R3B evidence does not match the Review anchor.');
  }
  if (message?.kind !== 'review-teaching-message' || message.version !== 1
    || typeof message.ruleId !== 'string' || message.ruleId.length === 0
    || message.source?.recordId !== source.recordId || message.source?.ply !== source.ply
    || message.source?.positionKey !== positionKey
    || message.source?.r3aRevision !== state.revision) {
    fail('R3C1_IDENTITY_MISMATCH', 'The selected R3C1 message does not match the Review anchor.');
  }
}

function validateHandoffShape(handoff) {
  if (!handoff || typeof handoff !== 'object'
    || !hasExactFields(handoff, HANDOFF_FIELDS)
    || handoff.kind !== GAME_LIVE_REVIEW_HANDOFF_KIND
    || handoff.version !== GAME_LIVE_REVIEW_HANDOFF_VERSION
    || typeof handoff.recordId !== 'string' || handoff.recordId.length === 0
    || !Number.isInteger(handoff.anchorPly) || handoff.anchorPly < 0
    || handoff.movePly !== handoff.anchorPly + 1
    || typeof handoff.positionKey !== 'string' || handoff.positionKey.length === 0
    || !Number.isInteger(handoff.teachingRevision) || handoff.teachingRevision < 0
    || typeof handoff.historyIdentity !== 'string' || handoff.historyIdentity.length === 0) {
    fail('INVALID_HANDOFF', 'The live Review handoff contract is invalid.');
  }
}

function createHistoryIdentity(moves, count) {
  if (!Array.isArray(moves) || moves.length < count) {
    fail('INVALID_HISTORY', 'The live history is shorter than its taught move identity.');
  }
  return moves.slice(0, count).map((move, index) => {
    const value = canonicalMove(move);
    return `${index + 1}:${value.from.r},${value.from.c}>${value.to.r},${value.to.c}`;
  }).join('|');
}

function canonicalMove(move) {
  if (!move || !Number.isInteger(move.from?.r) || !Number.isInteger(move.from?.c)
    || !Number.isInteger(move.to?.r) || !Number.isInteger(move.to?.c)) {
    fail('INVALID_MOVE', 'A canonical live move is required.');
  }
  return {
    from: { r: move.from.r, c: move.from.c },
    to: { r: move.to.r, c: move.to.c },
  };
}

function sameMove(left, right) {
  return !!left && !!right
    && left.from?.r === right.from?.r && left.from?.c === right.from?.c
    && left.to?.r === right.to?.r && left.to?.c === right.to?.c;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code, message) {
  throw new GameLiveReviewHandoffError(code, message);
}
