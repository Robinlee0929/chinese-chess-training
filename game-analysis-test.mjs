import assert from 'node:assert/strict';
import test from 'node:test';
import { RED, BLACK, applyMove, legalMoves } from './game.js';
import {
  GameAnalysisError,
  createGameAnalysis,
  gameAnalysisLegalMoves,
  applyGameAnalysisMove,
  undoGameAnalysisMove,
  resetGameAnalysis,
} from './game-analysis.js';

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function checkmateRecord(id = 'analysis-checkmate') {
  const board = emptyBoard();
  board[9][4] = { type: 'K', side: BLACK };
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][8] = { type: 'R', side: RED };
  return {
    schemaVersion: 1,
    id,
    createdAt: '2026-08-31T01:00:00.000Z',
    completedAt: '2026-08-31T01:05:00.000Z',
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
  };
}

function stalemateRecord() {
  const board = emptyBoard();
  board[9][5] = { type: 'K', side: BLACK };
  board[0][5] = { type: 'K', side: RED };
  board[4][5] = { type: 'P', side: RED };
  board[7][5] = { type: 'N', side: RED };
  board[7][0] = { type: 'R', side: RED };
  return {
    ...checkmateRecord('analysis-stalemate'),
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 7, c: 0 }, to: { r: 8, c: 0 } }],
    result: { winner: RED, terminationReason: 'stalemate' },
  };
}

const repetitionCycle = [
  [{ r: 9, c: 4 }, { r: 9, c: 5 }],
  [{ r: 4, c: 3 }, { r: 5, c: 3 }],
  [{ r: 9, c: 5 }, { r: 9, c: 4 }],
  [{ r: 5, c: 3 }, { r: 4, c: 3 }],
];

function repetitionRecord(id = 'analysis-repetition') {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[4][3] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  return {
    ...checkmateRecord(id),
    initialPosition: { board, sideToMove: BLACK },
    moves: [...repetitionCycle, ...repetitionCycle].map(([from, to]) => ({ from, to })),
    result: { winner: null, terminationReason: 'threefold-repetition' },
  };
}

function applyLine(analysis, line) {
  return line.reduce((state, [from, to]) => applyGameAnalysisMove(state, from, to), analysis);
}

function assertAnalysisError(action, code) {
  assert.throws(action, (error) => error instanceof GameAnalysisError && error.code === code);
}

test('creates an isolated nonterminal sandbox from canonical replay and retains its source context', () => {
  const source = repetitionRecord();
  const before = structuredClone(source);
  const analysis = createGameAnalysis(source, 4);
  assert.equal(analysis.sourceRecordId, source.id);
  assert.equal(analysis.sourcePly, 4);
  assert.equal(analysis.currentSide, BLACK);
  assert.deepEqual(analysis.currentBoard, analysis.anchorBoard);
  assert.deepEqual(analysis.repetitionHistory, analysis.anchorRepetitionHistory);
  assert.equal(analysis.repetitionHistory.length, 5);
  assert.deepEqual(analysis.moves, []);
  assert.equal(analysis.terminal, null);
  assert.equal(analysis.revision, 0);
  assert.deepEqual(source, before);
  assert.equal(Object.isFrozen(analysis), true);
  assert.equal(Object.isFrozen(analysis.sourceRecord), true);
  assert.equal(Object.isFrozen(analysis.currentBoard), true);
});

test('rejects terminal source plies but accepts opening, middle and pre-terminal plies', () => {
  const record = repetitionRecord();
  for (const ply of [0, 3, 7]) assert.equal(createGameAnalysis(record, ply).sourcePly, ply);
  assertAnalysisError(() => createGameAnalysis(record, 8), 'TERMINAL_SOURCE');
});

