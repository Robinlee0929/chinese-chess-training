import {
  ROWS,
  COLS,
  RED,
  BLACK,
  legalMoves,
  applyMove,
  notation,
  inCheck,
  hasAnyLegalMove,
  hashBoard,
  repetitionVerdict,
} from './game.js?v=58273955d5';

export const GAME_RECORD_SCHEMA_VERSION = 1;

const SIDES = new Set([RED, BLACK]);
const MODES = new Set(['pvp', 'easy', 'medium', 'hard']);
const PIECE_TYPES = new Set(['K', 'A', 'B', 'N', 'R', 'C', 'P']);
const TERMINATION_REASONS = new Set([
  'checkmate',
  'stalemate',
  'perpetual-check',
  'threefold-repetition',
  'mutual-perpetual-check',
]);
const ROOT_FIELDS = Object.freeze([
  'schemaVersion', 'id', 'createdAt', 'completedAt', 'initialPosition', 'moves', 'mode', 'result',
]);
const INITIAL_POSITION_FIELDS = Object.freeze(['board', 'sideToMove']);
const PIECE_FIELDS = Object.freeze(['type', 'side']);
const MOVE_FIELDS = Object.freeze(['from', 'to']);
const COORDINATE_FIELDS = Object.freeze(['r', 'c']);
const RESULT_FIELDS = Object.freeze(['winner', 'terminationReason']);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class GameRecordValidationError extends Error {
  constructor(code, message, { path, ply } = {}) {
    super(message);
    this.name = 'GameRecordValidationError';
    this.code = code;
    if (path !== undefined) this.path = path;
    if (ply !== undefined) this.ply = ply;
  }
}

export function validateGameRecord(input) {
  try {
    const record = canonicalRecord(input);
    replayCanonical(record, record.moves.length);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof GameRecordValidationError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.ply === undefined ? {} : { ply: error.ply }),
      },
    };
  }
}

export function createGameRecord(input) {
  const record = canonicalRecord(input);
  replayCanonical(record, record.moves.length);
  return freezeRecord(record);
}

export function replayGameRecord(input, ply) {
  const record = canonicalRecord(input);
  validateReplayPly(ply, record.moves.length);
  return replayCanonical(record, ply);
}

function canonicalRecord(input) {
  requirePlainObject(input, 'INVALID_RECORD', 'GameRecord must be an object.', 'record');
  requireExactFields(input, ROOT_FIELDS, 'record');

  if (input.schemaVersion !== GAME_RECORD_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', 'GameRecord schemaVersion is unsupported.', {
      path: 'schemaVersion',
    });
  }
  const id = requireCanonicalId(input.id);
  const createdAt = requireTimestamp(input.createdAt, 'createdAt');
  const completedAt = requireTimestamp(input.completedAt, 'completedAt');
  if (completedAt < createdAt) {
    fail('INVALID_TIMESTAMP_ORDER', 'completedAt must not be earlier than createdAt.', {
      path: 'completedAt',
    });
  }

  const initialPosition = canonicalInitialPosition(input.initialPosition);
  if (!Array.isArray(input.moves)) {
    fail('INVALID_MOVES', 'GameRecord moves must be an array.', { path: 'moves' });
  }
  const moves = input.moves.map((move, index) => canonicalMove(move, index));
  if (!MODES.has(input.mode)) {
    fail('UNSUPPORTED_MODE', 'GameRecord mode is unsupported.', { path: 'mode' });
  }
  const result = canonicalResult(input.result);

  return {
    schemaVersion: GAME_RECORD_SCHEMA_VERSION,
    id,
    createdAt,
    completedAt,
    initialPosition,
    moves,
    mode: input.mode,
    result,
  };
}

function canonicalInitialPosition(input) {
  requirePlainObject(
    input,
    'INVALID_INITIAL_POSITION',
    'GameRecord initialPosition must be an object.',
    'initialPosition',
  );
  requireExactFields(input, INITIAL_POSITION_FIELDS, 'initialPosition');
  const board = canonicalBoard(input.board);
  if (!SIDES.has(input.sideToMove)) {
    fail('INVALID_SIDE_TO_MOVE', 'initialPosition.sideToMove must be red or black.', {
      path: 'initialPosition.sideToMove',
    });
  }
  return { board, sideToMove: input.sideToMove };
}

