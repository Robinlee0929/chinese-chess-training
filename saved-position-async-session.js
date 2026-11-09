import { createCustomGameRoot, createMutableCustomGamePosition, validateCustomPlayPosition } from './custom-position-play.js?v=66a2321529';
import { validateContinuationConfiguration } from './game-review-continuation.js?v=66a2321529';

export function savedPositionMessage(result = {}) {
  const code = result.code ?? result.status;
  return ({
    REVISION_CONFLICT: '資料已在其他分頁變更。輸入已保留；請重新載入，確認後再提交。',
    POSITION_NOT_FOUND: '此局面已被刪除。輸入已保留。',
    STORAGE_INSTANCE_CHANGED: '儲存資料庫已更換或消失。請關閉視窗後重新開啟；舊操作不會重送。',
    UNKNOWN: '尚未確認完成。請查證結果；不會自動重新提交。',
    LEGACY_SOURCE_DIFFERS_OR_UNREADABLE: 'IndexedDB 與舊版資料不同，或舊資料無法讀取。現在僅供查閱；沒有合併、覆寫或回滾任何資料。請先保留兩份資料並停止舊版分頁。',
    SOURCE_CHANGED: '舊資料已變更，轉移未啟用。請重新檢查後確認。',
    MIGRATION_TARGET_CONFLICT: '目標資料已變更。未覆寫或合併，請重新檢查。',
    QuotaExceededError: '儲存空間不足，操作未能確認完成。請保留資料並查證結果。',
    INVALID_TITLE: '名稱必須為 1–60 個字元，不可包含換行或控制字元。',
    POSITION_LIMIT: '已達局面數量上限。',
    STORAGE_SIZE_LIMIT: '資料已達 1 MiB 上限。',
  })[code] ?? `無法完成操作（${code || 'UNAVAILABLE'}）。資料不會被自動清空或改用舊版儲存。`;
}

