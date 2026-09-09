import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { RED, BLACK, hashBoard, applyMove } from './game.js';
import {
  createGameTeachingModeState,
  setGameTeachingModeEnabled,
  beginGameTeachingModeAnalysis,
  settleGameTeachingModeAnalysis,
  invalidateGameTeachingMode,
} from './game-teaching-mode.js';
import {
  GAME_RECORD_SCHEMA_VERSION,
  createGameRecord,
  createGameTimeline,
  replayGameTimeline,
} from './game-record.js';
import {
  createGameLiveReviewHandoff,
  consumeGameLiveReviewHandoff,
  createGameLiveReviewAnalysis,
} from './game-live-review-handoff.js';
import {
  firstGameReviewPly,
  lastGameReviewPly,
  nextGameReviewPly,
  previousGameReviewPly,
} from './game-review.js';
import { createGameAnalysisFromPosition } from './game-analysis.js';
import { createGameReviewPuzzleHandoff } from './game-review-puzzle-handoff.js';

const moduleSource = readFileSync(new URL('./game-live-review-handoff.js', import.meta.url), 'utf8');
const reviewSource = readFileSync(new URL('./game-review.js', import.meta.url), 'utf8');
const puzzleHandoffSource = readFileSync(new URL('./game-review-puzzle-handoff.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const htmlSource = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('./css/style.css', import.meta.url), 'utf8');

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function teachingBoard() {
  const board = emptyBoard();
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[4][1] = { type: 'N', side: BLACK };
  board[5][4] = { type: 'P', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  return board;
}

const PLAYED = Object.freeze({ from: Object.freeze({ r: 2, c: 3 }), to: Object.freeze({ r: 2, c: 4 }) });
const CANDIDATE = Object.freeze({ from: Object.freeze({ r: 2, c: 3 }), to: Object.freeze({ r: 3, c: 3 }) });
const COMPUTER_REPLY = Object.freeze({ from: Object.freeze({ r: 4, c: 1 }), to: Object.freeze({ r: 2, c: 2 }) });

function fixture() {
  const board = teachingBoard();
  const session = {
    id: 'live-teaching-session',
    createdAt: '2026-09-08T01:02:03.000Z',
    initialPosition: { board, sideToMove: RED },
    mode: 'medium',
  };
  const source = {
    recordId: session.id,
    movePly: 1,
    ply: 0,
    board,
    sideToMove: RED,
    repetitionHistory: [{ key: `${hashBoard(board)}|${RED}`, mover: null, check: false }],
    playedMove: PLAYED,
  };
  const enabled = setGameTeachingModeEnabled(createGameTeachingModeState(), true);
  const started = beginGameTeachingModeAnalysis(enabled, source);
  const settled = settleGameTeachingModeAnalysis(started.state, {
    kind: 'review-candidate',
    recordId: started.request.recordId,
    ply: started.request.ply,
    revision: started.request.revision,
    result: { ...CANDIDATE, depth: 2 },
  });
  assert.equal(settled.accepted, true);
  assert.equal(settled.state.status, 'ready');
  assert.ok(settled.state.message);
  return { teachingState: settled.state, session, history: [{ ...PLAYED, notation: '俥六平五' }] };
}

function computerFixture() {
  const board = teachingBoard();
  board[2][2] = { type: 'P', side: RED };
  const playedMove = { from: { r: 4, c: 1 }, to: { r: 2, c: 2 } };
  const candidateMove = { from: { r: 4, c: 1 }, to: { r: 3, c: 3 } };
  const session = {
    id: 'computer-move-session',
    createdAt: '2026-09-08T02:03:04.000Z',
    initialPosition: { board, sideToMove: BLACK },
    mode: 'medium',
  };
  const source = {
    recordId: session.id,
    movePly: 1,
    ply: 0,
    board,
    sideToMove: BLACK,
    repetitionHistory: [{ key: `${hashBoard(board)}|${BLACK}`, mover: null, check: false }],
    playedMove,
  };
  const enabled = setGameTeachingModeEnabled(createGameTeachingModeState(), true);
  const started = beginGameTeachingModeAnalysis(enabled, source);
  const settled = settleGameTeachingModeAnalysis(started.state, {
    kind: 'review-candidate',
    recordId: started.request.recordId,
    ply: started.request.ply,
    revision: started.request.revision,
    result: { ...candidateMove, depth: 2 },
  });
  assert.equal(settled.state.status, 'ready');
  assert.ok(settled.state.message);
  return { teachingState: settled.state, session, history: [playedMove] };
}

function clone(value) {
  return structuredClone(value);
}

function makeHandoff(values = fixture()) {
  const handoff = createGameLiveReviewHandoff(values);
  assert.ok(handoff);
  return { ...values, handoff };
}

function consume(values) {
  return consumeGameLiveReviewHandoff(values.handoff, values);
}

test('creates a minimal immutable non-GameRecord timeline with exact anchor and move identities', () => {
  const values = makeHandoff();
  const { handoff } = values;
  assert.equal(handoff.anchorPly, 0);
  assert.equal(handoff.movePly, 1);
  assert.equal(handoff.timeline.moves.length, 1);
  assert.equal(handoff.timeline.id, values.session.id);
  assert.equal(Object.hasOwn(handoff.timeline, 'schemaVersion'), false);
  assert.equal(Object.hasOwn(handoff.timeline, 'completedAt'), false);
  assert.equal(Object.hasOwn(handoff.timeline, 'result'), false);
  assert.ok(Object.isFrozen(handoff));
  assert.ok(Object.isFrozen(handoff.timeline.initialPosition.board[0]));
  assert.ok(Object.isFrozen(handoff.r3aState.request.board));
});

test('timeline replay shares canonical Xiangqi rules while allowing an unfinished final position', () => {
  const values = fixture();
  const timeline = createGameTimeline({
    id: values.session.id,
    createdAt: values.session.createdAt,
    initialPosition: values.session.initialPosition,
    moves: values.history.map(({ from, to }) => ({ from, to })),
    mode: values.session.mode,
  });
  const anchor = replayGameTimeline(timeline, 0);
  const moved = replayGameTimeline(timeline, 1);
  assert.deepEqual(anchor.board, values.teachingState.active.board);
  assert.equal(anchor.sideToMove, RED);
  assert.equal(moved.sideToMove, BLACK);
  assert.equal(moved.terminal, null);
  assert.throws(() => createGameTimeline({ ...timeline, result: null }), /exactly/);
});

test('consume opens Review at anchorPly and retains the taught movePly identity', () => {
  const values = makeHandoff();
  const result = consume(values);
  assert.equal(result.accepted, true);
  assert.equal(result.review.sourceKind, 'live-teaching');
  assert.equal(result.review.selectedPly, values.handoff.anchorPly);
  assert.equal(result.review.teachingTarget.movePly, values.handoff.movePly);
  assert.deepEqual(result.review.teachingTarget.move, PLAYED);
  assert.equal(result.review.teachingTarget.ruleId, values.teachingState.message.ruleId);
});

test('consume reuses the exact accepted R3A, R3B and R3C1 artifacts without reselection', () => {
  const values = makeHandoff();
  const result = consume(values);
  assert.deepEqual(result.r3aState, values.teachingState.r3aState);
  assert.deepEqual(result.evidence, values.teachingState.evidence);
  assert.deepEqual(result.message, values.teachingState.message);
  assert.equal(result.message.source.positionKey, result.review.teachingTarget.positionKey);
  assert.ok(Object.isFrozen(result.message));
});

test('a single appended computer reply preserves the handoff and its immutable minimal timeline', () => {
  const values = makeHandoff();
  const before = clone(values.handoff);
  values.history.push({ ...COMPUTER_REPLY, notation: '馬2進3' });
  const result = consume(values);
  assert.equal(result.accepted, true);
  assert.deepEqual(values.handoff, before);
  assert.equal(result.review.record.moves.length, 1);
});

test('a next human move invalidates even when the taught prefix still matches', () => {
  const values = makeHandoff();
  values.history.push(COMPUTER_REPLY, { from: { r: 6, c: 0 }, to: { r: 5, c: 0 } });
  assert.equal(consume(values).accepted, false);
});

test('new game, session, mode and position identity mismatches fail closed', () => {
  const values = makeHandoff();
  for (const session of [
    { ...values.session, id: 'new-session' },
    { ...values.session, mode: 'easy' },
    { ...values.session, initialPosition: { ...values.session.initialPosition, sideToMove: BLACK } },
  ]) {
    assert.equal(consume({ ...values, session }).accepted, false);
  }
});

test('undo, reset, disable and Teaching revision changes fail closed', () => {
  const values = makeHandoff();
  assert.equal(consume({ ...values, history: [] }).accepted, false);
  assert.equal(consume({ ...values, teachingState: invalidateGameTeachingMode(values.teachingState) }).accepted, false);
  assert.equal(consume({
    ...values,
    teachingState: setGameTeachingModeEnabled(values.teachingState, false),
  }).accepted, false);
});

test('same-length move replacement and moved target identity fail closed', () => {
  const values = makeHandoff();
  const changedHistory = [{ from: { r: 2, c: 3 }, to: { r: 3, c: 3 } }];
  assert.equal(consume({ ...values, history: changedHistory }).accepted, false);
  const changed = clone(values.handoff);
  changed.timeline.moves[0].to.r = 3;
  assert.equal(consume({ ...values, handoff: changed }).accepted, false);
});

test('record, anchor, move, position, revision and rule identities are independently revalidated', () => {
  const values = makeHandoff();
  const cases = [
    ['recordId', 'other'], ['anchorPly', 1], ['movePly', 2],
    ['positionKey', 'other|red'], ['teachingRevision', values.handoff.teachingRevision + 1],
  ];
  for (const [field, replacement] of cases) {
    assert.equal(consume({ ...values, handoff: { ...clone(values.handoff), [field]: replacement } }).accepted, false, field);
  }
  const message = clone(values.handoff);
  message.message.ruleId = 'different-rule';
  assert.equal(consume({ ...values, handoff: message }).accepted, false);
});

test('R3A request, R3B evidence and R3C1 source mismatches fail closed', () => {
  const values = makeHandoff();
  const r3a = clone(values.handoff);
  r3a.r3aState.request.ply++;
  assert.equal(consume({ ...values, handoff: r3a }).accepted, false);
  const r3b = clone(values.handoff);
  r3b.evidence.source.positionKey = 'wrong|red';
  assert.equal(consume({ ...values, handoff: r3b }).accepted, false);
  const r3c1 = clone(values.handoff);
  r3c1.message.source.r3aRevision++;
  assert.equal(consume({ ...values, handoff: r3c1 }).accepted, false);
});

test('OFF, loading, no-message and pvp states cannot create a handoff', () => {
  const values = fixture();
  assert.equal(createGameLiveReviewHandoff({
    ...values, teachingState: createGameTeachingModeState(),
  }), null);
  const loading = beginGameTeachingModeAnalysis(
    setGameTeachingModeEnabled(createGameTeachingModeState(), true),
    values.teachingState.active,
  ).state;
  assert.equal(createGameLiveReviewHandoff({ ...values, teachingState: loading }), null);
  assert.equal(createGameLiveReviewHandoff({
    ...values, teachingState: { ...values.teachingState, message: null },
  }), null);
  assert.throws(() => createGameLiveReviewHandoff({
    ...values, session: { ...values.session, mode: 'pvp' },
  }), /computer-game session/);
});

test('a computer-move Teaching-shaped result is independently rejected at handoff creation', () => {
  assert.throws(() => createGameLiveReviewHandoff(computerFixture()), /committed human move/);
});

test('Review navigation stays inside the immutable timeline and preserves target identity', () => {
  const review = consume(makeHandoff()).review;
  const last = lastGameReviewPly(review);
  assert.equal(last.selectedPly, 1);
  assert.equal(last.teachingTarget.movePly, 1);
  assert.equal(nextGameReviewPly(last).selectedPly, lastGameReviewPly(last).selectedPly);
  const first = firstGameReviewPly(last);
  assert.equal(first.selectedPly, 0);
  assert.equal(previousGameReviewPly(first).selectedPly, 0);
  assert.deepEqual(first.teachingTarget, review.teachingTarget);
});

test('Analysis starts from the Review anchor snapshot, never a later live board', () => {
  const values = makeHandoff();
  const review = consume(values).review;
  const laterBoard = clone(review.snapshot.board);
  applyMove(laterBoard, PLAYED.from, PLAYED.to);
  const analysis = createGameAnalysisFromPosition({
    sourceRecordId: review.record.id,
    sourcePly: review.selectedPly,
    board: review.snapshot.board,
    sideToMove: review.snapshot.sideToMove,
    repetitionHistory: review.snapshot.repetitionHistory,
  });
  assert.deepEqual(analysis.anchorBoard, review.snapshot.board);
  assert.notDeepEqual(analysis.anchorBoard, laterBoard);
  assert.equal(analysis.sourcePly, values.handoff.anchorPly);
  assert.deepEqual(createGameLiveReviewAnalysis(review).anchorBoard, review.snapshot.board);
});

test('P1-01 live Teaching Review Analysis preserves the canonical incomplete timeline at every edge ply', () => {
  const values = makeHandoff();
  const before = clone(values);
  const review = consume(values).review;
  const first = firstGameReviewPly(review);
  const last = lastGameReviewPly(review);
  const cases = [
    ['anchor/start', first, values.handoff.anchorPly],
    ['ply 1', last, 1],
    ['taught move', last, values.handoff.movePly],
    ['last available', last, review.totalPlies],
    ['incomplete-game last', last, review.totalPlies],
  ];

  for (const [label, selected, expectedPly] of cases) {
    const analysis = createGameLiveReviewAnalysis(selected);
    assert.equal(selected.selectedPly, expectedPly, `${label}: selected Review ply`);
    assert.equal(analysis.sourcePly, expectedPly, `${label}: Analysis source ply`);
    assert.equal(
      analysis.sourceRecord.moves.length,
      review.totalPlies,
      `${label}: renderable source progress uses the canonical timeline`,
    );
    assert.deepEqual(analysis.anchorBoard, selected.snapshot.board, `${label}: exact board`);
    assert.equal(analysis.anchorSideToMove, selected.snapshot.sideToMove, `${label}: exact side`);
    assert.deepEqual(
      analysis.anchorRepetitionHistory,
      selected.snapshot.repetitionHistory,
      `${label}: exact repetition prefix`,
    );
    assert.equal(Object.hasOwn(analysis.sourceRecord, 'result'), false, `${label}: no result fabricated`);
  }

  assert.deepEqual(values, before, 'Analysis initialization leaves the live game inputs unchanged');
});

test('Puzzle handoff starts from the same Review anchor snapshot', () => {
  const review = consume(makeHandoff()).review;
  const puzzle = createGameReviewPuzzleHandoff(review);
  assert.equal(puzzle.sourcePly, review.selectedPly);
  assert.deepEqual(puzzle.editorState.board, review.snapshot.board);
  assert.equal(puzzle.editorState.sideToMove, review.snapshot.sideToMove);
});

test('create and consume leave the live board, session, history and Teaching state unchanged', () => {
  const values = fixture();
  const before = clone(values);
  const handoff = createGameLiveReviewHandoff(values);
  const result = consumeGameLiveReviewHandoff(handoff, values);
  assert.equal(result.accepted, true);
  assert.deepEqual(values, before);
});

test('production seam exposes one bounded CTA while routing live Review consumers through snapshots', () => {
  assert.equal((htmlSource.match(/id="btnGameTeachingReview"/gu) || []).length, 1);
  assert.match(htmlSource, /<button id="btnGameTeachingReview" type="button"[^>]*>複盤這一步<\/button>/u);
  assert.match(mainSource, /gameTeachingReviewCtaReady/u);
  assert.match(mainSource, /consumeGameLiveReviewHandoff\(gameTeachingReviewHandoff/u);
  assert.match(mainSource, /openGameTeachingReviewHandoff\(btnGameTeachingReview\)/u);
  assert.match(mainSource, /move\.ply === review\.teachingTarget\?\.movePly/u);
  assert.match(cssSource, /\.game-review-teaching-move-marker/u);
  assert.match(mainSource, /openGameTeachingReviewHandoff/);
  assert.match(mainSource, /createGameLiveReviewAnalysis\(gameReviewSession\)/);
  assert.match(mainSource, /createGameReviewPuzzleHandoff\(gameReviewSession\)/);
  assert.doesNotMatch(moduleSource, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/);
});

test('focused contract: movePly is exactly anchorPly plus one', () => {
  const { handoff } = makeHandoff();
  assert.equal(handoff.movePly, handoff.anchorPly + 1);
});

test('focused reconstruction: anchor board is exact', () => {
  const values = makeHandoff();
  assert.deepEqual(consume(values).review.snapshot.board, values.teachingState.active.board);
});

test('focused reconstruction: target move is exact', () => {
  assert.deepEqual(consume(makeHandoff()).review.teachingTarget.move, PLAYED);
});

test('focused reconstruction: repetition prefix and side are exact', () => {
  const values = makeHandoff();
  const snapshot = consume(values).review.snapshot;
  assert.deepEqual(snapshot.repetitionHistory, values.teachingState.active.repetitionHistory);
  assert.equal(snapshot.sideToMove, values.teachingState.active.sideToMove);
});

test('focused stale guard: wrong session is rejected', () => {
  const values = makeHandoff();
  assert.equal(consume({ ...values, session: { ...values.session, id: 'wrong-session' } }).accepted, false);
});

test('focused stale guard: wrong position key is rejected', () => {
  const values = makeHandoff();
  assert.equal(consume({ ...values, handoff: { ...clone(values.handoff), positionKey: 'wrong|red' } }).accepted, false);
});

test('focused stale guard: wrong anchor ply is rejected', () => {
  const values = makeHandoff();
  assert.equal(consume({ ...values, handoff: { ...clone(values.handoff), anchorPly: 1 } }).accepted, false);
});

test('focused stale guard: wrong move ply is rejected', () => {
  const values = makeHandoff();
  assert.equal(consume({ ...values, handoff: { ...clone(values.handoff), movePly: 2 } }).accepted, false);
});

test('focused creation: a real no-rule R3C1 result creates no handoff', () => {
  const values = fixture();
  const enabled = setGameTeachingModeEnabled(createGameTeachingModeState(), true);
  const started = beginGameTeachingModeAnalysis(enabled, values.teachingState.active);
  const settled = settleGameTeachingModeAnalysis(started.state, {
    kind: 'review-candidate',
    recordId: started.request.recordId,
    ply: started.request.ply,
    revision: started.request.revision,
    result: { ...PLAYED, depth: 2 },
  });
  assert.equal(settled.state.message, null);
  assert.equal(createGameLiveReviewHandoff({ ...values, teachingState: settled.state }), null);
});

test('focused compatibility: persisted GameRecord v1 semantics remain unchanged', () => {
  const board = emptyBoard();
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[9][8] = { type: 'R', side: RED };
  const record = createGameRecord({
    schemaVersion: 1,
    id: 'v1-compatibility',
    createdAt: '2026-09-08T03:00:00.000Z',
    completedAt: '2026-09-08T03:01:00.000Z',
    initialPosition: { board, sideToMove: RED },
    moves: [PLAYED],
    mode: 'medium',
    result: { winner: RED, terminationReason: 'checkmate' },
  });
  assert.equal(GAME_RECORD_SCHEMA_VERSION, 1);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.result.terminationReason, 'checkmate');
});

function absoluteImports(source) {
  const urls = {
    'game.js': new URL('./game.js', import.meta.url).href,
    'game-record.js': new URL('./game-record.js', import.meta.url).href,
    'game-review.js': new URL('./game-review.js', import.meta.url).href,
    'game-analysis.js': new URL('./game-analysis.js', import.meta.url).href,
  };
  let rewritten = source;
  for (const [file, to] of Object.entries(urls)) {
    rewritten = rewritten.replace(new RegExp(`\\./${file.replace('.', '\\.') }\\?v=[a-f0-9]+`, 'g'), to);
  }
  return rewritten;
}

function replaceOnce(source, needle, replacement) {
  const normalized = source.replace(/\r\n/g, '\n');
  const count = normalized.split(needle).length - 1;
  assert.equal(count, 1, `mutation anchor must occur once: ${needle.slice(0, 50)}`);
  return normalized.replace(needle, replacement);
}

async function mutatedApi(transform, eol = '\n') {
  const transformed = transform(moduleSource.replace(/\r\n/g, '\n'));
  assert.notEqual(transformed, moduleSource.replace(/\r\n/g, '\n'), 'mutation applied');
  const executable = absoluteImports(transformed).replace(/\n/g, eol);
  return import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}#${Math.random()}`);
}

async function mutatedPuzzleApi(transform, eol = '\n') {
  const transformed = transform(puzzleHandoffSource.replace(/\r\n/g, '\n'));
  assert.notEqual(transformed, puzzleHandoffSource.replace(/\r\n/g, '\n'), 'puzzle mutation applied');
  const executable = transformed
    .replace(/\.\/puzzle-editor\.js\?v=[a-f0-9]+/g, new URL('./puzzle-editor.js', import.meta.url).href)
    .replace(/\n/g, eol);
  return import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}#${Math.random()}`);
}

async function mutatedReviewApi(transform, eol = '\n') {
  const transformed = transform(reviewSource.replace(/\r\n/g, '\n'));
  assert.notEqual(transformed, reviewSource.replace(/\r\n/g, '\n'), 'Review mutation applied');
  const executable = transformed
    .replace(/\.\/game-record\.js\?v=[a-f0-9]+/g, new URL('./game-record.js', import.meta.url).href)
    .replace(/\n/g, eol);
  return import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}#${Math.random()}`);
}

