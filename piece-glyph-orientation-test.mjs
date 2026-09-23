import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_UPRIGHT, FACE_OPPONENT, PIECE_GLYPH_ORIENTATION_KEY,
  getPieceGlyphRotation, readPieceGlyphOrientationMode, writePieceGlyphOrientationMode,
} from './piece-glyph-orientation.js';

for (const viewerSide of ['red', 'black']) {
  for (const pieceSide of ['red', 'black']) {
    test(`all-upright: ${viewerSide} viewer, ${pieceSide} piece`, () => {
      assert.equal(getPieceGlyphRotation({ mode: ALL_UPRIGHT, pieceSide, viewerSide }), 0);
    });
    test(`face-opponent: ${viewerSide} viewer, ${pieceSide} piece`, () => {
      assert.equal(getPieceGlyphRotation({ mode: FACE_OPPONENT, pieceSide, viewerSide }),
        viewerSide === pieceSide ? 0 : 180);
    });
  }
}

test('unknown viewer side keeps glyph upright', () => {
  assert.equal(getPieceGlyphRotation({ mode: FACE_OPPONENT, pieceSide: 'black', viewerSide: null }), 0);
});

test('stored mode defaults safely and persists independently', () => {
  const values = new Map([[PIECE_GLYPH_ORIENTATION_KEY, 'unknown']]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(readPieceGlyphOrientationMode(() => storage), ALL_UPRIGHT);
  assert.equal(writePieceGlyphOrientationMode(() => storage, FACE_OPPONENT), true);
  assert.equal(readPieceGlyphOrientationMode(() => storage), FACE_OPPONENT);
  assert.equal(writePieceGlyphOrientationMode(() => storage, 'unknown'), false);
  assert.equal(readPieceGlyphOrientationMode(() => storage), FACE_OPPONENT);
  assert.equal(writePieceGlyphOrientationMode(() => null, FACE_OPPONENT), false);
  assert.equal(readPieceGlyphOrientationMode(() => { throw new Error('storage blocked'); }), ALL_UPRIGHT);
});
