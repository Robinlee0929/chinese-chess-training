// AI 引擎自測
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as gameEngine from './game.js';
import { initialBoard, applyMove, legalMoves, inCheck, RED, BLACK, hashBoard } from './game.js';
import { findBestMove, evaluate } from './ai.js';

let failed = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓', msg); }
  else { failed++; console.error('  ✗', msg); }
}
const emptyBoard = () => Array.from({ length: 10 }, () => Array(9).fill(null));
const isLegal = (b, mv) =>
  !!mv && legalMoves(b, mv.from.r, mv.from.c).some((m) => m.r === mv.to.r && m.c === mv.to.c);

const aiSource = readFileSync(new URL('./ai.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(source, search, replacement, label) {
  const next = source.replace(search, replacement);
  if (next === source) throw new Error(`AI test harness could not instrument ${label}`);
  return next;
}

function executableAi({ disableNegamaxRepetition = false, disableQuiesceRepetition = false,
  invertPerpetualScore = false, exposePartialDepth = false, breakCleanupLayer = null } = {}) {
  let source = aiSource;
  source = replaceRequired(source, /import \{[^]*?\} from '\.\/game\.js\?v=[^']+';/,
    'const { ROWS, COLS, RED, BLACK, getMoves, legalMoves, kingsFacing, kingPos, inCheck, hashBoard, repetitionVerdict } = globalThis.__game;',
    'game import');
  source = source.replace(/\bexport\s+/g, '');
  if (disableNegamaxRepetition) {
    source = replaceRequired(source,
      'function negamax(b, side, depth, alpha, beta, ply) {\n  checkTime();\n  const repeated = repetitionScore(side, ply);',
      'function negamax(b, side, depth, alpha, beta, ply) {\n  checkTime();\n  const repeated = null;',
      'negamax repetition negative control');
  }
  source = replaceRequired(source,
    'function withRepetitionPosition(b, mover, sideToMove, searchChild) {\n  if (!repetitionAware) return searchChild();\n  pushRepetitionPosition(b, mover, sideToMove);\n  try {\n    return searchChild();\n  } finally {\n    repetitionPath.pop();\n  }\n}',
    `function withRepetitionPosition(b, mover, sideToMove, layer, searchChild) {
  if (!repetitionAware) return searchChild();
  const before = repetitionPath.map((entry) => ({ ...entry }));
  pushRepetitionPosition(b, mover, sideToMove);
  globalThis.__hooks?.onRepetitionPush?.(layer, before, repetitionPath.map((entry) => ({ ...entry })));
  try {
    return searchChild();
  } finally {
    if (globalThis.__brokenCleanupLayer !== layer) repetitionPath.pop();
    globalThis.__hooks?.onRepetitionExit?.(layer, before, repetitionPath.map((entry) => ({ ...entry })));
  }
}`,
    'repetition-scope diagnostics');
  source = replaceRequired(source,
    'const sc = -withRepetitionPosition(b, side, other(side),\n      () => quiesce',
    "const sc = -withRepetitionPosition(b, side, other(side), 'quiescence',\n      () => quiesce",
    'quiescence repetition-scope label');
  source = replaceRequired(source,
    'const sc = -withRepetitionPosition(b, side, other(side),\n      () => negamax',
    "const sc = -withRepetitionPosition(b, side, other(side), 'negamax',\n      () => negamax",
    'negamax repetition-scope label');
  source = replaceRequired(source,
    'const sc = withRepetitionPosition(b, side, other(side), () => {',
    "const sc = withRepetitionPosition(b, side, other(side), 'root', () => {",
    'root repetition-scope label');
  if (disableQuiesceRepetition) {
    source = replaceRequired(source,
      'function quiesce(b, side, alpha, beta, ply) {\n  checkTime();\n  const repeated = repetitionScore(side, ply);',
      'function quiesce(b, side, alpha, beta, ply) {\n  checkTime();\n  const repeated = null;',
      'quiescence repetition negative control');
  }
  if (invertPerpetualScore) {
    source = replaceRequired(source,
      'return verdict.loser === side ? -MATE + ply : MATE - ply;',
      'return verdict.loser === side ? MATE - ply : -MATE + ply;',
      'perpetual-check sign negative control');
  }
  source = replaceRequired(source,
    'if (deadline && (++nodes & 1023) === 0 && Date.now() > deadline) throw TIMEOUT;',
    'if (deadline && (++nodes & globalThis.__timeMask) === 0 && globalThis.__now() > deadline) throw TIMEOUT;',
    'controllable deadline');
  source = source.replace(/Date\.now\(\)/g, 'globalThis.__now()');
  source = replaceRequired(source,
    'function quiesce(b, side, alpha, beta, ply) {\n  checkTime();\n  const repeated =',
    'function quiesce(b, side, alpha, beta, ply) {\n  globalThis.__hooks?.onQuiesceEnter?.({ side, ply });\n  checkTime();\n  const repeated =',
    'quiescence entry hook');
  source = replaceRequired(source,
    "    make(b, m);\n    const sc = -withRepetitionPosition(b, side, other(side), 'quiescence',",
    `    make(b, m);
    globalThis.__hooks?.onQuiesceMove?.({
      move: { fr: m.fr, fc: m.fc, tr: m.tr, tc: m.tc },
      captured: cap ? { ...cap } : null,
      key: hashBoard(b) + '|' + other(side),
      mover: side,
      check: inCheckFast(b, other(side)),
    });
    const sc = -withRepetitionPosition(b, side, other(side), 'quiescence',`,
    'quiescence move diagnostics');
  source = replaceRequired(source,
    'function negamax(b, side, depth, alpha, beta, ply) {\n  checkTime();\n  const repeated =',
    'function negamax(b, side, depth, alpha, beta, ply) {\n  globalThis.__hooks?.onNegamaxEnter?.({ side, depth, ply });\n  checkTime();\n  const repeated =',
    'negamax entry hook');
  source = replaceRequired(source,
    'if (repeated !== null) return repeated;',
    'if (repeated !== null) { globalThis.__hooks?.onQuiesceRepetition?.({ side, ply, key: repetitionPath[repetitionPath.length - 1].key }); return repeated; }',
    'quiescence repetition hook');
  source = replaceRequired(source,
    'if (repeated !== null) return repeated;',
    'if (repeated !== null) { globalThis.__hooks?.onNegamaxRepetition?.({ side, ply }); return repeated; }',
    'negamax repetition hook');
  source = replaceRequired(source,
    'const hit = transpositionTableEnabled ? TT.get(key) : null;',
    'globalThis.__hooks?.onTTRead?.(transpositionTableEnabled);\n  const hit = transpositionTableEnabled ? TT.get(key) : null;',
    'TT read hook');
  source = replaceRequired(source,
    'if (transpositionTableEnabled) TT.set(key, { d: depth, s: sStore, f: flag, m: bestM });',
    'globalThis.__hooks?.onTTWrite?.(transpositionTableEnabled);\n  if (transpositionTableEnabled) TT.set(key, { d: depth, s: sStore, f: flag, m: bestM });',
    'TT write hook');
  source = replaceRequired(source,
    'for (let d = 1; d <= maxDepth; d++) {',
    'for (let d = 1; d <= maxDepth; d++) {\n    globalThis.__hooks?.onDepthStart?.(d);',
    'depth-start hook');
  source = replaceRequired(source,
    'completed = d;\n    if (scored[0].score > MATE - 200)',
    'completed = d;\n    globalThis.__hooks?.onDepthComplete?.(d, scored.map((entry) => ({ m: { ...entry.m }, score: entry.score })));\n    if (scored[0].score > MATE - 200)',
    'depth-complete hook');
  source = replaceRequired(source,
    'if (err !== TIMEOUT) throw err;\n      // 逾時例外會跳過搜索內層的 make/unmake，直接換新盤面',
    'if (err !== TIMEOUT) throw err;\n      globalThis.__hooks?.onIterationTimeout?.(repetitionPath?.map((entry) => ({ ...entry })));\n      // 逾時例外會跳過搜索內層的 make/unmake，直接換新盤面',
    'iteration-timeout hook');
  if (exposePartialDepth) {
    source = replaceRequired(source,
      'globalThis.__hooks?.onDepthStart?.(d);',
      'globalThis.__hooks?.onDepthStart?.(d);\n    completed = d;',
      'partial-depth negative control');
  }
  source += `
globalThis.__aiTest = {
  findBestMove,
  runNegamax(srcBoard, side, depth, records) {
    const b = srcBoard.map((row) => row.map((p) => (p ? { ...p } : null)));
    nodes = 0; deadline = 0; TT = new Map(); killers = [];
    histH = { [RED]: {}, [BLACK]: {} };
    repetitionAware = true;
    repetitionPath = records.map((entry) => ({ ...entry }));
    transpositionTableEnabled = false;
    initZobrist(b, side);
    try { return negamax(b, side, depth, -INF, INF, 0); }
    finally { repetitionAware = false; repetitionPath = null; transpositionTableEnabled = true; }
  },
};`;

  const context = vm.createContext({
    __game: gameEngine,
    __hooks: {},
    __brokenCleanupLayer: breakCleanupLayer,
    __now: Date.now,
    __timeMask: 1023,
    Math,
    Map,
    Set,
  });
  vm.runInContext(source, context);
  return context;
}

