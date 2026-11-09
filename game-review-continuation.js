import { RED, BLACK } from './game.js?v=5c54c31039';
import { createGameTimeline } from './game-record.js?v=5c54c31039';

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export function defaultContinuationDifficulty(mode) {
  return DIFFICULTIES.has(mode) || mode === 'experimental-b' ? mode : 'medium';
}

// Runtime only. Persistent custom-position preferences must continue to call
// validateContinuationConfiguration, whose allowlist deliberately excludes B.
export function validateRuntimeContinuationConfiguration(configuration) {
  if (configuration.difficulty !== 'experimental-b') return validateContinuationConfiguration(configuration);
  defaultContinuationHumanSide(configuration.humanSide);
  return { difficulty: configuration.difficulty, humanSide: configuration.humanSide };
}

export function defaultContinuationHumanSide(sideToMove) {
  if (sideToMove !== RED && sideToMove !== BLACK) throw new TypeError('Invalid player side.');
  return sideToMove;
}

export function validateContinuationConfiguration({ difficulty, humanSide }) {
  if (!DIFFICULTIES.has(difficulty)) throw new TypeError('Invalid AI difficulty.');
  defaultContinuationHumanSide(humanSide);
  return { difficulty, humanSide };
}

export function createReviewContinuationPosition(review) {
  if (!review || review.sourceKind !== 'completed' || !review.snapshot
    || review.snapshot.terminal !== null) {
    throw new TypeError('A nonterminal completed review is required.');
  }
  // Reuse canonical board/side validation without inheriting any prefix history.
  const timeline = createGameTimeline({
    id: 'review-continuation-root',
    createdAt: '2026-01-01T00:00:00.000Z',
    initialPosition: {
      board: review.snapshot.board,
      sideToMove: review.snapshot.sideToMove,
    },
    moves: [],
    mode: 'medium',
  });
  return structuredClone(timeline.initialPosition);
}

export function canStartGameFromReview(review) {
  try {
    createReviewContinuationPosition(review);
    return true;
  } catch {
    return false;
  }
}
