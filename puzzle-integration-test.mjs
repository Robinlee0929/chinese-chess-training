import assert from 'node:assert/strict';
import test from 'node:test';
import { RED, BLACK } from './game.js';
import { createPuzzle, isCheckmateAfterSolution } from './puzzle-domain.js';
import { createEditorState, placeEditorPiece, confirmAuthoredPosition } from './puzzle-editor.js';
import { createRecorder, recordMove, undoRecordedMove, finishRecording } from './puzzle-recorder.js';
import { createPuzzleStore, PUZZLE_STORAGE_KEY } from './puzzle-store.js';
import { serializePuzzleExport, parsePuzzleImport } from './puzzle-transfer.js';
import { createPractice, attemptPracticeMove, applyOpponentReply, restartPractice } from './puzzle-practice.js';
import { createReviewState, confirmPiece, acceptHighConfidenceEmpty, buildReviewedBoard } from './puzzle-photo-review.js';

// Known three-ply mate with a defending capture and a final attacking capture.
// This is a fixed regression fixture, not a solver or generated puzzle.
const placements = [
  [9, 4, BLACK, 'K'], [0, 3, RED, 'K'], [8, 0, RED, 'R'],
  [6, 8, RED, 'R'], [5, 3, RED, 'P'], [3, 0, RED, 'P'],
  [5, 6, RED, 'P'], [6, 6, BLACK, 'P'], [9, 8, BLACK, 'P'],
];
const line = [
  [{ r: 3, c: 0 }, { r: 4, c: 0 }],
  [{ r: 6, c: 6 }, { r: 5, c: 6 }],
  [{ r: 6, c: 8 }, { r: 9, c: 8 }],
];

function authored() {
  return placements.reduce((state, [r, c, side, type]) => (
    placeEditorPiece(state, { side, type }, { r, c })
  ), createEditorState());
}

test('editor → recorder/undo → Puzzle → storage roundtrip → practice/captures/metadata', () => {
  const editor = authored();
  const confirmed = confirmAuthoredPosition(editor);
  assert.equal(confirmed.ok, true);
  let recorder = createRecorder(confirmed.position);
  recorder = recordMove(recorder, ...line[0]);
  const beforeCapture = recorder;
  recorder = recordMove(recorder, ...line[1]);
  assert.equal(recorder.records[1].captured.side, RED);
  recorder = undoRecordedMove(recorder);
  assert.deepEqual(recorder, beforeCapture);
  recorder = recordMove(recorder, ...line[1]);
  recorder = recordMove(recorder, ...line[2]);
  assert.equal(recorder.records[2].captured.side, BLACK);
  const finished = finishRecording(recorder);
  assert.equal(finished.checkmate, true);
  const puzzle = createPuzzle({ id: 'release-fixture', title: 'P12 三著雙吃', ...finished.result });
  assert.equal(isCheckmateAfterSolution(puzzle), true);

  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const store = createPuzzleStore({ storage, idFactory: () => 'p12-fixture' });
  const saved = store.savePuzzle(puzzle.toJSON());
  const serialized = memory.get(PUZZLE_STORAGE_KEY);
  const reloadedStore = createPuzzleStore({ storage });
  const loaded = reloadedStore.getPuzzle(saved.id);
  assert.deepEqual(loaded, saved);
  assert.equal(JSON.parse(serialized).version, 1);
  loaded.initialBoard[0][3].type = 'R';
  assert.equal(reloadedStore.getPuzzle(saved.id).initialBoard[0][3].type, 'K');

  let practice = createPractice(reloadedStore.getPuzzle(saved.id));
  reloadedStore.markPracticeStarted(saved.id);
  const wrong = attemptPracticeMove(practice, { r: 8, c: 0 }, { r: 7, c: 0 });
  assert.equal(wrong.error.code, 'WRONG_MOVE');
  assert.deepEqual(wrong.practice.currentBoard, practice.currentBoard);
  practice = attemptPracticeMove(wrong.practice, ...line[0]).practice;
  const reply = applyOpponentReply(practice);
  assert.equal(reply.captured.side, RED);
  const final = attemptPracticeMove(reply.practice, ...line[2]);
  assert.equal(final.captured.side, BLACK);
  assert.equal(final.complete, true);
  assert.equal(final.practice.mistakes, 1);
  reloadedStore.markPracticeCompleted(saved.id);
  const persisted = createPuzzleStore({ storage }).getPuzzle(saved.id);
  assert.equal(persisted.practiceCount, 1);
  assert.equal(persisted.completedCount, 1);
  assert.ok(persisted.lastPracticedAt);
  assert.deepEqual(restartPractice(final.practice).currentBoard, editor.board);
  assert.deepEqual(persisted.initialBoard, editor.board);
  assert.equal(isCheckmateAfterSolution(persisted), true);
});

