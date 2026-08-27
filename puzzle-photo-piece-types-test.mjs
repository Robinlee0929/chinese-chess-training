import assert from 'node:assert/strict';
import {
  PIECE_TYPE_THRESHOLDS,
  PuzzlePhotoPieceTypeError,
  addTemplate,
  comparePiecePatches,
  confidenceForRanking,
  createPieceTypeSessionToken,
  createTemplate,
  createTemplateLibrary,
  isPieceTypeSessionCurrent,
  listTemplates,
  normalizePiecePatch,
  rankPieceTypes,
  removeTemplate,
  removeTemplatesForSource,
  suggestPieceType,
  suggestUnresolvedPieceTypes,
} from './puzzle-photo-piece-types.js';

const tests = [];
const test = (name, run) => tests.push({ name, run });

function expectCode(code, run) {
  assert.throws(run, (error) => error instanceof PuzzlePhotoPieceTypeError && error.code === code);
}

function pixels(width = 41, height = 41, background = 210) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set([background, background, background, 255], index);
  return { width, height, data };
}

function paint(source, predicate, value = 30) {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      if (predicate(x, y)) source.data.set([value, value, value, 255], (y * source.width + x) * 4);
    }
  }
  return source;
}

function glyph(kind = 'L') {
  const source = pixels();
  if (kind === 'L') paint(source, (x, y) => (x >= 16 && x <= 18 && y >= 11 && y <= 29) || (y >= 27 && y <= 29 && x >= 16 && x <= 27));
  if (kind === 'T') paint(source, (x, y) => (y >= 11 && y <= 13 && x >= 12 && x <= 28) || (x >= 19 && x <= 21 && y >= 11 && y <= 29));
  if (kind === 'X') paint(source, (x, y) => Math.abs(x - y) <= 1 || Math.abs(x + y - 40) <= 1);
  if (kind === 'dot') paint(source, (x, y) => Math.hypot(x - 20, y - 20) <= 3);
  return normalizePiecePatch(source, { x: 20, y: 20 }, { radius: 18, size: 16 });
}

function rotatePatchFixture(patch, degrees) {
  const size = patch.size;
  const fields = {};
  for (const field of ['values', 'inkMask', 'weights']) {
    fields[field] = Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        let sourceRow;
        let sourceCol;
        if (degrees === 90) [sourceRow, sourceCol] = [size - 1 - col, row];
        else if (degrees === 180) [sourceRow, sourceCol] = [size - 1 - row, size - 1 - col];
        else [sourceRow, sourceCol] = [col, size - 1 - row];
        fields[field][row * size + col] = patch[field][sourceRow * size + sourceCol];
      }
    }
  }
  return { size, ...fields, quality: patch.quality };
}

function withTemplate(library, side, type, patch, sourceKey = `${side}-${type}`) {
  return addTemplate(library, { side, type, patch, sourceKey, confirmedByHuman: true });
}