function canonicalBoard(board) {
  if (!Array.isArray(board) || board.length !== ROWS) {
    fail('INVALID_BOARD_ROWS', `Initial board must contain exactly ${ROWS} rows.`, {
      path: 'initialPosition.board',
    });
  }
  let redKings = 0;
  let blackKings = 0;
  const copy = [];
  for (let r = 0; r < ROWS; r++) {
    const row = board[r];
    if (!Array.isArray(row) || row.length !== COLS) {
      fail('INVALID_BOARD_COLUMNS', `Initial board row ${r} must contain exactly ${COLS} columns.`, {
        path: `initialPosition.board[${r}]`,
      });
    }
    const copiedRow = [];
    for (let c = 0; c < COLS; c++) {
      const piece = row[c];
      if (piece === null) {
        copiedRow.push(null);
        continue;
      }
      const path = `initialPosition.board[${r}][${c}]`;
      requirePlainObject(piece, 'INVALID_BOARD_CELL', 'Board cells must be null or piece objects.', path);
      requireExactFields(piece, PIECE_FIELDS, path);
      if (!PIECE_TYPES.has(piece.type)) {
        fail('INVALID_PIECE_TYPE', `Piece at (${r}, ${c}) has an invalid type.`, {
          path: `${path}.type`,
        });
      }
      if (!SIDES.has(piece.side)) {
        fail('INVALID_PIECE_SIDE', `Piece at (${r}, ${c}) has an invalid side.`, {
          path: `${path}.side`,
        });
      }
      if (piece.type === 'K') {
        if (piece.side === RED) redKings++;
        else blackKings++;
      }
      copiedRow.push({ type: piece.type, side: piece.side });
    }
    copy.push(copiedRow);
  }
  requireOneKing(RED, redKings);
  requireOneKing(BLACK, blackKings);
  return copy;
}

function canonicalMove(move, index) {
  const ply = index + 1;
  const path = `moves[${index}]`;
  requirePlainObject(move, 'INVALID_MOVE', `Move at ply ${ply} must be an object.`, path, ply);
  requireExactFields(move, MOVE_FIELDS, path, ply);
  return {
    from: canonicalCoordinate(move.from, `${path}.from`, ply),
    to: canonicalCoordinate(move.to, `${path}.to`, ply),
  };
}

function canonicalCoordinate(coordinate, path, ply) {
  requirePlainObject(
    coordinate,
    'INVALID_COORDINATE',
    `Move at ply ${ply} must contain coordinate objects.`,
    path,
    ply,
  );
  requireExactFields(coordinate, COORDINATE_FIELDS, path, ply);
  if (!Number.isInteger(coordinate.r) || !Number.isInteger(coordinate.c)) {
    fail('INVALID_COORDINATE', `Move at ply ${ply} coordinates must be integers.`, { path, ply });
  }
  if (coordinate.r < 0 || coordinate.r >= ROWS || coordinate.c < 0 || coordinate.c >= COLS) {
    fail('COORDINATE_OUT_OF_BOUNDS', `Move at ply ${ply} is outside the board.`, { path, ply });
  }
  return { r: coordinate.r, c: coordinate.c };
}

function canonicalResult(result) {
  requirePlainObject(result, 'INVALID_RESULT', 'GameRecord result must be an object.', 'result');
  requireExactFields(result, RESULT_FIELDS, 'result');
  if (result.winner !== null && !SIDES.has(result.winner)) {
    fail('INVALID_WINNER', 'GameRecord winner must be red, black, or null.', {
      path: 'result.winner',
    });
  }
  if (!TERMINATION_REASONS.has(result.terminationReason)) {
    fail('UNSUPPORTED_TERMINATION_REASON', 'GameRecord terminationReason is unsupported.', {
      path: 'result.terminationReason',
    });
  }
  return { winner: result.winner, terminationReason: result.terminationReason };
}

