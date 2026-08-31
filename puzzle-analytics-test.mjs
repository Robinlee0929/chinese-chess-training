import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRACTICE_ANALYTICS_KEY,
  PRACTICE_ANALYTICS_MAX_RECENT_ATTEMPTS,
  PRACTICE_ANALYTICS_VERSION,
  PracticeAnalyticsError,
  createPracticeAnalyticsStore,
} from './puzzle-analytics.js';

const START = '2026-08-30T14:59:00.000Z';
const END = '2026-08-30T15:00:00.000Z';

function memoryStorage(initial = null, { readError = false, writeError = false } = {}) {
  let value = initial;
  let writes = 0;
  return {
    getItem() { if (readError) throw new Error('read'); return value; },
    setItem(_, next) { writes++; if (writeError) throw new Error('write'); value = next; },
    get value() { return value; },
    get writes() { return writes; },
  };
}

function completed(overrides = {}) {
  return { puzzleId: 'abc', startedAt: START, endedAt: END, outcome: 'completed', mistakes: 0, hintRequests: 0, maxHintLevel: 0, ...overrides };
}

function abandoned(overrides = {}) {
  return completed({ outcome: 'abandoned', ...overrides });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof PracticeAnalyticsError && error.code === code);
}

test('exports the exact analytics constants', () => {
  assert.equal(PRACTICE_ANALYTICS_VERSION, 1);
  assert.equal(PRACTICE_ANALYTICS_KEY, 'chinese-chess-training:practice-history:v1');
  assert.equal(PRACTICE_ANALYTICS_MAX_RECENT_ATTEMPTS, 10);
});

test('missing key loads a frozen empty envelope without writing', () => {
  const storage = memoryStorage();
  const loaded = createPracticeAnalyticsStore({ storage }).loadAll();
  assert.deepEqual(loaded, { version: 1, puzzles: [] });
  assert.equal(storage.writes, 0);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.puzzles), true);
});

test('unknown lookup and delete are null/false with zero writes', () => {
  const storage = memoryStorage();
  const store = createPracticeAnalyticsStore({ storage });
  assert.equal(store.getPuzzleAnalytics('missing'), null);
  assert.equal(store.deletePuzzleAnalytics('missing'), false);
  assert.equal(storage.writes, 0);
});

test('valid completed and abandoned attempts update lifetime aggregates', () => {
  const storage = memoryStorage();
  const store = createPracticeAnalyticsStore({ storage });
  store.recordAttempt(completed({ mistakes: 1, hintRequests: 2, maxHintLevel: 2 }));
  store.recordAttempt(abandoned({ startedAt: END, endedAt: '2026-08-30T15:01:00.000Z', mistakes: 3, hintRequests: 1, maxHintLevel: 1 }));
  const { aggregate, recentAttempts } = store.getPuzzleAnalytics('abc');
  assert.deepEqual(aggregate, {
    attemptCount: 2, completedCount: 1, abandonedCount: 1, cleanCompletionCount: 0,
    hintedCompletionCount: 1, totalMistakes: 4, totalHintRequests: 3,
    lastAttemptAt: '2026-08-30T15:01:00.000Z', lastCompletedAt: END,
  });
  assert.equal(recentAttempts[0].outcome, 'abandoned');
  assert.equal(recentAttempts[1].outcome, 'completed');
});

test('clean completion requires zero mistakes and zero hints', () => {
  const store = createPracticeAnalyticsStore({ storage: memoryStorage() });
  store.recordAttempt(completed());
  store.recordAttempt(completed({ startedAt: END, endedAt: '2026-08-30T15:01:00.000Z', mistakes: 1 }));
  store.recordAttempt(completed({ startedAt: END, endedAt: '2026-08-30T15:02:00.000Z', hintRequests: 1, maxHintLevel: 1 }));
  const aggregate = store.getPuzzleAnalytics('abc').aggregate;
  assert.equal(aggregate.attemptCount, 3);
  assert.equal(aggregate.completedCount, 3);
  assert.equal(aggregate.abandonedCount, 0);
  assert.equal(aggregate.cleanCompletionCount, 1);
  assert.equal(aggregate.hintedCompletionCount, 1);
  assert.equal(aggregate.totalMistakes, 1);
  assert.equal(aggregate.totalHintRequests, 1);
  assert.equal(aggregate.lastCompletedAt, '2026-08-30T15:02:00.000Z');
});

