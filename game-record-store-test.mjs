import assert from 'node:assert/strict';
import test from 'node:test';
import { RED, BLACK } from './game.js';
import {
  GAME_RECORD_STORAGE_KEY,
  GAME_RECORD_STORAGE_VERSION,
  GAME_RECORD_RETENTION_LIMIT,
  GameRecordStoreError,
  createGameRecordStore,
} from './game-record-store.js';

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function gameRecord({
  id = 'game-001',
  createdAt = '2026-08-31T01:00:00.000Z',
  completedAt = '2026-08-31T01:05:00.000Z',
  mode = 'pvp',
} = {}) {
  const board = emptyBoard();
  board[9][4] = { type: 'K', side: BLACK };
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][8] = { type: 'R', side: RED };
  return {
    schemaVersion: 1,
    id,
    createdAt,
    completedAt,
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode,
    result: { winner: RED, terminationReason: 'checkmate' },
  };
}

function memoryStorage(initial = null, { readError = null, writeError = null } = {}) {
  let serialized = initial;
  let reads = 0;
  let writes = 0;
  return {
    getItem() {
      reads++;
      if (readError) throw readError;
      return serialized;
    },
    setItem(_key, value) {
      writes++;
      if (writeError) throw writeError;
      serialized = value;
    },
    get reads() { return reads; },
    get writes() { return writes; },
    get serialized() { return serialized; },
  };
}

function expectStoreError(fn, code) {
  assert.throws(fn, (error) => error instanceof GameRecordStoreError && error.code === code);
}

function timestamp(day, minute = 0) {
  return new Date(Date.UTC(2026, 0, day, 0, minute)).toISOString();
}

test('exports the exact independent storage contract', () => {
  assert.equal(GAME_RECORD_STORAGE_KEY, 'chinese-chess-training:game-records:v1');
  assert.equal(GAME_RECORD_STORAGE_VERSION, 1);
  assert.equal(GAME_RECORD_RETENTION_LIMIT, 100);
});

test('missing storage key loads an immutable empty store without writing', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  const loaded = store.loadAll();
  assert.deepEqual(loaded.records, []);
  assert.deepEqual(loaded.issues, []);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.records), true);
  assert.equal(storage.writes, 0);
});

test('loads one valid record and multiple records in deterministic oldest-first order', () => {
  const later = gameRecord({
    id: 'later', createdAt: timestamp(2), completedAt: timestamp(4),
  });
  const earlier = gameRecord({
    id: 'earlier', createdAt: timestamp(1), completedAt: timestamp(3),
  });
  const storage = memoryStorage(JSON.stringify({ version: 1, records: [later, earlier] }));
  const store = createGameRecordStore({ storage });
  assert.deepEqual(store.listGameRecords().map((record) => record.id), ['earlier', 'later']);
  assert.equal(store.getGameRecord('later').id, 'later');
  assert.equal(store.getGameRecord('missing'), null);
  assert.equal(storage.writes, 0);
});

test('load/list/get results are deeply isolated and immutable', () => {
  const source = gameRecord();
  const storage = memoryStorage(JSON.stringify({ version: 1, records: [source] }));
  const store = createGameRecordStore({ storage });
  const first = store.loadAll();
  assert.throws(() => { first.records[0].initialPosition.board[2][3].type = 'N'; }, TypeError);
  assert.throws(() => { first.records[0].moves[0].from.r = 8; }, TypeError);
  assert.throws(() => { first.records[0].result.winner = BLACK; }, TypeError);
  const second = store.loadAll();
  assert.deepEqual(second.records[0].initialPosition.board[2][3], { type: 'R', side: RED });
  assert.deepEqual(second.records[0].moves[0].from, { r: 2, c: 3 });
  assert.equal(second.records[0].result.winner, RED);
  assert.notEqual(first.records[0], second.records[0]);
});

