export const PRACTICE_ANALYTICS_VERSION = 1;
export const PRACTICE_ANALYTICS_KEY = 'chinese-chess-training:practice-history:v1';
export const PRACTICE_ANALYTICS_MAX_RECENT_ATTEMPTS = 10;

const OUTCOMES = new Set(['completed', 'abandoned']);
const ROOT_FIELDS = Object.freeze(['version', 'puzzles']);
const PUZZLE_FIELDS = Object.freeze(['puzzleId', 'aggregate', 'recentAttempts']);
const AGGREGATE_FIELDS = Object.freeze([
  'attemptCount', 'completedCount', 'abandonedCount', 'cleanCompletionCount',
  'hintedCompletionCount', 'totalMistakes', 'totalHintRequests', 'lastAttemptAt',
  'lastCompletedAt',
]);
const INPUT_ATTEMPT_FIELDS = Object.freeze([
  'puzzleId', 'startedAt', 'endedAt', 'outcome', 'mistakes', 'hintRequests', 'maxHintLevel',
]);
const STORED_ATTEMPT_FIELDS = Object.freeze(INPUT_ATTEMPT_FIELDS.filter((field) => field !== 'puzzleId'));
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class PracticeAnalyticsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PracticeAnalyticsError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function createPracticeAnalyticsStore({
  storage,
  key = PRACTICE_ANALYTICS_KEY,
  now = () => new Date().toISOString(),
} = {}) {
  requireStorage(storage);
  requirePuzzleId(key, 'INVALID_STORAGE', 'Analytics storage key must be a nonempty canonical string.');
  if (typeof now !== 'function') fail('INVALID_STORAGE', 'Analytics clock must be a function.');

  function loadAll() {
    let serialized;
    try {
      serialized = storage.getItem(key);
    } catch {
      fail('STORE_READ_FAILED', 'Unable to read practice analytics.');
    }
    if (serialized === null) return freezeEnvelope(emptyEnvelope());
    if (typeof serialized !== 'string') fail('INVALID_ROOT', 'Analytics storage must contain JSON text.');
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      fail('INVALID_JSON', 'Practice analytics are not valid JSON.');
    }
    return freezeEnvelope(validateEnvelope(parsed));
  }

  function getPuzzleAnalytics(puzzleId) {
    requirePuzzleId(puzzleId);
    const entry = loadAll().puzzles.find((candidate) => candidate.puzzleId === puzzleId);
    return entry || null;
  }

  function recordAttempt(attempt) {
    const loaded = loadForMutation();
    const validAttempt = validateAttempt(attempt, true);
    const records = loaded.puzzles.map(clonePuzzleAnalytics);
    const index = records.findIndex((entry) => entry.puzzleId === validAttempt.puzzleId);
    const current = index < 0 ? emptyPuzzleAnalytics(validAttempt.puzzleId) : records[index];
    const next = applyAttempt(current, validAttempt);
    if (index < 0) records.push(next);
    else records[index] = next;
    records.sort((a, b) => (a.puzzleId < b.puzzleId ? -1 : a.puzzleId > b.puzzleId ? 1 : 0));
    writeEnvelope({ version: PRACTICE_ANALYTICS_VERSION, puzzles: records });
    return freezePuzzleAnalytics(next);
  }

  function deletePuzzleAnalytics(puzzleId) {
    requirePuzzleId(puzzleId);
    const loaded = loadForMutation();
    const records = loaded.puzzles.filter((entry) => entry.puzzleId !== puzzleId).map(clonePuzzleAnalytics);
    if (records.length === loaded.puzzles.length) return false;
    writeEnvelope({ version: PRACTICE_ANALYTICS_VERSION, puzzles: records });
    return true;
  }

  function loadForMutation() {
    try {
      return loadAll();
    } catch (error) {
      if (!(error instanceof PracticeAnalyticsError) || error.code === 'STORE_READ_FAILED') throw error;
      fail('STORAGE_CORRUPT', 'Stored practice analytics are corrupt.', { causeCode: error.code });
    }
  }

  function writeEnvelope(envelope) {
    const validated = validateEnvelope(envelope);
    const serialized = JSON.stringify(validated);
    try {
      storage.setItem(key, serialized);
    } catch {
      fail('STORE_WRITE_FAILED', 'Unable to write practice analytics.');
    }
  }

  return Object.freeze({ loadAll, getPuzzleAnalytics, recordAttempt, deletePuzzleAnalytics, now });
}

function emptyEnvelope() {
  return { version: PRACTICE_ANALYTICS_VERSION, puzzles: [] };
}

