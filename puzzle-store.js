import { validatePuzzle, isCheckmateAfterSolution } from './puzzle-domain.js?v=c335a26469';

export const PUZZLE_STORAGE_VERSION = 1;
export const PUZZLE_STORAGE_KEY = 'chinese-chess-training:puzzles:v1';

export class PuzzleStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PuzzleStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function createPuzzleStore({
  storage,
  key = PUZZLE_STORAGE_KEY,
  now = () => new Date().toISOString(),
  idFactory = defaultIdFactory,
} = {}) {
  requireStorage(storage);

  function loadAll() {
    let serialized;
    try {
      serialized = storage.getItem(key);
    } catch {
      return { puzzles: [], issues: [issue('STORE_READ_FAILED', 'Unable to read saved puzzles.')] };
    }
    const parsed = parseEnvelope(serialized);
    if (parsed.fatal) return { puzzles: [], issues: parsed.issues };
    const puzzles = [];
    const issues = [...parsed.issues];
    const seen = new Set();
    parsed.records.forEach((raw, index) => {
      try {
        const record = validateStoredRecord(raw);
        if (seen.has(record.id)) {
          issues.push(issue('DUPLICATE_ID', `Duplicate puzzle ID: ${record.id}`, index, record.id));
          return;
        }
        seen.add(record.id);
        puzzles.push(record);
      } catch (error) {
        issues.push(issue(
          error instanceof PuzzleStoreError ? error.code : 'INVALID_PUZZLE',
          error.message,
          index,
          raw && typeof raw === 'object' ? raw.id : undefined,
        ));
      }
    });
    return { puzzles: puzzles.map(cloneRecord), issues };
  }

  function listPuzzles() {
    return loadAll().puzzles;
  }

  function getPuzzle(id) {
    requireId(id);
    const found = loadAll().puzzles.find((puzzle) => puzzle.id === id);
    return found ? cloneRecord(found) : null;
  }

  function savePuzzle(input) {
    const records = recordsForMutation();
    const timestamp = normalizeTimestamp(now(), 'now');
    const title = requireTitle(input?.title);
    const chess = validateChessData({
      id: 'pending-puzzle',
      title,
      initialBoard: input?.initialBoard,
      sideToMove: input?.sideToMove,
      solution: input?.solution,
      tags: normalizeTags(input?.tags),
    });
    const id = createUniqueId(records, idFactory);
    const record = validateStoredRecord({
      id,
      title,
      initialBoard: chess.initialBoard,
      sideToMove: chess.sideToMove,
      solution: chess.solution,
      tags: normalizeTags(input?.tags),
      notes: normalizeNotes(input?.notes),
      createdAt: timestamp,
      updatedAt: timestamp,
      practiceCount: 0,
      completedCount: 0,
      lastPracticedAt: null,
    });
    writeRecords([...records, record]);
    return cloneRecord(record);
  }

  function updatePuzzleMetadata(id, updates = {}) {
    requireId(id);
    const records = recordsForMutation();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    const current = records[index];
    const next = validateStoredRecord({
      ...current,
      title: updates.title === undefined ? current.title : requireTitle(updates.title),
      tags: updates.tags === undefined ? current.tags : normalizeTags(updates.tags),
      notes: updates.notes === undefined ? current.notes : normalizeNotes(updates.notes),
      updatedAt: normalizeTimestamp(now(), 'now'),
    });
    records[index] = next;
    writeRecords(records);
    return cloneRecord(next);
  }

  function deletePuzzle(id) {
    requireId(id);
    const records = recordsForMutation();
    const next = records.filter((record) => record.id !== id);
    if (next.length === records.length) return false;
    writeRecords(next);
    return true;
  }

  function markPracticeStarted(id) {
    return updatePracticeMetadata(id, { practice: 1, completed: 0 });
  }

  function markPracticeCompleted(id) {
    return updatePracticeMetadata(id, { practice: 0, completed: 1 });
  }

  function updatePracticeMetadata(id, delta) {
    requireId(id);
    const records = recordsForMutation();
    const index = records.findIndex((record) => record.id === id);
    if (index < 0) return null;
    const timestamp = normalizeTimestamp(now(), 'now');
    const current = records[index];
    const next = validateStoredRecord({
      ...current,
      practiceCount: current.practiceCount + delta.practice,
      completedCount: current.completedCount + delta.completed,
      lastPracticedAt: timestamp,
      updatedAt: timestamp,
    });
    records[index] = next;
    writeRecords(records);
    return cloneRecord(next);
  }

  function recordsForMutation() {
    const loaded = loadAll();
    if (loaded.issues.some((entry) => entry.code === 'STORE_READ_FAILED')) {
      throw new PuzzleStoreError('STORE_READ_FAILED', 'Unable to read saved puzzles; storage was left unchanged.');
    }
    if (loaded.issues.length > 0) {
      throw new PuzzleStoreError(
        'STORAGE_CORRUPT',
        'Saved puzzle storage contains invalid data and was left unchanged.',
        { issues: loaded.issues },
      );
    }
    return loaded.puzzles.map(cloneRecord);
  }

  function writeRecords(records) {
    const envelope = { version: PUZZLE_STORAGE_VERSION, puzzles: records.map(cloneRecord) };
    try {
      storage.setItem(key, JSON.stringify(envelope));
    } catch (error) {
      throw new PuzzleStoreError('STORE_WRITE_FAILED', 'Unable to write saved puzzles.', { cause: error });
    }
  }

  return Object.freeze({
    key,
    loadAll,
    listPuzzles,
    getPuzzle,
    savePuzzle,
    updatePuzzleMetadata,
    deletePuzzle,
    markPracticeStarted,
    markPracticeCompleted,
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
    return { records: [], issues: [issue('INVALID_JSON', 'Saved puzzle data is not valid JSON.')], fatal: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Object.hasOwn(parsed, 'version')) {
    return { records: [], issues: [issue('MISSING_VERSION', 'Saved puzzle schema version is missing.')], fatal: true };
  }
  if (parsed.version !== PUZZLE_STORAGE_VERSION) {
    return { records: [], issues: [issue('UNSUPPORTED_VERSION', `Unsupported saved puzzle version: ${parsed.version}.`)], fatal: true };
  }
  if (!Array.isArray(parsed.puzzles)) {
    return { records: [], issues: [issue('PUZZLES_NOT_ARRAY', 'Saved puzzles must be an array.')], fatal: true };
  }
  return { records: parsed.puzzles, issues: [], fatal: false };
}

function validateStoredRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PuzzleStoreError('INVALID_PUZZLE', 'Saved puzzle must be an object.');
  }
  const id = requireId(raw.id);
  const title = requireTitle(raw.title);
  const tags = normalizeTags(raw.tags);
  const chess = validateChessData({
    id,
    title,
    initialBoard: raw.initialBoard,
    sideToMove: raw.sideToMove,
    solution: raw.solution,
    tags,
  });
  const createdAt = normalizeTimestamp(raw.createdAt, 'createdAt');
  const updatedAt = normalizeTimestamp(raw.updatedAt, 'updatedAt');
  const lastPracticedAt = raw.lastPracticedAt === null
    ? null
    : normalizeTimestamp(raw.lastPracticedAt, 'lastPracticedAt');
  return freezeRecord({
    id,
    title,
    initialBoard: chess.initialBoard,
    sideToMove: chess.sideToMove,
    solution: chess.solution,
    tags,
    notes: normalizeNotes(raw.notes),
    createdAt,
    updatedAt,
    practiceCount: normalizeCount(raw.practiceCount, 'practiceCount'),
    completedCount: normalizeCount(raw.completedCount, 'completedCount'),
    lastPracticedAt,
  });
}