const MUTATIONS = [
  ['review-selected-at-move',
    (s) => replaceOnce(s, "return buildReview(canonicalTimeline, anchorPly, 'live-teaching', target);", "return buildReview(canonicalTimeline, movePly, 'live-teaching', target);"),
    async (api, values) => { const target = consume(values).review.teachingTarget; const review = api.createLiveGameReview(values.handoff.timeline, { anchorPly: 0, movePly: 1, teachingTarget: target }); assert.equal(review.selectedPly, 0); }],
  ['break-anchor-plus-one',
    (s) => replaceOnce(s, "|| movePly !== anchorPly + 1 || movePly > canonicalTimeline.moves.length", "|| false || movePly > canonicalTimeline.moves.length"),
    async (api, values) => { const timeline = createGameTimeline({ ...values.handoff.timeline, moves: [PLAYED, COMPUTER_REPLY] }); assert.throws(() => api.createLiveGameReview(timeline, { anchorPly: 0, movePly: 2, teachingTarget: { ...consume(values).review.teachingTarget, movePly: 2, move: COMPUTER_REPLY } })); }],
  ['skip-session-id',
    (s) => replaceOnce(
      replaceOnce(s, "if (source.recordId !== session.id || source.sideToMove !== RED", "if (false || source.sideToMove !== RED"),
      "if (timeline.id !== session.id || timeline.mode !== session.mode",
      "if (false || timeline.mode !== session.mode",
    ),
    async (api, values) => assert.equal(api.consumeGameLiveReviewHandoff(values.handoff, { ...values, session: { ...values.session, id: 'wrong' } }).accepted, false)],
  ['skip-position-key',
    (s) => replaceOnce(s, "if (handoff.positionKey !== anchor.repetitionHistory.at(-1).key)", "if (false)"),
    async (api, values) => assert.equal(api.consumeGameLiveReviewHandoff({ ...clone(values.handoff), positionKey: 'wrong|red' }, values).accepted, false)],
  ['accept-stale-history-revision',
    (s) => replaceOnce(
      replaceOnce(s, "if (history.length < handoff.movePly || history.length > handoff.movePly + 1)", "if (false)"),
      "if (createHistoryIdentity(history, handoff.movePly) !== handoff.historyIdentity)",
      "if (false)",
    ),
    async (api, values) => { values.history.push(COMPUTER_REPLY, { from: { r: 6, c: 0 }, to: { r: 5, c: 0 } }); assert.equal(api.consumeGameLiveReviewHandoff(values.handoff, values).accepted, false); }],
  ['substitute-latest-live-board',
    (s) => replaceOnce(s, "review,\n      r3aState: structuredClone(handoff.r3aState),", "review: globalThis.__t2aLatestBoard ? Object.freeze({ ...review, snapshot: Object.freeze({ ...review.snapshot, board: structuredClone(globalThis.__t2aLatestBoard) }) }) : review,\n      r3aState: structuredClone(handoff.r3aState),"),
    async (api, values) => { const latest = clone(values.teachingState.active.board); applyMove(latest, PLAYED.from, PLAYED.to); applyMove(latest, COMPUTER_REPLY.from, COMPUTER_REPLY.to); values.history.push(COMPUTER_REPLY); globalThis.__t2aLatestBoard = latest; try { const result = api.consumeGameLiveReviewHandoff(values.handoff, values); assert.deepEqual(result.review.snapshot.board, values.teachingState.active.board); } finally { delete globalThis.__t2aLatestBoard; } }],
  ['allow-computer-source',
    (s) => replaceOnce(s, "|| source.sideToMove !== RED", "|| false"),
    async (api) => assert.throws(() => api.createGameLiveReviewHandoff(computerFixture()), /committed human move/)],
  ['allow-off-state',
    (s) => replaceOnce(
      replaceOnce(s,
        "if (!teachingState?.enabled || teachingState.status",
        "if (false || teachingState.status"),
      "|| teachingState.enabled !== true",
      "|| false"),
    async (api, values) => assert.equal(api.createGameLiveReviewHandoff({ ...values, teachingState: { ...values.teachingState, enabled: false } }), null)],
  ['duplicate-r3a',
    (s) => replaceOnce(s, "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  try {", "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  globalThis.__t2aR3A?.();\n  try {"),
    async (api, values) => { let calls = 0; globalThis.__t2aR3A = () => calls++; try { api.consumeGameLiveReviewHandoff(values.handoff, values); assert.equal(calls, 0); } finally { delete globalThis.__t2aR3A; } }],
  ['mismatch-falls-back-to-reanalysis',
    (s) => replaceOnce(s, "} catch (error) {\n    if (!(error instanceof GameLiveReviewHandoffError))", "} catch (error) {\n    globalThis.__t2aFallbackReanalysis?.();\n    if (!(error instanceof GameLiveReviewHandoffError))"),
    async (api, values) => { let calls = 0; globalThis.__t2aFallbackReanalysis = () => calls++; try { api.consumeGameLiveReviewHandoff({ ...clone(values.handoff), positionKey: 'wrong|red' }, values); assert.equal(calls, 0); } finally { delete globalThis.__t2aFallbackReanalysis; } }],
  ['analysis-uses-live-board',
    (s) => replaceOnce(
      s,
      "board: review.snapshot.board,\n    sideToMove: review.snapshot.sideToMove,\n    repetitionHistory: review.snapshot.repetitionHistory,",
      "board: globalThis.__t2aAnalysisLiveSnapshot.board,\n    sideToMove: globalThis.__t2aAnalysisLiveSnapshot.sideToMove,\n    repetitionHistory: globalThis.__t2aAnalysisLiveSnapshot.repetitionHistory,"),
    async (api, values) => {
      const review = consume(values).review;
      const laterTimeline = createGameTimeline({
        ...values.handoff.timeline,
        moves: [PLAYED, COMPUTER_REPLY],
      });
      globalThis.__t2aAnalysisLiveSnapshot = replayGameTimeline(laterTimeline, 2);
      try {
        assert.deepEqual(api.createGameLiveReviewAnalysis(review).anchorBoard, review.snapshot.board);
      } finally {
        delete globalThis.__t2aAnalysisLiveSnapshot;
      }
    }],
  ['puzzle-uses-live-board',
    (s) => replaceOnce(s, "board: review.snapshot.board,", "board: globalThis.__t2aPuzzleLiveBoard,"),
    async (api, values) => { const review = consume(values).review; const latest = clone(review.snapshot.board); applyMove(latest, PLAYED.from, PLAYED.to); globalThis.__t2aPuzzleLiveBoard = latest; try { assert.deepEqual(api.createGameReviewPuzzleHandoff(review).editorState.board, review.snapshot.board); } finally { delete globalThis.__t2aPuzzleLiveBoard; } }],
  ['synthesize-completion',
    (s) => replaceOnce(s, "timeline: structuredClone(timeline),", "timeline: { ...structuredClone(timeline), completedAt: session.createdAt, result: null },"),
    async (api, values) => { const handoff = api.createGameLiveReviewHandoff(values); assert.equal(Object.hasOwn(handoff.timeline, 'completedAt'), false); assert.equal(Object.hasOwn(handoff.timeline, 'result'), false); }],
  ['write-storage',
    (s) => replaceOnce(s, "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  try {", "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  globalThis.__t2aStorage?.();\n  try {"),
    async (api, values) => { let writes = 0; globalThis.__t2aStorage = () => writes++; try { api.consumeGameLiveReviewHandoff(values.handoff, values); assert.equal(writes, 0); } finally { delete globalThis.__t2aStorage; } }],
  ['network-transport',
    (s) => replaceOnce(s, "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  try {", "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  globalThis.__t2aNetwork?.();\n  try {"),
    async (api, values) => { let sends = 0; globalThis.__t2aNetwork = () => sends++; try { api.consumeGameLiveReviewHandoff(values.handoff, values); assert.equal(sends, 0); } finally { delete globalThis.__t2aNetwork; } }],
  ['review-mutates-live-game',
    (s) => replaceOnce(s, "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  try {", "export function consumeGameLiveReviewHandoff(handoff, { teachingState, session, history }) {\n  globalThis.__t2aLiveState?.history.push('mutated');\n  try {"),
    async (api, values) => { const live = { history: [] }; globalThis.__t2aLiveState = live; try { api.consumeGameLiveReviewHandoff(values.handoff, values); assert.deepEqual(live.history, []); } finally { delete globalThis.__t2aLiveState; } }],
];

