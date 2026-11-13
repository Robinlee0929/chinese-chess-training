import { GAME_TRANSFER_MAX_BYTES, GAME_TRANSFER_TIMEOUT_MS, GameTransferError } from './contract.js?v=fb9fc70633';
import { invalidWorkerResponse, validateWorkerMessage } from './worker-protocol.js?v=fb9fc70633';

// No parser/replay import here: a failed Worker must not fall back to the UI thread.
export function createGameTransferValidationClient({
  WorkerClass = globalThis.Worker,
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  let active = null, sequence = 0, disposed = false;
  function cancel() {
    if (active) active.finish(new GameTransferError('CANCELLED', '已取消棋譜驗證。'));
  }
  function validate(input, { signal } = {}) {
    cancel();
    if (disposed) return Promise.reject(new GameTransferError('DISPOSED', '棋譜驗證器已關閉。'));
    if (signal?.aborted) return Promise.reject(new GameTransferError('CANCELLED', '已取消棋譜驗證。'));
    const size = typeof input === 'string' ? input.length
      : input instanceof Uint8Array || input instanceof ArrayBuffer ? input.byteLength : null;
    if (size === null) return Promise.reject(new GameTransferError('INVALID_INPUT', '請提供 JSON 文字或 UTF-8 位元組。'));
    // Cheap admission bound; exact UTF-8 size is checked in the Worker.
    if (size > GAME_TRANSFER_MAX_BYTES) return Promise.reject(new GameTransferError('FILE_TOO_LARGE', '棋譜檔案不可超過 1 MiB。'));
    return new Promise((resolve, reject) => {
      const requestId = ++sequence, started = now();
      let worker, timer, done = false;
      const abort = () => finish(new GameTransferError('CANCELLED', '已取消棋譜驗證。'));
      const finish = (error, value) => {
        if (done) return;
        done = true;
        // Success is already checked/frozen. Cleanup cannot strand the promise,
        // even if a host adapter throws; each cleanup action is still attempted.
        let cleanupFailed = false;
        const cleanup = fn => { try { fn(); } catch { cleanupFailed = true; } };
        if (timer !== undefined) cleanup(() => clearTimer(timer));
        cleanup(() => signal?.removeEventListener('abort', abort));
        if (worker) {
          for (const key of ['onmessage', 'onerror', 'onmessageerror']) cleanup(() => { worker[key] = null; });
          cleanup(() => worker.terminate());
        }
        if (active?.requestId === requestId) active = null;
        if (error || cleanupFailed) reject(error || invalidWorkerResponse()); else resolve(value);
      };
      active = { requestId, finish };
      try {
        // The caller may reuse/mutate its byte buffer after validate() returns.
        const source = typeof input === 'string' ? input : new Uint8Array(input instanceof ArrayBuffer ? new Uint8Array(input) : input);
        worker = new WorkerClass(new URL('./validation-worker.js?v=fb9fc70633', import.meta.url), { type: 'module', name: 'game-transfer-validation' });
        if (done) { worker.terminate(); return; }
        worker.onmessage = event => {
          if (done || active?.requestId !== requestId) return;
          try {
            // Retained callbacks/old IDs cannot complete a newer request.
            const data = event.data;
            const id = data && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, 'requestId') : null;
            if (id && Object.hasOwn(id, 'value') && Number.isSafeInteger(id.value) && id.value > 0 && id.value !== requestId) return;
            const timeout = () => new GameTransferError('VALIDATION_TIMEOUT', '棋譜驗證超過 10 秒，已停止。');
            if (now() - started >= GAME_TRANSFER_TIMEOUT_MS) { finish(timeout()); return; }
            const result = validateWorkerMessage(data, source, requestId);
            // Protocol work and freezing must finish inside the same deadline.
            if (now() - started >= GAME_TRANSFER_TIMEOUT_MS) { finish(timeout()); return; }
            finish(result.error, result.value);
          } catch {
            finish(invalidWorkerResponse());
          }
        };
        worker.onerror = event => {
          try { event.preventDefault?.(); } catch { /* Host event failure must still settle. */ }
          finish(new GameTransferError('VALIDATOR_UNAVAILABLE', '無法啟動或執行棋譜驗證器。'));
        };
        worker.onmessageerror = () => finish(new GameTransferError('INVALID_WORKER_RESPONSE', '無法讀取棋譜驗證回應。'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        if (done) return;
        timer = setTimer(() => finish(new GameTransferError('VALIDATION_TIMEOUT', '棋譜驗證超過 10 秒，已停止。')),
          Math.max(0, GAME_TRANSFER_TIMEOUT_MS - (now() - started)));
        worker.postMessage({ kind: 'validate-game-transfer', requestId, input: source });
      } catch {
        finish(new GameTransferError('VALIDATOR_UNAVAILABLE', '無法啟動或執行棋譜驗證器。'));
      }
    });
  }
  return Object.freeze({ validate, cancel, dispose() { disposed = true; cancel(); } });
}
