import { hashBoard } from './game.js?v=36ce3754cc';
import { validateCustomPlayPosition } from './custom-position-play.js?v=36ce3754cc';
import { validateContinuationConfiguration } from './game-review-continuation.js?v=36ce3754cc';

export const CUSTOM_POSITION_STORAGE_KEY = 'chinese-chess-training:custom-positions:v1';
export const CUSTOM_POSITION_STORAGE_VERSION = 1;
export const CUSTOM_POSITION_LIMIT = 100;
// Application limit in UTF-8 bytes; browser quota accounting may differ.
export const CUSTOM_POSITION_MAX_BYTES = 1024 * 1024;
export const CUSTOM_POSITION_TITLE_LIMIT = 60;

const RECORD_FIELDS = ['id', 'title', 'initialBoard', 'sideToMove', 'createdAt', 'updatedAt', 'playPreferences'];
const INPUT_FIELDS = ['title', 'initialBoard', 'sideToMove', 'playPreferences'];
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FORBIDDEN_TITLE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

export class CustomPositionStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CustomPositionStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

// Synchronous data boundary only. expectedRevision rejects known stale writes;
// it is NOT a cross-tab lock or compare-and-swap. Phase B must serialize the
// complete read/check/write operation, including all callers, with Web Locks.
// Pass storage as () => window.localStorage to defer a throwing browser getter.
export function createCustomPositionStore({
  storage,
  now = () => new Date().toISOString(),
  idFactory = defaultIdFactory,
} = {}) {
  if (typeof now !== 'function' || typeof idFactory !== 'function') {
    fail('INVALID_OPTIONS', 'Clock and ID factory must be functions.');
  }

  function readSnapshot() {
    let adapter;
    let serialized;
    try {
      adapter = typeof storage === 'function' ? storage() : storage;
      serialized = adapter.getItem(CUSTOM_POSITION_STORAGE_KEY);
    } catch {
      return failedLoad('STORE_READ_FAILED', 'Unable to read saved custom positions.');
    }
    let envelope;
    try {
      envelope = parseEnvelope(serialized);
    } catch (error) {
      return failedLoad(error.code || 'INVALID_DATA', error.message);
    }
    const issues = [];
    const positions = [];
    const ids = new Map();
    for (const raw of envelope.positions) {
      if (typeof raw?.id === 'string') ids.set(raw.id, (ids.get(raw.id) || 0) + 1);
    }
    for (const [id, count] of ids) {
      if (count > 1) issues.push({ code: 'DUPLICATE_ID', message: 'Saved position IDs must be unique.', id });
    }
    envelope.positions.forEach((raw, index) => {
      try {
        const position = canonicalRecord(raw);
        // No ambiguous ID is actionable, even if one of its records is valid.
        if (ids.get(position.id) === 1) positions.push(position);
      } catch (error) {
        issues.push({ code: error.code || 'INVALID_POSITION', message: error.message, index });
      }
    });
    return { positions, issues, revision: envelope.revision, writable: issues.length === 0, adapter };
  }

  function loadAll() {
    const { adapter, ...loaded } = readSnapshot();
    return freezeDeep(loaded);
  }

  function getPosition(id) {
    requireId(id);
    return loadAll().positions.find(position => position.id === id) ?? null;
  }

  function forMutation(options) {
    const expectedRevision = options?.expectedRevision;
    requireRevision(expectedRevision, 'INVALID_EXPECTED_REVISION');
    const loaded = readSnapshot();
    if (!loaded.writable) {
      const code = loaded.issues[0]?.code === 'STORE_READ_FAILED' ? 'STORE_READ_FAILED' : 'STORAGE_CORRUPT';
      fail(code, 'Saved data cannot be modified and was left unchanged.', { issues: loaded.issues });
    }
    if (expectedRevision !== loaded.revision) {
      fail('REVISION_CONFLICT', 'Saved positions changed; reload before modifying them.', {
        expectedRevision, actualRevision: loaded.revision,
      });
    }
    return loaded;
  }

  function commit(loaded, positions) {
    if (loaded.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED', 'Revision limit reached.');
    if (positions.length > CUSTOM_POSITION_LIMIT) fail('POSITION_LIMIT', 'At most 100 positions can be saved.');
    // Revalidate and rebuild the whitelist immediately before serialization.
    const envelope = {
      version: CUSTOM_POSITION_STORAGE_VERSION,
      revision: loaded.revision + 1,
      positions: positions.map(canonicalRecord),
    };
    const serialized = JSON.stringify(envelope);
    requireSize(serialized);
    try {
      // One setItem, no remove/clear, no fallback overwrite or retry. The
      // injected adapter must honor localStorage's atomic setItem contract.
      loaded.adapter.setItem(CUSTOM_POSITION_STORAGE_KEY, serialized);
    } catch (cause) {
      fail('STORE_WRITE_FAILED', 'Unable to save custom positions.', { cause });
    }
    return envelope.revision;
  }

  function savePosition(input, options) {
    const loaded = forMutation(options);
    requireFields(input, INPUT_FIELDS, ['title', 'initialBoard', 'sideToMove']);
    const title = requireTitle(input.title);
    const chess = canonicalChess(input);
    const playPreferences = canonicalPreferences(input.playPreferences === undefined
      ? { humanSide: chess.sideToMove, difficulty: 'medium' }
      : input.playPreferences);
    const key = positionKey(chess);
    const existing = loaded.positions.find(position => positionKey(position) === key);
    if (existing) return freezeDeep({ position: existing, revision: loaded.revision, created: false });
    if (loaded.positions.length >= CUSTOM_POSITION_LIMIT) fail('POSITION_LIMIT', 'At most 100 positions can be saved.');
    const timestamp = requireTimestamp(now());
    const position = canonicalRecord({
      id: uniqueId(loaded.positions, idFactory), title, ...chess,
      createdAt: timestamp, updatedAt: timestamp, playPreferences,
    });
    const revision = commit(loaded, [...loaded.positions, position]);
    return freezeDeep({ position, revision, created: true });
  }

  function updatePosition(id, options, transform) {
    requireId(id);
    const loaded = forMutation(options);
    const index = loaded.positions.findIndex(position => position.id === id);
    if (index < 0) fail('POSITION_NOT_FOUND', 'The saved position no longer exists.');
    const current = loaded.positions[index];
    const next = transform(current);
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return freezeDeep({ position: current, revision: loaded.revision, changed: false });
    }
    // A clock correction must not move updatedAt backwards.
    next.updatedAt = [requireTimestamp(now()), current.updatedAt].sort().at(-1);
    const position = canonicalRecord(next);
    loaded.positions[index] = position;
    const revision = commit(loaded, loaded.positions);
    return freezeDeep({ position, revision, changed: true });
  }

  function renamePosition(id, title, options) {
    return updatePosition(id, options, current => ({ ...current, title: requireTitle(title) }));
  }

  function updatePlayPreferences(id, preferences, options) {
    return updatePosition(id, options, current => ({ ...current, playPreferences: canonicalPreferences(preferences) }));
  }

  function deletePosition(id, options) {
    requireId(id);
    const loaded = forMutation(options);
    const positions = loaded.positions.filter(position => position.id !== id);
    if (positions.length === loaded.positions.length) {
      return Object.freeze({ deleted: false, revision: loaded.revision });
    }
    return Object.freeze({ deleted: true, revision: commit(loaded, positions) });
  }

  return Object.freeze({
    key: CUSTOM_POSITION_STORAGE_KEY, loadAll, getPosition,
    savePosition, renamePosition, updatePlayPreferences, deletePosition,
  });
}

