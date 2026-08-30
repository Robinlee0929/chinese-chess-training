import assert from 'node:assert/strict';
import { RED, BLACK } from './game.js';
import { validatePuzzle, isCheckmateAfterSolution } from './puzzle-domain.js';
import {
  PUZZLE_STORAGE_KEY,
  PUZZLE_STORAGE_VERSION,
  PuzzleStoreError,
  createPuzzleStore,
} from './puzzle-store.js';

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

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    dump(key = PUZZLE_STORAGE_KEY) { return data.get(key); },
  };
}

function matePuzzle(title = '三步殺') {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  board[9][4] = { type: 'K', side: BLACK };
  board[0][3] = { type: 'K', side: RED };
  board[8][0] = { type: 'R', side: RED };
  board[6][8] = { type: 'R', side: RED };
  board[5][3] = { type: 'P', side: RED };
  board[3][0] = { type: 'P', side: RED };
  board[5][6] = { type: 'P', side: RED };
  board[6][6] = { type: 'P', side: BLACK };
  return {
    title,
    initialBoard: board,
    sideToMove: RED,
    solution: [
      { side: RED, from: { r: 3, c: 0 }, to: { r: 4, c: 0 } },
      { side: BLACK, from: { r: 6, c: 6 }, to: { r: 5, c: 6 } },
      { side: RED, from: { r: 6, c: 8 }, to: { r: 9, c: 8 } },
    ],
    tags: ['車殺'],
    notes: '測試題目',
  };
}

function makeStore(storage = memoryStorage(), options = {}) {
  let id = 0;
  let tick = 0;
  return createPuzzleStore({
    storage,
    idFactory: options.idFactory || (() => `puzzle-${++id}`),
    now: options.now || (() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()),
  });
}

function savedFixture() {
  const storage = memoryStorage();
  const store = makeStore(storage);
  const saved = store.savePuzzle(matePuzzle());
  return { storage, store, saved };
}

function rawEnvelope(storage) {
  return JSON.parse(storage.dump());
}

function setEnvelope(storage, envelope) {
  storage.setItem(PUZZLE_STORAGE_KEY, JSON.stringify(envelope));
}

test('empty store loads empty library', () => {
  assert.deepEqual(makeStore().loadAll(), { puzzles: [], issues: [] });
});

test('save valid puzzle', () => {
  assert.equal(savedFixture().store.listPuzzles().length, 1);
});

test('saved puzzle gets stable ID', () => {
  const { storage, saved } = savedFixture();
  assert.equal(saved.id, 'puzzle-1');
  assert.equal(makeStore(storage).getPuzzle(saved.id).id, saved.id);
});

test('title is persisted', () => {
  assert.equal(savedFixture().store.listPuzzles()[0].title, '三步殺');
});

test('initialBoard is persisted', () => {
  const { store } = savedFixture();
  assert.deepEqual(store.listPuzzles()[0].initialBoard, matePuzzle().initialBoard);
});

test('sideToMove is persisted', () => {
  assert.equal(savedFixture().store.listPuzzles()[0].sideToMove, RED);
});

test('solution is persisted', () => {
  assert.deepEqual(savedFixture().store.listPuzzles()[0].solution, matePuzzle().solution);
});

test('save is deeply isolated from input', () => {
  const storage = memoryStorage();
  const store = makeStore(storage);
  const input = matePuzzle();
  store.savePuzzle(input);
  input.initialBoard[0][3].type = 'R';
  input.solution[0].from.r = 9;
  input.tags[0] = 'changed';
  const loaded = store.listPuzzles()[0];
  assert.deepEqual(loaded.initialBoard[0][3], { type: 'K', side: RED });
  assert.deepEqual(loaded.solution[0].from, { r: 3, c: 0 });
  assert.deepEqual(loaded.tags, ['車殺']);
});

test('load is deeply isolated', () => {
  const { store } = savedFixture();
  const first = store.listPuzzles()[0];
  first.initialBoard[0][3].type = 'R';
  first.solution[0].to.r = 9;
  assert.deepEqual(store.listPuzzles()[0].initialBoard[0][3], { type: 'K', side: RED });
  assert.deepEqual(store.listPuzzles()[0].solution[0].to, { r: 4, c: 0 });
});

test('multiple puzzles are stored', () => {
  const storage = memoryStorage();
  const store = makeStore(storage);
  store.savePuzzle(matePuzzle('第一題'));
  store.savePuzzle(matePuzzle('第二題'));
  assert.deepEqual(store.listPuzzles().map(({ title }) => title), ['第一題', '第二題']);
});

