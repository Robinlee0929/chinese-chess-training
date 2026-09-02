import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { RED, BLACK, initialBoard } from './game.js';
import { createGameRecord, replayGameRecord } from './game-record.js';
import { createGameRecordStore } from './game-record-store.js';
import {
  createGameReview,
  firstGameReviewPly,
  previousGameReviewPly,
  nextGameReviewPly,
  lastGameReviewPly,
  selectGameReviewPly,
  createGameRecordLibraryView,
} from './game-review.js';
import {
  createGameReviewAiState,
  invalidateGameReviewAiState,
  beginGameReviewAiRequest,
  settleGameReviewAiResponse,
} from './game-review-ai.js';
import { createGameReviewEvidence } from './game-review-evidence.js';
import { deriveGameReviewTeaching } from './game-review-teaching.js';
import {
  createDisabledCoachState,
  createIdleCoachState,
  createTeachingFingerprint,
  beginCoachRequest,
  settleCoachResponse,
  invalidateCoachState,
} from './game-review-coach.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./css/style.css', import.meta.url), 'utf8');
const R3B_FORBIDDEN_UI_TERMS = Object.freeze([
  '最佳著', '比較好', '比較差', '失誤', '大漏著', '白送', '掉子', '懸子',
  '優勢', '勝率', '評分', '評估值', '分數', 'score', 'evaluation', 'PV',
]);
const R3C_FORBIDDEN_UI_TERMS = Object.freeze([
  '完美', '最佳', '最好', '比較好', '比較差', '你走錯了', '失誤', '大錯',
  '大漏著', '漏吃', '白送', '掉子', '懸子', '一定會被吃', '賺子', '賺更多',
  '子力優勢', '優勢', '勝率', '評分', '評估值', '分數', 'score', 'evaluation', 'PV',
  '妙手', '牽制', '串擊', '必勝', '必敗',
]);

function functionSource(name) {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `main.js function ${name} exists`);
  return match[0];
}

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function record(id = 'record-a', completedMinute = 1) {
  const board = emptyBoard();
  board[0][4] = { type: 'K', side: RED };
  board[2][3] = { type: 'R', side: RED };
  board[2][4] = { type: 'P', side: BLACK };
  board[9][0] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  board[9][8] = { type: 'R', side: RED };
  return createGameRecord({
    schemaVersion: 1,
    id,
    createdAt: `2026-08-31T01:0${completedMinute - 1}:00.000Z`,
    completedAt: `2026-08-31T01:0${completedMinute}:00.000Z`,
    initialPosition: { board, sideToMove: RED },
    moves: [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }],
    mode: 'pvp',
    result: { winner: RED, terminationReason: 'checkmate' },
  });
}

function repetitionRecord(id = 'record-repetition') {
  const board = emptyBoard();
  board[0][0] = { type: 'K', side: RED };
  board[4][3] = { type: 'R', side: RED };
  board[9][4] = { type: 'K', side: BLACK };
  const cycle = [
    [{ r: 9, c: 4 }, { r: 9, c: 5 }],
    [{ r: 4, c: 3 }, { r: 5, c: 3 }],
    [{ r: 9, c: 5 }, { r: 9, c: 4 }],
    [{ r: 5, c: 3 }, { r: 4, c: 3 }],
  ];
  return createGameRecord({
    schemaVersion: 1,
    id,
    createdAt: '2026-08-31T02:00:00.000Z',
    completedAt: '2026-08-31T02:08:00.000Z',
    initialPosition: { board, sideToMove: BLACK },
    moves: [...cycle, ...cycle].map(([from, to]) => ({ from, to })),
    mode: 'hard',
    result: { winner: null, terminationReason: 'threefold-repetition' },
  });
}

function domNode(initiallyHidden = false, tagName = 'div') {
  const classes = new Set(initiallyHidden ? ['hidden'] : []);
  const attributes = new Map();
  const node = {
    tagName: tagName.toUpperCase(),
    children: [],
    dataset: {},
    disabled: false,
    scrollTop: 0,
    textContent: '',
    className: '',
    type: '',
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [...children];
    },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    querySelector(selector) {
      const matches = (candidate) => selector === '[aria-current="step"]'
        && candidate.getAttribute?.('aria-current') === 'step';
      const visit = (candidate) => {
        if (matches(candidate)) return candidate;
        for (const child of candidate.children || []) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
    },
    focusCalls: 0,
    focus() { this.focusCalls++; },
  };
  return node;
}

function vector() {
  return { set() {} };
}

