import { createAsyncSavedPositionSession } from './saved-position-async-session.js?v=fb9fc70633';

export function createSavedPositionUI({ document, window, repository, host }) {
  const el = id => document.getElementById(id);
  const dialog = el('savedPositionsDialog');
  let invoker = null, viewKey = '';
  const side = value => value === 'red' ? '紅方' : '黑方';
  const difficulty = value => ({ easy: '簡單', medium: '中等', hard: '困難' })[value];
  // Paint busy/disabled controls before synchronous validation. This yield is
  // outside every IDB transaction and never signals a storage outcome.
  const yieldUI = () => new Promise(resolve => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
  const session = createAsyncSavedPositionSession({ repository, host, onChange: render, yieldUI });
  let suspended = false, lifecycle = 0, resumeContext = null, composing = false;
  function render(state) {
    if (!state.active) {
      if (dialog.open) dialog.close();
      viewKey = ''; host.refresh?.();
      const focusTarget = invoker && !invoker.disabled && invoker.getClientRects().length ? invoker : el('btnMore');
      focusTarget?.focus({ preventScroll: true }); return;
    }
    const { form, snapshot } = state;
    dialog.setAttribute('aria-busy', String(state.busy));
    dialog.dataset.storageState = state.storageState;
    const list = state.view === 'list';
    el('savedPositionsListView').hidden = !list;
    el('savedPositionForm').hidden = list;
    el('savedPositionsNotice').textContent = state.notice;
    el('savedPositionsStorageStatus').textContent = state.storageMessage;
    el('savedPositionsReload').disabled = state.busy;
    el('savedPositionMigration').hidden = !state.canMigrate;
    el('savedPositionMigrationCount').textContent = `預計轉移 ${state.migrationCount} 個局面；舊資料原文不會刪除。`;
    el('savedPositionMigrate').textContent = state.storageState === 'STAGED' ? '確認繼續啟用' : '確認轉移';
    el('savedPositionMigrate').disabled = state.busy || !el('savedPositionMigrationConfirm').checked;
    el('savedPositionMigrationConfirm').disabled = state.busy;
    el('savedPositionVerify').hidden = !state.canVerify;
    el('savedPositionVerify').disabled = state.busy;
    if (list) {
      const container = el('savedPositionsList'); container.replaceChildren();
      const positions = [...(snapshot?.envelope.positions ?? [])].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      el('savedPositionsEmpty').hidden = positions.length > 0 || !state.writable || state.busy;
      for (const position of positions) {
        const item = document.createElement('li'); item.dataset.positionId = position.id;
        const title = document.createElement('h3'); title.textContent = position.title;
        const meta = document.createElement('p');
        meta.textContent = `輪走：${side(position.sideToMove)} · 玩家：${side(position.playPreferences.humanSide)} · AI：${difficulty(position.playPreferences.difficulty)}`;
        const actions = document.createElement('div'); actions.className = 'saved-position-actions';
        for (const [kind, label] of [['challenge', '挑戰'], ['load', '載入編輯器'], ['rename', '重新命名'], ['preferences', '偏好設定'], ['delete', '刪除']]) {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = label; button.dataset.action = kind;
          button.disabled = !state.writable || state.busy;
          button.addEventListener('click', () => session.select(kind, position.id));
          actions.append(button);
        }
        item.append(title, meta, actions); container.append(item);
      }
    } else {
      const key = `${form.kind}:${form.id || ''}`;
      const titleNeeded = ['save', 'rename'].includes(form.kind);
      const settingsNeeded = ['save', 'challenge', 'preferences'].includes(form.kind);
      el('savedPositionFormTitle').textContent = ({ save: '儲存局面', rename: '重新命名', preferences: '偏好設定', delete: '確認刪除局面', challenge: '挑戰設定', load: '載入編輯器' })[form.kind];
      el('savedPositionSummary').textContent = form.kind === 'save'
        ? form.experimentalSnapshot
          ? '只儲存棋盤局面，保留玩家棋色，下次預設為困難級。若要挑戰級，請重新選擇「挑戰級（試玩）」及「僅本次挑戰」。'
          : '只儲存棋盤快照與輪走方，不保存完整對局進度、著法、悔棋或殺局答案。下次挑戰會建立獨立新局。'
        : `「${form.position.title}」 · ${side(form.position.sideToMove)}先行`;
      el('savedPositionTitleLabel').hidden = !titleNeeded;
      el('savedPositionTitle').required = titleNeeded;
      el('savedPositionTitle').disabled = !titleNeeded || form.busy;
      el('savedPositionSettings').hidden = !settingsNeeded;
      for (const id of ['savedPositionHumanSide', 'savedPositionDifficulty']) el(id).disabled = !settingsNeeded || form.busy || form.experimentalSnapshot === true;
      el('savedPositionAcknowledgement').hidden = !(form.requiresAcknowledgement || form.replacesEditor);
      el('savedPositionAcknowledgementText').textContent = form.requiresAcknowledgement
        ? '我確認放棄目前尚未完成的對局進度。' : '我確認取代目前的編輯草稿。';
      el('savedPositionAcknowledge').disabled = form.busy;
      el('savedPositionError').textContent = form.error;
      el('savedPositionSubmit').textContent = state.busy ? '處理中…' : ({ save: '儲存局面', rename: '儲存名稱', preferences: '儲存偏好', delete: '確認刪除', challenge: '開始挑戰', load: '載入獨立草稿' })[form.kind];
      el('savedPositionSubmit').disabled = state.busy || form.stale || form.invalid || !state.writable;
      const experimental = form.difficulty === 'experimental-b';
      const experimentalAvailable = host.experimentalOpponentAvailable?.() === true;
      if (experimental) {
        el('savedPositionSubmit').disabled = true;
        el('savedPositionError').textContent = form.error || (experimentalAvailable
          ? '挑戰級（試玩） 不保存偏好，只能「僅本次挑戰」。' : '挑戰級（試玩） 尚未準備完成，請重新整理後再試。');
      }
      const experimentalOption = el('savedPositionDifficulty').querySelector('[value="experimental-b"]');
      const experimentalDisabled = !experimentalAvailable || form.kind !== 'challenge';
      if (experimentalOption) experimentalOption.disabled = experimentalDisabled;
      // A pre-fix UI can toggle option.disabled; it cannot unlock this HTML
      // optgroup. Only a host that explicitly supports B can unlock both.
      const experimentalGroup = el('savedPositionExperimentalGroup');
      if (experimentalGroup) experimentalGroup.disabled = experimentalDisabled;
      el('savedPositionOnce').hidden = form.kind !== 'challenge';
      el('savedPositionOnce').disabled = state.busy || form.stale || form.invalid || !state.writable
        || (experimental && !experimentalAvailable);
      el('savedPositionDeleteWarning').hidden = form.kind !== 'delete';
      if (viewKey !== key) {
        el('savedPositionTitle').value = form.title;
        el('savedPositionHumanSide').value = form.humanSide;
        el('savedPositionDifficulty').value = form.difficulty;
        el('savedPositionAcknowledge').checked = false;
      }
    }
    const nextKey = list ? 'list' : `${form.kind}:${form.id || ''}`;
    if (!dialog.open) dialog.showModal();
    if (viewKey !== nextKey) {
      (list ? el('savedPositionsHeading') : ['save', 'rename'].includes(form.kind)
        ? el('savedPositionTitle') : el('savedPositionBack')).focus();
      viewKey = nextKey;
    }
    host.refresh?.();
  }
  function readInputs() {
    session.edit({ title: el('savedPositionTitle').value,
      humanSide: el('savedPositionHumanSide').value, difficulty: el('savedPositionDifficulty').value,
      acknowledged: el('savedPositionAcknowledge').checked });
    render(session.state());
  }
  el('savedPositionForm').addEventListener('input', readInputs);
  el('savedPositionForm').addEventListener('change', readInputs);
  el('savedPositionForm').addEventListener('compositionstart', () => { composing = true; });
  el('savedPositionForm').addEventListener('compositionend', () => { composing = false; readInputs(); });
  el('savedPositionForm').addEventListener('submit', event => { event.preventDefault(); if (composing) return; readInputs(); void session.submit(); });
  el('savedPositionOnce').addEventListener('click', () => { readInputs(); void session.submit({ once: true }); });
  el('savedPositionBack').addEventListener('click', () => session.back());
  el('savedPositionsReload').addEventListener('click', () => session.reload());
  el('savedPositionsClose').addEventListener('click', () => session.close());
  el('savedPositionMigrationConfirm').addEventListener('change', () => render(session.state()));
  el('savedPositionMigrate').addEventListener('click', () => { void session.confirmMigration(el('savedPositionMigrationConfirm').checked); });
  el('savedPositionVerify').addEventListener('click', () => { void session.verifyPending(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); session.close(); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...dialog.querySelectorAll('button, input, select, [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    const next = event.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
    event.preventDefault(); controls[next].focus();
  });
  dialog.addEventListener('close', () => { if (!dialog.open) session.close(); });
  window.addEventListener('storage', event => { if (event.key === null || event.key === 'chinese-chess-training:custom-positions:v1') session.externalChanged(); });
  window.addEventListener('focus', () => session.externalChanged());
  const stop = event => {
    if (session.state().active) resumeContext = { ...host.context() };
    suspended = true; lifecycle++; session.close(false); repository.suspend(event.type);
  };
  const resume = async () => {
    if (!suspended) { session.externalChanged(); return; }
    suspended = false; const captured = ++lifecycle, origin = resumeContext; await repository.resume();
    // Only restore the same in-memory game; repository recovery never starts one.
    if (!suspended && lifecycle === captured && origin
      && ['session', 'mode', 'modeRevision', 'appState', 'editor', 'confirmed'].every(key => host.context()[key] === origin[key])) {
      resumeContext = null; host.refresh?.(); host.resume?.(origin);
    }
  };
  document.addEventListener('freeze', stop, true); window.addEventListener('pagehide', stop, true);
  document.addEventListener('resume', () => { void resume(); }, true); window.addEventListener('pageshow', () => { void resume(); }, true);
  return Object.freeze({
    open(button) { invoker = button; el('savedPositionMigrationConfirm').checked = false; return session.open(); },
    openSave(position, button, preferences, options) { invoker = button; el('savedPositionMigrationConfirm').checked = false; return session.openSave(position, preferences, options); },
  });
}
