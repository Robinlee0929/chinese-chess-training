import {
  ROWS,
  COLS,
  RED,
  BLACK,
  legalMoves,
  applyMove,
  inCheck,
  hasAnyLegalMove,
} from './game.js?v=d78bb3ba26';

const SIDES = new Set([RED, BLACK]);
const PIECE_TYPES = new Set(['K', 'A', 'B', 'N', 'R', 'C', 'P']);
const PUZZLE_DATA = new WeakMap();
const CONSTRUCTION_TOKEN = Symbol('Puzzle construction token');

export class PuzzleValidationError extends Error {
  constructor(code, message, { path, ply } = {}) {
    super(message);
    this.name = 'PuzzleValidationError';
    this.code = code;
    if (path !== undefined) this.path = path;
    if (ply !== undefined) this.ply = ply;
  }
}

export class Puzzle {
  constructor(data, token) {
    if (token !== CONSTRUCTION_TOKEN) {
      throw new TypeError('Use createPuzzle() to construct a puzzle.');
    }
    PUZZLE_DATA.set(this, clonePuzzleData(data));
    Object.freeze(this);
  }

  get id() {
    return PUZZLE_DATA.get(this).id;
  }

  get title() {
    return PUZZLE_DATA.get(this).title;
  }

  get initialBoard() {
    return cloneBoard(PUZZLE_DATA.get(this).initialBoard);
  }

  get sideToMove() {
    return PUZZLE_DATA.get(this).sideToMove;
  }

  get solution() {
    return cloneSolution(PUZZLE_DATA.get(this).solution);
  }

  get tags() {
    const tags = PUZZLE_DATA.get(this).tags;
    return tags === undefined ? undefined : tags.slice();
  }

  get notes() {
    return PUZZLE_DATA.get(this).notes;
  }

  toJSON() {
    return clonePuzzleData(PUZZLE_DATA.get(this));
  }
}

export function validatePuzzle(input) {
  try {
    validateAndReplay(snapshot(input));
    return { ok: true };
  } catch (error) {
    if (!(error instanceof PuzzleValidationError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.ply === undefined ? {} : { ply: error.ply }),
      },
    };
  }
}

export function createPuzzle(input) {
  const data = snapshot(input);
  validateAndReplay(data);
  return new Puzzle(data, CONSTRUCTION_TOKEN);
}

export function replayPuzzle(input) {
  const data = snapshot(input);
  return validateAndReplay(data);
}

export function isCheckmateAfterSolution(input) {
  const data = snapshot(input);
  const board = validateAndReplay(data);
  const defendingSide = data.solution.length % 2 === 0
    ? data.sideToMove
    : opposite(data.sideToMove);
  return inCheck(board, defendingSide) && !hasAnyLegalMove(board, defendingSide);
}

function snapshot(input) {
  if (input instanceof Puzzle) return clonePuzzleData(PUZZLE_DATA.get(input));
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_PUZZLE', 'Puzzle must be an object.', { path: 'puzzle' });
  }
  return clonePuzzleData(input);
}

function validateAndReplay(data) {
  validateMetadata(data);
  validateBoard(data.initialBoard);
  validateSideToMove(data.sideToMove);
  validateOptionalFields(data);

  if (!Array.isArray(data.solution)) {
    fail('INVALID_SOLUTION', 'Puzzle solution must be an array.', { path: 'solution' });
  }

  const board = cloneBoard(data.initialBoard);
  let expectedSide = data.sideToMove;

  for (let index = 0; index < data.solution.length; index++) {
    const move = data.solution[index];
    const ply = index + 1;
    const basePath = `solution[${index}]`;

    if (!move || typeof move !== 'object' || Array.isArray(move)) {
      fail('INVALID_MOVE', `Solution ply ${ply} must be a move object.`, {
        path: basePath,
        ply,
      });
    }
    if (!SIDES.has(move.side)) {
      fail('INVALID_MOVE_SIDE', `Solution ply ${ply} has invalid side.`, {
        path: `${basePath}.side`,
        ply,
      });
    }
    validateCoordinate(move.from, `${basePath}.from`, ply);
    validateCoordinate(move.to, `${basePath}.to`, ply);

    if (move.side !== expectedSide) {
      const first = index === 0;
      fail(
        first ? 'WRONG_FIRST_SIDE' : 'NON_ALTERNATING_SIDES',
        first
          ? `Solution ply 1 must be played by ${data.sideToMove}.`
          : `Solution ply ${ply} must be played by ${expectedSide}.`,
        { path: `${basePath}.side`, ply },
      );
    }

    const piece = board[move.from.r][move.from.c];
    if (piece === null) {
      fail('EMPTY_FROM_SQUARE', `Solution ply ${ply} moves from an empty square.`, {
        path: `${basePath}.from`,
        ply,
      });
    }
    if (piece.side !== move.side) {
      fail('WRONG_PIECE_SIDE', `Solution ply ${ply} moves the opponent's piece.`, {
        path: `${basePath}.from`,
        ply,
      });
    }

    const legal = legalMoves(board, move.from.r, move.from.c)
      .some(({ r, c }) => r === move.to.r && c === move.to.c);
    if (!legal) {
      fail('ILLEGAL_MOVE', `Solution ply ${ply} is not a legal Xiangqi move.`, {
        path: basePath,
        ply,
      });
    }

    applyMove(board, move.from, move.to);
    expectedSide = opposite(expectedSide);
  }

  return cloneBoard(board);
}

