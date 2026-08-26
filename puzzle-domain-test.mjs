import assert from 'node:assert/strict';
import { initialBoard, RED, BLACK } from './game.js';
import {
  Puzzle,
  PuzzleValidationError,
  createPuzzle,
  validatePuzzle,
  replayPuzzle,
  isCheckmateAfterSolution,
} from './puzzle-domain.js';

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
  return board;
}

function minimalInput(overrides = {}) {
  return {
    id: 'minimal-1',
    title: 'Minimal legal puzzle',
    initialBoard: minimalBoard(),
    sideToMove: RED,
    solution: [
      { side: RED, from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
    ],
    tags: ['foundation'],
    notes: 'A small legal position.',
    ...overrides,
  };
}

function assertError(input, code, ply) {
  const result = validatePuzzle(input);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  if (ply !== undefined) assert.equal(result.error.ply, ply);

  assert.throws(
    () => createPuzzle(input),
    (error) => error instanceof PuzzleValidationError
      && error.code === code
      && (ply === undefined || error.ply === ply),
  );
}

test('valid minimal puzzle', () => {
  const puzzle = createPuzzle(minimalInput());
  assert.ok(puzzle instanceof Puzzle);
  assert.equal(puzzle.id, 'minimal-1');
  assert.equal(puzzle.title, 'Minimal legal puzzle');
  assert.equal(validatePuzzle(puzzle).ok, true);
});

test('valid multi-ply puzzle', () => {
  const puzzle = createPuzzle(minimalInput({
    id: 'multi-1',
    initialBoard: initialBoard(),
    solution: [
      { side: RED, from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
      { side: BLACK, from: { r: 6, c: 0 }, to: { r: 5, c: 0 } },
      { side: RED, from: { r: 4, c: 0 }, to: { r: 5, c: 0 } },
    ],
  }));
  const result = replayPuzzle(puzzle);
  assert.deepEqual(result[5][0], { type: 'P', side: RED });
  assert.equal(result[4][0], null);
  assert.equal(result[6][0], null);
});

test('malformed row count', () => {
  assertError(minimalInput({ initialBoard: minimalBoard().slice(0, 9) }), 'INVALID_BOARD_ROWS');
});

test('malformed column count', () => {
  const board = minimalBoard();
  board[4] = board[4].slice(0, 8);
  assertError(minimalInput({ initialBoard: board }), 'INVALID_BOARD_COLUMNS');
});

test('board cell must be null or a piece object', () => {
  const board = minimalBoard();
  board[4][4] = 'R';
  assertError(minimalInput({ initialBoard: board }), 'INVALID_BOARD_CELL');
});

test('invalid piece side', () => {
  const board = minimalBoard();
  board[3][0].side = 'blue';
  assertError(minimalInput({ initialBoard: board }), 'INVALID_PIECE_SIDE');
});

test('invalid piece type', () => {
  const board = minimalBoard();
  board[3][0].type = 'Q';
  assertError(minimalInput({ initialBoard: board }), 'INVALID_PIECE_TYPE');
});

test('missing red king', () => {
  const board = minimalBoard();
  board[0][3] = null;
  assertError(minimalInput({ initialBoard: board }), 'MISSING_RED_KING');
});

test('missing black king', () => {
  const board = minimalBoard();
  board[9][4] = null;
  assertError(minimalInput({ initialBoard: board }), 'MISSING_BLACK_KING');
});

test('duplicate red king', () => {
  const board = minimalBoard();
  board[0][4] = { type: 'K', side: RED };
  assertError(minimalInput({ initialBoard: board }), 'DUPLICATE_RED_KING');
});

test('duplicate black king', () => {
  const board = minimalBoard();
  board[9][5] = { type: 'K', side: BLACK };
  assertError(minimalInput({ initialBoard: board }), 'DUPLICATE_BLACK_KING');
});

test('invalid sideToMove', () => {
  assertError(minimalInput({ sideToMove: 'green' }), 'INVALID_SIDE_TO_MOVE');
});

test('empty puzzle id', () => {
  assertError(minimalInput({ id: '   ' }), 'INVALID_ID');
});

test('empty puzzle title', () => {
  assertError(minimalInput({ title: '' }), 'INVALID_TITLE');
});

test('invalid coordinates report their exact ply', () => {
  const solution = [
    { side: RED, from: { r: 3.5, c: 0 }, to: { r: 4, c: 0 } },
  ];
  assertError(minimalInput({ solution }), 'INVALID_COORDINATE', 1);
});

test('out-of-bounds coordinates report their exact ply', () => {
  const solution = [
    { side: RED, from: { r: 3, c: 0 }, to: { r: 10, c: 0 } },
  ];
  assertError(minimalInput({ solution }), 'COORDINATE_OUT_OF_BOUNDS', 1);
});

test('wrong first solution side', () => {
  const solution = [
    { side: BLACK, from: { r: 9, c: 4 }, to: { r: 8, c: 4 } },
  ];
  assertError(minimalInput({ solution }), 'WRONG_FIRST_SIDE', 1);
});

test('non-alternating solution sides', () => {
  const board = minimalBoard();
  board[3][2] = { type: 'P', side: RED };
  const solution = [
    { side: RED, from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
    { side: RED, from: { r: 3, c: 2 }, to: { r: 4, c: 2 } },
  ];
  assertError(minimalInput({ initialBoard: board, solution }), 'NON_ALTERNATING_SIDES', 2);
});

test('moving from an empty square', () => {
  const solution = [
    { side: RED, from: { r: 4, c: 0 }, to: { r: 5, c: 0 } },
  ];
  assertError(minimalInput({ solution }), 'EMPTY_FROM_SQUARE', 1);
});

test('moving the opponent piece', () => {
  const board = minimalBoard();
  board[6][0] = { type: 'P', side: BLACK };
  const solution = [
    { side: RED, from: { r: 6, c: 0 }, to: { r: 5, c: 0 } },
  ];
  assertError(minimalInput({ initialBoard: board, solution }), 'WRONG_PIECE_SIDE', 1);
});

test('illegal Xiangqi move', () => {
  const solution = [
    { side: RED, from: { r: 3, c: 0 }, to: { r: 3, c: 1 } },
  ];
  const input = minimalInput({ solution });
  assertError(input, 'ILLEGAL_MOVE', 1);
  assert.throws(
    () => replayPuzzle(input),
    (error) => error instanceof PuzzleValidationError
      && error.code === 'ILLEGAL_MOVE'
      && error.ply === 1,
  );
});

test('successful legal replay', () => {
  const result = replayPuzzle(createPuzzle(minimalInput()));
  assert.equal(result[3][0], null);
  assert.deepEqual(result[4][0], { type: 'P', side: RED });
});

test('source board remains unchanged', () => {
  const input = minimalInput();
  const before = structuredClone(input.initialBoard);
  const puzzle = createPuzzle(input);
  replayPuzzle(puzzle);
  assert.deepEqual(input.initialBoard, before);
});

test('puzzle board is deeply isolated from input and returned values', () => {
  const input = minimalInput();
  const puzzle = createPuzzle(input);

  input.initialBoard[0][3].type = 'R';
  input.initialBoard[3][0] = null;
  const returned = puzzle.initialBoard;
  returned[0][3].type = 'A';
  returned[3][0] = null;

  assert.deepEqual(puzzle.initialBoard[0][3], { type: 'K', side: RED });
  assert.deepEqual(puzzle.initialBoard[3][0], { type: 'P', side: RED });
});

test('solution and tags are deeply isolated', () => {
  const input = minimalInput();
  const puzzle = createPuzzle(input);

  input.solution[0].side = BLACK;
  input.solution[0].from.r = 8;
  input.tags[0] = 'changed-input';

  const returnedSolution = puzzle.solution;
  returnedSolution[0].to.r = 9;
  const returnedTags = puzzle.tags;
  returnedTags[0] = 'changed-output';

  assert.deepEqual(puzzle.solution, [
    { side: RED, from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
  ]);
  assert.deepEqual(puzzle.tags, ['foundation']);
});

test('returned replay board is isolated from the stored puzzle', () => {
  const puzzle = createPuzzle(minimalInput());
  const first = replayPuzzle(puzzle);
  first[4][0].type = 'R';
  first[9][4] = null;

  const second = replayPuzzle(puzzle);
  assert.deepEqual(second[4][0], { type: 'P', side: RED });
  assert.deepEqual(second[9][4], { type: 'K', side: BLACK });
});

test('recorded solution ending in checkmate', () => {
  const board = emptyBoard();
  board[9][4] = { type: 'K', side: BLACK };
  board[0][3] = { type: 'K', side: RED };
  board[8][0] = { type: 'R', side: RED };
  board[6][8] = { type: 'R', side: RED };
  board[5][3] = { type: 'P', side: RED };

  const puzzle = createPuzzle(minimalInput({
    id: 'mate-1',
    initialBoard: board,
    solution: [
      { side: RED, from: { r: 6, c: 8 }, to: { r: 9, c: 8 } },
    ],
  }));
  assert.equal(isCheckmateAfterSolution(puzzle), true);
});

test('recorded solution not ending in checkmate', () => {
  assert.equal(isCheckmateAfterSolution(createPuzzle(minimalInput())), false);
});

console.log(`\n${passed} puzzle-domain tests passed; ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