function expectedFailure(detector, label) {
  let caught = false;
  try { detector(); } catch { caught = true; }
  ok(caught, `EXPECTED_FAIL：${label}`);
}

// ---------- 初始局面：三種難度都要回傳合法著法 ----------
for (const lv of ['easy', 'medium', 'hard']) {
  const b = initialBoard();
  const t0 = Date.now();
  const mv = findBestMove(b, RED, lv);
  const ms = Date.now() - t0;
  ok(isLegal(b, mv), `${lv}：初始局面回傳合法著法（${ms}ms, depth=${mv?.depth}）`);
}

// ---------- 黑方也能走 ----------
{
  const b = initialBoard();
  applyMove(b, { r: 2, c: 1 }, { r: 2, c: 4 }); // 紅炮平五
  const mv = findBestMove(b, BLACK, 'medium');
  ok(isLegal(b, mv), '黑方（medium）回傳合法著法');
}

// ---------- 白吃大子：中等以上要吃掉沒人保護的車 ----------
{
  // 保留開局屏障，避免四子殘局的先將再吃與立即吃車落在 8 分隨機窗內。
  // 紅車移到無根的 (5,1)，黑車可直取且紅方無法立即回吃。
  const b = initialBoard();
  b[5][1] = b[0][0]; b[0][0] = null;
  b[5][8] = b[9][8]; b[9][8] = null;
  const mv = findBestMove(b, BLACK, 'medium');
  ok(isLegal(b, mv) && mv.from.r === 5 && mv.from.c === 8 && mv.to.r === 5 && mv.to.c === 1,
    `medium：白吃無根紅車（實走 ${JSON.stringify(mv)}）`);
}

