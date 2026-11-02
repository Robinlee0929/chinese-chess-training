import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { initialBoard, legalMoves, applyMove } from './game.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name);
  return match[0].replaceAll('import.meta.url', JSON.stringify(new URL('./main.js', import.meta.url).href));
};
function harness({ workerFails = false, postFails = false } = {}) {
  const workers = [], moves = [], messages = [], timers = new Map(), scheduled = [];
  let timerId = 0;
  const ctx = vm.createContext({
    board: initialBoard(), turn: 'black', mode: 'medium', posHistory: ['root'],
    aiToken: 0, aiRequest: null, aiWorker: null, aiModule: null,
    normalGameRecordSession: { id: 'first' }, customRematchRequest: null,
    over: false, busy: false, aiThinking: false, aiMoveStart: 0,
    normalGameActive: () => ctx.appState === 'NORMAL_GAME', appState: 'NORMAL_GAME',
    isAI: () => ctx.mode !== 'pvp', aiSide: () => 'black', legalMoves,
    performance: { now: () => 100 }, URL,
    refreshHUD() {}, toast: message => messages.push(message),
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); scheduled.push(fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    doMove(from, to) { moves.push({ from, to }); applyMove(ctx.board, from, to); ctx.turn = 'red'; },
    Worker: class {
      constructor() { if (workerFails) throw new Error('worker unavailable'); workers.push(this); this.posts = []; }
      postMessage(payload) { if (postFails) throw new Error('post failed'); this.posts.push(payload); }
      terminate() { this.terminated = true; }
    },
  });
  for (const name of ['invalidateNormalAI', 'currentAIRequest', 'startAIFallback',
    'requestAIMove', 'maybeAIMove', 'onAIResult']) vm.runInContext(functionSource(name), ctx);
  const reply = { from: { r: 6, c: 0 }, to: { r: 5, c: 0 } };
  const deliver = worker => worker.onmessage({ data: { token: worker.posts[0].token, result: reply } });
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  const replaceSession = () => {
    ctx.invalidateNormalAI(); ctx.normalGameRecordSession = { id: 'second' };
    ctx.board = initialBoard(); ctx.turn = 'black';
  };
  return { ctx, workers, moves, messages, timers, scheduled, reply, deliver, flush, replaceSession };
}
const microtasks = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('Phase C AI: scheduler and duplicate worker messages commit exactly one move', () => {
  const h = harness(); h.ctx.maybeAIMove(); h.ctx.maybeAIMove(); h.ctx.requestAIMove();
  assert.equal(h.workers.length, 1); assert.equal(h.workers[0].posts.length, 1);
  h.deliver(h.workers[0]); h.deliver(h.workers[0]);
  assert.equal(h.timers.size, 1); h.flush();
  assert.equal(h.moves.length, 1); assert.equal(h.ctx.aiThinking, false);
});

test('Phase C AI: stale worker response and onerror cannot start fallback or alter a new session', () => {
  const h = harness(); h.ctx.maybeAIMove();
  const old = h.workers[0], message = old.onmessage, error = old.onerror, token = old.posts[0].token;
  h.replaceSession(); h.ctx.maybeAIMove();
  assert.equal(old.terminated, true); assert.notEqual(h.ctx.aiWorker, old);
  message({ data: { token, result: h.reply } }); error(); h.flush();
  assert.equal(h.moves.length, 0); assert.equal(h.workers.length, 2);
  assert.equal(h.ctx.aiModule, null); assert.equal(h.ctx.aiRequest.fallbackStarted, false);
  h.deliver(h.workers[1]); h.flush(); assert.equal(h.moves.length, 1);
});

test('Phase C AI: session identity rejects a response even if token is made equal', () => {
  const h = harness(); h.ctx.maybeAIMove();
  h.ctx.normalGameRecordSession = { id: 'different' };
  h.deliver(h.workers[0]); h.flush(); assert.equal(h.moves.length, 0);
});

test('Phase C AI: a different worker cannot deliver a current token', () => {
  const h = harness(); h.ctx.maybeAIMove();
  h.ctx.onAIResult({ token: h.ctx.aiToken, result: h.reply }, h.ctx.aiRequest, {});
  h.flush(); assert.equal(h.moves.length, 0);
  h.deliver(h.workers[0]); h.flush(); assert.equal(h.moves.length, 1);
});

