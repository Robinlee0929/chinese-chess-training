import { createGameExportController, createGameExportDownload, gameExportErrorMessage } from './export-controller.js?v=fb9fc70633';
import { captureExportSource } from './export-source.js?v=fb9fc70633';

// Capability handshake: old HTML never receives new handlers; old JS leaves
// all export buttons hidden/disabled. Missing modules cannot break game startup.
export function createGameExportUI({ document = globalThis.document, readSource, closeMenu, notify }) {
  const dialog = document.getElementById('gameExportDialog');
  const entries = [['btnGameExport', 'live'], ['btnGameExportEnd', 'live'], ['btnGameReviewExport', 'review']]
    .map(([id, kind]) => ({ button: document.getElementById(id), kind }));
  if (dialog?.dataset.gameExportUi !== '1' || entries.some(({ button }) => button?.dataset.gameExport !== '1')) return null;
  const summary = document.getElementById('gameExportSummary');
  const status = document.getElementById('gameExportStatus');
  const close = document.getElementById('gameExportClose');
  const formats = [...dialog.querySelectorAll('[data-export-format]')];
  if (!summary || !status || !close || formats.length !== 2) return null;
  const downloads = createGameExportDownload({ document });
  const controller = createGameExportController({ readSource, download: downloads.download });
  const listeners = [];
  const downloadedFormats = new Set();
  let generation = 0, disposed = false, returnFocus = null;
  const listen = (node, event, handler) => { node.addEventListener(event, handler); listeners.push(() => node.removeEventListener(event, handler)); };
  const setPending = pending => {
    dialog.setAttribute('aria-busy', String(pending));
    for (const button of formats) button.disabled = pending || downloadedFormats.has(button.dataset.exportFormat);
  };
  function invalidate() {
    generation++; controller.cancel(); setPending(false);
    if (dialog.open) dialog.close();
  }
  function dismiss() {
    invalidate();
    // The mobile More menu closes before showModal(), hiding the live entry.
    // Restore focus only for user dismissal, not source/page invalidation.
    const target = returnFocus?.getClientRects().length ? returnFocus
      : returnFocus?.id === 'btnGameExport' ? document.getElementById('btnMore') : null;
    if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus();
  }
  function refresh() {
    if (disposed) return;
    if (dialog.open && !controller.check()) invalidate();
    for (const { button, kind } of entries) {
      const source = readSource(kind);
      button.hidden = kind === 'review' ? !source.available || source.sourceKind !== 'completed'
        : button.id === 'btnGameExportEnd' ? !source.available || !source.over : false;
      try {
        captureExportSource(source, '2000-01-01T00:00:00.000Z');
        button.disabled = false; button.title = kind === 'review' ? '匯出完整原對局，不受目前複盤著數影響' : '下載目前已確認的完整走棋進度';
      } catch (error) { button.disabled = true; button.title = gameExportErrorMessage(error); }
    }
  }
  for (const { button, kind } of entries) listen(button, 'click', () => {
    try {
      const game = controller.open(kind); generation++; downloadedFormats.clear(); closeMenu();
      summary.textContent = `${game.moves.length} 著・${game.status === 'completed' ? '已完成' : '未完成'}${kind === 'review' ? '・完整原對局' : ''}`;
      status.textContent = '選擇格式，下載到你的裝置。'; setPending(false);
      returnFocus = button;
      dialog.showModal(); formats[0].focus();
    } catch (error) { controller.cancel(); notify(gameExportErrorMessage(error)); }
  });
  for (const button of formats) listen(button, 'click', async () => {
    if (button.disabled || controller.pending || !dialog.open) return;
    const operation = generation;
    setPending(true); status.textContent = '正在確認棋譜，請稍候…';
    try {
      const result = await controller.export(button.dataset.exportFormat);
      if (generation !== operation || !dialog.open) return;
      if (result.status === 'cancelled') { invalidate(); notify('棋局已變更，已取消匯出。'); }
      else if (result.status === 'downloaded') {
        downloadedFormats.add(button.dataset.exportFormat);
        status.textContent = downloadedFormats.size === 2 ? '兩種格式都已送出下載。' : '已送出下載。也可以選擇另一種格式。';
      }
    } catch (error) {
      if (generation === operation && dialog.open) status.textContent = gameExportErrorMessage(error);
    } finally { if (generation === operation) setPending(false); }
  });
  listen(close, 'click', dismiss);
  listen(dialog, 'cancel', event => { event.preventDefault(); dismiss(); });
  // A programmatic close also owns cancellation; never leave a hidden request alive.
  listen(dialog, 'close', () => { if (!dialog.open) { generation++; controller.cancel(); setPending(false); } });
  refresh();
  return Object.freeze({ refresh, invalidate, dispose() {
    if (disposed) return;
    disposed = true; invalidate(); controller.dispose(); downloads.dispose();
    for (const remove of listeners) remove();
    for (const { button } of entries) { button.hidden = true; button.disabled = true; }
  } });
}