// ---------- 解將：被將軍時必須應將 ----------
{
  const b = emptyBoard();
  b[0][4] = { type: 'K', side: RED };
  b[9][4] = { type: 'K', side: BLACK };
  b[5][4] = { type: 'N', side: BLACK }; // 擋對臉
  b[3][4] = { type: 'R', side: BLACK }; // 將軍
  b[0][0] = { type: 'R', side: RED };
  for (const lv of ['easy', 'medium', 'hard']) {
    const mv = findBestMove(b, RED, lv);
    const nb = b.map((r) => r.slice());
    applyMove(nb, mv.from, mv.to);
    ok(!inCheck(nb, RED), `${lv}：被將時應將（實走 ${JSON.stringify(mv)}）`);
  }
}

// ---------- 殺棋：困難模式找到一步殺 ----------
{
  // 黑將 (9,4)，紅雙俥：一俥 (8,0) 控制第 8 行，另一俥 (7,8) 走到 (9,8)... 改用鐵門栓型
  const b = emptyBoard();
  b[9][4] = { type: 'K', side: BLACK };
  b[0][3] = { type: 'K', side: RED };
  b[8][0] = { type: 'R', side: RED };  // 控制 row 8（黑將無法下來）
  b[6][8] = { type: 'R', side: RED };  // 俥進 (9,8) 抽底線將軍
  b[5][3] = { type: 'P', side: RED };
  const mv = findBestMove(b, RED, 'hard');
  const nb = b.map((r) => r.slice());
  applyMove(nb, mv.from, mv.to);
  const mated = inCheck(nb, BLACK) &&
    ![...Array(10).keys()].some((r) => [...Array(9).keys()].some((c) => {
      const p = nb[r][c];
      return p && p.side === BLACK && legalMoves(nb, r, c).length > 0;
    }));
  ok(mated, `hard：找到一步殺（實走 ${JSON.stringify(mv)}，score=${mv?.score}）`);
}

