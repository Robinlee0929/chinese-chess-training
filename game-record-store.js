import {
  GameRecordValidationError,
  createGameRecord,
} from './game-record.js?v=522295374f';

export const GAME_RECORD_STORAGE_VERSION = 1;
export const GAME_RECORD_STORAGE_KEY = 'chinese-chess-training:game-records:v1';
export const GAME_RECORD_RETENTION_LIMIT = 100;

export class GameRecordStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GameRecordStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function createGameRecordStore({
  storage,
  key = GAME_RECORD_STORAGE_KEY,
  retentionLimit = GAME_RECORD_RETENTION_LIMIT,
} = {}) {
  requireStorage(storage);
  if (retentionLimit !== GAME_RECORD_RETENTION_LIMIT) {
    throw new GameRecordStoreError(
      'INVALID_RETENTION_LIMIT',
      `GameRecord retention must be exactly ${GAME_RECORD_RETENTION_LIMIT}.`,
    );
  }

  function loadAll() {
    let serialized;
    try {
      serialized = storage.getItem(key);
    } catch (cause) {
      return freezeLoadResult([], [issue(
        'STORE_READ_FAILED',
        'Unable to read saved GameRecords.',
        { cause },
      )]);
    }

    const parsed = parseEnvelope(serialized);
    if (parsed.fatal) return freezeLoadResult([], parsed.issues);

    const records = [];
    const issues = [...parsed.issues];
    const seen = new Set();
    parsed.records.forEach((raw, index) => {
      try {
        const record = canonicalRecord(raw);
        if (seen.has(record.id)) {
          issues.push(issue('DUPLICATE_ID', `Duplicate GameRecord ID: ${record.id}.`, {
            index,
            id: record.id,
          }));
          return;
        }
        seen.add(record.id);
        records.push(record);
      } catch (error) {
        issues.push(issue(
          error instanceof GameRecordStoreError ? error.code : 'INVALID_GAME_RECORD',
          error.message,
          {
            index,
            ...(raw && typeof raw === 'object' && typeof raw.id === 'string'
              ? { id: raw.id }
              : {}),
            ...(error.domainCode ? { domainCode: error.domainCode } : {}),
            ...(error.path ? { path: error.path } : {}),
          },
        ));
      }
    });
    records.sort(compareOldestFirst);
    return freezeLoadResult(records, issues);
  }

  function listGameRecords() {
    return loadAll().records;
  }

  function getGameRecord(id) {
    requireCanonicalId(id);
    return loadAll().records.find((record) => record.id === id) ?? null;
  }

  function saveGameRecord(input) {
    const incoming = canonicalRecord(input);
    const records = recordsForMutation();
    const existing = records.find((record) => record.id === incoming.id);
    if (existing) {
      if (!canonicalEquivalent(existing, incoming)) {
        throw new GameRecordStoreError(
          'ID_CONFLICT',
          `GameRecord ID ${incoming.id} already belongs to different data.`,
          { id: incoming.id },
        );
      }
      return freezeSaveResult(existing, []);
    }

    const ordered = [...records, incoming].sort(compareOldestFirst);
    const evictionCount = Math.max(0, ordered.length - GAME_RECORD_RETENTION_LIMIT);
    const evictedIds = ordered.slice(0, evictionCount).map((record) => record.id);
    const retained = ordered.slice(evictionCount);
    writeRecords(retained);
    return freezeSaveResult(incoming, evictedIds);
  }

  function deleteGameRecord(id) {
    requireCanonicalId(id);
    const records = recordsForMutation();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) return false;
    writeRecords(next);
    return true;
  }

  function recordsForMutation() {
    const loaded = loadAll();
    if (loaded.issues.some((entry) => entry.code === 'STORE_READ_FAILED')) {
      throw new GameRecordStoreError(
        'STORE_READ_FAILED',
        'Unable to read saved GameRecords; storage was left unchanged.',
      );
    }
    if (loaded.issues.length > 0) {
      throw new GameRecordStoreError(
        'STORAGE_CORRUPT',
        'Saved GameRecord storage contains invalid data and was left unchanged.',
        { issues: loaded.issues },
      );
    }
    return loaded.records;
  }

  function writeRecords(records) {
    const envelope = {
      version: GAME_RECORD_STORAGE_VERSION,
      records,
    };
    try {
      storage.setItem(key, JSON.stringify(envelope));
    } catch (cause) {
      throw new GameRecordStoreError(
        'STORE_WRITE_FAILED',
        'Unable to write saved GameRecords.',
        { cause },
      );
    }
  }

  return Object.freeze({
    key,
    loadAll,
    listGameRecords,
    getGameRecord,
    saveGameRecord,
    deleteGameRecord,
  });
}

function parseEnvelope(serialized) {
  if (serialized === null || serialized === '') {
    return { records: [], issues: [], fatal: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return {
      records: [],
      issues: [issue('INVALID_JSON', 'Saved GameRecord data is not valid JSON.')],
      fatal: true,
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Object.hasOwn(parsed, 'version')) {
    return {
      records: [],
      issues: [issue('MISSING_VERSION', 'Saved GameRecord schema version is missing.')],
      fatal: true,
    };
  }
  if (parsed.version !== GAME_RECORD_STORAGE_VERSION) {
    const version = typeof parsed.version === 'object' ? 'invalid type' : parsed.version;
    return {
      records: [],
      issues: [issue('UNSUPPORTED_VERSION', `Unsupported saved GameRecord version: ${version}.`)],
      fatal: true,
    };
  }
  if (!Array.isArray(parsed.records)) {
    return {
      records: [],
      issues: [issue('RECORDS_NOT_ARRAY', 'Saved GameRecords must be an array.')],
      fatal: true,
    };
  }
  return { records: parsed.records, issues: [], fatal: false };
}

function canonicalRecord(input) {
  try {
    return createGameRecord(input);
  } catch (error) {
    if (!(error instanceof GameRecordValidationError)) throw error;
    throw new GameRecordStoreError('INVALID_GAME_RECORD', error.message, {
      domainCode: error.code,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.ply === undefined ? {} : { ply: error.ply }),
    });
  }
}

function compareOldestFirst(a, b) {
  return a.completedAt.localeCompare(b.completedAt)
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}

function canonicalEquivalent(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new GameRecordStoreError(
      'INVALID_STORAGE',
      'A storage adapter with getItem/setItem is required.',
    );
  }
}

function requireCanonicalId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
    throw new GameRecordStoreError('INVALID_ID', 'GameRecord ID must be a canonical nonempty string.');
  }
}

function issue(code, message, details = {}) {
  const { cause, ...publicDetails } = details;
  return Object.freeze({ code, message, ...publicDetails });
}

function freezeLoadResult(records, issues) {
  return Object.freeze({
    records: Object.freeze(records.map((record) => createGameRecord(record))),
    issues: Object.freeze(issues.map((entry) => Object.freeze({ ...entry }))),
  });
}

function freezeSaveResult(record, evictedIds) {
  return Object.freeze({
    record: createGameRecord(record),
    evictedIds: Object.freeze([...evictedIds]),
  });
}
