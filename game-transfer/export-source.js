import { GAME_TRANSFER_FORMAT, GAME_TRANSFER_VERSION, GAME_TRANSFER_MAX_PLIES, GameTransferError, deepFreeze } from './contract.js?v=151972aca4';

const reject = (message, code = 'EXPORT_SOURCE_UNAVAILABLE') => { throw new GameTransferError(code, message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sides = ['red', 'black'];
const modes = ['easy', 'medium', 'hard', 'experimental-b', 'pvp'];
function copyBoard(board) {
  if (!Array.isArray(board) || board.length !== 10 || board.some(row => !Array.isArray(row) || row.length !== 9)) reject('棋盤資料不完整，無法匯出。');
  return board.map(row => row.map(piece => piece === null ? null : { type: piece.type, side: piece.side }));
}
function copyMoves(moves) {
  if (!Array.isArray(moves)) reject('棋譜資料不完整，無法匯出。');
  if (moves.length > GAME_TRANSFER_MAX_PLIES) reject('棋譜超過 1,024 著，無法完整匯出；不會截斷棋譜。', 'TOO_MANY_PLIES');
  return moves.map(({ from, to }) => ({ from: { r: from.r, c: from.c }, to: { r: to.r, c: to.c } }));
}
const position = p => ({ board: copyBoard(p.board), sideToMove: p.sideToMove });

// Admission and identity only. Full legal replay belongs to the validation Worker.
// The immutable document contains no session, revision, storage or browser data.
export function captureExportSource(source, exportedAt) {
  if (!source || !source.available) reject('目前畫面無法匯出這份棋譜。');
  if (source.busy || source.aiThinking) reject('請等待 AI 思考及棋步動畫完成後再匯出。');
  if (source.invalidating || source.recordError) reject('棋譜狀態不一致，無法匯出；請重新開局。');
  let initialPosition, moves, mode, playerSide, status, result, expected = null;
  let session = null, record = null;
  if (source.kind === 'live') {
    session = source.session;
    if (!session || session.mode !== source.mode || session.modeRevision !== source.modeRevision
      || !session.id || !Number.isSafeInteger(source.revision)) reject('棋局身分已變更，請重新開啟匯出。');
    mode = source.mode;
    playerSide = mode === 'pvp' ? null : session.humanSide;
    if (mode !== 'pvp' && (!sides.includes(playerSide) || playerSide !== source.humanSide)) reject('玩家棋色與目前棋局不一致。');
    initialPosition = position(session.initialPosition);
    moves = copyMoves(source.history);
    status = source.over ? 'completed' : 'in-progress';
    result = null;
    if (source.over) {
      record = source.completedRecord;
      if (!record || source.completedSessionId !== session.id || record.id !== session.id || record.mode !== mode
        || !same(position(record.initialPosition), initialPosition) || !same(copyMoves(record.moves), moves)
        || record.result?.winner !== source.winner) reject('尚無可安全匯出的完成棋譜。');
      result = { winner: record.result.winner, terminationReason: record.result.terminationReason };
    }
    if (!Array.isArray(source.positionHashes) || source.positionHashes.length !== moves.length + 1
      || !Array.isArray(source.repetitionHistory) || source.repetitionHistory.length !== moves.length + 1) reject('棋譜進度尚未確認，請稍後再試。');
    let turn = initialPosition.sideToMove;
    const metadata = source.history.map((entry, index) => {
      const move = { ply: index + 1, side: turn, ...moves[index],
        captured: entry.captured === null ? null : { type: entry.captured.type, side: entry.captured.side }, notation: entry.nota };
      turn = turn === 'red' ? 'black' : 'red';
      return move;
    });
    expected = deepFreeze({ board: copyBoard(source.board), sideToMove: source.turn,
      positionHashes: [...source.positionHashes],
      repetitionHistory: source.repetitionHistory.map(({ key, mover, check }) => ({ key, mover, check })),
      moveMetadata: metadata });
  } else if (source.kind === 'review' && source.sourceKind === 'completed') {
    record = source.record;
    if (!record) reject('目前沒有可匯出的整局棋譜。');
    initialPosition = position(record.initialPosition); moves = copyMoves(record.moves);
    mode = record.mode; status = 'completed';
    playerSide = source.stored ? null : (sides.includes(source.verifiedPlayerSide) ? source.verifiedPlayerSide : null);
    result = { winner: record.result.winner, terminationReason: record.result.terminationReason };
  } else reject('這個複盤來源尚不支援整局匯出。');
  if (!modes.includes(mode)) reject('不支援此對弈模式。');
  const document = deepFreeze({ format: GAME_TRANSFER_FORMAT, schemaVersion: GAME_TRANSFER_VERSION,
    exportedAt, initialPosition, moves, mode, playerSide, status, result });
  // Includes contents, not just move count. References + revision distinguish
  // a replacement game or an undo/replay that happens to reach the same board.
  const identity = JSON.stringify({ document, expected, revision: source.revision,
    modeRevision: source.modeRevision, sessionId: session?.id, recordId: record?.id, stored: source.stored });
  return Object.freeze({ kind: source.kind, document, expected, identity, session, record });
}
export function exportSourceIsCurrent(snapshot, source) {
  try {
    const current = captureExportSource(source, snapshot.document.exportedAt);
    return current.identity === snapshot.identity && current.session === snapshot.session && current.record === snapshot.record;
  } catch { return false; }
}
export function exportReplayMatches(snapshot, validated) {
  if (!same(validated.document, snapshot.document)) return false;
  if (!snapshot.expected) return true;
  return Object.entries(snapshot.expected).every(([key, value]) => same(validated.replay[key], value));
}
