import { GAME_TRANSFER_FORMAT, GAME_TRANSFER_VERSION, GAME_TRANSFER_MAX_BYTES,
  GAME_TRANSFER_MAX_PLIES, GAME_TRANSFER_MAX_DEPTH, GameTransferError } from './contract.js?v=7ba133c431';

export const invalidWorkerResponse = () => new GameTransferError('INVALID_WORKER_RESPONSE', '棋譜驗證回應無效。');
const require = condition => { if (!condition) throw invalidWorkerResponse(); };
const side = value => value === 'red' || value === 'black';
const opposite = value => value === 'red' ? 'black' : 'red';
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const documentFields = ['format', 'schemaVersion', 'exportedAt', 'initialPosition', 'moves', 'mode', 'playerSide', 'status', 'result'];

// Bound work BEFORE recursive comparison/freezing. Structured clone can preserve
// cycles and aliases. Reject cycles, accessors, exotic values and oversized graphs;
// do not skip previously frozen objects. No chess engine runs on this side.
function boundedData(value) {
  const ancestors = new Set(), objects = [];
  let nodes = 0, characters = 0;
  function visit(item, depth) {
    require(++nodes <= 65536);
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { require(Number.isFinite(item)); return; }
    if (typeof item === 'string') {
      characters += item.length;
      require(item.length <= 512 && characters <= GAME_TRANSFER_MAX_BYTES); return;
    }
    require(typeof item === 'object' && depth < GAME_TRANSFER_MAX_DEPTH && !ancestors.has(item));
    const array = Array.isArray(item);
    require(array ? Object.getPrototypeOf(item) === Array.prototype && item.length <= GAME_TRANSFER_MAX_PLIES + 1
      : [Object.prototype, null].includes(Object.getPrototypeOf(item)));
    const keys = Reflect.ownKeys(item);
    require(array ? keys.length === item.length + 1 : keys.length <= 10);
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      require(typeof key === 'string' && key.length <= 64);
      if (array) require(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length);
      const field = Object.getOwnPropertyDescriptor(item, key);
      require(field && Object.hasOwn(field, 'value') && field.enumerable);
      visit(field.value, depth + 1);
    }
    ancestors.delete(item);
    objects.push(item);
  }
  visit(value, 0);
  return objects;
}

function exact(value, fields) {
  require(value !== null && typeof value === 'object' && !Array.isArray(value));
  require(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}
function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
function piece(value) {
  if (value === null) return;
  exact(value, ['type', 'side']);
  require(['K', 'A', 'B', 'N', 'R', 'C', 'P'].includes(value.type) && side(value.side));
}
function board(value) {
  require(Array.isArray(value) && value.length === 10);
  for (const row of value) {
    require(Array.isArray(row) && row.length === 9);
    for (const cell of row) piece(cell);
  }
}
function coordinate(value) {
  exact(value, ['r', 'c']); require(integer(value.r, 9) && integer(value.c, 8));
}
function result(value) {
  exact(value, ['winner', 'terminationReason']);
  const decisive = ['checkmate', 'stalemate', 'perpetual-check'].includes(value.terminationReason);
  require(decisive ? side(value.winner)
    : ['threefold-repetition', 'mutual-perpetual-check'].includes(value.terminationReason) && value.winner === null);
}
function document(value) {
  exact(value, documentFields);
  require(value.format === GAME_TRANSFER_FORMAT && value.schemaVersion === GAME_TRANSFER_VERSION);
  require(typeof value.exportedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.exportedAt)
    && new Date(value.exportedAt).toISOString() === value.exportedAt);
  require(['easy', 'medium', 'hard', 'experimental-b', 'pvp'].includes(value.mode));
  require(value.playerSide === null || side(value.playerSide));
  require(value.mode !== 'pvp' || value.playerSide === null);
  require(value.status === 'completed' || value.status === 'in-progress');
  if (value.status === 'completed') result(value.result); else require(value.result === null);
  exact(value.initialPosition, ['board', 'sideToMove']);
  board(value.initialPosition.board); require(side(value.initialPosition.sideToMove));
  require(Array.isArray(value.moves) && value.moves.length <= GAME_TRANSFER_MAX_PLIES);
  for (const move of value.moves) {
    exact(move, ['from', 'to']); coordinate(move.from); coordinate(move.to);
  }
}

