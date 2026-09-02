import { createEditorState } from './puzzle-editor.js?v=a53299d76a';

export class GameReviewPuzzleHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameReviewPuzzleHandoffError';
    this.code = code;
  }
}

export function createGameReviewPuzzleHandoff(review) {
  if (!review || typeof review !== 'object' || !review.record || !review.snapshot
    || !Number.isInteger(review.selectedPly)) {
    throw new GameReviewPuzzleHandoffError(
      'INVALID_GAME_REVIEW',
      'A canonical Game Review snapshot is required.',
    );
  }
  if (review.snapshot.terminal) {
    throw new GameReviewPuzzleHandoffError(
      'TERMINAL_REVIEW_POSITION',
      'A terminal Game Review position cannot start a mate puzzle.',
    );
  }

  return Object.freeze({
    sourceRecordId: review.record.id,
    sourcePly: review.selectedPly,
    editorState: createEditorState({
      board: review.snapshot.board,
      sideToMove: review.snapshot.sideToMove,
    }),
  });
}