function harness({
  records = [], serialized, readError, writeError, confirm = true,
  mode = 'pvp', turn = RED, realRenderer = false, rendererMutation = null,
  reviewAiMutation = null, teachingMutation = null, workerCreationError = false,
  coachEnabled = false, coachMutation = null,
} = {}) {
  let stored = serialized === undefined
    ? (records.length ? JSON.stringify({ version: 1, records }) : null)
    : serialized;
  let reads = 0;
  let writes = 0;
  const storage = {
    getItem() {
      reads++;
      if (readError) throw readError;
      return stored;
    },
    setItem(_key, value) {
      writes++;
      if (writeError) throw writeError;
      stored = value;
    },
    get reads() { return reads; },
    get writes() { return writes; },
    get serialized() { return stored; },
  };
  const gameRecordStore = createGameRecordStore({ storage });
  const coachRequests = [];
  let activeCoachRequests = 0;
  let maxActiveCoachRequests = 0;
  const gameReviewCoachRequester = coachEnabled ? (request, { signal }) => {
    const pending = {
      request: structuredClone(request),
      signal,
      active: true,
      resolve: null,
      reject: null,
    };
    activeCoachRequests++;
    maxActiveCoachRequests = Math.max(maxActiveCoachRequests, activeCoachRequests);
    const finish = () => {
      if (!pending.active) return false;
      pending.active = false;
      activeCoachRequests--;
      return true;
    };
    const promise = new Promise((resolve, reject) => {
      pending.resolve = (value) => { if (finish()) resolve(value); };
      pending.reject = (error = new Error('mock rejection')) => { if (finish()) reject(error); };
    });
    signal.addEventListener('abort', () => pending.reject(new Error('mock aborted')), { once: true });
    coachRequests.push(pending);
    return promise;
  } : null;
  const liveBoard = initialBoard();
  const reviewAiWorkers = [];
  class FakeReviewAiWorker {
    constructor() {
      this.messages = [];
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      reviewAiWorkers.push(this);
    }
    postMessage(message) {
      context.reviewAiRequestCount++;
      this.messages.push(structuredClone(message));
    }
    terminate() { this.terminated = true; }
    emit(data) { this.onmessage?.({ data }); }
    fail() { this.onerror?.({ preventDefault() {} }); }
  }
  const document = {
    activeElement: null,
    createElement: (tagName) => domNode(false, tagName),
  };
  const context = vm.createContext({
    RED, BLACK, structuredClone,
    APP_STATE: Object.freeze({
      NORMAL_GAME: 'NORMAL_GAME',
      GAME_RECORD_LIBRARY: 'GAME_RECORD_LIBRARY',
      GAME_REVIEW: 'GAME_REVIEW',
      GAME_ANALYSIS: 'GAME_ANALYSIS',
    }),
    appState: 'NORMAL_GAME',
    board: liveBoard,
    turn,
    history: [{ from: { r: 0, c: 1 }, to: { r: 2, c: 2 }, captured: null, nota: '傌八進七' }],
    posHistory: ['live-position-a', 'live-position-b'],
    repHistory: [{ key: 'live|red', mover: null, check: false }],
    capturedBy: { red: [{ side: BLACK, type: 'P' }], black: [] },
    over: false,
    winner: null,
    normalGameRecordSession: Object.freeze({
      id: 'live-session',
      createdAt: '2026-08-31T03:00:00.000Z',
      initialPosition: Object.freeze({ board: structuredClone(liveBoard), sideToMove: turn }),
      mode,
    }),
    lastCompletedGameRecord: records[0] || record('memory-only'),
    selected: { r: 0, c: 1 },
    legal: [{ r: 2, c: 0 }, { r: 2, c: 2 }],
    busy: false,
    mode,
    aiToken: 7,
    aiThinking: mode !== 'pvp' && turn === BLACK,
    aiMoveStart: 4321,
    aiWorker: Object.freeze({ kind: 'normal-worker' }),
    aiRequests: 0,
    aiMaybeMoveCalls: 0,
    tweens: [],
    gameReviewSession: null,
    gameReviewReturnState: 'NORMAL_GAME',
    gameReviewInvoker: null,
    gameReviewStored: false,
    gameReviewLivePresentation: null,
    gameAnalysisState: null,
    gameAnalysisSelected: null,
    gameAnalysisLegal: [],
    gameAnalysisNotice: '',
    gameReviewAiState: createGameReviewAiState(),
    gameReviewAiWorker: null,
    gameReviewEvidenceState: null,
    gameReviewCoachRequester,
    gameReviewCoachState: coachEnabled ? createIdleCoachState() : createDisabledCoachState(),
    gameReviewCoachRequest: null,
    gameReviewCoachRequestSequence: 0,
    gameReviewCoachStatusMessage: '',
    coachRequests,
    get activeCoachRequests() { return activeCoachRequests; },
    get maxActiveCoachRequests() { return maxActiveCoachRequests; },
    reviewAiWorkers,
    reviewAiRequestCount: 0,
    engineSearches: 0,
    gameRuleEvaluations: 0,
    gameRuleCallsByName: {},
    networkRequests: 0,
    renderedBoard: liveBoard,
    renderCount: 0,
    productionRenderCallCount: 0,
    reviewRenderBoards: [],
    liveRenderBoards: [],
    normalDoMoveCalls: 0,
    libraryView: null,
    puzzleWrites: 0,
    analyticsWrites: 0,
    messages: [],
    gameRecordStore,
    storage,
    createGameReview,
    firstGameReviewPly,
    previousGameReviewPly,
    nextGameReviewPly,
    lastGameReviewPly,
    selectGameReviewPly,
    invalidateGameReviewAiState,
    beginGameReviewAiRequest,
    settleGameReviewAiResponse,
    createGameReviewEvidence,
    deriveGameReviewTeaching,
    createTeachingFingerprint,
    createIdleCoachState,
    beginCoachRequest: (options) => beginCoachRequest({
      state: options.state,
      teachingMessage: options.teachingMessage,
      requestId: options.requestId,
    }),
    settleCoachResponse: (options) => settleCoachResponse({
      state: options.state,
      currentTeachingMessage: options.currentTeachingMessage,
      response: options.response,
    }),
    invalidateCoachState,
    AbortController,
    GAME_RECORD_MODE_LABELS: Object.freeze({
      pvp: '雙人對弈', easy: '人機・簡單', medium: '人機・中等', hard: '人機・困難',
    }),
    GAME_RECORD_REASON_LABELS: Object.freeze({
      checkmate: '將死',
      stalemate: '困斃',
      'perpetual-check': '長將判負',
      'threefold-repetition': '三次重複局面',
      'mutual-perpetual-check': '雙方長將',
    }),
    appEl: domNode(),
    gameRecordPanel: domNode(true),
    gameRecordLibraryView: domNode(),
    gameReviewView: domNode(true),
    gameAnalysisView: domNode(true),
    gameRecordLibraryHeading: domNode(),
    gameReviewHeading: domNode(),
    gameReviewMeta: domNode(),
    gameReviewStatus: domNode(),
    gameReviewMoveCount: domNode(),
    gameReviewMoveList: domNode(),
    btnReviewGame: domNode(),
    btnGameRecords: domNode(),
    btnGameReviewFirst: domNode(),
    btnGameReviewPrevious: domNode(),
    btnGameReviewNext: domNode(),
    btnGameReviewLast: domNode(),
    btnGameReviewAnalyze: domNode(),
    btnGameReviewAiAnalyze: domNode(),
    gameReviewAiPanel: domNode(true),
    gameReviewAiHeading: domNode(),
    gameReviewAiDetail: domNode(),
    gameReviewEvidence: domNode(true),
    gameReviewEvidencePlayed: domNode(),
    gameReviewEvidenceCandidate: domNode(),
    gameReviewEvidenceMatch: domNode(true),
    gameReviewEvidenceFactsSection: domNode(),
    gameReviewEvidenceFacts: domNode(),
    gameReviewTeaching: domNode(true),
    gameReviewCoachLeadIn: domNode(true),
    gameReviewTeachingTitle: domNode(),
    gameReviewTeachingBody: domNode(),
    gameReviewCoachEncouragement: domNode(true),
    btnGameReviewCoach: domNode(true, 'button'),
    gameReviewCoachStatus: domNode(),
    staleCoachState: null,
    btnGameReviewCreatePuzzle: domNode(),
    btnGameReviewBack: domNode(),
    btnGameReviewDelete: domNode(true),
    overlay: domNode(true),
    banner: domNode(true),
    lastFromMark: { visible: true, position: vector() },
    lastToMark: { visible: true, position: vector() },
    document,
    window: { confirm: () => confirm },
    normalGameActive: () => context.appState === 'NORMAL_GAME',
    gameRecordFlowActive: () => ['GAME_RECORD_LIBRARY', 'GAME_REVIEW', 'GAME_ANALYSIS'].includes(context.appState),
    clearSelection: () => { context.selected = null; context.legal = []; },
    clearGameAnalysisSelection: () => {
      context.gameAnalysisSelected = null;
      context.gameAnalysisLegal = [];
    },
    stopConfetti() {},
    rebuildPieceMeshes(board) {
      context.clearSelection();
      context.renderedBoard = structuredClone(board);
      if (context.appState === 'GAME_REVIEW') {
        context.productionRenderCallCount++;
        context.reviewRenderBoards.push(structuredClone(board));
      } else {
        context.liveRenderBoards.push(structuredClone(board));
      }
    },
    syncLastMoveMark() {
      context.lastFromMark.visible = context.lastToMark.visible = context.history.length > 0;
    },
    to3D: (r, c) => ({ x: c, z: r }),
    showMoveDots() {},
    ...(!realRenderer ? {
      renderGameReview() {
        context.renderCount++;
        context.renderedBoard = structuredClone(context.gameReviewSession.snapshot.board);
      },
    } : {}),
    renderGameRecordLibrary() {
      context.libraryView = createGameRecordLibraryView(context.gameRecordStore.loadAll());
      return context.libraryView;
    },
    refreshHUD() {},
    checkBoardMeshInvariant: () => ({ ok: true, errors: [] }),
    toast: (message) => context.messages.push(message),
    createGameReviewAiWorker: () => {
      if (workerCreationError) throw new Error('worker unavailable');
      return new FakeReviewAiWorker();
    },
    findBestMove() {
      context.engineSearches++;
      return null;
    },
    fetch() {
      context.networkRequests++;
      return Promise.resolve({ ok: true });
    },
    legalMoves() {
      context.gameRuleEvaluations++;
      context.gameRuleCallsByName.legalMoves = (context.gameRuleCallsByName.legalMoves || 0) + 1;
      return [];
    },
    applyMove(value) {
      context.gameRuleEvaluations++;
      context.gameRuleCallsByName.applyMove = (context.gameRuleCallsByName.applyMove || 0) + 1;
      return value;
    },
    inCheck() {
      context.gameRuleEvaluations++;
      context.gameRuleCallsByName.inCheck = (context.gameRuleCallsByName.inCheck || 0) + 1;
      return false;
    },
    repetitionVerdict() {
      context.gameRuleEvaluations++;
      context.gameRuleCallsByName.repetitionVerdict = (context.gameRuleCallsByName.repetitionVerdict || 0) + 1;
      return null;
    },
    notation() {
      context.gameRuleEvaluations++;
      context.gameRuleCallsByName.notation = (context.gameRuleCallsByName.notation || 0) + 1;
      return '測試記法';
    },
    doMove() { context.normalDoMoveCalls++; },
    maybeAIMove() {
      context.aiMaybeMoveCalls++;
      if (context.appState === 'NORMAL_GAME' && context.mode !== 'pvp'
        && !context.over && context.turn === BLACK && !context.aiThinking) {
        context.aiThinking = true;
        context.aiRequests++;
      }
    },
  });
  const names = [
    'currentGameReviewTeachingMessage', 'gameReviewCoachMatchesTeaching',
    'invalidateGameReviewCoach', 'renderGameReviewCoach',
    'finishGameReviewCoachFailure', 'handleGameReviewCoachResponse',
    'requestGameReviewCoach',
    'terminateGameReviewAiWorker', 'invalidateGameReviewAi',
    'gameReviewEvidenceTerminalText', 'gameReviewEvidenceFactTexts',
    'renderGameReviewTeaching', 'renderGameReviewEvidence', 'renderGameReviewAi',
    'handleGameReviewAiResponse', 'requestGameReviewAiCandidate',
    'pauseLiveGameForGameRecords', 'restoreLiveGamePresentation',
    'enterGameRecordLibrary', 'showGameRecordLibrary', 'openGameReview',
    'openLastCompletedGameReview', 'openStoredGameReview', 'navigateGameReview',
    'deleteGameRecordFromLibrary', 'exitGameReview', 'exitGameRecordFlow',
  ];
  // In realRenderer mode these are byte-identical production functions from main.js.
  // Only low-level DOM, mesh rebuilding, HUD, audio/confetti, and storage boundaries are doubled.
  const rendererHelpers = realRenderer ? [
    'gameRecordModeLabel', 'gameRecordResultLabel', 'formatGameRecordCompletedAt',
    'appendGameReviewMeta', 'syncGameReviewMoveMark', 'gameReviewAnnouncement',
  ].map(functionSource) : [];
  let rendererSource = realRenderer ? functionSource('renderGameReview') : '';
  const mutations = {
    board: 'board = structuredClone(review.snapshot.board);',
    turn: 'turn = review.snapshot.sideToMove;',
    history: 'history = [];',
    captured: 'capturedBy = { [RED]: [], [BLACK]: [] };',
  };
  if (rendererMutation) {
    assert.ok(mutations[rendererMutation], `known renderer mutation: ${rendererMutation}`);
    rendererSource = rendererSource.replace(
      'const review = gameReviewSession;',
      `const review = gameReviewSession;\n  ${mutations[rendererMutation]}`,
    );
  }
  const mainFunctions = names.map(functionSource);
  if (reviewAiMutation === 'doMove') {
    const index = names.indexOf('handleGameReviewAiResponse');
    mainFunctions[index] = mainFunctions[index].replace(
      'gameReviewAiState = settled.state;',
      'gameReviewAiState = settled.state;\n  doMove({ r: 0, c: 0 }, { r: 0, c: 1 });',
    );
  } else if (reviewAiMutation === 'storage') {
    const index = names.indexOf('handleGameReviewAiResponse');
    mainFunctions[index] = mainFunctions[index].replace(
      'gameReviewAiState = settled.state;',
      "gameReviewAiState = settled.state;\n  storage.setItem('r3b-forbidden', '1');",
    );
  } else if (reviewAiMutation === 'direct-search') {
    const index = names.indexOf('handleGameReviewAiResponse');
    mainFunctions[index] = mainFunctions[index].replace(
      '  renderGameReviewAi();',
      "  findBestMove(gameReviewSession.snapshot.board, gameReviewSession.snapshot.sideToMove, 'review-v1');\n  renderGameReviewAi();",
    );
  }
  if (teachingMutation === 'direct-rule') {
    const index = names.indexOf('renderGameReviewTeaching');
    mainFunctions[index] = mainFunctions[index].replace(
      '  const [message] = deriveGameReviewTeaching(evidence);',
      '  legalMoves(gameReviewSession.snapshot.board, 0, 0);\n  const [message] = deriveGameReviewTeaching(evidence);',
    );
  }
  if (coachMutation) {
    const replaceIn = (name, target, replacement) => {
      const index = names.indexOf(name);
      assert.notEqual(index, -1, `coach mutation function exists: ${name}`);
      const before = mainFunctions[index];
      mainFunctions[index] = before.replace(target, replacement);
      assert.notEqual(mainFunctions[index], before, `coach mutation applied: ${coachMutation}`);
    };
    if (coachMutation === 'auto-request') {
      replaceIn(
        'renderGameReviewTeaching',
        '  renderGameReviewCoach(message ?? null);',
        '  renderGameReviewCoach(message ?? null);\n  if (message) requestGameReviewCoach();',
      );
    } else if (coachMutation === 'duplicate') {
      replaceIn(
        'requestGameReviewCoach',
        '    state: gameReviewCoachState,',
        '    state: createIdleCoachState(gameReviewCoachState.revision),',
      );
      replaceIn(
        'requestGameReviewCoach',
        /\s*\|\| gameReviewCoachRequest\s*\|\| gameReviewCoachState\.status === 'loading'/,
        '',
      );
    } else if (coachMutation === 'remove-canonical-loading') {
      replaceIn(
        'renderGameReviewCoach',
        "  const framing = available && gameReviewCoachState.status === 'success'",
        "  if (loading) { gameReviewTeachingTitle.textContent = ''; gameReviewTeachingBody.textContent = ''; }\n  const framing = available && gameReviewCoachState.status === 'success'",
      );
    } else if (coachMutation === 'rewrite-canonical') {
      replaceIn(
        'handleGameReviewCoachResponse',
        '  gameReviewCoachRequest = null;',
        '  gameReviewTeachingTitle.textContent = response.framing.leadIn;\n  gameReviewTeachingBody.textContent = response.framing.encouragement;\n  gameReviewCoachRequest = null;',
      );
    } else if (coachMutation === 'accept-unvalidated') {
      replaceIn(
        'handleGameReviewCoachResponse',
        '  if (!settled.accepted) return finishGameReviewCoachFailure(activeRequest);',
        "  if (!settled.accepted) {\n    gameReviewCoachRequest = null;\n    gameReviewCoachState = Object.freeze({ ...gameReviewCoachState, status: 'success', framing: response.framing });\n    renderGameReviewCoach(message);\n    return true;\n  }",
      );
    } else if (coachMutation === 'real-network') {
      replaceIn(
        'requestGameReviewCoach',
        '    pending = gameReviewCoachRequester(started.request, { signal: controller.signal });',
        "    fetch('coach-test');\n    pending = gameReviewCoachRequester(started.request, { signal: controller.signal });",
      );
    } else if (coachMutation === 'storage-write') {
      replaceIn(
        'requestGameReviewCoach',
        '    pending = gameReviewCoachRequester(started.request, { signal: controller.signal });',
        "    storage.setItem('coach-test', '1');\n    pending = gameReviewCoachRequester(started.request, { signal: controller.signal });",
      );
    } else if (coachMutation === 'engine-call') {
      replaceIn(
        'requestGameReviewCoach',
        '    pending = gameReviewCoachRequester(started.request, { signal: controller.signal });',
        "    findBestMove(); legalMoves();\n    pending = gameReviewCoachRequester(started.request, { signal: controller.signal });",
      );
    } else {
      assert.fail(`unknown coach mutation: ${coachMutation}`);
    }
  }
  vm.runInContext([...rendererHelpers, rendererSource, ...mainFunctions].filter(Boolean).join('\n'), context);
  return context;
}

