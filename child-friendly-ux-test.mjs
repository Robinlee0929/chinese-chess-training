import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { getLiveBoardAzimuthDeg } from './piece-glyph-orientation.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const fn = name => source.match(new RegExp('^function ' + name + '\\([^]*?^}', 'm'))[0];

test('four guarded entries keep the internal ID and use the child-facing name', () => {
  for (const id of ['modeSel', 'customPlayDifficulty', 'gameReviewContinuationDifficulty', 'savedPositionDifficulty']) {
    const select = html.match(new RegExp('<select[^>]*id="' + id + '"[^]*?</select>'))[0];
    assert.match(select, /<option value="experimental-b" disabled>挑戰級（試玩）/);
  }
  assert.match(html, /不保證比困難級強。完整棋譜不會永久保存/);
  for (const file of ['index.html', 'main.js', 'saved-position-ui.js', 'saved-position-async-session.js']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /實驗對手 B|大師級/);
  }
});

test('first camera equals the existing red-bottom preset without replacing preference restoration', () => {
  assert.match(source, /const HOME_AZIMUTH = 0;/);
  assert.match(source, /const HOME_POLAR = 55;/);
  assert.match(source, /let viewIdx = 2;/);
  assert.match(source, /newGame\(\{ reconcileHumanSideCamera: false \}\)/);
});

test('automatic perspective selects bottom views and respects explicit lock', () => {
  const calls = [], ctx = vm.createContext({ BLACK: 'black', viewLocked: false,
    activateCameraView: (index, options) => calls.push({ index, ...options }) });
  vm.runInContext(fn('showPlayerPerspective'), ctx);
  ctx.showPlayerPerspective('red'); ctx.showPlayerPerspective('black');
  assert.deepEqual(calls, [{ index: 2, announce: false }, { index: 4, announce: false }]);
  ctx.viewLocked = true; ctx.showPlayerPerspective('red'); assert.equal(calls.length, 2);
  assert.match(fn('flyTo'), /setFromVector3/);
  assert.match(fn('flyTo'), /if \(dTheta === -Math.PI\) dTheta = Math.PI/);
});

test('viewer side follows live camera even after manual rotation, not a stale preset index', () => {
  const ctx = vm.createContext({ RED: 'red', BLACK: 'black',
    THREE: { MathUtils: { degToRad: n => n * Math.PI / 180 } }, getLiveBoardAzimuthDeg,
    camera: { position: { x: 0, y: 10, z: 10 } }, controls: { target: { x: 0, y: 0, z: 0 } } });
  vm.runInContext(fn('cameraViewerSide'), ctx);
  assert.equal(ctx.cameraViewerSide(), 'red');
  ctx.camera.position.z = -10; assert.equal(ctx.cameraViewerSide(), 'black');
  ctx.camera.position = { x: 10, y: 10, z: 0 }; assert.equal(ctx.cameraViewerSide(), null);
  ctx.camera.position = { x: 0, y: 10, z: 0 }; assert.equal(ctx.cameraViewerSide(), null);
});

test('resize keeps a horizontal field of view without changing the camera position', () => {
  const position = { x: 1, y: 10, z: -12 };
  const ctx = vm.createContext({ container: { clientWidth: 390, clientHeight: 600 },
    THREE: { MathUtils: { degToRad: n => n * Math.PI / 180, radToDeg: n => n * 180 / Math.PI } },
    camera: { position, updateProjectionMatrix() {} }, renderer: { setSize() {} } });
  vm.runInContext(fn('resize'), ctx); ctx.resize();
  assert.ok(ctx.camera.fov > 38 && ctx.camera.fov < 90);
  assert.equal(ctx.camera.position, position);
  ctx.container.clientWidth = 1600; ctx.resize(); assert.equal(ctx.camera.fov, 38);
});

test('board-hit fallback selects an occupied intersection when an exact mesh seam misses', () => {
  const pawn = { userData: { r: 6, c: 4, piece: { side: 'black', type: 'P' } } };
  let meshHits = [];
  const ctx = vm.createContext({ camera: {}, pieces: [pawn], boardMesh: {}, ROWS: 10, COLS: 9,
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 600 }) } },
    ndc: { set() {} }, ray: { setFromCamera() {}, intersectObjects: () => meshHits,
      intersectObject: () => [{ point: { x: 0, z: -1.5 } }] },
    to3D: (r, c) => ({ x: c - 4, z: 4.5 - r }) });
  vm.runInContext(fn('pieceAt') + '\n' + fn('pick'), ctx);
  assert.equal(ctx.pick({ clientX: 195, clientY: 300 }), pawn);
  ctx.pieces = []; assert.equal(JSON.stringify(ctx.pick({ clientX: 195, clientY: 300 })), JSON.stringify({ r: 6, c: 4 }));
  meshHits = [{ object: pawn }]; assert.equal(ctx.pick({ clientX: 195, clientY: 300 }), pawn);
});