function validateChessData(puzzle) {
  const validation = validatePuzzle(puzzle);
  if (!validation.ok) {
    throw new PuzzleStoreError('INVALID_PUZZLE', validation.error.message, {
      domainCode: validation.error.code,
      path: validation.error.path,
    });
  }
  if (!isCheckmateAfterSolution(puzzle)) {
    throw new PuzzleStoreError('NOT_CHECKMATE', 'Saved puzzle solution must end in checkmate.');
  }
  return {
    initialBoard: cloneBoard(puzzle.initialBoard),
    sideToMove: puzzle.sideToMove,
    solution: cloneSolution(puzzle.solution),
  };
}

function createUniqueId(records, idFactory) {
  const used = new Set(records.map((record) => record.id));
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = String(idFactory()).trim();
    if (candidate && !used.has(candidate)) return candidate;
  }
  throw new PuzzleStoreError('ID_COLLISION', 'Unable to create a unique puzzle ID.');
}

function defaultIdFactory() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = Math.random().toString(36).slice(2, 12);
  return `puzzle-${Date.now().toString(36)}-${random}`;
}

function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    throw new PuzzleStoreError('INVALID_STORAGE', 'A storage adapter with getItem/setItem is required.');
  }
}

function requireId(id) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new PuzzleStoreError('INVALID_ID', 'Puzzle ID must be a non-empty string.');
  }
  return id.trim();
}

function requireTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new PuzzleStoreError('EMPTY_TITLE', 'Puzzle title is required.');
  }
  return title.trim();
}

function normalizeTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new PuzzleStoreError('INVALID_TAGS', 'Puzzle tags must be an array of strings.');
  }
  return tags.map((tag) => tag.trim()).filter(Boolean);
}

function normalizeNotes(notes) {
  if (notes === undefined) return '';
  if (typeof notes !== 'string') throw new PuzzleStoreError('INVALID_NOTES', 'Puzzle notes must be a string.');
  return notes.trim();
}

function normalizeCount(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new PuzzleStoreError('INVALID_METADATA', `${field} must be a non-negative integer.`);
  }
  return value;
}

function normalizeTimestamp(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
    throw new PuzzleStoreError('INVALID_METADATA', `${field} must be an ISO-compatible timestamp.`);
  }
  return value;
}

function issue(code, message, index, id) {
  return { code, message, ...(index === undefined ? {} : { index }), ...(id ? { id } : {}) };
}

function clonePiece(piece) {
  // Persist chess data only, never arbitrary nested photo/session fields.
  return piece === null ? null : { type: piece.type, side: piece.side };
}

function cloneBoard(board) {
  return board.map((row) => row.map(clonePiece));
}

function cloneMove(move) {
  return {
    side: move.side,
    from: { r: move.from.r, c: move.from.c },
    to: { r: move.to.r, c: move.to.c },
  };
}

function cloneSolution(solution) {
  return solution.map(cloneMove);
}

function cloneRecord(record) {
  return {
    id: record.id,
    title: record.title,
    initialBoard: cloneBoard(record.initialBoard),
    sideToMove: record.sideToMove,
    solution: cloneSolution(record.solution),
    tags: [...record.tags],
    notes: record.notes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    practiceCount: record.practiceCount,
    completedCount: record.completedCount,
    lastPracticedAt: record.lastPracticedAt,
  };
}

function freezeRecord(record) {
  const cloned = cloneRecord(record);
  cloned.initialBoard.forEach((row) => {
    row.forEach((piece) => { if (piece) Object.freeze(piece); });
    Object.freeze(row);
  });
  cloned.solution.forEach((move) => {
    Object.freeze(move.from);
    Object.freeze(move.to);
    Object.freeze(move);
  });
  Object.freeze(cloned.initialBoard);
  Object.freeze(cloned.solution);
  Object.freeze(cloned.tags);
  return Object.freeze(cloned);
}
