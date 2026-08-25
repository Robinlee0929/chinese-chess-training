// 隨機 fuzz：大量隨機對局，確保規則引擎不出錯、終局判定正常
import {
  initialBoard, legalMoves, applyMove, hasAnyLegalMove, kingsFacing, RED, BLACK,
} from './game.js';

const GAMES = 3000;
for (let g = 0; g < GAMES; g++) {
  let board = initialBoard();
  let turn = RED;
  let moves = 0;
  let end = null;
  while (moves < 120) {
    // 隨機選一個有合法走法的子
    const options = [];
    const pieces = [];
    for (let r = 0; r < 10; r++)
      for (let c = 0; c < 9; c++) {
        const p = board[r][c];
        if (p && p.side === turn) {
          const mv = legalMoves(board, r, c);
          for (const m of mv) options.push({ r, c, m });
          if (mv.length) pieces.push({ r, c });
        }
      }
    if (!options.length) { end = turn === RED ? 'black' : 'red'; break; }
    const pick = options[Math.floor(Math.random() * options.length)];
    applyMove(board, { r: pick.r, c: pick.c }, pick.m);
    turns: {
      turn = turn === RED ? BLACK : RED;
    }
    moves++;
    // 不變量：雙方都必須有將
    let redK = 0, blkK = 0;
    for (let r = 0; r < 10; r++)
      for (let c = 0; c < 9; c++) {
        const p = board[r][c];
        if (p && p.type === 'K' && p.side === RED) redK++;
        if (p && p.type === 'K' && p.side === BLACK) blkK++;
      }
    if (redK !== 1 || blkK !== 1) throw new Error(`game ${g}: 將帥數量異常 red=${redK} blk=${blkK}`);
    if (kingsFacing(board)) {
      // 對臉在合法走法裡已被過濾，若出現說明确實漏判
      throw new Error(`game ${g}: 出現對臉局面`);
    }
  }
  if (end) {
    const loser = end === 'red' ? BLACK : RED; // end 是勝方
    // 輸方不該有合法走法
    if (hasAnyLegalMove(board, loser)) throw new Error(`game ${g}: 宣告終局但 ${loser} 仍有走法`);
  }
}
console.log(`${GAMES} 局隨機對局全部正常 ✔`);
