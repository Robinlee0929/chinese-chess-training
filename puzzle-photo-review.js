// Pure, memory-only human review. Machine output never becomes a board choice.
import { selectionKey } from './puzzle-photo-recognition.js?v=58273955d5';

export const UNREVIEWED = 'UNREVIEWED';
export const CONFIRMED_EMPTY = 'CONFIRMED_EMPTY';
export const CONFIRMED_PIECE = 'CONFIRMED_PIECE';
export const HIGH_CONFIDENCE_EMPTY_THRESHOLD = 0.70;
const states = new WeakSet();
const pieceTypes = new Set(['K', 'A', 'B', 'N', 'R', 'C', 'P']);

export class PuzzlePhotoReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PuzzlePhotoReviewError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) { throw new PuzzlePhotoReviewError(code, message, details); }
function requireState(state) {
  if (!states.has(state)) fail('INVALID_REVIEW', 'Expected a review state created by this module.');
}
function requireKey(state, key) {
  requireState(state);
  if (!Object.hasOwn(state.entries, key)) fail('INVALID_COORDINATE', 'Unknown review coordinate.');
}
function freeze(state) {
  for (const entry of Object.values(state.entries)) {
    if (entry.piece) Object.freeze(entry.piece);
    Object.freeze(entry);
  }
  state.candidates.forEach(Object.freeze);
  Object.freeze(state.candidates);
  Object.freeze(state.entries);
  states.add(state);
  return Object.freeze(state);
}
function copy(state) {
  requireState(state);
  return {
    candidates: state.candidates.map((candidate) => ({ ...candidate })),
    entries: Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, {
      ...entry, piece: entry.piece ? { ...entry.piece } : null,
    }])),
    currentKey: state.currentKey,
  };
}
function freshEntry() { return { status: UNREVIEWED, piece: null, source: null, flagged: false }; }
export function isHighConfidenceEmpty(candidate) {
  return candidate.occupancy === 'empty'
    && candidate.occupancyConfidence >= HIGH_CONFIDENCE_EMPTY_THRESHOLD;
}

export function createReviewState(candidates) {
  if (!Array.isArray(candidates) || candidates.length !== 90) {
    fail('INVALID_CANDIDATES', 'Review requires exactly 90 candidates.');
  }
  const entries = {};
  const displayCoordinates = new Set();
  const isolated = candidates.map((candidate) => {
    const key = selectionKey(candidate?.r, candidate?.c);
    if (Object.hasOwn(entries, key)) fail('DUPLICATE_CANDIDATE', 'Review coordinates must be unique.');
    if (!['empty', 'occupied', 'uncertain'].includes(candidate.occupancy)
      || !['red', 'black', 'unknown'].includes(candidate.suggestedSide)
      || ![candidate.occupancyConfidence, candidate.sideConfidence].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      )) fail('INVALID_CANDIDATE', 'Malformed review candidate.');
    const displayRow = candidate.displayRow ?? 9 - candidate.r;
    const displayCol = candidate.displayCol ?? candidate.c;
    if (!Number.isInteger(displayRow) || displayRow < 0 || displayRow > 9
      || !Number.isInteger(displayCol) || displayCol < 0 || displayCol > 8
      || displayCoordinates.has(`${displayRow},${displayCol}`)) {
      fail('INVALID_DISPLAY_GRID', 'Display coordinates must form a unique 10 by 9 grid.');
    }
    displayCoordinates.add(`${displayRow},${displayCol}`);
    entries[key] = freshEntry();
    // Copy only the candidate contract, not arbitrary machine suggestion objects.
    return {
      r: candidate.r, c: candidate.c,
      displayRow, displayCol,
      occupancy: candidate.occupancy, occupancyConfidence: candidate.occupancyConfidence,
      suggestedSide: candidate.suggestedSide, sideConfidence: candidate.sideConfidence,
    };
  });
  isolated.sort((a, b) => a.displayRow - b.displayRow || a.displayCol - b.displayCol || a.r - b.r || a.c - b.c);
  const first = isolated.find((candidate) => !isHighConfidenceEmpty(candidate));
  return freeze({ candidates: isolated, entries, currentKey: first ? selectionKey(first.r, first.c) : null });
}

export function buildReviewQueue(state, { unresolvedOnly = false } = {}) {
  requireState(state);
  return state.candidates.filter((candidate) => {
    const entry = state.entries[selectionKey(candidate.r, candidate.c)];
    return (!isHighConfidenceEmpty(candidate) || entry.flagged)
      && (!unresolvedOnly || entry.status === UNREVIEWED);
  }).map((candidate) => selectionKey(candidate.r, candidate.c));
}

export function nextUnresolved(state, fromKey = state.currentKey) {
  const queue = buildReviewQueue(state);
  const start = queue.indexOf(fromKey);
  for (let step = 1; step <= queue.length; step++) {
    const key = queue[(start + step) % queue.length];
    if (state.entries[key].status === UNREVIEWED) return key;
  }
  return null;
}
function adjacentCandidate(state, direction) {
  const queue = buildReviewQueue(state);
  if (!queue.length) return null;
  const index = queue.indexOf(state.currentKey);
  if (index < 0) return direction > 0 ? queue[0] : queue.at(-1);
  return queue[(index + direction + queue.length) % queue.length];
}
export function nextCandidate(state) { return adjacentCandidate(state, 1); }
export function previousCandidate(state) { return adjacentCandidate(state, -1); }

