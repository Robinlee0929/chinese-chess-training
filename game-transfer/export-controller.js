import { createGameTransferValidationClient } from './worker-client.js?v=151972aca4';
import { captureExportSource, exportSourceIsCurrent, exportReplayMatches } from './export-source.js?v=151972aca4';
import { renderTransferJSON, renderTransferTXT } from './export-format.js?v=151972aca4';
import { GameTransferError } from './contract.js?v=151972aca4';

export function gameExportErrorMessage(error) {
  // The existing rule engine has English diagnostic messages. Keep those out
  // of the child-facing UI without changing Phase A error codes or validation.
  if (error instanceof GameTransferError && /[\u3400-\u9fff]/u.test(error.message)) return error.message;
  const ply = Number.isSafeInteger(error?.ply) && error.ply > 0 ? `第 ${error.ply} 著無法通過驗證。` : '';
  return `${ply}棋譜驗證失敗，無法安全匯出；請重新開局或稍後再試。`;
}

export function createGameExportController({ readSource, download, client = createGameTransferValidationClient(), now = () => new Date().toISOString() }) {
  let snapshot = null, sequence = 0, pending = null, disposed = false;
  const downloadedFormats = new Set();
  function cancel() { sequence++; client.cancel(); pending = null; snapshot = null; downloadedFormats.clear(); }
  const current = captured => !disposed && snapshot === captured && exportSourceIsCurrent(captured, readSource(captured.kind));
  return Object.freeze({
    open(kind) {
      cancel();
      if (disposed) throw new GameTransferError('DISPOSED', '匯出視窗已關閉。');
      snapshot = captureExportSource(readSource(kind), now()); return snapshot.document;
    },
    cancel,
    check() { if (!snapshot) return false; if (current(snapshot)) return true; cancel(); return false; },
    get pending() { return !!pending; },
    async export(format) {
      if (pending || downloadedFormats.has(format)) return { status: 'ignored' };
      const captured = snapshot;
      if (!['json', 'txt'].includes(format) || !captured || !current(captured)) {
        cancel(); throw new GameTransferError('EXPORT_SOURCE_STALE', '棋局已變更，請重新開啟匯出。');
      }
      const job = { id: ++sequence }; pending = job;
      const isCurrent = () => pending === job && job.id === sequence && current(captured);
      try {
        const validated = await client.validate(JSON.stringify(captured.document));
        if (!isCurrent()) return { status: 'cancelled' };
        if (!exportReplayMatches(captured, validated)) throw new GameTransferError('EXPORT_POSITION_MISMATCH', '棋盤與棋譜不一致，無法匯出；請重新開局。');
        const text = format === 'json' ? renderTransferJSON(validated) : renderTransferTXT(validated);
        if (!isCurrent()) return { status: 'cancelled' };
        const stamp = captured.document.exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const downloaded = download({ text, filename: 'chinese-chess-game-' + stamp + '.' + format,
          mime: format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8', isCurrent });
        if (downloaded !== false) downloadedFormats.add(format);
        return { status: downloaded === false ? 'cancelled' : 'downloaded' };
      } catch (error) {
        if (!isCurrent()) return { status: 'cancelled' };
        throw error;
      } finally { if (pending === job) pending = null; }
    },
    dispose() { cancel(); disposed = true; client.dispose(); },
  });
}

// Dedicated object-URL ownership; no localStorage/IndexedDB and no sharing APIs.
export function createGameExportDownload({ document, URL = globalThis.URL, Blob = globalThis.Blob,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const urls = new Map();
  function release(url) { if (urls.has(url)) { clearTimer(urls.get(url)); urls.delete(url); URL.revokeObjectURL(url); } }
  return Object.freeze({
    download({ text, filename, mime, isCurrent }) {
      if (!isCurrent()) return false;
      const url = URL.createObjectURL(new Blob([text], { type: mime }));
      urls.set(url, null);
      let link;
      try {
        link = document.createElement('a');
        link.href = url; link.download = filename; link.hidden = true;
        document.body.append(link);
        if (!isCurrent()) { release(url); return false; }
        link.click(); return true;
      } finally {
        link?.remove();
        if (urls.has(url)) urls.set(url, setTimer(() => release(url), 1000));
      }
    },
    dispose() { for (const url of [...urls.keys()]) release(url); },
  });
}