test('get puzzle by ID', () => {
  const { store, saved } = savedFixture();
  assert.equal(store.getPuzzle(saved.id).title, '三步殺');
});

test('unknown ID returns null', () => {
  assert.equal(savedFixture().store.getPuzzle('missing'), null);
});

test('update puzzle metadata', () => {
  const { store, saved } = savedFixture();
  const updated = store.updatePuzzleMetadata(saved.id, {
    title: '更名殺局', tags: ['入門'], notes: '新的筆記',
  });
  assert.equal(updated.title, '更名殺局');
  assert.deepEqual(updated.tags, ['入門']);
  assert.equal(updated.notes, '新的筆記');
  assert.notEqual(updated.updatedAt, saved.updatedAt);
});

test('metadata update does not mutate chess data', () => {
  const { store, saved } = savedFixture();
  const updated = store.updatePuzzleMetadata(saved.id, { title: '只改標題' });
  assert.deepEqual(updated.initialBoard, saved.initialBoard);
  assert.deepEqual(updated.solution, saved.solution);
  assert.equal(updated.sideToMove, saved.sideToMove);
});

test('delete removes exact puzzle', () => {
  const storage = memoryStorage();
  const store = makeStore(storage);
  const first = store.savePuzzle(matePuzzle('第一題'));
  const second = store.savePuzzle(matePuzzle('第二題'));
  assert.equal(store.deletePuzzle(first.id), true);
  assert.deepEqual(store.listPuzzles().map(({ id }) => id), [second.id]);
});

test('delete unknown puzzle is safe', () => {
  const { store } = savedFixture();
  assert.equal(store.deletePuzzle('missing'), false);
  assert.equal(store.listPuzzles().length, 1);
});

test('practiceCount increments', () => {
  const { store, saved } = savedFixture();
  assert.equal(store.markPracticeStarted(saved.id).practiceCount, 1);
});

test('completedCount increments', () => {
  const { store, saved } = savedFixture();
  assert.equal(store.markPracticeCompleted(saved.id).completedCount, 1);
});

test('lastPracticedAt updates', () => {
  const { store, saved } = savedFixture();
  const practiced = store.markPracticeStarted(saved.id);
  assert.notEqual(practiced.lastPracticedAt, saved.lastPracticedAt);
  assert.equal(practiced.lastPracticedAt, practiced.updatedAt);
});

test('invalid JSON is handled without mutation', () => {
  const storage = memoryStorage({ [PUZZLE_STORAGE_KEY]: '{broken' });
  const result = makeStore(storage).loadAll();
  assert.equal(result.puzzles.length, 0);
  assert.equal(result.issues[0].code, 'INVALID_JSON');
  assert.equal(storage.dump(), '{broken');
});

test('missing schema version is handled', () => {
  const storage = memoryStorage({ [PUZZLE_STORAGE_KEY]: JSON.stringify({ puzzles: [] }) });
  assert.equal(makeStore(storage).loadAll().issues[0].code, 'MISSING_VERSION');
});

test('unsupported schema version is handled', () => {
  const storage = memoryStorage({ [PUZZLE_STORAGE_KEY]: JSON.stringify({ version: 99, puzzles: [] }) });
  assert.equal(makeStore(storage).loadAll().issues[0].code, 'UNSUPPORTED_VERSION');
});

for (const [label, version] of [
  ['object', {}], ['null', null], ['array', []], ['array containing an object', [{ toString: null }]],
  ['non-callable toString', { toString: null }],
  ['hostile-looking toString', { toString: 'throw new Error("must not execute")', valueOf: null }],
  ['unsupported number', 99], ['unsupported string', '1'], ['unsupported boolean', true],
]) {
  test(`${label} version reports corruption without coercion or writeback`, () => {
    const serialized = JSON.stringify({ version, puzzles: [] });
    let writes = 0;
    const store = makeStore({ getItem: () => serialized, setItem() { writes++; } });
    const result = store.loadAll();
    assert.deepEqual(result.puzzles, []);
    assert.equal(result.issues[0].code, 'UNSUPPORTED_VERSION');
    for (const action of [
      () => store.savePuzzle(matePuzzle()),
      () => store.deletePuzzle('existing'),
      () => store.updatePuzzleMetadata('existing', { title: 'changed' }),
      () => store.markPracticeStarted('existing'),
      () => store.markPracticeCompleted('existing'),
    ]) assert.throws(action, { name: 'PuzzleStoreError', code: 'STORAGE_CORRUPT' });
    assert.equal(writes, 0);
  });
}

