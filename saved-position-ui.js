import { createSavedPositionSession } from './saved-position-session.js?v=0bcf8ccbd6';
import { customPositionErrorMessage } from './custom-position-coordinator.js?v=0bcf8ccbd6';

export function createSavedPositionUI({ document, window, coordinator, host }) {
  const el = id => document.getElementById(id);
  const dialog = el('savedPositionsDialog');
  let invoker = null, viewKey = '';
  const side = value => value === 'red' ? '紅方' : '黑方';
  const difficulty = value => ({ easy: '簡單', medium: '中等', hard: '困難' })[value];
  const session = createSavedPositionSession({ coordinator, host, onChange: render });
  function render(state) {
    if (!state.active) {
      if (dialog.open) dialog.close();
      viewKey = ''; host.refresh?.(); invoker?.focus({ preventScroll: true }); return;
    }
    const { form, snapshot } = state;
    const list = state.view === 'list';
    el('savedPositionsListView').hidden = !list;
    el('savedPositionForm').hidden = list;
    el('savedPositionsNotice').textContent = state.notice;
    el('savedPositionsStorageStatus').textContent = snapshot.issues.length
      ? customPositionErrorMessage(snapshot.issues[0])
      : !snapshot.locksAvailable ? customPositionErrorMessage({ code: 'LOCKS_UNAVAILABLE' }) : '';
    if (list) {
      const container = el('savedPositionsList'); container.replaceChildren();
      const positions = [...snapshot.positions].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      el('savedPositionsEmpty').hidden = positions.length > 0 || snapshot.issues.length > 0;
      for (const position of positions) {
        const item = document.createElement('li'); item.dataset.positionId = position.id;
        const title = document.createElement('h3'); title.textContent = position.title;
        const meta = document.createElement('p');
        meta.textContent = `輪走：${side(position.sideToMove)} · 玩家：${side(position.playPreferences.humanSide)} · AI：${difficulty(position.playPreferences.difficulty)}`;
        const actions = document.createElement('div'); actions.className = 'saved-position-actions';
        for (const [kind, label] of [['challenge', '挑戰'], ['load', '載入編輯器'], ['rename', '重新命名'], ['delete', '刪除']]) {
          const button = document.createElement('button'); button.type = 'button';
          button.textContent = label; button.dataset.action = kind;
          button.disabled = !snapshot.writable && ['rename', 'delete'].includes(kind);
          button.addEventListener('click', () => session.select(kind, position.id));
          actions.append(button);
        }
        item.append(title, meta, actions); container.append(item);
      }
    } else {
      const key = `${form.kind}:${form.id || ''}`;
      const titleNeeded = ['save', 'rename'].includes(form.kind);
      const settingsNeeded = ['save', 'challenge'].includes(form.kind);
      el('savedPositionFormTitle').textContent = ({ save: '儲存局面', rename: '重新命名', delete: '確認刪除局面', challenge: '挑戰設定', load: '載入編輯器' })[form.kind];
      el('savedPositionSummary').textContent = form.kind === 'save'
        ? '只儲存已確認的棋面與輪走方，不包含殺局答案或棋譜。'
        : `「${form.position.title}」 · ${side(form.position.sideToMove)}先行`;
      el('savedPositionTitleLabel').hidden = !titleNeeded;
      el('savedPositionTitle').required = titleNeeded;
      el('savedPositionTitle').disabled = !titleNeeded || form.busy;
      el('savedPositionSettings').hidden = !settingsNeeded;
      for (const id of ['savedPositionHumanSide', 'savedPositionDifficulty']) el(id).disabled = !settingsNeeded || form.busy;
      el('savedPositionAcknowledgement').hidden = !(form.requiresAcknowledgement || form.replacesEditor);
      el('savedPositionAcknowledgementText').textContent = form.requiresAcknowledgement
        ? '我確認放棄目前尚未完成的對局進度。' : '我確認取代目前的編輯草稿。';
      el('savedPositionAcknowledge').disabled = form.busy;
      el('savedPositionError').textContent = form.error;
      el('savedPositionSubmit').textContent = form.busy ? '等待安全儲存…' : ({ save: '儲存局面', rename: '儲存名稱', delete: '確認刪除', challenge: '開始挑戰', load: '載入獨立草稿' })[form.kind];
      const writableAction = ['save', 'rename', 'delete'].includes(form.kind);
      el('savedPositionSubmit').disabled = form.busy || form.stale || form.invalid || (writableAction && !snapshot.writable);
      el('savedPositionOnce').hidden = form.kind !== 'challenge';
      el('savedPositionOnce').disabled = form.busy || form.stale || form.invalid;
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
  }
  el('savedPositionForm').addEventListener('input', readInputs);
  el('savedPositionForm').addEventListener('change', readInputs);
  el('savedPositionForm').addEventListener('submit', event => { event.preventDefault(); readInputs(); void session.submit(); });
  el('savedPositionOnce').addEventListener('click', () => { readInputs(); void session.submit({ once: true }); });
  el('savedPositionBack').addEventListener('click', () => session.back());
  el('savedPositionsReload').addEventListener('click', () => session.reload());
  el('savedPositionsClose').addEventListener('click', () => session.close());
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
  window.addEventListener('storage', event => session.storageChanged(event));
  window.addEventListener('pagehide', () => session.close(false));
  return Object.freeze({
    open(button) { invoker = button; return session.open(); },
    openSave(position, button) { invoker = button; return session.openSave(position); },
  });
}
