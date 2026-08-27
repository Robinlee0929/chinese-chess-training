import assert from 'node:assert/strict';
import {
  PHOTO_MAX_BYTES,
  PHOTO_MAX_ZOOM,
  PHOTO_MIN_ZOOM,
  PuzzlePhotoError,
  clearPhotoReference,
  createPhotoReferenceState,
  exportPhotoReferenceState,
  resetPhotoTransform,
  rotatePhotoLeft,
  rotatePhotoRight,
  setPhotoReference,
  setPhotoZoom,
  validatePhotoMetadata,
  zoomPhotoIn,
  zoomPhotoOut,
} from './puzzle-photo.js';

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

const jpeg = (overrides = {}) => ({ name: 'board.jpg', type: 'image/jpeg', size: 2048, ...overrides });
const selected = () => setPhotoReference(createPhotoReferenceState(), jpeg());
const assertPhotoError = (fn, code) => assert.throws(fn, (error) => (
  error instanceof PuzzlePhotoError && error.code === code
));

test('default photo reference state', () => {
  assert.deepEqual(createPhotoReferenceState(), { photo: null, rotation: 0, zoom: 1 });
});

test('valid image metadata accepted', () => {
  assert.deepEqual(validatePhotoMetadata(jpeg()), jpeg());
  assert.equal(validatePhotoMetadata(jpeg({ type: 'image/png' })).type, 'image/png');
  assert.equal(validatePhotoMetadata(jpeg({ type: 'image/webp' })).type, 'image/webp');
});

test('unsupported MIME rejected', () => {
  assertPhotoError(() => validatePhotoMetadata(jpeg({ type: 'image/gif' })), 'UNSUPPORTED_TYPE');
  assertPhotoError(() => validatePhotoMetadata(jpeg({ type: '' })), 'UNSUPPORTED_TYPE');
});

test('zero-byte file rejected', () => {
  assertPhotoError(() => validatePhotoMetadata(jpeg({ size: 0 })), 'EMPTY_FILE');
});

test('oversized file rejected', () => {
  assertPhotoError(() => validatePhotoMetadata(jpeg({ size: PHOTO_MAX_BYTES + 1 })), 'FILE_TOO_LARGE');
});

test('rotate right 90 degrees', () => {
  assert.equal(rotatePhotoRight(selected()).rotation, 90);
});

test('rotate left 90 degrees', () => {
  assert.equal(rotatePhotoLeft(selected()).rotation, 270);
});

test('rotations normalize deterministically', () => {
  let state = selected();
  for (let i = 0; i < 5; i++) state = rotatePhotoRight(state);
  assert.equal(state.rotation, 90);
  for (let i = 0; i < 6; i++) state = rotatePhotoLeft(state);
  assert.equal(state.rotation, 270);
});

test('zoom in', () => {
  assert.equal(zoomPhotoIn(selected()).zoom, 1.25);
});

test('zoom out', () => {
  assert.equal(zoomPhotoOut(selected()).zoom, 0.75);
});

test('zoom upper bound', () => {
  assert.equal(setPhotoZoom(selected(), 99).zoom, PHOTO_MAX_ZOOM);
  assert.equal(zoomPhotoIn(setPhotoZoom(selected(), PHOTO_MAX_ZOOM)).zoom, PHOTO_MAX_ZOOM);
});

test('zoom lower bound', () => {
  assert.equal(setPhotoZoom(selected(), 0).zoom, PHOTO_MIN_ZOOM);
  assert.equal(zoomPhotoOut(setPhotoZoom(selected(), PHOTO_MIN_ZOOM)).zoom, PHOTO_MIN_ZOOM);
});

test('reset transform', () => {
  const transformed = zoomPhotoIn(rotatePhotoRight(selected()));
  assert.deepEqual(resetPhotoTransform(transformed), { photo: jpeg(), rotation: 0, zoom: 1 });
});

test('clear photo state', () => {
  assert.deepEqual(clearPhotoReference(selected()), createPhotoReferenceState());
});

test('invalid zoom input rejected', () => {
  for (const zoom of [NaN, Infinity, -Infinity, '2', null]) {
    assertPhotoError(() => setPhotoZoom(selected(), zoom), 'INVALID_ZOOM');
  }
});

test('source state is not mutated', () => {
  const source = selected();
  const before = exportPhotoReferenceState(source);
  rotatePhotoRight(source);
  zoomPhotoIn(source);
  clearPhotoReference(source);
  assert.deepEqual(exportPhotoReferenceState(source), before);
});

test('returned state is isolated', () => {
  const state = selected();
  const exported = exportPhotoReferenceState(state);
  exported.photo.name = 'changed.png';
  exported.rotation = 180;
  assert.equal(state.photo.name, 'board.jpg');
  assert.equal(state.rotation, 0);
});

console.log(`\n${passed} puzzle-photo tests passed; ${failed} failed.`);
if (failed) process.exitCode = 1;
