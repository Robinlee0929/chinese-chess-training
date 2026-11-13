import { name } from '../game.js?v=fb9fc70633';
import { createGameImportController, gameImportErrorMessage } from './import-controller.js?v=fb9fc70633';
export { selectImportedGameReviewPly, canContinueImportedGame, createImportedContinuationPosition, isImportedGameReview } from './imported-review.js?v=fb9fc70633';

const modes = { easy: '簡單', medium: '中等', hard: '困難', 'experimental-b': '挑戰級（試玩）', pvp: '雙人對弈' };
const reasons = { checkmate: '將死', stalemate: '困斃', 'perpetual-check': '長將判負', 'threefold-repetition': '三次重複局面', 'mutual-perpetual-check': '雙方長將' };
const side = value => value === 'red' ? '紅方' : '黑方';
export function createGameImportUI({ document = globalThis.document, context, accept }) {
  const button = document.getElementById('btnGameImport'), dialog = document.getElementById('gameImportDialog');
  if (button?.dataset.gameImport !== '1' || dialog?.dataset.gameImportUi !== '1') return null;
  const file = document.getElementById('gameImportFile'), status = document.getElementById('gameImportStatus'),
    preview = document.getElementById('gameImportPreview'), metadata = document.getElementById('gameImportMeta'),
    board = document.getElementById('gameImportBoard'), confirm = document.getElementById('gameImportConfirm'),
    close = document.getElementById('gameImportCancel'), form = document.getElementById('gameImportForm');
  if ([file,status,preview,metadata,board,confirm,close,form].some(x => !x)) return null;
  const controller = createGameImportController({ context, accept });
  const listeners = []; let generation = 0, disposed = false, selectedFile = null;
  const listen = (node, event, fn) => { node.addEventListener(event, fn); listeners.push(() => node.removeEventListener(event, fn)); };
  function invalidate() {
    generation++; controller.cancel(); selectedFile = null; file.value = ''; confirm.disabled = true;
    preview.hidden = true; metadata.replaceChildren(); board.replaceChildren(); dialog.setAttribute('aria-busy', 'false');
    if (dialog.open) dialog.close();
  }
  function dismiss() { invalidate(); if (context().active) button.focus(); }
  function refresh() { if (dialog.open && !controller.check()) invalidate(); }
  function render(review) {
    const game = review.document;
    const values = [['對手模式', modes[game.mode]], ['玩家棋色', game.playerSide === null ? '未記錄' : side(game.playerSide)],
      ['先行方', side(game.initialPosition.sideToMove)], ['總著數', `${game.moves.length} 著`],
      ['狀態', game.status === 'completed' ? '已完成' : '未完成']];
    if (game.result) values.push(['結果', `${game.result.winner === null ? '和棋' : side(game.result.winner) + '勝'}・${reasons[game.result.terminationReason]}`]);
    metadata.replaceChildren();
    for (const [label,value] of values) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; metadata.append(dt,dd); }
    board.replaceChildren();
    for (let r = 9; r >= 0; r--) { const row = document.createElement('tr');
      for (const piece of game.initialPosition.board[r]) { const cell = document.createElement('td'); cell.textContent = piece ? name(piece.side,piece.type) : '・'; if (piece) cell.className = piece.side; row.append(cell); } board.append(row); }
    preview.hidden = false; confirm.disabled = false;
  }
  listen(button, 'click', () => {
    if (dialog.open || !controller.open()) return;
    generation++; selectedFile = null; file.value = ''; preview.hidden = true; confirm.disabled = true;
    status.textContent = '選擇 JSON 棋譜，驗證後才能開始複盤。'; dialog.showModal(); file.focus();
  });
  listen(file, 'change', async () => {
    const chosen = file.files?.[0]; if (!dialog.open || !chosen || chosen === selectedFile) return;
    selectedFile = chosen; const operation = ++generation;
    preview.hidden = true; confirm.disabled = true; status.textContent = '正在驗證完整棋譜，請稍候…'; dialog.setAttribute('aria-busy','true');
    try {
      const result = await controller.select(chosen);
      if (generation !== operation || !dialog.open) return;
      if (result.status === 'ready') { render(result.review); status.textContent = '驗證完成。確認後開始暫存複盤，不會自動儲存。'; }
      else if (result.status === 'cancelled') invalidate();
    } catch (error) { if (generation === operation && dialog.open) { selectedFile = null; status.textContent = gameImportErrorMessage(error); } }
    finally { if (generation === operation) dialog.setAttribute('aria-busy','false'); }
  });
  listen(form, 'submit', event => { event.preventDefault(); if (!dialog.open || confirm.disabled) return;
    confirm.disabled = true;
    if (controller.confirm()) invalidate(); else { status.textContent = '匯入已失效，請重新選擇檔案。'; preview.hidden = true; }
  });
  listen(close, 'click', dismiss);
  listen(dialog, 'cancel', event => { event.preventDefault(); dismiss(); });
  listen(dialog, 'close', () => { if (!dialog.open) { generation++; controller.cancel(); selectedFile = null; } });
  button.hidden = false; button.disabled = false;
  return Object.freeze({ refresh, invalidate, dispose() { if (disposed) return; disposed = true; invalidate(); controller.dispose(); for (const remove of listeners) remove(); button.hidden = true; button.disabled = true; } });
}
