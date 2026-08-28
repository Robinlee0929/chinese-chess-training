import assert from 'node:assert/strict';
import {
  CALIBRATION_CANONICAL_HEIGHT,
  CALIBRATION_CANONICAL_WIDTH,
  CALIBRATION_CORNER_NAMES,
  CALIBRATION_ORIENTATION_RED_BOTTOM,
  CALIBRATION_ORIENTATION_RED_TOP,
  PuzzlePhotoCalibrationError,
  computeHomography,
  createCalibrationState,
  createGridIntersections,
  exportCalibration,
  normalizeCorner,
  resetCalibration,
  setCalibrationOrientation,
  setCorner,
  transformPoint,
  validateQuadrilateral,
} from './puzzle-photo-calibration.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

const assertCalibrationError = (fn, code) => assert.throws(fn, (error) => (
  error instanceof PuzzlePhotoCalibrationError && error.code === code
));
const closeTo = (actual, expected, epsilon = 1e-8) => assert.ok(
  Math.abs(actual - expected) <= epsilon,
  `Expected ${actual} to be within ${epsilon} of ${expected}`,
);

test('creates default calibration state', () => {
  const state = createCalibrationState();
  assert.equal(state.orientation, CALIBRATION_ORIENTATION_RED_BOTTOM);
  assert.equal(state.sideToMove, null);
});

test('four corners initialized', () => {
  assert.deepEqual(Object.keys(createCalibrationState().corners), CALIBRATION_CORNER_NAMES);
});

test('normalized corners remain within bounds', () => {
  assert.deepEqual(normalizeCorner({ x: -2, y: 3 }), { x: 0, y: 1 });
});

for (const [name, point] of [
  ['topLeft', { x: 0.1, y: 0.2 }],
  ['topRight', { x: 0.9, y: 0.15 }],
  ['bottomRight', { x: 0.88, y: 0.92 }],
  ['bottomLeft', { x: 0.12, y: 0.85 }],
]) {
  test(`set ${name}`, () => {
    assert.deepEqual(setCorner(createCalibrationState(), name, point).corners[name], point);
  });
}

test('source state is not mutated', () => {
  const source = createCalibrationState({ sideToMove: 'black' });
  const before = exportCalibration(source);
  setCorner(source, 'topLeft', { x: 0.2, y: 0.2 });
  setCalibrationOrientation(source, CALIBRATION_ORIENTATION_RED_TOP);
  assert.deepEqual(exportCalibration(source), before);
});

test('output is defensively copied', () => {
  const state = createCalibrationState();
  const output = exportCalibration(state);
  output.corners.topLeft.x = 0.7;
  output.gridIntersections[0].r = 4;
  assert.equal(state.corners.topLeft.x, 0.08);
  assert.equal(exportCalibration(state).gridIntersections[0].r, 9);
});

test('reject overlapping points', () => {
  const state = setCorner(createCalibrationState(), 'topRight', { x: 0.08, y: 0.08 });
  assertCalibrationError(() => validateQuadrilateral(state), 'OVERLAPPING_CORNERS');
});

test('reject degenerate quadrilateral', () => {
  const state = createCalibrationState({ inset: 0.08 });
  const corners = {
    topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.1 },
    bottomRight: { x: 0.9, y: 0.13 }, bottomLeft: { x: 0.1, y: 0.13 },
  };
  assertCalibrationError(() => validateQuadrilateral(corners), 'DEGENERATE_QUADRILATERAL');
  assert.ok(state);
});

test('reject self-intersection', () => {
  const corners = {
    topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.9, y: 0.9 },
    bottomRight: { x: 0.9, y: 0.1 }, bottomLeft: { x: 0.1, y: 0.9 },
  };
  assertCalibrationError(() => validateQuadrilateral(corners), 'SELF_INTERSECTION');
});

test('valid quadrilateral accepted', () => {
  assert.equal(validateQuadrilateral(createCalibrationState()).valid, true);
});