// ---------- 殺棋：困難模式看到兩步連將殺（應將靜態搜索＋將軍延伸） ----------
{
  const b = emptyBoard();
  b[9][4] = { type: 'K', side: BLACK };
  b[8][6] = { type: 'C', side: BLACK }; // 黑砲只能墊將，被吃後無子可擋
  b[0][0] = { type: 'K', side: RED };
  b[8][0] = { type: 'R', side: RED };  // 控制 row 8 的宮位出口
  b[5][8] = { type: 'R', side: RED };  // 俥進 (9,8) 開始連將
  const mv = findBestMove(b, RED, 'hard');
  ok(mv && mv.score > 100000 - 200,
    `hard：看出兩步連將殺（實走 ${JSON.stringify(mv?.from)}→${JSON.stringify(mv?.to)}，score=${mv?.score}）`);
}

// ---------- 重複局面：近期出現過的局面要扣分避開 ----------
{
  // 注意：紅帥須在九宮內（(0,0) 會造成紅方無子可動→全為殺棋分數，測試失真）
  const b = emptyBoard();
  b[0][3] = { type: 'K', side: RED };
  b[9][5] = { type: 'K', side: BLACK };
  const mv1 = findBestMove(b, BLACK, 'medium');
  const nb1 = b.map((r) => r.slice());
  applyMove(nb1, mv1.from, mv1.to);
  const h = hashBoard(nb1);
  const mv2 = findBestMove(b, BLACK, 'medium', [h]);
  const nb2 = b.map((r) => r.slice());
  applyMove(nb2, mv2.from, mv2.to);
  ok(hashBoard(nb2) !== h, `medium：給定近期局面後避開重複（第一次 ${JSON.stringify(mv1?.to)}，第二次 ${JSON.stringify(mv2?.to)}）`);
}

// ---------- 評估函數對稱 ----------
{
  ok(evaluate(initialBoard()) === 0, '初始局面評估為 0（紅黑對稱）');
}

// ---------- Review AI：歷史前綴使同一候選成為第三次重複和局 ----------
{
  const b = emptyBoard();
  b[0][3] = { type: 'K', side: RED };
  b[7][3] = { type: 'K', side: BLACK };
  b[0][4] = { type: 'R', side: BLACK };
  b[1][3] = { type: 'R', side: BLACK };
  const forced = { from: { r: 0, c: 3 }, to: { r: 0, c: 4 } };
  const child = b.map((row) => row.map((p) => (p ? { ...p } : null)));
  applyMove(child, forced.from, forced.to);
  const childKey = `${hashBoard(child)}|${BLACK}`;
  const currentKey = `${hashBoard(b)}|${RED}`;
  const inherited = [
    { key: childKey, mover: null, check: false },
    { key: 'historical-filler|red', mover: BLACK, check: false },
    { key: childKey, mover: RED, check: false },
    { key: currentKey, mover: BLACK, check: false },
  ];
  const fresh = [{ key: currentKey, mover: null, check: false }];
  const repeated = findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: inherited });
  const withoutHistory = findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: fresh });
  ok(isLegal(b, repeated) && repeated.score === 0,
    `review-v1：繼承前綴把唯一候選判為第三次重複和局（${JSON.stringify(repeated)}）`);
  ok(withoutHistory?.score < -(100000 - 200),
    `review-v1：改成 fresh 前綴會產生實質不同的殺棋級分數（${withoutHistory?.score}）`);
  ok(repeated.depth >= 1 && repeated.depth <= 3, `review-v1：只回報完成的 1–3 層（depth=${repeated.depth}）`);

  const again = findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: inherited });
  ok(JSON.stringify(again) === JSON.stringify(repeated), 'review-v1：同完成深度的同分選擇具確定性');
}

// ---------- Review AI：negamax 實際遞迴會讀取繼承歷史 ----------
{
  const b = emptyBoard();
  b[0][3] = { type: 'K', side: RED };
  b[7][3] = { type: 'K', side: BLACK };
  b[0][4] = { type: 'R', side: BLACK };
  b[1][3] = { type: 'R', side: BLACK };
  const child = b.map((row) => row.map((p) => (p ? { ...p } : null)));
  applyMove(child, { r: 0, c: 3 }, { r: 0, c: 4 });
  const childKey = `${hashBoard(child)}|${BLACK}`;
  const currentKey = `${hashBoard(b)}|${RED}`;
  const inherited = [
    { key: childKey, mover: null, check: false },
    { key: 'negamax-filler|red', mover: BLACK, check: false },
    { key: childKey, mover: RED, check: false },
    { key: currentKey, mover: BLACK, check: false },
  ];
  const context = executableAi();
  let repetitionHits = 0;
  context.__hooks.onNegamaxRepetition = () => { repetitionHits++; };
  const result = context.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: inherited });
  ok(result?.score === 0 && repetitionHits > 0,
    `review-v1：negamax 遞迴讀到第三次重複（hits=${repetitionHits}, score=${result?.score}）`);

  const broken = executableAi({ disableNegamaxRepetition: true });
  const brokenResult = broken.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: inherited });
  expectedFailure(() => assert.equal(brokenResult?.score, 0), '移除 negamax 歷史判決會被測試攔截');
}

