import { createCustomPositionStore, CustomPositionStoreError, CUSTOM_POSITION_STORAGE_KEY } from './custom-position-store.js?v=029a7ace40';

export const CUSTOM_POSITION_LOCK = `${CUSTOM_POSITION_STORAGE_KEY}:write`;
const mutations = new Set(['savePosition', 'renamePosition', 'updatePlayPreferences', 'deletePosition']);
const fail = code => { throw new CustomPositionStoreError(code, code); };

// Every application writer must use this boundary. Web Locks coordinate callers
// on this origin; they cannot protect against extensions or unrelated unlocked writers.
export function createCustomPositionCoordinator({ storage, locks, store = createCustomPositionStore({ storage }) } = {}) {
  let locksRejected = false;
  function lockManager() {
    if (locksRejected) return null;
    try { const manager = typeof locks === 'function' ? locks() : locks;
      return typeof manager?.request === 'function' ? manager : null;
    } catch { return null; }
  }
  function loadAll() {
    const snapshot = store.loadAll();
    const locksAvailable = !!lockManager();
    return Object.freeze({ ...snapshot, dataWritable: snapshot.writable,
      writable: snapshot.writable && locksAvailable, locksAvailable });
  }
  function latest(expectedRevision, id) {
    const snapshot = store.loadAll();
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_EXPECTED_REVISION');
    if (snapshot.revision === null) fail(snapshot.issues[0]?.code || 'STORAGE_CORRUPT');
    if (snapshot.revision !== expectedRevision) fail('REVISION_CONFLICT');
    const position = id === undefined ? null : snapshot.positions.find(p => p.id === id);
    if (id !== undefined && !position) fail('POSITION_NOT_FOUND');
    return { snapshot, position };
  }
  function getPosition(id, expectedRevision) { return latest(expectedRevision, id).position; }
  async function mutate(operation, args, { expectedRevision, signal, isCurrent = () => true } = {}) {
    if (!mutations.has(operation)) fail('INVALID_OPERATION');
    const manager = lockManager();
    if (!manager) fail('LOCKS_UNAVAILABLE');
    // Detach form data before waiting; queued operations must not follow later edits.
    const input = structuredClone(args);
    try { return await manager.request(CUSTOM_POSITION_LOCK, { mode: 'exclusive', ...(signal ? { signal } : {}) }, async () => {
      if (signal?.aborted || !isCurrent()) fail('OPERATION_CANCELLED');
      const id = operation === 'savePosition' ? undefined : input[0];
      const { snapshot } = latest(expectedRevision, id);
      if (!snapshot.writable) fail('STORAGE_CORRUPT');
      // No await between fresh read, target validation, revision check and commit.
      const result = store[operation](...input, { expectedRevision });
      // localStorage implementations can batch cross-document propagation until
      // the task ends. Keep the exclusive lock through a task boundary AFTER
      // commit, so the next tab cannot acquire it before that batch is sent.
      // This is deliberately not an await inside the read/check/write interval.
      await new Promise(resolve => setTimeout(resolve, 0));
      return result;
    }); } catch (error) {
      if (['SecurityError', 'NotSupportedError', 'NotAllowedError'].includes(error?.name)) {
        locksRejected = true; fail('LOCKS_UNAVAILABLE');
      }
      throw error;
    }
  }
  return Object.freeze({ key: CUSTOM_POSITION_STORAGE_KEY, loadAll, getPosition, mutate });
}

export function customPositionErrorMessage(error) {
  const messages = {
    STORE_READ_FAILED: '無法讀取瀏覽器儲存空間；原有資料未變更。',
    STORE_WRITE_FAILED: '儲存失敗，可能是空間不足或瀏覽器拒絕寫入；原有資料未變更。',
    LOCKS_UNAVAILABLE: '此瀏覽器無法使用安全儲存鎖，目前僅供讀取及本次挑戰。',
    REVISION_CONFLICT: '其他分頁已變更資料。請重新載入後再提交；你的輸入已保留。',
    POSITION_NOT_FOUND: '此局面已被刪除或不再有效，請返回清單。',
    INVALID_TITLE: '名稱須為 1–60 個 Unicode 字元，不可包含換行或控制字元。',
    POSITION_LIMIT: '最多可儲存 100 個局面，請先刪除不需要的局面。',
    STORAGE_SIZE_LIMIT: '局面資料已達 1 MiB 上限，無法儲存。',
    INVALID_POSITION: '局面無法用於對弈，請返回編輯器調整後重新確認。',
    UNSUPPORTED_VERSION: '局面資料版本不受支援，已禁止修改以保護原資料。',
    OPERATION_CANCELLED: '操作已取消，沒有啟動新棋局。',
  };
  if (error?.name === 'AbortError') return messages.OPERATION_CANCELLED;
  return messages[error?.code] || '局面資料損壞或無效，已禁止修改；不會覆寫原資料。';
}