test('perspective mapping maps four source corners to canonical corners', () => {
  const state = setCorner(
    setCorner(createCalibrationState(), 'topLeft', { x: 0.18, y: 0.1 }),
    'bottomRight', { x: 0.92, y: 0.9 },
  );
  const source = CALIBRATION_CORNER_NAMES.map((name) => state.corners[name]);
  const target = [
    { x: 0, y: 0 }, { x: 480, y: 0 }, { x: 480, y: 540 }, { x: 0, y: 540 },
  ];
  const h = computeHomography(source, target);
  source.forEach((point, index) => {
    const mapped = transformPoint(h, point);
    closeTo(mapped.x, target[index].x, 1e-6);
    closeTo(mapped.y, target[index].y, 1e-6);
  });
});

test('center-ish point transforms deterministically', () => {
  const source = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ];
  const target = [
    { x: 0, y: 0 }, { x: 480, y: 0 }, { x: 480, y: 540 }, { x: 0, y: 540 },
  ];
  const mapped = transformPoint(computeHomography(source, target), { x: 0.5, y: 0.5 });
  closeTo(mapped.x, 240);
  closeTo(mapped.y, 270);
});

test('grid generator returns exactly 90 points', () => {
  assert.equal(createGridIntersections().length, 90);
});

test('grid row range = 0..9', () => {
  assert.deepEqual([...new Set(createGridIntersections().map(({ r }) => r))].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('grid column range = 0..8', () => {
  assert.deepEqual([...new Set(createGridIntersections().map(({ c }) => c))].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('no duplicate logical coordinates', () => {
  const keys = createGridIntersections().map(({ r, c }) => `${r},${c}`);
  assert.equal(new Set(keys).size, 90);
});

test('no duplicate canonical coordinates', () => {
  const keys = createGridIntersections().map(({ x, y }) => `${x},${y}`);
  assert.equal(new Set(keys).size, 90);
});

test('red-bottom orientation mapping', () => {
  const grid = createGridIntersections(CALIBRATION_ORIENTATION_RED_BOTTOM);
  assert.deepEqual(grid[0], { r: 9, c: 0, displayRow: 0, displayCol: 0, x: 0, y: 0 });
  assert.deepEqual(grid.at(-1), {
    r: 0, c: 8, displayRow: 9, displayCol: 8,
    x: CALIBRATION_CANONICAL_WIDTH, y: CALIBRATION_CANONICAL_HEIGHT,
  });
});

test('red-top orientation mapping', () => {
  const grid = createGridIntersections(CALIBRATION_ORIENTATION_RED_TOP);
  assert.deepEqual(grid[0], { r: 0, c: 8, displayRow: 0, displayCol: 0, x: 0, y: 0 });
  assert.deepEqual(grid.at(-1), {
    r: 9, c: 0, displayRow: 9, displayCol: 8,
    x: CALIBRATION_CANONICAL_WIDTH, y: CALIBRATION_CANONICAL_HEIGHT,
  });
});

test('orientation does not change sideToMove', () => {
  const source = createCalibrationState({ sideToMove: 'black' });
  assert.equal(setCalibrationOrientation(source, CALIBRATION_ORIENTATION_RED_TOP).sideToMove, 'black');
});

test('reset restores defaults', () => {
  let state = createCalibrationState({ orientation: CALIBRATION_ORIENTATION_RED_TOP, sideToMove: 'red' });
  state = setCorner(state, 'topLeft', { x: 0.23, y: 0.18 });
  assert.deepEqual(resetCalibration(state), createCalibrationState({
    orientation: CALIBRATION_ORIENTATION_RED_TOP,
    sideToMove: 'red',
  }));
});

test('invalid coordinates fail deterministically', () => {
  for (const point of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, { x: '0', y: 1 }, null]) {
    assertCalibrationError(() => setCorner(createCalibrationState(), 'topLeft', point), 'INVALID_COORDINATE');
  }
});

test('points outside bounds rejected by validation', () => {
  const corners = exportCalibration(createCalibrationState()).corners;
  corners.topLeft.x = -0.01;
  assertCalibrationError(() => validateQuadrilateral(corners), 'OUT_OF_BOUNDS');
});

test('invalid orientation rejected', () => {
  assertCalibrationError(
    () => setCalibrationOrientation(createCalibrationState(), 'automatic'),
    'INVALID_ORIENTATION',
  );
});

console.log(`\n${passed} puzzle-photo-calibration tests passed; ${failed} failed.`);
if (failed) process.exitCode = 1;
