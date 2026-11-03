import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityFixture } from './tools/idb-capacity-fixture.mjs';
import { createCustomPositionIDB, validateCustomPositionIDBState, observeCustomPositionOperation } from './custom-position-idb.js';

test('full window replay leaves input, base, rows and pieces isolated', () => {
  const input = capacityFixture(), before = structuredClone(input);
  const state = validateCustomPositionIDBState(input.envelope, input.metadata);
  assert.deepEqual(input, before);
  assert.equal(state.envelope.positions.length, 100);
  assert.equal(state.metadata.commits.length, 128);
  assert.equal(state.metadata.baseEnvelope.revision, 2);
  input.metadata.commits[0].delta.after.initialBoard[0][0].type = 'P';
  input.envelope.positions[0].title = 'changed';
  assert.deepEqual(state, before);
  assert.throws(() => state.metadata.commits[0].delta.after.initialBoard[0][0].type = 'P', TypeError);
});

test('known frozen snapshot reuse does not trust a frozen caller-created lookalike', () => {
  const fixture = capacityFixture(), state = validateCustomPositionIDBState(fixture.envelope, fixture.metadata);
  const adapter = createCustomPositionIDB();
  assert.ok(adapter.prepare(state, { type: 'rename', id: 'seed-0', title: 'safe' }));
  const forged = structuredClone(state);
  forged.metadata.commits[0].delta.after.title = 'corrupt';
  Object.freeze(forged);
  assert.throws(() => adapter.prepare(forged, { type: 'rename', id: 'seed-0', title: 'unsafe' }));
  assert.equal(observeCustomPositionOperation(forged, state.metadata.commits.at(-1).operation).status, 'UNKNOWN');
});

test('shared canonical snapshots cannot be mutated through a prepared command', () => {
  const fixture = capacityFixture(), state = validateCustomPositionIDBState(fixture.envelope, fixture.metadata);
  const adapter = createCustomPositionIDB(), command = { type: 'preferences', id: 'seed-0', preferences: { humanSide: 'red', difficulty: 'hard' } };
  const token = adapter.prepare(state, command);
  command.preferences.humanSide = 'black';
  assert.equal(token.command.preferences.humanSide, 'red');
  assert.deepEqual(state, fixture);
  assert.throws(() => token.command.preferences.difficulty = 'easy', TypeError);
});

test('large legal fields and full-piece boards remain valid under the unchanged 1 MiB bound', () => {
  const fixture = capacityFixture(100, true), state = validateCustomPositionIDBState(fixture.envelope, fixture.metadata);
  assert.equal(state.envelope.positions.length, 100);
  for (const p of state.envelope.positions) {
    assert.equal(p.id.length, 128);
    assert.equal([...p.title].length, 60);
    assert.equal(p.initialBoard.flat().filter(Boolean).length, 32);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(state.envelope)) > 180000);
  assert.ok(Buffer.byteLength(JSON.stringify(state.envelope)) < 1024 * 1024);
});

test('schema field limits make a legal 1 MiB envelope unreachable even at the conservative board upper bound', () => {
  // Deliberately overestimates: 90 black pieces exceed legal counts, but every
  // valid cell serializes to no more bytes. BMP IDs maximize bytes per UTF-16
  // unit; astral titles maximize bytes per permitted Unicode code point.
  const record = { id: '界'.repeat(128), title: '🀄'.repeat(60),
    initialBoard: Array.from({ length: 10 }, () => Array.from({ length: 9 }, () => ({ type: 'K', side: 'black' }))),
    sideToMove: 'black', createdAt: '9999-12-31T23:59:59.999Z', updatedAt: '9999-12-31T23:59:59.999Z',
    playPreferences: { humanSide: 'black', difficulty: 'medium' } };
  const upper = { version: 1, revision: Number.MAX_SAFE_INTEGER, positions: Array(100).fill(record) };
  assert.ok(Buffer.byteLength(JSON.stringify(upper)) < 1024 * 1024);
  assert.throws(() => validateCustomPositionIDBState(upper, capacityFixture().metadata));
});