test('saves canonical records and isolates persisted data from caller mutation', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  const input = gameRecord();
  const saved = store.saveGameRecord(input);
  input.initialPosition.board[2][3].type = 'N';
  input.moves[0].to.c = 8;
  input.result.winner = BLACK;
  assert.equal(storage.writes, 1);
  assert.deepEqual(saved.evictedIds, []);
  assert.equal(Object.isFrozen(saved.record), true);
  const loaded = store.listGameRecords()[0];
  assert.deepEqual(loaded.initialPosition.board[2][3], { type: 'R', side: RED });
  assert.deepEqual(loaded.moves[0].to, { r: 2, c: 4 });
  assert.equal(loaded.result.winner, RED);
});

test('invalid GameRecord is rejected by the canonical domain before storage mutation', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  const invalid = gameRecord();
  invalid.moves[0].notation = 'not persisted';
  expectStoreError(() => store.saveGameRecord(invalid), 'INVALID_GAME_RECORD');
  assert.equal(storage.reads, 0);
  assert.equal(storage.writes, 0);
});

test('identical same-ID save is idempotent with zero second write', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  const first = store.saveGameRecord(gameRecord());
  const serialized = storage.serialized;
  const second = store.saveGameRecord(structuredClone(first.record));
  assert.equal(storage.writes, 1);
  assert.equal(storage.serialized, serialized);
  assert.deepEqual(second.evictedIds, []);
  assert.equal(store.listGameRecords().length, 1);
});

test('same ID with different canonical data fails closed without overwrite', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  store.saveGameRecord(gameRecord());
  const serialized = storage.serialized;
  expectStoreError(() => store.saveGameRecord(gameRecord({ mode: 'easy' })), 'ID_CONFLICT');
  assert.equal(storage.writes, 1);
  assert.equal(storage.serialized, serialized);
  assert.equal(store.listGameRecords()[0].mode, 'pvp');
});

test('saves multiple unique records and deletes only the exact ID', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  store.saveGameRecord(gameRecord({ id: 'a' }));
  store.saveGameRecord(gameRecord({ id: 'b' }));
  assert.deepEqual(store.listGameRecords().map((record) => record.id), ['a', 'b']);
  assert.equal(store.deleteGameRecord('a'), true);
  assert.deepEqual(store.listGameRecords().map((record) => record.id), ['b']);
  const writes = storage.writes;
  assert.equal(store.deleteGameRecord('missing'), false);
  assert.equal(storage.writes, writes);
});

test('retains exactly 100 records and the 101st save evicts completedAt-oldest', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  for (let index = 0; index < 100; index++) {
    store.saveGameRecord(gameRecord({
      id: `game-${String(index).padStart(3, '0')}`,
      createdAt: timestamp(1, index),
      completedAt: timestamp(2, index),
    }));
  }
  const result = store.saveGameRecord(gameRecord({
    id: 'game-100', createdAt: timestamp(3), completedAt: timestamp(4),
  }));
  assert.deepEqual(result.evictedIds, ['game-000']);
  const records = store.listGameRecords();
  assert.equal(records.length, 100);
  assert.equal(records.some((record) => record.id === 'game-000'), false);
  assert.equal(records.some((record) => record.id === 'game-100'), true);
});

test('retention uses createdAt as the second deterministic tie-break', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  const completedAt = timestamp(5);
  for (let index = 0; index < 100; index++) {
    store.saveGameRecord(gameRecord({
      id: `created-${String(index).padStart(3, '0')}`,
      createdAt: timestamp(1, index),
      completedAt,
    }));
  }
  const result = store.saveGameRecord(gameRecord({
    id: 'created-new', createdAt: timestamp(2), completedAt,
  }));
  assert.deepEqual(result.evictedIds, ['created-000']);
});

test('retention uses ID as the final deterministic tie-break', () => {
  const storage = memoryStorage();
  const store = createGameRecordStore({ storage });
  const createdAt = timestamp(1);
  const completedAt = timestamp(2);
  for (let index = 0; index < 100; index++) {
    store.saveGameRecord(gameRecord({
      id: `id-${String(index).padStart(3, '0')}`, createdAt, completedAt,
    }));
  }
  const result = store.saveGameRecord(gameRecord({ id: 'id-100', createdAt, completedAt }));
  assert.deepEqual(result.evictedIds, ['id-000']);
});