// ---------- Review AI：quiescence 第三次重複會改變公開候選，fresh history 不會 ----------
{
  const b = emptyBoard();
  b[0][5] = { type: 'K', side: RED };
  b[2][6] = { type: 'N', side: RED };
  b[2][7] = { type: 'R', side: RED };
  b[3][2] = { type: 'B', side: BLACK };
  b[8][4] = { type: 'K', side: BLACK };
  b[9][0] = { type: 'A', side: BLACK };

  // 候選俥七進七後，黑將進入 (7,3)，quiescence 內俥由 (9,7) 吃至 (9,0)。
  const repeatedBoard = b.map((row) => row.map((p) => (p ? { ...p } : null)));
  applyMove(repeatedBoard, { r: 2, c: 7 }, { r: 9, c: 7 });
  applyMove(repeatedBoard, { r: 8, c: 4 }, { r: 7, c: 3 });
  applyMove(repeatedBoard, { r: 9, c: 7 }, { r: 9, c: 0 });
  const repeatedKey = `${hashBoard(repeatedBoard)}|${BLACK}`;
  const currentKey = `${hashBoard(b)}|${RED}`;

  // 使用實際 hashBoard 產生的 canonical entry，並維持 side/mover 交替。
  const filler1 = b.map((row) => row.map((p) => (p ? { ...p } : null)));
  filler1[8][3] = filler1[8][4]; filler1[8][4] = null;
  const filler2 = filler1.map((row) => row.map((p) => (p ? { ...p } : null)));
  filler2[4][5] = filler2[2][6]; filler2[2][6] = null;
  const filler3 = filler2.map((row) => row.map((p) => (p ? { ...p } : null)));
  filler3[5][4] = filler3[3][2]; filler3[3][2] = null;
  const inherited = [
    { key: repeatedKey, mover: null, check: false },
    { key: `${hashBoard(filler1)}|${RED}`, mover: BLACK, check: false },
    { key: `${hashBoard(filler2)}|${BLACK}`, mover: RED, check: false },
    { key: `${hashBoard(filler3)}|${RED}`, mover: BLACK, check: false },
    { key: repeatedKey, mover: RED, check: false },
    { key: currentKey, mover: BLACK, check: false },
  ];
  const fresh = [{ key: currentKey, mover: null, check: false }];

  const inheritedResult = findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: inherited });
  const freshResult = findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: fresh });
  ok(inheritedResult?.from.r === 2 && inheritedResult?.from.c === 7
    && inheritedResult?.to.r === 9 && inheritedResult?.to.c === 7
    && inheritedResult?.score === 298 && inheritedResult?.depth === 3,
  `review-v1：quiescence 重複歷史選擇俥 (2,7)→(9,7)（score=${inheritedResult?.score}, depth=${inheritedResult?.depth}）`);
  ok(freshResult?.from.r === 2 && freshResult?.from.c === 7
    && freshResult?.to.r === 8 && freshResult?.to.c === 7
    && freshResult?.score === 303 && freshResult?.depth === 3,
  `review-v1：fresh history 改選俥 (2,7)→(8,7)（score=${freshResult?.score}, depth=${freshResult?.depth}）`);
  ok(JSON.stringify(inheritedResult) !== JSON.stringify(freshResult),
    'review-v1：唯一輸入差異為 repetition history，公開候選與分數產生實質差異');

  const context = executableAi();
  context.__now = () => 0;
  const quiescenceHits = [];
  const quiescenceMoves = [];
  let negamaxHits = 0;
  context.__hooks.onQuiesceMove = (entry) => { quiescenceMoves.push(entry); };
  context.__hooks.onQuiesceRepetition = (entry) => { quiescenceHits.push(entry); };
  context.__hooks.onNegamaxRepetition = () => { negamaxHits++; };
  const result = context.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: inherited });
  const decisiveMoveReached = quiescenceMoves.some((entry) => entry.key === repeatedKey
    && entry.move.fr === 9 && entry.move.fc === 7 && entry.move.tr === 9 && entry.move.tc === 0);
  ok(JSON.stringify(result) === JSON.stringify(inheritedResult)
    && decisiveMoveReached && quiescenceHits.some((entry) => entry.key === repeatedKey),
  `review-v1：quiescence 內 (9,7)→(9,0) 到達第三次重複（hits=${quiescenceHits.length}）`);
  ok(negamaxHits === 0, 'review-v1：公開結果差異不是由 negamax repetition 判決造成');

  const freshContext = executableAi();
  freshContext.__now = () => 0;
  const freshQuiescenceHits = [];
  freshContext.__hooks.onQuiesceRepetition = (entry) => { freshQuiescenceHits.push(entry); };
  const deterministicFreshResult = freshContext.__aiTest.findBestMove(
    b, RED, 'review-v1', [], { repetitionPrefix: fresh });
  ok(JSON.stringify(deterministicFreshResult) === JSON.stringify(freshResult)
    && !freshQuiescenceHits.some((entry) => entry.key === repeatedKey),
  'review-v1：固定 clock 下 fresh history 的同一 quiescence 節點不受重複判決');

  const broken = executableAi({ disableQuiesceRepetition: true });
  broken.__now = () => 0;
  const brokenResult = broken.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: inherited });
  ok(JSON.stringify(brokenResult) === JSON.stringify(freshResult),
    'review-v1：移除 quiescence repetition 後 inherited 結果退化為 fresh history 結果');
  expectedFailure(() => assert.deepEqual(brokenResult, inheritedResult),
    '移除 quiescence 歷史判決會被候選／分數行為差異攔截');
}

