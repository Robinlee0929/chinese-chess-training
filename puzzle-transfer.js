import { validatePuzzle, isCheckmateAfterSolution } from './puzzle-domain.js?v=75fe963924';

export const PUZZLE_TRANSFER_FORMAT = 'chinese-chess-training-puzzles';
export const PUZZLE_TRANSFER_SCHEMA_VERSION = 1;
export const PUZZLE_TRANSFER_PUZZLE_VERSION = 1;
export const PUZZLE_TRANSFER_MAX_BYTES = 5 * 1024 * 1024;
export const PUZZLE_TRANSFER_MAX_PUZZLES = 1000;

const ROOT_FIELDS = Object.freeze(['format', 'schemaVersion', 'exportedAt', 'puzzles']);
const PUZZLE_FIELDS = Object.freeze([
  'puzzleVersion', 'id', 'title', 'initialBoard', 'sideToMove', 'solution', 'tags', 'notes',
]);

export class PuzzleTransferError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PuzzleTransferError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function serializePuzzleExport(records, { now = () => new Date().toISOString() } = {}) {
  if (!Array.isArray(records)) fail('INVALID_ROOT', 'Puzzle export input must be an array.');
  if (records.length > PUZZLE_TRANSFER_MAX_PUZZLES) {
    fail('TOO_MANY_PUZZLES', `Puzzle export cannot exceed ${PUZZLE_TRANSFER_MAX_PUZZLES} records.`);
  }
  let exportedAt;
  try {
    exportedAt = typeof now === 'function' ? now() : undefined;
  } catch {
    fail('INVALID_EXPORTED_AT', 'Export timestamp is invalid.');
  }
  if (!validTimestamp(exportedAt)) fail('INVALID_EXPORTED_AT', 'Export timestamp is invalid.');
  const puzzles = records.map((record, index) => portablePuzzle(record, index));
  rejectDuplicateIds(puzzles);
  const serialized = `${JSON.stringify({
    format: PUZZLE_TRANSFER_FORMAT,
    schemaVersion: PUZZLE_TRANSFER_SCHEMA_VERSION,
    exportedAt,
    puzzles,
  }, null, 2)}\n`;
  requireByteLimit(serialized);
  return serialized;
}

export function parsePuzzleImport(text) {
  if (typeof text !== 'string') fail('INVALID_ROOT', 'Puzzle import must be JSON text.');
  requireByteLimit(text);
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    fail('INVALID_JSON', 'Puzzle import is not valid JSON.');
  }
  if (!plainObject(envelope) || !hasExactFields(envelope, ROOT_FIELDS) || !Array.isArray(envelope.puzzles)) {
    fail('INVALID_ROOT', 'Puzzle import has an invalid root object.');
  }
  if (envelope.format !== PUZZLE_TRANSFER_FORMAT) {
    fail('UNSUPPORTED_FORMAT', 'Puzzle import uses an unsupported format.');
  }
  if (envelope.schemaVersion !== PUZZLE_TRANSFER_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', 'Puzzle import uses an unsupported schema version.');
  }
  if (!validTimestamp(envelope.exportedAt)) {
    fail('INVALID_EXPORTED_AT', 'Puzzle import has an invalid export timestamp.');
  }
  if (envelope.puzzles.length > PUZZLE_TRANSFER_MAX_PUZZLES) {
    fail('TOO_MANY_PUZZLES', `Puzzle import cannot exceed ${PUZZLE_TRANSFER_MAX_PUZZLES} records.`);
  }
  const puzzles = envelope.puzzles.map((record, index) => {
    if (!plainObject(record) || !hasExactFields(record, PUZZLE_FIELDS)) {
      fail('INVALID_PUZZLE', `Puzzle at index ${index} has noncanonical fields.`, { index });
    }
    if (record.puzzleVersion !== PUZZLE_TRANSFER_PUZZLE_VERSION) {
      fail('UNSUPPORTED_PUZZLE_VERSION', `Puzzle at index ${index} uses an unsupported version.`, { index });
    }
    return portablePuzzle(record, index);
  });
  rejectDuplicateIds(puzzles);
  return deepFreeze(puzzles);
}