for (const [name, serialized, code] of [
  ['malformed JSON', '{', 'INVALID_JSON'],
  ['wrong envelope type', '[]', 'MISSING_VERSION'],
  ['missing version', '{"records":[]}', 'MISSING_VERSION'],
  ['unsupported version', '{"version":2,"records":[]}', 'UNSUPPORTED_VERSION'],
  ['malformed records array', '{"version":1,"records":{}}', 'RECORDS_NOT_ARRAY'],
]) {
  test(`${name} reports corruption without destructive rewrite`, () => {
    const storage = memoryStorage(serialized);
    const store = createGameRecordStore({ storage });
    const loaded = store.loadAll();
    assert.deepEqual(loaded.records, []);
    assert.equal(loaded.issues[0].code, code);
    assert.equal(storage.writes, 0);
    assert.equal(storage.serialized, serialized);
    expectStoreError(() => store.saveGameRecord(gameRecord()), 'STORAGE_CORRUPT');
    expectStoreError(() => store.deleteGameRecord('anything'), 'STORAGE_CORRUPT');
    assert.equal(storage.writes, 0);
    assert.equal(storage.serialized, serialized);
  });
}

test('valid records remain readable beside malformed records but mutation fails closed', () => {
  const valid = gameRecord();
  const invalid = structuredClone(valid);
  invalid.id = 'invalid';
  invalid.moves[0].from.r = -1;
  const serialized = JSON.stringify({ version: 1, records: [valid, invalid] });
  const storage = memoryStorage(serialized);
  const store = createGameRecordStore({ storage });
  const loaded = store.loadAll();
  assert.deepEqual(loaded.records.map((record) => record.id), ['game-001']);
  assert.equal(loaded.issues.length, 1);
  assert.equal(loaded.issues[0].code, 'INVALID_GAME_RECORD');
  expectStoreError(() => store.saveGameRecord(gameRecord({ id: 'new' })), 'STORAGE_CORRUPT');
  expectStoreError(() => store.deleteGameRecord('game-001'), 'STORAGE_CORRUPT');
  assert.equal(storage.writes, 0);
  assert.equal(storage.serialized, serialized);
});

test('duplicate stored IDs are explicit corruption and block mutation', () => {
  const record = gameRecord();
  const serialized = JSON.stringify({ version: 1, records: [record, record] });
  const storage = memoryStorage(serialized);
  const store = createGameRecordStore({ storage });
  const loaded = store.loadAll();
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.issues[0].code, 'DUPLICATE_ID');
  expectStoreError(() => store.saveGameRecord(gameRecord({ id: 'new' })), 'STORAGE_CORRUPT');
  assert.equal(storage.writes, 0);
});

test('read failure has a stable issue and every mutation fails with zero writes', () => {
  const storage = memoryStorage(null, { readError: new Error('blocked') });
  const store = createGameRecordStore({ storage });
  assert.equal(store.loadAll().issues[0].code, 'STORE_READ_FAILED');
  expectStoreError(() => store.saveGameRecord(gameRecord()), 'STORE_READ_FAILED');
  expectStoreError(() => store.deleteGameRecord('game-001'), 'STORE_READ_FAILED');
  assert.equal(storage.writes, 0);
});

test('quota/write failure preserves prior serialization and performs no retry', () => {
  const prior = JSON.stringify({ version: 1, records: [gameRecord({ id: 'prior' })] });
  const storage = memoryStorage(prior, { writeError: new Error('quota') });
  const store = createGameRecordStore({ storage });
  expectStoreError(() => store.saveGameRecord(gameRecord({ id: 'next' })), 'STORE_WRITE_FAILED');
  assert.equal(storage.writes, 1);
  assert.equal(storage.serialized, prior);
});

test('invalid storage adapters and retention overrides are rejected', () => {
  expectStoreError(() => createGameRecordStore({ storage: null }), 'INVALID_STORAGE');
  expectStoreError(() => createGameRecordStore({ storage: memoryStorage(), retentionLimit: 99 }), 'INVALID_RETENTION_LIMIT');
});