test('supported numeric version still loads a valid saved puzzle without writeback', () => {
  const { storage, saved } = savedFixture();
  const serialized = storage.dump();
  let writes = 0;
  const store = makeStore({ getItem: () => serialized, setItem() { writes++; } });
  assert.deepEqual(store.loadAll(), { puzzles: [saved], issues: [] });
  assert.equal(writes, 0);
});

test('malformed puzzles array is handled', () => {
  const storage = memoryStorage({
    [PUZZLE_STORAGE_KEY]: JSON.stringify({ version: PUZZLE_STORAGE_VERSION, puzzles: {} }),
  });
  assert.equal(makeStore(storage).loadAll().issues[0].code, 'PUZZLES_NOT_ARRAY');
});

test('invalid saved puzzle is skipped', () => {
  const storage = memoryStorage();
  setEnvelope(storage, { version: PUZZLE_STORAGE_VERSION, puzzles: [{ id: 'bad' }] });
  const result = makeStore(storage).loadAll();
  assert.equal(result.puzzles.length, 0);
  assert.equal(result.issues.length, 1);
});

test('duplicate IDs keep first record deterministically', () => {
  const { storage, saved } = savedFixture();
  setEnvelope(storage, { version: PUZZLE_STORAGE_VERSION, puzzles: [saved, { ...saved, title: '重複' }] });
  const result = makeStore(storage).loadAll();
  assert.equal(result.puzzles.length, 1);
  assert.equal(result.puzzles[0].title, saved.title);
  assert.equal(result.issues[0].code, 'DUPLICATE_ID');
});

test('one malformed record does not hide valid records', () => {
  const { storage, saved } = savedFixture();
  setEnvelope(storage, { version: PUZZLE_STORAGE_VERSION, puzzles: [{ id: 'bad' }, saved] });
  const result = makeStore(storage).loadAll();
  assert.equal(result.puzzles.length, 1);
  assert.equal(result.puzzles[0].id, saved.id);
  assert.equal(result.issues.length, 1);
});

test('browser-style serialization round-trip', () => {
  const { storage, saved } = savedFixture();
  const envelope = JSON.parse(storage.dump());
  assert.equal(envelope.version, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(makeStore(storage).getPuzzle(saved.id))), saved);
});

test('checkmate remains valid after round-trip', () => {
  const { store, saved } = savedFixture();
  const loaded = store.getPuzzle(saved.id);
  const domain = {
    id: loaded.id,
    title: loaded.title,
    initialBoard: loaded.initialBoard,
    sideToMove: loaded.sideToMove,
    solution: loaded.solution,
  };
  assert.equal(validatePuzzle(domain).ok, true);
  assert.equal(isCheckmateAfterSolution(domain), true);
});

test('empty title cannot be saved', () => {
  const puzzle = matePuzzle('');
  assert.throws(() => makeStore().savePuzzle(puzzle), (error) => (
    error instanceof PuzzleStoreError && error.code === 'EMPTY_TITLE'
  ));
});

test('corrupt storage is not overwritten by mutation', () => {
  const storage = memoryStorage({ [PUZZLE_STORAGE_KEY]: '{broken' });
  assert.throws(() => makeStore(storage).savePuzzle(matePuzzle()), (error) => (
    error instanceof PuzzleStoreError && error.code === 'STORAGE_CORRUPT'
  ));
  assert.equal(storage.dump(), '{broken');
});

test('unavailable storage reads fail safely without an uncaught exception', () => {
  const store = makeStore({ getItem() { throw new Error('SecurityError'); }, setItem() {} });
  assert.deepEqual(store.loadAll().puzzles, []);
  assert.equal(store.loadAll().issues[0].code, 'STORE_READ_FAILED');
});

test('unavailable storage cannot be mistaken for an empty writable library', () => {
  let writes = 0;
  const store = makeStore({
    getItem() { throw new Error('SecurityError'); },
    setItem() { writes++; },
  });
  assert.throws(() => store.savePuzzle(matePuzzle()), (error) => (
    error instanceof PuzzleStoreError && error.code === 'STORE_READ_FAILED'
  ));
  assert.equal(writes, 0);
});

test('quota failure preserves the existing serialized library', () => {
  const { storage, saved } = savedFixture();
  const before = storage.dump();
  const store = makeStore({ getItem: storage.getItem, setItem() { throw new Error('QuotaExceededError'); } });
  assert.throws(() => store.markPracticeStarted(saved.id), { code: 'STORE_WRITE_FAILED' });
  assert.equal(storage.dump(), before);
});

