import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  ALL_UPRIGHT, FACE_OPPONENT, DEFAULT_PIECE_GLYPH_ORIENTATION_MODE,
  PIECE_GLYPH_ORIENTATION_KEY, ORIENTATION_HYSTERESIS_DEG, VERTICAL_DEADZONE_DEG,
  getLiveBoardAzimuthDeg, quantizeBoardOrientation,
  initializeSnappedBoardOrientation, updateSnappedBoardOrientation,
  getBoardViewRotationDeg, getPieceGlyphRotation, getPieceTextureRotation,
  readPieceGlyphOrientationMode, writePieceGlyphOrientationMode,
} from './piece-glyph-orientation.js';

const layouts = [
  { label: '紅方在下', rotation: 0, red: 0, black: 180, same: 0 },
  { label: '紅左黑右', rotation: 90, red: 270, black: 90, same: 270 },
  { label: '黑方在下', rotation: 180, red: 180, black: 0, same: 180 },
  { label: '紅右黑左', rotation: 270, red: 90, black: 270, same: 90 },
];

for (const layout of layouts) {
  for (const pieceSide of ['red', 'black']) {
    test(`all-upright: ${layout.label}, ${pieceSide} piece`, () => {
      assert.equal(getPieceGlyphRotation({
        mode: ALL_UPRIGHT, pieceSide, boardViewRotationDeg: layout.rotation,
      }), layout.same);
    });
    test(`face-opponent: ${layout.label}, ${pieceSide} piece`, () => {
      assert.equal(getPieceGlyphRotation({
        mode: FACE_OPPONENT, pieceSide, boardViewRotationDeg: layout.rotation,
      }), layout[pieceSide]);
    });
  }
}

test('camera presets supply the four physical layout rotations without shifting old indices', () => {
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const declaration = source.match(/const CAMERA_VIEWS = \[[\s\S]*?\n\];/u)?.[0];
  assert.ok(declaration);
  const views = vm.runInNewContext(`${declaration}\nCAMERA_VIEWS`, {
    THREE: { Vector3: class {} }, HOME_TGT: {},
  });
  for (const layout of layouts) {
    const view = views.find((item) => item.label === layout.label);
    assert.ok(view, `${layout.label} is a reachable camera preset`);
    assert.equal(getBoardViewRotationDeg(view), layout.rotation);
  }
  assert.equal(views[0].azimuth, -90);
  assert.equal(views[1].azimuth, 90);
  assert.equal(views[3].label, '俯視'); // preserve existing saved view indices
  assert.equal(views[4].label, '黑方在下');
  assert.equal(getBoardViewRotationDeg(views[0]), 270);
});

test('live camera azimuth matches the board axes and OrbitControls spherical convention', () => {
  const target = { x: 2, y: 0, z: -3 };
  for (const azimuth of [0, 90, 180, 270]) {
    const radians = azimuth * Math.PI / 180;
    const camera = { x: target.x + 10 * Math.sin(radians), y: 10, z: target.z + 10 * Math.cos(radians) };
    assert.ok(Math.abs(getLiveBoardAzimuthDeg(camera, target) - azimuth) < 1e-10);
  }
  assert.equal(getLiveBoardAzimuthDeg(target, target), null);
  assert.equal(getLiveBoardAzimuthDeg({ x: NaN, y: 10, z: 1 }, target), null);
});

test('exact vertical and microscopic horizontal noise have no azimuth', () => {
  const target = { x: 0, y: 0, z: 0.2 };
  assert.equal(VERTICAL_DEADZONE_DEG, 1);
  for (const x of [0, 1e-12, -1e-12]) {
    assert.equal(getLiveBoardAzimuthDeg({ x, y: 14.2, z: 0.2 }, target), null);
  }
});

test('vertical dead cone is relative to camera distance, with a clear boundary', () => {
  const target = { x: 0, y: 0, z: 0 };
  for (const distance of [1, 14.2, 1000]) {
    const atPolar = degrees => ({
      x: distance * Math.sin(degrees * Math.PI / 180),
      y: distance * Math.cos(degrees * Math.PI / 180), z: 0,
    });
    assert.equal(getLiveBoardAzimuthDeg(atPolar(0.9), target), null);
    assert.equal(getLiveBoardAzimuthDeg(atPolar(1.1), target), 90);
    assert.equal(getLiveBoardAzimuthDeg(atPolar(8), target), 90);
  }
});