// ---------- Review AI：長將判負的兩個符號方向都由 negamax 實際判決 ----------
{
  const context = executableAi();
  const blackToMove = emptyBoard();
  blackToMove[0][3] = { type: 'K', side: RED };
  blackToMove[9][5] = { type: 'K', side: BLACK };
  const key = `${hashBoard(blackToMove)}|${BLACK}`;
  const blackLoses = [
    { key, mover: null, check: false },
    { key: 'black-check-1|red', mover: BLACK, check: true },
    { key, mover: RED, check: false },
    { key: 'black-check-2|red', mover: BLACK, check: true },
    { key, mover: RED, check: false },
  ];
  const redLoses = [
    { key, mover: null, check: false },
    { key: 'red-check-1|red', mover: BLACK, check: false },
    { key, mover: RED, check: true },
    { key: 'red-check-2|red', mover: BLACK, check: false },
    { key, mover: RED, check: true },
  ];
  const loss = context.__aiTest.runNegamax(blackToMove, BLACK, 1, blackLoses);
  const win = context.__aiTest.runNegamax(blackToMove, BLACK, 1, redLoses);
  ok(loss < -(100000 - 200), `review-v1：輪到違規長將方時回傳負殺分（${loss}）`);
  ok(win > 100000 - 200, `review-v1：輪到長將受害方時回傳正殺分（${win}）`);

  const broken = executableAi({ invertPerpetualScore: true });
  expectedFailure(() => {
    assert.ok(broken.__aiTest.runNegamax(blackToMove, BLACK, 1, blackLoses) < 0);
    assert.ok(broken.__aiTest.runNegamax(blackToMove, BLACK, 1, redLoses) > 0);
  }, '反轉長將勝負符號會被雙向測試攔截');
}