for (const [label, patch, code] of [
  ['empty puzzle ID', { puzzleId: '' }, 'INVALID_PUZZLE_ID'],
  ['edge-whitespace puzzle ID', { puzzleId: ' abc' }, 'INVALID_PUZZLE_ID'],
  ['invalid start', { startedAt: 'bad' }, 'INVALID_TIMESTAMP'],
  ['invalid end', { endedAt: 'bad' }, 'INVALID_TIMESTAMP'],
  ['noncanonical parseable timestamp', { startedAt: '2026-08-30T14:59:00Z' }, 'INVALID_TIMESTAMP'],
  ['end before start', { endedAt: '2026-08-30T14:58:00.000Z' }, 'INVALID_TIMESTAMP'],
  ['invalid outcome', { outcome: 'quit' }, 'INVALID_OUTCOME'],
  ['negative mistakes', { mistakes: -1 }, 'INVALID_COUNT'],
  ['fractional mistakes', { mistakes: 0.5 }, 'INVALID_COUNT'],
  ['negative hint requests', { hintRequests: -1 }, 'INVALID_COUNT'],
  ['invalid max hint level', { hintRequests: 1, maxHintLevel: 5 }, 'INVALID_HINT_LEVEL'],
  ['hint level without request', { maxHintLevel: 1 }, 'INVALID_HINT_LEVEL'],
  ['request without hint level', { hintRequests: 1 }, 'INVALID_HINT_LEVEL'],
  ['extra move-level field', { moves: [] }, 'INVALID_ATTEMPT'],
]) {
  test(`rejects ${label} without writing`, () => {
    const storage = memoryStorage();
    expectCode(() => createPracticeAnalyticsStore({ storage }).recordAttempt(completed(patch)), code);
    assert.equal(storage.writes, 0);
  });
}

test('recent-attempt eviction preserves every lifetime aggregate from mixed attempts', () => {
  const store = createPracticeAnalyticsStore({ storage: memoryStorage() });
  const attempts = [
    { outcome: 'completed', mistakes: 0, hintRequests: 0, maxHintLevel: 0 },
    { outcome: 'completed', mistakes: 7, hintRequests: 2, maxHintLevel: 2 },
    { outcome: 'abandoned', mistakes: 3, hintRequests: 1, maxHintLevel: 1 },
    { outcome: 'completed', mistakes: 4, hintRequests: 0, maxHintLevel: 0 },
    { outcome: 'abandoned', mistakes: 5, hintRequests: 0, maxHintLevel: 0 },
    { outcome: 'completed', mistakes: 6, hintRequests: 3, maxHintLevel: 3 },
    { outcome: 'completed', mistakes: 0, hintRequests: 0, maxHintLevel: 0 },
    { outcome: 'abandoned', mistakes: 8, hintRequests: 2, maxHintLevel: 2 },
    { outcome: 'completed', mistakes: 9, hintRequests: 1, maxHintLevel: 1 },
    { outcome: 'abandoned', mistakes: 10, hintRequests: 0, maxHintLevel: 0 },
    { outcome: 'completed', mistakes: 11, hintRequests: 4, maxHintLevel: 4 },
    { outcome: 'completed', mistakes: 12, hintRequests: 0, maxHintLevel: 0 },
  ];
  attempts.forEach((attempt, offset) => {
    const index = offset + 1;
    const minute = String(index).padStart(2, '0');
    store.recordAttempt(completed({
      ...attempt,
      startedAt: `2026-08-30T15:${minute}:00.000Z`,
      endedAt: `2026-08-30T15:${minute}:30.000Z`,
    }));
    const current = store.getPuzzleAnalytics('abc');
    assert.equal(current.recentAttempts.length, Math.min(index, PRACTICE_ANALYTICS_MAX_RECENT_ATTEMPTS));
  });
  const current = store.getPuzzleAnalytics('abc');
  assert.deepEqual(current.aggregate, {
    attemptCount: 12,
    completedCount: 8,
    abandonedCount: 4,
    cleanCompletionCount: 2,
    hintedCompletionCount: 4,
    totalMistakes: 75,
    totalHintRequests: 13,
    lastAttemptAt: '2026-08-30T15:12:30.000Z',
    lastCompletedAt: '2026-08-30T15:12:30.000Z',
  });
  assert.equal(current.recentAttempts.length, PRACTICE_ANALYTICS_MAX_RECENT_ATTEMPTS);
  assert.deepEqual(
    current.recentAttempts.map((attempt) => attempt.endedAt),
    Array.from({ length: 10 }, (_, offset) => `2026-08-30T15:${String(12 - offset).padStart(2, '0')}:30.000Z`),
  );
  assert.equal(current.recentAttempts[0].outcome, 'completed');
  assert.equal(current.recentAttempts.at(-1).outcome, 'abandoned');
});

test('successful record performs exactly one write and snapshots caller data', () => {
  const storage = memoryStorage();
  const store = createPracticeAnalyticsStore({ storage });
  const attempt = completed();
  const result = store.recordAttempt(attempt);
  attempt.mistakes = 99;
  assert.equal(storage.writes, 1);
  assert.equal(result.recentAttempts[0].mistakes, 0);
  assert.equal(store.getPuzzleAnalytics('abc').recentAttempts[0].mistakes, 0);
});