test('only canonical chess fields persist, including inside board pieces', () => {
  const storage = memoryStorage();
  const input = matePuzzle();
  const transient = { sourceImage: 'data:image/png;base64,PRIVATE', templates: [{ pixels: [1, 2, 3] }] };
  Object.assign(input, transient, { calibration: { corners: [] }, recognition: { patches: [] } });
  input.initialBoard[0][3].photo = transient;
  input.solution[0].patch = transient;
  const saved = makeStore(storage).savePuzzle(input);
  assert.deepEqual(saved.initialBoard[0][3], { type: 'K', side: RED });
  assert.equal(storage.dump().includes('PRIVATE'), false);
  assert.equal(storage.dump().includes('templates'), false);
  assert.equal(storage.dump().includes('calibration'), false);
  assert.equal(storage.dump().includes('recognition'), false);
  transient.templates[0].pixels[0] = 999;
  assert.equal(storage.dump().includes('999'), false);
});

function importable(id, title = `匯入 ${id}`) {
  return { id, ...matePuzzle(title) };
}

function trackedStorage(initial = {}) {
  const storage = memoryStorage(initial);
  let writes = 0;
  return {
    getItem: storage.getItem,
    setItem(key, value) { writes++; storage.setItem(key, value); },
    dump: storage.dump,
    resetWrites() { writes = 0; },
    get writes() { return writes; },
  };
}

test('atomic multi-record import preserves IDs, data and one shared timestamp in one write', () => {
  const storage = trackedStorage();
  const timestamp = '2026-08-30T12:34:56.000Z';
  const store = makeStore(storage, { now: () => timestamp });
  const first = importable('import-1');
  const second = importable('import-2');
  const result = store.importPuzzles([first, second]);
  assert.deepEqual(result, {
    importedCount: 2, skippedCount: 0,
    importedIds: ['import-1', 'import-2'], skippedIds: [],
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.importedIds), true);
  assert.equal(storage.writes, 1);
  const records = store.listPuzzles();
  assert.deepEqual(records.map(({ id }) => id), ['import-1', 'import-2']);
  for (const [record, input] of records.map((record, index) => [record, [first, second][index]])) {
    assert.equal(record.createdAt, timestamp);
    assert.equal(record.updatedAt, timestamp);
    assert.equal(record.practiceCount, 0);
    assert.equal(record.completedCount, 0);
    assert.equal(record.lastPracticedAt, null);
    assert.deepEqual(record.initialBoard, input.initialBoard);
    assert.deepEqual(record.solution, input.solution);
    assert.deepEqual(record.tags, input.tags);
    assert.equal(record.notes, input.notes);
  }
});

test('import preserves canonical portable text and note edge whitespace across reload', () => {
  const storage = trackedStorage();
  const store = makeStore(storage, { now: () => '2026-08-30T12:34:56.000Z' });
  const input = importable('exact-id', 'Unicode 殺局 🐉');
  input.tags = ['次序二', '次序一', ''];
  input.notes = '  第一行\n第二行  ';
  store.importPuzzles([input]);
  const reloaded = makeStore(storage).getPuzzle('exact-id');
  assert.equal(reloaded.id, 'exact-id');
  assert.equal(reloaded.title, 'Unicode 殺局 🐉');
  assert.deepEqual(reloaded.tags, ['次序二', '次序一', '']);
  assert.equal(reloaded.notes, '  第一行\n第二行  ');
});