// Session owns UI intent only. Repository is the sole storage boundary. Every
// awaited result is fenced by dialog, generation, form and originating game.
export function createAsyncSavedPositionSession({ repository, host, onChange = () => {}, yieldUI = () => Promise.resolve() }) {
  let active = false, origin = null, dialog = null, scope = null, generation = 0;
  let view = 'list', form = null, snapshot = null, storageState = 'UNAVAILABLE', storageMessage = '';
  let plan = null, busy = false, notice = '', inflight = null, ready = Promise.resolve(false);
  const unresolved = new Map(); // Includes cancelled committed/unknown intents; never resubmitted.
  const contextMatches = () => origin && ['session', 'appState', 'editor', 'confirmed']
    .every(key => host.context()[key] === origin[key]);
  const state = () => ({ active, view, form, snapshot, storageState, storageMessage, busy, notice,
    migrationCount: plan?.count ?? 0, canMigrate: !!plan && ['MIGRATION_REQUIRED', 'STAGED'].includes(storageState),
    canVerify: unresolved.size > 0, writable: storageState === 'ACTIVE' && !!snapshot });
  const emit = () => onChange(state());
  const fence = value => ({ snapshot: value, storageInstanceId: value.metadata.storageInstanceId, expectedRevision: value.envelope.revision });
  function cancelWork() { generation++; inflight?.cancel('ui-intent-cancelled'); inflight = null; busy = false; if (form) form.busy = false; }
  function ticket() {
    const captured = { dialog, scope, generation: ++generation, form };
    return () => active && dialog === captured.dialog && scope === captured.scope
      && generation === captured.generation && form === captured.form && contextMatches();
  }
  function begin() { const current = ticket(); busy = true; if (form) { form.busy = true; if (!form.invalid) form.error = ''; } notice = '處理中…'; emit(); return current; }
  function finish(current) { if (current()) { busy = false; if (form) form.busy = false; emit(); } }
  async function receive(handle, current, write = false) {
    inflight = handle;
    if (write) unresolved.set(handle, { handle, result: null });
    const result = await handle.completion;
    if (write) {
      const entry = unresolved.get(handle); if (entry) entry.result = result;
      // A late result may update this private recovery ledger, never the UI/game.
      if (result.persistence?.nativeEvent === 'ABORT') unresolved.delete(handle);
    }
    if (!current()) return null;
    if (inflight === handle) inflight = null;
    if (result.status === 'SUCCESS' && !scope.canApply(handle, result)) return null;
    if (result.uiIntent !== 'CURRENT') return null;
    return result;
  }
  function describe(result) {
    const raw = result.migration, code = result.code ?? raw?.code;
    snapshot = result.snapshot ?? null; plan = result.plan ?? null;
    if (result.status === 'SUCCESS' || result.status === 'ACTIVE') { storageState = 'ACTIVE'; storageMessage = ''; }
    else if (raw?.state === 'UNINITIALIZED') { storageState = 'UNINITIALIZED'; storageMessage = '正在檢查舊資料並準備儲存空間。'; }
    else if (result.status === 'STAGED') { storageState = 'STAGED'; storageMessage = '資料已複製，但尚未完成啟用。請先停止其他舊版分頁，重新確認後繼續。'; }
    else if (result.status === 'MIGRATION_REQUIRED') { storageState = 'MIGRATION_REQUIRED'; storageMessage = '偵測到舊版儲存的棋局。請先關閉其他正在使用舊版網站的分頁或視窗，再確認轉移。轉移前會重新檢查資料是否變更；不會直接刪除舊資料。'; }
    else if (/SOURCE_CHANGED|MIGRATION_TARGET_CONFLICT|LEGACY_SOURCE_DIFFERS|UNMANAGED_IDB/.test(code || '')) { storageState = 'CONFLICT'; storageMessage = savedPositionMessage(result); }
    else if (/UNSUPPORTED|VersionError/.test(code || '')) { storageState = 'UNSUPPORTED'; storageMessage = savedPositionMessage(result); }
    else if (raw?.state === 'BLOCKED' && !raw?.outcome) { storageState = 'CORRUPT'; storageMessage = savedPositionMessage(result); }
    else { storageState = result.status === 'UNKNOWN' || result.persistence?.status === 'UNKNOWN' ? 'UNKNOWN' : 'UNAVAILABLE'; storageMessage = savedPositionMessage(result); }
  }
  function formFromSnapshot(explicit) {
    if (!form) return;
    const found = form.kind === 'save' ? form.position : snapshot?.envelope.positions.find(p => p.id === form.id);
    const changed = form.fence && (form.fence.expectedRevision !== snapshot?.envelope.revision
      || form.fence.storageInstanceId !== snapshot?.metadata.storageInstanceId);
    if (!found || storageState !== 'ACTIVE') { form.stale = true; form.error = storageMessage || '此局面已被刪除；輸入已保留。'; }
    else if (explicit || !form.fence) {
      form.fence = fence(snapshot); form.position = found; form.stale = false;
      if (explicit) form.error = '已重新載入；輸入已保留，請確認後再提交。';
    } else if (changed) { form.stale = true; form.error = savedPositionMessage({ code: 'REVISION_CONFLICT' }); }
  }
  async function refresh({ initialize = false, explicit = false } = {}) {
    if (!active || busy || !contextMatches()) return false;
    const current = begin();
    try {
      await yieldUI(); if (!current()) return false;
      let result = await receive(scope.inspectMigration(), current); if (!result) return false;
      describe(result);
      if (initialize && result.migration?.state === 'UNINITIALIZED') {
        emit(); const initialization = scope.initialize(); result = await receive(initialization, current, true); if (!result) return false;
        if (result.status === 'ACTIVE') unresolved.delete(initialization);
        describe(result);
      }
      if (storageState === 'ACTIVE') {
        result = await receive(scope.loadAll(), current); if (!result) return false;
        describe(result);
      }
      formFromSnapshot(explicit); notice = unresolved.size ? '先前的操作可能已完成；可查證結果。' : '';
      return storageState === 'ACTIVE';
    } catch (error) { if (current()) { storageState = 'UNAVAILABLE'; storageMessage = savedPositionMessage(error); notice = '操作失敗。'; } return false; }
    finally { finish(current); }
  }
  function open() {
    if (active || !host.canOpen()) return false;
    origin = { ...host.context() }; dialog = {}; active = true; view = 'list'; form = null;
    snapshot = null; plan = null; notice = ''; storageState = 'UNAVAILABLE'; storageMessage = ''; generation++;
    const ownDialog = dialog;
    scope = repository.createScope({ uiGeneration: generation, dialogIdentity: dialog, gameSessionIdentity: origin.session,
      isCurrent: () => active && dialog === ownDialog && contextMatches() });
    host.pause(); ready = refresh({ initialize: true }); return true;
  }
  function openSave(position, preferences = { humanSide: position?.sideToMove || 'red', difficulty: 'medium' }) {
    // Build the detached draft before open() captures its refresh ticket.
    const valid = validateCustomPlayPosition(position);
    const settings = validateContinuationConfiguration(preferences);
    if (!open()) return false;
    cancelWork();
    form = { kind: 'save', title: '', ...settings,
      position: valid.ok ? { initialBoard: valid.position.board, sideToMove: valid.position.sideToMove } : null,
      error: valid.ok ? '' : valid.error.message, invalid: !valid.ok, stale: false, busy: false, fence: null };
    view = 'form'; ready = refresh({ initialize: true }); return true;
  }
  function close(resume = true) {
    if (!active) return;
    const same = contextMatches(); cancelWork(); active = false; scope.close('dialog-closed'); form = null; plan = null; emit();
    if (resume && same) host.resume(origin);
  }
  function select(kind, id) {
    if (!active || busy || storageState !== 'ACTIVE' || !['challenge', 'load', 'rename', 'preferences', 'delete'].includes(kind)) return false;
    const position = snapshot.envelope.positions.find(p => p.id === id); if (!position) return false;
    cancelWork(); form = { kind, id, position, title: position.title, ...position.playPreferences, fence: fence(snapshot),
      busy: false, stale: false, error: '', acknowledged: false,
      requiresAcknowledgement: kind === 'challenge' && origin.hasProgress, replacesEditor: kind === 'load' && !!origin.editor };
    view = 'form'; notice = ''; emit(); return true;
  }
  function edit(values) {
    if (!form || busy) return;
    for (const key of ['title', 'humanSide', 'difficulty', 'acknowledged']) if (Object.hasOwn(values, key)) form[key] = values[key];
  }
  function back() { if (!active) return; cancelWork(); view = 'list'; form = null; ready = refresh(); }
  function reload() { if (!active || busy) return false; ready = refresh({ explicit: true, initialize: storageState === 'UNINITIALIZED' }); return ready; }
  function externalChanged() { if (active && !busy) ready = refresh(); }
  function failed(result, handle) {
    const committed = result.persistence?.status === 'COMMITTED';
    const unknown = result.status === 'UNKNOWN' || result.persistence?.status === 'UNKNOWN';
    const message = committed ? '資料已提交，但後續狀態已改變。尚未開始挑戰，請重新檢查。'
      : unknown ? savedPositionMessage({ code: result.code === 'STORAGE_INSTANCE_CHANGED' ? result.code : 'UNKNOWN' }) : savedPositionMessage(result);
    if (form) {
      form.error = message;
      form.stale = committed || unknown || ['REVISION_CONFLICT', 'POSITION_NOT_FOUND'].includes(result.code);
    }
    notice = message;
    if (!committed && !unknown) unresolved.delete(handle);
    if (result.migration) describe(result);
    return false;
  }
  async function submit({ once = false } = {}) {
    if (!active || busy || !form || form.stale || form.invalid || storageState !== 'ACTIVE' || !contextMatches()) return false;
    const f = form, settings = { humanSide: f.humanSide, difficulty: f.difficulty };
    if (settings.difficulty === 'experimental-b' && !(f.kind === 'challenge' && once)) {
      f.error = '實驗對手 B 不保存偏好，請選「僅本次挑戰」。'; emit(); return false;
    }
    if ((f.requiresAcknowledgement || f.replacesEditor) && !f.acknowledged) { f.error = '請先確認放棄目前進度或取代編輯草稿。'; emit(); return false; }
    const current = begin();
    try {
      await yieldUI(); if (!current()) return false;
      let result, handle, expected = f.fence;
      if (['challenge', 'load'].includes(f.kind)) {
        handle = scope.getPosition(f.id, expected); result = await receive(handle, current); if (!result) return false;
        if (result.status !== 'SUCCESS') return failed(result, handle);
        if (f.kind === 'challenge' && !once && (result.position.playPreferences.humanSide !== settings.humanSide || result.position.playPreferences.difficulty !== settings.difficulty)) {
          handle = scope.updatePlayPreferences(f.id, settings, expected); result = await receive(handle, current, true); if (!result) return false;
          if (result.status !== 'SUCCESS') return failed(result, handle);
          unresolved.delete(handle); expected = fence(result.snapshot);
        }
        // Last authoritative read; original revision or the exact committed receipt.
        handle = scope.getPosition(f.id, expected); result = await receive(handle, current); if (!result) return false;
        if (result.status !== 'SUCCESS') return failed(result, handle);
        if (!current() || !scope.canApply(handle, result)) return false;
        const root = createCustomGameRoot(result.position, settings, { savedPositionId: result.position.id });
        const mutable = createMutableCustomGamePosition(root);
        close(false); if (f.kind === 'challenge') host.start(root, mutable); else host.loadEditor(mutable);
        return true;
      }
      handle = f.kind === 'save' ? scope.savePosition({ ...f.position, title: f.title, playPreferences: settings }, expected)
        : f.kind === 'rename' ? scope.renamePosition(f.id, f.title, expected)
          : f.kind === 'preferences' ? scope.updatePlayPreferences(f.id, settings, expected) : scope.deletePosition(f.id, expected);
      result = await receive(handle, current, true); if (!result) return false;
      if (result.status !== 'SUCCESS') return failed(result, handle);
      unresolved.delete(handle); snapshot = result.latestSnapshot ?? result.snapshot;
      notice = f.kind === 'save' ? result.created ? `已儲存「${result.position.title}」。` : `此棋面已存在：「${result.position.title}」，名稱與偏好未變更。`
        : f.kind === 'delete' ? '已刪除局面。' : '已完成更新。';
      busy = false; form = null; view = 'list'; emit(); return true;
    } catch (error) { if (current()) { f.error = savedPositionMessage(error); notice = f.error; } return false; }
    finally { finish(current); }
  }
  async function confirmMigration(confirmed) {
    if (!active || busy || !plan || confirmed !== true || !contextMatches()) return false;
    const current = begin(), selected = plan;
    try {
      await yieldUI(); if (!current()) return false;
      const handle = scope.confirmMigration(selected, { confirmed: true, legacyWritersStopped: true });
      const result = await receive(handle, current, true); if (!result) return false;
      describe(result);
      if (result.status === 'ACTIVE') {
        unresolved.delete(handle);
        const loaded = await receive(scope.loadAll(), current); if (!loaded) return false;
        describe(loaded); formFromSnapshot(true); notice = loaded.status === 'SUCCESS' ? '已完成轉移；舊資料原文仍保留。' : savedPositionMessage(loaded);
        return loaded.status === 'SUCCESS';
      }
      return failed(result, handle);
    } catch (error) { if (current()) notice = savedPositionMessage(error); return false; }
    finally { finish(current); }
  }
  async function verifyPending() {
    if (!active || busy || !unresolved.size) return false;
    const current = begin(), messages = [];
    try {
      await yieldUI(); if (!current()) return false;
      for (const [handle] of [...unresolved]) {
        const result = await handle.verify(); if (!current()) return false;
        messages.push(result.status === 'COMMITTED' ? '已查證先前操作已提交。'
          : result.status === 'NOT_COMMITTED_OBSERVED' || result.status === 'ABORTED_OBSERVED' ? '已查證先前操作未提交。'
            : '尚未確認完成；保留 UNKNOWN，不會重送。');
        if (['COMMITTED', 'NOT_COMMITTED_OBSERVED', 'ABORTED_OBSERVED'].includes(result.status)) unresolved.delete(handle);
      }
      notice = messages.join('\n') + '\n請重新載入最新資料後再操作。'; if (form) form.stale = true;
      return true;
    } catch (error) { if (current()) notice = savedPositionMessage(error); return false; }
    finally { finish(current); }
  }
  return Object.freeze({ state, open, openSave, close, select, edit, back, reload, externalChanged, submit,
    confirmMigration, verifyPending, whenReady: () => ready });
}