const clone = (value) => structuredClone(value);
function liveSnapshot(ctx) {
  return clone({
    board: ctx.board,
    turn: ctx.turn,
    history: ctx.history,
    posHistory: ctx.posHistory,
    repHistory: ctx.repHistory,
    capturedBy: ctx.capturedBy,
    over: ctx.over,
    winner: ctx.winner,
    normalGameRecordSession: ctx.normalGameRecordSession,
    lastCompletedGameRecord: ctx.lastCompletedGameRecord,
    mode: ctx.mode,
  });
}

function assertLiveStateUnchanged(ctx, before, stage) {
  const after = liveSnapshot(ctx);
  assert.deepEqual(after.board, before.board, `LIVE_BOARD_UNCHANGED after ${stage}`);
  assert.equal(after.turn, before.turn, `LIVE_TURN_UNCHANGED after ${stage}`);
  assert.deepEqual(after.history, before.history, `LIVE_HISTORY_UNCHANGED after ${stage}`);
  assert.deepEqual(after.posHistory, before.posHistory, `LIVE_POS_HISTORY_UNCHANGED after ${stage}`);
  assert.deepEqual(after.repHistory, before.repHistory, `LIVE_REP_HISTORY_UNCHANGED after ${stage}`);
  assert.deepEqual(after.capturedBy, before.capturedBy, `LIVE_CAPTURED_STATE_UNCHANGED after ${stage}`);
  assert.equal(after.over, before.over, `LIVE_RESULT_UNCHANGED after ${stage}: over`);
  assert.equal(after.winner, before.winner, `LIVE_RESULT_UNCHANGED after ${stage}: winner`);
  assert.deepEqual(
    after.normalGameRecordSession,
    before.normalGameRecordSession,
    `LIVE_SESSION_ID_UNCHANGED after ${stage}`,
  );
  assert.deepEqual(
    after.lastCompletedGameRecord,
    before.lastCompletedGameRecord,
    `LAST_COMPLETED_GAME_RECORD_UNCHANGED after ${stage}`,
  );
  assert.equal(after.mode, before.mode, `LIVE_MODE_UNCHANGED after ${stage}`);
}

function reviewAiIsolationSnapshot(ctx) {
  return clone({
    live: liveSnapshot(ctx),
    aiToken: ctx.aiToken,
    aiThinking: ctx.aiThinking,
    aiMoveStart: ctx.aiMoveStart,
    aiRequests: ctx.aiRequests,
    aiMaybeMoveCalls: ctx.aiMaybeMoveCalls,
    normalDoMoveCalls: ctx.normalDoMoveCalls,
    storageWrites: ctx.storage.writes,
    puzzleWrites: ctx.puzzleWrites,
    analyticsWrites: ctx.analyticsWrites,
  });
}

function successfulReviewAiResponse(worker, result = {}) {
  const request = worker.messages[0];
  return {
    kind: 'review-candidate',
    recordId: request.recordId,
    ply: request.ply,
    revision: request.revision,
    result: {
      from: { r: 2, c: 3 },
      to: { r: 2, c: 4 },
      depth: 2,
      score: 99998,
      pv: ['must-not-surface'],
      ...result,
    },
  };
}

function renderedR3bText(ctx) {
  return [
    ctx.gameReviewAiHeading.textContent,
    ctx.gameReviewAiDetail.textContent,
    ctx.gameReviewEvidencePlayed.textContent,
    ctx.gameReviewEvidenceCandidate.textContent,
    ctx.gameReviewEvidenceMatch.textContent,
    ...ctx.gameReviewEvidenceFacts.children.map((item) => item.textContent),
  ].filter(Boolean).join('\n');
}

function renderedR3cText(ctx) {
  return [ctx.gameReviewTeachingTitle.textContent, ctx.gameReviewTeachingBody.textContent]
    .filter(Boolean).join('\n');
}

function syntheticTeachingEvidence(base, kind) {
  const fixture = clone(base);
  for (const outcome of [fixture.played, fixture.candidate]) {
    outcome.terminal = null;
    outcome.repetitionVerdict = null;
    outcome.legalReplyCount = 2;
    outcome.movedPieceCaptureReplies = [];
    outcome.givesCheck = false;
    outcome.capture = null;
  }
  if (kind === 'candidate-mate') {
    fixture.candidate.terminal = { winner: RED, terminationReason: 'checkmate' };
    fixture.candidate.legalReplyCount = null;
    fixture.candidate.movedPieceCaptureReplies = null;
    fixture.candidate.givesCheck = true;
  } else if (kind === 'candidate-check') {
    fixture.candidate.givesCheck = true;
  } else if (kind === 'candidate-capture') {
    fixture.candidate.capture = { side: BLACK, type: 'P', name: '卒' };
  } else if (kind !== 'none') {
    throw new TypeError(`Unknown synthetic teaching fixture: ${kind}`);
  }
  return fixture;
}

function prepareEligibleCoach(ctx, id = 'review-coach-ui') {
  const saved = record(id);
  if (!ctx.gameRecordStore.getGameRecord(id)) ctx.gameRecordStore.saveGameRecord(saved);
  assert.equal(ctx.openStoredGameReview(id, ctx.btnGameRecords), true);
  assert.equal(ctx.navigateGameReview(0), true);
  assert.equal(ctx.requestGameReviewAiCandidate(), true);
  const worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker, { to: { r: 3, c: 3 } }));
  assert.equal(ctx.gameReviewEvidenceState.comparison.status, 'DIFFERENT');
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), false);
  return {
    saved,
    title: ctx.gameReviewTeachingTitle.textContent,
    body: ctx.gameReviewTeachingBody.textContent,
  };
}

function validCoachResponse(pending, overrides = {}) {
  return {
    version: pending.request.version,
    requestId: pending.request.requestId,
    sourceRuleId: pending.request.sourceRuleId,
    style: pending.request.style,
    framing: {
      leadIn: '可以一起看看這個地方。',
      encouragement: '下次也可以先停一下想想。',
    },
    ...overrides,
  };
}

async function flushCoachSettlement() {
  await Promise.resolve();
  await Promise.resolve();
}

function assertFactualR3bLanguage(text, label = 'R3B user-visible text') {
  for (const term of R3B_FORBIDDEN_UI_TERMS) {
    assert.equal(text.toLowerCase().includes(term.toLowerCase()), false,
      `${label} must not contain forbidden term: ${term}`);
  }
}

test('just-completed in-memory record opens at the final board with zero persistence writes', () => {
  const completed = record('just-completed');
  const ctx = harness({ records: [], realRenderer: true });
  ctx.lastCompletedGameRecord = completed;
  ctx.board = clone(replayGameRecord(completed, completed.moves.length).board);
  ctx.over = true;
  ctx.winner = RED;
  const before = liveSnapshot(ctx);
  assert.equal(ctx.openLastCompletedGameReview(ctx.btnReviewGame), true);
  assert.equal(ctx.appState, 'GAME_REVIEW');
  assert.equal(ctx.gameReviewSession.selectedPly, completed.moves.length);
  assert.equal(ctx.btnGameReviewAnalyze.disabled, true);
  assert.deepEqual(ctx.renderedBoard, before.board);
  assert.equal(ctx.productionRenderCallCount, 1);
  assertLiveStateUnchanged(ctx, before, 'just-completed final render');
  assert.equal(ctx.navigateGameReview('previous'), true);
  assert.equal(ctx.btnGameReviewAnalyze.disabled, false);
  assert.equal(ctx.productionRenderCallCount, 2);
  assert.deepEqual(ctx.renderedBoard, replayGameRecord(completed, 0).board);
  assertLiveStateUnchanged(ctx, before, 'just-completed previous render');
  assert.equal(ctx.navigateGameReview('last'), true);
  assert.equal(ctx.productionRenderCallCount, 3);
  assert.deepEqual(ctx.renderedBoard, before.board);
  assertLiveStateUnchanged(ctx, before, 'just-completed final rerender');
  assert.equal(ctx.storage.writes, 0);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assertLiveStateUnchanged(ctx, before, 'just-completed review exit');
});

