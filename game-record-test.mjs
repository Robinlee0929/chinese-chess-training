import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initialBoard,
  applyMove,
  hashBoard,
  inCheck,
  RED,
  BLACK,
} from './game.js';
import {
  GAME_RECORD_SCHEMA_VERSION,
  GameRecordValidationError,
  validateGameRecord,
  createGameRecord,
  replayGameRecord,
} from './game-record.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(error);
  }
}

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function clone(value) {
  return structuredClone(value);
}

function checkmateRecord(overrides = {}) {
  const board = emptyBoard();
  board[9][4] = { type: 'K', side: BLACK };
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][8] = { type: 'R', side: RED };
  return {
    schemaVersion: 1,
    id: 'game-checkmate-1',
    createdAt: '2026-08-31T01:00:00.000Z',
    completedAt: '2026-08-31T01:05:00.000Z',
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
    ...overrides,
  };
}

function stalemateRecord() {
  const board = emptyBoard();
  board[9][5] = { type: 'K', side: BLACK };
  board[0][5] = { type: 'K', side: RED };
  board[4][5] = { type: 'P', side: RED };
  board[7][5] = { type: 'N', side: RED };
  board[7][0] = { type: 'R', side: RED };
  return {
    ...checkmateRecord(),
    id: 'game-stalemate-1',
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 7, c: 0 }, to: { r: 8, c: 0 } }],
    result: { winner: RED, terminationReason: 'stalemate' },
  };
}

function perpetualCheckRecord() {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[7][0] = { type: 'R', side: RED };
  board[7][4] = { type: 'K', side: BLACK };
  const cycle = [
    [{ r: 7, c: 4 }, { r: 8, c: 4 }],
    [{ r: 7, c: 0 }, { r: 8, c: 0 }],
    [{ r: 8, c: 4 }, { r: 7, c: 4 }],
    [{ r: 8, c: 0 }, { r: 7, c: 0 }],
  ];
  return {
    ...checkmateRecord(),
    id: 'game-perpetual-1',
    initialPosition: { board, sideToMove: BLACK },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    result: { winner: BLACK, terminationReason: 'perpetual-check' },
  };
}

function repetitionDrawRecord() {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[4][3] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  const cycle = [
    [{ r: 9, c: 4 }, { r: 9, c: 5 }],
    [{ r: 4, c: 3 }, { r: 5, c: 3 }],
    [{ r: 9, c: 5 }, { r: 9, c: 4 }],
    [{ r: 5, c: 3 }, { r: 4, c: 3 }],
  ];
  return {
    ...checkmateRecord(),
    id: 'game-repetition-1',
    initialPosition: { board, sideToMove: BLACK },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    result: { winner: null, terminationReason: 'threefold-repetition' },
  };
}

function mutualPerpetualCheckRecord() {
  const board = emptyBoard();
  board[0][3] = { type: 'R', side: RED };
  board[1][4] = { type: 'K', side: RED };
  board[2][4] = { type: 'C', side: RED };
  board[3][4] = { type: 'N', side: BLACK };
  board[5][6] = { type: 'N', side: BLACK };
  board[5][8] = { type: 'R', side: RED };
  board[7][4] = { type: 'C', side: BLACK };
  board[8][3] = { type: 'K', side: BLACK };
  const cycle = [
    [{ r: 3, c: 4 }, { r: 5, c: 3 }],
    [{ r: 2, c: 4 }, { r: 2, c: 3 }],
    [{ r: 5, c: 3 }, { r: 3, c: 4 }],
    [{ r: 2, c: 3 }, { r: 2, c: 4 }],
  ];
  return {
    ...checkmateRecord(),
    id: 'game-mutual-perpetual-1',
    initialPosition: { board, sideToMove: BLACK },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    result: { winner: null, terminationReason: 'mutual-perpetual-check' },
  };
}

function assertValidationError(input, code, ply) {
  const validation = validateGameRecord(input);
  assert.equal(validation.ok, false);
  assert.equal(validation.error.code, code);
  if (ply !== undefined) assert.equal(validation.error.ply, ply);
  assert.throws(
    () => createGameRecord(input),
    (error) => error instanceof GameRecordValidationError
      && error.code === code
      && (ply === undefined || error.ply === ply),
  );
}

test('exports the exact supported schema version', () => {
  assert.equal(GAME_RECORD_SCHEMA_VERSION, 1);
});

test('accepts and freezes a canonical GameRecord', () => {
  const record = createGameRecord(checkmateRecord());
  assert.equal(validateGameRecord(record).ok, true);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.initialPosition), true);
  assert.equal(Object.isFrozen(record.initialPosition.board[2][3]), true);
  assert.equal(Object.isFrozen(record.moves[0].from), true);
  assert.equal(Object.isFrozen(record.result), true);
  assert.deepEqual(Object.keys(record), [
    'schemaVersion', 'id', 'createdAt', 'completedAt', 'initialPosition', 'moves', 'mode', 'result',
  ]);
});

