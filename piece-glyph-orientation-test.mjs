import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  ALL_UPRIGHT, FACE_OPPONENT, DEFAULT_PIECE_GLYPH_ORIENTATION_MODE,
  PIECE_GLYPH_ORIENTATION_KEY, ORIENTATION_HYSTERESIS_DEG,
  getLiveBoardAzimuthDeg, quantizeBoardOrientation, updateSnappedBoardOrientation,
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
  const target = { x: 2, z: -3 };
  for (const azimuth of [0, 90, 180, 270]) {
    const radians = azimuth * Math.PI / 180;
    const camera = { x: target.x + 10 * Math.sin(radians), z: target.z + 10 * Math.cos(radians) };
    assert.ok(Math.abs(getLiveBoardAzimuthDeg(camera, target) - azimuth) < 1e-10);
  }
  assert.equal(getLiveBoardAzimuthDeg(target, target), null);
  assert.equal(getLiveBoardAzimuthDeg({ x: NaN, z: 1 }, target), null);
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
