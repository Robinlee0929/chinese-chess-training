import { ROWS, COLS, RED, BLACK } from './game.js?v=1db5e72ff0';
import { validatePuzzle } from './puzzle-domain.js?v=1db5e72ff0';

const SIDES = new Set([RED, BLACK]);
const PIECE_TYPES = new Set(['K', 'A', 'B', 'N', 'R', 'C', 'P']);

export class PuzzleEditorError extends Error {
  constructor(code, message, { path } = {}) {
    super(message);
    this.name = 'PuzzleEditorError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export function createEmptyEditorBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

export function createEditorState({ board = createEmptyEditorBoard(), sideToMove = RED } = {}) {
  validateEditorBoard(board);
  validateSide(sideToMove);
  return freezeState(board, sideToMove);
}

export function placeEditorPiece(state, piece, coordinate) {
  const current = checkedState(state);
  validatePiece(piece, 'piece');
  validateCoordinate(coordinate, 'coordinate');
  if (current.board[coordinate.r][coordinate.c] !== null) {
    fail('OCCUPIED_SQUARE', 'Cannot place a piece on an occupied square.', { path: 'coordinate' });
  }

  const board = cloneBoard(current.board);
  board[coordinate.r][coordinate.c] = clonePiece(piece);
  return freezeState(board, current.sideToMove);
}

export function moveEditorPiece(state, from, to) {
  const current = checkedState(state);
  validateCoordinate(from, 'from');
  validateCoordinate(to, 'to');
  const piece = current.board[from.r][from.c];
  if (piece === null) {
    fail('EMPTY_SOURCE', 'Cannot move a piece from an empty square.', { path: 'from' });
  }
  if (current.board[to.r][to.c] !== null) {
    fail('OCCUPIED_DESTINATION', 'Cannot move a piece to an occupied square.', { path: 'to' });
  }

  const board = cloneBoard(current.board);
  board[to.r][to.c] = clonePiece(piece);
  board[from.r][from.c] = null;
  return freezeState(board, current.sideToMove);
}

export function removeEditorPiece(state, coordinate) {
  const current = checkedState(state);
  validateCoordinate(coordinate, 'coordinate');
  if (current.board[coordinate.r][coordinate.c] === null) {
    fail('EMPTY_SQUARE', 'Cannot remove a piece from an empty square.', { path: 'coordinate' });
  }

  const board = cloneBoard(current.board);
  board[coordinate.r][coordinate.c] = null;
  return freezeState(board, current.sideToMove);
}

export function setEditorSideToMove(state, sideToMove) {
  const current = checkedState(state);
  validateSide(sideToMove);
  return freezeState(current.board, sideToMove);
}

export function validateAuthoredPosition(state) {
  const current = checkedState(state);
  return validatePuzzle({
    id: 'authored-position',
    title: 'Authored position',
    initialBoard: current.board,
    sideToMove: current.sideToMove,
    solution: [],
  });
}

export function exportAuthoredPosition(state) {
  const current = checkedState(state);
  return {
    initialBoard: cloneBoard(current.board),
    sideToMove: current.sideToMove,
  };
}

export function confirmAuthoredPosition(state) {
  const validation = validateAuthoredPosition(state);
  if (!validation.ok) return validation;
  return { ok: true, position: exportAuthoredPosition(state) };
}

function checkedState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    fail('INVALID_EDITOR_STATE', 'Editor state must be an object.', { path: 'state' });
  }
  validateEditorBoard(state.board);
  validateSide(state.sideToMove);
  return state;
}

function validateEditorBoard(board) {
  if (!Array.isArray(board) || board.length !== ROWS) {
    fail('INVALID_BOARD_ROWS', `Editor board must contain exactly ${ROWS} rows.`, { path: 'board' });
  }
  for (let r = 0; r < ROWS; r++) {
    if (!Array.isArray(board[r]) || board[r].length !== COLS) {
      fail('INVALID_BOARD_COLUMNS', `Editor board row ${r} must contain exactly ${COLS} columns.`, {
        path: `board[${r}]`,
      });
    }
    for (let c = 0; c < COLS; c++) {
      const piece = board[r][c];
      if (piece === null) continue;
      validatePiece(piece, `board[${r}][${c}]`);
    }
  }
}

function validatePiece(piece, path) {
  if (!piece || typeof piece !== 'object' || Array.isArray(piece)) {
    fail('INVALID_PIECE', 'Editor pieces must be objects.', { path });
  }
  if (!SIDES.has(piece.side)) {
    fail('INVALID_PIECE_SIDE', 'Editor piece side must be red or black.', { path: `${path}.side` });
  }
  if (!PIECE_TYPES.has(piece.type)) {
    fail('INVALID_PIECE_TYPE', 'Editor piece type is invalid.', { path: `${path}.type` });
  }
}

function validateSide(side) {
  if (!SIDES.has(side)) {
    fail('INVALID_SIDE_TO_MOVE', 'Editor sideToMove must be red or black.', { path: 'sideToMove' });
  }
}

function validateCoordinate(coordinate, path) {
  if (!coordinate || typeof coordinate !== 'object' || Array.isArray(coordinate)
    || !Number.isInteger(coordinate.r) || !Number.isInteger(coordinate.c)) {
    fail('INVALID_COORDINATE', 'Editor coordinates must contain integer r and c values.', { path });
  }
  if (coordinate.r < 0 || coordinate.r >= ROWS || coordinate.c < 0 || coordinate.c >= COLS) {
    fail('COORDINATE_OUT_OF_BOUNDS', 'Editor coordinate is outside the board.', { path });
  }
}

function clonePiece(piece) {
  return { ...piece };
}

function cloneBoard(board) {
  return board.map((row) => row.map((piece) => (piece === null ? null : clonePiece(piece))));
}

function freezeState(board, sideToMove) {
  const copy = cloneBoard(board);
  for (const row of copy) {
    for (const piece of row) if (piece) Object.freeze(piece);
    Object.freeze(row);
  }
  Object.freeze(copy);
  return Object.freeze({ board: copy, sideToMove });
}

function fail(code, message, details) {
  throw new PuzzleEditorError(code, message, details);
}