function emptyPuzzleAnalytics(puzzleId) {
  return {
    puzzleId,
    aggregate: {
      attemptCount: 0,
      completedCount: 0,
      abandonedCount: 0,
      cleanCompletionCount: 0,
      hintedCompletionCount: 0,
      totalMistakes: 0,
      totalHintRequests: 0,
      lastAttemptAt: null,
      lastCompletedAt: null,
    },
    recentAttempts: [],
  };
}

function validateEnvelope(value) {
  if (!plainObject(value) || !hasExactFields(value, ROOT_FIELDS)) {
    if (plainObject(value) && !Object.hasOwn(value, 'version')) fail('MISSING_VERSION', 'Analytics version is required.');
    fail('INVALID_ROOT', 'Analytics root must contain only version and puzzles.');
  }
  if (value.version !== PRACTICE_ANALYTICS_VERSION) fail('UNSUPPORTED_VERSION', 'Analytics version is unsupported.');
  if (!Array.isArray(value.puzzles)) fail('INVALID_PUZZLES', 'Analytics puzzles must be an array.');
  const seen = new Set();
  const puzzles = value.puzzles.map((entry) => {
    const valid = validatePuzzleAnalytics(entry);
    if (seen.has(valid.puzzleId)) fail('DUPLICATE_PUZZLE_ID', `Duplicate analytics puzzle ID: ${valid.puzzleId}`);
    seen.add(valid.puzzleId);
    return valid;
  });
  return { version: PRACTICE_ANALYTICS_VERSION, puzzles };
}

function validatePuzzleAnalytics(value) {
  if (!plainObject(value) || !hasExactFields(value, PUZZLE_FIELDS)) {
    fail('INVALID_ROOT', 'Puzzle analytics entry is malformed.');
  }
  const puzzleId = requirePuzzleId(value.puzzleId);
  const aggregate = validateAggregate(value.aggregate);
  if (!Array.isArray(value.recentAttempts) || value.recentAttempts.length > PRACTICE_ANALYTICS_MAX_RECENT_ATTEMPTS) {
    fail('INVALID_ATTEMPT', 'Recent attempts must be a bounded array.');
  }
  const recentAttempts = value.recentAttempts.map((attempt) => validateAttempt(attempt, false));
  if (recentAttempts.length > aggregate.attemptCount) fail('INVALID_AGGREGATE', 'Recent attempts exceed lifetime attempts.');
  for (let index = 1; index < recentAttempts.length; index += 1) {
    if (recentAttempts[index - 1].endedAt < recentAttempts[index].endedAt) {
      fail('INVALID_ATTEMPT', 'Recent attempts must be newest first.');
    }
  }
  return { puzzleId, aggregate, recentAttempts };
}

function validateAggregate(value) {
  if (!plainObject(value) || !hasExactFields(value, AGGREGATE_FIELDS)) {
    fail('INVALID_AGGREGATE', 'Analytics aggregate is malformed.');
  }
  const aggregate = {};
  for (const field of AGGREGATE_FIELDS.slice(0, 7)) aggregate[field] = requireCount(value[field]);
  if (aggregate.attemptCount !== aggregate.completedCount + aggregate.abandonedCount
    || aggregate.cleanCompletionCount > aggregate.completedCount
    || aggregate.hintedCompletionCount > aggregate.completedCount) {
    fail('INVALID_AGGREGATE', 'Analytics aggregate counters are inconsistent.');
  }
  if (aggregate.attemptCount === 0) {
    if (value.lastAttemptAt !== null || aggregate.completedCount !== 0 || value.lastCompletedAt !== null) {
      fail('INVALID_AGGREGATE', 'Empty analytics aggregate has timestamps or completions.');
    }
    aggregate.lastAttemptAt = null;
  } else {
    aggregate.lastAttemptAt = requireTimestamp(value.lastAttemptAt);
  }
  if (aggregate.completedCount === 0) {
    if (value.lastCompletedAt !== null) fail('INVALID_AGGREGATE', 'Uncompleted analytics cannot have a completion timestamp.');
    aggregate.lastCompletedAt = null;
  } else {
    aggregate.lastCompletedAt = requireTimestamp(value.lastCompletedAt);
  }
  return aggregate;
}