// ---------- Review AI：negamax timeout 逐層精確還原 repetition path ----------
{
  const b = initialBoard();
  const prefix = [{ key: `${hashBoard(b)}|${RED}`, mover: null, check: false }];
  let activeDepth = 0;
  let negamaxPly = 0;
  const exits = [];
  const timeoutPaths = [];
  const context = executableAi();
  context.__timeMask = 0;
  context.__hooks.onDepthStart = (depth) => { activeDepth = depth; };
  context.__hooks.onNegamaxEnter = ({ ply }) => { negamaxPly = ply; };
  context.__hooks.onRepetitionExit = (layer, before, after) => {
    if (layer === 'negamax') exits.push({ before: structuredClone(before), after: structuredClone(after) });
  };
  context.__hooks.onIterationTimeout = (path) => timeoutPaths.push(structuredClone(path));
  context.__now = () => (activeDepth >= 2 && negamaxPly >= 2 ? 1201 : 0);
  const result = context.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: prefix });
  ok(result?.depth === 1 && exits.length > 0
    && exits.every(({ before, after }) => JSON.stringify(before) === JSON.stringify(after))
    && timeoutPaths.every((path) => JSON.stringify(path) === JSON.stringify(prefix)),
  `review-v1：negamax timeout 後精確還原每筆 repetition entry（scopes=${exits.length}）`);

  activeDepth = 0;
  negamaxPly = 0;
  const broken = executableAi({ breakCleanupLayer: 'negamax' });
  broken.__timeMask = 0;
  broken.__hooks.onDepthStart = (depth) => { activeDepth = depth; };
  broken.__hooks.onNegamaxEnter = ({ ply }) => { negamaxPly = ply; };
  broken.__now = () => (activeDepth >= 2 && negamaxPly >= 2 ? 1201 : 0);
  expectedFailure(() => assert.doesNotThrow(() => broken.__aiTest.findBestMove(
    b, RED, 'review-v1', [], { repetitionPrefix: prefix },
  )), '略過 negamax exceptional cleanup 會被測試攔截');
}

// ---------- Review AI：quiescence timeout 逐層精確還原 repetition path ----------
{
  const b = emptyBoard();
  b[0][3] = { type: 'K', side: RED };
  b[7][3] = { type: 'K', side: BLACK };
  b[0][4] = { type: 'R', side: BLACK };
  b[1][3] = { type: 'R', side: BLACK };
  b[1][0] = { type: 'B', side: RED };
  const prefix = [{ key: `${hashBoard(b)}|${RED}`, mover: null, check: false }];
  let quiescePly = 0;
  const exits = [];
  const timeoutPaths = [];
  const context = executableAi();
  context.__timeMask = 0;
  context.__hooks.onQuiesceEnter = ({ ply }) => { quiescePly = ply; };
  context.__hooks.onRepetitionExit = (layer, before, after) => {
    if (layer === 'quiescence') exits.push({ before: structuredClone(before), after: structuredClone(after) });
  };
  context.__hooks.onIterationTimeout = (path) => timeoutPaths.push(structuredClone(path));
  context.__now = () => (quiescePly >= 2 ? 1201 : 0);
  const result = context.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: prefix });
  ok(result === null && exits.length > 0
    && exits.every(({ before, after }) => JSON.stringify(before) === JSON.stringify(after))
    && timeoutPaths.every((path) => JSON.stringify(path) === JSON.stringify(prefix)),
  `review-v1：quiescence timeout 後精確還原每筆 repetition entry（scopes=${exits.length}）`);

  quiescePly = 0;
  const broken = executableAi({ breakCleanupLayer: 'quiescence' });
  broken.__timeMask = 0;
  broken.__hooks.onQuiesceEnter = ({ ply }) => { quiescePly = ply; };
  broken.__now = () => (quiescePly >= 2 ? 1201 : 0);
  expectedFailure(() => assert.doesNotThrow(() => broken.__aiTest.findBestMove(
    b, RED, 'review-v1', [], { repetitionPrefix: prefix },
  )), '略過 quiescence exceptional cleanup 會被測試攔截');
}

