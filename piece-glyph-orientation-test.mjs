import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  ALL_UPRIGHT, FACE_OPPONENT, DEFAULT_PIECE_GLYPH_ORIENTATION_MODE,
  PIECE_GLYPH_ORIENTATION_KEY,
  getBoardViewRotationDeg, getPieceGlyphRotation, getPieceTextureRotation,
  readPieceGlyphOrientationMode, writePieceGlyphOrientationMode,
} from './piece-glyph-orientation.js';

const layouts = [
  { label: '紅方在下', rotation: 0, red: 0, black: 180 },
  { label: '黑方在下', rotation: 180, red: 180, black: 0 },
  { label: '紅左黑右', rotation: 90, red: 270, black: 90 },
];

for (const layout of layouts) {
  for (const pieceSide of ['red', 'black']) {
    test(`all-upright: ${layout.label}, ${pieceSide} piece`, () => {
      assert.equal(getPieceGlyphRotation({
        mode: ALL_UPRIGHT, pieceSide, boardViewRotationDeg: layout.rotation,
      }), 0);
    });
    test(`face-opponent: ${layout.label}, ${pieceSide} piece`, () => {
      assert.equal(getPieceGlyphRotation({
        mode: FACE_OPPONENT, pieceSide, boardViewRotationDeg: layout.rotation,
      }), layout[pieceSide]);
    });
  }
}

test('camera presets supply the three physical layout rotations', () => {
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
  assert.equal(getBoardViewRotationDeg(views[0]), 270);
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
