import { createGameRecord, replayGameRecord } from './game-record.js?v=a53299d76a';

export const GAME_REVIEW_INITIAL_PLY = 'last';

export function createGameRecordLibraryView(loadResult) {
  if (!loadResult || !Array.isArray(loadResult.records) || !Array.isArray(loadResult.issues)) {
    throw new TypeError('A GameRecord store load result is required.');
  }
  const records = loadResult.records.map((record) => createGameRecord(record));
  const issues = loadResult.issues.map((entry) => Object.freeze({
    code: String(entry.code),
    message: String(entry.message),
  }));
  const readFailed = issues.some((entry) => entry.code === 'STORE_READ_FAILED');
  const status = readFailed ? 'unavailable'
    : issues.length > 0 ? 'warning'
      : records.length > 0 ? 'ready' : 'empty';
  return Object.freeze({
    status,
    records: Object.freeze(records),
    issues: Object.freeze(issues),
  });
}

export function createGameReview(record, { selectedPly = GAME_REVIEW_INITIAL_PLY } = {}) {
  const canonicalRecord = createGameRecord(record);
  const initialPly = resolveInitialPly(selectedPly, canonicalRecord.moves.length);
  return buildReview(canonicalRecord, initialPly);
}

export function selectGameReviewPly(review, selectedPly) {
  requireReview(review);
  if (!Number.isInteger(selectedPly)) {
    throw new TypeError('Game review ply must be an integer.');
  }
  return buildReview(review.record, clamp(selectedPly, 0, review.totalPlies));
}

export function firstGameReviewPly(review) {
  return selectGameReviewPly(review, 0);
}

export function previousGameReviewPly(review) {
  return selectGameReviewPly(review, review.selectedPly - 1);
}

export function nextGameReviewPly(review) {
  return selectGameReviewPly(review, review.selectedPly + 1);
}

export function lastGameReviewPly(review) {
  requireReview(review);
  return selectGameReviewPly(review, review.totalPlies);
}

function resolveInitialPly(selectedPly, totalPlies) {
  if (selectedPly === 'last') return totalPlies;
  if (selectedPly === 'first') return 0;
  if (!Number.isInteger(selectedPly)) {
    throw new TypeError('Game review initial ply must be first, last, or an integer.');
  }
  return clamp(selectedPly, 0, totalPlies);
}

function buildReview(record, selectedPly) {
  const snapshot = replayGameRecord(record, selectedPly);
  const currentMove = selectedPly === 0 ? null : snapshot.moveMetadata[selectedPly - 1];
  return Object.freeze({
    record,
    selectedPly,
    totalPlies: snapshot.totalPlies,
    snapshot,
    moves: snapshot.moveMetadata,
    currentMove,
    atFirst: selectedPly === 0,
    atLast: selectedPly === snapshot.totalPlies,
  });
}

function requireReview(review) {
  if (!review || typeof review !== 'object' || !review.record
    || !Number.isInteger(review.selectedPly) || !Number.isInteger(review.totalPlies)) {
    throw new TypeError('A valid game review session is required.');
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
