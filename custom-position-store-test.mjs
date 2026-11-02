import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initialBoard, RED, BLACK } from './game.js';
import { PUZZLE_STORAGE_KEY } from './puzzle-store.js';
import { GAME_RECORD_STORAGE_KEY } from './game-record-store.js';
import { PRACTICE_ANALYTICS_KEY } from './puzzle-analytics.js';
import {
  CUSTOM_POSITION_STORAGE_KEY as KEY, CUSTOM_POSITION_STORAGE_VERSION,
  CUSTOM_POSITION_LIMIT, CUSTOM_POSITION_MAX_BYTES,
  CustomPositionStoreError, createCustomPositionStore,
} from './custom-position-store.js';

const otherKeys = [PUZZLE_STORAGE_KEY, GAME_RECORD_STORAGE_KEY, PRACTICE_ANALYTICS_KEY];
const opts = expectedRevision => ({ expectedRevision });
const input = (sideToMove = RED, title = '練習局面') => ({ title, initialBoard: initialBoard(), sideToMove });
const code = expected => error => error instanceof CustomPositionStoreError && error.code === expected;

function memory(raw = null) {
  const data = new Map(otherKeys.map(key => [key, `untouched:${key}`]));
  if (raw !== null) data.set(KEY, raw);
  const writes = [];
  return {
    data, writes,
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { writes.push(key); data.set(key, value); },
    raw() { return data.get(KEY) ?? null; },
  };
}

function harness({ raw = null, now, idFactory, factory = createCustomPositionStore } = {}) {
  const storage = memory(raw);
  let id = 0;
  let tick = 0;
  const store = factory({
    storage,
    now: now ?? (() => new Date(Date.UTC(2026, 10, 2, 0, 0, tick++)).toISOString()),
    idFactory: idFactory ?? (() => `position-${++id}`),
  });
  return { storage, store };
}

function seeded() {
  const h = harness();
  const saved = h.store.savePosition(input(), opts(0));
  return { ...h, saved, envelope: JSON.parse(h.storage.raw()) };
}

function variant(index) {
  const p = input();
  const pawns = [[3, 0], [3, 2], [3, 6], [3, 8], [6, 0], [6, 2], [6, 6], [6, 8]];
  pawns.forEach(([r, c], bit) => { if (index & (1 << bit)) p.initialBoard[r][c] = null; });
  return p;
}

function mutationCalls(store, revision, id = 'position-1') {
  return [
    () => store.savePosition(variant(1), opts(revision)),
    () => store.renamePosition(id, '新名稱', opts(revision)),
    () => store.updatePlayPreferences(id, { humanSide: BLACK, difficulty: 'hard' }, opts(revision)),
    () => store.deletePosition(id, opts(revision)),
  ];
}

function assertNoMutationOnFailure(storage, operations, expectedCode) {
  const before = storage.raw();
  const writes = storage.writes.length;
  for (const operation of operations) {
    assert.throws(operation, code(expectedCode));
    assert.equal(storage.raw(), before);
    assert.equal(storage.writes.length, writes);
  }
}

test('independent version/key and missing-key read have no writes', () => {
  const { store, storage } = harness();
  assert.equal(KEY, 'chinese-chess-training:custom-positions:v1');
  assert.equal(CUSTOM_POSITION_STORAGE_VERSION, 1);
  assert.equal(CUSTOM_POSITION_LIMIT, 100);
  assert.equal(CUSTOM_POSITION_MAX_BYTES, 1024 * 1024);
  assert.deepEqual(store.loadAll(), { positions: [], issues: [], revision: 0, writable: true });
  assert.equal(store.getPosition('missing'), null);
  assert.equal(storage.writes.length, 0);
});

