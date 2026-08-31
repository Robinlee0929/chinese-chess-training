import {
  ROWS,
  COLS,
  RED,
  BLACK,
  legalMoves,
  applyMove,
  notation,
} from './game.js?v=35524d4c3d';
import {
  validatePuzzle,
  replayPuzzle,
  isCheckmateAfterSolution,
} from './puzzle-domain.js?v=35524d4c3d';

const SIDES = new Set([RED, BLACK]);
const STATUSES = new Set(['recording', 'recorded']);

export class PuzzleRecorderError extends Error {
  constructor(code, message, { path } = {}) {
    super(message);
    this.name = 'PuzzleRecorderError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export function createRecorder({ initialBoard, sideToMove }) {
  const validation = validatePuzzle(recorderPuzzleData(initialBoard, sideToMove, []));
  if (!validation.ok) {
    fail(validation.error.code, validation.error.message, { path: validation.error.path });
  }
  return freezeRecorder({
    initialBoard,
    sideToMove,
    board: initialBoard,
    currentSide: sideToMove,
    solution: [],
    records: [],
    status: 'recording',
  });
}

export function recordMove(recorder, from, to) {
  const current = checkedRecorder(recorder);
  requireRecording(current);
  validateCoordinate(from, 'from');
  validateCoordinate(to, 'to');

  const piece = current.board[from.r][from.c];
  if (piece === null) {
    fail('EMPTY_SOURCE', 'Cannot record a move from an empty square.', { path: 'from' });
  }
  if (piece.side !== current.currentSide) {
    fail('WRONG_SIDE', `It is ${current.currentSide}'s turn.`, { path: 'from' });
  }

  const legal = legalMoves(current.board, from.r, from.c)
    .some(({ r, c }) => r === to.r && c === to.c);
  if (!legal) {
    fail('ILLEGAL_MOVE', 'The recorded move is not legal in the current position.', { path: 'to' });
  }

  const board = cloneBoard(current.board);
  const captured = clonePiece(board[to.r][to.c]);
  const displayNotation = notation(board, from, to);
  const move = {
    side: current.currentSide,
    from: cloneCoordinate(from),
    to: cloneCoordinate(to),
  };
  applyMove(board, from, to);

  return freezeRecorder({
    ...current,
    board,
    currentSide: opposite(current.currentSide),
    solution: [...current.solution, move],
    records: [...current.records, { move, captured, notation: displayNotation }],
  });
}

export function undoRecordedMove(recorder) {
  const current = checkedRecorder(recorder);
  requireRecording(current);
  if (current.records.length === 0) {
    fail('NOTHING_TO_UNDO', 'There is no recorded move to undo.');
  }

  const record = current.records[current.records.length - 1];
  const board = cloneBoard(current.board);
  const movedPiece = board[record.move.to.r][record.move.to.c];
  board[record.move.from.r][record.move.from.c] = clonePiece(movedPiece);
  board[record.move.to.r][record.move.to.c] = clonePiece(record.captured);

  return freezeRecorder({
    ...current,
    board,
    currentSide: record.move.side,
    solution: current.solution.slice(0, -1),
    records: current.records.slice(0, -1),
  });
}

export function resetRecording(recorder) {
  const current = checkedRecorder(recorder);
  return freezeRecorder({
    ...current,
    board: current.initialBoard,
    currentSide: current.sideToMove,
    solution: [],
    records: [],
    status: 'recording',
  });
}

export function finishRecording(recorder) {
  const current = checkedRecorder(recorder);
  requireRecording(current);
  if (current.solution.length === 0) {
    return {
      ok: false,
      error: { code: 'EMPTY_SOLUTION', message: 'Record at least one move before finishing.' },
    };
  }

  const puzzleData = recorderPuzzleData(
    current.initialBoard,
    current.sideToMove,
    current.solution,
  );
  const validation = validatePuzzle(puzzleData);
  if (!validation.ok) return validation;

  const finalBoard = replayPuzzle(puzzleData);
  const checkmate = isCheckmateAfterSolution(puzzleData);
  if (!checkmate) {
    return {
      ok: true,
      checkmate: false,
      recorder: freezeRecorder(current),
      finalBoard,
    };
  }

  const finishedRecorder = freezeRecorder({ ...current, status: 'recorded' });
  return {
    ok: true,
    checkmate: true,
    recorder: finishedRecorder,
    result: freezeResult({
      initialBoard: current.initialBoard,
      sideToMove: current.sideToMove,
      solution: current.solution,
    }),
    finalBoard,
  };
}

export function exportSolution(recorder) {
  return cloneSolution(checkedRecorder(recorder).solution);
}

export function exportRecorderBoard(recorder) {
  return cloneBoard(checkedRecorder(recorder).board);
}

export function exportRecordedResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('INVALID_RECORDED_RESULT', 'Recorded result must be an object.');
  }
  return {
    initialBoard: cloneBoard(result.initialBoard),
    sideToMove: result.sideToMove,
    solution: cloneSolution(result.solution),
  };
}