test('rejects null, arrays, missing fields and unsupported schema versions', () => {
  assertValidationError(null, 'INVALID_RECORD');
  assertValidationError([], 'INVALID_RECORD');
  const missing = checkmateRecord();
  delete missing.mode;
  assertValidationError(missing, 'UNEXPECTED_FIELDS');
  assertValidationError(checkmateRecord({ schemaVersion: 2 }), 'UNSUPPORTED_SCHEMA_VERSION');
});

test('rejects unexpected fields at every persisted object boundary', () => {
  assertValidationError({ ...checkmateRecord(), title: 'not allowed' }, 'UNEXPECTED_FIELDS');
  const initial = checkmateRecord();
  initial.initialPosition.variant = 'standard';
  assertValidationError(initial, 'UNEXPECTED_FIELDS');
  const piece = checkmateRecord();
  piece.initialPosition.board[2][3].texture = 'wood';
  assertValidationError(piece, 'UNEXPECTED_FIELDS');
  const move = checkmateRecord();
  move.moves[0].notation = '俥六平五';
  assertValidationError(move, 'UNEXPECTED_FIELDS', 1);
  const coordinate = checkmateRecord();
  coordinate.moves[0].from.side = RED;
  assertValidationError(coordinate, 'UNEXPECTED_FIELDS', 1);
  const result = checkmateRecord();
  result.result.score = 1;
  assertValidationError(result, 'UNEXPECTED_FIELDS');
});

test('requires a canonical nonempty identifier', () => {
  assertValidationError(checkmateRecord({ id: '' }), 'INVALID_ID');
  assertValidationError(checkmateRecord({ id: ' padded ' }), 'INVALID_ID');
  assertValidationError(checkmateRecord({ id: 12 }), 'INVALID_ID');
});

test('accepts only canonical UTC timestamps in chronological order', () => {
  for (const createdAt of [
    '2026-08-31T01:00:00Z',
    '2026-08-31T01:00:00.00Z',
    '2026-08-31T01:00:00.000+00:00',
    '2026-02-30T01:00:00.000Z',
    'not-a-date',
    123,
  ]) {
    assertValidationError(checkmateRecord({ createdAt }), 'INVALID_TIMESTAMP');
  }
  assertValidationError(checkmateRecord({
    createdAt: '2026-08-31T02:00:00.000Z',
    completedAt: '2026-08-31T01:59:59.999Z',
  }), 'INVALID_TIMESTAMP_ORDER');
  assertValidationError(checkmateRecord({ completedAt: '2026-08-31 01:05:00Z' }), 'INVALID_TIMESTAMP');
  assert.equal(validateGameRecord(checkmateRecord({
    createdAt: '2026-08-31T01:00:00.000Z',
    completedAt: '2026-08-31T01:00:00.000Z',
  })).ok, true);
});

test('accepts only the four canonical modes', () => {
  for (const mode of ['pvp', 'easy', 'medium', 'hard']) {
    assert.equal(validateGameRecord(checkmateRecord({ mode })).ok, true, mode);
  }
  for (const mode of ['analysis', 'expert', '', null]) {
    assertValidationError(checkmateRecord({ mode }), 'UNSUPPORTED_MODE');
  }
});

test('validates exact board dimensions, cells, piece types, sides and kings', () => {
  const rows = checkmateRecord();
  rows.initialPosition.board.pop();
  assertValidationError(rows, 'INVALID_BOARD_ROWS');
  const columns = checkmateRecord();
  columns.initialPosition.board[0].pop();
  assertValidationError(columns, 'INVALID_BOARD_COLUMNS');
  const cell = checkmateRecord();
  cell.initialPosition.board[1][1] = 'rook';
  assertValidationError(cell, 'INVALID_BOARD_CELL');
  const type = checkmateRecord();
  type.initialPosition.board[2][3].type = 'Q';
  assertValidationError(type, 'INVALID_PIECE_TYPE');
  const side = checkmateRecord();
  side.initialPosition.board[2][3].side = 'green';
  assertValidationError(side, 'INVALID_PIECE_SIDE');
  const noRedKing = checkmateRecord();
  noRedKing.initialPosition.board[0][4] = null;
  assertValidationError(noRedKing, 'MISSING_RED_KING');
  const duplicateBlackKing = checkmateRecord();
  duplicateBlackKing.initialPosition.board[8][4] = { type: 'K', side: BLACK };
  assertValidationError(duplicateBlackKing, 'DUPLICATE_BLACK_KING');
});