test('applies a legal capture with canonical notation, side toggle and repetition update', () => {
  const analysis = createGameAnalysis(checkmateRecord(), 0);
  const legal = gameAnalysisLegalMoves(analysis, { r: 2, c: 3 });
  assert.equal(legal.some(({ r, c }) => r === 2 && c === 4), true);
  const moved = applyGameAnalysisMove(analysis, { r: 2, c: 3 }, { r: 2, c: 4 });
  assert.equal(moved.currentSide, BLACK);
  assert.equal(moved.moves.length, 1);
  assert.deepEqual(moved.moves[0].captured, { type: 'P', side: BLACK });
  assert.equal(moved.moves[0].notation, '俥六平五');
  assert.deepEqual(moved.currentBoard[2][4], { type: 'R', side: RED });
  assert.equal(moved.currentBoard[2][3], null);
  assert.equal(moved.repetitionHistory.length, analysis.repetitionHistory.length + 1);
  assert.deepEqual(moved.terminal, { winner: RED, terminationReason: 'checkmate' });
  assert.deepEqual(analysis.currentBoard[2][3], { type: 'R', side: RED });
  assert.deepEqual(analysis.currentBoard[2][4], { type: 'P', side: BLACK });
});

test('rejects empty, wrong-side, illegal and post-terminal moves without changing the source state', () => {
  const analysis = createGameAnalysis(checkmateRecord(), 0);
  assertAnalysisError(
    () => applyGameAnalysisMove(analysis, { r: 4, c: 4 }, { r: 5, c: 4 }),
    'EMPTY_SOURCE',
  );
  assertAnalysisError(
    () => applyGameAnalysisMove(analysis, { r: 2, c: 4 }, { r: 3, c: 4 }),
    'WRONG_SIDE',
  );
  assertAnalysisError(
    () => applyGameAnalysisMove(analysis, { r: 2, c: 3 }, { r: 3, c: 4 }),
    'ILLEGAL_MOVE',
  );
  const terminal = applyGameAnalysisMove(analysis, { r: 2, c: 3 }, { r: 2, c: 4 });
  assertAnalysisError(
    () => applyGameAnalysisMove(terminal, { r: 9, c: 4 }, { r: 8, c: 4 }),
    'ANALYSIS_TERMINAL',
  );
  assert.equal(analysis.moves.length, 0);
});

test('supports a four-ply manual line with exact board, side and move-list metadata', () => {
  const analysis = createGameAnalysis(repetitionRecord(), 0);
  const after = applyLine(analysis, repetitionCycle);
  assert.equal(after.moves.length, 4);
  assert.equal(after.currentSide, BLACK);
  assert.deepEqual(after.currentBoard, analysis.anchorBoard);
  assert.deepEqual(after.moves.map(({ ply, side }) => [ply, side]), [
    [1, BLACK], [2, RED], [3, BLACK], [4, RED],
  ]);
  assert.deepEqual(after.moves.map(({ notation }) => notation), ['將五平六', '俥六進一', '將六平五', '俥六退一']);
  assert.equal(after.terminal, null);
});

test('undo restores a capture, side, repetition prefix and clears terminal state', () => {
  const analysis = createGameAnalysis(checkmateRecord(), 0);
  const terminal = applyGameAnalysisMove(analysis, { r: 2, c: 3 }, { r: 2, c: 4 });
  const undone = undoGameAnalysisMove(terminal);
  assert.deepEqual(undone.currentBoard, analysis.currentBoard);
  assert.equal(undone.currentSide, RED);
  assert.deepEqual(undone.repetitionHistory, analysis.repetitionHistory);
  assert.equal(undone.terminal, null);
  assert.equal(undone.moves.length, 0);
  assert.deepEqual(undone.currentBoard[2][4], { type: 'P', side: BLACK });
  assert.equal(undoGameAnalysisMove(undone), undone, 'zero-ply Undo is an identity no-op');
});

test('reset restores the exact anchor and preserves source record and ply', () => {
  const analysis = createGameAnalysis(repetitionRecord(), 0);
  const moved = applyLine(analysis, repetitionCycle.slice(0, 3));
  const reset = resetGameAnalysis(moved);
  assert.deepEqual(reset.currentBoard, analysis.anchorBoard);
  assert.equal(reset.currentSide, analysis.anchorSideToMove);
  assert.deepEqual(reset.repetitionHistory, analysis.anchorRepetitionHistory);
  assert.equal(reset.moves.length, 0);
  assert.equal(reset.terminal, null);
  assert.equal(reset.sourceRecord, analysis.sourceRecord);
  assert.equal(reset.sourcePly, analysis.sourcePly);
  assert.equal(reset.revision, moved.revision + 1);
});