// This is a bounded wire-consistency fold (<= 1024 coordinate assignments, with
// 90-cell fingerprints), NOT legal-move generation, notation or adjudication.
// Those remain exclusively in validation-worker.js / the existing replay core.
function replay(value, doc) {
  exact(value, ['board', 'sideToMove', 'selectedPly', 'totalPlies', 'moveMetadata', 'positionHashes', 'repetitionHistory', 'terminal']);
  const total = doc.moves.length;
  require(value.totalPlies === total && value.selectedPly === total);
  board(value.board); require(side(value.sideToMove));
  for (const [key, length] of [['moveMetadata', total], ['positionHashes', total + 1], ['repetitionHistory', total + 1]]) {
    require(Array.isArray(value[key]) && value[key].length === length);
  }
  require(equal(value.terminal, doc.result));
  const cells = doc.initialPosition.board.map(row => row.slice());
  let turn = doc.initialPosition.sideToMove;
  function fingerprint(index, mover) {
    const hash = cells.map(row => row.map(p => p ? p.type + (p.side === 'red' ? 'r' : 'b') : '.').join('')).join('');
    require(value.positionHashes[index] === hash);
    const entry = value.repetitionHistory[index];
    exact(entry, ['key', 'mover', 'check']);
    require(entry.key === hash + '|' + turn && entry.mover === mover && typeof entry.check === 'boolean');
    if (index === 0) require(entry.check === false);
  }
  fingerprint(0, null);
  for (let i = 0; i < total; i++) {
    const move = doc.moves[i], meta = value.moveMetadata[i], { from, to } = move;
    exact(meta, ['ply', 'side', 'from', 'to', 'captured', 'notation']);
    coordinate(meta.from); coordinate(meta.to); piece(meta.captured);
    require(meta.ply === i + 1 && meta.side === turn && equal(meta.from, from) && equal(meta.to, to));
    require(typeof meta.notation === 'string' && /^[\u3400-\u9fff]{4}$/.test(meta.notation));
    const moving = cells[from.r][from.c], captured = cells[to.r][to.c];
    require(moving !== null && moving.side === turn && (captured === null || captured.side !== turn) && equal(meta.captured, captured));
    cells[to.r][to.c] = moving; cells[from.r][from.c] = null;
    turn = opposite(turn); fingerprint(i + 1, meta.side);
  }
  require(value.sideToMove === turn && equal(value.board, cells));
}

function sourceDocument(input) {
  // Only correlate an already-successful Worker result to the immutable request.
  // Native JSON decoding is byte-bounded; strict duplicate-key parsing and all
  // chess validation still run in the Worker. This is never a failure fallback.
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  require(bytes.byteLength <= GAME_TRANSFER_MAX_BYTES);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  boundedData(parsed); document(parsed);
  return parsed;
}

export function validateWorkerMessage(data, input, requestId) {
  const objects = boundedData(data);
  require(data.kind === 'game-transfer-validation' && data.requestId === requestId);
  if (data.ok === false) {
    exact(data, ['kind', 'requestId', 'ok', 'error']);
    const error = data.error, fields = ['code', 'message', 'path', 'ply', 'offset', 'byteLength'];
    require(error && typeof error === 'object' && !Array.isArray(error));
    require(Object.keys(error).every(key => fields.includes(key)) && Object.hasOwn(error, 'code') && Object.hasOwn(error, 'message'));
    require(typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      && typeof error.message === 'string' && error.message.length > 0);
    if (Object.hasOwn(error, 'path')) require(typeof error.path === 'string' && error.path.length <= 256);
    for (const key of ['ply', 'offset', 'byteLength']) if (Object.hasOwn(error, key)) require(integer(error[key], 3 * GAME_TRANSFER_MAX_BYTES));
    return { error: new GameTransferError(error.code, error.message, error) };
  }
  exact(data, ['kind', 'requestId', 'ok', 'value']); require(data.ok === true);
  exact(data.value, ['document', 'replay']); document(data.value.document);
  require(equal(data.value.document, sourceDocument(input)));
  replay(data.value.replay, data.value.document);
  // Freeze the already bounded postorder list, including descendants of an
  // already-frozen parent. No recursive freeze over untrusted data is needed.
  for (const object of objects) Object.freeze(object);
  return { value: data.value };
}
