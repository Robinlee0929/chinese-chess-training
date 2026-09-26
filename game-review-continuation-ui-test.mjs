import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { initialBoard, RED, BLACK } from './game.js';
import * as domain from './game-review-continuation.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function harness() {
  const nodes = new Map();
  let activeElement;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, open: false, focus() { activeElement = this; },
      showModal() { this.open = true; }, close() { this.open = false; } });
    return nodes.get(id);
  };
  const ctx = vm.createContext({ ...domain, RED, BLACK,
    APP_STATE: { GAME_REVIEW: 'GAME_REVIEW' }, appState: 'GAME_REVIEW',
    gameReviewSession: { sourceKind: 'completed', selectedPly: 3, record: { mode: 'hard' },
      snapshot: { board: initialBoard(), sideToMove: BLACK, terminal: null } },
    gameReviewContinuationSource: null,
    document: { getElementById: node },
  });
  for (const name of ['renderGameReviewContinuation', 'openGameReviewContinuation', 'cancelGameReviewContinuation']) {
    const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match); vm.runInContext(match[0], ctx);
  }
  return { ctx, node, focused: () => activeElement?.id };
}

test('actual continuation controls display selected ply, difficulty and newly chosen player side', () => {
  const {ctx,node,focused} = harness();
  assert.equal(ctx.openGameReviewContinuation(), true);
  assert.match(node('gameReviewContinuationPosition').textContent, /第 3 著後・輪到：黑方/);
  assert.equal(node('gameReviewContinuationDifficulty').value,'hard');
  assert.equal(node('gameReviewContinuationHumanSide').value, BLACK);
  assert.equal(node('gameReviewContinuationDialog').open,true);
  assert.equal(focused(),'gameReviewContinuationDifficulty');
});

test('actual cancellation keeps the same review and returns focus without any transition', () => {
  const {ctx,node,focused} = harness(); const before = ctx.gameReviewSession;
  ctx.openGameReviewContinuation(); ctx.cancelGameReviewContinuation();
  assert.equal(ctx.gameReviewSession,before);
  assert.equal(ctx.appState,'GAME_REVIEW');
  assert.equal(node('gameReviewContinuationDialog').open,false);
  assert.equal(ctx.gameReviewContinuationSource,null);
  assert.equal(focused(),'btnGameReviewContinue');
});

test('actual disabled explanations cover terminal and live teaching review', () => {
  const {ctx,node} = harness();
  ctx.gameReviewSession.snapshot.terminal = {};
  ctx.renderGameReviewContinuation();
  assert.equal(node('btnGameReviewContinue').disabled,true);
  assert.match(node('gameReviewContinueReason').textContent,/已終局/);
  ctx.gameReviewSession.sourceKind = 'live-teaching';
  ctx.gameReviewSession.snapshot.terminal = null;
  ctx.renderGameReviewContinuation();
  assert.equal(node('btnGameReviewContinue').disabled,true);
  assert.match(node('gameReviewContinueReason').textContent,/進行中的教學對局/);
  assert.equal(ctx.openGameReviewContinuation(),false);
});

test('global Review keyboard shortcuts cannot exit or navigate behind an open configuration modal', () => {
  const {ctx,node} = harness();
  const match = source.match(/document\.addEventListener\('keydown', \(e\) => \{([^]*?)\n\}\);/);
  assert.ok(match);
  vm.runInContext(`function keyboard(e) {${match[1]}\n}`,ctx);
  let transitions = 0;
  ctx.exitGameReview = () => transitions++;
  ctx.navigateGameReview = () => transitions++;
  ctx.closeHudMenu = () => {};
  node('gameReviewContinuationDialog').open = true;
  for (const key of ['Escape','ArrowLeft','ArrowRight','Home','End']) ctx.keyboard({key});
  assert.equal(transitions,0);
  node('gameReviewContinuationDialog').open = false;
  ctx.keyboard({key:'Escape'});
  assert.equal(transitions,1);
});