test('write failure makes no fallback write', () => {
  const storage = memoryStorage(null, { writeError: true });
  expectCode(() => createPracticeAnalyticsStore({ storage }).recordAttempt(completed()), 'STORE_WRITE_FAILED');
  assert.equal(storage.writes, 1);
});

test('read failure is stable and performs no write', () => {
  const storage = memoryStorage(null, { readError: true });
  expectCode(() => createPracticeAnalyticsStore({ storage }).recordAttempt(completed()), 'STORE_READ_FAILED');
  assert.equal(storage.writes, 0);
});

for (const [label, serialized, loadCode] of [
  ['invalid JSON', '{', 'INVALID_JSON'],
  ['missing version', JSON.stringify({ puzzles: [] }), 'MISSING_VERSION'],
  ['unsupported version', JSON.stringify({ version: 2, puzzles: [] }), 'UNSUPPORTED_VERSION'],
  ['invalid root', JSON.stringify([]), 'INVALID_ROOT'],
  ['puzzles not array', JSON.stringify({ version: 1, puzzles: {} }), 'INVALID_PUZZLES'],
]) {
  test(`${label} fails closed`, () => {
    const storage = memoryStorage(serialized);
    const store = createPracticeAnalyticsStore({ storage });
    expectCode(() => store.loadAll(), loadCode);
    expectCode(() => store.recordAttempt(completed()), 'STORAGE_CORRUPT');
    assert.equal(storage.writes, 0);
  });
}

test('duplicate IDs, malformed aggregate, malformed recent attempt and impossible invariant fail closed', () => {
  const validStorage = memoryStorage();
  const seedStore = createPracticeAnalyticsStore({ storage: validStorage });
  seedStore.recordAttempt(completed());
  const valid = JSON.parse(validStorage.value);
  const cases = [
    { ...valid, puzzles: [valid.puzzles[0], valid.puzzles[0]] },
    { ...valid, puzzles: [{ ...valid.puzzles[0], aggregate: {} }] },
    { ...valid, puzzles: [{ ...valid.puzzles[0], recentAttempts: [{ bad: true }] }] },
    { ...valid, puzzles: [{ ...valid.puzzles[0], aggregate: { ...valid.puzzles[0].aggregate, attemptCount: 9 } }] },
  ];
  for (const envelope of cases) {
    const storage = memoryStorage(JSON.stringify(envelope));
    expectCode(() => createPracticeAnalyticsStore({ storage }).recordAttempt(completed()), 'STORAGE_CORRUPT');
    assert.equal(storage.writes, 0);
  }
});

test('public values are deeply frozen and future reads are isolated', () => {
  const store = createPracticeAnalyticsStore({ storage: memoryStorage() });
  const result = store.recordAttempt(completed());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.aggregate), true);
  assert.equal(Object.isFrozen(result.recentAttempts), true);
  assert.equal(Object.isFrozen(result.recentAttempts[0]), true);
  assert.throws(() => { result.aggregate.attemptCount = 99; }, TypeError);
  assert.throws(() => { result.recentAttempts[0].mistakes = 99; }, TypeError);
  assert.equal(store.getPuzzleAnalytics('abc').aggregate.attemptCount, 1);
});

test('deleting exact analytics preserves other puzzles and writes once', () => {
  const storage = memoryStorage();
  const store = createPracticeAnalyticsStore({ storage });
  store.recordAttempt(completed({ puzzleId: 'a' }));
  store.recordAttempt(completed({ puzzleId: 'b' }));
  const beforeDelete = storage.writes;
  assert.equal(store.deletePuzzleAnalytics('a'), true);
  assert.equal(storage.writes, beforeDelete + 1);
  assert.equal(store.getPuzzleAnalytics('a'), null);
  assert.equal(store.getPuzzleAnalytics('b').aggregate.attemptCount, 1);
  const beforeMissing = storage.writes;
  assert.equal(store.deletePuzzleAnalytics('a'), false);
  assert.equal(storage.writes, beforeMissing);
});

test('serialized analytics are compact and contain no forbidden content fields', () => {
  const storage = memoryStorage();
  createPracticeAnalyticsStore({ storage }).recordAttempt(completed({ mistakes: 2, hintRequests: 3, maxHintLevel: 2 }));
  for (const forbidden of ['board', 'solution', 'moves', 'from', 'to', 'notation', 'title', 'notes', 'photo', 'hintHistory']) {
    assert.equal(Object.hasOwn(JSON.parse(storage.value).puzzles[0], forbidden), false);
    assert.equal(storage.value.includes(`"${forbidden}"`), false);
  }
});