// Directly selecting an excluded point flags it for explicit review, too.
export function selectReviewCandidate(state, key) {
  requireKey(state, key);
  const next = copy(state);
  next.currentKey = key;
  next.entries[key].flagged = true;
  return freeze(next);
}
function confirm(state, key, piece) {
  requireKey(state, key);
  const next = copy(state);
  next.entries[key] = {
    status: piece ? CONFIRMED_PIECE : CONFIRMED_EMPTY,
    piece: piece ? { type: piece.type, side: piece.side } : null,
    source: 'manual', flagged: true,
  };
  const confirmed = freeze(next);
  return freeze({ ...copy(confirmed), currentKey: nextUnresolved(confirmed, key) ?? key });
}
export function confirmEmpty(state, key = state.currentKey) { return confirm(state, key, null); }
export function confirmPiece(state, key, piece) {
  if (!piece || !pieceTypes.has(piece.type) || !['red', 'black'].includes(piece.side)) {
    fail('INVALID_PIECE', 'Choose an exact red or black piece.');
  }
  return confirm(state, key, piece);
}
export function eligibleEmptyKeys(state) {
  requireState(state);
  return state.candidates.filter((candidate) => isHighConfidenceEmpty(candidate)
    && state.entries[selectionKey(candidate.r, candidate.c)].status === UNREVIEWED)
    .map((candidate) => selectionKey(candidate.r, candidate.c));
}
export function acceptHighConfidenceEmpty(state) {
  const eligible = eligibleEmptyKeys(state);
  const next = copy(state);
  for (const key of eligible) next.entries[key] = {
    ...next.entries[key], status: CONFIRMED_EMPTY, piece: null, source: 'bulk',
  };
  const accepted = freeze(next);
  const keepCurrent = accepted.currentKey && accepted.entries[accepted.currentKey].status === UNREVIEWED;
  return freeze({ ...copy(accepted), currentKey: keepCurrent ? accepted.currentKey : nextUnresolved(accepted) ?? accepted.currentKey });
}
export function undoBulkEmpty(state) {
  const next = copy(state);
  for (const entry of Object.values(next.entries)) {
    if (entry.source === 'bulk') Object.assign(entry, { status: UNREVIEWED, source: null, piece: null });
  }
  return freeze(next);
}
export function resetReview(state) { requireState(state); return createReviewState(state.candidates); }

// Same calibrated grid only. A rescan refreshes evidence, never human decisions.
export function rescanReview(state, candidates) {
  requireState(state);
  const next = copy(createReviewState(candidates));
  for (const [key, entry] of Object.entries(state.entries)) {
    next.entries[key] = { ...entry, piece: entry.piece ? { ...entry.piece } : null };
  }
  next.currentKey = state.currentKey;
  const rescanned = freeze(next);
  return freeze({ ...copy(rescanned), currentKey: rescanned.currentKey ?? nextUnresolved(rescanned) });
}
export function unresolvedCount(state) {
  requireState(state);
  return Object.values(state.entries).filter((entry) => entry.status === UNREVIEWED).length;
}
export function reviewProgress(state) {
  const queue = buildReviewQueue(state);
  const entries = Object.values(state.entries);
  const unresolved = unresolvedCount(state);
  const remaining = queue.filter((key) => state.entries[key].status === UNREVIEWED).length;
  return {
    total: 90, queueSize: queue.length, confirmed: queue.length - remaining, remaining,
    unresolved, eligibleEmpty: eligibleEmptyKeys(state).length,
    occupied: state.candidates.filter((candidate) => candidate.occupancy === 'occupied').length,
    uncertain: state.candidates.filter((candidate) => candidate.occupancy === 'uncertain').length,
    bulkEmpty: entries.filter((entry) => entry.source === 'bulk').length,
    manualPieces: entries.filter((entry) => entry.status === CONFIRMED_PIECE).length,
    redKings: entries.filter((entry) => entry.piece?.type === 'K' && entry.piece.side === 'red').length,
    blackKings: entries.filter((entry) => entry.piece?.type === 'K' && entry.piece.side === 'black').length,
    canApply: unresolved === 0,
  };
}
export function confirmedSelections(state) {
  requireState(state);
  return Object.fromEntries(Object.entries(state.entries)
    .filter(([, entry]) => entry.status !== UNREVIEWED)
    .map(([key, entry]) => [key, entry.piece ? { ...entry.piece } : null]));
}
export function buildReviewedBoard(state) {
  const remaining = unresolvedCount(state);
  if (remaining) fail('UNRESOLVED_REVIEW', `尚有 ${remaining} 個位置未確認。`, { remaining });
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const candidate of state.candidates) {
    const entry = state.entries[selectionKey(candidate.r, candidate.c)];
    if (entry.status === CONFIRMED_PIECE) board[candidate.r][candidate.c] = { ...entry.piece };
  }
  return board;
}
