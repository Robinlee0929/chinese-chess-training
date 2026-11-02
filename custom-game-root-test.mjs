import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { initialBoard, applyMove, RED, BLACK } from './game.js';
import { createEditorState } from './puzzle-editor.js';
import {
  createCustomGameRoot, createMutableCustomGamePosition, CustomGameRootError,
} from './custom-position-play.js';

const position = (sideToMove = RED) => ({ initialBoard: initialBoard(), sideToMove });
const settings = (humanSide = BLACK, difficulty = 'medium') => ({ humanSide, difficulty });

function assertDistinct(actual, source) {
  assert.notStrictEqual(actual, source, 'BOARD_ISOLATION');
  for (let r = 0; r < 10; r++) {
    assert.notStrictEqual(actual[r], source[r], 'ROW_ISOLATION');
    for (let c = 0; c < 9; c++) if (source[r][c]) {
      assert.notStrictEqual(actual[r][c], source[r][c], 'PIECE_ISOLATION');
    }
  }
}

function assertFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertFrozen(child);
}

for (const sideToMove of [RED, BLACK]) for (const humanSide of [RED, BLACK]) {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    test(`root independently preserves ${sideToMove} turn / ${humanSide} human / ${difficulty}`, () => {
      const input = position(sideToMove);
      const configuration = settings(humanSide, difficulty);
      const root = createCustomGameRoot(input, configuration, {
        savedPositionId: 'position-1', sourceRecordId: 'completed-source',
      });
      assert.deepEqual(root, {
        initialPosition: { board: input.initialBoard, sideToMove },
        settings: configuration, savedPositionId: 'position-1', sourceRecordId: 'completed-source',
      });
      assertDistinct(root.initialPosition.board, input.initialBoard);
      assert.notStrictEqual(root.settings, configuration);
      assertFrozen(root);
      assert.equal(Object.isFrozen(input.initialBoard), false);
      configuration.humanSide = 'white';
      input.initialBoard[0][0].type = 'P';
      assert.equal(root.settings.humanSide, humanSide);
      assert.equal(root.initialPosition.board[0][0].type, 'R');
    });
  }
}

test('editor source remains isolated, including stripped piece metadata', () => {
  const board = initialBoard();
  board[0][0].metadata = { note: 'editor only' };
  const editor = createEditorState({ board, sideToMove: BLACK });
  const root = createCustomGameRoot({ initialBoard: editor.board, sideToMove: editor.sideToMove }, settings());
  assertDistinct(root.initialPosition.board, editor.board);
  assert.deepEqual(root.initialPosition.board[0][0], { type: 'R', side: RED });
  assert.equal(root.savedPositionId, null);
  assert.equal(root.sourceRecordId, null);
  assert.throws(() => { root.initialPosition.board[0][0].type = 'P'; }, TypeError);
  assert.throws(() => { root.initialPosition.board[0][0] = null; }, TypeError);
  assert.throws(() => { root.settings.difficulty = 'hard'; }, TypeError);
  assert.throws(() => { root.sourceRecordId = 'different'; }, TypeError);
});

test('every mutable position is detached from root, source and previous games', () => {
  const input = position();
  const before = structuredClone(input);
  const root = createCustomGameRoot(input, settings());
  const first = createMutableCustomGamePosition(root);
  const second = createMutableCustomGamePosition(root);
  assertDistinct(first.board, root.initialPosition.board);
  assertDistinct(first.board, second.board);
  applyMove(first.board, { r: 3, c: 0 }, { r: 4, c: 0 });
  first.board[0][0].type = 'P';
  first.sideToMove = BLACK;
  // Even if the editor/source has since moved, the root stays at capture time.
  applyMove(input.initialBoard, { r: 3, c: 2 }, { r: 4, c: 2 });
  const third = createMutableCustomGamePosition(root);
  assert.deepEqual(third, { board: before.initialBoard, sideToMove: before.sideToMove });
  assert.deepEqual(second, third);
  assert.deepEqual(root.initialPosition, third);
  assert.equal(Object.isFrozen(third.board[0][0]), false);
  assert.equal(Object.isFrozen(third.board[0]), false);
  assert.equal(Object.isFrozen(third.board), false);
});

test('invalid positions, configurations and provenance fail before producing a root', () => {
  const invalid = position(); invalid.initialBoard[0][4] = null;
  for (const input of [null, {}, invalid, { ...position(), sideToMove: 'white' }]) {
    assert.throws(() => createCustomGameRoot(input, settings()), CustomGameRootError);
  }
  for (const configuration of [null, {}, settings('white'), settings(RED, 'pvp')]) {
    assert.throws(() => createCustomGameRoot(position(), configuration), { code: 'INVALID_CONFIGURATION' });
  }
  for (const key of ['savedPositionId', 'sourceRecordId']) for (const id of ['', ' x ', 1, {}]) {
    assert.throws(() => createCustomGameRoot(position(), settings(), { [key]: id }), { code: 'INVALID_PROVENANCE_ID' });
  }
  assert.throws(() => createMutableCustomGamePosition(null), CustomGameRootError);
});

async function mutatedModule(before, after) {
  const url = new URL('./custom-position-play.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'exactly one production mutation site');
  const changed = source.replace(before, after).replace(/from '(\.\/[^']+)'/g,
    (_, specifier) => `from '${new URL(specifier, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
}

test('negative control: removing root copying is caught by the same isolation assertion', async () => {
  const mutant = await mutatedModule('const initialPosition = validation.position;',
    'const initialPosition = { board: position.initialBoard, sideToMove: position.sideToMove };');
  const input = position();
  const root = mutant.createCustomGameRoot(input, settings());
  assert.deepEqual(root.initialPosition.board, initialBoard(), 'mutant loads and produces a valid board');
  assert.throws(() => assertDistinct(root.initialPosition.board, input.initialBoard),
    error => error.code === 'ERR_ASSERTION' && /BOARD_ISOLATION/.test(error.message));
});

test('negative control: reusing frozen root as a mutable game is caught behaviorally', async () => {
  const mutant = await mutatedModule('return validation.position;', 'return root.initialPosition;');
  const root = mutant.createCustomGameRoot(position(), settings());
  const mutable = mutant.createMutableCustomGamePosition(root);
  assert.deepEqual(mutable, root.initialPosition, 'mutant factory executes successfully');
  assert.throws(() => assertDistinct(mutable.board, root.initialPosition.board),
    error => error.code === 'ERR_ASSERTION' && /BOARD_ISOLATION/.test(error.message));
});