function checkedRecorder(recorder) {
  if (!recorder || typeof recorder !== 'object' || Array.isArray(recorder)) {
    fail('INVALID_RECORDER', 'Recorder state must be an object.');
  }
  if (!Array.isArray(recorder.initialBoard) || !Array.isArray(recorder.board)) {
    fail('INVALID_RECORDER_BOARD', 'Recorder state must contain initial and current boards.');
  }
  if (!SIDES.has(recorder.sideToMove) || !SIDES.has(recorder.currentSide)) {
    fail('INVALID_RECORDER_SIDE', 'Recorder state contains an invalid side.');
  }
  if (!Array.isArray(recorder.solution) || !Array.isArray(recorder.records)) {
    fail('INVALID_RECORDER_HISTORY', 'Recorder solution and records must be arrays.');
  }
  if (!STATUSES.has(recorder.status)) {
    fail('INVALID_RECORDER_STATUS', 'Recorder status is invalid.');
  }
  return recorder;
}

function requireRecording(recorder) {
  if (recorder.status !== 'recording') {
    fail('RECORDING_FINISHED', 'The recorded solution has already been finalized.');
  }
}

function recorderPuzzleData(initialBoard, sideToMove, solution) {
  return {
    id: 'recorded-puzzle',
    title: 'Recorded puzzle',
    initialBoard: cloneBoard(initialBoard),
    sideToMove,
    solution: cloneSolution(solution),
  };
}

function validateCoordinate(coordinate, path) {
  if (!coordinate || typeof coordinate !== 'object' || Array.isArray(coordinate)
    || !Number.isInteger(coordinate.r) || !Number.isInteger(coordinate.c)) {
    fail('INVALID_COORDINATE', 'Recorder coordinates must contain integer r and c values.', { path });
  }
  if (coordinate.r < 0 || coordinate.r >= ROWS || coordinate.c < 0 || coordinate.c >= COLS) {
    fail('COORDINATE_OUT_OF_BOUNDS', 'Recorder coordinate is outside the board.', { path });
  }
}

function opposite(side) {
  return side === RED ? BLACK : RED;
}

function cloneCoordinate(coordinate) {
  return { r: coordinate.r, c: coordinate.c };
}

function clonePiece(piece) {
  return piece === null ? null : { ...piece };
}

function cloneBoard(board) {
  return board.map((row) => row.map(clonePiece));
}

function cloneMove(move) {
  return {
    side: move.side,
    from: cloneCoordinate(move.from),
    to: cloneCoordinate(move.to),
  };
}

function cloneSolution(solution) {
  return solution.map(cloneMove);
}

function cloneRecord(record) {
  return {
    move: cloneMove(record.move),
    captured: clonePiece(record.captured),
    notation: record.notation,
  };
}

function freezeBoard(board) {
  const copy = cloneBoard(board);
  for (const row of copy) {
    for (const piece of row) if (piece) Object.freeze(piece);
    Object.freeze(row);
  }
  return Object.freeze(copy);
}

function freezeMove(move) {
  const copy = cloneMove(move);
  Object.freeze(copy.from);
  Object.freeze(copy.to);
  return Object.freeze(copy);
}

function freezeRecorder(recorder) {
  const initialBoard = freezeBoard(recorder.initialBoard);
  const board = freezeBoard(recorder.board);
  const solution = recorder.solution.map(freezeMove);
  const records = recorder.records.map((record) => {
    const copy = cloneRecord(record);
    copy.move = freezeMove(copy.move);
    if (copy.captured) Object.freeze(copy.captured);
    return Object.freeze(copy);
  });
  return Object.freeze({
    initialBoard,
    sideToMove: recorder.sideToMove,
    board,
    currentSide: recorder.currentSide,
    solution: Object.freeze(solution),
    records: Object.freeze(records),
    status: recorder.status,
  });
}

function freezeResult(result) {
  const initialBoard = freezeBoard(result.initialBoard);
  const solution = Object.freeze(result.solution.map(freezeMove));
  return Object.freeze({ initialBoard, sideToMove: result.sideToMove, solution });
}

function fail(code, message, details) {
  throw new PuzzleRecorderError(code, message, details);
}