test('adjudicates hypothetical checkmate and stalemate without a GameRecord side effect', () => {
  const mate = applyGameAnalysisMove(
    createGameAnalysis(checkmateRecord(), 0),
    { r: 2, c: 3 },
    { r: 2, c: 4 },
  );
  assert.deepEqual(mate.terminal, { winner: RED, terminationReason: 'checkmate' });
  const stale = applyGameAnalysisMove(
    createGameAnalysis(stalemateRecord(), 0),
    { r: 7, c: 0 },
    { r: 8, c: 0 },
  );
  assert.deepEqual(stale.terminal, { winner: RED, terminationReason: 'stalemate' });
});

test('historical repetition prefix materially changes the hypothetical result', () => {
  const record = repetitionRecord();
  const fresh = applyLine(createGameAnalysis(record, 0), repetitionCycle);
  assert.equal(fresh.terminal, null, 'a fresh prefix has only two copies after one cycle');
  const inherited = applyLine(createGameAnalysis(record, 4), repetitionCycle);
  assert.deepEqual(
    inherited.terminal,
    { winner: null, terminationReason: 'threefold-repetition' },
    'the real prefix supplies the second historical occurrence before the hypothetical cycle',
  );
  assert.equal(
    inherited.repetitionHistory.filter(({ key }) => key === inherited.repetitionHistory.at(-1).key).length,
    3,
  );
  const undone = undoGameAnalysisMove(inherited);
  assert.equal(undone.terminal, null);
  assert.equal(undone.repetitionHistory.length, inherited.repetitionHistory.length - 1);
});

test('deep isolation prevents source, returned board, move and repetition alias contamination', () => {
  const source = repetitionRecord();
  const analysis = createGameAnalysis(source, 0);
  source.id = 'mutated';
  source.initialPosition.board[4][3].type = 'N';
  source.moves[0].from.r = 0;
  assert.equal(analysis.sourceRecordId, 'analysis-repetition');
  assert.deepEqual(analysis.anchorBoard[4][3], { type: 'R', side: RED });
  const from = { r: 9, c: 4 };
  const to = { r: 9, c: 5 };
  const moved = applyGameAnalysisMove(analysis, from, to);
  from.r = 0;
  to.c = 0;
  assert.deepEqual(moved.moves[0].from, { r: 9, c: 4 });
  assert.deepEqual(moved.moves[0].to, { r: 9, c: 5 });
  assert.throws(() => { moved.currentBoard[9][5].type = 'R'; }, TypeError);
  assert.throws(() => { moved.moves[0].from.r = 2; }, TypeError);
  assert.throws(() => { moved.repetitionHistory[0].check = true; }, TypeError);

  const external = structuredClone(moved.currentBoard);
  applyMove(external, { r: 4, c: 3 }, { r: 5, c: 3 });
  assert.deepEqual(moved.currentBoard[4][3], { type: 'R', side: RED });
});

test('fuzzes 128 deterministic legal analysis plies while preserving state invariants', () => {
  const source = checkmateRecord('analysis-fuzz');
  const original = structuredClone(source);
  let analysis = createGameAnalysis(source, 0);
  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let ply = 0; ply < 128; ply++) {
    if (analysis.terminal) analysis = createGameAnalysis(source, 0);
    const candidates = [];
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        if (analysis.currentBoard[r][c]?.side !== analysis.currentSide) continue;
        for (const to of legalMoves(analysis.currentBoard, r, c)) {
          candidates.push({ from: { r, c }, to });
        }
      }
    }
    assert.ok(candidates.length > 0, `legal candidates exist before deterministic ply ${ply + 1}`);
    const chosen = candidates[Math.floor(random() * candidates.length)];
    const before = analysis;
    analysis = applyGameAnalysisMove(analysis, chosen.from, chosen.to);
    assert.equal(analysis.moves.length, before.moves.length + 1);
    assert.equal(analysis.currentSide, before.currentSide === RED ? BLACK : RED);
    assert.equal(
      analysis.repetitionHistory.length,
      analysis.anchorRepetitionHistory.length + analysis.moves.length,
    );
    assert.deepEqual(analysis.moves.at(-1).from, chosen.from);
    assert.deepEqual(analysis.moves.at(-1).to, chosen.to);
    assert.ok(Object.isFrozen(analysis.currentBoard));
  }
  assert.deepEqual(source, original);
});