for (const sideToMove of [RED, BLACK]) for (const humanSide of [RED, BLACK]) {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    test(`90-cell roundtrip: ${sideToMove} turn / ${humanSide} player / ${difficulty}`, () => {
      const { store, storage } = harness();
      const p = { ...input(sideToMove), playPreferences: { humanSide, difficulty } };
      const saved = store.savePosition(p, opts(0));
      const reloaded = createCustomPositionStore({ storage }).getPosition(saved.position.id);
      assert.equal(saved.created, true);
      assert.equal(saved.revision, 1);
      assert.equal(reloaded.sideToMove, sideToMove);
      assert.deepEqual(reloaded.playPreferences, { humanSide, difficulty });
      for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
        assert.deepEqual(reloaded.initialBoard[r][c], p.initialBoard[r][c]);
      }
      assert.equal(storage.writes.length, 1);
    });
  }
}

test('defaults are explicit per position and persistent schema has only approved fields', () => {
  const { store, storage } = harness();
  const result = store.savePosition(input(BLACK, '  黑先  '), opts(0));
  assert.deepEqual(result.position.playPreferences, { humanSide: BLACK, difficulty: 'medium' });
  assert.equal(result.position.title, '黑先');
  const envelope = JSON.parse(storage.raw());
  assert.deepEqual(Object.keys(envelope).sort(), ['positions', 'revision', 'version']);
  assert.deepEqual(Object.keys(envelope.positions[0]).sort(), [
    'id', 'title', 'initialBoard', 'sideToMove', 'createdAt', 'updatedAt', 'playPreferences',
  ].sort());
  assert.deepEqual(Object.keys(envelope.positions[0].initialBoard[0][0]).sort(), ['side', 'type']);
  assert.equal(storage.raw().includes('sourceRecordId'), false);
});

test('input, saved result, independent reads and preferences have no mutable aliases', () => {
  const { store, storage } = harness();
  const p = { ...input(), playPreferences: { humanSide: BLACK, difficulty: 'hard' } };
  const before = structuredClone(p);
  const result = store.savePosition(p, opts(0));
  const read1 = store.getPosition(result.position.id);
  const read2 = store.loadAll().positions[0];
  const serialized = storage.raw();
  for (const board of [result.position.initialBoard, read1.initialBoard, read2.initialBoard]) {
    assert.notStrictEqual(board, p.initialBoard);
    for (let r = 0; r < 10; r++) {
      assert.notStrictEqual(board[r], p.initialBoard[r]);
      for (let c = 0; c < 9; c++) if (board[r][c]) {
        assert.notStrictEqual(board[r][c], p.initialBoard[r][c]);
        assert.ok(Object.isFrozen(board[r][c]));
      }
      assert.ok(Object.isFrozen(board[r]));
    }
    assert.ok(Object.isFrozen(board));
  }
  assert.notStrictEqual(read1.initialBoard, read2.initialBoard);
  assert.notStrictEqual(read1.initialBoard[0][0], read2.initialBoard[0][0]);
  assert.throws(() => { read1.playPreferences.difficulty = 'easy'; }, TypeError);
  p.initialBoard[0][0].type = 'P'; p.initialBoard[0][1] = null;
  p.playPreferences.humanSide = RED;
  assert.deepEqual(read1.initialBoard, before.initialBoard);
  assert.deepEqual(read1.playPreferences, before.playPreferences);
  assert.equal(storage.raw(), serialized);
  assert.equal(Object.isFrozen(p.initialBoard), false);
});

test('same board plus turn deduplicates without renaming, changing preferences or touching timestamps', () => {
  const { store, storage, saved } = seeded();
  const before = storage.raw();
  const duplicate = store.savePosition({ ...input(RED, '另一名稱'), playPreferences: { humanSide: BLACK, difficulty: 'hard' } }, opts(1));
  assert.deepEqual(duplicate, { ...saved, created: false });
  assert.equal(storage.raw(), before);
  assert.equal(storage.writes.length, 1);
  assert.equal(store.savePosition(input(BLACK), opts(1)).created, true, 'different turn is a different position');
  assert.equal(store.loadAll().positions.length, 2);
});

