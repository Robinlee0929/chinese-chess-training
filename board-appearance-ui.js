import { createBoardAppearanceController } from './board-appearance.js?v=1ebb13d661';
import { createBoardAppearanceStore } from './board-appearance-store.js?v=1ebb13d661';

export function createBoardAppearanceUI({ surface, changed, closeMenu, doc = document }) {
  const el = id => doc.getElementById(id);
  const disable = () => {
    const button = el('btnBoardAppearance');
    if (button) { button.disabled = true; button.title = '棋盤外觀元件未完整載入，請重新整理頁面。'; }
    return { dispose() {} };
  };
  // A stale or partial HTML document must not prevent the main game from starting.
  // Check the whole optional UI before binding events or opening its database.
  const required = ['btnBoardAppearance', 'boardAppearanceDialog', 'boardAppearanceHeading',
    'boardAppearanceClose', 'boardAppearancePrivacy', 'boardAppearancePreview',
    'boardAppearanceChoose', 'boardAppearanceFile', 'boardAppearanceSettings', 'boardAppearanceFit',
    'boardAppearanceRemember', 'boardAppearancePersistence', 'boardAppearanceStatus',
    'boardAppearanceReset', 'boardAppearanceRetry',
    ...['opacity', 'x', 'y'].flatMap(key => [`boardAppearance${key}`, `boardAppearance${key}Value`])];
  if (required.some(id => !el(id))) return disable();
  const dialog = el('boardAppearanceDialog'), picker = el('boardAppearanceFile');
  const preview = el('boardAppearancePreview');
  if (typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function'
    || typeof preview.getContext !== 'function') return disable();
  const previewContext = preview.getContext('2d');
  if (!previewContext) return disable();
  const settings = el('boardAppearanceSettings'), remember = el('boardAppearanceRemember');
  const status = el('boardAppearanceStatus'), retry = el('boardAppearanceRetry');
  let invoker, timer, pending = null, disposed = false;
  function render(state) {
    // An async save may finish inside the input debounce window. Keep the user's
    // pending values and unsaved status until flush passes them to the controller.
    const value = pending ?? state.settings;
    const hasPendingSave = !!pending && state.remember;
    const persistence = hasPendingSave ? 'unsaved' : state.persistence;
    const message = hasPendingSave ? '外觀已調整，等待保存。' : state.message;
    settings.disabled = !state.hasPhoto || state.loading;
    remember.disabled = !state.hasPhoto || state.loading;
    remember.checked = state.remember;
    for (const key of ['opacity', 'x', 'y']) {
      el(`boardAppearance${key}`).value = Math.round(value[key] * 100);
      el(`boardAppearance${key}Value`).value = `${Math.round(value[key] * 100)}%`;
    }
    el('boardAppearanceFit').value = value.fit;
    previewContext.clearRect(0, 0, preview.width, preview.height);
    previewContext.drawImage(surface.canvas, 0, 0, preview.width, preview.height);
    const save = persistence === 'saving' ? '正在更新此裝置的照片…'
      : persistence === 'saved' ? '已在此裝置記住照片。'
        : persistence === 'unsaved' ? '外觀尚未保存。' : '照片僅供目前分頁使用。';
    status.textContent = state.loading ? '正在檢查與處理圖片…'
      : message || (state.hasPhoto ? save : '目前使用原始木紋棋盤。');
    el('boardAppearancePersistence').textContent = state.hasPhoto || persistence === 'saving' ? save : '';
    status.classList.toggle('appearance-error', persistence === 'error');
    retry.hidden = persistence !== 'error';
    retry.textContent = state.remember ? '重試保存' : '重試清除保存照片';
    dialog.setAttribute('aria-busy', String(state.loading));
  }
  const controller = createBoardAppearanceController({
    store: createBoardAppearanceStore(),
    apply: (image, value) => { surface.setPhoto(image, value); changed(); },
    onChange: render,
  });
  function flush(commit = true) {
    clearTimeout(timer); timer = null;
    if (pending) { const value = pending; pending = null; controller.update(value, commit); }
    else if (commit && controller.state().persistence === 'unsaved') controller.update(controller.state().settings);
  }
  function readInputs(commit) {
    pending = { fit: el('boardAppearanceFit').value,
      opacity: Number(el('boardAppearanceopacity').value) / 100,
      x: Number(el('boardAppearancex').value) / 100, y: Number(el('boardAppearancey').value) / 100 };
    if (commit) flush();
    else { render(controller.state()); clearTimeout(timer); timer = setTimeout(() => flush(false), 75); }
  }
  el('btnBoardAppearance').addEventListener('click', event => {
    if (doc.querySelector('dialog[open]')) return;
    invoker = event.currentTarget; closeMenu(); render(controller.state());
    dialog.showModal(); el('boardAppearanceChoose').focus();
  });
  el('boardAppearanceChoose').addEventListener('click', () => { picker.value = ''; picker.click(); });
  picker.addEventListener('change', () => {
    flush(); const file = picker.files?.[0]; picker.value = ''; void controller.select(file);
  });
  // Capture the value before child listeners/microtasks can deliver an older
  // completion and repaint the controls during this same native input event.
  settings.addEventListener('input', () => readInputs(false), true);
  settings.addEventListener('change', () => readInputs(true));
  remember.addEventListener('change', () => { const value = remember.checked; flush(); controller.setRemember(value); });
  el('boardAppearanceReset').addEventListener('click', () => {
    clearTimeout(timer); pending = null; picker.value = ''; void controller.reset();
  });
  retry.addEventListener('click', () => { flush(); void controller.retry(); });
  el('boardAppearanceClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    flush();
    const target = invoker?.getClientRects().length ? invoker : el('btnMore');
    target?.focus({ preventScroll: true });
  });
  // Stop existing document-level shortcuts, including when the dialog closes on Esc.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  render(controller.state()); void controller.restore();
  // HTML starts disabled so stale JS or an incomplete module load cannot leave
  // an apparently usable button with no working UI. Preflight failures stay disabled.
  el('btnBoardAppearance').disabled = false;
  el('btnBoardAppearance').removeAttribute('title');
  return {
    dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); pending = null;
      controller.dispose(); preview.width = preview.height = 1;
    },
  };
}