for (const prior of [0, 90, 180, 270]) {
  test(`vertical azimuth preserves the last ${prior}° snap`, () => {
    assert.equal(updateSnappedBoardOrientation({ liveAngleDeg: null, currentSnapDeg: prior }), prior);
    assert.equal(initializeSnappedBoardOrientation({ liveAngleDeg: null, persistedSnapDeg: prior }), prior);
  });
}

test('valid restored camera overrides stale saved snap; old and invalid values migrate safely', () => {
  assert.equal(initializeSnappedBoardOrientation({ liveAngleDeg: 162, persistedSnapDeg: 90 }), 180);
  for (const invalid of [undefined, null, 'garbage', 45, 91, -90, NaN]) {
    assert.equal(initializeSnappedBoardOrientation({ liveAngleDeg: null, persistedSnapDeg: invalid }), 0);
  }
});

test('exiting the vertical dead cone resumes the existing 10° hysteresis', () => {
  const update = (liveAngleDeg, currentSnapDeg) => updateSnappedBoardOrientation({ liveAngleDeg, currentSnapDeg });
  let snap = 0;
  for (const live of [null, null, 54]) snap = update(live, snap);
  assert.equal(snap, 0);
  snap = update(56, snap);
  assert.equal(snap, 90);
  snap = update(null, snap);
  assert.equal(snap, 90);
  snap = update(36, snap);
  assert.equal(snap, 90);
  assert.equal(update(34, snap), 0);
});

// Run the production preference and camera-change functions in a small VM with
// storage, vectors, and the texture refresh as observable boundaries.
function productionFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is present in main.js`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} has a complete body`);
}

function makeVector(initial) {
  let values = [...initial];
  return {
    get x() { return values[0]; },
    get y() { return values[1]; },
    get z() { return values[2]; },
    set(x, y, z) { values = [x, y, z]; return this; },
    fromArray(next) { values = [...next]; return this; },
    toArray() { return [...values]; },
  };
}

