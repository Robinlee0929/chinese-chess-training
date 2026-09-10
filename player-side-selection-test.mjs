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
  const context = vm.createContext({ RED, BLACK, ...values });
  vm.runInContext(functionSource(name), context);
  return context;
}

test('renders one native AI-only player-side selector with the approved labels', () => {
  assert.equal((html.match(/id="sideChooser"/gu) || []).length, 1);
  assert.match(html, /<fieldset id="sideChooser"[^>]*>[\s\S]*<legend>選擇你的棋色<\/legend>/u);
  assert.match(html, /name="humanSide" value="red" checked>[\s\S]*紅方・先手/u);
  assert.match(html, /name="humanSide" value="black">[\s\S]*黑方・後手/u);
  assert.match(css, /\.side-chooser input:focus-visible \+ label/u);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.side-chooser label \{ min-height: 44px/u);
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
  const context = install('onAIResult', {
    aiToken: 9,
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

test('side changes restart cleanly, orient the camera, and generic resets return to Red', () => {
  const calls = [];
  const context = install('changeHumanSide', {
    normalGameActive: () => true,
    isAI: () => true,
    humanSide: RED,
    newGame(options) { calls.push(['new', options.resetHumanSide]); },
    showPlayerPerspective(side) { calls.push(['camera', side]); },
  });
  assert.equal(context.changeHumanSide(BLACK), true);
  assert.equal(context.humanSide, BLACK);
  assert.deepEqual(calls, [['new', false], ['camera', BLACK]]);
  assert.match(functionSource('newGame'), /if \(resetHumanSide\) humanSide = RED;/u);
  assert.match(functionSource('showPlayerPerspective'), /side === BLACK \? 1 : 0/u);
});

test('teaching, result and capture attribution follow the selected human actor', () => {
  assert.match(functionSource('captureTeachingModeSource'), /computerSide: aiSide\(\)/u);
  assert.match(functionSource('finishMove'), /if \(mover === humanSide\) requestGameTeachingModeAnalysis/u);
  assert.match(functionSource('showGameOver'), /winner === humanSide/u);
  assert.match(functionSource('showGameOver'), /capturedBy\[humanSide\]\.length/u);
});
