import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUZZLE_TRANSFER_FORMAT,
  PUZZLE_TRANSFER_SCHEMA_VERSION,
  PUZZLE_TRANSFER_PUZZLE_VERSION,
  PUZZLE_TRANSFER_MAX_BYTES,
  PUZZLE_TRANSFER_MAX_PUZZLES,
  PuzzleTransferError,
  serializePuzzleExport,
  parsePuzzleImport,
} from './puzzle-transfer.js';

const EXPORTED_AT = '2026-08-30T01:02:03.000Z';

function matePuzzle(id = 'transfer-1', title = '三步殺') {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const [r, c, side, type] of [
    [9, 4, 'black', 'K'], [0, 3, 'red', 'K'], [8, 0, 'red', 'R'],
    [6, 8, 'red', 'R'], [5, 3, 'red', 'P'], [3, 0, 'red', 'P'],
    [5, 6, 'red', 'P'], [6, 6, 'black', 'P'], [9, 8, 'black', 'P'],
  ]) board[r][c] = { side, type };
  return {
    id,
    title,
    initialBoard: board,
    sideToMove: 'red',
    solution: [
      { side: 'red', from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
      { side: 'black', from: { r: 6, c: 6 }, to: { r: 5, c: 6 } },
      { side: 'red', from: { r: 6, c: 8 }, to: { r: 9, c: 8 } },
    ],
    tags: ['車殺', '入門'],
    notes: '測試題目',
  };
}

function portable(record) {
  return {
    puzzleVersion: PUZZLE_TRANSFER_PUZZLE_VERSION,
    id: record.id,
    title: record.title,
    initialBoard: structuredClone(record.initialBoard),
    sideToMove: record.sideToMove,
    solution: structuredClone(record.solution),
    tags: [...record.tags],
    notes: record.notes,
  };
}

function envelope(puzzles, updates = {}) {
  return {
    format: PUZZLE_TRANSFER_FORMAT,
    schemaVersion: PUZZLE_TRANSFER_SCHEMA_VERSION,
    exportedAt: EXPORTED_AT,
    puzzles: puzzles.map(portable),
    ...updates,
  };
}

function parseEnvelope(puzzles, updates) {
  return parsePuzzleImport(JSON.stringify(envelope(puzzles, updates)));
}

function expectCode(code, fn) {
  assert.throws(fn, (error) => error instanceof PuzzleTransferError && error.code === code);
}

test('exports one puzzle with canonical fields, injected timestamp and terminating LF', () => {
  const input = { ...matePuzzle(), createdAt: 'private', practiceCount: 9, photo: 'private' };
  const text = serializePuzzleExport([input], { now: () => EXPORTED_AT });
  assert.equal(text.endsWith('\n'), true);
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['format', 'schemaVersion', 'exportedAt', 'puzzles']);
  assert.deepEqual(Object.keys(parsed.puzzles[0]), [
    'puzzleVersion', 'id', 'title', 'initialBoard', 'sideToMove', 'solution', 'tags', 'notes',
  ]);
  assert.equal(parsed.exportedAt, EXPORTED_AT);
  assert.equal(text.includes('practiceCount'), false);
  assert.equal(text.includes('createdAt'), false);
  assert.equal(text.includes('photo'), false);
});

test('exports multiple puzzles in supplied order and deterministically', () => {
  const inputs = [matePuzzle('second', '第二題'), matePuzzle('first', '第一題')];
  const first = serializePuzzleExport(inputs, { now: () => EXPORTED_AT });
  const second = serializePuzzleExport(inputs, { now: () => EXPORTED_AT });
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(first).puzzles.map(({ id }) => id), ['second', 'first']);
});

test('Unicode metadata round trips semantically and uses UTF-8 bytes', () => {
  const input = matePuzzle('unicode', '<車殺> 🐉');
  input.tags = ['將死', '中文', ''];
  input.notes = '  <img src=x onerror=alert(1)> 只是文字\n  ';
  const text = serializePuzzleExport([input], { now: () => EXPORTED_AT });
  assert.ok(new TextEncoder().encode(text).byteLength > text.length);
  const [roundTrip] = parsePuzzleImport(text);
  assert.deepEqual(roundTrip, portable(input));
  assert.equal(roundTrip.title, '<車殺> 🐉');
  assert.deepEqual(roundTrip.tags, ['將死', '中文', '']);
  assert.equal(roundTrip.notes, '  <img src=x onerror=alert(1)> 只是文字\n  ');
  assert.equal(roundTrip.notes.includes('onerror'), true);
});

