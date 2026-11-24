import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { RED, BLACK } from './game.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./css/style.css', import.meta.url), 'utf8');

function functionSource(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `main.js function ${name} exists`);
  return match[0];
}

function install(name, values) {
  const context = vm.createContext({ RED, BLACK, mode: 'medium', experimentalAIFailure: null, customRematchRequest: null, ...values });
  vm.runInContext(functionSource(name), context);
  return context;
}

function installMany(names, values) {
  const context = vm.createContext({ RED, BLACK, mode: 'medium', experimentalAIFailure: null, clearTimeout() {}, customRematchRequest: null,
    gameExportRevision: 0, gameExportUI: null, ...values });
  vm.runInContext(['invalidateGameExport', ...names].map(functionSource).join('\n'), context);
  return context;
}

function assertCustomPlayDescription(markup) {
  const descriptions = [...markup.matchAll(/<p\b[^>]*\sid="customPlayDescription"[^>]*>([^]*?)<\/p>/gu)];
  assert.equal(descriptions.length, 1, 'one custom-position play description');
  assert.equal(descriptions[0][1].replace(/\s+/gu, ' ').trim(),
    '以已確認棋面開始新對局。玩家棋色與輪走方分開設定；輪到電腦時，電腦會先走。原本尚未完成的對局將被取代。');
}

test('renders one native AI-only player-side selector with the approved labels', () => {
  assert.equal((html.match(/id="sideChooser"/gu) || []).length, 1);
  assert.match(html, /<fieldset id="sideChooser"[^>]*>[\s\S]*<legend>選擇你的棋色<\/legend>/u);
  assert.match(html, /<label for="humanSideRed">紅方<\/label>/u);
  assert.match(html, /<label for="humanSideBlack">黑方<\/label>/u);
  assert.doesNotMatch(html, /選黑方時 AI 會先走|尚無著法，紅方先行/u);
  assertCustomPlayDescription(html);
  assert.match(css, /\.side-chooser input:focus-visible \+ label/u);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.side-chooser label \{ min-height: 44px/u);
});

test('custom play description negative controls reject wrong turn ownership and misplaced copy', () => {
  for (const [before, after] of [
    ['玩家棋色與輪走方分開設定', '玩家棋色決定輪走方'],
    ['輪到電腦時，電腦會先走', '選黑方時，電腦必定先走'],
    ['id="customPlayDescription"', 'id="unrelatedDescription"'],
    ['id="customPlayDescription"', 'data-id="customPlayDescription"'],
  ]) {
    assert.equal(html.split(before).length, 2, 'mutation must hit exactly once');
    assert.throws(() => assertCustomPlayDescription(html.replace(before, after)), { code: 'ERR_ASSERTION' });
  }
});

test('derives AI ownership from ephemeral human ownership without an authoritative AI_SIDE', () => {
  assert.match(source, /let humanSide = RED;/u);
  assert.match(source, /const aiSide = \(\) => humanSide === RED \? BLACK : RED;/u);
  assert.doesNotMatch(source, /\bAI_SIDE\b/u);
  assert.doesNotMatch(source, /humanSide[^\n]*(?:localStorage|sessionStorage)|(?:localStorage|sessionStorage)[^\n]*humanSide/u);
  assert.match(functionSource('beginNormalGameRecordSession'), /\.\.\.\(isAI\(\) \? \{ humanSide \} : \{\}\)/u);
});

test('central human input predicate enforces actor ownership and lifecycle locks', () => {
  const cases = [
    [{ active: true, mode: 'pvp', turn: BLACK, humanSide: RED }, true],
    [{ active: true, mode: 'medium', turn: RED, humanSide: RED }, true],
    [{ active: true, mode: 'medium', turn: BLACK, humanSide: RED }, false],
    [{ active: true, mode: 'medium', turn: BLACK, humanSide: BLACK }, true],
    [{ active: true, mode: 'medium', turn: RED, humanSide: BLACK }, false],
    [{ active: false, mode: 'medium', turn: RED, humanSide: RED }, false],
  ];
  for (const [value, expected] of cases) {
    const context = install('canHumanMove', {
      normalGameActive: () => value.active,
      isAI: () => value.mode !== 'pvp',
      over: false,
      busy: false,
      aiThinking: false,
      turn: value.turn,
      humanSide: value.humanSide,
    });
    assert.equal(context.canHumanMove(), expected);
  }
  for (const lock of ['over', 'busy', 'aiThinking']) {
    const context = install('canHumanMove', {
      normalGameActive: () => true,
      isAI: () => true,
      over: lock === 'over',
      busy: lock === 'busy',
      aiThinking: lock === 'aiThinking',
      turn: RED,
      humanSide: RED,
    });
    assert.equal(context.canHumanMove(), false);
  }
  assert.match(source, /if \(!canHumanMove\(\)\) return;/u);
});

test('AI scheduler no-ops for human Red opening and starts exactly once for human Black', () => {
  function harness(humanSide) {
    const context = install('maybeAIMove', {
      normalGameActive: () => true,
      isAI: () => true,
      over: false,
      busy: false,
      turn: RED,
      humanSide,
      aiSide: () => humanSide === RED ? BLACK : RED,
      aiThinking: false,
      aiMoveStart: 0,
      performance: { now: () => 123 },
      requests: 0,
      requestAIMove() { context.requests++; },
      refreshHUD() {},
    });
    return context;
  }
  const red = harness(RED);
  red.maybeAIMove();
  assert.equal(red.requests, 0);
  assert.equal(red.aiThinking, false);

  const black = harness(BLACK);
  black.maybeAIMove();
  black.maybeAIMove();
  assert.equal(black.requests, 1);
  assert.equal(black.aiThinking, true);
  assert.match(functionSource('newGame'), /refreshHUD\(\);[\s\S]*maybeAIMove\(\);/u);
});

