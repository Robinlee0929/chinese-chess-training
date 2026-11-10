import { createCustomGameRoot, createMutableCustomGamePosition, validateCustomPlayPosition } from './custom-position-play.js?v=b1355bbc48';
import { customPositionErrorMessage } from './custom-position-coordinator.js?v=b1355bbc48';

// One dialog owns one operation generation and one originating game/editor.
// Host callbacks keep the existing game/renderer lifecycle in main.js.
export function createSavedPositionSession({ coordinator, host, onChange = () => {} }) {
  let active = false, origin = null, epoch = 0, controller = null;
  let view = 'list', form = null, snapshot = null, notice = '';
  const contextMatches = () => {
    const now = host.context();
    return origin && ['session', 'appState', 'editor', 'confirmed'].every(key => now[key] === origin[key]);
  };
  const state = () => ({ active, view, form, snapshot, notice });
  const emit = () => onChange(state());
  function invalidate() { epoch++; controller?.abort(); controller = null; }
  function refresh() { snapshot = coordinator.loadAll(); }
  function open() {
    if (active || !host.canOpen()) return false;
    origin = { ...host.context() }; active = true; view = 'list'; form = null; notice = '';
    invalidate(); host.pause(); refresh(); emit(); return true;
  }
  function close(resume = true) {
    if (!active) return;
    const same = contextMatches(); invalidate(); active = false; form = null; emit();
    if (resume && same) host.resume(origin);
  }
  function openSave(position) {
    if (!open()) return false;
    const valid = validateCustomPlayPosition(position);
    form = { kind: 'save', revision: snapshot.revision, title: '',
      humanSide: position?.sideToMove || 'red', difficulty: 'medium',
      position: valid.ok ? { initialBoard: valid.position.board, sideToMove: valid.position.sideToMove } : null,
      error: valid.ok ? '' : valid.error.message, invalid: !valid.ok, busy: false, stale: false };
    view = 'form'; emit(); return true;
  }
  function select(kind, id) {
    if (!active || !['challenge', 'load', 'rename', 'delete'].includes(kind)) return false;
    invalidate(); refresh();
    const position = snapshot.positions.find(p => p.id === id);
    if (!position) { notice = '此局面已被刪除或不再有效。'; view = 'list'; form = null; emit(); return false; }
    form = { kind, id, revision: snapshot.revision, position, title: position.title,
      ...position.playPreferences, acknowledged: false, busy: false, stale: false, error: '',
      requiresAcknowledgement: kind === 'challenge' && origin.hasProgress,
      replacesEditor: kind === 'load' && !!origin.editor };
    view = 'form'; notice = ''; emit(); return true;
  }
  function edit(values) {
    if (!form || form.busy) return;
    for (const key of ['title', 'humanSide', 'difficulty', 'acknowledged']) {
      if (Object.hasOwn(values, key)) form[key] = values[key];
    }
    // Do not rerender while typing: preserve caret, IME and keyboard focus.
  }
  function back() {
    if (!active) return;
    invalidate(); view = 'list'; form = null; notice = ''; refresh(); emit();
  }
  function reload() {
    if (!active) return;
    invalidate(); refresh(); notice = '';
    if (form) {
      form.busy = false;
      const found = form.kind === 'save' ? form.position : snapshot.positions.find(p => p.id === form.id);
      form.stale = !found || snapshot.revision === null;
      form.error = form.stale ? '此局面已被刪除或資料無法讀取；輸入已保留。' : '已重新載入最新版本；請確認輸入後再提交。';
      if (!form.stale) { form.revision = snapshot.revision; form.position = found; }
    }
    emit();
  }
  function storageChanged(event) {
    if (!active || (event.key !== coordinator.key && event.key !== null)) return;
    invalidate(); refresh(); notice = '其他分頁已更新局面清單。';
    if (form) {
      form.stale = true; form.busy = false;
      form.error = '資料已在其他分頁變更。請重新載入；你的輸入已保留。';
    }
    emit();
  }
  async function submit({ once = false } = {}) {
    if (!active || !form || form.busy || form.stale || form.invalid || !contextMatches()) return false;
    const currentForm = form;
    if ((form.requiresAcknowledgement || form.replacesEditor) && !form.acknowledged) {
      form.error = form.requiresAcknowledgement ? '請先確認放棄目前尚未完成的對局。' : '請先確認取代目前的編輯草稿。'; emit(); return false;
    }
    const generation = ++epoch;
    controller = new AbortController();
    const current = () => active && epoch === generation && form === currentForm && contextMatches();
    const options = { expectedRevision: form.revision, signal: controller.signal, isCurrent: current };
    form.busy = true; form.error = ''; emit();
    try {
      const settings = { humanSide: currentForm.humanSide, difficulty: currentForm.difficulty };
      let result;
      if (currentForm.kind === 'save') {
        result = await coordinator.mutate('savePosition', [{ ...currentForm.position, title: currentForm.title, playPreferences: settings }], options);
      } else if (currentForm.kind === 'rename') {
        result = await coordinator.mutate('renamePosition', [currentForm.id, currentForm.title], options);
      } else if (currentForm.kind === 'delete') {
        result = await coordinator.mutate('deletePosition', [currentForm.id], options);
      } else {
        let position = coordinator.getPosition(currentForm.id, currentForm.revision);
        let revision = currentForm.revision;
        if (currentForm.kind === 'challenge' && !once
          && (position.playPreferences.humanSide !== settings.humanSide || position.playPreferences.difficulty !== settings.difficulty)) {
          result = await coordinator.mutate('updatePlayPreferences', [currentForm.id, settings], options);
          revision = result.revision;
        }
        if (!current()) return false;
        // Re-read at the actual transition boundary, including after a lock wait.
        position = coordinator.getPosition(currentForm.id, revision);
        const root = createCustomGameRoot(position, settings, { savedPositionId: position.id });
        const mutable = createMutableCustomGamePosition(root);
        close(false);
        if (currentForm.kind === 'challenge') host.start(root, mutable);
        else host.loadEditor(mutable);
        return true;
      }
      if (!current()) return false;
      view = 'list'; form = null; refresh();
      notice = currentForm.kind === 'save'
        ? result.created ? `已儲存「${result.position.title}」。` : `此棋面已存在：「${result.position.title}」，名稱與偏好未變更。`
        : currentForm.kind === 'delete' ? '已刪除局面。' : '已更新局面名稱。';
      emit(); return true;
    } catch (error) {
      if (!current()) return false;
      currentForm.busy = false; currentForm.error = customPositionErrorMessage(error);
      currentForm.stale = ['REVISION_CONFLICT', 'POSITION_NOT_FOUND'].includes(error.code);
      refresh(); emit(); return false;
    }
  }
  return Object.freeze({ state, open, openSave, close, select, edit, back, reload, storageChanged, submit });
}
