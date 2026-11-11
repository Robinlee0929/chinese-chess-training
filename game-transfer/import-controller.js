import { GAME_TRANSFER_MAX_BYTES, GAME_TRANSFER_TIMEOUT_MS, GameTransferError } from './contract.js?v=1ebb13d661';
import { createGameTransferValidationClient } from './worker-client.js?v=1ebb13d661';
import { createImportedGameReview } from './imported-review.js?v=1ebb13d661';

export function gameImportErrorMessage(error) {
  if (Number.isInteger(error?.ply) && error.ply > 0) return `第 ${error.ply} 著不合法，尚未載入棋譜。`;
  return error instanceof GameTransferError && /[\u3400-\u9fff]/u.test(error.message)
    ? `${error.message} 尚未載入棋譜。` : '無法讀取或驗證這份棋譜，尚未載入棋譜。';
}
export function readGameImportFile(file, { signal, FileReaderClass = globalThis.FileReader,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let reader, timer, settled = false;
    const finish = (error, bytes) => {
      if (settled) return; settled = true;
      let cleanupFailed = false;
      const cleanup = fn => { try { fn(); } catch { cleanupFailed = true; } };
      if (timer !== undefined) cleanup(() => clearTimer(timer));
      cleanup(() => signal?.removeEventListener('abort', abort));
      if (reader) {
        for (const key of ['onload', 'onerror', 'onabort']) cleanup(() => { reader[key] = null; });
        cleanup(() => { if (reader.readyState === 1) reader.abort(); });
      }
      if (error || cleanupFailed) reject(error || new GameTransferError('FILE_READ_FAILED', '無法讀取這份檔案。')); else resolve(bytes);
    };
    const abort = () => finish(new GameTransferError('CANCELLED', '已取消匯入。'));
    try {
      if (signal?.aborted) { abort(); return; }
      reader = new FileReaderClass();
      reader.onload = () => { try { finish(null, reader.result); } catch { finish(new GameTransferError('FILE_READ_FAILED', '無法讀取這份檔案。')); } };
      reader.onerror = () => finish(new GameTransferError('FILE_READ_FAILED', '無法讀取這份檔案。'));
      reader.onabort = abort;
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimer(() => finish(new GameTransferError('FILE_READ_TIMEOUT', '讀取檔案超過 10 秒，已停止。')), GAME_TRANSFER_TIMEOUT_MS);
      reader.readAsArrayBuffer(file);
    } catch { finish(new GameTransferError('FILE_READ_FAILED', '無法讀取這份檔案。')); }
  });
}

export function createGameImportController({ context, accept, client = createGameTransferValidationClient(), readFile = readGameImportFile }) {
  let scope = null, job = null, ready = null, lastFile = null, disposed = false;
  const current = token => !disposed && scope === token && context().active && context().revision === token.revision;
  function cancel() { scope = null; ready = null; lastFile = null; job?.abort(); job = null; client.cancel(); }
  return Object.freeze({
    open() { cancel(); const state = context(); if (disposed || !state.active) return false; scope = { revision: state.revision }; return true; },
    cancel,
    check() { if (scope && current(scope)) return true; cancel(); return false; },
    async select(file) {
      const token = scope;
      if (!token || !current(token)) { cancel(); return { status: 'cancelled' }; }
      if (file === lastFile && (job || ready)) return { status: 'ignored' };
      job?.abort(); client.cancel(); ready = null; lastFile = file;
      const operation = new AbortController(); job = operation;
      const active = () => job === operation && current(token) && !operation.signal.aborted;
      try {
        if (!file || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > GAME_TRANSFER_MAX_BYTES)
          throw new GameTransferError('FILE_TOO_LARGE', '請選擇不超過 1 MiB 的 JSON 棋譜。');
        if (typeof file.name !== 'string' || !/\.json$/i.test(file.name)
          || !['', 'application/json', 'text/json', 'application/octet-stream'].includes(file.type))
          throw new GameTransferError('UNSUPPORTED_FILE_TYPE', '請選擇 JSON 棋譜；不支援 TXT 匯入。');
        const bytes = await readFile(file, { signal: operation.signal });
        if (!active()) return { status: 'cancelled' };
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size) throw new GameTransferError('FILE_READ_FAILED', '檔案內容不完整。');
        const value = await client.validate(bytes, { signal: operation.signal });
        if (!active()) return { status: 'cancelled' };
        ready = createImportedGameReview(value);
        return { status: 'ready', review: ready };
      } catch (error) {
        if (!active()) return { status: 'cancelled' };
        throw error;
      } finally { if (job === operation) job = null; }
    },
    confirm() {
      if (!scope || !current(scope) || !ready || job) return false;
      const review = ready; cancel(); // Consume before calling the application; duplicate submit cannot reopen.
      return accept(review) === true;
    },
    dispose() { cancel(); disposed = true; client.dispose(); },
  });
}
