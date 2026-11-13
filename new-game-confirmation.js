import { initialBoard, hashBoard, RED } from './game.js?v=fb9fc70633';

const standardBoard = JSON.stringify(initialBoard());
const standardHash = hashBoard(initialBoard());
const modes = new Set(['easy', 'medium', 'hard', 'experimental-b', 'pvp']);

// Only a demonstrably untouched standard opening may bypass confirmation.
// Unknown/inconsistent ownership is protected, never treated as an empty game.
export function needsNewGameConfirmation(source) {
  try {
    const s = source.session;
    return !s || typeof s.id !== 'string' || !s.id || source.recordError != null
      || s.mode !== source.mode || !modes.has(source.mode)
      || !Number.isSafeInteger(source.modeRevision) || source.modeRevision < 1
      || s.modeRevision !== source.modeRevision
      || (source.mode !== 'pvp' && s.humanSide !== source.humanSide)
      || source.customContext != null || s.sourceRecordId != null
      || source.busy || source.aiThinking || source.over || source.winner != null
      || source.completedSessionId != null || source.completedRecord?.id === s.id
      || !Array.isArray(source.history) || source.history.length !== 0
      || s.initialPosition.sideToMove !== RED || source.turn !== RED
      || JSON.stringify(s.initialPosition.board) !== standardBoard
      || JSON.stringify(source.board) !== standardBoard
      || JSON.stringify(source.positionHashes) !== JSON.stringify([standardHash])
      || JSON.stringify(source.repetitionHistory) !== JSON.stringify([
        { key: standardHash + '|' + RED, mover: null, check: false },
      ]);
  } catch { return true; }
}

function capture(source) {
  // revision catches change-and-undo (ABA); content also detects in-place changes.
  // Session identity is retained separately: equal serialized sessions are not owners.
  return { session: source.session, board: source.board, history: source.history,
    customContext: source.customContext,
    fingerprint: JSON.stringify(source) };
}

export function createNewGameConfirmation({ document, readSource, commit, syncSelection, notify }) {
  const dialog = document.getElementById('newGameConfirmDialog');
  const form = document.getElementById('newGameConfirmForm');
  const cancelButton = document.getElementById('btnNewGameCancel');
  const confirmButton = document.getElementById('btnNewGameConfirm');
  // Mixed old HTML/new JS must not silently discard progress without the UI.
  if (!dialog || !form || !cancelButton || !confirmButton) return null;
  let pending = null;

  function current(operation) {
    if (!operation || pending !== operation) return false;
    try {
      const source = readSource(), snapshot = capture(source);
      return source.active && snapshot.session === operation.source.session
        && snapshot.board === operation.source.board && snapshot.history === operation.source.history
        && snapshot.customContext === operation.source.customContext
        && snapshot.fingerprint === operation.source.fingerprint;
    } catch { return false; }
  }
  function dismiss({ focus = true } = {}) {
    const operation = pending;
    pending = null; // Consume synchronously, before the queued native close event.
    if (dialog.open) dialog.close();
    syncSelection();
    if (focus && operation?.invoker?.isConnected && !operation.invoker.disabled
      && operation.invoker.getClientRects().length) operation.invoker.focus({ preventScroll: true });
  }
  function refresh() {
    if (pending && !current(pending)) {
      dismiss();
      notify('棋局已更新，請重新確認是否開始新局。');
    }
  }
  function request(settings, invoker) {
    syncSelection();
    if (pending || document.querySelector('dialog[open]')
      || !modes.has(settings.mode) || !['red', 'black'].includes(settings.humanSide)) return false;
    const source = readSource();
    if (!source.active) return false;
    const choice = Object.freeze({ mode: settings.mode, humanSide: settings.humanSide });
    if (!needsNewGameConfirmation(source)) { commit(choice); return true; }
    try {
      pending = { settings: choice, source: capture(source), invoker };
      dialog.showModal();
      cancelButton.focus();
      return true;
    } catch {
      dismiss();
      notify('無法開啟換局確認，已保留目前棋局。');
      return false;
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const operation = pending;
    if (!dialog.open || !operation) return;
    if (!current(operation)) { refresh(); return; }
    dismiss({ focus: false });
    commit(operation.settings); // Exactly once, with no await between check and commit.
  });
  cancelButton.addEventListener('click', () => dismiss());
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => {
    // An earlier close can arrive after Escape -> immediate reopen. It owns
    // neither the new operation nor its focus while the dialog is open again.
    if (!dialog.open && pending) dismiss();
  });
  return Object.freeze({ request, refresh, invalidate: () => dismiss({ focus: false }) });
}