test('rename and preferences preserve chess data/createdAt; no-ops have no writes', () => {
  const { store, storage, saved } = seeded();
  const id = saved.position.id;
  const renamed = store.renamePosition(id, '重命名', opts(1));
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.changed, true);
  assert.equal(renamed.position.createdAt, saved.position.createdAt);
  assert.ok(renamed.position.updatedAt > saved.position.updatedAt);
  const pref = { humanSide: BLACK, difficulty: 'easy' };
  const updated = store.updatePlayPreferences(id, pref, opts(2));
  pref.difficulty = 'invalid';
  assert.equal(updated.revision, 3);
  assert.deepEqual(updated.position.initialBoard, saved.position.initialBoard);
  assert.equal(updated.position.sideToMove, saved.position.sideToMove);
  const before = storage.raw();
  assert.equal(store.renamePosition(id, ' 重命名 ', opts(3)).changed, false);
  assert.equal(store.updatePlayPreferences(id, { humanSide: BLACK, difficulty: 'easy' }, opts(3)).changed, false);
  assert.equal(store.deletePosition('missing', opts(3)).deleted, false);
  assert.equal(storage.raw(), before);
  assert.equal(storage.writes.length, 3);
});

test('delete is exact and stale operations cannot resurrect a removed position', () => {
  const { store, storage, saved } = seeded();
  store.savePosition(input(BLACK), opts(1));
  const deleted = store.deletePosition(saved.position.id, opts(2));
  assert.deepEqual(deleted, { deleted: true, revision: 3 });
  assert.equal(store.getPosition(saved.position.id), null);
  assert.equal(store.loadAll().positions[0].sideToMove, BLACK);
  assertNoMutationOnFailure(storage, mutationCalls(store, 2), 'REVISION_CONFLICT');
  assertNoMutationOnFailure(storage, [
    () => store.renamePosition(saved.position.id, '復活', opts(3)),
    () => store.updatePlayPreferences(saved.position.id, { humanSide: RED, difficulty: 'easy' }, opts(3)),
  ], 'POSITION_NOT_FOUND');
});

