// 隨機 fuzz：大量隨機對局，確保規則引擎不出錯、終局判定正常
import {
  initialBoard, legalMoves, applyMove, hasAnyLegalMove, kingsFacing, inCheck,
  hashBoard, repetitionVerdict, RED, BLACK,
} from './game.js';
import { replayGameRecord } from './game-record.js';

const GAMES = 3000;
const cloneBoard = (board) => board.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
const other = (side) => (side === RED ? BLACK : RED);
const same = (actual, expected, message) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
};

let replayedGames = 0;
const terminalCounts = new Map();
for (let g = 0; g < GAMES; g++) {
  let board = initialBoard();
  let turn = RED;
  let moves = 0;
  let terminal = null;
  const recordedMoves = [];
  const directBoards = [cloneBoard(board)];
  const directSides = [turn];
  const directCaptures = [];
  const positionHashes = [hashBoard(board)];
  const repetitionHistory = [{ key: `${positionHashes[0]}|${turn}`, mover: null, check: false }];
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
    if (!options.length) {
      terminal = {
        winner: other(turn),
        terminationReason: inCheck(board, turn) ? 'checkmate' : 'stalemate',
      };
      break;
    }
    const pick = options[Math.floor(Math.random() * options.length)];
    const from = { r: pick.r, c: pick.c };
    const to = { r: pick.m.r, c: pick.m.c };
    const mover = turn;
    const captured = applyMove(board, from, to);
    recordedMoves.push({ from, to });
    directCaptures.push(captured ? { type: captured.type, side: captured.side } : null);
    turn = other(turn);
    const positionHash = hashBoard(board);
    const checked = inCheck(board, turn);
    positionHashes.push(positionHash);
    repetitionHistory.push({ key: `${positionHash}|${turn}`, mover, check: checked });
    directBoards.push(cloneBoard(board));
    directSides.push(turn);

    if (!hasAnyLegalMove(board, turn)) {
      terminal = {
        winner: other(turn),
        terminationReason: checked ? 'checkmate' : 'stalemate',
      };
    } else {
      const verdict = repetitionVerdict(repetitionHistory, repetitionHistory.at(-1).key);
      if (verdict?.result === 'loss') {
        terminal = { winner: other(verdict.loser), terminationReason: 'perpetual-check' };
      } else if (verdict?.result === 'draw') {
        terminal = {
          winner: null,
          terminationReason: verdict.reason === '雙方長將'
            ? 'mutual-perpetual-check'
            : 'threefold-repetition',
        };
      }
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
    if (terminal) break;
  }

  if (terminal?.terminationReason === 'checkmate' || terminal?.terminationReason === 'stalemate') {
    const loser = other(terminal.winner);
    // 輸方不該有合法走法
    if (hasAnyLegalMove(board, loser)) throw new Error(`game ${g}: 宣告終局但 ${loser} 仍有走法`);
  }

  // Persisted GameRecords are terminal by contract. Every random game that
  // reaches a terminal state within the existing 120-ply fuzz horizon is also
  // replayed from its coordinate-only record at opening, middle and final ply.
  if (terminal) {
    const record = {
      schemaVersion: 1,
      id: `fuzz-${g}`,
      createdAt: '2026-08-31T00:00:00.000Z',
      completedAt: '2026-08-31T00:00:00.000Z',
      initialPosition: { board: directBoards[0], sideToMove: directSides[0] },
      moves: recordedMoves,
      mode: 'pvp',
      result: terminal,
    };
    const checkpoints = new Set([0, Math.floor(recordedMoves.length / 2), recordedMoves.length]);
    for (const ply of checkpoints) {
      const replay = replayGameRecord(record, ply);
      same(replay.board, directBoards[ply], `game ${g} ply ${ply}: replay board differs`);
      if (replay.sideToMove !== directSides[ply]) throw new Error(`game ${g} ply ${ply}: replay side differs`);
      same(replay.positionHashes, positionHashes.slice(0, ply + 1), `game ${g} ply ${ply}: hash prefix differs`);
      same(
        replay.repetitionHistory,
        repetitionHistory.slice(0, ply + 1),
        `game ${g} ply ${ply}: repetition prefix differs`,
      );
    }
    const finalReplay = replayGameRecord(record, recordedMoves.length);
    same(
      finalReplay.moveMetadata.map((move) => move.captured),
      directCaptures,
      `game ${g}: derived captures differ`,
    );
    same(finalReplay.terminal, terminal, `game ${g}: terminal verdict differs`);
    replayedGames++;
    terminalCounts.set(terminal.terminationReason, (terminalCounts.get(terminal.terminationReason) || 0) + 1);
  }
}
if (replayedGames === 0) throw new Error('No terminal fuzz game was available for GameRecord replay equivalence.');
console.log(`${GAMES} 局隨機對局全部正常 ✔`);
console.log(`${replayedGames} 局終局完成 GameRecord 開局／中局／終局重播等價 ✔`);
console.log(`終局分布：${[...terminalCounts].map(([reason, count]) => `${reason}=${count}`).join(', ')}`);
