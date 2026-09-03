// AI 搜索在 Worker 執行，避免深層搜索卡住畫面
import { findBestMove } from './ai.js?v=79cf894baf';

const SIDES = new Set(['red', 'black']);
const LEVELS = new Set(['easy', 'medium', 'hard']);
const PIECES = new Set(['K', 'A', 'B', 'N', 'R', 'C', 'P']);

function validBoard(board) {
  return Array.isArray(board) && board.length === 10 && board.every((row) => (
    Array.isArray(row) && row.length === 9 && row.every((piece) => (
      piece === null || (!!piece && typeof piece === 'object'
        && PIECES.has(piece.type) && SIDES.has(piece.side))
    ))
  ));
}

function validNormalRequest(message) {
  return validBoard(message.board) && SIDES.has(message.side) && LEVELS.has(message.level)
    && Number.isInteger(message.token) && Array.isArray(message.recent)
    && message.recent.every((key) => typeof key === 'string');
}

function validReviewRequest(message) {
  return typeof message.recordId === 'string' && message.recordId.length > 0
    && Number.isInteger(message.ply) && message.ply >= 0
    && Number.isInteger(message.revision) && message.revision >= 0
    && validBoard(message.board) && SIDES.has(message.sideToMove)
    && message.analysisPreset === 'review-v1'
    && Array.isArray(message.repetitionPrefix) && message.repetitionPrefix.length > 0
    && message.repetitionPrefix.every((entry) => (
      !!entry && typeof entry === 'object' && typeof entry.key === 'string'
      && (entry.mover === null || SIDES.has(entry.mover)) && typeof entry.check === 'boolean'
    ));
}

function unsupportedRequest(message) {
  const response = { kind: 'worker-error', error: 'unsupported-request' };
  if (Number.isInteger(message?.token)) response.token = message.token;
  if (Number.isInteger(message?.revision)) response.revision = message.revision;
  self.postMessage(response);
}

self.onmessage = (e) => {
  const message = e?.data;
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    unsupportedRequest(message);
    return;
  }
  const t0 = Date.now();
  let result = null;
  if (message.kind === 'review-candidate') {
    const {
      recordId, ply, revision, board, sideToMove, repetitionPrefix, analysisPreset,
    } = message;
    try {
      if (!validReviewRequest(message)) {
        self.postMessage({ kind: 'review-candidate', recordId, ply, revision, error: 'unsupported-request' });
        return;
      }
      result = findBestMove(board, sideToMove, analysisPreset, [], { repetitionPrefix });
    } catch (err) {
      self.postMessage({ kind: 'review-candidate', recordId, ply, revision, error: 'search-failed' });
      return;
    }
    self.postMessage({
      kind: 'review-candidate',
      recordId,
      ply,
      revision,
      result,
      timeMs: Date.now() - t0,
    });
    return;
  }

  const explicitNormal = message.kind === 'normal-game';
  const legacyNormal = !Object.prototype.hasOwnProperty.call(message, 'kind');
  if ((!explicitNormal && !legacyNormal) || !validNormalRequest(message)) {
    unsupportedRequest(message);
    return;
  }
  const { board, side, level, token, recent } = message;
  try {
    result = findBestMove(board, side, level, recent);
  } catch (err) {
    self.postMessage({ token, error: 'search-failed' });
    return;
  }
  self.postMessage({ token, result, timeMs: Date.now() - t0 });
};
