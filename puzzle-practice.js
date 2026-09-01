import { ROWS, COLS, RED, BLACK, legalMoves, applyMove, name, notation } from './game.js?v=7ddbb73eba';
import { validatePuzzle, isCheckmateAfterSolution } from './puzzle-domain.js?v=7ddbb73eba';

const SIDES = new Set([RED, BLACK]);
const STATUSES = new Set(['practicing', 'complete']);

export const PRACTICE_HINT_MAX_LEVEL = 4;

export class PuzzlePracticeError extends Error {
  constructor(code, message, { path } = {}) {
    super(message);
    this.name = 'PuzzlePracticeError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export function createPractice(recordedPuzzle) {
  const puzzle = cloneRecordedPuzzle(recordedPuzzle);
  if (puzzle.solution.length === 0) {
    fail('EMPTY_SOLUTION', 'A recorded solution is required to start practice.');
  }
  const validation = validatePuzzle(domainPuzzle(puzzle));
  if (!validation.ok) {
    fail(validation.error.code, validation.error.message, { path: validation.error.path });
  }
  if (!isCheckmateAfterSolution(domainPuzzle(puzzle))) {
    fail('NOT_CHECKMATE', 'Mate practice requires a recorded line ending in checkmate.');
  }
  return freezePractice({
    initialBoard: puzzle.initialBoard,
    solution: puzzle.solution,
    practiceSide: puzzle.sideToMove,
    currentBoard: puzzle.initialBoard,
    currentPly: 0,
    currentSide: puzzle.sideToMove,
    status: 'practicing',
    mistakes: 0,
  });
}

export function attemptPracticeMove(practice, from, to) {
  const current = checkedPractice(practice);
  requirePracticing(current);
  validateCoordinate(from, 'from');
  validateCoordinate(to, 'to');
  if (current.currentSide !== current.practiceSide) {
    return rejected(current, 'NOT_USER_TURN', 'Wait for the recorded opponent reply.');
  }

  const piece = current.currentBoard[from.r][from.c];
  if (piece === null) return rejected(current, 'EMPTY_SOURCE', 'Select one of your pieces.');
  if (piece.side !== current.practiceSide) {
    return rejected(current, 'WRONG_SIDE', 'The player controls only the practice side.');
  }
  if (!isLegal(current.currentBoard, from, to)) {
    return rejected(current, 'ILLEGAL_MOVE', 'The attempted move is not legal.');
  }

  const expected = current.solution[current.currentPly];
  if (!sameMove(expected, current.currentSide, from, to)) {
    const next = freezePractice({ ...current, mistakes: current.mistakes + 1 });
    return rejected(next, 'WRONG_MOVE', 'This legal move is not the recorded answer.');
  }
  return acceptedMove(current, expected, 'user');
}

export function applyOpponentReply(practice) {
  const current = checkedPractice(practice);
  requirePracticing(current);
  if (current.currentSide === current.practiceSide) {
    fail('NOT_OPPONENT_TURN', 'There is no opponent reply to apply.');
  }
  const expected = current.solution[current.currentPly];
  if (!expected || expected.side !== current.currentSide) {
    fail('INCONSISTENT_OPPONENT_REPLY', 'The stored opponent reply does not match the current ply.');
  }
  if (!isLegal(current.currentBoard, expected.from, expected.to)) {
    fail('INCONSISTENT_OPPONENT_REPLY', 'The stored opponent reply is not legal in the current position.');
  }
  return acceptedMove(current, expected, 'opponent');
}

export function restartPractice(practice) {
  const current = checkedPractice(practice);
  return freezePractice({
    ...current,
    currentBoard: current.initialBoard,
    currentPly: 0,
    currentSide: current.practiceSide,
    status: 'practicing',
    mistakes: 0,
  });
}

// Progressive hints describe only the current move in the recorded solution.
// They do not search for alternatives or evaluate whether that move is best.
export function derivePracticeHint(practice, level) {
  if (!Number.isInteger(level) || level < 1 || level > PRACTICE_HINT_MAX_LEVEL) {
    fail('INVALID_HINT_LEVEL', `Hint level must be an integer from 1 to ${PRACTICE_HINT_MAX_LEVEL}.`);
  }

  const current = checkedPractice(practice);
  if (current.status !== 'practicing' || current.currentSide !== current.practiceSide
    || current.currentPly >= current.solution.length) {
    fail('HINT_NOT_AVAILABLE', 'A hint is available only during the player turn of active practice.');
  }

  const expected = current.solution[current.currentPly];
  if (!isHintCoordinate(expected?.from) || !isHintCoordinate(expected?.to)
    || expected.side !== current.currentSide) {
    fail('INCONSISTENT_HINT_MOVE', 'The recorded hint move does not match the current practice ply.');
  }

  const sourcePiece = current.currentBoard[expected.from.r]?.[expected.from.c];
  if (!sourcePiece || sourcePiece.side !== current.currentSide) {
    fail('INCONSISTENT_HINT_MOVE', 'The recorded hint source does not contain a current-side piece.');
  }

  let legal = false;
  try {
    legal = isLegal(current.currentBoard, expected.from, expected.to);
  } catch {
    legal = false;
  }
  const pieceName = name(sourcePiece.side, sourcePiece.type);
  if (!legal || typeof pieceName !== 'string') {
    fail('INCONSISTENT_HINT_MOVE', 'The recorded hint move is not legal in the current position.');
  }

  const hint = {
    level,
    piece: { side: sourcePiece.side, type: sourcePiece.type, name: pieceName },
  };
  if (level >= 2) hint.from = cloneCoordinate(expected.from);
  if (level >= 3) hint.to = cloneCoordinate(expected.to);
  if (level >= 4) {
    try {
      hint.notation = notation(current.currentBoard, expected.from, expected.to);
    } catch {
      fail('INCONSISTENT_HINT_MOVE', 'The recorded hint move cannot be formatted in the current position.');
    }
  }
  return freezeHint(hint);
}

export function exportPracticeBoard(practice) {
  return cloneBoard(checkedPractice(practice).currentBoard);
}

export function exportPracticeSnapshot(practice) {
  const current = checkedPractice(practice);
  return {
    initialBoard: cloneBoard(current.initialBoard),
    solution: cloneSolution(current.solution),
    practiceSide: current.practiceSide,
    currentBoard: cloneBoard(current.currentBoard),
    currentPly: current.currentPly,
    currentSide: current.currentSide,
    status: current.status,
    mistakes: current.mistakes,
  };
}

function acceptedMove(current, move, actor) {
  const board = cloneBoard(current.currentBoard);
  const captured = clonePiece(board[move.to.r][move.to.c]);
  const displayNotation = notation(board, move.from, move.to);
  applyMove(board, move.from, move.to);
  const nextPly = current.currentPly + 1;
  const next = freezePractice({
    ...current,
    currentBoard: board,
    currentPly: nextPly,
    currentSide: opposite(current.currentSide),
    status: nextPly === current.solution.length ? 'complete' : 'practicing',
  });
  return {
    ok: true,
    actor,
    move: cloneMove(move),
    captured,
    notation: displayNotation,
    practice: next,
    complete: next.status === 'complete',
  };
}

function rejected(practice, code, message) {
  return { ok: false, error: { code, message }, practice };
}

function checkedPractice(practice) {
  if (!practice || typeof practice !== 'object' || Array.isArray(practice)) {
    fail('INVALID_PRACTICE', 'Practice state must be an object.');
  }
  if (!Array.isArray(practice.initialBoard) || !Array.isArray(practice.currentBoard)) {
    fail('INVALID_PRACTICE_BOARD', 'Practice state must contain initial and current boards.');
  }
  if (!Array.isArray(practice.solution) || !SIDES.has(practice.practiceSide)
    || !SIDES.has(practice.currentSide) || !STATUSES.has(practice.status)) {
    fail('INVALID_PRACTICE_STATE', 'Practice state is malformed.');
  }
  if (!Number.isInteger(practice.currentPly) || practice.currentPly < 0
    || practice.currentPly > practice.solution.length) {
    fail('INVALID_PRACTICE_PLY', 'Practice ply is outside the recorded solution.');
  }
  return practice;
}

function requirePracticing(practice) {
  if (practice.status !== 'practicing') {
    fail('PRACTICE_COMPLETE', 'This practice run is already complete.');
  }
}

function cloneRecordedPuzzle(recordedPuzzle) {
  if (!recordedPuzzle || typeof recordedPuzzle !== 'object' || Array.isArray(recordedPuzzle)) {
    fail('INVALID_RECORDED_PUZZLE', 'Recorded puzzle must be an object.');
  }
  if (!Array.isArray(recordedPuzzle.initialBoard) || !Array.isArray(recordedPuzzle.solution)) {
    fail('INVALID_RECORDED_PUZZLE', 'Recorded puzzle must contain initialBoard and solution.');
  }
  return {
    initialBoard: cloneBoard(recordedPuzzle.initialBoard),
    sideToMove: recordedPuzzle.sideToMove,
    solution: cloneSolution(recordedPuzzle.solution),
  };
}

function domainPuzzle(puzzle) {
  return {
    id: 'practice-puzzle',
    title: 'Practice puzzle',
    initialBoard: cloneBoard(puzzle.initialBoard),
    sideToMove: puzzle.sideToMove,
    solution: cloneSolution(puzzle.solution),
  };
}

function validateCoordinate(coordinate, path) {
  if (!coordinate || typeof coordinate !== 'object' || Array.isArray(coordinate)
    || !Number.isInteger(coordinate.r) || !Number.isInteger(coordinate.c)) {
    fail('INVALID_COORDINATE', 'Coordinates must contain integer r and c values.', { path });
  }
  if (coordinate.r < 0 || coordinate.r >= ROWS || coordinate.c < 0 || coordinate.c >= COLS) {
    fail('COORDINATE_OUT_OF_BOUNDS', 'Coordinate is outside the board.', { path });
  }
}

function isHintCoordinate(coordinate) {
  return coordinate && typeof coordinate === 'object' && !Array.isArray(coordinate)
    && Number.isInteger(coordinate.r) && Number.isInteger(coordinate.c)
    && coordinate.r >= 0 && coordinate.r < ROWS
    && coordinate.c >= 0 && coordinate.c < COLS;
}

function isLegal(board, from, to) {
  return legalMoves(board, from.r, from.c).some(({ r, c }) => r === to.r && c === to.c);
}

function sameMove(expected, side, from, to) {
  return expected && expected.side === side
    && expected.from.r === from.r && expected.from.c === from.c
    && expected.to.r === to.r && expected.to.c === to.c;
}

function opposite(side) {
  return side === RED ? BLACK : RED;
}

function clonePiece(piece) {
  return piece === null ? null : { ...piece };
}

function cloneBoard(board) {
  return board.map((row) => row.map(clonePiece));
}

function cloneCoordinate(coordinate) {
  return { r: coordinate.r, c: coordinate.c };
}

function cloneMove(move) {
  return { side: move.side, from: cloneCoordinate(move.from), to: cloneCoordinate(move.to) };
}

function cloneSolution(solution) {
  return solution.map(cloneMove);
}

function freezeBoard(board) {
  return Object.freeze(board.map((row) => Object.freeze(row.map((piece) => (
    piece === null ? null : Object.freeze({ ...piece })
  )))));
}

function freezeSolution(solution) {
  return Object.freeze(solution.map((move) => Object.freeze({
    side: move.side,
    from: Object.freeze(cloneCoordinate(move.from)),
    to: Object.freeze(cloneCoordinate(move.to)),
  })));
}

function freezePractice(practice) {
  return Object.freeze({
    initialBoard: freezeBoard(cloneBoard(practice.initialBoard)),
    solution: freezeSolution(cloneSolution(practice.solution)),
    practiceSide: practice.practiceSide,
    currentBoard: freezeBoard(cloneBoard(practice.currentBoard)),
    currentPly: practice.currentPly,
    currentSide: practice.currentSide,
    status: practice.status,
    mistakes: practice.mistakes,
  });
}

function freezeHint(hint) {
  const frozen = {
    level: hint.level,
    piece: Object.freeze({ ...hint.piece }),
  };
  if (hint.from) frozen.from = Object.freeze(cloneCoordinate(hint.from));
  if (hint.to) frozen.to = Object.freeze(cloneCoordinate(hint.to));
  if (hint.notation !== undefined) frozen.notation = hint.notation;
  return Object.freeze(frozen);
}

function fail(code, message, options) {
  throw new PuzzlePracticeError(code, message, options);
}
