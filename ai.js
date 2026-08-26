// ============================================================
// 中國象棋 AI 引擎 —— negamax + alpha-beta 剪枝 + 靜態搜索
// 純邏輯，可在 Web Worker 或主執行緒使用
// 難度：easy（淺層＋隨機）/ medium（3 層）/ hard（迭代加深至 6 層）
// ============================================================
import { ROWS, COLS, RED, BLACK, getMoves, legalMoves, kingsFacing, kingPos } from './game.js';

const INF = 1e9;
const MATE = 100000;

// 子力基礎分（兵 20 為一個單位基準）
const VAL = { K: 10000, R: 200, C: 96, N: 88, B: 40, A: 40, P: 20 };

// ---------------- 位置加成表（以己方底線為 row 0，列左右對稱） ----------------
const P_PST = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 0],
  [2, 4, 6, 8, 10, 8, 6, 4, 2],
  [10, 14, 18, 22, 26, 22, 18, 14, 10],
  [14, 20, 26, 32, 36, 32, 26, 20, 14],
  [16, 24, 32, 40, 44, 40, 32, 24, 16],
  [14, 22, 30, 38, 42, 38, 30, 22, 14],
  [6, 10, 14, 18, 20, 18, 14, 10, 6],
];
const N_PST = [
  [0, -4, 0, 0, 0, 0, 0, -4, 0],
  [0, 2, 4, 4, -2, 4, 4, 2, 0],
  [4, 6, 8, 8, 8, 8, 8, 6, 4],
  [2, 6, 8, 10, 6, 10, 8, 6, 2],
  [4, 12, 16, 14, 12, 14, 16, 12, 4],
  [6, 16, 14, 18, 18, 18, 14, 16, 6],
  [8, 24, 18, 24, 20, 24, 18, 24, 8],
  [12, 14, 16, 20, 18, 20, 16, 14, 12],
  [4, 10, 28, 16, 8, 16, 28, 10, 4],
  [4, 8, 16, 12, 4, 12, 16, 8, 4],
];
const R_PST = [
  [-2, 10, 6, 14, 12, 14, 6, 10, -2],
  [8, 4, 8, 16, 8, 16, 8, 4, 8],
  [4, 8, 6, 14, 12, 14, 6, 8, 4],
  [6, 10, 8, 14, 14, 14, 8, 10, 6],
  [12, 16, 14, 20, 20, 20, 14, 16, 12],
  [12, 14, 12, 18, 18, 18, 12, 14, 12],
  [12, 18, 16, 22, 22, 22, 16, 18, 12],
  [12, 12, 12, 18, 18, 18, 12, 12, 12],
  [16, 20, 18, 24, 26, 24, 18, 20, 16],
  [14, 14, 12, 18, 16, 18, 12, 14, 14],
];
const C_PST = [
  [0, 0, 2, 6, 6, 6, 2, 0, 0],
  [0, 2, 4, 6, 6, 6, 4, 2, 0],
  [4, 0, 8, 6, 10, 6, 8, 0, 4],
  [0, 0, 0, 2, 4, 2, 0, 0, 0],
  [-2, 0, 4, 2, 6, 2, 4, 0, -2],
  [0, 0, 0, 2, 8, 2, 0, 0, 0],
  [0, 0, -2, 4, 10, 4, -2, 0, 0],
  [0, 2, 4, 6, 12, 6, 4, 2, 0],
  [2, 2, 0, 8, 14, 8, 0, 2, 2],
  [4, 4, 0, 10, 12, 10, 0, 4, 4],
];

function pst(p, r, c) {
  const rr = p.side === RED ? r : 9 - r; // 換算成「距己方底線」的行數
  switch (p.type) {
    case 'P': return P_PST[rr][c];
    case 'N': return N_PST[rr][c];
    case 'R': return R_PST[rr][c];
    case 'C': return C_PST[rr][c];
    case 'A': return rr === 1 && c === 4 ? 3 : 0;
    case 'B': return rr === 2 && c === 4 ? 6 : rr === 0 ? 2 : 0;
    case 'K': return rr === 0 ? 2 : -6 * rr; // 將帥離底線越遠越危險
    default: return 0;
  }
}

/** 全盤評估：紅方視角（紅多為正） */
export function evaluate(b) {
  let s = 0;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = b[r][c];
      if (!p) continue;
      const v = VAL[p.type] + pst(p, r, c);
      s += p.side === RED ? v : -v;
    }
  return s;
}

const other = (side) => (side === RED ? BLACK : RED);
const evalFor = (b, side) => (side === RED ? evaluate(b) : -evaluate(b));

/** 產生某方所有伪合法著法（含飛將吃王，送將由搜索以「被吃王」懲罰） */
function genMoves(b, side) {
  const out = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = b[r][c];
      if (!p || p.side !== side) continue;
      for (const m of getMoves(b, r, c)) out.push({ fr: r, fc: c, tr: m.r, tc: m.c });
    }
  if (kingsFacing(b)) {
    const k = kingPos(b, side), ek = kingPos(b, other(side));
    if (k && ek) out.push({ fr: k.r, fc: k.c, tr: ek.r, tc: ek.c });
  }
  return out;
}

const make = (b, m) => {
  const cap = b[m.tr][m.tc];
  b[m.tr][m.tc] = b[m.fr][m.fc];
  b[m.fr][m.fc] = null;
  return cap;
};
const unmake = (b, m, cap) => {
  b[m.fr][m.fc] = b[m.tr][m.tc];
  b[m.tr][m.tc] = cap;
};

