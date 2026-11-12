import { deepFreeze, GAME_TRANSFER_MAX_PLIES } from './contract.js?v=7ba133c431';

// Only the import controller supplies the frozen canonical Worker result.
// Private provenance prevents forged/mutated review objects from authorizing continuation.
const sources = new WeakMap(), reviews = new WeakMap();
let sequence = 0;
export function createImportedGameReview(validated) {
  if (!Object.isFrozen(validated?.document) || !Object.isFrozen(validated?.replay)
    || validated.replay.totalPlies !== validated.document.moves.length
    || validated.document.moves.length > GAME_TRANSFER_MAX_PLIES) throw new TypeError('Canonical Worker result required.');
  const source = Object.freeze({ id: `imported-${++sequence}` });
  sources.set(source, validated);
  return build(source, 0, 0);
}

function build(source, selectedPly, revision) {
  const { document, replay } = sources.get(source);
  // Bounded coordinate folding of already-validated moves, not a chess-rule replay.
  const board = structuredClone(document.initialPosition.board);
  let sideToMove = document.initialPosition.sideToMove;
  for (let i = 0; i < selectedPly; i++) {
    const { from, to } = document.moves[i];
    board[to.r][to.c] = board[from.r][from.c]; board[from.r][from.c] = null;
    sideToMove = sideToMove === 'red' ? 'black' : 'red';
  }
  const totalPlies = document.moves.length;
  const snapshot = deepFreeze({ board, sideToMove, selectedPly, totalPlies,
    moveMetadata: replay.moveMetadata, positionHashes: replay.positionHashes.slice(0, selectedPly + 1),
    repetitionHistory: replay.repetitionHistory.slice(0, selectedPly + 1),
    terminal: selectedPly === totalPlies ? replay.terminal : null });
  const review = Object.freeze({ sourceKind: 'imported', source, revision, document,
    selectedPly, totalPlies, snapshot, moves: replay.moveMetadata,
    currentMove: selectedPly === 0 ? null : replay.moveMetadata[selectedPly - 1],
    atFirst: selectedPly === 0, atLast: selectedPly === totalPlies });
  reviews.set(review, source);
  return review;
}

export function isImportedGameReview(review) { return !!review && reviews.has(review); }
export function selectImportedGameReviewPly(review, target) {
  if (!isImportedGameReview(review)) throw new TypeError('Unknown imported review.');
  const ply = ({ first: 0, previous: review.selectedPly - 1, next: review.selectedPly + 1, last: review.totalPlies })[target] ?? target;
  if (!Number.isInteger(ply)) throw new TypeError('Invalid review ply.');
  return build(reviews.get(review), Math.max(0, Math.min(review.totalPlies, ply)), review.revision + 1);
}
export function canContinueImportedGame(review) {
  return isImportedGameReview(review) && review.snapshot.terminal === null;
}
export function createImportedContinuationPosition(review) {
  if (!canContinueImportedGame(review)) throw new TypeError('Nonterminal imported review required.');
  // Reacquire from the private canonical source; never trust an external snapshot.
  const fresh = build(reviews.get(review), review.selectedPly, review.revision);
  return structuredClone({ board: fresh.snapshot.board, sideToMove: fresh.snapshot.sideToMove });
}