test('production renderGameReview keeps a different live game immutable across every navigation route', () => {
  const saved = repetitionRecord('production-renderer-a');
  const ctx = harness({ records: [saved], mode: 'hard', turn: RED, realRenderer: true });
  assert.equal(
    ctx.renderGameReview.toString(),
    functionSource('renderGameReview'),
    'critical regression executes the byte-identical production renderer function',
  );
  const before = liveSnapshot(ctx);
  const selectedBefore = clone(ctx.selected);
  const legalBefore = clone(ctx.legal);
  const tokenBefore = ctx.aiToken;

  const assertReviewRender = (ply, expectedCallCount, stage) => {
    const expected = replayGameRecord(saved, ply);
    assert.equal(ctx.gameReviewSession.selectedPly, ply, `selected ply after ${stage}`);
    assert.equal(ctx.productionRenderCallCount, expectedCallCount, `real render count after ${stage}`);
    assert.deepEqual(ctx.reviewRenderBoards.at(-1), expected.board, `review snapshot rendered after ${stage}`);
    assert.deepEqual(ctx.renderedBoard, expected.board, `visible board after ${stage}`);
    assert.notDeepEqual(ctx.renderedBoard, before.board, `review board differs from live board after ${stage}`);
    assertLiveStateUnchanged(ctx, before, stage);
    const selectedMove = ctx.gameReviewMoveList.querySelector('[aria-current="step"]');
    assert.equal(selectedMove?.dataset.reviewPly ?? null, ply === 0 ? null : String(ply));
    assert.match(ctx.gameReviewStatus.textContent, new RegExp(`第 ${ply} / ${saved.moves.length} 著`));
    assert.equal(ctx.btnGameReviewFirst.disabled, ply === 0);
    assert.equal(ctx.btnGameReviewPrevious.disabled, ply === 0);
    assert.equal(ctx.btnGameReviewNext.disabled, ply === saved.moves.length);
    assert.equal(ctx.btnGameReviewLast.disabled, ply === saved.moves.length);
    assert.equal(ctx.storage.writes, 0);
    assert.equal(ctx.normalDoMoveCalls, 0);
    assert.equal(ctx.aiRequests, 0);
    assert.equal(ctx.aiMaybeMoveCalls, 0);
    assert.equal(ctx.puzzleWrites, 0);
    assert.equal(ctx.analyticsWrites, 0);
  };

  assert.equal(ctx.enterGameRecordLibrary(ctx.btnGameRecords), true);
  assert.equal(ctx.aiToken, tokenBefore + 1, 'entry invalidates pending live AI work');
  assert.equal(ctx.openStoredGameReview(saved.id), true);
  assertReviewRender(8, 1, 'open final');
  assert.equal(ctx.navigateGameReview('previous'), true);
  assertReviewRender(7, 2, 'previous');
  assert.notDeepEqual(ctx.reviewRenderBoards[0], ctx.reviewRenderBoards[1], 'selected ply changes review rendering');
  assert.equal(ctx.navigateGameReview('first'), true);
  assertReviewRender(0, 3, 'first');
  assert.equal(ctx.navigateGameReview('next'), true);
  assertReviewRender(1, 4, 'next');
  assert.equal(ctx.navigateGameReview(5), true);
  assertReviewRender(5, 5, 'direct jump');
  assert.equal(ctx.navigateGameReview('last'), true);
  assertReviewRender(8, 6, 'last');

  ctx.exitGameReview();
  assert.equal(ctx.appState, 'GAME_RECORD_LIBRARY');
  assert.equal(ctx.productionRenderCallCount, 6, 'exit does not rerun the review renderer');
  assert.deepEqual(ctx.renderedBoard, before.board, 'library exit renders the preserved live board');
  assertLiveStateUnchanged(ctx, before, 'return to record library');
  ctx.exitGameRecordFlow();
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assert.deepEqual(ctx.renderedBoard, before.board, 'normal-game exit renders the preserved live board');
  assertLiveStateUnchanged(ctx, before, 'return to normal game');
  assert.deepEqual(clone(ctx.selected), selectedBefore, 'live selection restored');
  assert.deepEqual(clone(ctx.legal), legalBefore, 'live legal moves restored');
  assert.equal(ctx.storage.writes, 0);
  assert.equal(ctx.normalDoMoveCalls, 0);
  assert.equal(ctx.aiRequests, 0);
  assert.equal(ctx.aiMaybeMoveCalls, 1, 'exit invokes only the normal resume check');
});

test('production-renderer negative controls detect forbidden live-state assignments', () => {
  const saved = repetitionRecord('production-renderer-negative');
  const mutations = [
    ['board', 'LIVE_BOARD_UNCHANGED'],
    ['turn', 'LIVE_TURN_UNCHANGED'],
    ['history', 'LIVE_HISTORY_UNCHANGED'],
    ['captured', 'LIVE_CAPTURED_STATE_UNCHANGED'],
  ];
  for (const [rendererMutation, expectedFailure] of mutations) {
    const ctx = harness({ records: [saved], realRenderer: true, rendererMutation });
    const before = liveSnapshot(ctx);
    assert.equal(ctx.enterGameRecordLibrary(), true);
    assert.equal(ctx.openStoredGameReview(saved.id), true);
    let detected = null;
    try {
      assertLiveStateUnchanged(ctx, before, `${rendererMutation} negative control`);
    } catch (error) {
      detected = error;
    }
    assert.equal(detected?.code, 'ERR_ASSERTION', `${rendererMutation} mutation must fail an assertion`);
    assert.match(detected.message, new RegExp(expectedFailure));
    assert.equal(ctx.productionRenderCallCount, 1, 'negative control still executes the real renderer');
    assert.deepEqual(
      ctx.reviewRenderBoards.at(-1),
      replayGameRecord(saved, saved.moves.length).board,
      'negative control failure is not caused by an invalid renderer fixture',
    );
  }
});

test('save failure does not prevent last-completed review', () => {
  const ctx = harness({ writeError: new Error('quota') });
  const completed = record('memory-after-failure');
  ctx.lastCompletedGameRecord = completed;
  assert.equal(ctx.openLastCompletedGameReview(), true);
  assert.equal(ctx.gameReviewSession.record.id, 'memory-after-failure');
  assert.equal(ctx.gameReviewSession.atLast, true);
  assert.equal(ctx.storage.writes, 0);
});

test('historical review navigation and exit preserve a different live game exactly', () => {
  const saved = record('saved-a');
  const ctx = harness({ records: [saved] });
  const before = liveSnapshot(ctx);
  const selectedBefore = clone(ctx.selected);
  const legalBefore = clone(ctx.legal);
  const tokenBefore = ctx.aiToken;
  assert.equal(ctx.enterGameRecordLibrary(ctx.btnReviewGame), true);
  assert.equal(ctx.openStoredGameReview(saved.id), true);
  assert.equal(ctx.navigateGameReview('first'), true);
  assert.equal(ctx.navigateGameReview('next'), true);
  assert.equal(ctx.navigateGameReview('last'), true);
  assert.equal(ctx.storage.writes, 0);
  assert.equal(ctx.puzzleWrites, 0);
  assert.equal(ctx.analyticsWrites, 0);
  assert.deepEqual(liveSnapshot(ctx), before);
  assert.equal(ctx.aiToken, tokenBefore + 1, 'entry invalidates stale live AI only once');
  ctx.exitGameReview();
  assert.equal(ctx.appState, 'GAME_RECORD_LIBRARY');
  assert.deepEqual(ctx.renderedBoard, before.board);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assert.deepEqual(liveSnapshot(ctx), before);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.selected)), selectedBefore);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.legal)), legalBefore);
  assert.equal(ctx.storage.writes, 0);
});

test('review entry and navigation never start AI; exit resumes one legitimate request', () => {
  const saved = record('saved-ai');
  const ctx = harness({ records: [saved], mode: 'hard', turn: BLACK });
  const staleToken = ctx.aiToken;
  assert.equal(ctx.enterGameRecordLibrary(), true);
  assert.equal(ctx.aiToken, staleToken + 1);
  assert.equal(ctx.aiThinking, false);
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  ctx.navigateGameReview('last');
  assert.equal(ctx.aiRequests, 0);
  assert.equal(ctx.aiMaybeMoveCalls, 0);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.aiMaybeMoveCalls, 1);
  assert.equal(ctx.aiRequests, 1);
});

test('deleting an open saved record preserves its immutable review and never resaves it', () => {
  const saved = record('delete-open');
  const other = record('keep-other', 2);
  const ctx = harness({ records: [saved, other] });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  const reviewBefore = ctx.gameReviewSession;
  assert.equal(ctx.deleteGameRecordFromLibrary(saved.id), true);
  assert.equal(ctx.storage.writes, 1);
  assert.equal(ctx.gameReviewSession, reviewBefore);
  assert.equal(ctx.gameReviewStored, false);
  assert.equal(ctx.navigateGameReview('first'), true);
  assert.equal(ctx.gameRecordStore.getGameRecord(saved.id), null);
  assert.equal(ctx.gameRecordStore.getGameRecord(other.id).id, other.id);
  ctx.exitGameRecordFlow();
  assert.equal(ctx.storage.writes, 1);
});

test('delete cancellation and write failure are non-destructive and leave review usable', () => {
  const saved = record('delete-safe');
  const cancelled = harness({ records: [saved], confirm: false });
  cancelled.enterGameRecordLibrary();
  cancelled.openStoredGameReview(saved.id);
  assert.equal(cancelled.deleteGameRecordFromLibrary(saved.id), false);
  assert.equal(cancelled.storage.writes, 0);
  assert.equal(cancelled.gameReviewSession.record.id, saved.id);

  const failed = harness({ records: [saved], writeError: new Error('quota') });
  const serializedBefore = failed.storage.serialized;
  failed.enterGameRecordLibrary();
  failed.openStoredGameReview(saved.id);
  assert.equal(failed.deleteGameRecordFromLibrary(saved.id), false);
  assert.equal(failed.storage.writes, 1);
  assert.equal(failed.storage.serialized, serializedBefore);
  assert.equal(failed.navigateGameReview('first'), true);
  assert.equal(failed.gameReviewSession.record.id, saved.id);
});

test('empty, multiple, corrupt and read-failed library loads never rewrite storage', () => {
  const empty = harness();
  empty.enterGameRecordLibrary();
  assert.equal(empty.libraryView.status, 'empty');
  assert.equal(empty.storage.writes, 0);

  const multiple = harness({ records: [record('a'), record('b', 2)] });
  multiple.enterGameRecordLibrary();
  assert.equal(multiple.libraryView.status, 'ready');
  assert.deepEqual(multiple.libraryView.records.map(({ id }) => id), ['a', 'b']);
  assert.equal(multiple.storage.writes, 0);

  const corrupt = harness({ serialized: '{broken' });
  corrupt.enterGameRecordLibrary();
  assert.equal(corrupt.libraryView.status, 'warning');
  assert.equal(corrupt.storage.writes, 0);

  const unavailable = harness({ readError: new Error('blocked') });
  unavailable.enterGameRecordLibrary();
  assert.equal(unavailable.libraryView.status, 'unavailable');
  assert.equal(unavailable.storage.writes, 0);
  unavailable.exitGameRecordFlow();
  assert.equal(unavailable.appState, 'NORMAL_GAME');
});

