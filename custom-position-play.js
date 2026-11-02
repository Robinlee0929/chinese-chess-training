import { RED, BLACK, name, kingPos, kingsFacing, inCheck, hasAnyLegalMove } from './game.js?v=533286807f';
import { createEditorState, PuzzleEditorError } from './puzzle-editor.js?v=533286807f';
import { validateContinuationConfiguration } from './game-review-continuation.js?v=533286807f';

const LIMITS = { K: 1, A: 2, B: 2, N: 2, R: 2, C: 2, P: 5 };
const invalid = (code, message) => ({ ok: false, error: { code, message } });

export class CustomGameRootError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CustomGameRootError';
    this.code = code;
  }
}

// Capture the confirmed starting position, never a live game's moving board.
// This factory does not start a game or persist provenance/settings.
export function createCustomGameRoot(position, configuration, {
  savedPositionId = null, sourceRecordId = null,
} = {}) {
  const validation = validateCustomPlayPosition(position);
  if (!validation.ok) throw new CustomGameRootError(validation.error.code, validation.error.message);
  let settings;
  try {
    settings = validateContinuationConfiguration(configuration);
  } catch {
    throw new CustomGameRootError('INVALID_CONFIGURATION', 'Invalid custom-game settings.');
  }
  for (const id of [savedPositionId, sourceRecordId]) {
    if (id !== null && (typeof id !== 'string' || !id || id.trim() !== id)) {
      throw new CustomGameRootError('INVALID_PROVENANCE_ID', 'Provenance IDs must be canonical strings or null.');
    }
  }
  const initialPosition = validation.position;
  for (const row of initialPosition.board) {
    for (const piece of row) if (piece) Object.freeze(piece);
    Object.freeze(row);
  }
  Object.freeze(initialPosition.board);
  return Object.freeze({
    initialPosition: Object.freeze(initialPosition),
    settings: Object.freeze(settings),
    savedPositionId,
    sourceRecordId,
  });
}

// Each consumer gets a fresh, validated, mutable board (including its pieces).
export function createMutableCustomGamePosition(root) {
  const validation = validateCustomPlayPosition({
    initialBoard: root?.initialPosition?.board,
    sideToMove: root?.initialPosition?.sideToMove,
  });
  if (!validation.ok) throw new CustomGameRootError(validation.error.code, validation.error.message);
  return validation.position;
}

// Separate from puzzle confirmation: authoring/recording keeps its existing rules.
// Movement, check and terminal detection always come from the game engine.
export function validateCustomPlayPosition(position) {
  let state;
  try {
    if (!position || !Array.isArray(position.initialBoard)) {
      return invalid('INVALID_BOARD', '棋盤必須是 10 列、每列 9 格。');
    }
    if (![RED, BLACK].includes(position.sideToMove)) {
      return invalid('INVALID_SIDE_TO_MOVE', '請指定輪到紅方或黑方行棋。');
    }
    state = createEditorState({ board: position.initialBoard, sideToMove: position.sideToMove });
  } catch (error) {
    if (!(error instanceof PuzzleEditorError)) throw error;
    const messages = {
      INVALID_BOARD_ROWS: '棋盤必須是 10 列、每列 9 格。',
      INVALID_BOARD_COLUMNS: '棋盤必須是 10 列、每列 9 格。',
      INVALID_PIECE: '棋盤格只能是空格或有效棋子。',
      INVALID_PIECE_SIDE: '棋子顏色必須是紅方或黑方。',
      INVALID_PIECE_TYPE: '棋盤包含無效的棋子種類。',
    };
    return invalid(error.code, messages[error.code] || '局面格式無效，請重新編輯。');
  }
  const { board, sideToMove } = state;
  for (const side of [RED, BLACK]) {
    const counts = Object.fromEntries(Object.keys(LIMITS).map(type => [type, 0]));
    for (const row of board) for (const piece of row) if (piece?.side === side) counts[piece.type]++;
    const label = side === RED ? '紅方' : '黑方';
    if (counts.K !== 1) return invalid('KING_COUNT', `${label}必須恰好有一枚${name(side, 'K')}。`);
    for (const [type, limit] of Object.entries(LIMITS)) {
      if (counts[type] > limit) return invalid('PIECE_LIMIT', `${label}的${name(side, type)}不可超過 ${limit} 枚。`);
    }
    const { r, c } = kingPos(board, side);
    if (c < 3 || c > 5 || (side === RED ? r > 2 : r < 7)) {
      return invalid('KING_OUTSIDE_PALACE', `${label}的${name(side, 'K')}必須位於己方九宮內。`);
    }
  }
  if (kingsFacing(board)) return invalid('KINGS_FACING', '將帥不可在同一直線上直接照面，請調整局面。');
  if (inCheck(board, sideToMove === RED ? BLACK : RED)) {
    return invalid('NON_MOVING_SIDE_IN_CHECK', '非輪走方已被將軍，請調整棋面或輪走方。');
  }
  if (!hasAnyLegalMove(board, sideToMove)) {
    return invalid('TERMINAL_POSITION', '目前輪走方已無合法著法（將死或困斃），無法開始對弈。');
  }
  // Canonical pieces only; no mutable rows, pieces or metadata from the editor.
  return { ok: true, position: {
    board: board.map(row => row.map(piece => piece ? { type: piece.type, side: piece.side } : null)),
    sideToMove,
  } };
}