function validateMetadata(data) {
  if (typeof data.id !== 'string' || data.id.trim().length === 0) {
    fail('INVALID_ID', 'Puzzle id must be a non-empty string.', { path: 'id' });
  }
  if (typeof data.title !== 'string' || data.title.trim().length === 0) {
    fail('INVALID_TITLE', 'Puzzle title must be a non-empty string.', { path: 'title' });
  }
}

function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== ROWS) {
    fail('INVALID_BOARD_ROWS', `Initial board must contain exactly ${ROWS} rows.`, {
      path: 'initialBoard',
    });
  }

  let redKings = 0;
  let blackKings = 0;

  for (let r = 0; r < ROWS; r++) {
    const row = board[r];
    if (!Array.isArray(row) || row.length !== COLS) {
      fail('INVALID_BOARD_COLUMNS', `Initial board row ${r} must contain exactly ${COLS} columns.`, {
        path: `initialBoard[${r}]`,
      });
    }

    for (let c = 0; c < COLS; c++) {
      const piece = row[c];
      if (piece === null) continue;
      const path = `initialBoard[${r}][${c}]`;
      if (!piece || typeof piece !== 'object' || Array.isArray(piece)) {
        fail('INVALID_BOARD_CELL', `Board cell (${r}, ${c}) must be null or a piece object.`, { path });
      }
      if (!SIDES.has(piece.side)) {
        fail('INVALID_PIECE_SIDE', `Piece at (${r}, ${c}) has invalid side.`, {
          path: `${path}.side`,
        });
      }
      if (!PIECE_TYPES.has(piece.type)) {
        fail('INVALID_PIECE_TYPE', `Piece at (${r}, ${c}) has invalid type.`, {
          path: `${path}.type`,
        });
      }
      if (piece.type === 'K') {
        if (piece.side === RED) redKings++;
        else blackKings++;
      }
    }
  }

  validateKingCount(RED, redKings);
  validateKingCount(BLACK, blackKings);
}

function validateKingCount(side, count) {
  const label = side === RED ? 'red' : 'black';
  const codeSide = side === RED ? 'RED' : 'BLACK';
  if (count === 0) {
    fail(`MISSING_${codeSide}_KING`, `Initial board must contain exactly one ${label} king.`, {
      path: 'initialBoard',
    });
  }
  if (count > 1) {
    fail(`DUPLICATE_${codeSide}_KING`, `Initial board contains more than one ${label} king.`, {
      path: 'initialBoard',
    });
  }
}

function validateSideToMove(side) {
  if (!SIDES.has(side)) {
    fail('INVALID_SIDE_TO_MOVE', 'sideToMove must be red or black.', { path: 'sideToMove' });
  }
}

function validateOptionalFields(data) {
  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags)) {
      fail('INVALID_TAGS', 'Puzzle tags must be an array when provided.', { path: 'tags' });
    }
    for (let index = 0; index < data.tags.length; index++) {
      if (typeof data.tags[index] !== 'string') {
        fail('INVALID_TAG', `Puzzle tag at index ${index} must be a string.`, {
          path: `tags[${index}]`,
        });
      }
    }
  }
  if (data.notes !== undefined && typeof data.notes !== 'string') {
    fail('INVALID_NOTES', 'Puzzle notes must be a string when provided.', { path: 'notes' });
  }
}

function validateCoordinate(coordinate, path, ply) {
  if (!coordinate || typeof coordinate !== 'object' || Array.isArray(coordinate)) {
    fail('INVALID_COORDINATE', `Solution ply ${ply} has an invalid coordinate at ${path}.`, {
      path,
      ply,
    });
  }
  if (!Number.isInteger(coordinate.r) || !Number.isInteger(coordinate.c)) {
    fail('INVALID_COORDINATE', `Solution ply ${ply} coordinates must be integers.`, {
      path,
      ply,
    });
  }
  if (coordinate.r < 0 || coordinate.r >= ROWS || coordinate.c < 0 || coordinate.c >= COLS) {
    fail('COORDINATE_OUT_OF_BOUNDS', `Solution ply ${ply} coordinate is outside the board.`, {
      path,
      ply,
    });
  }
}

function clonePuzzleData(data) {
  return {
    id: data.id,
    title: data.title,
    initialBoard: Array.isArray(data.initialBoard) ? cloneBoard(data.initialBoard) : data.initialBoard,
    sideToMove: data.sideToMove,
    solution: Array.isArray(data.solution) ? cloneSolution(data.solution) : data.solution,
    ...(data.tags === undefined
      ? {}
      : { tags: Array.isArray(data.tags) ? data.tags.slice() : data.tags }),
    ...(data.notes === undefined ? {} : { notes: data.notes }),
  };
}

function cloneBoard(board) {
  return board.map((row) => Array.isArray(row)
    ? row.map((piece) => (piece && typeof piece === 'object' && !Array.isArray(piece)
      ? { ...piece }
      : piece))
    : row);
}

function cloneSolution(solution) {
  return solution.map((move) => {
    if (!move || typeof move !== 'object' || Array.isArray(move)) return move;
    return {
      ...move,
      from: move.from && typeof move.from === 'object' && !Array.isArray(move.from)
        ? { ...move.from }
        : move.from,
      to: move.to && typeof move.to === 'object' && !Array.isArray(move.to)
        ? { ...move.to }
        : move.to,
    };
  });
}

function opposite(side) {
  return side === RED ? BLACK : RED;
}

function fail(code, message, details) {
  throw new PuzzleValidationError(code, message, details);
}