test('serialization snapshots caller data and excludes nested arbitrary fields', () => {
  const input = matePuzzle();
  input.initialBoard[0][3].sourceImage = 'private';
  input.solution[0].recognition = { pixels: [1] };
  input.templates = [{ private: true }];
  input.calibration = { corners: [] };
  const text = serializePuzzleExport([input], { now: () => EXPORTED_AT });
  input.initialBoard[0][3].type = 'R';
  input.solution[0].from.r = 9;
  input.tags[0] = 'changed';
  const parsed = JSON.parse(text).puzzles[0];
  assert.deepEqual(parsed.initialBoard[0][3], { type: 'K', side: 'red' });
  assert.deepEqual(parsed.solution[0].from, { r: 3, c: 0 });
  assert.deepEqual(parsed.tags, ['車殺', '入門']);
  for (const field of ['sourceImage', 'recognition', 'templates', 'calibration']) {
    assert.equal(text.includes(field), false);
  }
});

test('parsed records are deeply frozen and isolated', () => {
  const source = envelope([matePuzzle()]);
  const parsed = parsePuzzleImport(JSON.stringify(source));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed[0]), true);
  assert.equal(Object.isFrozen(parsed[0].initialBoard[0]), true);
  assert.equal(Object.isFrozen(parsed[0].initialBoard[0][3]), true);
  assert.equal(Object.isFrozen(parsed[0].solution[0].from), true);
  source.puzzles[0].initialBoard[0][3].type = 'R';
  assert.equal(parsed[0].initialBoard[0][3].type, 'K');
  assert.throws(() => { parsed[0].notes = 'changed'; }, TypeError);
});

test('empty puzzle arrays are accepted', () => {
  assert.deepEqual(parsePuzzleImport(JSON.stringify(envelope([]))), []);
});

test('invalid JSON and invalid root shapes have stable codes', () => {
  expectCode('INVALID_JSON', () => parsePuzzleImport('{broken'));
  for (const root of [null, [], 'text', 42]) {
    expectCode('INVALID_ROOT', () => parsePuzzleImport(JSON.stringify(root)));
  }
  expectCode('INVALID_ROOT', () => parsePuzzleImport(JSON.stringify({ ...envelope([]), extra: true })));
  expectCode('INVALID_ROOT', () => parsePuzzleImport(JSON.stringify({ format: PUZZLE_TRANSFER_FORMAT })));
});

test('format, schema and puzzle version errors are distinct', () => {
  expectCode('UNSUPPORTED_FORMAT', () => parsePuzzleImport(JSON.stringify(envelope([], { format: 'other' }))));
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => parsePuzzleImport(JSON.stringify(envelope([], { schemaVersion: 2 }))));
  const transfer = envelope([matePuzzle()]);
  transfer.puzzles[0].puzzleVersion = 2;
  expectCode('UNSUPPORTED_PUZZLE_VERSION', () => parsePuzzleImport(JSON.stringify(transfer)));
});

test('import accepts only canonical millisecond UTC exportedAt timestamps', () => {
  assert.deepEqual(parsePuzzleImport(JSON.stringify(envelope([]))), []);
  for (const exportedAt of [
    'August 30, 2026',
    '08/30/2026',
    '2026-08-30',
    '2026-08-30T00:00:00Z',
    '2026-08-30T08:00:00+08:00',
    '2026-02-30T00:00:00.000Z',
    '',
    null,
    42,
    'not-a-date',
  ]) {
    expectCode('INVALID_EXPORTED_AT', () => parsePuzzleImport(
      JSON.stringify(envelope([], { exportedAt })),
    ));
  }
});

test('injected export timestamp must be canonical and timestamp errors stay wrapped', () => {
  assert.equal(JSON.parse(serializePuzzleExport([], { now: () => EXPORTED_AT })).exportedAt, EXPORTED_AT);
  for (const exportedAt of [
    'August 30, 2026',
    '08/30/2026',
    '2026-08-30',
    '2026-08-30T00:00:00Z',
    '2026-08-30T08:00:00+08:00',
    '2026-02-30T00:00:00.000Z',
    '',
    null,
    42,
    'not-a-date',
  ]) {
    expectCode('INVALID_EXPORTED_AT', () => serializePuzzleExport([], { now: () => exportedAt }));
  }
  expectCode('INVALID_EXPORTED_AT', () => serializePuzzleExport([], {
    now: () => { throw new RangeError('clock failure'); },
  }));
});

test('identifier-like portable fields reject edge whitespace before acceptance', () => {
  for (const mutate of [
    (record) => { record.id = ' transfer-1 '; },
    (record) => { record.title = ' 三步殺 '; },
    (record) => { record.tags = ['車殺', ' 入門']; },
  ]) {
    const transfer = envelope([matePuzzle()]);
    mutate(transfer.puzzles[0]);
    expectCode('INVALID_PUZZLE', () => parsePuzzleImport(JSON.stringify(transfer)));

    const record = matePuzzle();
    mutate(record);
    expectCode('INVALID_PUZZLE', () => serializePuzzleExport([record], { now: () => EXPORTED_AT }));
  }
});

