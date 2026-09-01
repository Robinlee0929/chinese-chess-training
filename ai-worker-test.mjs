import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('./ai-worker.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/m, 'const findBestMove = globalThis.findBestMove;\n');

function harness() {
  const calls = [];
  const messages = [];
  const context = vm.createContext({
    Date,
    findBestMove(...args) {
      calls.push(args);
      return { from: { r: 1, c: 2 }, to: { r: 3, c: 4 }, score: 17, depth: 2 };
    },
    self: {
      postMessage(message) { messages.push(message); },
      onmessage: null,
    },
  });
  vm.runInContext(workerSource, context);
  return { context, calls, messages };
}

test('normal-game worker messages preserve the existing findBestMove arguments and result envelope', () => {
  const { context, calls, messages } = harness();
  const board = [[null]];
  context.self.onmessage({ data: {
    kind: 'normal-game', board, side: 'black', level: 'medium', token: 41, recent: ['position-a'],
  } });

  assert.deepEqual(calls, [[board, 'black', 'medium', ['position-a']]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].token, 41);
  assert.deepEqual(messages[0].result, {
    from: { r: 1, c: 2 }, to: { r: 3, c: 4 }, score: 17, depth: 2,
  });
  assert.equal(typeof messages[0].timeMs, 'number');
  assert.equal('kind' in messages[0], false, 'normal result envelope stays backward compatible');
});

test('legacy untyped normal messages remain compatible', () => {
  const { context, calls, messages } = harness();
  context.self.onmessage({ data: {
    board: [], side: 'red', level: 'easy', token: 7, recent: [],
  } });
  assert.deepEqual(calls[0], [[], 'red', 'easy', []]);
  assert.equal(messages[0].token, 7);
});

test('review-candidate messages route to review-v1 options and echo only Review identity', () => {
  const { context, calls, messages } = harness();
  const prefix = [{ key: 'board|red', mover: null, check: false }];
  context.self.onmessage({ data: {
    kind: 'review-candidate',
    recordId: 'record-a',
    ply: 3,
    revision: 9,
    board: [],
    sideToMove: 'red',
    repetitionPrefix: prefix,
    analysisPreset: 'review-v1',
  } });

  assert.deepEqual(structuredClone(calls[0]), [[], 'red', 'review-v1', [], { repetitionPrefix: prefix }]);
  assert.equal(messages[0].kind, 'review-candidate');
  assert.equal(messages[0].recordId, 'record-a');
  assert.equal(messages[0].ply, 3);
  assert.equal(messages[0].revision, 9);
  assert.equal('token' in messages[0], false);
});
