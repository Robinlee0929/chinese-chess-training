import { parseGameTransfer } from './game-transfer.js?v=1ebb13d661';
import { GameTransferError } from './contract.js?v=1ebb13d661';

// Dedicated data-validation Worker; never imports an AI engine or storage API.
self.onmessage = ({ data }) => {
  if (!data || data.kind !== 'validate-game-transfer' || !Number.isSafeInteger(data.requestId) || data.requestId < 1) return;
  const response = { kind: 'game-transfer-validation', requestId: data.requestId };
  try {
    self.postMessage({ ...response, ok: true, value: parseGameTransfer(data.input) });
  } catch (error) {
    const known = error instanceof GameTransferError;
    const details = {};
    for (const key of ['path', 'ply', 'offset', 'byteLength']) if (known && error[key] !== undefined) details[key] = error[key];
    self.postMessage({ ...response, ok: false, error: {
      code: known ? error.code : 'VALIDATION_FAILED',
      message: known ? error.message : '無法驗證棋譜。', ...details,
    } });
  }
};