function replayCanonical(record, selectedPly) {
  const board = cloneBoard(record.initialPosition.board);
  let sideToMove = record.initialPosition.sideToMove;
  const positionHashes = [hashBoard(board)];
  const repetitionHistory = [{
    key: `${positionHashes[0]}|${sideToMove}`,
    mover: null,
    check: false,
  }];
  const moveMetadata = [];
  let terminal = adjudicate(board, sideToMove, repetitionHistory);
  let selectedBoard = selectedPly === 0 ? cloneBoard(board) : null;
  let selectedSide = selectedPly === 0 ? sideToMove : null;
  let selectedTerminal = selectedPly === 0 ? cloneTerminal(terminal) : null;
  let selectedHashCount = selectedPly === 0 ? 1 : null;
  let selectedRepetitionCount = selectedPly === 0 ? 1 : null;

  for (let index = 0; index < record.moves.length; index++) {
    const ply = index + 1;
    const move = record.moves[index];
    if (terminal) {
      fail('MOVE_AFTER_TERMINAL', `Move at ply ${ply} occurs after the game is terminal.`, {
        path: `moves[${index}]`,
        ply,
      });
    }

    const piece = board[move.from.r][move.from.c];
    if (piece === null) {
      fail('EMPTY_SOURCE', `Move at ply ${ply} starts from an empty square.`, {
        path: `moves[${index}].from`,
        ply,
      });
    }
    if (piece.side !== sideToMove) {
      fail('WRONG_SIDE', `Move at ply ${ply} moves the wrong side.`, {
        path: `moves[${index}].from`,
        ply,
      });
    }
    const legal = legalMoves(board, move.from.r, move.from.c)
      .some(({ r, c }) => r === move.to.r && c === move.to.c);
    if (!legal) {
      fail('ILLEGAL_MOVE', `Move at ply ${ply} is not a legal Xiangqi move.`, {
        path: `moves[${index}]`,
        ply,
      });
    }

    const mover = sideToMove;
    const displayNotation = notation(board, move.from, move.to);
    const captured = clonePiece(board[move.to.r][move.to.c]);
    applyMove(board, move.from, move.to);
    sideToMove = opposite(sideToMove);
    const positionHash = hashBoard(board);
    const checked = inCheck(board, sideToMove);
    positionHashes.push(positionHash);
    repetitionHistory.push({
      key: `${positionHash}|${sideToMove}`,
      mover,
      check: checked,
    });
    terminal = adjudicate(board, sideToMove, repetitionHistory, checked);
    moveMetadata.push({
      ply,
      side: mover,
      from: cloneCoordinate(move.from),
      to: cloneCoordinate(move.to),
      captured,
      notation: displayNotation,
    });

    if (ply === selectedPly) {
      selectedBoard = cloneBoard(board);
      selectedSide = sideToMove;
      selectedTerminal = cloneTerminal(terminal);
      selectedHashCount = positionHashes.length;
      selectedRepetitionCount = repetitionHistory.length;
    }
  }

  if (!terminal) {
    fail('NONTERMINAL_RECORD', 'GameRecord move sequence does not reach a terminal position.', {
      path: 'moves',
    });
  }
  if (record.result.winner !== terminal.winner) {
    fail('RESULT_WINNER_MISMATCH', 'Stored winner does not match canonical replay.', {
      path: 'result.winner',
    });
  }
  if (record.result.terminationReason !== terminal.terminationReason) {
    fail('RESULT_REASON_MISMATCH', 'Stored terminationReason does not match canonical replay.', {
      path: 'result.terminationReason',
    });
  }

  return freezeReplaySnapshot({
    board: selectedBoard,
    sideToMove: selectedSide,
    selectedPly,
    totalPlies: record.moves.length,
    moveMetadata,
    positionHashes: positionHashes.slice(0, selectedHashCount),
    repetitionHistory: repetitionHistory.slice(0, selectedRepetitionCount),
    terminal: selectedTerminal,
  });
}

function adjudicate(board, sideToMove, repetitionHistory, knownCheck) {
  const checked = knownCheck === undefined ? inCheck(board, sideToMove) : knownCheck;
  if (!hasAnyLegalMove(board, sideToMove)) {
    return {
      winner: opposite(sideToMove),
      terminationReason: checked ? 'checkmate' : 'stalemate',
    };
  }
  const key = repetitionHistory[repetitionHistory.length - 1].key;
  const verdict = repetitionVerdict(repetitionHistory, key);
  if (!verdict) return null;
  if (verdict.result === 'loss') {
    return { winner: opposite(verdict.loser), terminationReason: 'perpetual-check' };
  }
  return {
    winner: null,
    terminationReason: verdict.reason === '雙方長將'
      ? 'mutual-perpetual-check'
      : 'threefold-repetition',
  };
}