test('explicit Review AI request uses only canonical Review context and renders one inert score-free candidate', () => {
  const saved = record('review-ai-lifecycle');
  const originalRecord = clone(saved);
  const ctx = harness({ records: [saved], mode: 'medium', turn: BLACK, realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  const review = ctx.gameReviewSession;
  const before = reviewAiIsolationSnapshot(ctx);
  const normalWorker = ctx.aiWorker;

  assert.equal(ctx.reviewAiWorkers.length, 0, 'analysis is explicit, never automatic on Review render/navigation');
  assert.equal(ctx.gameReviewEvidenceState, null, 'evidence is absent before R3A success');
  assert.equal(ctx.requestGameReviewAiCandidate(), true);
  assert.equal(ctx.gameReviewAiState.status, 'loading');
  assert.equal(ctx.gameReviewEvidenceState, null, 'evidence remains absent while R3A is loading');
  assert.equal(ctx.gameReviewAiHeading.textContent, '電腦搜尋中…');
  assert.equal(ctx.reviewAiWorkers.length, 1);
  const worker = ctx.reviewAiWorkers[0];
  const request = worker.messages[0];
  assert.deepEqual(request.board, review.snapshot.board);
  assert.notDeepEqual(request.board, ctx.board, 'live board is deliberately different');
  assert.equal(request.sideToMove, review.snapshot.sideToMove);
  assert.notEqual(request.sideToMove, ctx.turn, 'live turn is deliberately opposite');
  assert.deepEqual(request.repetitionPrefix, review.snapshot.repetitionHistory);
  assert.equal(request.analysisPreset, 'review-v1');
  assert.deepEqual(reviewAiIsolationSnapshot(ctx), before);
  assert.equal(ctx.aiWorker, normalWorker, 'persistent normal worker identity is unchanged');

  worker.emit(successfulReviewAiResponse(worker));
  assert.equal(ctx.gameReviewAiState.status, 'success');
  assert.equal(ctx.gameReviewAiState.candidate.notation, '俥六平五');
  assert.equal(ctx.gameReviewAiState.candidate.depth, 2);
  assert.ok(ctx.gameReviewEvidenceState, 'eligible R3A success automatically derives R3B evidence');
  assert.equal(ctx.gameReviewEvidenceState.kind, 'review-move-comparison');
  assert.equal(ctx.gameReviewEvidenceState.source.recordId, saved.id);
  assert.equal(ctx.gameReviewEvidenceState.source.ply, 0);
  assert.deepEqual(ctx.gameReviewEvidenceState.played.move, saved.moves[0]);
  assert.equal(ctx.gameReviewEvidenceState.comparison.status, 'MATCH');
  assert.equal(ctx.gameReviewEvidencePlayed.textContent, '俥六平五');
  assert.equal(ctx.gameReviewEvidenceCandidate.textContent, '俥六平五');
  assert.equal(ctx.gameReviewEvidenceMatch.textContent, '你的實戰著法與 AI 候選相同');
  assert.equal(ctx.gameReviewEvidenceFactsSection.classList.contains('hidden'), true);
  assert.equal(ctx.gameReviewEvidence.classList.contains('hidden'), false);
  assert.equal(ctx.reviewAiWorkers.length, 1, 'R3B creates no additional worker or search');
  assert.equal(worker.terminated, true);
  assert.equal(ctx.gameReviewAiWorker, null);
  assert.match(ctx.gameReviewAiHeading.textContent, /^AI 候選著法：/);
  assert.equal(ctx.gameReviewAiDetail.textContent, '搜尋深度：2');
  assert.doesNotMatch(`${ctx.gameReviewAiHeading.textContent}${ctx.gameReviewAiDetail.textContent}`, /99998|score|PV|最佳著/);
  assert.deepEqual(ctx.gameReviewSession.snapshot.board, review.snapshot.board);
  assert.deepEqual(ctx.gameReviewSession.record, originalRecord);
  assert.deepEqual(reviewAiIsolationSnapshot(ctx), before);
  assert.equal(ctx.normalDoMoveCalls, 0);
  assert.equal(ctx.storage.writes, 0);
  assert.equal(ctx.puzzleWrites, 0);
  assert.equal(ctx.analyticsWrites, 0);
});

test('R3C teaching is derived from current R3B evidence, bounded, and hidden for MATCH or no useful rule', () => {
  const saved = record('review-teaching-ui');
  const ctx = harness({ records: [saved], realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');

  assert.equal(ctx.gameReviewEvidenceState, null);
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), true);
  ctx.requestGameReviewAiCandidate();
  let worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker));
  assert.equal(ctx.gameReviewEvidenceState.comparison.status, 'MATCH');
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), true,
    'MATCH keeps the teaching card absent');
  assert.equal(renderedR3cText(ctx), '');

  ctx.requestGameReviewAiCandidate();
  worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker, { to: { r: 3, c: 3 } }));
  const canonicalDifferent = clone(ctx.gameReviewEvidenceState);
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), false);
  assert.equal(ctx.gameReviewTeachingTitle.textContent, '實戰的一步將死');
  assert.match(ctx.gameReviewTeachingBody.textContent, /直接將死/);

  const before = {
    workers: ctx.reviewAiWorkers.length,
    requests: ctx.reviewAiRequestCount,
    searches: ctx.engineSearches,
    storage: ctx.storage.writes,
    puzzle: ctx.puzzleWrites,
    analytics: ctx.analyticsWrites,
  };
  for (const [kind, expectedRule, expectedTitle] of [
    ['candidate-mate', 'immediate-mate', '先找一步將死'],
    ['candidate-check', 'check-difference', '先看看將軍手'],
    ['candidate-capture', 'capture-difference', '看看立即吃子'],
  ]) {
    ctx.gameReviewEvidenceState = syntheticTeachingEvidence(canonicalDifferent, kind);
    ctx.renderGameReviewEvidence();
    assert.equal(deriveGameReviewTeaching(ctx.gameReviewEvidenceState)[0].ruleId, expectedRule);
    assert.equal(ctx.gameReviewTeachingTitle.textContent, expectedTitle);
    assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), false);
    assert.equal(deriveGameReviewTeaching(ctx.gameReviewEvidenceState).length, 1);
  }

  ctx.gameReviewEvidenceState = syntheticTeachingEvidence(canonicalDifferent, 'none');
  ctx.renderGameReviewEvidence();
  assert.deepEqual(deriveGameReviewTeaching(ctx.gameReviewEvidenceState), []);
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), true);
  assert.equal(renderedR3cText(ctx), '');
  assert.deepEqual({
    workers: ctx.reviewAiWorkers.length,
    requests: ctx.reviewAiRequestCount,
    searches: ctx.engineSearches,
    storage: ctx.storage.writes,
    puzzle: ctx.puzzleWrites,
    analytics: ctx.analyticsWrites,
  }, before, 'R3C derivation adds no worker, request, search, or write');
});

test('R3C teaching clears with new requests and navigation and stale results cannot restore it', () => {
  const saved = record('review-teaching-stale');
  const ctx = harness({ records: [saved], realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  ctx.requestGameReviewAiCandidate();
  let worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker, { to: { r: 3, c: 3 } }));
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), false);

  ctx.requestGameReviewAiCandidate();
  worker = ctx.reviewAiWorkers.at(-1);
  assert.equal(ctx.gameReviewEvidenceState, null);
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), true);
  ctx.navigateGameReview('last');
  assert.equal(ctx.gameReviewEvidenceState, null);
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), true);
  worker.emit(successfulReviewAiResponse(worker, { to: { r: 3, c: 3 } }));
  assert.equal(ctx.gameReviewEvidenceState, null);
  assert.equal(ctx.gameReviewTeaching.classList.contains('hidden'), true,
    'BROKEN_R3C1_USES_STALE_R3B_EVIDENCE_WOULD_FAIL');
});

test('rendering R3C from existing R3B evidence adds zero workers, requests, searches or rule calls', () => {
  const exercise = (teachingMutation = null) => {
    const saved = record(`review-teaching-purity-${teachingMutation || 'canonical'}`);
    const ctx = harness({ records: [saved], realRenderer: true, teachingMutation });
    ctx.enterGameRecordLibrary();
    ctx.openStoredGameReview(saved.id);
    ctx.navigateGameReview('first');
    ctx.requestGameReviewAiCandidate();
    const worker = ctx.reviewAiWorkers.at(-1);
    worker.emit(successfulReviewAiResponse(worker, { to: { r: 3, c: 3 } }));
    assert.ok(ctx.gameReviewEvidenceState, 'R3B evidence exists before the measured R3C render');

    const before = {
      workers: ctx.reviewAiWorkers.length,
      requests: ctx.reviewAiRequestCount,
      searches: ctx.engineSearches,
      gameRules: ctx.gameRuleEvaluations,
    };
    ctx.renderGameReviewEvidence();
    return {
      ctx,
      additionalWorkers: ctx.reviewAiWorkers.length - before.workers,
      additionalRequests: ctx.reviewAiRequestCount - before.requests,
      additionalSearches: ctx.engineSearches - before.searches,
      additionalGameRules: ctx.gameRuleEvaluations - before.gameRules,
    };
  };

  const canonical = exercise();
  assert.equal(canonical.additionalWorkers, 0, 'ADDITIONAL_REVIEW_WORKERS_DURING_R3C1=0');
  assert.equal(canonical.additionalRequests, 0, 'ADDITIONAL_R3A_REQUESTS_DURING_R3C1=0');
  assert.equal(canonical.additionalSearches, 0, 'ADDITIONAL_ENGINE_SEARCHES_DURING_R3C1=0');
  assert.equal(canonical.additionalGameRules, 0,
    'ADDITIONAL_GAME_RULE_EVALUATIONS_DURING_R3C1=0');

  const broken = exercise('direct-rule');
  assert.equal(broken.additionalGameRules, 1,
    'isolated mutation performs one forbidden legalMoves computation from the Review snapshot');
  assert.deepEqual(Object.keys(broken.ctx.gameRuleCallsByName), ['legalMoves']);
  assert.ok(broken.ctx.gameRuleCallsByName.legalMoves >= 1);
  let detected = null;
  try {
    assert.equal(broken.additionalGameRules, 0,
      'BROKEN_R3C1_CALLS_GAME_RULES_WOULD_FAIL');
  } catch (error) {
    detected = error;
  }
  assert.equal(detected?.code, 'ERR_ASSERTION');
  assert.match(detected.message, /BROKEN_R3C1_CALLS_GAME_RULES_WOULD_FAIL/);
});

