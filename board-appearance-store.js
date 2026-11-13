import { BOARD_PHOTO_STORED_BYTES, validateBoardAppearanceSettings } from './board-appearance.js?v=fb9fc70633';

export const BOARD_APPEARANCE_DATABASE = 'chinese-chess-training:board-appearance';
const STORE = 'appearance', KEY = 'current';

function canonicalRecord(record) {
  if (!record || record.version !== 1 || !(record.blob instanceof Blob)
    || record.blob.type !== 'image/jpeg' || record.blob.size <= 0 || record.blob.size > BOARD_PHOTO_STORED_BYTES
    || Object.keys(record).some(key => !['version', 'blob', 'settings'].includes(key))) {
    throw new Error('Invalid saved board appearance');
  }
  return { version: 1, blob: record.blob, settings: validateBoardAppearanceSettings(record.settings) };
}

// Deliberately separate from custom positions: no migration, shared schema or keys.
export function createBoardAppearanceStore({ factory = () => globalThis.indexedDB, timeoutMs = 3000 } = {}) {
  let disposed = false;
  const pending = new Set();
  function run(mode, operation) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new Error('Disposed')); return; }
      let db, tx, request, done = false, result;
      const finish = (error) => {
        if (done) return;
        done = true; clearTimeout(timer); pending.delete(cancel); db?.close();
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => {
        try { tx?.abort(); } catch { /* A terminal transaction may already have committed. */ }
        finish(new Error('Appearance storage unavailable or completion not confirmed'));
      };
      const timer = setTimeout(cancel, timeoutMs); pending.add(cancel);
      try {
        request = factory().open(BOARD_APPEARANCE_DATABASE, 1);
        request.onblocked = cancel;
        request.onerror = () => finish(request.error || new Error('Open failed'));
        request.onupgradeneeded = () => {
          if (done || disposed) { request.transaction.abort(); return; }
          request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => {
          db = request.result;
          if (done || disposed) { db.close(); return; }
          db.onversionchange = cancel;
          try {
            tx = db.transaction(STORE, mode);
            tx.oncomplete = () => finish();
            tx.onabort = () => finish(tx.error || new Error('Transaction aborted'));
            tx.onerror = () => {}; // Abort is the terminal failure, not request success.
            const op = operation(tx.objectStore(STORE));
            op.onsuccess = () => { result = op.result; };
          } catch (error) {
            try { tx?.abort(); } catch { /* already terminal */ }
            finish(error);
          }
        };
      } catch (error) { finish(error); }
    });
  }
  return {
    async load() { const raw = await run('readonly', store => store.get(KEY)); return raw === undefined ? null : canonicalRecord(raw); },
    save(record) { const valid = canonicalRecord(record); return run('readwrite', store => store.put(valid, KEY)); },
    clear() { return run('readwrite', store => store.delete(KEY)); },
    dispose() { disposed = true; for (const cancel of [...pending]) cancel(); },
  };
}
