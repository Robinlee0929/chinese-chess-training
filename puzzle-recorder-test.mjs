import assert from 'node:assert/strict';
import { initialBoard, RED, BLACK } from './game.js';
import {
  PuzzleRecorderError,
  createRecorder,
  recordMove,
  undoRecordedMove,
  resetRecording,
  finishRecording,
  exportSolution,
  exportRecorderBoard,
  exportRecordedResult,
} from './puzzle-recorder.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (error) {
    failed++;
    console.error('  ✗', name);
    console.error(error);
  }
}

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function minimalBoard() {
  const board = emptyBoard();
  board[0][3] = { type: 'K', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[3][0] = { type: 'P', side: RED };
  board[6][8] = { type: 'P', side: BLACK };
  return board;
}

function captureBoard() {
  const board = emptyBoard();
  board[0][3] = { type: 'K', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[5][0] = { type: 'R', side: RED };
  board[5][3] = { type: 'P', side: BLACK };
  return board;
}

function mateBoard() {
  const board = emptyBoard();
  board[9][4] = { type: 'K', side: BLACK };
  board[0][3] = { type: 'K', side: RED };
  board[8][0] = { type: 'R', side: RED };
  board[6][8] = { type: 'R', side: RED };
  board[5][3] = { type: 'P', side: RED };
  return board;
}

function assertRecorderError(fn, code) {
  assert.throws(fn, (error) => error instanceof PuzzleRecorderError && error.code === code);
}

test('recorder initializes from confirmed board', () => {
  const board = minimalBoard();
  const recorder = createRecorder({ initialBoard: board, sideToMove: RED });
  assert.deepEqual(recorder.board, board);
  assert.deepEqual(recorder.initialBoard, board);
  assert.equal(recorder.status, 'recording');
  assert.deepEqual(recorder.solution, []);
});

test('source confirmed board is not mutated', () => {
  const board = minimalBoard();
  const before = structuredClone(board);
  let recorder = createRecorder({ initialBoard: board, sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  board[0][3].type = 'R';
  board[3][0] = null;
  assert.deepEqual(recorder.initialBoard, before);
});

test('first current side matches sideToMove', () => {
  const recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: BLACK });
  assert.equal(recorder.currentSide, BLACK);
});

test('legal move is recorded', () => {
  const recorder = recordMove(
    createRecorder({ initialBoard: minimalBoard(), sideToMove: RED }),
    { r: 3, c: 0 },
    { r: 4, c: 0 },
  );
  assert.equal(recorder.solution.length, 1);
  assert.equal(recorder.board[3][0], null);
  assert.deepEqual(recorder.board[4][0], { type: 'P', side: RED });
});

test('first recorded move has correct side/from/to', () => {
  const recorder = recordMove(
    createRecorder({ initialBoard: minimalBoard(), sideToMove: RED }),
    { r: 3, c: 0 },
    { r: 4, c: 0 },
  );
  assert.deepEqual(recorder.solution[0], {
    side: RED,
    from: { r: 3, c: 0 },
    to: { r: 4, c: 0 },
  });
});

test('turn alternates after recorded move', () => {
  const recorder = recordMove(
    createRecorder({ initialBoard: minimalBoard(), sideToMove: RED }),
    { r: 3, c: 0 },
    { r: 4, c: 0 },
  );
  assert.equal(recorder.currentSide, BLACK);
});

test('opponent piece cannot be moved', () => {
  const recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  assertRecorderError(
    () => recordMove(recorder, { r: 6, c: 8 }, { r: 5, c: 8 }),
    'WRONG_SIDE',
  );
});

test('empty square cannot move', () => {
  const recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  assertRecorderError(
    () => recordMove(recorder, { r: 4, c: 0 }, { r: 5, c: 0 }),
    'EMPTY_SOURCE',
  );
});

test('illegal Xiangqi move rejected without mutation', () => {
  const recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  assertRecorderError(
    () => recordMove(recorder, { r: 3, c: 0 }, { r: 3, c: 1 }),
    'ILLEGAL_MOVE',
  );
  assert.deepEqual(recorder.board, minimalBoard());
  assert.deepEqual(recorder.solution, []);
});

test('capture is recorded correctly', () => {
  const recorder = recordMove(
    createRecorder({ initialBoard: captureBoard(), sideToMove: RED }),
    { r: 5, c: 0 },
    { r: 5, c: 3 },
  );
  assert.deepEqual(recorder.records[0].captured, { type: 'P', side: BLACK });
  assert.equal(recorder.records[0].notation, '俥九平六');
});

test('captured logical piece disappears', () => {
  const recorder = recordMove(
    createRecorder({ initialBoard: captureBoard(), sideToMove: RED }),
    { r: 5, c: 0 },
    { r: 5, c: 3 },
  );
  assert.deepEqual(recorder.board[5][3], { type: 'R', side: RED });
  assert.equal(recorder.board[5][0], null);
});

test('recorder undo restores moved piece', () => {
  let recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  recorder = undoRecordedMove(recorder);
  assert.deepEqual(recorder.board[3][0], { type: 'P', side: RED });
  assert.equal(recorder.board[4][0], null);
});

test('recorder undo restores captured piece', () => {
  let recorder = createRecorder({ initialBoard: captureBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 5, c: 0 }, { r: 5, c: 3 });
  recorder = undoRecordedMove(recorder);
  assert.deepEqual(recorder.board[5][0], { type: 'R', side: RED });
  assert.deepEqual(recorder.board[5][3], { type: 'P', side: BLACK });
});

test('undo removes exactly one solution ply', () => {
  let recorder = createRecorder({ initialBoard: initialBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  recorder = recordMove(recorder, { r: 6, c: 0 }, { r: 5, c: 0 });
  recorder = undoRecordedMove(recorder);
  assert.equal(recorder.solution.length, 1);
  assert.deepEqual(recorder.solution[0].to, { r: 4, c: 0 });
});

test('undo restores correct side to move', () => {
  let recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  recorder = undoRecordedMove(recorder);
  assert.equal(recorder.currentSide, RED);
});

test('reset returns to initialBoard', () => {
  let recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  recorder = resetRecording(recorder);
  assert.deepEqual(recorder.board, minimalBoard());
  assert.equal(recorder.currentSide, RED);
});

test('reset clears solution', () => {
  let recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  recorder = resetRecording(recorder);
  assert.deepEqual(recorder.solution, []);
  assert.deepEqual(recorder.records, []);
});

test('exported solution is deeply isolated', () => {
  let recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  const first = exportSolution(recorder);
  first[0].side = BLACK;
  first[0].from.r = 9;
  assert.deepEqual(exportSolution(recorder), [{
    side: RED,
    from: { r: 3, c: 0 },
    to: { r: 4, c: 0 },
  }]);
});

test('replay board export is isolated', () => {
  let recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  const first = exportRecorderBoard(recorder);
  first[4][0].type = 'R';
  first[9][4] = null;
  const second = exportRecorderBoard(recorder);
  assert.deepEqual(second[4][0], { type: 'P', side: RED });
  assert.deepEqual(second[9][4], { type: 'K', side: BLACK });
});

test('empty solution cannot finish', () => {
  const result = finishRecording(createRecorder({ initialBoard: minimalBoard(), sideToMove: RED }));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EMPTY_SOLUTION');
});

test('legal non-checkmate sequence recognized as non-checkmate', () => {
  let recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  const result = finishRecording(recorder);
  assert.equal(result.ok, true);
  assert.equal(result.checkmate, false);
  assert.equal(result.recorder.status, 'recording');
});

test('legal checkmate sequence recognized as checkmate', () => {
  let recorder = createRecorder({ initialBoard: mateBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 6, c: 8 }, { r: 9, c: 8 });
  const result = finishRecording(recorder);
  assert.equal(result.ok, true);
  assert.equal(result.checkmate, true);
  assert.equal(result.recorder.status, 'recorded');
  assert.deepEqual(result.result.solution, recorder.solution);
});

test('successful recorded result is deeply isolated on export', () => {
  let recorder = createRecorder({ initialBoard: mateBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 6, c: 8 }, { r: 9, c: 8 });
  const finished = finishRecording(recorder);
  const first = exportRecordedResult(finished.result);
  first.initialBoard[0][3].type = 'R';
  first.solution[0].to.r = 0;
  const second = exportRecordedResult(finished.result);
  assert.deepEqual(second.initialBoard[0][3], { type: 'K', side: RED });
  assert.deepEqual(second.solution[0].to, { r: 9, c: 8 });
});

test('multi-ply legal solution validates through puzzle-domain', () => {
  let recorder = createRecorder({ initialBoard: initialBoard(), sideToMove: RED });
  recorder = recordMove(recorder, { r: 3, c: 0 }, { r: 4, c: 0 });
  recorder = recordMove(recorder, { r: 6, c: 0 }, { r: 5, c: 0 });
  recorder = recordMove(recorder, { r: 4, c: 0 }, { r: 5, c: 0 });
  const result = finishRecording(recorder);
  assert.equal(result.ok, true);
  assert.equal(result.checkmate, false);
  assert.deepEqual(result.finalBoard[5][0], { type: 'P', side: RED });
});

test('malformed or illegal sequence cannot be finalized', () => {
  const recorder = createRecorder({ initialBoard: minimalBoard(), sideToMove: RED });
  const tampered = {
    ...recorder,
    solution: [{ side: RED, from: { r: 3, c: 0 }, to: { r: 3, c: 1 } }],
  };
  const result = finishRecording(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ILLEGAL_MOVE');
});

console.log(`\n${passed} puzzle-recorder tests passed; ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