test('mutation injection is LF/CRLF neutral', async () => {
  for (const eol of ['\n', '\r\n']) {
    const api = await mutatedApi(MUTATIONS[8][1], eol);
    const values = makeHandoff();
    await assert.rejects(() => MUTATIONS[8][2](api, values));
  }
});

test('OFF mutant reaches the intended forbidden creation path and is killed behaviorally', async () => {
  const api = await mutatedApi(MUTATIONS[7][1]);
  const values = makeHandoff();
  const offValues = {
    ...values,
    teachingState: { ...values.teachingState, enabled: false },
  };
  let brokenHandoff;
  assert.doesNotThrow(() => {
    brokenHandoff = api.createGameLiveReviewHandoff(offValues);
  });
  assert.ok(brokenHandoff, 'mutant must create the forbidden OFF-state handoff');
  assert.equal(brokenHandoff.kind, 'live-teaching-review-handoff');
  let behavioralKill;
  try {
    assert.equal(brokenHandoff, null, 'healthy OFF behavior requires no handoff');
  } catch (error) {
    behavioralKill = error;
  }
  assert.equal(behavioralKill?.code, 'ERR_ASSERTION');
});

test('all 16 live handoff behavioral mutations apply, import, execute and are killed', async () => {
  let applied = 0;
  let imported = 0;
  let executed = 0;
  let killed = 0;
  for (const [name, transform, oracle] of MUTATIONS) {
    applied++;
    const api = name === 'puzzle-uses-live-board'
      ? await mutatedPuzzleApi(transform)
      : ['review-selected-at-move', 'break-anchor-plus-one'].includes(name)
        ? await mutatedReviewApi(transform)
        : await mutatedApi(transform);
    imported++;
    const values = makeHandoff();
    executed++;
    try {
      await oracle(api, values);
    } catch (error) {
      assert.equal(
        error?.code,
        'ERR_ASSERTION',
        `${name}: arbitrary production/import exceptions are not behavioral kills`,
      );
      killed++;
      continue;
    }
    assert.fail(`mutation survived: ${name}`);
  }
  assert.deepEqual(
    { applied, imported, executed, killed },
    { applied: MUTATIONS.length, imported: MUTATIONS.length, executed: MUTATIONS.length, killed: MUTATIONS.length },
  );
  assert.ok(MUTATIONS.length >= 16);
});