function parseEnvelope(serialized) {
  if (serialized === null) return { version: 1, revision: 0, positions: [] };
  if (typeof serialized !== 'string') fail('INVALID_DATA', 'Storage must return a string or null.');
  requireSize(serialized);
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    fail('INVALID_JSON', 'Saved custom positions are not valid JSON.');
  }
  requireFields(envelope, ['version', 'revision', 'positions']);
  if (envelope.version !== CUSTOM_POSITION_STORAGE_VERSION) fail('UNSUPPORTED_VERSION', 'Unsupported custom position version.');
  requireRevision(envelope.revision, 'INVALID_REVISION');
  if (!Array.isArray(envelope.positions)) fail('INVALID_POSITIONS', 'Positions must be an array.');
  if (envelope.positions.length > CUSTOM_POSITION_LIMIT) fail('POSITION_LIMIT', 'Stored position limit exceeded.');
  return envelope;
}

function canonicalRecord(raw) {
  requireFields(raw, RECORD_FIELDS);
  const id = requireId(raw.id);
  const title = requireTitle(raw.title);
  if (title !== raw.title) fail('INVALID_TITLE', 'Stored titles must already be trimmed.');
  const chess = canonicalChess(raw);
  const createdAt = requireTimestamp(raw.createdAt);
  const updatedAt = requireTimestamp(raw.updatedAt);
  if (updatedAt < createdAt) fail('INVALID_TIMESTAMP_ORDER', 'updatedAt precedes createdAt.');
  return { id, title, ...chess, createdAt, updatedAt, playPreferences: canonicalPreferences(raw.playPreferences) };
}