test('reject malformed patch pixel buffer', () => expectCode('INVALID_PIXEL_BUFFER', () => normalizePiecePatch(null, { x: 0, y: 0 })));
test('reject mismatched patch pixel data', () => expectCode('INVALID_PIXEL_BUFFER', () => normalizePiecePatch({ width: 4, height: 4, data: [] }, { x: 0, y: 0 })));
test('reject malformed patch center', () => expectCode('INVALID_POINT', () => normalizePiecePatch(pixels(), { x: NaN, y: 0 })));
test('reject unsafe fixed matrix size', () => expectCode('INVALID_MATRIX_SIZE', () => normalizePiecePatch(pixels(), { x: 20, y: 20 }, { size: 4 })));
test('reject unsafe patch radius', () => expectCode('INVALID_PATCH_RADIUS', () => normalizePiecePatch(pixels(), { x: 20, y: 20 }, { radius: 1 })));
test('normalization returns fixed 16 by 16 representation', () => {
  const patch = glyph();
  assert.equal(patch.size, 16);
  assert.equal(patch.values.length, 256);
  assert.equal(patch.inkMask.length, 256);
});
test('normalization is deterministic', () => assert.deepEqual(glyph('T'), glyph('T')));
test('normalization does not mutate source pixels', () => {
  const source = glyphSource();
  const before = source.data.slice();
  normalizePiecePatch(source, { x: 20, y: 20 }, { radius: 18 });
  assert.deepEqual(source.data, before);
});
test('normalized result and vectors are immutable', () => {
  const patch = glyph();
  assert.ok(Object.isFrozen(patch));
  assert.ok(Object.isFrozen(patch.values));
  assert.ok(Object.isFrozen(patch.inkMask));
});
test('outer boundary is suppressed by central crop', () => {
  const plain = glyphSource();
  const ringed = glyphSource();
  paint(ringed, (x, y) => {
    const d = Math.hypot(x - 20, y - 20);
    return d >= 16 && d <= 18;
  }, 0);
  const plainPatch = normalizePiecePatch(plain, { x: 20, y: 20 }, { radius: 18 });
  const ringedPatch = normalizePiecePatch(ringed, { x: 20, y: 20 }, { radius: 18 });
  for (let index = 0; index < plainPatch.values.length; index++) {
    if (plainPatch.weights[index] > 0) assert.equal(ringedPatch.values[index], plainPatch.values[index]);
  }
});
test('template requires explicit human confirmation', () => expectCode('HUMAN_CONFIRMATION_REQUIRED', () => createTemplate({ side: 'red', type: 'K', patch: glyph() })));
test('all internal piece representation codes are accepted', () => {
  for (const type of ['K', 'A', 'B', 'N', 'R', 'C', 'P']) {
    assert.equal(createTemplate({ side: 'red', type, patch: glyph(), confirmedByHuman: true }).type, type);
  }
});
test('invalid piece representation code is rejected', () => expectCode('INVALID_TYPE', () => createTemplate({ side: 'red', type: 'X', patch: glyph(), confirmedByHuman: true })));
test('red and black templates remain separate', () => {
  let library = createTemplateLibrary();
  library = withTemplate(library, 'red', 'K', glyph('L'));
  library = withTemplate(library, 'black', 'K', glyph('T'));
  assert.equal(rankPieceTypes(glyph('L'), library, 'red')[0].templateId, 'template-1');
  assert.equal(rankPieceTypes(glyph('T'), library, 'black')[0].templateId, 'template-2');
});
test('add template returns a new library', () => {
  const original = createTemplateLibrary();
  const next = withTemplate(original, 'red', 'R', glyph());
  assert.equal(listTemplates(original).length, 0);
  assert.equal(listTemplates(next).length, 1);
});
test('multiple templates for the same side and type are retained', () => {
  let library = createTemplateLibrary();
  library = withTemplate(library, 'red', 'R', glyph('L'), 'one');
  library = withTemplate(library, 'red', 'R', glyph('T'), 'two');
  assert.equal(listTemplates(library).length, 2);
  assert.equal(rankPieceTypes(glyph('T'), library, 'red')[0].templateId, 'template-2');
});
test('remove template deletes only exact ID', () => {
  let library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  library = withTemplate(library, 'red', 'C', glyph('T'));
  const next = removeTemplate(library, 'template-1');
  assert.deepEqual(listTemplates(next).map(({ type }) => type), ['C']);
});
test('remove templates for source supports human correction', () => {
  let library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'), '5,4');
  library = withTemplate(library, 'red', 'C', glyph('T'), '5,5');
  assert.deepEqual(listTemplates(removeTemplatesForSource(library, '5,4')).map(({ type }) => type), ['C']);
});
test('template listing is defensively copied', () => {
  const library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph());
  const listed = listTemplates(library);
  listed[0].type = 'C';
  assert.equal(listTemplates(library)[0].type, 'R');
});
test('identical patches have very high similarity', () => assert.ok(comparePiecePatches(glyph('L'), glyph('L')).score > 0.98));
test('visually different patches score below identical patches', () => assert.ok(comparePiecePatches(glyph('L'), glyph('X')).score < comparePiecePatches(glyph('L'), glyph('L')).score));
test('90 degree template rotation is matched', () => assert.ok(comparePiecePatches(glyph('L'), rotatePatchFixture(glyph('L'), 90)).score > 0.98));
test('180 degree template rotation is matched', () => assert.ok(comparePiecePatches(glyph('L'), rotatePatchFixture(glyph('L'), 180)).score > 0.98));
test('270 degree template rotation is matched', () => assert.ok(comparePiecePatches(glyph('L'), rotatePatchFixture(glyph('L'), 270)).score > 0.98));
test('confidence with no ranking is zero', () => assert.equal(confidenceForRanking(glyph(), []), 0));
test('confidence remains finite and bounded', () => {
  let library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  library = withTemplate(library, 'red', 'C', glyph('T'));
  const confidence = confidenceForRanking(glyph('L'), rankPieceTypes(glyph('L'), library, 'red'));
  assert.ok(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1);
});
test('no templates produces unknown suggestion', () => assert.deepEqual(suggestPieceType(glyph(), createTemplateLibrary(), 'red'), {
  status: 'unknown', side: 'red', type: null, confidence: 0, alternatives: [],
}));
test('unknown candidate side cannot borrow cross-side templates', () => {
  const library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph());
  assert.equal(suggestPieceType(glyph(), library, 'unknown').status, 'unknown');
});
test('tied top scores remain uncertain', () => {
  let library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  library = withTemplate(library, 'red', 'C', glyph('L'));
  assert.equal(suggestPieceType(glyph('L'), library, 'red').status, 'uncertain');
});
test('strong separated match becomes a suggestion', () => {
  let library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  library = withTemplate(library, 'red', 'C', glyph('X'));
  const result = suggestPieceType(glyph('L'), library, 'red');
  assert.equal(result.status, 'suggested');
  assert.equal(result.type, 'R');
});
test('unseen glyph remains unknown instead of forced', () => {
  const library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  assert.notEqual(suggestPieceType(glyph('dot'), library, 'red').status, 'suggested');
});
test('ranked alternatives are bounded to top three', () => {
  let library = createTemplateLibrary();
  for (const [index, type] of ['K', 'A', 'B', 'N', 'R'].entries()) library = withTemplate(library, 'red', type, glyph(index % 2 ? 'L' : 'T'));
  assert.equal(rankPieceTypes(glyph('L'), library, 'red').length, PIECE_TYPE_THRESHOLDS.maximumAlternatives);
});
test('adding human template updates unresolved suggestion', () => {
  const before = suggestPieceType(glyph('T'), createTemplateLibrary(), 'red');
  const library = withTemplate(createTemplateLibrary(), 'red', 'C', glyph('T'));
  const after = suggestPieceType(glyph('T'), library, 'red');
  assert.equal(before.status, 'unknown');
  assert.equal(after.type, 'C');
});
test('only unresolved occupied candidates are re-evaluated', () => {
  const library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  const result = suggestUnresolvedPieceTypes({
    candidates: [
      { r: 0, c: 0, occupancy: 'occupied', suggestedSide: 'red' },
      { r: 0, c: 1, occupancy: 'empty', suggestedSide: 'red' },
      { r: 0, c: 2, occupancy: 'uncertain', suggestedSide: 'red' },
    ],
    selections: {},
    patches: { '0,0': glyph('L'), '0,1': glyph('L'), '0,2': glyph('L') },
    library,
  });
  assert.deepEqual(Object.keys(result), ['0,0']);
});
test('human-confirmed piece is skipped during re-evaluation', () => {
  const library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  const result = suggestUnresolvedPieceTypes({ candidates: [{ r: 0, c: 0, occupancy: 'occupied', suggestedSide: 'red' }], selections: { '0,0': { side: 'red', type: 'C' } }, patches: { '0,0': glyph('L') }, library });
  assert.deepEqual(result, {});
});
test('human-confirmed empty is skipped during re-evaluation', () => {
  const library = withTemplate(createTemplateLibrary(), 'red', 'R', glyph('L'));
  const result = suggestUnresolvedPieceTypes({ candidates: [{ r: 0, c: 0, occupancy: 'occupied', suggestedSide: 'red' }], selections: { '0,0': null }, patches: { '0,0': glyph('L') }, library });
  assert.deepEqual(result, {});
});
test('re-evaluation never mutates human selections', () => {
  const selections = { '0,0': { side: 'red', type: 'C' } };
  const before = structuredClone(selections);
  suggestUnresolvedPieceTypes({ candidates: [{ r: 0, c: 0, occupancy: 'occupied', suggestedSide: 'red' }], selections, patches: { '0,0': glyph('L') }, library: createTemplateLibrary() });
  assert.deepEqual(selections, before);
});
test('piece-type session token is current for exact source versions', () => {
  const token = createPieceTypeSessionToken({ photoVersion: 1, calibrationVersion: 2, recognitionVersion: 3 });
  assert.equal(isPieceTypeSessionCurrent(token, { photoVersion: 1, calibrationVersion: 2, recognitionVersion: 3 }), true);
});
test('photo replacement invalidates template session', () => {
  const token = createPieceTypeSessionToken({ photoVersion: 1, calibrationVersion: 2, recognitionVersion: 3 });
  assert.equal(isPieceTypeSessionCurrent(token, { photoVersion: 2, calibrationVersion: 2, recognitionVersion: 3 }), false);
});
test('calibration change invalidates template session', () => {
  const token = createPieceTypeSessionToken({ photoVersion: 1, calibrationVersion: 2, recognitionVersion: 3 });
  assert.equal(isPieceTypeSessionCurrent(token, { photoVersion: 1, calibrationVersion: 3, recognitionVersion: 3 }), false);
});
test('recognition rescan invalidates template session', () => {
  const token = createPieceTypeSessionToken({ photoVersion: 1, calibrationVersion: 2, recognitionVersion: 3 });
  assert.equal(isPieceTypeSessionCurrent(token, { photoVersion: 1, calibrationVersion: 2, recognitionVersion: 4 }), false);
});
test('invalid session version fails closed', () => expectCode('INVALID_VERSION', () => createPieceTypeSessionToken({ photoVersion: 0, calibrationVersion: -1, recognitionVersion: 0 })));
test('reset library clears all memory-only templates', () => {
  const populated = withTemplate(createTemplateLibrary(), 'red', 'R', glyph());
  assert.equal(listTemplates(populated).length, 1);
  assert.equal(listTemplates(createTemplateLibrary()).length, 0);
});
test('invalid candidate coordinates fail deterministically', () => expectCode('INVALID_CANDIDATE', () => suggestUnresolvedPieceTypes({ candidates: [{ r: 10, c: 0, occupancy: 'occupied', suggestedSide: 'red' }], selections: {}, patches: {}, library: createTemplateLibrary() })));

function glyphSource() {
  const source = pixels();
  return paint(source, (x, y) => (x >= 16 && x <= 18 && y >= 11 && y <= 29) || (y >= 27 && y <= 29 && x >= 16 && x <= 27));
}

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

console.log(`\n${passed} puzzle-photo-piece-types tests passed; ${tests.length - passed} failed.`);