test('validates initial side, move containers and coordinate bounds', () => {
  const side = checkmateRecord();
  side.initialPosition.sideToMove = 'green';
  assertValidationError(side, 'INVALID_SIDE_TO_MOVE');
  assertValidationError(checkmateRecord({ moves: null }), 'INVALID_MOVES');
  const malformed = checkmateRecord();
  malformed.moves[0] = [];
  assertValidationError(malformed, 'INVALID_MOVE', 1);
  const fractional = checkmateRecord();
  fractional.moves[0].from.r = 2.5;
  assertValidationError(fractional, 'INVALID_COORDINATE', 1);
  const outside = checkmateRecord();
  outside.moves[0].to.c = 9;
  assertValidationError(outside, 'COORDINATE_OUT_OF_BOUNDS', 1);
});

test('rejects empty-source, wrong-side and illegal moves with exact plies', () => {
  const empty = checkmateRecord();
  empty.moves[0].from = { r: 1, c: 1 };
  assertValidationError(empty, 'EMPTY_SOURCE', 1);
  const wrong = checkmateRecord();
  wrong.moves[0].from = { r: 2, c: 4 };
  wrong.moves[0].to = { r: 3, c: 4 };
  assertValidationError(wrong, 'WRONG_SIDE', 1);
  const illegal = checkmateRecord();
  illegal.moves[0].to = { r: 3, c: 4 };
  assertValidationError(illegal, 'ILLEGAL_MOVE', 1);
});

test('validates result shape, winner and termination reason', () => {
  const malformed = checkmateRecord();
  malformed.result = null;
  assertValidationError(malformed, 'INVALID_RESULT');
  const winner = checkmateRecord();
  winner.result.winner = 'green';
  assertValidationError(winner, 'INVALID_WINNER');
  const reason = checkmateRecord();
  reason.result.terminationReason = 'resignation';
  assertValidationError(reason, 'UNSUPPORTED_TERMINATION_REASON');
});

test('derives a legal capture and notation from the pre-move board', () => {
  const snapshot = replayGameRecord(checkmateRecord(), 1);
  assert.deepEqual(snapshot.moveMetadata, [{
    ply: 1,
    side: RED,
    from: { r: 2, c: 3 },
    to: { r: 2, c: 4 },
    captured: { type: 'P', side: BLACK },
    notation: '俥六平五',
  }]);
  assert.deepEqual(snapshot.board[2][4], { type: 'R', side: RED });
  assert.equal(snapshot.board[2][3], null);
});

test('replays ply zero, an intermediate ply and the final ply', () => {
  const record = perpetualCheckRecord();
  const zero = replayGameRecord(record, 0);
  const middle = replayGameRecord(record, 4);
  const final = replayGameRecord(record, 8);
  assert.deepEqual(zero.board, record.initialPosition.board);
  assert.equal(zero.sideToMove, BLACK);
  assert.equal(zero.selectedPly, 0);
  assert.equal(zero.terminal, null);
  assert.equal(middle.selectedPly, 4);
  assert.equal(middle.sideToMove, BLACK);
  assert.deepEqual(middle.board, record.initialPosition.board);
  assert.equal(middle.terminal, null);
  assert.equal(final.selectedPly, 8);
  assert.equal(final.totalPlies, 8);
  assert.equal(final.sideToMove, BLACK);
  assert.deepEqual(final.board, record.initialPosition.board);
  assert.deepEqual(final.terminal, { winner: BLACK, terminationReason: 'perpetual-check' });
});

test('rejects invalid replay ply values', () => {
  for (const ply of [-1, 1.5, '1', null, 2]) {
    assert.throws(
      () => replayGameRecord(checkmateRecord(), ply),
      (error) => error instanceof GameRecordValidationError
        && (Number.isInteger(ply) ? error.code === 'REPLAY_PLY_OUT_OF_RANGE' : error.code === 'INVALID_REPLAY_PLY'),
    );
  }
});

test('reconstructs position hashes and repetition history prefixes', () => {
  const record = repetitionDrawRecord();
  const middle = replayGameRecord(record, 4);
  const final = replayGameRecord(record, 8);
  assert.equal(middle.positionHashes.length, 5);
  assert.equal(middle.repetitionHistory.length, 5);
  assert.equal(middle.positionHashes[0], hashBoard(record.initialPosition.board));
  assert.equal(middle.repetitionHistory[0].key, `${middle.positionHashes[0]}|black`);
  assert.equal(final.positionHashes.length, 9);
  assert.equal(final.repetitionHistory.length, 9);
  assert.equal(final.repetitionHistory.filter((entry) => entry.key === final.repetitionHistory[0].key).length, 3);
  assert.deepEqual(final.terminal, { winner: null, terminationReason: 'threefold-repetition' });
});

test('accepts every canonical engine-supported terminal reason', () => {
  for (const record of [
    checkmateRecord(),
    stalemateRecord(),
    perpetualCheckRecord(),
    repetitionDrawRecord(),
    mutualPerpetualCheckRecord(),
  ]) {
    assert.equal(validateGameRecord(record).ok, true, record.result.terminationReason);
    assert.deepEqual(replayGameRecord(record, record.moves.length).terminal, record.result);
  }
});