function canonicalChess(input) {
  const validation = validateCustomPlayPosition(input);
  if (!validation.ok) fail('INVALID_POSITION', validation.error.message, { domainCode: validation.error.code });
  for (const row of input.initialBoard) for (const piece of row) {
    if (piece !== null) requireFields(piece, ['type', 'side']);
  }
  return { initialBoard: validation.position.board, sideToMove: validation.position.sideToMove };
}

function canonicalPreferences(input) {
  requireFields(input, ['humanSide', 'difficulty']);
  try {
    const { humanSide, difficulty } = validateContinuationConfiguration(input);
    return { humanSide, difficulty };
  } catch {
    fail('INVALID_PREFERENCES', 'Invalid player side or AI difficulty.');
  }
}

function requireFields(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('INVALID_OBJECT', 'Expected a plain data object.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail('INVALID_FIELDS', 'Missing or unsupported data fields.');
  }
  // Data-only boundary: do not evaluate caller-provided property getters.
  if (keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    fail('INVALID_FIELDS', 'Accessor fields are not supported.');
  }
}

function requireTitle(title) {
  if (typeof title !== 'string' || FORBIDDEN_TITLE.test(title)) fail('INVALID_TITLE', 'Invalid position title.');
  const value = title.trim();
  if (!value || [...value].length > CUSTOM_POSITION_TITLE_LIMIT) fail('INVALID_TITLE', 'Title must contain 1–60 Unicode code points.');
  return value;
}

function requireId(id) {
  if (typeof id !== 'string' || !id || id.trim() !== id || id.length > 128 || FORBIDDEN_TITLE.test(id)) {
    fail('INVALID_ID', 'Expected a canonical ID of at most 128 characters.');
  }
  return id;
}

function requireTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('INVALID_TIMESTAMP', 'Expected a canonical UTC timestamp.');
  }
  return value;
}

function requireRevision(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, 'Revision must be a nonnegative safe integer.');
}

function requireSize(serialized) {
  if (new TextEncoder().encode(serialized).byteLength > CUSTOM_POSITION_MAX_BYTES) {
    fail('STORAGE_SIZE_LIMIT', 'Custom position data exceeds 1 MiB in UTF-8.');
  }
}

function positionKey(position) {
  return `${hashBoard(position.initialBoard)}|${position.sideToMove}`;
}

function uniqueId(positions, idFactory) {
  const used = new Set(positions.map(position => position.id));
  for (let attempt = 0; attempt < 12; attempt++) {
    const id = requireId(idFactory());
    if (!used.has(id)) return id;
  }
  fail('ID_COLLISION', 'Unable to create a unique position ID.');
}

function defaultIdFactory() {
  return globalThis.crypto?.randomUUID?.()
    ?? `position-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function failedLoad(code, message) {
  return { positions: [], issues: [{ code, message }], revision: null, writable: false };
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code, message, details) {
  throw new CustomPositionStoreError(code, message, details);
}