function validateAttempt(value, includePuzzleId) {
  const fields = includePuzzleId ? INPUT_ATTEMPT_FIELDS : STORED_ATTEMPT_FIELDS;
  if (!plainObject(value) || !hasExactFields(value, fields)) fail('INVALID_ATTEMPT', 'Attempt summary has noncanonical fields.');
  const attempt = {};
  if (includePuzzleId) attempt.puzzleId = requirePuzzleId(value.puzzleId);
  attempt.startedAt = requireTimestamp(value.startedAt);
  attempt.endedAt = requireTimestamp(value.endedAt);
  if (attempt.endedAt < attempt.startedAt) fail('INVALID_TIMESTAMP', 'Attempt end precedes attempt start.');
  if (!OUTCOMES.has(value.outcome)) fail('INVALID_OUTCOME', 'Attempt outcome must be completed or abandoned.');
  attempt.outcome = value.outcome;
  attempt.mistakes = requireCount(value.mistakes);
  attempt.hintRequests = requireCount(value.hintRequests);
  if (!Number.isInteger(value.maxHintLevel) || value.maxHintLevel < 0 || value.maxHintLevel > 4) {
    fail('INVALID_HINT_LEVEL', 'Maximum hint level must be an integer from 0 to 4.');
  }
  if ((attempt.hintRequests === 0) !== (value.maxHintLevel === 0)) {
    fail('INVALID_HINT_LEVEL', 'Hint request count and maximum level are inconsistent.');
  }
  attempt.maxHintLevel = value.maxHintLevel;
  return attempt;
}

function applyAttempt(current, attempt) {
  const aggregate = { ...current.aggregate };
  aggregate.attemptCount = increment(aggregate.attemptCount);
  if (attempt.outcome === 'completed') aggregate.completedCount = increment(aggregate.completedCount);
  else aggregate.abandonedCount = increment(aggregate.abandonedCount);
  if (attempt.outcome === 'completed' && attempt.mistakes === 0 && attempt.hintRequests === 0) {
    aggregate.cleanCompletionCount = increment(aggregate.cleanCompletionCount);
  }
  if (attempt.outcome === 'completed' && attempt.hintRequests > 0) {
    aggregate.hintedCompletionCount = increment(aggregate.hintedCompletionCount);
  }
  aggregate.totalMistakes = addCount(aggregate.totalMistakes, attempt.mistakes);
  aggregate.totalHintRequests = addCount(aggregate.totalHintRequests, attempt.hintRequests);
  aggregate.lastAttemptAt = attempt.endedAt;
  if (attempt.outcome === 'completed') aggregate.lastCompletedAt = attempt.endedAt;
  const storedAttempt = Object.fromEntries(STORED_ATTEMPT_FIELDS.map((field) => [field, attempt[field]]));
  return {
    puzzleId: current.puzzleId,
    aggregate,
    recentAttempts: [storedAttempt, ...current.recentAttempts.map(cloneAttempt)]
      .slice(0, PRACTICE_ANALYTICS_MAX_RECENT_ATTEMPTS),
  };
}

function requireStorage(storage) {
  if (!storage || typeof storage !== 'object' || typeof storage.getItem !== 'function'
    || typeof storage.setItem !== 'function') {
    fail('INVALID_STORAGE', 'Analytics storage must provide getItem and setItem.');
  }
}

function requirePuzzleId(value, code = 'INVALID_PUZZLE_ID', message = 'Puzzle ID must be a nonempty canonical string.') {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) fail(code, message);
  return value;
}

function requireTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) fail('INVALID_TIMESTAMP', 'Timestamp must be canonical UTC ISO text.');
  try {
    if (new Date(value).toISOString() !== value) fail('INVALID_TIMESTAMP', 'Timestamp must be canonical UTC ISO text.');
  } catch {
    fail('INVALID_TIMESTAMP', 'Timestamp must be canonical UTC ISO text.');
  }
  return value;
}

function requireCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_COUNT', 'Analytics counts must be nonnegative safe integers.');
  return value;
}

function increment(value) {
  return addCount(value, 1);
}

function addCount(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) fail('INVALID_COUNT', 'Analytics count exceeds the safe integer range.');
  return sum;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function cloneAttempt(attempt) {
  return { ...attempt };
}

function clonePuzzleAnalytics(entry) {
  return {
    puzzleId: entry.puzzleId,
    aggregate: { ...entry.aggregate },
    recentAttempts: entry.recentAttempts.map(cloneAttempt),
  };
}

function freezePuzzleAnalytics(entry) {
  return Object.freeze({
    puzzleId: entry.puzzleId,
    aggregate: Object.freeze({ ...entry.aggregate }),
    recentAttempts: Object.freeze(entry.recentAttempts.map((attempt) => Object.freeze(cloneAttempt(attempt)))),
  });
}

function freezeEnvelope(envelope) {
  return Object.freeze({
    version: envelope.version,
    puzzles: Object.freeze(envelope.puzzles.map(freezePuzzleAnalytics)),
  });
}

function fail(code, message, details) {
  throw new PracticeAnalyticsError(code, message, details);
}
