import { createGameTimeline, replayGameTimeline, createSessionGameRecord, GameRecordValidationError } from '../game-record.js?v=151972aca4';
import { validateCustomPlayPosition } from '../custom-position-play.js?v=151972aca4';
import { checkTransferOutputSize as checkOutputSize, renderTransferJSON, renderTransferTXT } from './export-format.js?v=151972aca4';
import { GAME_TRANSFER_FORMAT, GAME_TRANSFER_VERSION, GAME_TRANSFER_MAX_BYTES, GAME_TRANSFER_MAX_PLIES, GameTransferError, fail, deepFreeze } from './contract.js?v=151972aca4';
import { parseStrictTransferJSON } from './strict-json.js?v=151972aca4';
export { GAME_TRANSFER_FORMAT, GAME_TRANSFER_VERSION, GAME_TRANSFER_MAX_BYTES, GAME_TRANSFER_MAX_PLIES, GAME_TRANSFER_MAX_DEPTH, GAME_TRANSFER_TIMEOUT_MS, GameTransferError } from './contract.js?v=151972aca4';

const fields = ['format', 'schemaVersion', 'exportedAt', 'initialPosition', 'moves', 'mode', 'playerSide', 'status', 'result'];
const modes = new Set(['easy', 'medium', 'hard', 'experimental-b', 'pvp']);

function exact(value, expected, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_OBJECT', '棋譜欄位必須是一般物件。', { path });
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== expected.length
    || expected.some(key => !descriptors[key] || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    fail('UNEXPECTED_FIELDS', '棋譜含有缺少、不支援或非資料欄位。', { path });
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

// Structural validation before passing caller objects to the existing domain.
function checkNestedFields(input) {
  exact(input.initialPosition, ['board', 'sideToMove'], 'initialPosition');
  const board = input.initialPosition.board;
  if (!Array.isArray(board) || board.length !== 10) fail('INVALID_BOARD_ROWS', '棋盤必須有 10 列。', { path: 'initialPosition.board' });
  for (let r = 0; r < 10; r++) {
    if (!Array.isArray(board[r]) || board[r].length !== 9) fail('INVALID_BOARD_COLUMNS', '棋盤每列必須有 9 格。', { path: `initialPosition.board[${r}]` });
    for (let c = 0; c < 9; c++) if (board[r][c] !== null) exact(board[r][c], ['type', 'side'], `initialPosition.board[${r}][${c}]`);
  }
  if (!Array.isArray(input.moves)) fail('INVALID_MOVES', '著法必須是陣列。', { path: 'moves' });
  if (input.moves.length > GAME_TRANSFER_MAX_PLIES) fail('TOO_MANY_PLIES', '棋譜不可超過 1,024 著。', { path: 'moves' });
  for (let i = 0; i < input.moves.length; i++) {
    exact(input.moves[i], ['from', 'to'], `moves[${i}]`);
    for (const key of ['from', 'to']) exact(input.moves[i][key], ['r', 'c'], `moves[${i}].${key}`);
  }
}

function canonical(input) {
  exact(input, fields, 'transfer');
  if (input.format !== GAME_TRANSFER_FORMAT) fail('UNSUPPORTED_FORMAT', '不支援此棋譜格式。');
  if (input.schemaVersion !== GAME_TRANSFER_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', '不支援此棋譜版本。');
  if (!timestamp(input.exportedAt)) fail('INVALID_EXPORTED_AT', '匯出時間格式無效。', { path: 'exportedAt' });
  if (!modes.has(input.mode)) fail('UNSUPPORTED_MODE', '不支援此對弈模式。', { path: 'mode' });
  if (![null, 'red', 'black'].includes(input.playerSide)) fail('INVALID_PLAYER_SIDE', '玩家棋色必須是紅、黑或未記錄。', { path: 'playerSide' });
  if (input.mode === 'pvp' && input.playerSide !== null) fail('PLAYER_SIDE_MODE_MISMATCH', '雙人模式的玩家棋色必須是 null。', { path: 'playerSide' });
  if (!['in-progress', 'completed'].includes(input.status)) fail('INVALID_STATUS', '棋局狀態無效。', { path: 'status' });
  if (input.status === 'in-progress') {
    if (input.result !== null) fail('UNEXPECTED_RESULT', '未完成棋局不得宣告結果。', { path: 'result' });
  } else exact(input.result, ['winner', 'terminationReason'], 'result');
  checkNestedFields(input);

  // These local adapter fields are never exported or persisted. No imported ID
  // can become a live Session or a GameRecord-store identity.
  const root = createGameTimeline({ id: 'portable-validation', createdAt: input.exportedAt,
    initialPosition: input.initialPosition, moves: [], mode: input.mode });
  const position = validateCustomPlayPosition({ initialBoard: root.initialPosition.board, sideToMove: root.initialPosition.sideToMove });
  if (!position.ok) {
    if (position.error.code !== 'TERMINAL_POSITION') fail(position.error.code, position.error.message, { path: 'initialPosition' });
    if (input.moves.length) fail('MOVE_AFTER_TERMINAL', '初始局面已終局，不可再走棋。', { path: 'moves[0]', ply: 1 });
    if (input.status !== 'completed') fail('TERMINAL_INCOMPLETE_GAME', '已終局的棋譜不可標為未完成。');
    // Only the final terminal-only rejection is exempted. Palace, count,
    // facing-kings and non-moving-side-check checks have already succeeded.
  }
  const timelineInput = { ...root, moves: input.moves };
  let timeline;
  if (input.status === 'completed') {
    const record = createSessionGameRecord({ ...timelineInput, schemaVersion: 1,
      completedAt: input.exportedAt, result: input.result });
    timeline = { id: record.id, createdAt: record.createdAt, initialPosition: record.initialPosition, moves: record.moves, mode: record.mode };
  } else timeline = createGameTimeline(timelineInput);
  const replay = replayGameTimeline(timeline, timeline.moves.length);
  if (input.status === 'in-progress' && replay.terminal !== null) fail('TERMINAL_INCOMPLETE_GAME', '已終局的棋譜不可標為未完成。');
  const document = deepFreeze({ format: GAME_TRANSFER_FORMAT, schemaVersion: GAME_TRANSFER_VERSION,
    exportedAt: input.exportedAt, initialPosition: timeline.initialPosition, moves: timeline.moves,
    mode: timeline.mode, playerSide: input.playerSide, status: input.status,
    result: replay.terminal === null ? null : { ...replay.terminal } });
  checkOutputSize(JSON.stringify(document));
  return Object.freeze({ document, replay });
}

export function validateGameTransfer(input) {
  try { return canonical(input); }
  catch (error) {
    if (error instanceof GameTransferError) throw error;
    if (!(error instanceof GameRecordValidationError)) throw error;
    const code = error.code === 'NONTERMINAL_RECORD' ? 'NONTERMINAL_COMPLETED_GAME'
      : ['RESULT_WINNER_MISMATCH', 'RESULT_REASON_MISMATCH'].includes(error.code) ? 'RESULT_MISMATCH' : error.code;
    throw new GameTransferError(code, error.message, error);
  }
}

export function parseGameTransfer(input) {
  return validateGameTransfer(parseStrictTransferJSON(input));
}

export function serializeGameTransfer(input) {
  return renderTransferJSON(validateGameTransfer(input));
}

export function serializeGameTransferTXT(input) {
  return renderTransferTXT(validateGameTransfer(input));
}
