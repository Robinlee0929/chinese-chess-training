import assert from 'node:assert/strict';
import { RED, BLACK } from './game.js';
import {
  PuzzlePracticeError,
  createPractice,
  attemptPracticeMove,
  applyOpponentReply,
  restartPractice,
  exportPracticeBoard,
  exportPracticeSnapshot,
} from './puzzle-practice.js';

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

function multiPlyMate() {
  const board = emptyBoard();
  board[9][4] = { type: 'K', side: BLACK };
  board[0][3] = { type: 'K', side: RED };
  board[8][0] = { type: 'R', side: RED };
  board[6][8] = { type: 'R', side: RED };
  board[5][3] = { type: 'P', side: RED };
  board[3][0] = { type: 'P', side: RED };
  board[5][6] = { type: 'P', side: RED };
  board[6][6] = { type: 'P', side: BLACK };
  return {
    initialBoard: board,
    sideToMove: RED,
    solution: [
      { side: RED, from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
      { side: BLACK, from: { r: 6, c: 6 }, to: { r: 5, c: 6 } },
      { side: RED, from: { r: 6, c: 8 }, to: { r: 9, c: 8 } },
    ],
  };
}

function userCaptureMate() {
  const puzzle = multiPlyMate();
  puzzle.initialBoard[9][8] = { type: 'P', side: BLACK };
  puzzle.solution = [{ side: RED, from: { r: 6, c: 8 }, to: { r: 9, c: 8 } }];
  return puzzle;
}

function nonMatePuzzle() {
  const board = emptyBoard();
  board[0][3] = { type: 'K', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[3][0] = { type: 'P', side: RED };
  return {
    initialBoard: board,
    sideToMove: RED,
    solution: [{ side: RED, from: { r: 3, c: 0 }, to: { r: 4, c: 0 } }],
  };
}

function firstMove(practice) {
  return attemptPracticeMove(practice, { r: 3, c: 0 }, { r: 4, c: 0 });
}

function assertPracticeError(fn, code) {
  assert.throws(fn, (error) => error instanceof PuzzlePracticeError && error.code === code);
}

test('practice initializes from recorded puzzle', () => {
  const puzzle = multiPlyMate();
  const practice = createPractice(puzzle);
  assert.deepEqual(practice.currentBoard, puzzle.initialBoard);
  assert.equal(practice.status, 'practicing');
});

test('source puzzle is not mutated', () => {
  const puzzle = multiPlyMate();
  const before = structuredClone(puzzle);
  const practice = firstMove(createPractice(puzzle)).practice;
  puzzle.initialBoard[0][3].type = 'R';
  puzzle.solution[0].to.r = 9;
  assert.deepEqual(practice.initialBoard, before.initialBoard);
  assert.deepEqual(practice.solution, before.solution);
});

test('practice side equals sideToMove', () => {
  assert.equal(createPractice(multiPlyMate()).practiceSide, RED);
});

test('currentPly starts at zero', () => {
  assert.equal(createPractice(multiPlyMate()).currentPly, 0);
});

test('correct expected user move is accepted', () => {
  assert.equal(firstMove(createPractice(multiPlyMate())).ok, true);
});

test('correct user move advances currentPly', () => {
  assert.equal(firstMove(createPractice(multiPlyMate())).practice.currentPly, 1);
});

test('wrong but legal move is rejected', () => {
  const result = attemptPracticeMove(createPractice(multiPlyMate()), { r: 8, c: 0 }, { r: 7, c: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'WRONG_MOVE');
});

test('wrong legal move does not mutate board', () => {
  const practice = createPractice(multiPlyMate());
  const result = attemptPracticeMove(practice, { r: 8, c: 0 }, { r: 7, c: 0 });
  assert.deepEqual(result.practice.currentBoard, practice.currentBoard);
});

test('wrong legal move does not advance ply', () => {
  const result = attemptPracticeMove(createPractice(multiPlyMate()), { r: 8, c: 0 }, { r: 7, c: 0 });
  assert.equal(result.practice.currentPly, 0);
  assert.equal(result.practice.mistakes, 1);
});

test('illegal move is rejected without mutation', () => {
  const practice = createPractice(multiPlyMate());
  const result = attemptPracticeMove(practice, { r: 3, c: 0 }, { r: 6, c: 0 });
  assert.equal(result.error.code, 'ILLEGAL_MOVE');
  assert.deepEqual(result.practice.currentBoard, practice.currentBoard);
});

test('opponent piece cannot be user-controlled', () => {
  const result = attemptPracticeMove(createPractice(multiPlyMate()), { r: 6, c: 6 }, { r: 5, c: 6 });
  assert.equal(result.error.code, 'WRONG_SIDE');
});

test('automatic opponent move is applied correctly', () => {
  const reply = applyOpponentReply(firstMove(createPractice(multiPlyMate())).practice);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.practice.currentBoard[5][6], { type: 'P', side: BLACK });
  assert.equal(reply.practice.currentPly, 2);
});

test('opponent move is exactly the recorded solution move', () => {
  const reply = applyOpponentReply(firstMove(createPractice(multiPlyMate())).practice);
  assert.deepEqual(reply.move, multiPlyMate().solution[1]);
  assert.equal(reply.actor, 'opponent');
});

test('user capture works', () => {
  const result = attemptPracticeMove(createPractice(userCaptureMate()), { r: 6, c: 8 }, { r: 9, c: 8 });
  assert.deepEqual(result.captured, { type: 'P', side: BLACK });
  assert.deepEqual(result.practice.currentBoard[9][8], { type: 'R', side: RED });
});

test('opponent capture works', () => {
  const reply = applyOpponentReply(firstMove(createPractice(multiPlyMate())).practice);
  assert.deepEqual(reply.captured, { type: 'P', side: RED });
  assert.deepEqual(reply.practice.currentBoard[5][6], { type: 'P', side: BLACK });
});

test('restart restores exact initialBoard', () => {
  const moved = applyOpponentReply(firstMove(createPractice(multiPlyMate())).practice).practice;
  assert.deepEqual(restartPractice(moved).currentBoard, moved.initialBoard);
});

test('restart resets currentPly', () => {
  const moved = firstMove(createPractice(multiPlyMate())).practice;
  assert.equal(restartPractice(moved).currentPly, 0);
});

test('restart resets mistakes', () => {
  const wrong = attemptPracticeMove(createPractice(multiPlyMate()), { r: 8, c: 0 }, { r: 7, c: 0 }).practice;
  assert.equal(restartPractice(wrong).mistakes, 0);
});

test('exported current board is deeply isolated', () => {
  const practice = createPractice(multiPlyMate());
  const board = exportPracticeBoard(practice);
  board[0][3].type = 'R';
  assert.deepEqual(exportPracticeBoard(practice)[0][3], { type: 'K', side: RED });
});

test('recorded puzzle remains deeply isolated', () => {
  const practice = createPractice(multiPlyMate());
  const snapshot = exportPracticeSnapshot(practice);
  snapshot.initialBoard[0][3].type = 'R';
  snapshot.solution[0].from.r = 9;
  const again = exportPracticeSnapshot(practice);
  assert.deepEqual(again.initialBoard[0][3], { type: 'K', side: RED });
  assert.deepEqual(again.solution[0].from, { r: 3, c: 0 });
});

test('final correct move completes practice', () => {
  let practice = firstMove(createPractice(multiPlyMate())).practice;
  practice = applyOpponentReply(practice).practice;
  const result = attemptPracticeMove(practice, { r: 6, c: 8 }, { r: 9, c: 8 });
  assert.equal(result.complete, true);
  assert.equal(result.practice.status, 'complete');
});

test('complete state occurs only at solution end', () => {
  let practice = firstMove(createPractice(multiPlyMate())).practice;
  assert.equal(practice.status, 'practicing');
  practice = applyOpponentReply(practice).practice;
  assert.equal(practice.status, 'practicing');
  practice = attemptPracticeMove(practice, { r: 6, c: 8 }, { r: 9, c: 8 }).practice;
  assert.equal(practice.currentPly, practice.solution.length);
  assert.equal(practice.status, 'complete');
});

test('malformed stored opponent reply fails closed', () => {
  const afterUser = firstMove(createPractice(multiPlyMate())).practice;
  const malformed = {
    ...afterUser,
    solution: [afterUser.solution[0], {
      side: BLACK,
      from: { r: 6, c: 6 },
      to: { r: 6, c: 5 },
    }, afterUser.solution[2]],
  };
  assertPracticeError(() => applyOpponentReply(malformed), 'INCONSISTENT_OPPONENT_REPLY');
  assert.deepEqual(afterUser.currentBoard[6][6], { type: 'P', side: BLACK });
});

test('empty solution cannot start practice', () => {
  const puzzle = multiPlyMate();
  puzzle.solution = [];
  assertPracticeError(() => createPractice(puzzle), 'EMPTY_SOLUTION');
});

test('non-checkmate puzzle cannot enter mate practice', () => {
  assertPracticeError(() => createPractice(nonMatePuzzle()), 'NOT_CHECKMATE');
});

test('user input is blocked while opponent reply is pending', () => {
  const afterUser = firstMove(createPractice(multiPlyMate())).practice;
  const result = attemptPracticeMove(afterUser, { r: 6, c: 8 }, { r: 9, c: 8 });
  assert.equal(result.error.code, 'NOT_USER_TURN');
  assert.equal(result.practice.currentPly, 1);
});

console.log(`\n${passed} puzzle-practice tests passed; ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
