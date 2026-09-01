// AI 搜索在 Worker 執行，避免深層搜索卡住畫面
import { findBestMove } from './ai.js?v=7ddbb73eba';

self.onmessage = (e) => {
  const message = e.data;
  const t0 = Date.now();
  let result = null;
  if (message.kind === 'review-candidate') {
    const {
      recordId, ply, revision, board, sideToMove, repetitionPrefix, analysisPreset,
    } = message;
    try {
      if (analysisPreset !== 'review-v1') throw new TypeError('Unsupported Review AI preset.');
      result = findBestMove(board, sideToMove, analysisPreset, [], { repetitionPrefix });
    } catch (err) {
      self.postMessage({ kind: 'review-candidate', recordId, ply, revision, error: String(err) });
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

  const { board, side, level, token, recent } = message;
  try {
    result = findBestMove(board, side, level, recent);
  } catch (err) {
    self.postMessage({ token, error: String(err) });
    return;
  }
  self.postMessage({ token, result, timeMs: Date.now() - t0 });
};