// ---------- Review AI：逾時只回傳完整完成的迭代 ----------
{
  const b = initialBoard();
  const prefix = [{ key: `${hashBoard(b)}|${RED}`, mover: null, check: false }];
  let activeDepth = 0;
  const starts = [];
  const completes = [];
  const completedCandidates = new Map();
  const timeoutPaths = [];
  const rootExits = [];
  const context = executableAi();
  context.__timeMask = 0;
  context.__hooks.onDepthStart = (depth) => { activeDepth = depth; starts.push(depth); };
  context.__hooks.onDepthComplete = (depth, scored) => {
    completes.push(depth);
    completedCandidates.set(depth, structuredClone(scored[0]));
  };
  context.__hooks.onIterationTimeout = (path) => timeoutPaths.push(structuredClone(path));
  context.__hooks.onRepetitionExit = (layer, before, after) => {
    if (layer === 'root') rootExits.push({ before: structuredClone(before), after: structuredClone(after) });
  };
  context.__now = () => (activeDepth >= 3 ? 1201 : 0);
  const partial = context.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: prefix });
  const completedDepth2 = completedCandidates.get(2);
  ok(partial?.depth === 2 && starts.join() === '1,2,3' && completes.join() === '1,2',
    `review-v1：第 3 層中途逾時只回傳第 2 層（depth=${partial?.depth}）`);
  ok(partial?.from.r === completedDepth2?.m.fr && partial?.from.c === completedDepth2?.m.fc
    && partial?.to.r === completedDepth2?.m.tr && partial?.to.c === completedDepth2?.m.tc
    && partial?.score === completedDepth2?.score,
  'review-v1：逾時結果是完整 depth-2 的同一候選與分數，不是部分 depth-3 結果');
  ok(timeoutPaths.length === 1 && JSON.stringify(timeoutPaths[0]) === JSON.stringify(prefix)
    && rootExits.every(({ before, after }) => JSON.stringify(before) === JSON.stringify(after)),
  'review-v1：iterative timeout 邊界看到完整原始 repetition prefix');

  activeDepth = 0;
  context.__hooks = {};
  context.__now = () => 0;
  const afterTimeout = context.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: prefix });
  ok(isLegal(b, afterTimeout) && afterTimeout.depth === 3,
    'review-v1：同一引擎 context 在 timeout 後可用乾淨 canonical history 完成下一次搜索');

  activeDepth = 0;
  const immediate = executableAi();
  const immediateTimeoutPaths = [];
  immediate.__timeMask = 0;
  immediate.__hooks.onDepthStart = (depth) => { activeDepth = depth; };
  immediate.__hooks.onIterationTimeout = (path) => immediateTimeoutPaths.push(structuredClone(path));
  immediate.__now = () => (activeDepth >= 1 ? 1201 : 0);
  const none = immediate.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: prefix });
  ok(none === null && immediateTimeoutPaths.length === 1
    && JSON.stringify(immediateTimeoutPaths[0]) === JSON.stringify(prefix),
  'review-v1：第 1 層完成前逾時安全回傳 null 且 repetition history 完整');

  activeDepth = 0;
  const broken = executableAi({ exposePartialDepth: true });
  broken.__timeMask = 0;
  broken.__hooks.onDepthStart = (depth) => { activeDepth = depth; };
  broken.__now = () => (activeDepth >= 3 ? 1201 : 0);
  const leaked = broken.__aiTest.findBestMove(b, RED, 'review-v1', [], { repetitionPrefix: prefix });
  expectedFailure(() => assert.equal(leaked?.depth, 2), '把部分完成的第 3 層標為完成會被測試攔截');
}

// ---------- Review AI：實際搜索停用 board-only TT，一般 AI 仍啟用 ----------
{
  const reviewBoard = initialBoard();
  const prefix = [{ key: `${hashBoard(reviewBoard)}|${RED}`, mover: null, check: false }];
  const reviewContext = executableAi();
  const reviewReads = [];
  const reviewWrites = [];
  reviewContext.__hooks.onTTRead = (enabled) => reviewReads.push(enabled);
  reviewContext.__hooks.onTTWrite = (enabled) => reviewWrites.push(enabled);
  reviewContext.__aiTest.findBestMove(reviewBoard, RED, 'review-v1', [], { repetitionPrefix: prefix });
  ok(reviewReads.length > 0 && reviewReads.every((enabled) => enabled === false)
    && reviewWrites.length > 0 && reviewWrites.every((enabled) => enabled === false),
  'review-v1：可執行搜索完全停用 board-only TT 讀寫');

  const normalContext = executableAi();
  const normalReads = [];
  const normalWrites = [];
  normalContext.__hooks.onTTRead = (enabled) => normalReads.push(enabled);
  normalContext.__hooks.onTTWrite = (enabled) => normalWrites.push(enabled);
  normalContext.__aiTest.findBestMove(initialBoard(), RED, 'medium');
  ok(normalReads.some(Boolean) && normalWrites.some(Boolean), '一般 AI 的可執行搜索仍啟用 TT');
}

// ---------- 效能：hard 在初始局面 5.5 秒內回覆 ----------
{
  const t0 = Date.now();
  findBestMove(initialBoard(), RED, 'hard');
  const ms = Date.now() - t0;
  ok(ms < 5500, `hard 思考時間 ${ms}ms < 5500ms`);
}

console.log(failed === 0 ? '\n全部通過 ✔' : `\n${failed} 項失敗 ✘`);
process.exit(failed === 0 ? 0 : 1);