test('explicit photo review → editor confirmation → existing recorder contract', () => {
  const expected = authored().board;
  const candidates = expected.flatMap((row, r) => row.map((piece, c) => ({
    r, c, occupancy: piece ? 'uncertain' : 'empty', occupancyConfidence: piece ? 0.3 : 0.9,
    suggestedSide: 'unknown', sideConfidence: 0,
  })));
  let review = acceptHighConfidenceEmpty(createReviewState(candidates));
  for (const [r, c, side, type] of placements) review = confirmPiece(review, `${r},${c}`, { side, type });
  const board = buildReviewedBoard(review);
  assert.deepEqual(board, expected);
  const confirmed = confirmAuthoredPosition(createEditorState({ board, sideToMove: RED }));
  const recorder = line.reduce((state, move) => recordMove(state, ...move), createRecorder(confirmed.position));
  assert.equal(finishRecording(recorder).checkmate, true);
});

test('stored puzzle → portable export/parse → atomic import → semantic reload', () => {
  const sourceMemory = new Map();
  const sourceStorage = {
    getItem: (key) => sourceMemory.get(key) ?? null,
    setItem: (key, value) => sourceMemory.set(key, value),
  };
  const sourceStore = createPuzzleStore({
    storage: sourceStorage,
    idFactory: () => 'portable-fixture',
    now: () => '2026-08-30T01:00:00.000Z',
  });
  const puzzle = createPuzzle({
    id: 'source-domain-id', title: '可攜殺局', ...finishRecording(
      line.reduce((state, move) => recordMove(state, ...move), createRecorder(confirmAuthoredPosition(authored()).position)),
    ).result,
    tags: ['次序二', '次序一'], notes: '<b>純文字</b>',
  });
  const saved = sourceStore.savePuzzle(puzzle.toJSON());
  sourceStore.markPracticeStarted(saved.id);
  sourceStore.markPracticeCompleted(saved.id);
  const portableSource = {
    ...sourceStore.listPuzzles()[0],
    tags: ['次序二', '次序一'],
    notes: '  <b>純文字</b>\n  ',
  };
  const text = serializePuzzleExport([portableSource], {
    now: () => '2026-08-30T02:00:00.000Z',
  });
  assert.equal(text.includes('practiceCount'), false);
  assert.equal(text.includes('createdAt'), false);
  const parsed = parsePuzzleImport(text);

  const targetMemory = new Map();
  let writes = 0;
  const targetStorage = {
    getItem: (key) => targetMemory.get(key) ?? null,
    setItem(key, value) { writes++; targetMemory.set(key, value); },
  };
  const targetStore = createPuzzleStore({
    storage: targetStorage,
    now: () => '2026-08-30T03:00:00.000Z',
  });
  const result = targetStore.importPuzzles(parsed);
  assert.equal(writes, 1);
  assert.deepEqual(result.importedIds, [saved.id]);
  const reloaded = createPuzzleStore({ storage: targetStorage }).getPuzzle(saved.id);
  for (const field of ['id', 'title', 'initialBoard', 'sideToMove', 'solution', 'tags', 'notes']) {
    assert.deepEqual(reloaded[field], portableSource[field]);
  }
  assert.equal(reloaded.createdAt, '2026-08-30T03:00:00.000Z');
  assert.equal(reloaded.updatedAt, reloaded.createdAt);
  assert.equal(reloaded.practiceCount, 0);
  assert.equal(reloaded.completedCount, 0);
  assert.equal(reloaded.lastPracticedAt, null);
  assert.deepEqual(reloaded.tags, ['次序二', '次序一']);
  assert.equal(reloaded.notes, '  <b>純文字</b>\n  ');

  const beforeCollision = targetMemory.get(PUZZLE_STORAGE_KEY);
  writes = 0;
  const collision = targetStore.importPuzzles(parsed);
  assert.deepEqual(collision.skippedIds, [saved.id]);
  assert.equal(writes, 0);
  assert.equal(targetMemory.get(PUZZLE_STORAGE_KEY), beforeCollision);
});