function validateReplayPly(ply, totalPlies) {
  if (!Number.isInteger(ply)) {
    fail('INVALID_REPLAY_PLY', 'Replay ply must be an integer.', { path: 'ply' });
  }
  if (ply < 0 || ply > totalPlies) {
    fail('REPLAY_PLY_OUT_OF_RANGE', `Replay ply must be between 0 and ${totalPlies}.`, {
      path: 'ply',
    });
  }
}

function requireCanonicalId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
    fail('INVALID_ID', 'GameRecord id must be a nonempty canonical string.', { path: 'id' });
  }
  return id;
}

function requireTimestamp(value, path) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    fail('INVALID_TIMESTAMP', `${path} must be a canonical UTC ISO timestamp.`, { path });
  }
  try {
    if (new Date(value).toISOString() !== value) {
      fail('INVALID_TIMESTAMP', `${path} must be a canonical UTC ISO timestamp.`, { path });
    }
  } catch {
    fail('INVALID_TIMESTAMP', `${path} must be a canonical UTC ISO timestamp.`, { path });
  }
  return value;
}

function requireOneKing(side, count) {
  const label = side === RED ? 'red' : 'black';
  const code = side === RED ? 'RED' : 'BLACK';
  if (count === 0) {
    fail(`MISSING_${code}_KING`, `Initial board must contain exactly one ${label} king.`, {
      path: 'initialPosition.board',
    });
  }
  if (count > 1) {
    fail(`DUPLICATE_${code}_KING`, `Initial board contains more than one ${label} king.`, {
      path: 'initialPosition.board',
    });
  }
}

function requirePlainObject(value, code, message, path, ply) {
  if (!plainObject(value)) fail(code, message, { path, ...(ply === undefined ? {} : { ply }) });
}

function requireExactFields(value, fields, path, ply) {
  if (!hasExactFields(value, fields)) {
    fail('UNEXPECTED_FIELDS', `${path} must contain exactly: ${fields.join(', ')}.`, {
      path,
      ...(ply === undefined ? {} : { ply }),
    });
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function opposite(side) {
  return side === RED ? BLACK : RED;
}

function cloneCoordinate(coordinate) {
  return { r: coordinate.r, c: coordinate.c };
}

function clonePiece(piece) {
  return piece === null ? null : { type: piece.type, side: piece.side };
}

function cloneBoard(board) {
  return board.map((row) => row.map(clonePiece));
}

function cloneTerminal(terminal) {
  return terminal === null ? null : { ...terminal };
}

function freezeBoard(board) {
  return Object.freeze(board.map((row) => Object.freeze(row.map((piece) => (
    piece === null ? null : Object.freeze(clonePiece(piece))
  )))));
}

function freezeRecord(record) {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    id: record.id,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    initialPosition: Object.freeze({
      board: freezeBoard(record.initialPosition.board),
      sideToMove: record.initialPosition.sideToMove,
    }),
    moves: Object.freeze(record.moves.map((move) => Object.freeze({
      from: Object.freeze(cloneCoordinate(move.from)),
      to: Object.freeze(cloneCoordinate(move.to)),
    }))),
    mode: record.mode,
    result: Object.freeze({ ...record.result }),
  });
}

function freezeReplaySnapshot(snapshot) {
  return Object.freeze({
    board: freezeBoard(snapshot.board),
    sideToMove: snapshot.sideToMove,
    selectedPly: snapshot.selectedPly,
    totalPlies: snapshot.totalPlies,
    moveMetadata: Object.freeze(snapshot.moveMetadata.map((move) => Object.freeze({
      ply: move.ply,
      side: move.side,
      from: Object.freeze(cloneCoordinate(move.from)),
      to: Object.freeze(cloneCoordinate(move.to)),
      captured: move.captured === null ? null : Object.freeze(clonePiece(move.captured)),
      notation: move.notation,
    }))),
    positionHashes: Object.freeze([...snapshot.positionHashes]),
    repetitionHistory: Object.freeze(snapshot.repetitionHistory.map((entry) => Object.freeze({
      key: entry.key,
      mover: entry.mover,
      check: entry.check,
    }))),
    terminal: snapshot.terminal === null ? null : Object.freeze({ ...snapshot.terminal }),
  });
}

function fail(code, message, details) {
  throw new GameRecordValidationError(code, message, details);
}
