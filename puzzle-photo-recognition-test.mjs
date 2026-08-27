import assert from 'node:assert/strict';
import {
  PuzzlePhotoRecognitionError,
  RECOGNITION_OCCUPANCY_EMPTY,
  RECOGNITION_OCCUPANCY_OCCUPIED,
  RECOGNITION_OCCUPANCY_UNCERTAIN,
  RECOGNITION_SIDE_UNKNOWN,
  RECOGNITION_VERSION,
  candidatesToEditorBoard,
  classifyPatch,
  createRecognitionToken,
  derivePatchRadius,
  extractPatchFeatures,
  isRecognitionTokenCurrent,
  recognizeIntersections,
  selectionKey,
} from './puzzle-photo-recognition.js';
import {
  CALIBRATION_ORIENTATION_RED_BOTTOM,
  CALIBRATION_ORIENTATION_RED_TOP,
  createGridIntersections,
} from './puzzle-photo-calibration.js';

const WIDTH = 161;
const HEIGHT = 181;
const RED = 'red';
const BLACK = 'black';
const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function buffer(width = WIDTH, height = HEIGHT, color = [184, 151, 98, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set(color, index);
  return { width, height, data };
}

function paintCircle(source, x, y, radius, color) {
  for (let py = Math.max(0, Math.floor(y - radius)); py <= Math.min(source.height - 1, Math.ceil(y + radius)); py++) {
    for (let px = Math.max(0, Math.floor(x - radius)); px <= Math.min(source.width - 1, Math.ceil(x + radius)); px++) {
      if (Math.hypot(px - x, py - y) > radius) continue;
      source.data.set(color, (py * source.width + px) * 4);
    }
  }
}

function paintGridCross(source, x, y, color = [68, 45, 25, 255]) {
  for (let offset = -1; offset <= 1; offset++) {
    for (let px = 0; px < source.width; px++) source.data.set(color, ((y + offset) * source.width + px) * 4);
    for (let py = 0; py < source.height; py++) source.data.set(color, (py * source.width + x + offset) * 4);
  }
}

function grid(orientation = CALIBRATION_ORIENTATION_RED_BOTTOM) {
  return createGridIntersections(orientation, WIDTH - 1, HEIGHT - 1);
}

function classifySynthetic(color, radius = 5) {
  const source = buffer();
  const point = grid().find((candidate) => candidate.r === 5 && candidate.c === 4);
  paintCircle(source, point.x, point.y, radius, color);
  return classifyPatch(extractPatchFeatures(source, point));
}

function candidateTemplate(overrides = {}) {
  return grid().map((point) => ({
    r: point.r,
    c: point.c,
    displayRow: point.displayRow,
    displayCol: point.displayCol,
    occupancy: RECOGNITION_OCCUPANCY_EMPTY,
    occupancyConfidence: 0.9,
    suggestedSide: RECOGNITION_SIDE_UNKNOWN,
    sideConfidence: 0,
    ...overrides,
  }));
}

function allEmptySelections(candidates) {
  return Object.fromEntries(candidates.map((candidate) => [selectionKey(candidate.r, candidate.c), null]));
}

function expectCode(code, run) {
  assert.throws(run, (error) => error instanceof PuzzlePhotoRecognitionError && error.code === code);
}

test('reject malformed pixel buffer', () => expectCode('INVALID_PIXEL_BUFFER', () => extractPatchFeatures(null, { x: 0, y: 0 })));
test('reject malformed dimensions', () => expectCode('INVALID_DIMENSIONS', () => extractPatchFeatures({ width: 0, height: 9, data: [] }, { x: 0, y: 0 })));
test('reject mismatched pixel data length', () => expectCode('INVALID_PIXEL_DATA', () => extractPatchFeatures({ width: 3, height: 3, data: [] }, { x: 0, y: 0 })));
test('reject malformed intersection point', () => expectCode('INVALID_POINT', () => extractPatchFeatures(buffer(), { x: NaN, y: 0 })));
test('reject unsafe patch fraction', () => expectCode('INVALID_PATCH_FRACTION', () => derivePatchRadius(WIDTH, HEIGHT, 0.5)));
test('patch radius stays below half grid spacing', () => {
  const radius = derivePatchRadius(WIDTH, HEIGHT);
  assert.ok(radius >= 2);
  assert.ok(radius < Math.min((WIDTH - 1) / 8, (HEIGHT - 1) / 9) / 2);
});
test('top-left edge patch is bounded', () => {
  const features = extractPatchFeatures(buffer(), { x: 0, y: 0 });
  assert.equal(features.centerX, 0);
  assert.equal(features.centerY, 0);
  assert.ok(features.sampleCount > 0);
});
test('bottom-right canonical edge is clamped safely', () => {
  const features = extractPatchFeatures(buffer(), { x: WIDTH, y: HEIGHT });
  assert.equal(features.centerX, WIDTH - 1);
  assert.equal(features.centerY, HEIGHT - 1);
});
test('recognizer returns exactly 90 candidates', () => assert.equal(recognizeIntersections(buffer(), grid()).length, 90));
test('recognizer returns unique logical coordinates', () => {
  const candidates = recognizeIntersections(buffer(), grid());
  assert.equal(new Set(candidates.map(({ r, c }) => `${r},${c}`)).size, 90);
});
test('candidate contract contains only bounded confidence values', () => {
  for (const candidate of recognizeIntersections(buffer(), grid())) {
    assert.ok(['empty', 'occupied', 'uncertain'].includes(candidate.occupancy));
    assert.ok(candidate.occupancyConfidence >= 0 && candidate.occupancyConfidence <= 1);
    assert.ok(['red', 'black', 'unknown'].includes(candidate.suggestedSide));
    assert.ok(candidate.sideConfidence >= 0 && candidate.sideConfidence <= 1);
  }
});
test('flat synthetic image is empty', () => assert.equal(classifySynthetic([184, 151, 98, 255], 0).occupancy, RECOGNITION_OCCUPANCY_EMPTY));
test('flat synthetic image has unknown side', () => assert.equal(classifySynthetic([184, 151, 98, 255], 0).suggestedSide, RECOGNITION_SIDE_UNKNOWN));
test('empty synthetic grid crossing remains empty', () => {
  const source = buffer();
  const point = grid().find((candidate) => candidate.r === 5 && candidate.c === 4);
  paintGridCross(source, point.x, point.y);
  assert.equal(classifyPatch(extractPatchFeatures(source, point)).occupancy, RECOGNITION_OCCUPANCY_EMPTY);
});
test('strong dark synthetic disk is occupied', () => assert.equal(classifySynthetic([30, 29, 27, 255]).occupancy, RECOGNITION_OCCUPANCY_OCCUPIED));
test('strong dark synthetic disk suggests black', () => assert.equal(classifySynthetic([30, 29, 27, 255]).suggestedSide, BLACK));
test('strong red synthetic disk is occupied', () => assert.equal(classifySynthetic([188, 35, 26, 255]).occupancy, RECOGNITION_OCCUPANCY_OCCUPIED));
test('strong red synthetic disk suggests red', () => assert.equal(classifySynthetic([188, 35, 26, 255]).suggestedSide, RED));
test('weak synthetic contrast is uncertain', () => assert.equal(classifySynthetic([150, 125, 88, 255], 6).occupancy, RECOGNITION_OCCUPANCY_UNCERTAIN));
test('ambiguous side evidence remains unknown', () => {
  const result = classifyPatch({
    luminanceContrast: 0.12,
    innerStdDev: 38,
    outerStdDev: 5,
    edgeMean: 0.06,
    redChroma: 0.07,
    darknessDelta: 0.08,
  });
  assert.equal(result.suggestedSide, RECOGNITION_SIDE_UNKNOWN);
});
test('candidate array and entries are immutable', () => {
  const candidates = recognizeIntersections(buffer(), grid());
  assert.ok(Object.isFrozen(candidates));
  assert.ok(candidates.every(Object.isFrozen));
});
test('source pixels are not mutated', () => {
  const source = buffer();
  const before = source.data.slice();
  recognizeIntersections(source, grid());
  assert.deepEqual(source.data, before);
});
test('source grid is not mutated', () => {
  const points = grid();
  const before = structuredClone(points);
  recognizeIntersections(buffer(), points);
  assert.deepEqual(points, before);
});
test('red-bottom orientation mapping is preserved', () => {
  const first = recognizeIntersections(buffer(), grid(CALIBRATION_ORIENTATION_RED_BOTTOM))[0];
  assert.deepEqual([first.r, first.c], [9, 0]);
});
test('red-top orientation mapping is preserved', () => {
  const first = recognizeIntersections(buffer(), grid(CALIBRATION_ORIENTATION_RED_TOP))[0];
  assert.deepEqual([first.r, first.c], [0, 8]);
});
test('recognition token captures both source versions', () => {
  assert.deepEqual(createRecognitionToken({ photoVersion: 2, calibrationVersion: 7 }), {
    recognitionVersion: RECOGNITION_VERSION,
    photoVersion: 2,
    calibrationVersion: 7,
  });
});
test('recognition token is current when both versions match', () => assert.equal(
  isRecognitionTokenCurrent(createRecognitionToken({ photoVersion: 2, calibrationVersion: 7 }), { photoVersion: 2, calibrationVersion: 7 }),
  true,
));
test('photo replacement invalidates recognition token', () => assert.equal(
  isRecognitionTokenCurrent(createRecognitionToken({ photoVersion: 2, calibrationVersion: 7 }), { photoVersion: 3, calibrationVersion: 7 }),
  false,
));
test('calibration change invalidates recognition token', () => assert.equal(
  isRecognitionTokenCurrent(createRecognitionToken({ photoVersion: 2, calibrationVersion: 7 }), { photoVersion: 2, calibrationVersion: 8 }),
  false,
));
test('invalid recognition version inputs fail closed', () => expectCode('INVALID_VERSION', () => createRecognitionToken({ photoVersion: -1, calibrationVersion: 0 })));
test('selection key rejects out-of-bounds coordinate', () => expectCode('INVALID_COORDINATE', () => selectionKey(10, 0)));
test('all explicit empty selections create a 10x9 empty editor board', () => {
  const candidates = candidateTemplate();
  const board = candidatesToEditorBoard(candidates, allEmptySelections(candidates));
  assert.equal(board.length, 10);
  assert.ok(board.every((row) => row.length === 9 && row.every((piece) => piece === null)));
});
test('exact red human selection maps to editor board', () => {
  const candidates = candidateTemplate();
  const selections = allEmptySelections(candidates);
  selections['0,4'] = { side: RED, type: 'K' };
  assert.deepEqual(candidatesToEditorBoard(candidates, selections)[0][4], { side: RED, type: 'K' });
});
test('exact black human selection maps to editor board', () => {
  const candidates = candidateTemplate();
  const selections = allEmptySelections(candidates);
  selections['9,4'] = { side: BLACK, type: 'K' };
  assert.deepEqual(candidatesToEditorBoard(candidates, selections)[9][4], { side: BLACK, type: 'K' });
});
test('human black selection overrides red suggestion', () => {
  const candidates = candidateTemplate({ occupancy: RECOGNITION_OCCUPANCY_OCCUPIED, suggestedSide: RED, sideConfidence: 0.9 });
  const selections = allEmptySelections(candidates);
  selections['5,4'] = { side: BLACK, type: 'R' };
  assert.deepEqual(candidatesToEditorBoard(candidates, selections)[5][4], { side: BLACK, type: 'R' });
});
test('human empty selection overrides occupied suggestion', () => {
  const candidates = candidateTemplate({ occupancy: RECOGNITION_OCCUPANCY_OCCUPIED, suggestedSide: BLACK, sideConfidence: 0.9 });
  assert.equal(candidatesToEditorBoard(candidates, allEmptySelections(candidates))[5][4], null);
});
test('human piece selection overrides empty suggestion', () => {
  const candidates = candidateTemplate();
  const selections = allEmptySelections(candidates);
  selections['5,4'] = { side: RED, type: 'C' };
  assert.deepEqual(candidatesToEditorBoard(candidates, selections)[5][4], { side: RED, type: 'C' });
});
test('candidate suggestions are never applied without explicit review', () => {
  const candidates = candidateTemplate({ occupancy: RECOGNITION_OCCUPANCY_OCCUPIED, suggestedSide: RED, sideConfidence: 0.9 });
  expectCode('UNREVIEWED_INTERSECTION', () => candidatesToEditorBoard(candidates, {}));
});
test('invalid exact piece selection is rejected', () => {
  const candidates = candidateTemplate();
  const selections = allEmptySelections(candidates);
  selections['5,4'] = { side: RED, type: 'X' };
  expectCode('INVALID_SELECTION', () => candidatesToEditorBoard(candidates, selections));
});
test('candidate-to-board conversion returns isolated boards', () => {
  const candidates = candidateTemplate();
  const selections = allEmptySelections(candidates);
  selections['5,4'] = { side: RED, type: 'R' };
  const first = candidatesToEditorBoard(candidates, selections);
  const second = candidatesToEditorBoard(candidates, selections);
  first[5][4].type = 'C';
  assert.equal(second[5][4].type, 'R');
});
test('grid with wrong candidate count is rejected', () => expectCode('INVALID_GRID', () => recognizeIntersections(buffer(), grid().slice(1))));
test('duplicate grid coordinate is rejected', () => {
  const points = grid().map((point) => ({ ...point }));
  points[1].r = points[0].r;
  points[1].c = points[0].c;
  expectCode('DUPLICATE_GRID_COORDINATE', () => recognizeIntersections(buffer(), points));
});
test('duplicate candidate coordinate is rejected', () => {
  const candidates = candidateTemplate();
  candidates[1].r = candidates[0].r;
  candidates[1].c = candidates[0].c;
  expectCode('DUPLICATE_CANDIDATE', () => candidatesToEditorBoard(candidates, allEmptySelections(candidateTemplate())));
});

let passed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

console.log(`\n${passed} puzzle-photo-recognition tests passed; ${tests.length - passed} failed.`);