function delayedResultAssertion(h) {
  h.ctx.maybeAIMove(); h.deliver(h.workers[0]);
  const staleCallback = h.scheduled.at(-1);
  h.replaceSession(); h.ctx.maybeAIMove();
  assert.equal(h.timers.size, 0, 'invalidate cancels the old delivery timer');
  staleCallback(); // Model a callback already queued by the browser.
  assert.equal(h.moves.length, 0, 'queued old AI result must not move on the replacement board');
}
test('Phase C AI: canceled and already-queued delayed results are both harmless', () => delayedResultAssertion(harness()));

test('Phase C negative control: accepting stale delayed AI fails a move-count assertion', () => {
  const h = harness();
  vm.runInContext('function currentAIRequest(request) { return !!request; }', h.ctx);
  assert.throws(() => delayedResultAssertion(h), { code: 'ERR_ASSERTION' });
});

for (const failure of ['constructor', 'post', 'error']) {
  test(`Phase C AI: ${failure} failure uses the same request for exactly one fallback`, async () => {
    const h = harness({ workerFails: failure === 'constructor', postFails: failure === 'post' });
    let searches = 0;
    h.ctx.aiModule = Promise.resolve({ findBestMove: () => { searches++; return h.reply; } });
    h.ctx.maybeAIMove(); const token = h.ctx.aiToken;
    if (failure === 'error') {
      const error = h.workers[0].onerror; error(); error();
      assert.equal(h.workers[0].terminated, true);
    }
    await microtasks(); h.flush(); h.flush();
    assert.equal(h.ctx.aiToken, token); assert.equal(searches, 1); assert.equal(h.moves.length, 1);
    assert.equal(h.messages.length, 0);
  });
}

for (const phase of ['import', 'search-timer', 'result-timer']) {
  test(`Phase C AI: replacing a session during fallback ${phase} prevents stale work`, async () => {
    const h = harness({ workerFails: true });
    let resolveModule, searches = 0;
    const module = { findBestMove: () => { searches++; return h.reply; } };
    h.ctx.aiModule = new Promise(resolve => { resolveModule = resolve; });
    h.ctx.maybeAIMove();
    if (phase !== 'import') { resolveModule(module); await microtasks(); }
    if (phase === 'result-timer') h.flush();
    const queued = [...h.timers.values()];
    h.replaceSession(); resolveModule(module); await microtasks();
    queued.forEach(fn => fn()); h.flush();
    assert.equal(h.moves.length, 0); assert.equal(searches, phase === 'result-timer' ? 1 : 0);
  });
}

test('Phase C AI: duplicate error after a valid result cannot search again', async () => {
  const h = harness(); h.ctx.maybeAIMove();
  const error = h.workers[0].onerror;
  h.deliver(h.workers[0]); error(); await microtasks(); h.flush();
  assert.equal(h.moves.length, 1); assert.equal(h.ctx.aiModule, null);
  assert.equal(h.workers[0].terminated, true); assert.equal(h.ctx.aiWorker, null);
});

test('Phase C AI: error from an idle worker retires it so the next turn can recreate it', () => {
  const h = harness(); h.ctx.maybeAIMove();
  const error = h.workers[0].onerror;
  h.deliver(h.workers[0]); h.flush(); error();
  assert.equal(h.workers[0].terminated, true); assert.equal(h.ctx.aiModule, null);
  h.ctx.turn = 'black'; h.ctx.maybeAIMove();
  assert.equal(h.workers.length, 2); assert.equal(h.workers[1].posts.length, 1);
});

test('Phase C AI: malformed/error response fails once without leaving AI stuck thinking', () => {
  for (const response of [{ error: true }, { result: { from: null, to: null } }]) {
    const h = harness(); h.ctx.maybeAIMove();
    const worker = h.workers[0];
    worker.onmessage({ data: { token: h.ctx.aiToken, ...response } }); h.flush();
    worker.onmessage({ data: { token: h.ctx.aiToken, ...response } }); h.flush();
    assert.equal(h.ctx.aiThinking, false); assert.equal(h.moves.length, 0);
    assert.equal(h.messages.length, 1);
  }
});