/** MVV-LVA：先吃大子、用小子吃 */
function orderMoves(b, moves) {
  for (const m of moves) {
    const v = b[m.tr][m.tc];
    m.o = v ? VAL[v.type] * 8 - VAL[b[m.fr][m.fc].type] : 0;
  }
  moves.sort((a, b2) => b2.o - a.o);
}

// ---------------- 搜索 ----------------
const TIMEOUT = Symbol('timeout');
let deadline = 0;
let nodes = 0;

function checkTime() {
  if (deadline && (++nodes & 1023) === 0 && Date.now() > deadline) throw TIMEOUT;
}

function quiesce(b, side, alpha, beta, ply) {
  checkTime();
  const moves = genMoves(b, side);
  // 能直接吃到對方將帥（含飛將）＝殺
  for (const m of moves) {
    const t = b[m.tr][m.tc];
    if (t && t.type === 'K') return MATE - ply;
  }
  const stand = evalFor(b, side);
  if (ply > 24) return stand;
  let best = stand;
  if (best >= beta) return best;
  if (best > alpha) alpha = best;
  const caps = moves.filter((m) => b[m.tr][m.tc]);
  orderMoves(b, caps);
  for (const m of caps) {
    const cap = b[m.tr][m.tc];
    if (stand + VAL[cap.type] + 60 < alpha) continue; // delta 剪枝
    make(b, m);
    const sc = -quiesce(b, other(side), -beta, -alpha, ply + 1);
    unmake(b, m, cap);
    if (sc > best) best = sc;
    if (sc > alpha) alpha = sc;
    if (alpha >= beta) break;
  }
  return best;
}

function negamax(b, side, depth, alpha, beta, ply) {
  checkTime();
  if (depth <= 0) return quiesce(b, side, alpha, beta, ply);
  const moves = genMoves(b, side);
  if (!moves.length) return -MATE + ply; // 無子可動：將死或困斃皆輸
  orderMoves(b, moves);
  let best = -INF;
  for (const m of moves) {
    const cap = b[m.tr][m.tc];
    if (cap && cap.type === 'K') return MATE - ply;
    make(b, m);
    const sc = -negamax(b, other(side), depth - 1, -beta, -alpha, ply + 1);
    unmake(b, m, cap);
    if (sc > best) best = sc;
    if (sc > alpha) alpha = sc;
    if (alpha >= beta) break;
  }
  return best;
}

// ---------------- 難度設定 ----------------
const LEVELS = {
  easy:   { maxDepth: 1, timeMs: 400,  jitter: 50, randomRate: 0.3 },
  medium: { maxDepth: 3, timeMs: 900,  jitter: 8,  randomRate: 0 },
  hard:   { maxDepth: 6, timeMs: 2200, jitter: 2,  randomRate: 0 },
};

/**
 * 找出 side 方的最佳著法。
 * @returns {{from:{r,c}, to:{r,c}, score:number, depth:number}|null} 無合法著法時回 null
 */
export function findBestMove(srcBoard, side, level = 'medium') {
  const cfg = LEVELS[level] || LEVELS.medium;
  const b = srcBoard.map((row) => row.map((p) => (p ? { type: p.type, side: p.side } : null)));

  // 根節點只考慮「嚴格合法」的著法（不送將、不對臉）
  const rootMoves = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = b[r][c];
      if (!p || p.side !== side) continue;
      for (const m of legalMoves(b, r, c)) rootMoves.push({ fr: r, fc: c, tr: m.r, tc: m.c });
    }
  if (!rootMoves.length) return null;

  const fmt = (m, score, depth) => ({ from: { r: m.fr, c: m.fc }, to: { r: m.tr, c: m.tc }, score, depth });

  // 簡單模式：一定機率直接亂走
  if (cfg.randomRate && Math.random() < cfg.randomRate) {
    return fmt(rootMoves[(Math.random() * rootMoves.length) | 0], 0, 0);
  }

  nodes = 0;
  deadline = Date.now() + cfg.timeMs;
  let scored = rootMoves.map((m) => ({ m, score: 0 }));
  let completed = 0;

  for (let d = 1; d <= cfg.maxDepth; d++) {
    const iter = [];
    let alpha = -INF;
    try {
      for (const e of scored) {
        const cap = make(b, e.m);
        let sc = -negamax(b, other(side), d - 1, -INF, -alpha, 1);
        // sc === alpha 可能只是提前截斷的界值（非精確分數），全窗口重搜確認，
        // 避免假分數與真殺著同分而被誤選
        if (sc === alpha && alpha > -INF) {
          sc = -negamax(b, other(side), d - 1, -INF, INF, 1);
        }
        unmake(b, e.m, cap);
        iter.push({ m: e.m, score: sc });
        if (sc > alpha) alpha = sc;
      }
    } catch (err) {
      if (err === TIMEOUT) break;
      throw err;
    }
    iter.sort((a, b2) => b2.score - a.score);
    scored = iter;
    completed = d;
    if (scored[0].score > MATE - 200) break; // 已見必殺，不必再深
  }
  deadline = 0;

  // 依難度加入隨機擾動，讓走法有變化
  let best = scored[0], bestKey = -Infinity;
  for (const e of scored) {
    const key = e.score + (cfg.jitter ? (Math.random() * 2 - 1) * cfg.jitter : 0);
    if (key > bestKey) { bestKey = key; best = e; }
  }
  return fmt(best.m, best.score, completed);
}