test('accepted R3A success adds zero Review workers, requests or direct engine searches', () => {
  const exercise = (reviewAiMutation = null) => {
    const saved = record(`review-ai-search-count-${reviewAiMutation || 'canonical'}`);
    const ctx = harness({ records: [saved], realRenderer: true, reviewAiMutation });
    ctx.enterGameRecordLibrary();
    ctx.openStoredGameReview(saved.id);
    ctx.navigateGameReview('first');
    ctx.requestGameReviewAiCandidate();
    const worker = ctx.reviewAiWorkers.at(-1);
    const before = {
      workers: ctx.reviewAiWorkers.length,
      requests: ctx.reviewAiRequestCount,
      searches: ctx.engineSearches,
    };
    worker.emit(successfulReviewAiResponse(worker));
    return {
      ctx,
      additionalWorkers: ctx.reviewAiWorkers.length - before.workers,
      additionalRequests: ctx.reviewAiRequestCount - before.requests,
      additionalSearches: ctx.engineSearches - before.searches,
    };
  };

  const canonical = exercise();
  assert.ok(canonical.ctx.gameReviewEvidenceState);
  assert.equal(canonical.additionalWorkers, 0);
  assert.equal(canonical.additionalRequests, 0);
  assert.equal(canonical.additionalSearches, 0);

  const broken = exercise('direct-search');
  assert.equal(broken.additionalWorkers, 0,
    'direct-search mutation deliberately creates no additional Worker');
  assert.equal(broken.additionalRequests, 0,
    'direct-search mutation deliberately creates no additional R3A request');
  assert.equal(broken.additionalSearches, 1,
    'isolated mutation performs exactly one forbidden direct engine search');
  let detected = null;
  try {
    assert.equal(broken.additionalSearches, 0, 'BROKEN_R3B_DIRECT_ENGINE_SEARCH');
  } catch (error) {
    detected = error;
  }
  assert.equal(detected?.code, 'ERR_ASSERTION');
  assert.match(detected.message, /BROKEN_R3B_DIRECT_ENGINE_SEARCH/);
});