function createViewPrefsHarness(prefs) {
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const keyDeclaration = source.match(/^const VIEW_PREF_KEY = '[^']+';$/mu)?.[0];
  assert.ok(keyDeclaration);
  const restoreStart = source.indexOf('const savedPrefs = loadViewPrefs();');
  const restoreEnd = source.indexOf("controls.addEventListener('change', syncSnappedBoardOrientation);", restoreStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const storage = new Map([['xiangqi.viewPrefs.v1', JSON.stringify(prefs)]]);
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const camera = { position: makeVector([0, 10, 10]), lookAt() {} };
  const controls = { target: makeVector([0, 0, 0]) };
  let refreshCount = 0;
  const script = [
    'let snappedBoardOrientationDeg = null; let viewLocked = false; let viewIdx = 0;',
    keyDeclaration,
    productionFunction(source, 'loadViewPrefs'),
    productionFunction(source, 'saveViewPrefs'),
    productionFunction(source, 'syncSnappedBoardOrientation'),
    source.slice(restoreStart, restoreEnd),
    '({ snap: () => snappedBoardOrientationDeg, locked: () => viewLocked,',
    'viewIdx: () => viewIdx, saveViewPrefs, syncSnappedBoardOrientation })',
  ].join('\n');
  const runtime = vm.runInNewContext(script, {
    camera, controls, localStorage, CAMERA_VIEWS: Array(5), syncLockUI() {},
    getLiveBoardAzimuthDeg, initializeSnappedBoardOrientation,
    updateSnappedBoardOrientation, ORIENTATION_HYSTERESIS_DEG,
    refreshPieceGlyphTextures: () => { refreshCount++; },
  });
  return {
    ...runtime, camera, controls, storage,
    saved: () => JSON.parse(storage.get('xiangqi.viewPrefs.v1')),
    refreshCount: () => refreshCount,
  };
}

const verticalPrefs = (x, snap = 180) => ({
  pos: [x, 14.2, 0.2], tgt: [0, 0, 0.2], locked: true,
  viewIdx: 3, pieceGlyphBoardSnapDeg: snap,
});

test('production viewPrefs write keeps camera, target, lock, and view index beside the snap', () => {
  const prefs = verticalPrefs(0);
  const runtime = createViewPrefsHarness(prefs);
  runtime.saveViewPrefs();
  assert.deepEqual([...runtime.storage.keys()], ['xiangqi.viewPrefs.v1']);
  assert.deepEqual(runtime.saved(), prefs);
  assert.equal(runtime.snap(), 180);
  assert.equal(runtime.locked(), true);
  assert.equal(runtime.viewIdx(), 3);
});

test('production viewPrefs restore keeps 180° for exact and ±1e-12 vertical cameras', () => {
  for (const x of [0, 1e-12, -1e-12]) {
    const runtime = createViewPrefsHarness(verticalPrefs(x));
    assert.equal(runtime.snap(), 180, `X offset ${x}`);
    assert.equal(runtime.saved().pieceGlyphBoardSnapDeg, 180);
    assert.deepEqual(runtime.camera.position.toArray(), [x, 14.2, 0.2]);
  }
});

test('production restore gives valid live camera priority over a stale saved snap', () => {
  const runtime = createViewPrefsHarness({
    ...verticalPrefs(0), pos: [10, 10, 0.2], pieceGlyphBoardSnapDeg: 180,
  });
  assert.equal(runtime.snap(), 90);
  assert.equal(runtime.saved().pieceGlyphBoardSnapDeg, 90);
});

test('production restore migrates missing and invalid snaps without overriding valid live camera', () => {
  for (const value of [undefined, null, 45, 'garbage']) {
    const prefs = verticalPrefs(0);
    if (value === undefined) delete prefs.pieceGlyphBoardSnapDeg;
    else prefs.pieceGlyphBoardSnapDeg = value;
    const runtime = createViewPrefsHarness(prefs);
    assert.equal(runtime.snap(), 0);
    assert.equal(runtime.saved().pieceGlyphBoardSnapDeg, 0);
  }
  const runtime = createViewPrefsHarness(verticalPrefs(0, 'garbage'));
  runtime.camera.position.set(10, 10, 0.2);
  runtime.syncSnappedBoardOrientation();
  assert.equal(runtime.snap(), 90);
  assert.equal(runtime.saved().pieceGlyphBoardSnapDeg, 90);
  const validCamera = createViewPrefsHarness({
    ...verticalPrefs(0, 'garbage'), pos: [10, 10, 0.2],
  });
  assert.equal(validCamera.snap(), 90);
  assert.equal(validCamera.saved().pieceGlyphBoardSnapDeg, 90);
});

test('production snap gate ignores vertical noise and same-quadrant motion, then refreshes once', () => {
  const runtime = createViewPrefsHarness(verticalPrefs(0));
  const setCamera = (polarDeg, azimuthDeg) => {
    const polar = polarDeg * Math.PI / 180;
    const azimuth = azimuthDeg * Math.PI / 180;
    runtime.camera.position.set(14.2 * Math.sin(polar) * Math.sin(azimuth),
      14.2 * Math.cos(polar), 0.2 + 14.2 * Math.sin(polar) * Math.cos(azimuth));
    runtime.syncSnappedBoardOrientation();
  };
  setCamera(8, 180);
  assert.equal(runtime.snap(), 180);
  assert.equal(runtime.refreshCount(), 0);
  for (const x of [0, 1e-12, -1e-12]) {
    runtime.camera.position.set(x, 14.2, 0.2);
    runtime.syncSnappedBoardOrientation();
    assert.equal(runtime.snap(), 180);
  }
  assert.equal(runtime.refreshCount(), 0);
  for (const azimuth of [180, 190, 170]) setCamera(8, azimuth);
  assert.equal(runtime.snap(), 180);
  assert.equal(runtime.refreshCount(), 0);
  setCamera(8, 270);
  assert.equal(runtime.snap(), 270);
  assert.equal(runtime.refreshCount(), 1);
  assert.equal(runtime.saved().pieceGlyphBoardSnapDeg, 270);
  for (const azimuth of [260, 280]) setCamera(8, azimuth);
  assert.equal(runtime.refreshCount(), 1);
});

test('initial snap chooses the nearest cardinal direction, including wraparound', () => {
  assert.equal(ORIENTATION_HYSTERESIS_DEG, 10);
  for (const [live, expected] of [[12, 0], [71, 90], [162, 180], [268, 270], [342, 0], [-18, 0], [522, 180]]) {
    assert.equal(quantizeBoardOrientation(live), expected);
    assert.equal(updateSnappedBoardOrientation({ liveAngleDeg: live, currentSnapDeg: null }), expected);
  }
  assert.equal(quantizeBoardOrientation(NaN), null);
});

for (const from of [0, 90, 180, 270]) {
  const to = (from + 90) % 360;
  const snap = (liveAngleDeg, currentSnapDeg) => updateSnappedBoardOrientation({ liveAngleDeg, currentSnapDeg });
  test(`10° hysteresis across ${from}° ↔ ${to}°`, () => {
    assert.equal(snap(from + 54, from), from);
    assert.equal(snap(from + 56, from), to);
    assert.equal(snap(from + 36, to), to);
    assert.equal(snap(from + 34, to), from);
    for (const live of [from + 44, from + 46, from + 54]) assert.equal(snap(live, from), from);
    for (const live of [from + 54, from + 46, from + 36]) assert.equal(snap(live, to), to);
  });
}

test('large camera jumps resolve directly and invalid angles preserve a valid snap', () => {
  const snap = (liveAngleDeg, currentSnapDeg) => updateSnappedBoardOrientation({ liveAngleDeg, currentSnapDeg });
  assert.equal(snap(205, 0), 180);
  assert.equal(snap(70, 270), 90);
  assert.equal(snap(NaN, 180), 180);
  assert.equal(snap(NaN, null), null);
});

test('nine non-cardinal angles yield only four discrete glyph orientations', () => {
  for (const [live, expected] of [[25, 0], [50, 90], [70, 90], [115, 90], [162, 180],
    [205, 180], [250, 270], [310, 270], [340, 0]]) {
    const snap = updateSnappedBoardOrientation({ liveAngleDeg: live, currentSnapDeg: null });
    assert.equal(snap, expected);
    for (const mode of [FACE_OPPONENT, ALL_UPRIGHT]) {
      for (const pieceSide of ['red', 'black']) {
        assert.ok([0, 90, 180, 270].includes(getPieceGlyphRotation({ mode, pieceSide, boardViewRotationDeg: snap })));
      }
    }
  }
});

test('texture compensation preserves screen-relative quarter turns', () => {
  assert.equal(getPieceTextureRotation({ mode: FACE_OPPONENT, pieceSide: 'red', boardViewRotationDeg: 0 }), 270);
  assert.equal(getPieceTextureRotation({ mode: FACE_OPPONENT, pieceSide: 'red', boardViewRotationDeg: 180 }), 270);
  assert.equal(getPieceTextureRotation({ mode: FACE_OPPONENT, pieceSide: 'red', boardViewRotationDeg: 90 }), 90);
  assert.equal(getPieceTextureRotation({ mode: FACE_OPPONENT, pieceSide: 'black', boardViewRotationDeg: 90 }), 270);
});

test('unknown board orientation keeps glyph upright', () => {
  assert.equal(getBoardViewRotationDeg({ azimuth: 45 }), null);
  assert.equal(getPieceGlyphRotation({ mode: FACE_OPPONENT, pieceSide: 'black', boardViewRotationDeg: null }), 0);
});

test('missing and invalid stored modes use the physical-board default', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(DEFAULT_PIECE_GLYPH_ORIENTATION_MODE, FACE_OPPONENT);
  assert.equal(readPieceGlyphOrientationMode(() => storage), FACE_OPPONENT);
  values.set(PIECE_GLYPH_ORIENTATION_KEY, 'unknown');
  assert.equal(readPieceGlyphOrientationMode(() => storage), FACE_OPPONENT);
  assert.equal(readPieceGlyphOrientationMode(() => { throw new Error('storage blocked'); }), FACE_OPPONENT);
});

test('explicit saved choices remain independent of the default', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(writePieceGlyphOrientationMode(() => storage, ALL_UPRIGHT), true);
  assert.equal(readPieceGlyphOrientationMode(() => storage), ALL_UPRIGHT);
  assert.equal(writePieceGlyphOrientationMode(() => storage, FACE_OPPONENT), true);
  assert.equal(readPieceGlyphOrientationMode(() => storage), FACE_OPPONENT);
  assert.equal(writePieceGlyphOrientationMode(() => storage, 'unknown'), false);
  assert.equal(readPieceGlyphOrientationMode(() => storage), FACE_OPPONENT);
  assert.equal(writePieceGlyphOrientationMode(() => null, FACE_OPPONENT), false);
});