test('direct import rejects noncanonical identifier text before reading or writing', () => {
  let reads = 0;
  let writes = 0;
  const store = makeStore({ getItem() { reads++; return null; }, setItem() { writes++; } });
  const cases = [
    [Object.assign(importable('canonical'), { id: ' canonical ' }), 'INVALID_ID'],
    [Object.assign(importable('canonical'), { title: ' 非標準 ' }), 'EMPTY_TITLE'],
    [Object.assign(importable('canonical'), { tags: [' 車殺'] }), 'INVALID_TAGS'],
  ];
  for (const [input, code] of cases) {
    assert.throws(() => store.importPuzzles([input]), { name: 'PuzzleStoreError', code });
  }
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('existing ID collision is skipped without overwrite or write when all collide', () => {
  const storage = trackedStorage();
  const store = makeStore(storage, { idFactory: () => 'existing-id' });
  const existing = store.savePuzzle(matePuzzle('原題'));
  const before = storage.dump();
  storage.resetWrites();
  const collision = importable(existing.id, '不得覆寫');
  const result = store.importPuzzles([collision]);
  assert.deepEqual(result, {
    importedCount: 0, skippedCount: 1,
    importedIds: [], skippedIds: [existing.id],
  });
  assert.equal(storage.writes, 0);
  assert.equal(storage.dump(), before);
  assert.equal(store.getPuzzle(existing.id).title, '原題');
});

test('mixed collision imports only new records in one write', () => {
  const storage = trackedStorage();
  const store = makeStore(storage, { idFactory: () => 'existing-id' });
  const existing = store.savePuzzle(matePuzzle('原題'));
  storage.resetWrites();
  const result = store.importPuzzles([
    importable(existing.id, '不得覆寫'), importable('new-id', '新題'),
  ]);
  assert.deepEqual(result, {
    importedCount: 1, skippedCount: 1,
    importedIds: ['new-id'], skippedIds: [existing.id],
  });
  assert.equal(storage.writes, 1);
  assert.deepEqual(store.listPuzzles().map(({ id }) => id), [existing.id, 'new-id']);
  assert.equal(store.getPuzzle(existing.id).title, '原題');
});

test('duplicate incoming IDs reject before reading or writing storage', () => {
  let reads = 0;
  let writes = 0;
  const store = makeStore({ getItem() { reads++; return null; }, setItem() { writes++; } });
  assert.throws(() => store.importPuzzles([
    importable('duplicate'), importable('duplicate'),
  ]), { name: 'PuzzleStoreError', code: 'DUPLICATE_ID' });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('empty import performs no read and no write', () => {
  let reads = 0;
  let writes = 0;
  const store = makeStore({ getItem() { reads++; return null; }, setItem() { writes++; } });
  assert.deepEqual(store.importPuzzles([]), {
    importedCount: 0, skippedCount: 0, importedIds: [], skippedIds: [],
  });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('all imported puzzles validate before any existing storage read', () => {
  let reads = 0;
  let writes = 0;
  const store = makeStore({ getItem() { reads++; return null; }, setItem() { writes++; } });
  const invalid = importable('invalid');
  invalid.solution[0].to = { r: 5, c: 5 };
  assert.throws(() => store.importPuzzles([importable('valid'), invalid]), {
    name: 'PuzzleStoreError', code: 'INVALID_PUZZLE',
  });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});

test('corrupt or unavailable storage blocks import without writes', () => {
  let writes = 0;
  const corrupt = makeStore({ getItem: () => '{broken', setItem() { writes++; } });
  assert.throws(() => corrupt.importPuzzles([importable('new')]), {
    name: 'PuzzleStoreError', code: 'STORAGE_CORRUPT',
  });
  const unavailable = makeStore({ getItem() { throw new Error('SecurityError'); }, setItem() { writes++; } });
  assert.throws(() => unavailable.importPuzzles([importable('new')]), {
    name: 'PuzzleStoreError', code: 'STORE_READ_FAILED',
  });
  assert.equal(writes, 0);
});

test('failed final import write has no fallback and preserves prior serialization', () => {
  const { storage, saved } = savedFixture();
  const before = storage.dump();
  let writes = 0;
  const store = makeStore({
    getItem: storage.getItem,
    setItem() { writes++; throw new Error('QuotaExceededError'); },
  });
  assert.throws(() => store.importPuzzles([importable('new-id')]), {
    name: 'PuzzleStoreError', code: 'STORE_WRITE_FAILED',
  });
  assert.equal(writes, 1);
  assert.equal(storage.dump(), before);
  assert.equal(makeStore(storage).getPuzzle(saved.id).title, saved.title);
});

test('import is deeply isolated and persists canonical fields only', () => {
  const storage = trackedStorage();
  const store = makeStore(storage);
  const input = importable('isolated');
  input.photo = { bytes: 'PRIVATE' };
  input.initialBoard[0][3].sourceImage = 'PRIVATE';
  input.solution[0].recognition = { pixels: [1] };
  store.importPuzzles([input]);
  input.initialBoard[0][3].type = 'R';
  input.solution[0].from.r = 9;
  input.tags[0] = 'changed';
  const loaded = store.getPuzzle('isolated');
  assert.deepEqual(loaded.initialBoard[0][3], { type: 'K', side: RED });
  assert.deepEqual(loaded.solution[0].from, { r: 3, c: 0 });
  assert.deepEqual(loaded.tags, ['車殺']);
  assert.equal(storage.dump().includes('PRIVATE'), false);
  assert.equal(storage.dump().includes('recognition'), false);
});

console.log(`\n${passed} puzzle-store tests passed; ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
