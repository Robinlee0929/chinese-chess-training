import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('./ai-worker.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/m, 'const findBestMove = globalThis.findBestMove;\n');

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function normalRequest(overrides = {}) {
  return {
    kind: 'normal-game',
    board: emptyBoard(),
    side: 'black',
    level: 'medium',
    token: 41,
    recent: ['position-a'],
    ...overrides,
  };
}

function reviewRequest(overrides = {}) {
  return {
    kind: 'review-candidate',
    recordId: 'record-a',
    ply: 3,
    revision: 9,
    board: emptyBoard(),
    sideToMove: 'red',
    repetitionPrefix: [{ key: 'board|red', mover: null, check: false }],
    analysisPreset: 'review-v1',
    ...overrides,
  };
}

function harness(source = workerSource) {
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
  vm.runInContext(source, context);
  return { context, calls, messages };
}

test('normal-game worker messages preserve the existing findBestMove arguments and result envelope', () => {
  const { context, calls, messages } = harness();
  const message = normalRequest();
  context.self.onmessage({ data: message });

  assert.deepEqual(calls, [[message.board, 'black', 'medium', ['position-a']]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].token, 41);
  assert.deepEqual(messages[0].result, {
    from: { r: 1, c: 2 }, to: { r: 3, c: 4 }, score: 17, depth: 2,
  });
  assert.equal(typeof messages[0].timeMs, 'number');
  assert.equal('kind' in messages[0], false, 'normal result envelope stays backward compatible');
});

test('legacy normal messages remain compatible only when kind is absent', () => {
  const { context, calls, messages } = harness();
  const message = normalRequest({ kind: undefined, side: 'red', level: 'easy', token: 7, recent: [] });
  delete message.kind;
  context.self.onmessage({ data: message });

  assert.deepEqual(calls[0], [message.board, 'red', 'easy', []]);
  assert.equal(messages[0].token, 7);
});

test('review-candidate messages route to review-v1 options and echo only Review identity', () => {
  const { context, calls, messages } = harness();
  const message = reviewRequest();
  context.self.onmessage({ data: message });

  assert.deepEqual(structuredClone(calls[0]), [
    message.board,
    'red',
    'review-v1',
    [],
    { repetitionPrefix: message.repetitionPrefix },
  ]);
  assert.equal(messages[0].kind, 'review-candidate');
  assert.equal(messages[0].recordId, 'record-a');
  assert.equal(messages[0].ply, 3);
  assert.equal(messages[0].revision, 9);
  assert.equal('token' in messages[0], false);
});

test('unknown kinds never fall through to normal search', () => {
  const { context, calls, messages } = harness();
  context.self.onmessage({ data: normalRequest({ kind: 'future-request' }) });

  assert.equal(calls.length, 0);
  assert.deepEqual(structuredClone(messages), [{ kind: 'worker-error', error: 'unsupported-request', token: 41 }]);
});

test('malformed payloads and malformed kind values are rejected without throwing or searching', () => {
  const inputs = [
    null,
    [],
    'bad',
    42,
    {},
    normalRequest({ kind: '' }),
    normalRequest({ kind: null }),
    normalRequest({ kind: 123 }),
    { board: emptyBoard(), side: 'red' },
  ];

  for (const input of inputs) {
    const { context, calls, messages } = harness();
    assert.doesNotThrow(() => context.self.onmessage({ data: input }));
    assert.equal(calls.length, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].error, 'unsupported-request');
  }
});

test('partial review requests preserve correlation identity but never search', () => {
  const { context, calls, messages } = harness();
  context.self.onmessage({ data: reviewRequest({ board: [[null]] }) });

  assert.equal(calls.length, 0);
  assert.deepEqual(structuredClone(messages), [{
    kind: 'review-candidate',
    recordId: 'record-a',
    ply: 3,
    revision: 9,
    error: 'unsupported-request',
  }]);
});

test('negative control: unknown-kind fallthrough is detected', () => {
  const brokenSource = workerSource.replace(
    "const explicitNormal = message.kind === 'normal-game';",
    'const explicitNormal = true;',
  );
  const { context, calls } = harness(brokenSource);
  context.self.onmessage({ data: normalRequest({ kind: 'future-request' }) });

  let expectedFailure = false;
  try {
    assert.equal(calls.length, 0);
  } catch {
    expectedFailure = true;
  }
  assert.equal(expectedFailure, true, 'EXPECTED_FAIL: detector must reject unknown-kind fallthrough');
});

test('negative control: an uncaught null payload is detected', () => {
  const brokenSource = workerSource.replace(
    "if (!message || typeof message !== 'object' || Array.isArray(message)) {",
    'if (false) {',
  );
  const { context } = harness(brokenSource);

  let expectedFailure = false;
  try {
    assert.doesNotThrow(() => context.self.onmessage({ data: null }));
  } catch {
    expectedFailure = true;
  }
  assert.equal(expectedFailure, true, 'EXPECTED_FAIL: detector must reject uncaught null input');
});