test('AI failure is bounded, local and stale-token safe', () => {
  const messages = [];
  const session = {};
  const context = installMany(['currentAIRequest', 'onAIResult'], {
    aiToken: 9,
    aiRequest: { token: 9, session, payload: { side: BLACK, level: 'medium' } },
    normalGameRecordSession: session, normalGameActive: () => true, isAI: () => true,
    over: false, turn: BLACK, aiSide: () => BLACK, mode: 'medium',
    aiThinking: true,
    refreshHUD() {},
    toast(message) { messages.push(message); },
  });
  context.onAIResult({ token: 8, error: true });
  assert.equal(context.aiThinking, true);
  assert.deepEqual(messages, []);
  context.onAIResult({ token: 9, error: true });
  assert.equal(context.aiThinking, false);
  assert.deepEqual(messages, ['AI 無法完成行棋，請開新對局重試。']);
  assert.doesNotMatch(functionSource('onAIResult'), /requestAIMove|fetch|XMLHttpRequest|WebSocket/u);
});

test('black-side opening cannot be undone until the human has moved', () => {
  const opening = install('normalUndoAvailable', {
    normalGameActive: () => true,
    isAI: () => true,
    history: [{}],
    busy: false,
    aiThinking: false,
    over: false,
    turn: BLACK,
    humanSide: BLACK,
  });
  assert.equal(opening.normalUndoAvailable(), false);

  const paired = install('normalUndoAvailable', {
    normalGameActive: () => true,
    isAI: () => true,
    history: [{}, {}, {}],
    busy: false,
    aiThinking: false,
    over: false,
    turn: BLACK,
    humanSide: BLACK,
  });
  assert.equal(paired.normalUndoAvailable(), true);
  assert.match(functionSource('undo'), /turn === aiSide\(\)/u);
});

test('side changes request confirmation before mutation; accepted new games reconcile the camera', () => {
  const calls = [];
  const context = install('changeHumanSide', {
    normalGameActive: () => true,
    isAI: () => true,
    humanSide: RED,
    document: { getElementById: id => ({ id }) },
    requestNormalNewGame(settings, invoker) { calls.push([settings.mode, settings.humanSide, invoker.id]); return true; },
  });
  assert.equal(context.changeHumanSide(BLACK), true);
  assert.equal(context.humanSide, RED);
  assert.deepEqual(calls, [['medium', BLACK, 'humanSideBlack']]);
  assert.match(functionSource('newGame'), /if \(resetHumanSide\) humanSide = RED;/u);
  assert.match(functionSource('newGame'), /if \(reconcileHumanSideCamera\) showPlayerPerspective\(humanSide\);/u);
  assert.match(functionSource('showPlayerPerspective'), /side === BLACK \? 4 : 2/u);
  assert.match(source, /newGame\(\{ reconcileHumanSideCamera: false \}\);/u);
});

test('PSS-REV-01: the latest authoritative side owns the camera after rapid game resets', () => {
  const context = installMany(['commitNormalNewGame', 'initializeNormalGamePosition', 'newGame'], {
    normalGameActive: () => true,
    isAI: () => true,
    humanSide: BLACK,
    modeSel: { value: 'medium' },
    tweens: [{ tag: 'camera', target: BLACK }],
    aiToken: 0,
    aiThinking: false,
    history: [{}],
    capturedBy: { [RED]: [], [BLACK]: [] },
    over: false,
    winner: null,
    busy: false,
    board: null,
    turn: BLACK,
    posHistory: [],
    repHistory: [],
    gameStartTime: 0,
    undoCount: 1,
    initialBoard: () => [['fresh']],
    hashBoard: () => 'fresh-position',
    invalidateTeachingModeFeedback() {},
    invalidateNormalAI() { context.aiToken++; context.aiThinking = false; },
    clearTimeout() {}, gameOverTimer: null, customRematchUnlockTimer: null,
    customRematchLock: null, customGameContext: null,
    document: { getElementById: () => ({ close() {} }) },
    showBanner() {}, clearSelection() {},
    beginNormalGameRecordSession() {},
    stopConfetti() {},
    overlay: { classList: { add() {} } },
    banner: { classList: { add() {} } },
    logEl: { innerHTML: 'old' },
    logEmpty: { style: { display: 'none' } },
    syncLastMoveMark() {},
    buildScene() {},
    refreshHUD() {},
    showPlayerPerspective(side) {
      context.tweens.push({ tag: 'camera', target: side });
    },
    maybeAIMove() {},
  });

  context.commitNormalNewGame({ mode: 'medium', humanSide: RED });
  context.newGame();
  assert.equal(context.humanSide, RED);
  assert.equal(context.turn, RED);
  assert.equal(context.history.length, 0);
  assert.deepEqual(context.tweens.map(({ target }) => target), [RED]);

  context.commitNormalNewGame({ mode: 'medium', humanSide: BLACK });
  context.commitNormalNewGame({ mode: 'medium', humanSide: RED });
  context.commitNormalNewGame({ mode: 'medium', humanSide: BLACK });
  assert.deepEqual(context.tweens.map(({ target }) => target), [BLACK]);
});

test('teaching, result and capture attribution follow the selected human actor', () => {
  assert.match(functionSource('captureTeachingModeSource'), /computerSide: aiSide\(\)/u);
  assert.match(functionSource('finishMove'), /if \(mover === humanSide\) requestGameTeachingModeAnalysis/u);
  assert.match(functionSource('showGameOver'), /winner === humanSide/u);
  assert.match(functionSource('showGameOver'), /capturedBy\[humanSide\]\.length/u);
});
