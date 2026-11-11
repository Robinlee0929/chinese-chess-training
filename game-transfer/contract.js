// Frozen V1 contract shared by the data core and export integration.
export const GAME_TRANSFER_FORMAT = 'chinese-chess-training-game-transfer';
export const GAME_TRANSFER_VERSION = 1;
export const GAME_TRANSFER_MAX_BYTES = 1024 * 1024;
export const GAME_TRANSFER_MAX_PLIES = 1024;
export const GAME_TRANSFER_MAX_DEPTH = 16;
export const GAME_TRANSFER_TIMEOUT_MS = 10000;

export class GameTransferError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GameTransferError';
    this.code = code;
    for (const key of ['path', 'ply', 'offset', 'byteLength']) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
}

export function fail(code, message, details) {
  throw new GameTransferError(code, message, details);
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