test('Review AI error is retryable and worker construction has no main-thread fallback', () => {
  const saved = record('review-ai-error');
  const ctx = harness({ records: [saved], workerCreationError: true, realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');

  assert.equal(ctx.requestGameReviewAiCandidate(), true);
  assert.equal(ctx.gameReviewAiState.status, 'error');
  assert.equal(ctx.gameReviewEvidenceState, null);
  assert.match(ctx.gameReviewAiHeading.textContent, /請再試一次/);
  assert.equal(ctx.btnGameReviewAiAnalyze.disabled, false);
  assert.equal(ctx.reviewAiWorkers.length, 0);
  assert.doesNotMatch(functionSource('requestGameReviewAiCandidate'), /aiModule|findBestMove|setTimeout/);
  assert.equal(ctx.requestGameReviewAiCandidate(), true, 'retry remains explicit and available');
  assert.equal(ctx.gameReviewAiState.status, 'error');
});

test('new request, ply navigation and record switch reject stale revision and old-worker results', () => {
  const recordA = record('review-ai-record-a');
  const recordB = record('review-ai-record-b', 2);
  const ctx = harness({ records: [recordA, recordB], realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(recordA.id);
  ctx.navigateGameReview('first');

  ctx.requestGameReviewAiCandidate();
  const firstWorker = ctx.reviewAiWorkers.at(-1);
  const firstRevision = firstWorker.messages[0].revision;
  ctx.requestGameReviewAiCandidate();
  const secondWorker = ctx.reviewAiWorkers.at(-1);
  assert.equal(firstWorker.terminated, true);
  firstWorker.emit(successfulReviewAiResponse(firstWorker));
  assert.equal(ctx.gameReviewAiState.status, 'loading', 'old worker cannot settle the replacement request');
  secondWorker.emit({ ...successfulReviewAiResponse(secondWorker), revision: firstRevision });
  assert.equal(ctx.gameReviewAiState.status, 'loading', 'wrong revision remains ignored');
  secondWorker.emit(successfulReviewAiResponse(secondWorker));
  assert.equal(ctx.gameReviewAiState.status, 'success');
  assert.ok(ctx.gameReviewEvidenceState);

  ctx.requestGameReviewAiCandidate();
  assert.equal(ctx.gameReviewEvidenceState, null, 'a new R3A request clears prior evidence');
  const plyWorker = ctx.reviewAiWorkers.at(-1);
  ctx.navigateGameReview('last');
  assert.equal(plyWorker.terminated, true);
  assert.equal(ctx.gameReviewAiState.status, 'idle');
  assert.equal(ctx.gameReviewEvidenceState, null);
  assert.equal(ctx.gameReviewAiPanel.classList.contains('hidden'), true);
  plyWorker.emit(successfulReviewAiResponse(plyWorker, { from: { r: 0, c: 4 }, to: { r: 0, c: 5 } }));
  assert.equal(ctx.gameReviewAiState.status, 'idle', 'stale ply response remains ignored');

  ctx.navigateGameReview('first');
  ctx.requestGameReviewAiCandidate();
  const recordWorker = ctx.reviewAiWorkers.at(-1);
  ctx.openStoredGameReview(recordB.id);
  assert.equal(recordWorker.terminated, true);
  recordWorker.emit(successfulReviewAiResponse(recordWorker));
  assert.equal(ctx.gameReviewSession.record.id, recordB.id);
  assert.equal(ctx.gameReviewAiState.status, 'idle', 'stale Record A response cannot surface on Record B');
  assert.equal(ctx.gameReviewEvidenceState, null, 'stale Record A evidence cannot surface on Record B');
  assert.equal(ctx.normalDoMoveCalls, 0);
  assert.equal(ctx.storage.writes, 0);
});

test('Review exit invalidates pending results and normal AI resumes through its existing scheduler only', () => {
  const saved = record('review-ai-exit');
  const ctx = harness({ records: [saved], mode: 'hard', turn: BLACK, realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  const tokenAfterReviewEntry = ctx.aiToken;
  ctx.requestGameReviewAiCandidate();
  const worker = ctx.reviewAiWorkers.at(-1);
  assert.equal(ctx.aiToken, tokenAfterReviewEntry);
  ctx.exitGameRecordFlow();
  assert.equal(worker.terminated, true);
  assert.equal(ctx.gameReviewEvidenceState, null);
  assert.equal(ctx.appState, 'NORMAL_GAME');
  assert.equal(ctx.aiToken, tokenAfterReviewEntry + 1, 'only the existing Review exit invalidation advances normal token');
  assert.equal(ctx.aiRequests, 1, 'normal scheduler resumes one normal AI request');
  worker.emit(successfulReviewAiResponse(worker));
  assert.equal(ctx.gameReviewAiState.status, 'idle');
  assert.equal(ctx.normalDoMoveCalls, 0);
});

test('terminal and GAME_ANALYSIS contexts gate Review AI, while R2/R4 production entries invalidate it', () => {
  const saved = record('review-ai-gating');
  const ctx = harness({ records: [saved], realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  assert.ok(ctx.gameReviewSession.snapshot.terminal);
  assert.equal(ctx.btnGameReviewAiAnalyze.disabled, true);
  assert.equal(ctx.requestGameReviewAiCandidate(), false);
  ctx.navigateGameReview('first');
  ctx.appState = 'GAME_ANALYSIS';
  assert.equal(ctx.requestGameReviewAiCandidate(), false);
  assert.equal(ctx.reviewAiWorkers.length, 0);
  assert.match(functionSource('enterGameAnalysis'), /invalidateGameReviewAi\(\)/);
  assert.match(functionSource('createPuzzleFromGameReview'), /invalidateGameReviewAi\(\)/);
  ctx.gameReviewEvidenceState = Object.freeze({ kind: 'stale-evidence' });
  ctx.invalidateGameReviewAi();
  assert.equal(ctx.gameReviewEvidenceState, null, 'the shared R2/R4 invalidation clears R3B evidence');
  assert.doesNotMatch(
    html.match(/<section id="gameAnalysisView"[^]*?<\/section>/)?.[0] || '',
    /btnGameReviewAiAnalyze|AI 分析/,
  );
});

test('negative control detects forbidden doMove reuse in the real Review AI result route', () => {
  const saved = record('review-ai-do-move-mutation');
  const ctx = harness({ records: [saved], realRenderer: true, reviewAiMutation: 'doMove' });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  ctx.requestGameReviewAiCandidate();
  const worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker));
  let detected = null;
  try {
    assert.equal(ctx.normalDoMoveCalls, 0, 'REVIEW_AI_DO_MOVE_COUNT');
  } catch (error) {
    detected = error;
  }
  assert.equal(detected?.code, 'ERR_ASSERTION');
  assert.match(detected.message, /REVIEW_AI_DO_MOVE_COUNT/);
});

test('negative control detects any R3B-triggered storage write', () => {
  const saved = record('review-evidence-storage-mutation');
  const ctx = harness({ records: [saved], realRenderer: true, reviewAiMutation: 'storage' });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  const writesBefore = ctx.storage.writes;
  ctx.requestGameReviewAiCandidate();
  const worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker));
  let detected = null;
  try {
    assert.equal(ctx.storage.writes, writesBefore, 'R3B_STORAGE_WRITE_COUNT');
  } catch (error) {
    detected = error;
  }
  assert.equal(detected?.code, 'ERR_ASSERTION');
  assert.match(detected.message, /R3B_STORAGE_WRITE_COUNT/);
});

test('MATCH and DIFFERENT panels retain factual language and reject heuristic wording mutations', () => {
  const renderCandidate = (id, result = {}) => {
    const saved = record(id);
    const ctx = harness({ records: [saved], realRenderer: true });
    ctx.enterGameRecordLibrary();
    ctx.openStoredGameReview(saved.id);
    ctx.navigateGameReview('first');
    ctx.requestGameReviewAiCandidate();
    const worker = ctx.reviewAiWorkers.at(-1);
    worker.emit(successfulReviewAiResponse(worker, result));
    assert.ok(ctx.gameReviewEvidenceState);
    return renderedR3bText(ctx);
  };

  const matchText = renderCandidate('review-language-match');
  assert.match(matchText, /實戰/);
  assert.match(matchText, /AI 候選/);
  assert.match(matchText, /你的實戰著法與 AI 候選相同/);
  assertFactualR3bLanguage(matchText, 'MATCH panel');

  const differentText = renderCandidate('review-language-different', {
    to: { r: 3, c: 3 },
  });
  for (const allowedFact of ['實戰', 'AI 候選', '吃到', '將軍', '將死']) {
    assert.match(differentText, new RegExp(allowedFact));
  }
  assertFactualR3bLanguage(differentText, 'DIFFERENT panel');

  for (const injected of [
    'AI 候選比較好',
    '這步白送一車',
    '目前有明顯優勢',
    '評分較高',
  ]) {
    let detected = null;
    try {
      assertFactualR3bLanguage(`${differentText}\n${injected}`, 'mutated R3B panel');
    } catch (error) {
      detected = error;
    }
    assert.equal(detected?.code, 'ERR_ASSERTION');
    assert.match(detected.message, /must not contain forbidden term/);
  }
});

test('rendered R3C templates remain child-neutral and forbidden-language mutations are detected', () => {
  const saved = record('review-teaching-language');
  const ctx = harness({ records: [saved], realRenderer: true });
  ctx.enterGameRecordLibrary();
  ctx.openStoredGameReview(saved.id);
  ctx.navigateGameReview('first');
  ctx.requestGameReviewAiCandidate();
  const worker = ctx.reviewAiWorkers.at(-1);
  worker.emit(successfulReviewAiResponse(worker, { to: { r: 3, c: 3 } }));
  const base = clone(ctx.gameReviewEvidenceState);
  const rendered = [];
  for (const kind of ['candidate-mate', 'candidate-check', 'candidate-capture']) {
    ctx.gameReviewEvidenceState = syntheticTeachingEvidence(base, kind);
    ctx.renderGameReviewEvidence();
    rendered.push(renderedR3cText(ctx));
  }
  for (const text of rendered) {
    assert.ok(text);
    for (const term of R3C_FORBIDDEN_UI_TERMS) {
      assert.equal(text.toLowerCase().includes(term.toLowerCase()), false,
        `rendered R3C text must not contain forbidden term: ${term}`);
    }
  }
  for (const injected of ['這步白送一車', 'AI 最佳著比較好']) {
    let detected = null;
    try {
      for (const term of R3C_FORBIDDEN_UI_TERMS) {
        assert.equal(injected.toLowerCase().includes(term.toLowerCase()), false,
          `BROKEN_R3C1_FORBIDDEN_UI_LANGUAGE: ${term}`);
      }
    } catch (error) {
      detected = error;
    }
    assert.equal(detected?.code, 'ERR_ASSERTION');
  }
});

test('R3C2-A2 capability gating, explicit request, loading and validated success preserve canonical teaching', async () => {
  const disabled = harness({ records: [record('coach-disabled')], realRenderer: true });
  prepareEligibleCoach(disabled, 'coach-disabled');
  assert.equal(disabled.btnGameReviewCoach.classList.contains('hidden'), true,
    'capability disabled keeps the coach button absent');
  assert.equal(disabled.requestGameReviewCoach(), false);
  assert.equal(disabled.coachRequests.length, 0);

  const ctx = harness({ records: [record('coach-enabled')], realRenderer: true, coachEnabled: true });
  assert.equal(ctx.btnGameReviewCoach.classList.contains('hidden'), true, 'R3C1 absent has no coach action');
  assert.equal(ctx.openStoredGameReview('coach-enabled', ctx.btnGameRecords), true);
  assert.equal(ctx.navigateGameReview(0), true);
  assert.equal(ctx.requestGameReviewAiCandidate(), true);
  const aiWorker = ctx.reviewAiWorkers.at(-1);
  aiWorker.emit(successfulReviewAiResponse(aiWorker));
  assert.equal(ctx.gameReviewEvidenceState.comparison.status, 'MATCH');
  assert.equal(ctx.btnGameReviewCoach.classList.contains('hidden'), true, 'MATCH has no coach action');
  assert.equal(ctx.requestGameReviewAiCandidate(), true);
  const differentWorker = ctx.reviewAiWorkers.at(-1);
  differentWorker.emit(successfulReviewAiResponse(differentWorker, { to: { r: 3, c: 3 } }));
  const canonical = {
    title: ctx.gameReviewTeachingTitle.textContent,
    body: ctx.gameReviewTeachingBody.textContent,
  };
  assert.equal(ctx.coachRequests.length, 0,
    'BROKEN_R3C2_A2_AUTO_REQUEST_ON_RENDER_WOULD_FAIL');
  assert.equal(ctx.btnGameReviewCoach.classList.contains('hidden'), false);
  assert.equal(ctx.requestGameReviewCoach(), true);
  assert.equal(ctx.coachRequests.length, 1);
  assert.deepEqual(Object.keys(ctx.coachRequests[0].request).sort(),
    ['locale', 'requestId', 'sourceRuleId', 'style', 'version']);
  assert.equal(ctx.gameReviewCoachState.status, 'loading');
  assert.equal(ctx.btnGameReviewCoach.disabled, true);
  assert.equal(ctx.btnGameReviewCoach.getAttribute('aria-busy'), 'true');
  assert.equal(ctx.gameReviewCoachStatus.textContent, 'AI 教練整理中…');
  assert.deepEqual({
    title: ctx.gameReviewTeachingTitle.textContent,
    body: ctx.gameReviewTeachingBody.textContent,
  }, canonical, 'BROKEN_R3C2_A2_REMOVES_R3C1_DURING_LOADING_WOULD_FAIL');
  assert.equal(ctx.requestGameReviewCoach(), false);
  assert.equal(ctx.coachRequests.length, 1,
    'BROKEN_R3C2_A2_DUPLICATE_REQUEST_WOULD_FAIL');
  assert.equal(ctx.maxActiveCoachRequests, 1);
  ctx.coachRequests[0].resolve(validCoachResponse(ctx.coachRequests[0]));
  await flushCoachSettlement();
  assert.equal(ctx.gameReviewCoachState.status, 'success');
  assert.equal(ctx.gameReviewCoachLeadIn.textContent, '可以一起看看這個地方。');
  assert.equal(ctx.gameReviewCoachEncouragement.textContent, '下次也可以先停一下想想。');
  assert.equal(ctx.gameReviewCoachStatus.textContent, 'AI 教練已整理完成。');
  assert.deepEqual({
    title: ctx.gameReviewTeachingTitle.textContent,
    body: ctx.gameReviewTeachingBody.textContent,
  }, canonical, 'BROKEN_R3C2_A2_REWRITES_CANONICAL_TEACHING_WOULD_FAIL');
});

test('R3C2-A2 malformed, unsafe and rejected mock responses fail back to unchanged R3C1', async () => {
  const exercise = async (id, settle) => {
    const ctx = harness({ records: [record(id)], realRenderer: true, coachEnabled: true });
    const canonical = prepareEligibleCoach(ctx, id);
    assert.equal(ctx.requestGameReviewCoach(), true);
    settle(ctx.coachRequests[0]);
    await flushCoachSettlement();
    assert.equal(ctx.gameReviewCoachState.status, 'idle');
    assert.equal(ctx.gameReviewCoachLeadIn.textContent, '');
    assert.equal(ctx.gameReviewCoachEncouragement.textContent, '');
    assert.deepEqual({
      title: ctx.gameReviewTeachingTitle.textContent,
      body: ctx.gameReviewTeachingBody.textContent,
    }, { title: canonical.title, body: canonical.body });
    assert.match(ctx.gameReviewCoachStatus.textContent, /原教學提示保持不變/);
  };
  await exercise('coach-extra-key', (pending) => pending.resolve({
    ...validCoachResponse(pending), extra: true,
  }));
  await exercise('coach-wrong-id', (pending) => pending.resolve({
    ...validCoachResponse(pending), requestId: 'wrong-request',
  }));
  await exercise('coach-wrong-rule', (pending) => pending.resolve({
    ...validCoachResponse(pending), sourceRuleId: 'capture-difference',
  }));
  await exercise('coach-unsafe-fact', (pending) => pending.resolve(validCoachResponse(pending, {
    framing: { leadIn: '這步形成將軍。', encouragement: '下次也可以先停一下想想。' },
  })));
  await exercise('coach-quality', (pending) => pending.resolve(validCoachResponse(pending, {
    framing: { leadIn: '這是最佳選擇。', encouragement: '下次也可以先停一下想想。' },
  })));
  await exercise('coach-rejection', (pending) => pending.reject());
});

test('R3C2-A2 ply, record, R3A, exit and R2 boundaries invalidate without resurrection', async () => {
  const pendingPly = harness({ records: [record('coach-stale-ply')], realRenderer: true, coachEnabled: true });
  const canonicalPly = prepareEligibleCoach(pendingPly, 'coach-stale-ply');
  pendingPly.requestGameReviewCoach();
  const stalePly = pendingPly.coachRequests[0];
  pendingPly.navigateGameReview('next');
  stalePly.resolve(validCoachResponse(stalePly));
  await flushCoachSettlement();
  assert.equal(pendingPly.gameReviewCoachState.status, 'idle');
  assert.equal(pendingPly.gameReviewCoachLeadIn.textContent, '',
    'BROKEN_R3C2_A2_STALE_PLY_RESPONSE_WOULD_FAIL');
  assert.notEqual(pendingPly.gameReviewTeachingTitle.textContent, canonicalPly.title);

  const recordB = record('coach-record-b', 2);
  const switched = harness({ records: [record('coach-record-a'), recordB], realRenderer: true, coachEnabled: true });
  prepareEligibleCoach(switched, 'coach-record-a');
  switched.requestGameReviewCoach();
  const staleRecord = switched.coachRequests[0];
  switched.openStoredGameReview(recordB.id, switched.btnGameRecords);
  staleRecord.resolve(validCoachResponse(staleRecord));
  await flushCoachSettlement();
  assert.equal(switched.gameReviewSession.record.id, recordB.id);
  assert.equal(switched.gameReviewCoachLeadIn.textContent, '',
    'BROKEN_R3C2_A2_STALE_RECORD_RESPONSE_WOULD_FAIL');

  const r3a = harness({ records: [record('coach-r3a')], realRenderer: true, coachEnabled: true });
  prepareEligibleCoach(r3a, 'coach-r3a');
  r3a.requestGameReviewCoach();
  r3a.coachRequests[0].resolve(validCoachResponse(r3a.coachRequests[0]));
  await flushCoachSettlement();
  assert.notEqual(r3a.gameReviewCoachLeadIn.textContent, '');
  assert.equal(r3a.requestGameReviewAiCandidate(), true);
  assert.equal(r3a.gameReviewCoachLeadIn.textContent, '', 'new R3A clears coach framing immediately');
  r3a.reviewAiWorkers.at(-1).fail();
  assert.equal(r3a.gameReviewAiState.status, 'error');
  assert.equal(r3a.gameReviewCoachLeadIn.textContent, '', 'R3A error cannot restore coach framing');

  const exited = harness({ records: [record('coach-exit')], realRenderer: true, coachEnabled: true });
  prepareEligibleCoach(exited, 'coach-exit');
  exited.requestGameReviewCoach();
  const staleExit = exited.coachRequests[0];
  exited.exitGameRecordFlow();
  staleExit.resolve(validCoachResponse(staleExit));
  await flushCoachSettlement();
  assert.equal(exited.appState, 'NORMAL_GAME');
  assert.equal(exited.gameReviewCoachState.status, 'idle');

  const r2 = harness({ records: [record('coach-r2')], realRenderer: true, coachEnabled: true });
  prepareEligibleCoach(r2, 'coach-r2');
  r2.requestGameReviewCoach();
  const staleR2 = r2.coachRequests[0];
  r2.invalidateGameReviewAi();
  r2.appState = 'GAME_ANALYSIS';
  r2.renderGameReviewCoach(null);
  staleR2.resolve(validCoachResponse(staleR2));
  await flushCoachSettlement();
  assert.equal(r2.btnGameReviewCoach.classList.contains('hidden'), true);
  r2.appState = 'GAME_REVIEW';
  r2.renderGameReviewAi();
  assert.equal(r2.gameReviewCoachLeadIn.textContent, '',
    'BROKEN_R3C2_A2_R2_RESURRECTION_WOULD_FAIL');
});

test('R3C2-A2 observable mutants trip auto, duplicate, canonical, validator and zero-dependency gates', async () => {
  const auto = harness({ records: [record('coach-mut-auto')], realRenderer: true,
    coachEnabled: true, coachMutation: 'auto-request' });
  prepareEligibleCoach(auto, 'coach-mut-auto');
  assert.equal(auto.coachRequests.length, 1,
    'BROKEN_R3C2_A2_AUTO_REQUEST_ON_RENDER_WOULD_FAIL');

  const duplicate = harness({ records: [record('coach-mut-duplicate')], realRenderer: true,
    coachEnabled: true, coachMutation: 'duplicate' });
  prepareEligibleCoach(duplicate, 'coach-mut-duplicate');
  duplicate.requestGameReviewCoach();
  duplicate.requestGameReviewCoach();
  assert.equal(duplicate.coachRequests.length, 2,
    'BROKEN_R3C2_A2_DUPLICATE_REQUEST_WOULD_FAIL');

  const removed = harness({ records: [record('coach-mut-removed')], realRenderer: true,
    coachEnabled: true, coachMutation: 'remove-canonical-loading' });
  const removedCanonical = prepareEligibleCoach(removed, 'coach-mut-removed');
  removed.requestGameReviewCoach();
  assert.notEqual(removed.gameReviewTeachingTitle.textContent, removedCanonical.title,
    'BROKEN_R3C2_A2_REMOVES_R3C1_DURING_LOADING_WOULD_FAIL');

  const rewritten = harness({ records: [record('coach-mut-rewrite')], realRenderer: true,
    coachEnabled: true, coachMutation: 'rewrite-canonical' });
  const rewriteCanonical = prepareEligibleCoach(rewritten, 'coach-mut-rewrite');
  rewritten.requestGameReviewCoach();
  rewritten.coachRequests[0].resolve(validCoachResponse(rewritten.coachRequests[0]));
  await flushCoachSettlement();
  assert.notEqual(rewritten.gameReviewTeachingTitle.textContent, rewriteCanonical.title,
    'BROKEN_R3C2_A2_REWRITES_CANONICAL_TEACHING_WOULD_FAIL');

  const unsafe = harness({ records: [record('coach-mut-validator')], realRenderer: true,
    coachEnabled: true, coachMutation: 'accept-unvalidated' });
  prepareEligibleCoach(unsafe, 'coach-mut-validator');
  unsafe.requestGameReviewCoach();
  unsafe.coachRequests[0].resolve(validCoachResponse(unsafe.coachRequests[0], {
    framing: { leadIn: '這步形成將軍。', encouragement: '這是最佳選擇。' },
  }));
  await flushCoachSettlement();
  assert.equal(unsafe.gameReviewCoachLeadIn.textContent, '這步形成將軍。',
    'BROKEN_R3C2_A2_ACCEPTS_UNVALIDATED_RESPONSE_WOULD_FAIL');

  for (const [mutation, field, label] of [
    ['real-network', 'networkRequests', 'BROKEN_R3C2_A2_REAL_NETWORK_CALL_WOULD_FAIL'],
    ['storage-write', null, 'BROKEN_R3C2_A2_STORAGE_WRITE_WOULD_FAIL'],
    ['engine-call', 'engineSearches', 'BROKEN_R3C2_A2_ENGINE_CALL_WOULD_FAIL'],
  ]) {
    const ctx = harness({ records: [record(`coach-mut-${mutation}`)], realRenderer: true,
      coachEnabled: true, coachMutation: mutation });
    prepareEligibleCoach(ctx, `coach-mut-${mutation}`);
    const writesBefore = ctx.storage.writes;
    const rulesBefore = ctx.gameRuleEvaluations;
    ctx.requestGameReviewCoach();
    const observed = mutation === 'storage-write'
      ? ctx.storage.writes - writesBefore
      : (mutation === 'engine-call'
        ? (ctx.engineSearches + ctx.gameRuleEvaluations - rulesBefore)
        : ctx[field]);
    assert.ok(observed > 0, label);
  }

  const canonical = harness({ records: [record('coach-purity')], realRenderer: true, coachEnabled: true });
  prepareEligibleCoach(canonical, 'coach-purity');
  const before = {
    storage: canonical.storage.writes,
    engine: canonical.engineSearches,
    rules: canonical.gameRuleEvaluations,
    network: canonical.networkRequests,
  };
  canonical.requestGameReviewCoach();
  assert.deepEqual({
    storage: canonical.storage.writes,
    engine: canonical.engineSearches,
    rules: canonical.gameRuleEvaluations,
    network: canonical.networkRequests,
  }, before);
});

test('source and DOM contain explicit read-only, accessibility and responsive guards', () => {
  assert.match(functionSource('doMove'), /if\s*\(!normalGameActive\(\)\)\s*return/);
  assert.match(source, /if \(appState === APP_STATE\.GAME_RECORD_LIBRARY \|\| appState === APP_STATE\.GAME_REVIEW\) return;\s*\n\s*const hit = pick\(e\)/);
  assert.match(source, /if \(appState === APP_STATE\.GAME_ANALYSIS\) \{\s*\n\s*handleGameAnalysisBoardClick\(hit\)/);
  assert.doesNotMatch(functionSource('navigateGameReview'), /doMove|maybeAIMove|gameRecordStore/);
  assert.match(source, /createGameReview\(record\)/);
  assert.match(html, /id="gameReviewStatus"[^>]*aria-live="polite"/);
  assert.match(html, /id="btnGameReviewFirst"[^>]*type="button"/);
  assert.match(html, /id="btnGameReviewPrevious"[^>]*type="button"/);
  assert.match(html, /id="btnGameReviewAiAnalyze"[^>]*type="button"[^>]*aria-label="分析目前複盤局面"/);
  assert.match(html, /id="gameReviewAiPanel"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="gameReviewEvidence"[^>]*aria-label="實戰著法與 AI 候選的事實比較"/);
  assert.match(html, /id="gameReviewTeaching"[^>]*class="game-review-teaching hidden"[^>]*aria-labelledby="gameReviewTeachingHeading"/);
  assert.match(html, /id="gameReviewTeachingHeading">教學提示<\/h3>/);
  const teachingMarkup = html.match(/<section id="gameReviewTeaching"[^]*?<\/section>/)?.[0] || '';
  assert.equal((teachingMarkup.match(/aria-live="polite"/g) || []).length, 1,
    'R3C2 has one polite status region');
  assert.match(teachingMarkup, /id="btnGameReviewCoach"[^>]*aria-controls="[^"]+"[^>]*aria-busy="false"/);
  assert.doesNotMatch(
    html.match(/<section id="gameAnalysisView"[^]*?<\/section>/)?.[0] || '',
    /gameReviewTeaching|教學提示/,
    'R2 has no teaching UI',
  );
  assert.doesNotMatch(source, /gameReviewTeachingState/,
    'R3C uses no separate mutable teaching state');
  assert.match(functionSource('renderGameReviewTeaching'), /deriveGameReviewTeaching\(evidence\)/);
  assert.equal((html.match(/id="btnGameReviewAiAnalyze"/g) || []).length, 1, 'R3B adds no second action');
  assert.equal((html.match(/id="btnGameReviewCoach"/g) || []).length, 1, 'R3C2 adds one bounded action');
  assert.doesNotMatch(html, /最佳著|比較好|比較差|你走錯了|失誤|大漏著|白送|掉子|懸子|優勢|勝率|評分/);
  assert.match(source, /setAttribute\('aria-current', 'step'\)/);
  assert.match(source, /ArrowLeft: 'previous'/);
  assert.match(source, /ArrowRight: 'next'/);
  assert.match(source, /Home: 'first'/);
  assert.match(source, /End: 'last'/);
  assert.match(css, /@media \(max-width: 900px\)[^]*#gameRecordPanel/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /\.game-review-teaching/);
  assert.match(css, /\.game-review-coach-button[^]*?min-height: 44px/);
  assert.match(css, /prefers-reduced-motion/);
  const coachPath = [
    functionSource('requestGameReviewCoach'),
    functionSource('handleGameReviewCoachResponse'),
    functionSource('renderGameReviewCoach'),
  ].join('\n');
  assert.doesNotMatch(coachPath, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/);
  assert.doesNotMatch(coachPath, /\b(?:localStorage|sessionStorage|indexedDB|gameRecordStore|puzzleStore)\b/);
  assert.doesNotMatch(coachPath, /\b(?:findBestMove|legalMoves|applyMove|inCheck|repetitionVerdict)\b/);
});