test('allows zero moves only when the initial position is already terminal', () => {
  const source = checkmateRecord();
  const board = clone(source.initialPosition.board);
  applyMove(board, source.moves[0].from, source.moves[0].to);
  const record = {
    ...source,
    id: 'game-initial-terminal-1',
    initialPosition: { board, sideToMove: BLACK },
    moves: [],
  };
  assert.equal(validateGameRecord(record).ok, true);
  assert.deepEqual(replayGameRecord(record, 0).terminal, record.result);
});

test('derives mutual perpetual check only when both sides check throughout the repeated cycle', () => {
  const record = mutualPerpetualCheckRecord();
  const snapshot = replayGameRecord(record, record.moves.length);
  assert.deepEqual(snapshot.terminal, { winner: null, terminationReason: 'mutual-perpetual-check' });
  assert.equal(snapshot.repetitionHistory.slice(1).every((entry) => entry.check), true);
  assert.equal(new Set(snapshot.repetitionHistory.slice(1).map((entry) => entry.mover)).size, 2);
  assert.equal(snapshot.repetitionHistory.filter((entry) => entry.key === snapshot.repetitionHistory[0].key).length, 3);
});

test('rejects nonterminal records, wrong winners and wrong reasons', () => {
  const nonterminal = {
    ...checkmateRecord(),
    id: 'unfinished',
    initialPosition: { board: initialBoard(), sideToMove: RED },
    moves: [],
  };
  assertValidationError(nonterminal, 'NONTERMINAL_RECORD');
  const winner = checkmateRecord();
  winner.result.winner = BLACK;
  assertValidationError(winner, 'RESULT_WINNER_MISMATCH');
  const reason = checkmateRecord();
  reason.result.terminationReason = 'stalemate';
  assertValidationError(reason, 'RESULT_REASON_MISMATCH');
});

test('rejects a move after the first terminal position', () => {
  const record = checkmateRecord();
  record.moves.push({ from: { r: 9, c: 4 }, to: { r: 8, c: 4 } });
  assertValidationError(record, 'MOVE_AFTER_TERMINAL', 2);
});

test('canonical record creation is deeply isolated from caller mutation', () => {
  const input = checkmateRecord();
  const record = createGameRecord(input);
  input.id = 'mutated';
  input.initialPosition.board[2][3].type = 'N';
  input.moves[0].from.r = 8;
  input.result.winner = BLACK;
  assert.equal(record.id, 'game-checkmate-1');
  assert.deepEqual(record.initialPosition.board[2][3], { type: 'R', side: RED });
  assert.deepEqual(record.moves[0].from, { r: 2, c: 3 });
  assert.equal(record.result.winner, RED);
  assert.throws(() => { record.initialPosition.board[2][3].type = 'N'; }, TypeError);
  assert.throws(() => { record.moves[0].from.r = 8; }, TypeError);
});

test('replay snapshots and repeated calls are deeply isolated', () => {
  const input = checkmateRecord();
  const first = replayGameRecord(input, 1);
  input.initialPosition.board[2][3] = null;
  input.moves[0].to.c = 8;
  assert.deepEqual(first.board[2][4], { type: 'R', side: RED });
  assert.deepEqual(first.moveMetadata[0].to, { r: 2, c: 4 });
  assert.throws(() => { first.board[2][4].type = 'N'; }, TypeError);
  assert.throws(() => { first.moveMetadata[0].captured.type = 'R'; }, TypeError);
  assert.throws(() => { first.repetitionHistory[1].check = false; }, TypeError);
  const second = replayGameRecord(checkmateRecord(), 1);
  assert.deepEqual(second.board[2][4], { type: 'R', side: RED });
  assert.deepEqual(second.moveMetadata[0].captured, { type: 'P', side: BLACK });
});

test('does not mutate a valid input during validation or replay', () => {
  const input = repetitionDrawRecord();
  const before = clone(input);
  assert.equal(validateGameRecord(input).ok, true);
  replayGameRecord(input, 3);
  assert.deepEqual(input, before);
});

test('imports canonical game.js primitives and contains no replacement rule functions', () => {
  const source = readFileSync(new URL('./game-record.js', import.meta.url), 'utf8');
  for (const imported of [
    'legalMoves', 'applyMove', 'notation', 'inCheck', 'hasAnyLegalMove', 'hashBoard', 'repetitionVerdict',
  ]) {
    assert.match(source, new RegExp(`\\b${imported}\\b`));
    assert.doesNotMatch(source, new RegExp(`function\\s+${imported}\\s*\\(`));
  }
  assert.doesNotMatch(source, /switch\s*\([^)]*\.type[^)]*\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
