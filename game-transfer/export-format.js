// Rendering only: callers supply the canonical result of the validation Worker.
// No chess validation/replay, storage or browser settings are read here.
import { name } from '../game.js?v=7ba133c431';
import { GAME_TRANSFER_MAX_BYTES, fail } from './contract.js?v=7ba133c431';

const modeNames = { easy: '簡單', medium: '中等', hard: '困難', 'experimental-b': '挑戰級（試玩）', pvp: '雙人對弈' };
const reasons = { checkmate: '將死', stalemate: '困斃', 'perpetual-check': '長將判負', 'threefold-repetition': '三次重複局面', 'mutual-perpetual-check': '雙方長將' };
const sideName = side => side === 'red' ? '紅方' : '黑方';

export function checkTransferOutputSize(text) {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > GAME_TRANSFER_MAX_BYTES) fail('FILE_TOO_LARGE', '棋譜檔案不可超過 1 MiB。', { byteLength });
  return text;
}
export function renderTransferJSON({ document }) {
  return checkTransferOutputSize(JSON.stringify(document, null, 2) + '\n');
}
export function renderTransferTXT({ document: game, replay }) {
  const player = game.playerSide === null ? (game.mode === 'pvp' ? '雙人對弈，無固定玩家棋色' : '未記錄，不推測') : sideName(game.playerSide);
  const lines = ['中國象棋棋譜', `模式：${modeNames[game.mode]}`, `玩家棋色：${player}`,
    `狀態：${game.status === 'completed' ? '已完成' : '未完成'}`, `匯出時間：${game.exportedAt}`,
    `先行方：${sideName(game.initialPosition.sideToMove)}`, '', '初始棋盤',
    '座標：(r,c)；紅方底線 r=0，黑方底線 r=9；c=0..8。', 'r\\c 0 1 2 3 4 5 6 7 8'];
  for (let r = 9; r >= 0; r--) lines.push(`${r}   ${game.initialPosition.board[r].map(p => p ? name(p.side, p.type) : '・').join(' ')}`);
  lines.push('', `著法（共 ${game.moves.length} 著）`);
  for (const move of replay.moveMetadata) {
    const { from, to } = move;
    lines.push(`第 ${move.ply} 著 ${sideName(move.side)}：${move.notation} (${from.r},${from.c}) → (${to.r},${to.c})${move.captured ? `；吃${sideName(move.captured.side)}${name(move.captured.side, move.captured.type)}` : ''}`);
  }
  if (replay.terminal) lines.push('', `結果：${replay.terminal.winner === null ? '和棋' : sideName(replay.terminal.winner) + '勝'}；${reasons[replay.terminal.terminationReason]}`);
  else lines.push('', `結果：尚未完成；輪到${sideName(replay.sideToMove)}行棋。`);
  return checkTransferOutputSize('\uFEFF' + lines.join('\n') + '\n');
}