test('every mutation requires a valid expectedRevision, even for duplicates/no-ops/missing IDs', () => {
  const { store, storage, saved } = seeded();
  for (const revision of [undefined, null, -1, 1.1, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assertNoMutationOnFailure(storage, mutationCalls(store, revision), 'INVALID_EXPECTED_REVISION');
  }
  assertNoMutationOnFailure(storage, [
    () => store.savePosition(input()),
    () => store.renamePosition(saved.position.id, saved.position.title),
    () => store.updatePlayPreferences(saved.position.id, saved.position.playPreferences),
    () => store.deletePosition('missing'),
  ], 'INVALID_EXPECTED_REVISION');
  assertNoMutationOnFailure(storage, mutationCalls(store, 0), 'REVISION_CONFLICT');
  assertNoMutationOnFailure(storage, [() => store.savePosition(input(), opts(0)), () => store.deletePosition('missing', opts(0))], 'REVISION_CONFLICT');
});

test('two store instances reject known stale revisions (not a cross-tab locking claim)', () => {
  const { store, storage } = seeded();
  const second = createCustomPositionStore({ storage });
  const observed = second.loadAll().revision;
  store.renamePosition('position-1', '第一個操作', opts(observed));
  assertNoMutationOnFailure(storage, [() => second.renamePosition('position-1', '過期操作', opts(observed))], 'REVISION_CONFLICT');
  assert.equal(second.renamePosition('position-1', '重新讀取後', opts(2)).revision, 3);
});

test('names count Unicode code points, including supplementary characters', () => {
  const { store } = harness();
  const result = store.savePosition(input(RED, '棋'.repeat(30) + '😀'.repeat(30)), opts(0));
  assert.equal([...result.position.title].length, 60);
  assert.equal(store.renamePosition(result.position.id, '😀', opts(1)).position.title, '😀');
});

for (const title of ['', '   ', '\n棋', '棋\r', '棋\t盤', '棋\0', '\u007f', '\u0085', '\u2028', '\u2029', '\u200b', '\ud800', '😀'.repeat(61), 1, null]) {
  test(`invalid title is rejected: ${JSON.stringify(title)}`, () => {
    const { store, storage, saved } = seeded();
    assertNoMutationOnFailure(storage, [
      () => store.savePosition(input(BLACK, title), opts(1)),
      () => store.renamePosition(saved.position.id, title, opts(1)),
    ], 'INVALID_TITLE');
  });
}

test('100 positions are retained; 101st is rejected without eviction; deletion frees capacity', () => {
  const { store, storage } = harness();
  for (let i = 0; i < 100; i++) assert.equal(store.savePosition(variant(i), opts(i)).revision, i + 1);
  const before = storage.raw();
  assert.equal(store.loadAll().positions.length, 100);
  assert.equal(store.savePosition(variant(0), opts(100)).created, false);
  assertNoMutationOnFailure(storage, [() => store.savePosition(variant(100), opts(100))], 'POSITION_LIMIT');
  assert.equal(storage.raw(), before);
  store.deletePosition('position-1', opts(100));
  assert.equal(store.savePosition(variant(100), opts(101)).revision, 102);
  assert.equal(store.loadAll().positions.length, 100);
});

test('ID collisions retry up to 12 times and never overwrite existing data', () => {
  const { storage } = seeded();
  let calls = 0;
  const store = createCustomPositionStore({ storage, idFactory: () => { calls++; return 'position-1'; } });
  assertNoMutationOnFailure(storage, [() => store.savePosition(input(BLACK), opts(1))], 'ID_COLLISION');
  assert.equal(calls, 12);
  calls = 0;
  const retry = createCustomPositionStore({ storage, idFactory: () => ++calls < 3 ? 'position-1' : 'position-2' });
  assert.equal(retry.savePosition(input(BLACK), opts(1)).position.id, 'position-2');
  assert.equal(calls, 3);
});

for (const id of ['', ' padded ', 1, {}, 'x'.repeat(129)]) {
  test(`invalid generated ID fails without writing: ${JSON.stringify(id)}`, () => {
    const { store, storage } = harness({ idFactory: () => id });
    assertNoMutationOnFailure(storage, [() => store.savePosition(input(), opts(0))], 'INVALID_ID');
  });
}

test('all mutation APIs touch only the custom-position key; other stores get zero writes', () => {
  const { store, storage, saved } = seeded();
  store.renamePosition(saved.position.id, '重命名', opts(1));
  store.updatePlayPreferences(saved.position.id, { humanSide: BLACK, difficulty: 'hard' }, opts(2));
  store.deletePosition(saved.position.id, opts(3));
  assert.deepEqual(storage.writes, [KEY, KEY, KEY, KEY]);
  for (const key of otherKeys) assert.equal(storage.data.get(key), `untouched:${key}`);
});

test('input whitelist rejects puzzle solutions, records, provenance and board metadata', () => {
  const { store, storage } = harness();
  for (const field of ['id', 'solution', 'moves', 'result', 'sourceRecordId', 'createdAt', 'extra']) {
    assertNoMutationOnFailure(storage, [() => store.savePosition({ ...input(), [field]: 'not allowed' }, opts(0))], 'INVALID_FIELDS');
  }
  const p = input(); p.initialBoard[0][0].metadata = {};
  assertNoMutationOnFailure(storage, [() => store.savePosition(p, opts(0))], 'INVALID_FIELDS');
  let getterCalls = 0;
  const accessor = { ...input(), get title() { getterCalls++; return '棋'; } };
  assertNoMutationOnFailure(storage, [() => store.savePosition(accessor, opts(0))], 'INVALID_FIELDS');
  assert.equal(getterCalls, 0);
});

for (const change of [
  p => p.initialBoard.pop(), p => p.initialBoard[0].pop(),
  p => { p.initialBoard[0][0] = {}; },
  p => { p.initialBoard[0][0].type = 'X'; }, p => { p.initialBoard[0][0].side = 'white'; },
  p => { p.initialBoard[0][4] = null; },
  p => { p.initialBoard[3][4] = null; p.initialBoard[6][4] = null; },
  p => { p.sideToMove = 'white'; },
]) test('illegal chess data is rejected on both save and load', () => {
  const { store, storage, envelope } = seeded();
  const p = input(); change(p);
  assertNoMutationOnFailure(storage, [() => store.savePosition(p, opts(1))], 'INVALID_POSITION');
  change(envelope.positions[0]);
  storage.data.set(KEY, JSON.stringify(envelope));
  assert.equal(store.loadAll().writable, false);
  assert.equal(store.loadAll().positions.length, 0);
  assertNoMutationOnFailure(storage, mutationCalls(store, 1), 'STORAGE_CORRUPT');
});

test('sparse in-memory boards are rejected before JSON can turn holes into empty squares', () => {
  const { store, storage } = harness();
  const p = input(); delete p.initialBoard[0][0];
  assertNoMutationOnFailure(storage, [() => store.savePosition(p, opts(0))], 'INVALID_POSITION');
});

test('terminal and nonmoving-side-in-check positions cannot be saved', () => {
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  board[0][3] = { type: 'K', side: RED }; board[9][4] = { type: 'K', side: BLACK };
  board[8][0] = { type: 'R', side: RED }; board[7][5] = { type: 'R', side: RED };
  const { store, storage } = harness();
  assertNoMutationOnFailure(storage, [() => store.savePosition({ ...input(BLACK), initialBoard: board }, opts(0))], 'INVALID_POSITION');
  const checked = initialBoard();
  checked[3][4] = { type: 'R', side: BLACK }; checked[9][0] = null;
  assertNoMutationOnFailure(storage, [() => store.savePosition({ ...input(BLACK), initialBoard: checked }, opts(0))], 'INVALID_POSITION');
});

test('preferences are revalidated on save, update and load', () => {
  for (const preferences of [null, {}, { humanSide: 'white', difficulty: 'easy' },
    { humanSide: RED, difficulty: 'pvp' }, { humanSide: RED, difficulty: 'easy', extra: true }]) {
    const { store, storage, envelope } = seeded();
    const before = storage.raw();
    assert.throws(() => store.savePosition({ ...input(BLACK), playPreferences: preferences }, opts(1)), CustomPositionStoreError);
    assert.throws(() => store.updatePlayPreferences('position-1', preferences, opts(1)), CustomPositionStoreError);
    assert.equal(storage.raw(), before);
    envelope.positions[0].playPreferences = preferences;
    storage.data.set(KEY, JSON.stringify(envelope));
    assert.equal(store.loadAll().writable, false);
    assertNoMutationOnFailure(storage, mutationCalls(store, 1), 'STORAGE_CORRUPT');
  }
});

test('invalid clocks fail safely and clock rollback preserves monotonic updatedAt', () => {
  for (const now of [() => 'yesterday', () => '2026-02-30T00:00:00.000Z', () => '2026-11-02T00:00:00Z', () => 1]) {
    const { store, storage } = harness({ now });
    assertNoMutationOnFailure(storage, [() => store.savePosition(input(), opts(0))], 'INVALID_TIMESTAMP');
    const seed = seeded();
    const editing = createCustomPositionStore({ storage: seed.storage, now });
    assertNoMutationOnFailure(seed.storage, [() => editing.renamePosition('position-1', '新名稱', opts(1))], 'INVALID_TIMESTAMP');
  }
  const { storage, saved } = seeded();
  const store = createCustomPositionStore({ storage, now: () => '2025-01-01T00:00:00.000Z' });
  const result = store.renamePosition('position-1', '時鐘回調', opts(1));
  assert.equal(result.position.updatedAt, saved.position.updatedAt);
  assert.equal(result.revision, 2);
});

for (const raw of ['', '{broken', 'null', '[]', '{}',
  '{"version":2,"revision":0,"positions":[]}',
  '{"version":1,"revision":-1,"positions":[]}',
  '{"version":1,"revision":0.5,"positions":[]}',
  '{"version":1,"revision":0,"positions":null}',
  '{"version":1,"revision":0,"positions":[],"extra":true}']) {
  test(`invalid envelope is never treated as empty writable storage: ${raw}`, () => {
    const { store, storage } = harness({ raw });
    assert.equal(store.loadAll().writable, false);
    assert.ok(store.loadAll().issues.length > 0);
    assertNoMutationOnFailure(storage, mutationCalls(store, 0), 'STORAGE_CORRUPT');
  });
}

test('stored whitelist, timestamps, count and revision overflow all fail closed', () => {
  for (const change of [
    e => { e.positions[0].solution = []; },
    e => { e.positions[0].initialBoard[0][0].extra = true; },
    e => { e.positions[0].title = ' padded '; },
    e => { delete e.positions[0].createdAt; },
    e => { e.positions[0].createdAt = 'invalid'; },
    e => { e.positions[0].updatedAt = '2026-11-01T00:00:00.000Z'; },
    e => { e.positions = Array(101).fill(e.positions[0]); },
    e => { e.revision = Number.MAX_SAFE_INTEGER + 1; },
  ]) {
    const { store, storage, envelope } = seeded();
    change(envelope); storage.data.set(KEY, JSON.stringify(envelope));
    assert.equal(store.loadAll().writable, false);
    assertNoMutationOnFailure(storage, mutationCalls(store, 1), 'STORAGE_CORRUPT');
  }
  const { store, storage, envelope } = seeded();
  envelope.revision = Number.MAX_SAFE_INTEGER; storage.data.set(KEY, JSON.stringify(envelope));
  assertNoMutationOnFailure(storage, mutationCalls(store, Number.MAX_SAFE_INTEGER), 'REVISION_EXHAUSTED');
});

test('valid records remain readable beside corruption, but ambiguous IDs cannot be selected', () => {
  const { store, storage, envelope } = seeded();
  envelope.positions.push({ ...envelope.positions[0], id: 'broken', title: '' });
  storage.data.set(KEY, JSON.stringify(envelope));
  assert.equal(store.loadAll().positions.length, 1);
  assert.equal(store.getPosition('position-1').id, 'position-1');
  assertNoMutationOnFailure(storage, mutationCalls(store, 1), 'STORAGE_CORRUPT');
  envelope.positions.push({ ...envelope.positions[0], title: '衝突' });
  storage.data.set(KEY, JSON.stringify(envelope));
  assert.ok(store.loadAll().issues.some(issue => issue.code === 'DUPLICATE_ID'));
  assert.equal(store.getPosition('position-1'), null);
  assertNoMutationOnFailure(storage, mutationCalls(store, 1), 'STORAGE_CORRUPT');
});

test('1 MiB raw UTF-8 size boundary is enforced before parsing', () => {
  const raw = JSON.stringify({ version: 1, revision: 0, positions: [] });
  const exact = raw + ' '.repeat(CUSTOM_POSITION_MAX_BYTES - Buffer.byteLength(raw));
  const { store, storage } = harness({ raw: exact });
  assert.equal(store.loadAll().writable, true);
  storage.data.set(KEY, exact + ' ');
  assert.equal(store.loadAll().issues[0].code, 'STORAGE_SIZE_LIMIT');
  assertNoMutationOnFailure(storage, mutationCalls(store, 0), 'STORAGE_CORRUPT');
  storage.data.set(KEY, '棋'.repeat(Math.floor(CUSTOM_POSITION_MAX_BYTES / 3) + 1));
  assert.equal(store.loadAll().issues[0].code, 'STORAGE_SIZE_LIMIT', 'counts bytes, not string length');
});

test('storage provider/getItem/getItem getter failures do not become empty stores', () => {
  const failure = new Error('storage blocked');
  for (const storage of [() => { throw failure; },
    { getItem() { throw failure; } }, { get getItem() { throw failure; } }, undefined]) {
    const store = createCustomPositionStore({ storage });
    const loaded = store.loadAll();
    assert.equal(loaded.writable, false);
    assert.equal(loaded.revision, null);
    assert.equal(loaded.issues[0].code, 'STORE_READ_FAILED');
    for (const call of mutationCalls(store, 0)) assert.throws(call, code('STORE_READ_FAILED'));
  }
});

test('setItem, setter getter and quota failures preserve previous serialized data for every mutation', () => {
  for (const kind of ['setItem', 'getter', 'quota']) for (let operation = 0; operation < 4; operation++) {
    const { storage } = seeded();
    const before = storage.raw();
    let attempts = 0;
    const failure = new Error('denied'); failure.name = kind === 'quota' ? 'QuotaExceededError' : 'SecurityError';
    const adapter = { getItem: key => storage.getItem(key) };
    if (kind === 'getter') Object.defineProperty(adapter, 'setItem', { get() { attempts++; throw failure; } });
    else adapter.setItem = () => { attempts++; throw failure; };
    const store = createCustomPositionStore({ storage: () => adapter });
    assert.throws(mutationCalls(store, 1)[operation], code('STORE_WRITE_FAILED'));
    assert.equal(attempts, 1, 'no retry or fallback');
    assert.equal(storage.raw(), before);
    assert.equal(store.loadAll().revision, 1);
  }
});

async function mutatedModule(before, after) {
  const url = new URL('./custom-position-store.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'exactly one production mutation site');
  const changed = source.replace(before, after).replace(/from '(\.\/[^']+)'/g,
    (_, specifier) => `from '${new URL(specifier, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

test('serialized write size guard accepts exact byte cap and rejects the next byte', async () => {
  // Legal v1 records under the 100-record cap are normally smaller than 1 MiB.
  // Lower only the constant to exercise the same production write guard.
  const control = harness(); control.store.savePosition(input(RED, 'a'), opts(0));
  const cap = Buffer.byteLength(control.storage.raw());
  const module = await mutatedModule('CUSTOM_POSITION_MAX_BYTES = 1024 * 1024;', `CUSTOM_POSITION_MAX_BYTES = ${cap};`);
  const { store, storage } = harness({ factory: module.createCustomPositionStore });
  assert.equal(store.savePosition(input(RED, 'a'), opts(0)).revision, 1);
  assert.equal(Buffer.byteLength(storage.raw()), cap);
  const before = storage.raw();
  assert.throws(() => store.renamePosition('position-1', 'aa', opts(1)), { code: 'STORAGE_SIZE_LIMIT' });
  assert.equal(storage.raw(), before);
  assert.equal(storage.writes.length, 1);
});

test('negative control: treating corrupt JSON as empty is caught by a behavior assertion', async () => {
  const mutant = await mutatedModule("fail('INVALID_JSON', 'Saved custom positions are not valid JSON.');",
    'return { version: 1, revision: 0, positions: [] };');
  const control = harness({ factory: mutant.createCustomPositionStore });
  assert.equal(control.store.savePosition(input(), opts(0)).created, true, 'mutant executes normal behavior');
  const { store, storage } = harness({ raw: '{broken', factory: mutant.createCustomPositionStore });
  store.savePosition(input(), opts(0));
  assert.throws(() => assert.equal(storage.raw(), '{broken', 'CORRUPT_BYTES_PRESERVED'),
    error => error.code === 'ERR_ASSERTION' && /CORRUPT_BYTES_PRESERVED/.test(error.message));
  assert.equal(storage.writes.length, 1, 'mutant actually overwrote corruption');
});

test('negative control: removing revision check permits stale write and fails the contract', async () => {
  const mutant = await mutatedModule('if (expectedRevision !== loaded.revision) {', 'if (false) {');
  const { store, storage } = harness({ factory: mutant.createCustomPositionStore });
  store.savePosition(input(), opts(0));
  store.renamePosition('position-1', '最新名稱', opts(1));
  const before = storage.raw();
  store.renamePosition('position-1', '過期名稱', opts(1));
  assert.throws(() => assert.equal(storage.raw(), before, 'STALE_WRITE_REJECTED'),
    error => error.code === 'ERR_ASSERTION' && /STALE_WRITE_REJECTED/.test(error.message));
  assert.equal(store.loadAll().revision, 3, 'mutant accepted an actual stale write');
});