function portablePuzzle(record, index) {
  if (!plainObject(record)) fail('INVALID_PUZZLE', `Puzzle at index ${index} must be an object.`, { index });
  const canonical = {
    id: record.id,
    title: record.title,
    initialBoard: cloneBoard(record.initialBoard),
    sideToMove: record.sideToMove,
    solution: cloneSolution(record.solution),
    tags: record.tags === undefined ? [] : cloneTags(record.tags),
    notes: record.notes === undefined ? '' : record.notes,
  };
  validatePortableText(canonical, index);
  let validation;
  try {
    validation = validatePuzzle(canonical);
  } catch {
    fail('INVALID_PUZZLE', `Puzzle at index ${index} is invalid.`, { index });
  }
  if (!validation.ok) {
    fail('INVALID_PUZZLE', validation.error.message, {
      index,
      domainCode: validation.error.code,
      path: validation.error.path,
    });
  }
  let checkmate = false;
  try {
    checkmate = isCheckmateAfterSolution(canonical);
  } catch {
    fail('INVALID_PUZZLE', `Puzzle at index ${index} is invalid.`, { index });
  }
  if (!checkmate) fail('NOT_CHECKMATE', `Puzzle at index ${index} does not end in checkmate.`, { index });
  return {
    puzzleVersion: PUZZLE_TRANSFER_PUZZLE_VERSION,
    id: canonical.id,
    title: canonical.title,
    initialBoard: cloneBoard(canonical.initialBoard),
    sideToMove: canonical.sideToMove,
    solution: cloneSolution(canonical.solution),
    tags: cloneTags(canonical.tags),
    notes: canonical.notes,
  };
}

function rejectDuplicateIds(puzzles) {
  const seen = new Set();
  for (const puzzle of puzzles) {
    if (seen.has(puzzle.id)) fail('DUPLICATE_ID', `Duplicate puzzle ID: ${puzzle.id}`, { id: puzzle.id });
    seen.add(puzzle.id);
  }
}

function requireByteLimit(text) {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > PUZZLE_TRANSFER_MAX_BYTES) {
    fail('TOO_LARGE', `Puzzle transfer exceeds ${PUZZLE_TRANSFER_MAX_BYTES} UTF-8 bytes.`, { byteLength });
  }
  return byteLength;
}

function validTimestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  } catch {
    return false;
  }
}

function validatePortableText(puzzle, index) {
  for (const field of ['id', 'title']) {
    const value = puzzle[field];
    if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
      fail('INVALID_PUZZLE', `Puzzle at index ${index} has a noncanonical ${field}.`, {
        index,
        path: field,
      });
    }
  }
  if (!Array.isArray(puzzle.tags)) {
    fail('INVALID_PUZZLE', `Puzzle at index ${index} has invalid tags.`, { index, path: 'tags' });
  }
  puzzle.tags.forEach((tag, tagIndex) => {
    if (typeof tag !== 'string' || tag !== tag.trim()) {
      fail('INVALID_PUZZLE', `Puzzle at index ${index} has a noncanonical tag.`, {
        index,
        path: `tags[${tagIndex}]`,
      });
    }
  });
  if (typeof puzzle.notes !== 'string') {
    fail('INVALID_PUZZLE', `Puzzle at index ${index} has invalid notes.`, { index, path: 'notes' });
  }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function cloneBoard(board) {
  if (!Array.isArray(board)) return board;
  return board.map((row) => Array.isArray(row)
    ? row.map((piece) => (plainObject(piece) ? { type: piece.type, side: piece.side } : piece))
    : row);
}

function cloneSolution(solution) {
  if (!Array.isArray(solution)) return solution;
  return solution.map((move) => plainObject(move) ? {
    side: move.side,
    from: plainObject(move.from) ? { r: move.from.r, c: move.from.c } : move.from,
    to: plainObject(move.to) ? { r: move.to.r, c: move.to.c } : move.to,
  } : move);
}

function cloneTags(tags) {
  return Array.isArray(tags) ? tags.slice() : tags;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function fail(code, message, details) {
  throw new PuzzleTransferError(code, message, details);
}