test('noncanonical puzzle fields are rejected', () => {
  const transfer = envelope([matePuzzle()]);
  transfer.puzzles[0].practiceCount = 5;
  expectCode('INVALID_PUZZLE', () => parsePuzzleImport(JSON.stringify(transfer)));
});

test('malformed board, move, side and illegal solution are invalid puzzles', () => {
  const cases = [];
  const malformedBoard = matePuzzle('bad-board'); malformedBoard.initialBoard = [];
  cases.push(malformedBoard);
  const malformedMove = matePuzzle('bad-move'); malformedMove.solution[0].from = null;
  cases.push(malformedMove);
  const badSide = matePuzzle('bad-side'); badSide.sideToMove = 'blue';
  cases.push(badSide);
  const illegal = matePuzzle('illegal'); illegal.solution[0].to = { r: 5, c: 5 };
  cases.push(illegal);
  for (const puzzle of cases) expectCode('INVALID_PUZZLE', () => parseEnvelope([puzzle]));
});

test('valid non-mating solution is rejected separately', () => {
  const puzzle = matePuzzle('nonmate');
  puzzle.solution = puzzle.solution.slice(0, 1);
  expectCode('NOT_CHECKMATE', () => parseEnvelope([puzzle]));
});

test('duplicate IDs within a transfer reject the whole file', () => {
  expectCode('DUPLICATE_ID', () => parseEnvelope([matePuzzle('same'), matePuzzle('same')]));
  expectCode('DUPLICATE_ID', () => serializePuzzleExport(
    [matePuzzle('same'), matePuzzle('same')], { now: () => EXPORTED_AT },
  ));
});

test('exactly 1000 compact puzzles are accepted and 1001 are rejected', () => {
  const thousand = Array.from({ length: PUZZLE_TRANSFER_MAX_PUZZLES }, (_, index) => matePuzzle(`p-${index}`));
  const compact = JSON.stringify(envelope(thousand));
  assert.ok(new TextEncoder().encode(compact).byteLength <= PUZZLE_TRANSFER_MAX_BYTES);
  assert.equal(parsePuzzleImport(compact).length, PUZZLE_TRANSFER_MAX_PUZZLES);
  const tooMany = JSON.stringify(envelope([...thousand, matePuzzle('p-1000')]));
  expectCode('TOO_MANY_PUZZLES', () => parsePuzzleImport(tooMany));
});

test('UTF-8 byte limit accepts exact limit and rejects one byte over', () => {
  const base = JSON.stringify(envelope([]));
  const baseBytes = new TextEncoder().encode(base).byteLength;
  const exact = base + ' '.repeat(PUZZLE_TRANSFER_MAX_BYTES - baseBytes);
  assert.equal(new TextEncoder().encode(exact).byteLength, PUZZLE_TRANSFER_MAX_BYTES);
  assert.deepEqual(parsePuzzleImport(exact), []);
  expectCode('TOO_LARGE', () => parsePuzzleImport(`${exact} `));
});

test('Unicode byte count, not JavaScript length, enforces the limit', () => {
  const base = JSON.stringify(envelope([]));
  const count = Math.floor((PUZZLE_TRANSFER_MAX_BYTES - new TextEncoder().encode(base).byteLength) / 3) + 1;
  const text = `${base}${'界'.repeat(count)}`;
  assert.ok(text.length < PUZZLE_TRANSFER_MAX_BYTES);
  assert.ok(new TextEncoder().encode(text).byteLength > PUZZLE_TRANSFER_MAX_BYTES);
  expectCode('TOO_LARGE', () => parsePuzzleImport(text));
});

test('export rejects invalid timestamp, invalid/non-mating records and oversized record count', () => {
  expectCode('INVALID_PUZZLE', () => serializePuzzleExport([{ id: 'bad' }], { now: () => EXPORTED_AT }));
  const nonmate = matePuzzle(); nonmate.solution = nonmate.solution.slice(0, 1);
  expectCode('NOT_CHECKMATE', () => serializePuzzleExport([nonmate], { now: () => EXPORTED_AT }));
  expectCode('TOO_MANY_PUZZLES', () => serializePuzzleExport(
    Array.from({ length: PUZZLE_TRANSFER_MAX_PUZZLES + 1 }, () => matePuzzle()),
    { now: () => EXPORTED_AT },
  ));
});
