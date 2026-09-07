import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hashBoard } from './game.js';
import { createGameRecord } from './game-record.js';
import { createGameReview, selectGameReviewPly } from './game-review.js';
import {
  createGameTeachingModeState,
  setGameTeachingModeEnabled,
  invalidateGameTeachingMode,
  beginGameTeachingModeAnalysis,
  settleGameTeachingModeAnalysis,
  gameTeachingModeMatchesHistory,
  shouldScheduleGameTeachingMode,
} from './game-teaching-mode.js';

const moduleSource = readFileSync(new URL('./game-teaching-mode.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const FORBIDDEN = /最佳著|失誤|這步不錯|這步不好|勝率|centipawn|score/i;

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function mateSource() {
  const board = emptyBoard();
  board[0][4] = { type: 'K', side: 'red' };
  board[2][3] = { type: 'R', side: 'red' };
  board[2][4] = { type: 'P', side: 'black' };
  board[4][1] = { type: 'N', side: 'black' };
  board[9][0] = { type: 'R', side: 'red' };
  board[9][4] = { type: 'K', side: 'black' };
  board[9][8] = { type: 'R', side: 'red' };
  return sourceFromBoard(board, { from: { r: 2, c: 3 }, to: { r: 2, c: 4 } });
}

function stalemateSource() {
  const board = emptyBoard();
  board[9][5] = { type: 'K', side: 'black' };
  board[0][5] = { type: 'K', side: 'red' };
  board[4][5] = { type: 'P', side: 'red' };
  board[7][5] = { type: 'N', side: 'red' };
  board[7][0] = { type: 'R', side: 'red' };
  return sourceFromBoard(board, { from: { r: 7, c: 0 }, to: { r: 8, c: 0 } }, 'stalemate-session');
}

function sourceFromBoard(board, playedMove, recordId = 'teaching-session') {
  return {
    recordId,
    movePly: 1,
    ply: 0,
    board,
    sideToMove: 'red',
    repetitionHistory: [{ key: `${hashBoard(board)}|red`, mover: null, check: false }],
    playedMove,
  };
}

function cycleRecord() {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: 'red' };
  board[4][3] = { type: 'R', side: 'red' };
  board[4][1] = { type: 'N', side: 'black' };
  board[9][4] = { type: 'K', side: 'black' };
  const cycle = [
    [{ r: 9, c: 4 }, { r: 9, c: 5 }],
    [{ r: 4, c: 3 }, { r: 5, c: 3 }],
    [{ r: 9, c: 5 }, { r: 9, c: 4 }],
    [{ r: 5, c: 3 }, { r: 4, c: 3 }],
  ];
  return createGameRecord({
    schemaVersion: 1,
    id: 'teaching-repetition',
    createdAt: '2026-09-07T01:00:00.000Z',
    completedAt: '2026-09-07T01:05:00.000Z',
    initialPosition: { board, sideToMove: 'black' },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    mode: 'medium',
    result: { winner: null, terminationReason: 'threefold-repetition' },
  });
}

function sourceFromReview(review) {
  return {
    recordId: review.record.id,
    movePly: review.selectedPly + 1,
    ply: review.selectedPly,
    board: review.snapshot.board,
    sideToMove: review.snapshot.sideToMove,
    repetitionHistory: review.snapshot.repetitionHistory,
    playedMove: review.record.moves[review.selectedPly],
  };
}

function enable(module = null) {
  const api = module ?? { createGameTeachingModeState, setGameTeachingModeEnabled };
  return api.setGameTeachingModeEnabled(api.createGameTeachingModeState(), true);
}

function responseFor(started, move, error = null) {
  return {
    kind: 'review-candidate',
    recordId: started.request.recordId,
    ply: started.request.ply,
    revision: started.request.revision,
    ...(error ? { error } : { result: { ...move, depth: 2 } }),
  };
}

function readyState(api, source = mateSource(), candidate = { from: { r: 2, c: 3 }, to: { r: 3, c: 3 } }) {
  const started = api.beginGameTeachingModeAnalysis(enable(api), source);
  const settled = api.settleGameTeachingModeAnalysis(started.state, responseFor(started, candidate));
  assert.equal(settled.accepted, true);
  return settled.state;
}

test('Teaching Mode defaults OFF and OFF schedules no local candidate analysis', () => {
  const state = createGameTeachingModeState();
  assert.equal(state.enabled, false);
  assert.equal(state.status, 'idle');
  const result = beginGameTeachingModeAnalysis(state, mateSource());
  assert.equal(result.scheduled, false);
  assert.equal(result.request, null);
  assert.equal(result.state, state);
});

test('only a human move in an active computer game is eligible', () => {
  const base = { enabled: true, normalGame: true, computerGame: true, computerSide: 'black' };
  assert.equal(shouldScheduleGameTeachingMode({ ...base, moverSide: 'red' }), true);
  assert.equal(shouldScheduleGameTeachingMode({ ...base, moverSide: 'black' }), false);
  assert.equal(shouldScheduleGameTeachingMode({ ...base, moverSide: 'red', computerGame: false }), false);
  assert.equal(shouldScheduleGameTeachingMode({ ...base, moverSide: 'red', enabled: false }), false);
});

test('Teaching Mode can be enabled without carrying stale feedback', () => {
  const enabled = setGameTeachingModeEnabled(createGameTeachingModeState(), true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.status, 'idle');
  assert.equal(enabled.message, null);
});

test('one human move schedules one R3A review-v1 request and preserves source identity', () => {
  const source = mateSource();
  const started = beginGameTeachingModeAnalysis(enable(), source);
  assert.equal(started.scheduled, true);
  assert.equal(started.request.kind, 'review-candidate');
  assert.equal(started.request.analysisPreset, 'review-v1');
  assert.equal(started.request.recordId, source.recordId);
  assert.equal(started.request.ply, source.ply);
  assert.equal(started.request.repetitionPrefix.at(-1).key, source.repetitionHistory.at(-1).key);
});

test('R3B evidence and the existing R3C-1 rule produce one concise teaching message', () => {
  const state = readyState({
    createGameTeachingModeState,
    setGameTeachingModeEnabled,
    beginGameTeachingModeAnalysis,
    settleGameTeachingModeAnalysis,
  });
  assert.equal(state.status, 'ready');
  assert.equal(state.message.ruleId, 'immediate-mate');
  assert.equal(state.message.source.recordId, 'teaching-session');
  assert.deepEqual(state.evidence.played.terminal, { winner: 'red', terminationReason: 'checkmate' });
  assert.doesNotMatch(`${state.message.title}${state.message.body}`, FORBIDDEN);
});

test('no applicable R3C-1 rule emits no teaching card and invents no quality claim', () => {
  const source = mateSource();
  const started = beginGameTeachingModeAnalysis(enable(), source);
  const settled = settleGameTeachingModeAnalysis(
    started.state,
    responseFor(started, source.playedMove),
  );
  assert.equal(settled.accepted, true);
  assert.equal(settled.state.message, null);
  assert.equal(settled.state.evidence.comparison.sameMove, true);
});

test('candidate failure is quiet and cannot block the already committed game flow', () => {
  const started = beginGameTeachingModeAnalysis(enable(), mateSource());
  let committedMoves = 1;
  const settled = settleGameTeachingModeAnalysis(
    started.state,
    responseFor(started, null, 'controlled failure'),
  );
  assert.equal(committedMoves, 1);
  assert.equal(settled.accepted, true);
  assert.equal(settled.state.status, 'idle');
  assert.equal(settled.state.message, null);
});

test('disable, new game, reset, undo and mode exit invalidate delayed results', () => {
  const started = beginGameTeachingModeAnalysis(enable(), mateSource());
  const late = responseFor(started, { from: { r: 2, c: 3 }, to: { r: 3, c: 3 } });
  const invalidated = invalidateGameTeachingMode(started.state);
  assert.equal(settleGameTeachingModeAnalysis(invalidated, late).accepted, false);
  const disabled = setGameTeachingModeEnabled(started.state, false);
  assert.equal(settleGameTeachingModeAnalysis(disabled, late).accepted, false);
  assert.equal(disabled.message, null);
  assert.equal(invalidated.message, null);
});

test('computer reply may follow the human move without creating or invalidating its card', () => {
  const state = readyState({
    createGameTeachingModeState,
    setGameTeachingModeEnabled,
    beginGameTeachingModeAnalysis,
    settleGameTeachingModeAnalysis,
  });
  const moves = [
    mateSource().playedMove,
    { from: { r: 9, c: 4 }, to: { r: 8, c: 4 } },
  ];
  assert.equal(gameTeachingModeMatchesHistory(state, 'teaching-session', moves), true);
  assert.equal(shouldScheduleGameTeachingMode({
    enabled: true, normalGame: true, computerGame: true, moverSide: 'black', computerSide: 'black',
  }), false);
});

test('undoing the taught human ply makes the result irrelevant', () => {
  const state = readyState({
    createGameTeachingModeState,
    setGameTeachingModeEnabled,
    beginGameTeachingModeAnalysis,
    settleGameTeachingModeAnalysis,
  });
  assert.equal(gameTeachingModeMatchesHistory(state, 'teaching-session', []), false);
  assert.equal(gameTeachingModeMatchesHistory(state, 'another-session', [mateSource().playedMove]), false);
});

test('terminal human moves retain canonical checkmate and stalemate facts', () => {
  const api = {
    createGameTeachingModeState,
    setGameTeachingModeEnabled,
    beginGameTeachingModeAnalysis,
    settleGameTeachingModeAnalysis,
  };
  const mate = readyState(api);
  assert.equal(mate.evidence.played.terminal.terminationReason, 'checkmate');
  const stalemate = stalemateSource();
  const same = readyState(api, stalemate, stalemate.playedMove);
  assert.equal(same.evidence.played.terminal.terminationReason, 'stalemate');
});

test('canonical repetition prefix survives the live Teaching Mode path', () => {
  const review = selectGameReviewPly(createGameReview(cycleRecord()), 7);
  const source = sourceFromReview(review);
  const state = readyState({
    createGameTeachingModeState,
    setGameTeachingModeEnabled,
    beginGameTeachingModeAnalysis,
    settleGameTeachingModeAnalysis,
  }, source, source.playedMove);
  assert.equal(state.evidence.played.terminal.terminationReason, 'threefold-repetition');
  assert.deepEqual(state.evidence.played.repetitionVerdict, { result: 'draw', reason: '三次重複局面' });
});

test('production integration schedules after normal AI flow and has no coach or network transport', () => {
  assert.match(mainSource, /maybeAIMove\(\);\s*if \(mover !== AI_SIDE\) requestGameTeachingModeAnalysis\(teachingSource\);/);
  assert.match(mainSource, /const teachingSource = captureTeachingModeSource\(from, to\);/);
  assert.match(mainSource, /invalidateTeachingModeFeedback\(\);\s*undoCount\+\+/);
  assert.doesNotMatch(moduleSource, /fetch\s*\(|XMLHttpRequest|WebSocket|review-coach|OpenAI|capabilities/i);
});

test('rapid lifecycle changes reject every delayed result from the prior revision', () => {
  const first = beginGameTeachingModeAnalysis(enable(), mateSource());
  const late = responseFor(first, { from: { r: 2, c: 3 }, to: { r: 3, c: 3 } });
  const changed = invalidateGameTeachingMode(
    setGameTeachingModeEnabled(
      invalidateGameTeachingMode(first.state),
      false,
    ),
  );
  assert.equal(settleGameTeachingModeAnalysis(changed, late).accepted, false);
  assert.equal(changed.message, null);
});

test('a thrown R3C-1 derivation remains advisory and clears feedback', async () => {
  const api = await importMutant('throwing teaching fixture', (source) => source.replace(
    'const [message] = deriveGameReviewTeaching(evidence);',
    "throw new Error('controlled teaching failure');",
  ));
  const started = api.beginGameTeachingModeAnalysis(enable(api), mateSource());
  const settled = api.settleGameTeachingModeAnalysis(
    started.state,
    responseFor(started, { from: { r: 2, c: 3 }, to: { r: 3, c: 3 } }),
  );
  assert.equal(settled.accepted, true);
  assert.equal(settled.state.status, 'idle');
  assert.equal(settled.state.message, null);
});

test('Teaching Mode is independent of opponent difficulty and move selection', () => {
  const easy = beginGameTeachingModeAnalysis(enable(), { ...mateSource(), opponentDifficulty: 'easy' });
  const hard = beginGameTeachingModeAnalysis(enable(), { ...mateSource(), opponentDifficulty: 'hard' });
  assert.deepEqual(easy.request, hard.request);
  assert.equal(easy.request.analysisPreset, 'review-v1');
  assert.doesNotMatch(moduleSource, /findBestMove|difficulty|\blevel\b/);
});

test('Teaching analysis does not mutate GameRecord, board or repetition history', () => {
  const record = cycleRecord();
  const review = selectGameReviewPly(createGameReview(record), 7);
  const source = sourceFromReview(review);
  const before = JSON.stringify({ record, source });
  readyState({
    createGameTeachingModeState,
    setGameTeachingModeEnabled,
    beginGameTeachingModeAnalysis,
    settleGameTeachingModeAnalysis,
  }, source, source.playedMove);
  assert.equal(JSON.stringify({ record, source }), before);
});

test('terminal handling remains ahead of advisory scheduling in the live move path', () => {
  const terminalBranch = mainSource.search(/if \(over\) \{\r?\n\s+finalizeNormalGameRecord\(endReason\);/);
  const opponentFlow = mainSource.indexOf('maybeAIMove();', terminalBranch);
  const teachingFlow = mainSource.indexOf('requestGameTeachingModeAnalysis(teachingSource);', opponentFlow);
  assert.ok(terminalBranch >= 0);
  assert.ok(opponentFlow > terminalBranch);
  assert.ok(teachingFlow > opponentFlow);
});

test('OFF and ON teaching paths make zero calls through network-capable globals', () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('network forbidden'); };
  try {
    beginGameTeachingModeAnalysis(createGameTeachingModeState(), mateSource());
    readyState({
      createGameTeachingModeState,
      setGameTeachingModeEnabled,
      beginGameTeachingModeAnalysis,
      settleGameTeachingModeAnalysis,
    });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function withAbsoluteImports(source) {
  return source.replace(/from '(.\/[^']+?\.js)(?:\?[^']*)?'/g, (_match, relative) => (
    `from '${new URL(relative, import.meta.url).href}'`
  ));
}

async function importMutant(label, transform) {
  const base = withAbsoluteImports(moduleSource);
  const mutant = transform(base);
  assert.notEqual(mutant, base, `${label}: mutant applies`);
  return import(`data:text/javascript;base64,${Buffer.from(`${mutant}\n// ${label}`).toString('base64')}`);
}

async function killed(label, transform, assertion) {
  const productionApi = await importMutant(`${label}-control`, (source) => `${source}\n`);
  await assertion(productionApi);
  const mutantApi = await importMutant(label, transform);
  await assert.rejects(() => assertion(mutantApi), undefined, `${label}: behavioral assertion kills mutant`);
}

test('all 10 Teaching Mode behavioral mutation gates apply, execute and are killed', async () => {
  const gates = [
    ['OFF still analyzes',
      (s) => s.replace('if (!state.enabled) return Object.freeze({ scheduled: false, state, request: null });', 'if (false) return Object.freeze({ scheduled: false, state, request: null });'),
      async (api) => assert.equal(api.beginGameTeachingModeAnalysis(api.createGameTeachingModeState(), mateSource()).scheduled, false)],
    ['computer move triggers teaching',
      (s) => s.replace('&& moverSide !== computerSide;', '&& true;'),
      async (api) => assert.equal(api.shouldScheduleGameTeachingMode({ enabled: true, normalGame: true, computerGame: true, moverSide: 'black', computerSide: 'black' }), false)],
    ['stale result renders after new game',
      (s) => s.replace('return emptyState(state.enabled, state.revision + 1);', 'return state;'),
      async (api) => assert.equal(api.invalidateGameTeachingMode(readyState(api)).message, null)],
    ['stale result renders after disable',
      (s) => s.replace("if (typeof enabled !== 'boolean') throw new TypeError('Teaching Mode enabled must be boolean.');", "if (typeof enabled !== 'boolean') throw new TypeError('Teaching Mode enabled must be boolean.');\n  if (enabled === false) return state;"),
      async (api) => { const state = api.setGameTeachingModeEnabled(readyState(api), false); assert.equal(state.enabled, false); assert.equal(state.message, null); }],
    ['stale result renders after undo',
      (s) => s.replace('return emptyState(state.enabled, state.revision + 1);', 'return state;'),
      async (api) => { const state = api.invalidateGameTeachingMode(readyState(api)); assert.equal(api.gameTeachingModeMatchesHistory(state, 'teaching-session', [mateSource().playedMove]), false); }],
    ['analysis failure blocks gameplay',
      (s) => s.replace("return Object.freeze({ accepted: true, state: emptyState(true, state.revision) });", "throw new Error('mutant blocks gameplay');"),
      async (api) => { const started = api.beginGameTeachingModeAnalysis(enable(api), mateSource()); const result = api.settleGameTeachingModeAnalysis(started.state, responseFor(started, null, 'fail')); assert.equal(result.accepted, true); }],
    ['candidate bypasses R3C-1 authority',
      (s) => s.replace('const [message] = deriveGameReviewTeaching(evidence);', "const message = { ruleId: 'mutant-bypass', title: 'invented', body: 'invented', source: {} };"),
      async (api) => { const state = readyState(api, mateSource(), mateSource().playedMove); assert.equal(state.message, null); }],
    ['unsupported quality claim synthesized',
      (s) => s.replace('const [message] = deriveGameReviewTeaching(evidence);', "const [canonicalMessage] = deriveGameReviewTeaching(evidence);\n    const message = canonicalMessage ? { ...canonicalMessage, title: '最佳著' } : canonicalMessage;"),
      async (api) => { const state = readyState(api); assert.doesNotMatch(`${state.message.title}${state.message.body}`, FORBIDDEN); }],
    ['Teaching Mode changes opponent difficulty',
      (s) => s.replace('export function beginGameTeachingModeAnalysis(state, source) {\n  requireState(state);', "export function beginGameTeachingModeAnalysis(state, source) {\n  requireState(state);\n  globalThis.__teachingDifficulty?.('hard');"),
      async (api) => { let difficulty = 'medium'; globalThis.__teachingDifficulty = (value) => { difficulty = value; }; try { api.beginGameTeachingModeAnalysis(enable(api), mateSource()); assert.equal(difficulty, 'medium'); } finally { delete globalThis.__teachingDifficulty; } }],
    ['Teaching Mode invokes network',
      (s) => s.replace('export function beginGameTeachingModeAnalysis(state, source) {\n  requireState(state);', 'export function beginGameTeachingModeAnalysis(state, source) {\n  requireState(state);\n  globalThis.__teachingNetwork?.();'),
      async (api) => { let requests = 0; globalThis.__teachingNetwork = () => { requests++; }; try { api.beginGameTeachingModeAnalysis(enable(api), mateSource()); assert.equal(requests, 0); } finally { delete globalThis.__teachingNetwork; } }],
  ];
  for (const [label, transform, assertion] of gates) await killed(label, transform, assertion);
  assert.equal(gates.length, 10);
});
