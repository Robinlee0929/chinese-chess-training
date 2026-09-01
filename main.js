// ============================================================
// 中國象棋 3D —— Three.js 呈現 + 互動
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  ROWS, COLS, RED, BLACK,
  initialBoard, legalMoves, applyMove, inCheck,
  hasAnyLegalMove, name, notation, hashBoard, repetitionVerdict,
} from './game.js?v=4dd3e2c2ca';
import { createGameRecord } from './game-record.js?v=4dd3e2c2ca';
import { createGameRecordStore } from './game-record-store.js?v=4dd3e2c2ca';
import {
  createGameReview,
  createGameRecordLibraryView,
  firstGameReviewPly,
  previousGameReviewPly,
  nextGameReviewPly,
  lastGameReviewPly,
  selectGameReviewPly,
} from './game-review.js?v=4dd3e2c2ca';
import {
  createGameReviewAiState,
  invalidateGameReviewAiState,
  beginGameReviewAiRequest,
  settleGameReviewAiResponse,
} from './game-review-ai.js?v=4dd3e2c2ca';
import { createGameReviewEvidence } from './game-review-evidence.js?v=4dd3e2c2ca';
import { deriveGameReviewTeaching } from './game-review-teaching.js?v=4dd3e2c2ca';
import {
  createGameAnalysis,
  gameAnalysisLegalMoves,
  applyGameAnalysisMove,
  undoGameAnalysisMove,
  resetGameAnalysis,
} from './game-analysis.js?v=4dd3e2c2ca';
import { createGameReviewPuzzleHandoff } from './game-review-puzzle-handoff.js?v=4dd3e2c2ca';
import {
  PuzzleEditorError,
  createEditorState,
  placeEditorPiece,
  moveEditorPiece,
  removeEditorPiece,
  setEditorSideToMove,
  confirmAuthoredPosition,
  exportAuthoredPosition,
} from './puzzle-editor.js?v=4dd3e2c2ca';
import {
  PuzzleRecorderError,
  createRecorder,
  recordMove,
  undoRecordedMove,
  resetRecording,
  finishRecording,
  exportRecorderBoard,
  exportRecordedResult,
} from './puzzle-recorder.js?v=4dd3e2c2ca';
import {
  PuzzlePracticeError,
  PRACTICE_HINT_MAX_LEVEL,
  createPractice,
  attemptPracticeMove,
  applyOpponentReply,
  derivePracticeHint,
  restartPractice,
  exportPracticeSnapshot,
} from './puzzle-practice.js?v=4dd3e2c2ca';
import { PuzzleStoreError, createPuzzleStore } from './puzzle-store.js?v=4dd3e2c2ca';
import {
  PracticeAnalyticsError,
  createPracticeAnalyticsStore,
} from './puzzle-analytics.js?v=4dd3e2c2ca';
import {
  PUZZLE_TRANSFER_FORMAT,
  PUZZLE_TRANSFER_SCHEMA_VERSION,
  PUZZLE_TRANSFER_MAX_BYTES,
  PuzzleTransferError,
  serializePuzzleExport,
  parsePuzzleImport,
} from './puzzle-transfer.js?v=4dd3e2c2ca';
import {
  PHOTO_MAX_ZOOM,
  PHOTO_MIN_ZOOM,
  PuzzlePhotoError,
  clearPhotoReference,
  createPhotoReferenceState,
  resetPhotoTransform,
  rotatePhotoLeft,
  rotatePhotoRight,
  setPhotoReference,
  validatePhotoMetadata,
  zoomPhotoIn,
  zoomPhotoOut,
} from './puzzle-photo.js?v=4dd3e2c2ca';
import {
  CALIBRATION_CANONICAL_HEIGHT,
  CALIBRATION_CANONICAL_WIDTH,
  CALIBRATION_CORNER_NAMES,
  CALIBRATION_ORIENTATION_RED_BOTTOM,
  PuzzlePhotoCalibrationError,
  computeHomography,
  createCalibrationState,
  createGridIntersections,
  exportCalibration,
  resetCalibration,
  setCalibrationOrientation,
  setCorner,
  transformPoint,
  validateQuadrilateral,
} from './puzzle-photo-calibration.js?v=4dd3e2c2ca';
import {
  PuzzlePhotoRecognitionError,
  RECOGNITION_OCCUPANCY_EMPTY,
  RECOGNITION_OCCUPANCY_OCCUPIED,
  RECOGNITION_OCCUPANCY_UNCERTAIN,
  RECOGNITION_SIDE_UNKNOWN,
  createRecognitionToken,
  derivePatchRadius,
  isRecognitionTokenCurrent,
  recognizeIntersections,
  selectionKey,
} from './puzzle-photo-recognition.js?v=4dd3e2c2ca';
import {
  addTemplate,
  createPieceTypeSessionToken,
  createTemplateLibrary,
  isPieceTypeSessionCurrent,
  listTemplates,
  normalizePiecePatch,
  removeTemplatesForSource,
  suggestUnresolvedPieceTypes,
} from './puzzle-photo-piece-types.js?v=4dd3e2c2ca';
import {
  UNREVIEWED, PuzzlePhotoReviewError,
  createReviewState, buildReviewQueue, selectReviewCandidate, confirmEmpty, confirmPiece,
  nextCandidate, previousCandidate, nextUnresolved, acceptHighConfidenceEmpty,
  undoBulkEmpty, resetReview, rescanReview, reviewProgress, confirmedSelections, buildReviewedBoard,
} from './puzzle-photo-review.js?v=4dd3e2c2ca';

// ---------------- 常數 ----------------
const CELL = 1;
const PAD = 0.6;
const BOARD_W = (COLS - 1) * CELL + PAD * 2;
const BOARD_H = (ROWS - 1) * CELL + PAD * 2;
const PIECE_H = 0.36;
const Y0 = PIECE_H / 2; // 棋子中心高度（貼著盤面）

const to3D = (r, c) =>
  new THREE.Vector3((c - (COLS - 1) / 2) * CELL, 0, ((ROWS - 1) / 2 - r) * CELL);

// ---------------- 场景 / 相机 / 渲染 ----------------
const container = document.getElementById('stage');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x171310);
scene.fog = new THREE.Fog(0x171310, 20, 46);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);

// 預設機位：以注視點為圓心，向左旋轉 90°（方位角 -90°）、向下翻轉 45°（極角 45°）
const HOME_DIST = 14.8;
const HOME_AZIMUTH = -90;
const HOME_POLAR = 45;
const HOME_TGT = new THREE.Vector3(0, -0.1, 0.2);
const HOME = {
  tgt: HOME_TGT,
  pos: new THREE.Vector3()
    .setFromSphericalCoords(
      HOME_DIST,
      THREE.MathUtils.degToRad(HOME_POLAR),
      THREE.MathUtils.degToRad(HOME_AZIMUTH),
    )
    .add(HOME_TGT),
};
camera.position.copy(HOME.pos);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.tgt);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 5;
controls.maxDistance = 22;
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = 1.38;
controls.enablePan = false;
controls.update();

// ---------------- 灯光 ----------------
scene.add(new THREE.HemisphereLight(0xfff1dd, 0x241b12, 0.85));
const sun = new THREE.DirectionalLight(0xffe7c2, 1.9);
sun.position.set(6, 12, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -9; sun.shadow.camera.right = 9;
sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
sun.shadow.camera.near = 2; sun.shadow.camera.far = 40;
sun.shadow.bias = -0.0006;
scene.add(sun);
const rim = new THREE.DirectionalLight(0x8fb7ff, 0.25);
rim.position.set(-8, 4, -6);
scene.add(rim);

// ---------------- 棋盘 ----------------
function makeBoardTexture() {
  const cell = 100, pad = 60;
  const W = (COLS - 1) * cell + pad * 2, H = (ROWS - 1) * cell + pad * 2;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  // 木紋底
  const grd = g.createLinearGradient(0, 0, W, H);
  grd.addColorStop(0, '#e0b884');
  grd.addColorStop(0.5, '#d5a971');
  grd.addColorStop(1, '#c99c64');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 160; i++) {
    g.strokeStyle = `rgba(118,78,38,${0.03 + Math.random() * 0.05})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    const y = Math.random() * H;
    g.beginPath();
    g.moveTo(0, y);
    g.bezierCurveTo(W * 0.3, y + (Math.random() * 16 - 8), W * 0.65, y + (Math.random() * 16 - 8), W, y + (Math.random() * 10 - 5));
    g.stroke();
  }

  const P = (r, c) => ({ x: pad + c * cell, y: pad + r * cell });
  const line = (a, b) => { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); };

  // 外框
  g.strokeStyle = '#4a3320';
  g.lineWidth = 5;
  g.strokeRect(pad * 0.42, pad * 0.42, W - pad * 0.84, H - pad * 0.84);
  g.lineWidth = 3;
  g.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

  // 橫線
  for (let r = 0; r < ROWS; r++) line(P(r, 0), P(r, COLS - 1));
  // 縱線（中間被楚河漢界斷開，兩邊界線貫穿）
  for (let c = 0; c < COLS; c++) {
    if (c === 0 || c === COLS - 1) line(P(0, c), P(ROWS - 1, c));
    else { line(P(0, c), P(4, c)); line(P(5, c), P(9, c)); }
  }
  // 九宮斜線
  line(P(0, 3), P(2, 5)); line(P(0, 5), P(2, 3));
  line(P(7, 3), P(9, 5)); line(P(7, 5), P(9, 3));

  // 星位（炮位、兵位）
  g.lineWidth = 2.5;
  const star = (r, c) => {
    const p = P(r, c), d = 12, o = 8;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x0 = p.x + sx * o, y0 = p.y + sy * o;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + sx * d, y0); g.stroke();
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0, y0 + sy * d); g.stroke();
    }
  };
  for (const [r, c] of [
    [2, 1], [2, 7], [7, 1], [7, 7],
    [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
    [6, 0], [6, 2], [6, 4], [6, 6], [6, 8],
  ]) star(r, c);

  // 楚河 / 漢界 —— 直書：字沿河界縱向排列，且在預設視角下正立
  // （貼圖相對於畫面旋轉了 90°：畫面上方 = 貼圖 +x，故字需旋轉 90° 並沿 x 排列）
  g.fillStyle = 'rgba(74,51,32,0.8)';
  g.font = '56px "Kaiti SC","STKaiti","KaiTi","Noto Serif TC",serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const ry = (4 + 5) / 2 * cell + pad;
  const vChar = (ch, x) => {
    g.save();
    g.translate(x, ry);
    g.rotate(Math.PI / 2);
    g.fillText(ch, 0, 3);
    g.restore();
  };
  vChar('楚', 264); vChar('河', 196);          // 畫面下方直書「楚河」
  vChar('漢', W - 196); vChar('界', W - 264);  // 畫面上方直書「漢界」

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

const boardMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(BOARD_W, BOARD_H),
  new THREE.MeshStandardMaterial({ map: makeBoardTexture(), roughness: 0.72, metalness: 0.02 })
);
boardMesh.rotation.x = -Math.PI / 2;
boardMesh.receiveShadow = true;
scene.add(boardMesh);

// 盤底座
const slab = new THREE.Mesh(
  new THREE.BoxGeometry(BOARD_W + 0.55, 0.34, BOARD_H + 0.55),
  new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.55, metalness: 0.12 })
);
slab.position.y = -0.18;
slab.castShadow = true;
slab.receiveShadow = true;
scene.add(slab);

// 地面
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(30, 48),
  new THREE.MeshStandardMaterial({ color: 0x141009, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.45;
ground.receiveShadow = true;
scene.add(ground);

// ---------------- 棋子 ----------------
let sideMat = null, botMat = null;
function sharedPieceMats() {
  if (sideMat) return;
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 128;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, '#cf9f66');
  grd.addColorStop(0.55, '#c2914f');
  grd.addColorStop(1, '#a97a42');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(90,58,26,0.25)';
  for (let i = 0; i < 7; i++) {
    g.lineWidth = 1 + Math.random() * 2;
    const y = Math.random() * 128;
    g.beginPath(); g.moveTo(0, y); g.lineTo(128, y + (Math.random() * 8 - 4)); g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  sideMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.05 });
  botMat = new THREE.MeshStandardMaterial({ color: 0x6b5133, roughness: 0.9 });
}
sharedPieceMats();

const PIECE_GEO = new THREE.CylinderGeometry(0.4, 0.46, PIECE_H, 48);

function makeTopTexture(side, type) {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = s; cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2 - 22, 12, s / 2, s / 2, s / 2);
  grd.addColorStop(0, '#eed6a8');
  grd.addColorStop(0.72, '#dcb27a');
  grd.addColorStop(1, '#c08f52');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(118,78,38,0.16)';
  for (let i = 0; i < 6; i++) {
    g.lineWidth = 0.8 + Math.random() * 1.4;
    g.beginPath();
    g.arc(s / 2, s / 2, 26 + i * 13 + Math.random() * 5, 0, Math.PI * 2);
    g.stroke();
  }
  const col = side === RED ? 'rgba(173,42,32,0.96)' : 'rgba(36,33,29,0.96)';
  g.strokeStyle = col;
  g.lineWidth = 9;
  g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 15, 0, Math.PI * 2); g.stroke();
  g.fillStyle = col;
  g.font = '900 118px "Kaiti SC","STKaiti","KaiTi","Noto Serif TC",serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // 棋子文字朝向持有者：紅方在原點側（畫面下方），黑方在遠端（畫面上方）
  if (side === BLACK) {
    g.translate(s / 2, s / 2);
    g.rotate(Math.PI);
    g.translate(-s / 2, -s / 2);
  }
  g.fillText(name(side, type), s / 2, s / 2 + 8);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function makePiece(piece, r, c) {
  const m = new THREE.Mesh(
    PIECE_GEO,
    [
      sideMat,
      new THREE.MeshStandardMaterial({ map: makeTopTexture(piece.side, piece.type), roughness: 0.5, metalness: 0.05 }),
      botMat,
    ]
  );
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData = { piece, r, c };
  const p = to3D(r, c);
  m.position.set(p.x, Y0, p.z);
  return m;
}

// ---------------- 高亮 ----------------
const selRing = new THREE.Mesh(
  new THREE.RingGeometry(0.5, 0.64, 48),
  new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
);
selRing.rotation.x = -Math.PI / 2;
selRing.visible = false;
scene.add(selRing);

// 最後一步標記（起點淡、終點深）
function mkLastMark(opacity) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.92, 0.92),
    new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.012;
  m.renderOrder = 3;
  m.visible = false;
  scene.add(m);
  return m;
}
const lastFromMark = mkLastMark(0.13);
const lastToMark = mkLastMark(0.26);
function syncLastMoveMark() {
  const h = history[history.length - 1];
  lastFromMark.visible = lastToMark.visible = !!h;
  if (!h) return;
  const a = to3D(h.from.r, h.from.c);
  const b = to3D(h.to.r, h.to.c);
  lastFromMark.position.set(a.x, 0.012, a.z);
  lastToMark.position.set(b.x, 0.012, b.z);
}

const fx = new THREE.Group();
scene.add(fx);
function clearFX() {
  for (const c of [...fx.children]) {
    fx.remove(c);
    c.geometry.dispose();
    c.material.dispose();
  }
}
function addFX(mesh) {
  mesh.renderOrder = 5;
  mesh.position.y = 0.02;
  fx.add(mesh);
}

// Practice hints use their own presentation-only layer. These meshes are not
// part of piece picking, selection, legal-move FX, or any domain state.
const practiceHintFX = new THREE.Group();
scene.add(practiceHintFX);
function clearPracticeHintMarkers() {
  for (const marker of [...practiceHintFX.children]) {
    practiceHintFX.remove(marker);
    marker.geometry.dispose();
    marker.material.dispose();
  }
}
function addPracticeHintMarker(coordinate, kind) {
  const source = kind === 'source';
  const marker = new THREE.Mesh(
    source ? new THREE.RingGeometry(0.52, 0.68, 48) : new THREE.PlaneGeometry(1.12, 1.12),
    new THREE.MeshBasicMaterial({
      color: source ? 0x69c7d4 : 0xf0a85b,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      wireframe: !source,
      depthWrite: false,
    }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.renderOrder = 6;
  marker.userData.practiceHintMarker = kind;
  marker.raycast = () => {};
  const point = to3D(coordinate.r, coordinate.c);
  marker.position.set(point.x, 0.035, point.z);
  practiceHintFX.add(marker);
}
function syncPracticeHintMarkers() {
  clearPracticeHintMarkers();
  if (practiceHint?.from) addPracticeHintMarker(practiceHint.from, 'source');
  if (practiceHint?.to) addPracticeHintMarker(practiceHint.to, 'target');
}
function showMoveDots(moves, sourceBoard = board, sourceSelection = selected) {
  clearFX();
  for (const m of moves) {
    const p = to3D(m.r, m.c);
    if (sourceBoard[m.r][m.c]) {
      // 可吃敵子：紅圈包圍
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.64, 48),
        new THREE.MeshBasicMaterial({ color: 0xe2736a, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      addFX(ring);
      ring.position.x = p.x; ring.position.z = p.z;
    } else {
      // 可走空位：綠點
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.28, 32),
        new THREE.MeshBasicMaterial({ color: 0x9fd68f, transparent: true, opacity: 0.85 })
      );
      dot.rotation.x = -Math.PI / 2;
      addFX(dot);
      dot.position.x = p.x; dot.position.z = p.z;
    }
  }
  showSelectRingAt(sourceSelection);
}

// ---------------- 声音 ----------------
let audio = null, muted = false;
function beep(freq, dur = 0.08, type = 'sine', gain = 0.12) {
  if (muted) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g);
    g.connect(audio.destination);
    const t = audio.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t);
    o.stop(t + dur);
  } catch { /* 無音訊環境則忽略 */ }
}
const sfx = {
  select: () => beep(680, 0.05, 'triangle'),
  move: () => beep(420, 0.08, 'sine'),
  capture: () => { beep(210, 0.14, 'square', 0.1); setTimeout(() => beep(330, 0.1, 'sine'), 60); },
  check: () => { beep(660, 0.1); setTimeout(() => beep(880, 0.16), 90); },
  win: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'triangle', 0.12), i * 110)); },
  lose: () => { [392, 311, 262].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'sine', 0.09), i * 170)); },
};

// ---------------- tween ----------------
const tweens = [];
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
function tween(dur, fn, done, delay = 0, tag = null) {
  tweens.push({ t0: performance.now() + delay, dur, fn, done, tag });
}
// 分頁隱藏時 rAF 會暫停；用計時器低頻補跑主迴圈，避免棋局卡在動畫中
setInterval(() => { if (document.hidden) tick(performance.now()); }, 500);

function stepTweens(now) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (now < tw.t0) continue;
    let k = (now - tw.t0) / tw.dur;
    if (k > 1) k = 1;
    tw.fn(ease(k));
    if (k === 1) {
      tweens.splice(i, 1);
      if (tw.done) tw.done();
    }
  }
}

// ---------------- 遊戲状态 ----------------
let board = null;
let turn = RED;
let selected = null;   // {r,c}
let legal = [];        // 選中子的合法著法
let pieces = [];       // 所有棋子 mesh
let history = [];      // {from,to,captured,nota}
let posHistory = [];   // 每步之後的局面雜湊，供 AI 避免重複局面
let repHistory = [];   // {key,mover,check}：三次重複局面／長將判決用
let capturedBy = { [RED]: [], [BLACK]: [] };
let over = false, winner = null, busy = false;
let gameStartTime = Date.now();
let undoCount = 0;     // 本局悔棋次數（人機模式一次連退兩著仍計 1 次）

// ---------------- 殺局工作流程 ----------------
const APP_STATE = Object.freeze({
  NORMAL_GAME: 'NORMAL_GAME',
  GAME_RECORD_LIBRARY: 'GAME_RECORD_LIBRARY',
  GAME_REVIEW: 'GAME_REVIEW',
  GAME_ANALYSIS: 'GAME_ANALYSIS',
  PUZZLE_EDITOR: 'PUZZLE_EDITOR',
  PUZZLE_CONFIRMED: 'PUZZLE_CONFIRMED',
  PUZZLE_RECORDING: 'PUZZLE_RECORDING',
  PUZZLE_RECORDED: 'PUZZLE_RECORDED',
  PUZZLE_PRACTICING: 'PUZZLE_PRACTICING',
  PUZZLE_PRACTICE_COMPLETE: 'PUZZLE_PRACTICE_COMPLETE',
  PUZZLE_LIBRARY: 'PUZZLE_LIBRARY',
  PUZZLE_VIEW: 'PUZZLE_VIEW',
});
let appState = APP_STATE.NORMAL_GAME;
let editorState = null;
let editorTool = { kind: 'move' };
let confirmedPosition = null;
let recorderState = null;
let recordedPuzzleResult = null;
let practiceState = null;
let practiceToken = 0;
let practiceHintLevel = 0;
let practiceHint = null;
let practiceAttempt = null;
// Access may throw when browser storage is disabled. Defer it to the store's
// guarded operations so normal play and unsaved authoring still work.
const browserStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
const gameRecordStore = createGameRecordStore({ storage: browserStorage });
const puzzleStore = createPuzzleStore({ storage: browserStorage });
const practiceAnalyticsStore = createPracticeAnalyticsStore({ storage: browserStorage });
let libraryViewPuzzle = null;
let activeSavedPuzzleId = null;
let savedCurrentPuzzleId = null;
let pendingPuzzleImport = null;
let puzzleImportToken = 0;
let practiceReturnState = 'recorded';
let practiceCompletionRecorded = false;
let photoReferenceState = createPhotoReferenceState();
let photoObjectUrl = null;
let pendingPhotoObjectUrl = null;
let photoLoadToken = 0;
let calibrationState = null;
let confirmedCalibration = null;
let calibrationMode = 'reference';
let activeCalibrationCorner = 'topLeft';
let calibrationPointerId = null;
let photoRecognitionVersion = 0;
let calibrationRecognitionVersion = 0;
let rectifiedPhotoPixels = null;
let recognitionSession = null;
let pieceTypeRecognitionVersion = 0;
let selectedRecognitionKey = null;
let recognitionUnresolvedOnly = false;

const PUZZLE_STATES = new Set([
  APP_STATE.PUZZLE_EDITOR,
  APP_STATE.PUZZLE_CONFIRMED,
  APP_STATE.PUZZLE_RECORDING,
  APP_STATE.PUZZLE_RECORDED,
  APP_STATE.PUZZLE_PRACTICING,
  APP_STATE.PUZZLE_PRACTICE_COMPLETE,
  APP_STATE.PUZZLE_LIBRARY,
  APP_STATE.PUZZLE_VIEW,
]);
const puzzleFlowActive = () => PUZZLE_STATES.has(appState);
const gameRecordFlowActive = () => appState === APP_STATE.GAME_RECORD_LIBRARY
  || appState === APP_STATE.GAME_REVIEW
  || appState === APP_STATE.GAME_ANALYSIS;
const normalGameActive = () => appState === APP_STATE.NORMAL_GAME;
const authoringActive = () => appState === APP_STATE.PUZZLE_EDITOR
  || appState === APP_STATE.PUZZLE_CONFIRMED;
const recorderVisible = () => appState === APP_STATE.PUZZLE_CONFIRMED
  || appState === APP_STATE.PUZZLE_RECORDING
  || appState === APP_STATE.PUZZLE_RECORDED
  || appState === APP_STATE.PUZZLE_PRACTICING
  || appState === APP_STATE.PUZZLE_PRACTICE_COMPLETE;
const recorderBoardActive = () => appState === APP_STATE.PUZZLE_RECORDING
  || appState === APP_STATE.PUZZLE_RECORDED;
const practiceActive = () => appState === APP_STATE.PUZZLE_PRACTICING
  || appState === APP_STATE.PUZZLE_PRACTICE_COMPLETE;
const libraryActive = () => appState === APP_STATE.PUZZLE_LIBRARY
  || appState === APP_STATE.PUZZLE_VIEW;
const puzzleBoardActive = () => recorderBoardActive() || practiceActive();

// ---------------- 對弈模式 / AI ----------------
let mode = 'medium';   // 'pvp' | 'easy' | 'medium' | 'hard'
const AI_SIDE = BLACK; // 人機模式：玩家執紅，AI 執黑
const isAI = () => mode !== 'pvp';
let aiThinking = false;
let aiToken = 0;       // 用於作廢過期的 AI 計算（開新局、悔棋後）
let aiMoveStart = 0;

const gameRecordNow = () => new Date().toISOString();
const gameRecordIdFactory = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
let normalGameRecordSession = null;
let completedGameRecordSessionId = null;
let lastCompletedGameRecord = null;
let gameReviewSession = null;
let gameReviewReturnState = APP_STATE.NORMAL_GAME;
let gameReviewInvoker = null;
let gameReviewStored = false;
let gameReviewLivePresentation = null;
let gameReviewPuzzleReturnContext = null;
let gameAnalysisState = null;
let gameAnalysisSelected = null;
let gameAnalysisLegal = [];
let gameAnalysisNotice = '';
let gameReviewAiState = createGameReviewAiState();
let gameReviewAiWorker = null;
let gameReviewEvidenceState = null;

let aiWorker = null;
let aiModule = null;   // Worker 不可用時的主執行緒後備
try {
  aiWorker = new Worker(new URL('./ai-worker.js?v=4dd3e2c2ca', import.meta.url), { type: 'module' });
  aiWorker.onmessage = (e) => onAIResult(e.data);
  aiWorker.onerror = () => {
    aiWorker = null;
    if (aiThinking) requestAIMove();
  };
} catch {
  aiWorker = null;
}

function requestAIMove() {
  const token = ++aiToken;
  const payload = {
    kind: 'normal-game',
    board: board.map((row) => row.map((p) => (p ? { ...p } : null))),
    side: turn,
    level: mode,
    recent: posHistory.slice(-16),
    token,
  };
  if (aiWorker) {
    aiWorker.postMessage(payload);
  } else {
    (aiModule ??= import('./ai.js?v=4dd3e2c2ca')).then(({ findBestMove }) => {
      setTimeout(() => {
        if (token !== aiToken) return;
        onAIResult({ token, result: findBestMove(payload.board, payload.side, payload.level, payload.recent) });
      }, 30);
    });
  }
}

function maybeAIMove() {
  if (!normalGameActive() || !isAI() || over || busy || turn !== AI_SIDE || aiThinking) return;
  aiThinking = true;
  aiMoveStart = performance.now();
  requestAIMove();
  refreshHUD();
}

function onAIResult({ token, result, error }) {
  if (token !== aiToken) return;
  if (error || !result) { aiThinking = false; refreshHUD(); return; }
  // 至少顯示一小段「思考中」，節奏比較自然
  const wait = Math.max(0, 500 - (performance.now() - aiMoveStart));
  setTimeout(() => {
    if (token !== aiToken) return;
    aiThinking = false;
    if (!normalGameActive() || over || busy || turn !== AI_SIDE) { refreshHUD(); return; }
    const { from, to } = result;
    const p = board[from.r] && board[from.r][from.c];
    const ok = p && p.side === turn &&
      legalMoves(board, from.r, from.c).some((m) => m.r === to.r && m.c === to.c);
    if (!ok) { refreshHUD(); return; }
    doMove(from, to);
  }, wait);
}

// 除錯／自動測試掛鉤
window.__chess = {
  get pieces() { return pieces; },
  get board() { return board; },
  get turn() { return turn; },
  get selected() { return selected; },
  get history() { return history; },
  get busy() { return busy; },
  get mode() { return mode; },
  get aiThinking() { return aiThinking; },
  get normalGameRecordSession() {
    return normalGameRecordSession ? structuredClone(normalGameRecordSession) : null;
  },
  get lastCompletedGameRecord() {
    return lastCompletedGameRecord ? createGameRecord(lastCompletedGameRecord) : null;
  },
  get appState() { return appState; },
  get gameReview() { return gameReviewSession; },
  get gameReviewAi() {
    return {
      status: gameReviewAiState.status,
      revision: gameReviewAiState.revision,
      recordId: gameReviewAiState.request?.recordId ?? null,
      ply: gameReviewAiState.request?.ply ?? null,
      candidate: gameReviewAiState.candidate ? structuredClone(gameReviewAiState.candidate) : null,
      workerActive: !!gameReviewAiWorker,
    };
  },
  get gameReviewEvidence() {
    return gameReviewEvidenceState ? structuredClone(gameReviewEvidenceState) : null;
  },
  get gameAnalysis() { return gameAnalysisState; },
  get editorDraft() { return editorState ? exportAuthoredPosition(editorState) : null; },
  get gameReviewPuzzleReturnContext() {
    return gameReviewPuzzleReturnContext ? {
      sourceRecordId: gameReviewPuzzleReturnContext.sourceRecordId,
      sourcePly: gameReviewPuzzleReturnContext.sourcePly,
    } : null;
  },
  get editorActive() { return puzzleFlowActive(); },
  get puzzleState() { return appState; },
  get editorResult() { return cloneConfirmedPosition(); },
  get recordedPuzzleResult() { return cloneRecordedPuzzleResult(); },
  get practiceState() { return practiceState ? exportPracticeSnapshot(practiceState) : null; },
  get practiceHintLevel() { return practiceHintLevel; },
  get practiceHint() { return practiceHint ? structuredClone(practiceHint) : null; },
  get practiceAttempt() { return practiceAttempt ? structuredClone(practiceAttempt) : null; },
  get practiceHintMarkers() {
    return practiceHintFX.children.map((marker) => marker.userData.practiceHintMarker);
  },
  get calibrationState() {
    return calibrationState ? {
      corners: Object.fromEntries(CALIBRATION_CORNER_NAMES.map((key) => [key, { ...calibrationState.corners[key] }])),
      orientation: calibrationState.orientation,
      sideToMove: calibrationState.sideToMove,
    } : null;
  },
  get confirmedCalibration() {
    return confirmedCalibration ? structuredClone(confirmedCalibration) : null;
  },
  get recognitionCandidates() {
    return recognitionSession ? recognitionSession.candidates.map((candidate) => ({ ...candidate })) : null;
  },
  get recognitionReviewedCount() {
    return recognitionSession ? Object.keys(recognitionSession.selections).length : 0;
  },
  get pieceTypeTemplateCount() {
    return recognitionSession ? listTemplates(recognitionSession.typeLibrary).length : 0;
  },
  get pieceTypeSuggestions() {
    return recognitionSession ? structuredClone(recognitionSession.typeSuggestions) : null;
  },
  setMode(m) { mode = m; const el = document.getElementById('modeSel'); if (el) el.value = m; },
  get lastResult() { return lastResult; },
  buildShareCard: (r) => buildShareCard(r || lastResult),
  resetTo,
  newGame,
  undo,
  doMove,
  enterGameRecordLibrary,
  openLastCompletedGameReview,
  openStoredGameReview,
  exitGameReview,
  exitGameRecordFlow,
  navigateGameReview,
  enterGameAnalysis,
  makeGameAnalysisMove,
  undoGameAnalysis,
  resetGameAnalysisToSource,
  returnToGameReview,
  createPuzzleFromGameReview,
  enterEditor,
  exitEditor,
  checkEditorMeshInvariant: () => checkBoardMeshInvariant(editorState?.board),
  checkPuzzleMeshInvariant: () => checkBoardMeshInvariant(activePuzzleBoard()),
  camera, renderer, scene, controls,
};

const appEl = document.getElementById('app');
const turnText = document.getElementById('turnText');
const turnDot = document.getElementById('turnDot');
const turnBox = document.getElementById('turn');
const logEl = document.getElementById('log');
const logEmpty = document.getElementById('logEmpty');
const capRedEl = document.getElementById('capRed');
const capBlackEl = document.getElementById('capBlack');
const banner = document.getElementById('checkBanner');
const overlay = document.getElementById('overlay');
const btnUndo = document.getElementById('btnUndo');
const btnNew = document.getElementById('btnNew');
const btnEditor = document.getElementById('btnEditor');
const btnLibrary = document.getElementById('btnLibrary');
const modeSel = document.getElementById('modeSel');
const btnGameRecords = document.getElementById('btnGameRecords');
const gameRecordPanel = document.getElementById('gameRecordPanel');
const gameRecordLibraryView = document.getElementById('gameRecordLibraryView');
const gameRecordLibraryHeading = document.getElementById('gameRecordLibraryHeading');
const gameRecordLibraryCount = document.getElementById('gameRecordLibraryCount');
const gameRecordLibraryIssues = document.getElementById('gameRecordLibraryIssues');
const gameRecordLibraryList = document.getElementById('gameRecordLibraryList');
const gameRecordLibraryEmpty = document.getElementById('gameRecordLibraryEmpty');
const gameReviewView = document.getElementById('gameReviewView');
const gameReviewHeading = document.getElementById('gameReviewHeading');
const gameReviewMeta = document.getElementById('gameReviewMeta');
const gameReviewStatus = document.getElementById('gameReviewStatus');
const gameReviewMoveCount = document.getElementById('gameReviewMoveCount');
const gameReviewMoveList = document.getElementById('gameReviewMoveList');
const btnGameReviewBack = document.getElementById('btnGameReviewBack');
const btnGameReviewFirst = document.getElementById('btnGameReviewFirst');
const btnGameReviewPrevious = document.getElementById('btnGameReviewPrevious');
const btnGameReviewNext = document.getElementById('btnGameReviewNext');
const btnGameReviewLast = document.getElementById('btnGameReviewLast');
const btnGameReviewAnalyze = document.getElementById('btnGameReviewAnalyze');
const btnGameReviewAiAnalyze = document.getElementById('btnGameReviewAiAnalyze');
const gameReviewAiPanel = document.getElementById('gameReviewAiPanel');
const gameReviewAiHeading = document.getElementById('gameReviewAiHeading');
const gameReviewAiDetail = document.getElementById('gameReviewAiDetail');
const gameReviewEvidence = document.getElementById('gameReviewEvidence');
const gameReviewEvidencePlayed = document.getElementById('gameReviewEvidencePlayed');
const gameReviewEvidenceCandidate = document.getElementById('gameReviewEvidenceCandidate');
const gameReviewEvidenceMatch = document.getElementById('gameReviewEvidenceMatch');
const gameReviewEvidenceFactsSection = document.getElementById('gameReviewEvidenceFactsSection');
const gameReviewEvidenceFacts = document.getElementById('gameReviewEvidenceFacts');
const gameReviewTeaching = document.getElementById('gameReviewTeaching');
const gameReviewTeachingTitle = document.getElementById('gameReviewTeachingTitle');
const gameReviewTeachingBody = document.getElementById('gameReviewTeachingBody');
const btnGameReviewCreatePuzzle = document.getElementById('btnGameReviewCreatePuzzle');
const btnGameReviewDelete = document.getElementById('btnGameReviewDelete');
const gameAnalysisView = document.getElementById('gameAnalysisView');
const gameAnalysisHeading = document.getElementById('gameAnalysisHeading');
const gameAnalysisMeta = document.getElementById('gameAnalysisMeta');
const gameAnalysisStatus = document.getElementById('gameAnalysisStatus');
const gameAnalysisMoveCount = document.getElementById('gameAnalysisMoveCount');
const gameAnalysisMoveList = document.getElementById('gameAnalysisMoveList');
const btnGameAnalysisUndo = document.getElementById('btnGameAnalysisUndo');
const btnGameAnalysisReset = document.getElementById('btnGameAnalysisReset');
const btnGameAnalysisReturn = document.getElementById('btnGameAnalysisReturn');
const btnReviewGame = document.getElementById('btnReviewGame');
const editorPanel = document.getElementById('editorPanel');
const editorHeading = document.getElementById('editorHeading');
const editorMessage = document.getElementById('editorMessage');
const editorToolText = document.getElementById('editorToolText');
const btnEditorMove = document.getElementById('btnEditorMove');
const btnEditorErase = document.getElementById('btnEditorErase');
const editorPieceButtons = [...document.querySelectorAll('[data-editor-side][data-editor-type]')];
const recorderPanel = document.getElementById('recorderPanel');
const recorderReady = document.getElementById('recorderReady');
const recorderWorkspace = document.getElementById('recorderWorkspace');
const recorderTitle = document.getElementById('recorderTitle');
const recorderSubtitle = document.getElementById('recorderSubtitle');
const recorderBadge = document.getElementById('recorderBadge');
const recorderTurnText = document.getElementById('recorderTurnText');
const recorderTurnDot = document.getElementById('recorderTurnDot');
const recorderLog = document.getElementById('recorderLog');
const recorderEmpty = document.getElementById('recorderEmpty');
const recorderMessage = document.getElementById('recorderMessage');
const btnRecorderUndo = document.getElementById('btnRecorderUndo');
const btnRecorderReset = document.getElementById('btnRecorderReset');
const btnRecorderFinish = document.getElementById('btnRecorderFinish');
const btnPracticeStart = document.getElementById('btnPracticeStart');
const practiceWorkspace = document.getElementById('practiceWorkspace');
const practiceTurnText = document.getElementById('practiceTurnText');
const practiceTurnDot = document.getElementById('practiceTurnDot');
const practiceProgress = document.getElementById('practiceProgress');
const practiceMistakes = document.getElementById('practiceMistakes');
const practiceMessage = document.getElementById('practiceMessage');
const practiceHintMessage = document.getElementById('practiceHintMessage');
const btnPracticeHint = document.getElementById('btnPracticeHint');
const btnPracticeRestart = document.getElementById('btnPracticeRestart');
const btnPracticeExit = document.getElementById('btnPracticeExit');
const savePuzzlePanel = document.getElementById('savePuzzlePanel');
const puzzleTitleInput = document.getElementById('puzzleTitleInput');
const puzzleNotesInput = document.getElementById('puzzleNotesInput');
const btnSavePuzzle = document.getElementById('btnSavePuzzle');
const savePuzzleMessage = document.getElementById('savePuzzleMessage');
const libraryPanel = document.getElementById('libraryPanel');
const libraryCount = document.getElementById('libraryCount');
const libraryIssues = document.getElementById('libraryIssues');
const libraryList = document.getElementById('libraryList');
const libraryEmpty = document.getElementById('libraryEmpty');
const libraryDetail = document.getElementById('libraryDetail');
const libraryDetailTitle = document.getElementById('libraryDetailTitle');
const libraryDetailMeta = document.getElementById('libraryDetailMeta');
const libraryDetailNotes = document.getElementById('libraryDetailNotes');
const libraryDetailSolution = document.getElementById('libraryDetailSolution');
const libraryAnalyticsStatus = document.getElementById('libraryAnalyticsStatus');
const libraryAnalyticsSummary = document.getElementById('libraryAnalyticsSummary');
const libraryRecentAttempts = document.getElementById('libraryRecentAttempts');
const btnLibraryDetailPractice = document.getElementById('btnLibraryDetailPractice');
const btnLibraryDetailDelete = document.getElementById('btnLibraryDetailDelete');
const btnLibraryExportAll = document.getElementById('btnLibraryExportAll');
const btnLibraryImport = document.getElementById('btnLibraryImport');
const puzzleImportFile = document.getElementById('puzzleImportFile');
const libraryTransferStatus = document.getElementById('libraryTransferStatus');
const libraryImportPreview = document.getElementById('libraryImportPreview');
const libraryImportPreviewText = document.getElementById('libraryImportPreviewText');
const btnLibraryImportConfirm = document.getElementById('btnLibraryImportConfirm');
const btnLibraryImportCancel = document.getElementById('btnLibraryImportCancel');
const btnLibraryDetailExport = document.getElementById('btnLibraryDetailExport');
const photoFileInput = document.getElementById('photoFileInput');
const btnPhotoImport = document.getElementById('btnPhotoImport');
const photoImportMessage = document.getElementById('photoImportMessage');
const photoPanel = document.getElementById('photoPanel');
const photoPreviewImage = document.getElementById('photoPreviewImage');
const photoTransformStatus = document.getElementById('photoTransformStatus');
const btnPhotoRotateLeft = document.getElementById('btnPhotoRotateLeft');
const btnPhotoRotateRight = document.getElementById('btnPhotoRotateRight');
const btnPhotoZoomOut = document.getElementById('btnPhotoZoomOut');
const btnPhotoZoomIn = document.getElementById('btnPhotoZoomIn');
const btnPhotoReset = document.getElementById('btnPhotoReset');
const photoReferenceView = document.getElementById('photoReferenceView');
const btnCalibrationStart = document.getElementById('btnCalibrationStart');
const calibrationSummary = document.getElementById('calibrationSummary');
const calibrationAdjustView = document.getElementById('calibrationAdjustView');
const calibrationPreviewView = document.getElementById('calibrationPreviewView');
const calibrationCornerCanvas = document.getElementById('calibrationCornerCanvas');
const calibrationRectifiedCanvas = document.getElementById('calibrationRectifiedCanvas');
const calibrationMessage = document.getElementById('calibrationMessage');
const calibrationPreviewStatus = document.getElementById('calibrationPreviewStatus');
const calibrationOrientationBadge = document.getElementById('calibrationOrientationBadge');
const calibrationCornerButtons = [...document.querySelectorAll('[data-calibration-corner]')];
const calibrationNudgeButtons = [...document.querySelectorAll('[data-calibration-nudge]')];
const calibrationOrientationInputs = [...document.querySelectorAll('input[name="calibrationOrientation"]')];
const btnCalibrationPreview = document.getElementById('btnCalibrationPreview');
const btnRecognitionScan = document.getElementById('btnRecognitionScan');
const recognitionReviewView = document.getElementById('recognitionReviewView');
const recognitionCanvas = document.getElementById('recognitionCanvas');
const recognitionMarkers = document.getElementById('recognitionMarkers');
const recognitionOccupiedCount = document.getElementById('recognitionOccupiedCount');
const recognitionUncertainCount = document.getElementById('recognitionUncertainCount');
const recognitionReviewedCount = document.getElementById('recognitionReviewedCount');
const recognitionUnresolvedOnlyInput = document.getElementById('recognitionUnresolvedOnly');
const recognitionSelectedCoordinate = document.getElementById('recognitionSelectedCoordinate');
const recognitionSuggestion = document.getElementById('recognitionSuggestion');
const recognitionTypeSuggestion = document.getElementById('recognitionTypeSuggestion');
const recognitionTypeConfidence = document.getElementById('recognitionTypeConfidence');
const recognitionTypeCard = document.getElementById('recognitionTypeCard');
const recognitionTargetCanvas = document.getElementById('recognitionTargetCanvas');
const recognitionPicker = document.getElementById('recognitionPicker');
const recognitionRemainingCount = document.getElementById('recognitionRemainingCount');
const recognitionBulkCount = document.getElementById('recognitionBulkCount');
const recognitionManualCount = document.getElementById('recognitionManualCount');
const recognitionKingSummary = document.getElementById('recognitionKingSummary');
const btnRecognitionAcceptEmpty = document.getElementById('btnRecognitionAcceptEmpty');
const btnRecognitionUndoEmpty = document.getElementById('btnRecognitionUndoEmpty');
const recognitionTemplateCount = document.getElementById('recognitionTemplateCount');
const recognitionMessage = document.getElementById('recognitionMessage');
const btnRecognitionEmpty = document.getElementById('btnRecognitionEmpty');
const btnRecognitionAdopt = document.getElementById('btnRecognitionAdopt');
const btnRecognitionManual = document.getElementById('btnRecognitionManual');
const btnRecognitionRematch = document.getElementById('btnRecognitionRematch');
const recognitionPieceButtons = [...document.querySelectorAll('[data-recognition-side][data-recognition-type]')];
const recognitionPalettes = [...document.querySelectorAll('.recognition-palette')];
const btnRecognitionApply = document.getElementById('btnRecognitionApply');

function refreshHUD() {
  const showSide = appState === APP_STATE.GAME_REVIEW
    ? gameReviewSession.snapshot.sideToMove
    : appState === APP_STATE.GAME_ANALYSIS
    ? gameAnalysisState.currentSide
    : practiceActive()
    ? practiceState.currentSide
    : (recorderBoardActive()
      ? recorderState.currentSide
      : (authoringActive()
        ? editorState.sideToMove
        : (appState === APP_STATE.PUZZLE_VIEW
          ? libraryViewPuzzle.sideToMove
          : (over && winner ? winner : turn))));
  const isRed = showSide === RED;
  if (appState === APP_STATE.GAME_RECORD_LIBRARY) {
    turnText.textContent = '對局紀錄';
  } else if (appState === APP_STATE.GAME_REVIEW) {
    turnText.textContent = gameReviewSession.atLast
      ? `複盤・${gameRecordResultLabel(gameReviewSession.record)}`
      : `複盤・第 ${gameReviewSession.selectedPly} / ${gameReviewSession.totalPlies} 著`;
  } else if (appState === APP_STATE.GAME_ANALYSIS) {
    turnText.textContent = gameAnalysisState.terminal
      ? `分析・${gameAnalysisTerminalLabel(gameAnalysisState.terminal)}`
      : `分析・${isRed ? '紅方' : '黑方'}行棋`;
  } else if (appState === APP_STATE.PUZZLE_EDITOR) {
    turnText.textContent = isRed ? '編輯中・紅方先行' : '編輯中・黑方先行';
  } else if (appState === APP_STATE.PUZZLE_CONFIRMED) {
    turnText.textContent = isRed ? '局面已確認・紅方先行' : '局面已確認・黑方先行';
  } else if (appState === APP_STATE.PUZZLE_RECORDING) {
    turnText.textContent = isRed ? '答案錄製・紅方行棋' : '答案錄製・黑方行棋';
  } else if (appState === APP_STATE.PUZZLE_RECORDED) {
    turnText.textContent = '答案已完成';
  } else if (appState === APP_STATE.PUZZLE_PRACTICING) {
    turnText.textContent = practiceState.currentSide === practiceState.practiceSide
      ? `殺局練習・${isRed ? '紅方' : '黑方'}請走`
      : '殺局練習・對手回應';
  } else if (appState === APP_STATE.PUZZLE_PRACTICE_COMPLETE) {
    turnText.textContent = '殺局練習完成';
  } else if (appState === APP_STATE.PUZZLE_LIBRARY) {
    turnText.textContent = '我的殺局';
  } else if (appState === APP_STATE.PUZZLE_VIEW) {
    turnText.textContent = `檢視・${libraryViewPuzzle.title}`;
  } else if (over) {
    turnText.textContent = winner == null ? '和局' : winner === RED ? '紅方勝' : '黑方勝';
  } else if (aiThinking) {
    turnText.textContent = 'AI 思考中…';
  } else if (isAI()) {
    turnText.textContent = isRed ? '輪到你了' : 'AI 行棋';
  } else {
    turnText.textContent = isRed ? '紅方行棋' : '黑方行棋';
  }
  const col = isRed ? '#c05345' : '#8b93a1';
  turnDot.style.background = col;
  turnDot.style.boxShadow = `0 0 10px ${col}`;
  turnBox.classList.toggle('thinking', normalGameActive() && aiThinking && !over);
  capRedEl.innerHTML = capturedBy[RED].map((p) => `<span class="chip ${p.side}">${name(p.side, p.type)}</span>`).join('') || '<em>—</em>';
  capBlackEl.innerHTML = capturedBy[BLACK].map((p) => `<span class="chip ${p.side}">${name(p.side, p.type)}</span>`).join('') || '<em>—</em>';
  btnUndo.disabled = !normalUndoAvailable();
  btnNew.disabled = !normalGameActive();
  modeSel.disabled = !normalGameActive();
  btnEditor.textContent = libraryActive() ? '建立殺局' : (puzzleFlowActive() ? '退出殺局' : '建立殺局');
  btnEditor.disabled = libraryActive() || gameRecordFlowActive();
  btnEditor.setAttribute('aria-pressed', String(puzzleFlowActive() && !libraryActive()));
  btnLibrary.textContent = libraryActive() ? '返回棋局' : '我的殺局';
  btnLibrary.disabled = gameRecordFlowActive() || (puzzleFlowActive() && !libraryActive());
  btnLibrary.setAttribute('aria-pressed', String(libraryActive()));
  btnGameRecords.textContent = gameRecordFlowActive() ? '返回棋局' : '對局紀錄';
  btnGameRecords.disabled = puzzleFlowActive() || ((busy || aiThinking) && !gameRecordFlowActive());
  btnGameRecords.setAttribute('aria-pressed', String(gameRecordFlowActive()));
}

function addLog(nota, side) {
  logEmpty.style.display = 'none';
  const li = document.createElement('li');
  const dot = document.createElement('span');
  dot.className = 'side ' + side;
  dot.textContent = side === RED ? '紅' : '黑';
  li.appendChild(dot);
  li.appendChild(document.createTextNode(' ' + nota));
  logEl.appendChild(li);
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearSelection() {
  selected = null;
  legal = [];
  clearFX();
  selRing.visible = false;
}

function showSelectRingAt(pos) {
  if (!pos) { selRing.visible = false; return; }
  const p = to3D(pos.r, pos.c);
  selRing.position.set(p.x, 0.02, p.z);
  selRing.visible = true;
}

function select(r, c) {
  clearSelection();
  selected = { r, c };
  legal = legalMoves(board, r, c);
  showSelectRingAt(selected);
  if (legal.length) showMoveDots(legal);
  sfx.select();
  refreshHUD();
}

function pieceAt(r, c) {
  return pieces.find((o) => o.userData.r === r && o.userData.c === c);
}

function releasePieceMesh(mesh) {
  scene.remove(mesh);
  // Geometry and side/bottom materials are shared. Only the top material and
  // its procedural texture belong to this piece and must be released on removal.
  mesh.material[1].map.dispose();
  mesh.material[1].dispose();
}

function rebuildPieceMeshes(sourceBoard, animate = false) {
  clearSelection();
  for (const m of [...pieces]) releasePieceMesh(m);
  pieces = [];
  let i = 0;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = sourceBoard[r][c];
      if (!p) continue;
      const m = makePiece(p, r, c);
      pieces.push(m);
      scene.add(m);
      if (animate) {
        m.position.y = 3.4;
        tween(420 + (i % 9) * 26, (k) => { m.position.y = 3.4 + (Y0 - 3.4) * k; }, null, (i >> 3) * 55);
      }
      i++;
    }
}

function buildScene() {
  rebuildPieceMeshes(board, true);
  const invariant = checkBoardMeshInvariant(board);
  if (!invariant.ok) throw new Error(`Normal board/mesh invariant failed: ${invariant.errors.join(' ')}`);
}

function checkBoardMeshInvariant(sourceBoard) {
  if (!sourceBoard) return { ok: false, errors: ['Editor is not active.'] };
  const errors = [];
  const seen = new Set();
  let boardPieceCount = 0;

  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) if (sourceBoard[r][c]) boardPieceCount++;

  for (const mesh of pieces) {
    const { r, c, piece } = mesh.userData;
    const key = `${r},${c}`;
    if (seen.has(key)) errors.push(`Duplicate mesh at ${key}.`);
    seen.add(key);
    if (mesh.parent !== scene || mesh.visible === false) errors.push(`Mesh at ${key} is not visible in the scene.`);
    const expected = to3D(r, c);
    if (Math.abs(mesh.position.x - expected.x) > 0.001 || Math.abs(mesh.position.z - expected.z) > 0.001) {
      errors.push(`Mesh at ${key} is positioned on a different square.`);
    }
    if (![mesh.scale.x, mesh.scale.y, mesh.scale.z].every((value) => Number.isFinite(value) && value > 0)) {
      errors.push(`Mesh at ${key} has no visible scale.`);
    }
    const logical = sourceBoard[r]?.[c];
    if (!logical) errors.push(`Mesh at ${key} has no logical piece.`);
    else if (!piece || logical.side !== piece.side || logical.type !== piece.type) {
      errors.push(`Mesh at ${key} does not match its logical piece.`);
    }
  }

  if (pieces.length !== boardPieceCount) {
    errors.push(`Expected ${boardPieceCount} meshes but found ${pieces.length}.`);
  }
  for (const child of scene.children) {
    if (child.userData?.piece && !pieces.includes(child)) errors.push('Scene contains an unregistered piece mesh.');
  }
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      if (sourceBoard[r][c] && !seen.has(`${r},${c}`)) errors.push(`Logical piece at ${r},${c} has no mesh.`);
    }
  return { ok: errors.length === 0, errors };
}

function syncEditorScene() {
  tweens.length = 0;
  rebuildPieceMeshes(editorState.board, false);
  const invariant = checkBoardMeshInvariant(editorState.board);
  if (!invariant.ok) throw new Error(`Editor board/mesh invariant failed: ${invariant.errors.join(' ')}`);
}

function setEditorMessage(message, kind = '') {
  editorMessage.textContent = message;
  editorMessage.classList.toggle('success', kind === 'success');
  editorMessage.classList.toggle('error', kind === 'error');
}

function setPhotoImportMessage(message, kind = '') {
  photoImportMessage.textContent = message;
  photoImportMessage.classList.toggle('success', kind === 'success');
  photoImportMessage.classList.toggle('error', kind === 'error');
}

function photoErrorMessage(error) {
  if (!(error instanceof PuzzlePhotoError)) return '無法讀取這張照片，請改用 JPEG、PNG 或 WebP。';
  if (error.code === 'UNSUPPORTED_TYPE') return '不支援此檔案格式，請選擇 JPEG、PNG 或 WebP。';
  if (error.code === 'EMPTY_FILE') return '所選檔案是空檔案，請選擇另一張照片。';
  if (error.code === 'FILE_TOO_LARGE') return '照片超過 10 MB 上限，請選擇較小的檔案。';
  return `照片無法載入：${error.message}`;
}

function syncPhotoUI() {
  const visible = !!photoObjectUrl && !!photoReferenceState.photo && authoringActive();
  photoPanel.classList.toggle('hidden', !visible);
  appEl.classList.toggle('photo-active', visible);
  if (!visible) {
    syncCalibrationUI();
    return;
  }
  const { rotation, zoom, photo } = photoReferenceState;
  photoPreviewImage.style.transform = `rotate(${rotation}deg) scale(${zoom})`;
  photoTransformStatus.textContent = `${photo.name}・${Math.round(zoom * 100)}%・${rotation}°`;
  btnPhotoZoomOut.disabled = zoom <= PHOTO_MIN_ZOOM;
  btnPhotoZoomIn.disabled = zoom >= PHOTO_MAX_ZOOM;
  syncCalibrationUI();
}

function releasePhotoReference() {
  photoLoadToken++;
  if (photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);
  if (pendingPhotoObjectUrl) URL.revokeObjectURL(pendingPhotoObjectUrl);
  photoObjectUrl = null;
  pendingPhotoObjectUrl = null;
  photoReferenceState = clearPhotoReference(photoReferenceState);
  invalidateCalibration();
  photoPreviewImage.removeAttribute('src');
  photoPreviewImage.style.transform = '';
  photoFileInput.value = '';
  syncPhotoUI();
}

function openPhotoPicker() {
  if (!authoringActive()) return;
  photoFileInput.value = '';
  photoFileInput.click();
}

function decodePhotoObjectUrl(objectUrl) {
  const probe = new Image();
  probe.decoding = 'async';
  probe.src = objectUrl;
  if (typeof probe.decode === 'function') {
    return probe.decode().then(() => probe);
  }
  return new Promise((resolve, reject) => {
    probe.onload = () => resolve(probe);
    probe.onerror = () => reject(new Error('Image decode failed.'));
  });
}

async function loadSelectedPhoto(file) {
  if (!file) return;
  let metadata;
  try {
    metadata = validatePhotoMetadata({ name: file.name, type: file.type, size: file.size });
  } catch (error) {
    const message = photoErrorMessage(error);
    setPhotoImportMessage(message, 'error');
    toast(message);
    return;
  }

  const token = ++photoLoadToken;
  if (pendingPhotoObjectUrl) URL.revokeObjectURL(pendingPhotoObjectUrl);
  const nextObjectUrl = URL.createObjectURL(file);
  pendingPhotoObjectUrl = nextObjectUrl;
  setPhotoImportMessage('正在載入照片…');
  try {
    const decoded = await decodePhotoObjectUrl(nextObjectUrl);
    if (token !== photoLoadToken) {
      URL.revokeObjectURL(nextObjectUrl);
      return;
    }
    if (!decoded.naturalWidth || !decoded.naturalHeight) throw new Error('Image has no decoded dimensions.');
    const previousObjectUrl = photoObjectUrl;
    invalidateCalibration();
    photoReferenceState = setPhotoReference(photoReferenceState, metadata);
    photoObjectUrl = nextObjectUrl;
    pendingPhotoObjectUrl = null;
    photoPreviewImage.src = nextObjectUrl;
    if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    setPhotoImportMessage(`已載入「${metadata.name}」，可先校正並掃描候選，再由你確認棋子。`, 'success');
    syncPhotoUI();
    toast('照片已載入，可校正後在本機掃描候選。');
  } catch {
    URL.revokeObjectURL(nextObjectUrl);
    if (pendingPhotoObjectUrl === nextObjectUrl) pendingPhotoObjectUrl = null;
    if (token !== photoLoadToken) return;
    const message = '照片解碼失敗，請改用有效的 JPEG、PNG 或 WebP。';
    setPhotoImportMessage(message, 'error');
    toast(message);
  } finally {
    photoFileInput.value = '';
  }
}

function applyPhotoState(action) {
  try {
    const previousRotation = photoReferenceState.rotation;
    const nextState = action(photoReferenceState);
    if (nextState.rotation !== previousRotation) invalidateCalibration();
    photoReferenceState = nextState;
    syncPhotoUI();
  } catch (error) {
    const message = photoErrorMessage(error);
    setPhotoImportMessage(message, 'error');
    toast(message);
  }
}

function calibrationErrorMessage(error) {
  if (!(error instanceof PuzzlePhotoCalibrationError)) return '無法產生棋盤校正，請重新調整四角。';
  const messages = {
    OVERLAPPING_CORNERS: '四個角點不可重疊。',
    DEGENERATE_QUADRILATERAL: '校正範圍過窄或過小，請拉開四個角點。',
    SELF_INTERSECTION: '角點連線不可交叉，請維持左上、右上、右下、左下順序。',
    INVALID_CORNER_ORDER: '角點順序已翻轉，請重新對齊棋盤四角。',
    OUT_OF_BOUNDS: '角點必須保持在照片範圍內。',
    SINGULAR_TRANSFORM: '目前四角無法建立透視校正，請重新調整。',
  };
  return messages[error.code] || `棋盤校正失敗：${error.message}`;
}

function invalidateRecognition() {
  pieceTypeRecognitionVersion++;
  rectifiedPhotoPixels = null;
  recognitionSession = null;
  selectedRecognitionKey = null;
  recognitionUnresolvedOnly = false;
  // Reset backing pixels and context state, preserving dimensions for the next review.
  for (const canvas of [calibrationRectifiedCanvas, recognitionCanvas, recognitionTargetCanvas]) {
    canvas.width = canvas.width;
  }
}

function invalidateRecognitionForCalibrationChange() {
  calibrationRecognitionVersion++;
  invalidateRecognition();
}

function invalidateCalibration() {
  photoRecognitionVersion++;
  calibrationRecognitionVersion++;
  invalidateRecognition();
  calibrationCornerCanvas.width = calibrationCornerCanvas.width;
  calibrationState = null;
  confirmedCalibration = null;
  calibrationMode = 'reference';
  activeCalibrationCorner = 'topLeft';
  calibrationPointerId = null;
}

function syncCalibrationUI() {
  const photoAvailable = !!photoObjectUrl && !!photoReferenceState.photo && authoringActive();
  const adjusting = photoAvailable && calibrationMode === 'adjust';
  const previewing = photoAvailable && calibrationMode === 'preview';
  const recognizing = photoAvailable && calibrationMode === 'recognition';
  photoReferenceView.classList.toggle('hidden', !photoAvailable || adjusting || previewing || recognizing);
  calibrationAdjustView.classList.toggle('hidden', !adjusting);
  calibrationPreviewView.classList.toggle('hidden', !previewing);
  recognitionReviewView.classList.toggle('hidden', !recognizing);
  photoPanel.classList.toggle('calibration-active', adjusting || previewing);
  photoPanel.classList.toggle('recognition-active', recognizing);
  if (!photoAvailable) return;

  calibrationSummary.textContent = confirmedCalibration
    ? `棋盤校正已確認：${confirmedCalibration.gridIntersections.length} 個交叉點，${orientationLabel(confirmedCalibration.orientation)}。`
    : (calibrationState ? '四角調整尚未確認，可隨時繼續校正。' : '尚未校正棋盤幾何。');
  calibrationSummary.classList.toggle('confirmed', !!confirmedCalibration);
  btnCalibrationStart.textContent = confirmedCalibration
    ? '重新校正棋盤'
    : (calibrationState ? '繼續校正棋盤' : '校正棋盤');
  btnRecognitionScan.classList.toggle('hidden', !confirmedCalibration);

  if (calibrationState) {
    calibrationCornerButtons.forEach((button) => {
      const active = button.dataset.calibrationCorner === activeCalibrationCorner;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    calibrationOrientationInputs.forEach((input) => {
      input.checked = input.value === calibrationState.orientation;
    });
  }
  if (adjusting) requestAnimationFrame(renderCalibrationAdjustment);
  if (previewing) requestAnimationFrame(renderRectifiedPreview);
  if (recognizing) requestAnimationFrame(syncRecognitionUI);
}

function orientationLabel(orientation) {
  return orientation === CALIBRATION_ORIENTATION_RED_BOTTOM ? '紅方在下' : '紅方在上';
}

function beginCalibration() {
  if (!photoObjectUrl || !photoReferenceState.photo || !authoringActive()) return;
  if (!calibrationState) {
    calibrationState = createCalibrationState({
      orientation: CALIBRATION_ORIENTATION_RED_BOTTOM,
      sideToMove: editorState?.sideToMove ?? null,
    });
  }
  calibrationMode = 'adjust';
  syncPhotoUI();
}

function createOrientedPhotoCanvas(maxDimension = 900) {
  if (!photoPreviewImage.complete || !photoPreviewImage.naturalWidth || !photoPreviewImage.naturalHeight) {
    throw new PuzzlePhotoCalibrationError('PHOTO_NOT_READY', 'The photo is not ready for calibration.');
  }
  const rotation = photoReferenceState.rotation;
  const quarterTurn = rotation === 90 || rotation === 270;
  const orientedWidth = quarterTurn ? photoPreviewImage.naturalHeight : photoPreviewImage.naturalWidth;
  const orientedHeight = quarterTurn ? photoPreviewImage.naturalWidth : photoPreviewImage.naturalHeight;
  const scale = Math.min(1, maxDimension / Math.max(orientedWidth, orientedHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(orientedWidth * scale));
  canvas.height = Math.max(1, Math.round(orientedHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.save();
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(
    photoPreviewImage,
    -photoPreviewImage.naturalWidth * scale / 2,
    -photoPreviewImage.naturalHeight * scale / 2,
    photoPreviewImage.naturalWidth * scale,
    photoPreviewImage.naturalHeight * scale,
  );
  context.restore();
  return canvas;
}

function setCalibrationMessage(message, kind = '') {
  calibrationMessage.textContent = message;
  calibrationMessage.classList.toggle('success', kind === 'success');
  calibrationMessage.classList.toggle('error', kind === 'error');
}

function calibrationValidation() {
  try {
    return { ok: true, result: validateQuadrilateral(calibrationState) };
  } catch (error) {
    if (!(error instanceof PuzzlePhotoCalibrationError)) throw error;
    return { ok: false, error };
  }
}

function renderCalibrationAdjustment() {
  if (calibrationMode !== 'adjust' || !calibrationState) return;
  try {
    const sourceCanvas = createOrientedPhotoCanvas();
    calibrationCornerCanvas.width = sourceCanvas.width;
    calibrationCornerCanvas.height = sourceCanvas.height;
    const context = calibrationCornerCanvas.getContext('2d');
    context.drawImage(sourceCanvas, 0, 0);
    const points = CALIBRATION_CORNER_NAMES.map((name) => ({
      name,
      x: calibrationState.corners[name].x * calibrationCornerCanvas.width,
      y: calibrationState.corners[name].y * calibrationCornerCanvas.height,
    }));

    context.save();
    context.lineJoin = 'round';
    context.lineWidth = Math.max(3, calibrationCornerCanvas.width / 180);
    context.strokeStyle = 'rgba(14, 10, 7, 0.9)';
    context.beginPath();
    points.forEach((point, index) => (index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)));
    context.closePath();
    context.stroke();
    context.lineWidth = Math.max(1.5, calibrationCornerCanvas.width / 360);
    context.strokeStyle = '#f0c463';
    context.stroke();

    const labels = { topLeft: '左上', topRight: '右上', bottomRight: '右下', bottomLeft: '左下' };
    const radius = Math.max(13, calibrationCornerCanvas.width / 38);
    context.font = `700 ${Math.max(12, calibrationCornerCanvas.width / 55)}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const point of points) {
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = point.name === activeCalibrationCorner ? '#f0c463' : '#2a2117';
      context.fill();
      context.lineWidth = Math.max(2, calibrationCornerCanvas.width / 300);
      context.strokeStyle = point.name === activeCalibrationCorner ? '#fff0c7' : '#f0c463';
      context.stroke();
      context.fillStyle = point.name === activeCalibrationCorner ? '#241a0c' : '#f4ead6';
      context.fillText(labels[point.name], point.x, point.y);
    }
    context.restore();

    const validation = calibrationValidation();
    btnCalibrationPreview.disabled = !validation.ok;
    if (validation.ok) setCalibrationMessage('四角目前有效，可產生校正預覽。', 'success');
    else setCalibrationMessage(calibrationErrorMessage(validation.error), 'error');
  } catch (error) {
    btnCalibrationPreview.disabled = true;
    setCalibrationMessage(calibrationErrorMessage(error), 'error');
  }
}

function canvasNormalizedPointer(event) {
  const rect = calibrationCornerCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function nearestCalibrationCorner(point) {
  let nearest = null;
  let nearestDistance = Infinity;
  for (const name of CALIBRATION_CORNER_NAMES) {
    const corner = calibrationState.corners[name];
    const distance = Math.hypot(point.x - corner.x, point.y - corner.y);
    if (distance < nearestDistance) {
      nearest = name;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= 0.11 ? nearest : null;
}

function selectCalibrationCorner(name) {
  if (!CALIBRATION_CORNER_NAMES.includes(name)) return;
  activeCalibrationCorner = name;
  syncCalibrationUI();
}

function moveCalibrationCorner(name, point) {
  try {
    calibrationState = setCorner(calibrationState, name, point);
    confirmedCalibration = null;
    invalidateRecognitionForCalibrationChange();
    renderCalibrationAdjustment();
  } catch (error) {
    setCalibrationMessage(calibrationErrorMessage(error), 'error');
  }
}

function nudgeCalibrationCorner(direction) {
  if (!calibrationState) return;
  const deltas = {
    up: { x: 0, y: -0.005 },
    down: { x: 0, y: 0.005 },
    left: { x: -0.005, y: 0 },
    right: { x: 0.005, y: 0 },
  };
  const delta = deltas[direction];
  if (!delta) return;
  const source = calibrationState.corners[activeCalibrationCorner];
  moveCalibrationCorner(activeCalibrationCorner, {
    x: source.x + delta.x,
    y: source.y + delta.y,
  });
}

function showCalibrationPreview() {
  if (!calibrationState) return;
  const validation = calibrationValidation();
  if (!validation.ok) {
    const message = calibrationErrorMessage(validation.error);
    setCalibrationMessage(message, 'error');
    toast(message);
    return;
  }
  calibrationMode = 'preview';
  syncPhotoUI();
}

function createRectifiedPhotoPixels() {
  if (!calibrationState) {
    throw new PuzzlePhotoCalibrationError('INVALID_STATE', 'Calibration is not available.');
  }
  validateQuadrilateral(calibrationState);
  const sourceCanvas = createOrientedPhotoCanvas();
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const sourcePixels = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  const width = CALIBRATION_CANONICAL_WIDTH;
  const height = CALIBRATION_CANONICAL_HEIGHT;
  const output = new ImageData(width, height);
  const destinationCorners = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const sourceCorners = CALIBRATION_CORNER_NAMES.map((name) => calibrationState.corners[name]);
  const inverse = computeHomography(destinationCorners, sourceCorners);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const normalized = transformPoint(inverse, { x, y });
      const sx = Math.round(normalized.x * (sourceCanvas.width - 1));
      const sy = Math.round(normalized.y * (sourceCanvas.height - 1));
      const targetIndex = (y * width + x) * 4;
      if (sx < 0 || sx >= sourceCanvas.width || sy < 0 || sy >= sourceCanvas.height) {
        output.data[targetIndex + 3] = 255;
        continue;
      }
      const sourceIndex = (sy * sourceCanvas.width + sx) * 4;
      output.data[targetIndex] = sourcePixels.data[sourceIndex];
      output.data[targetIndex + 1] = sourcePixels.data[sourceIndex + 1];
      output.data[targetIndex + 2] = sourcePixels.data[sourceIndex + 2];
      output.data[targetIndex + 3] = 255;
    }
  }
  return output;
}

function renderRectifiedPreview() {
  if (calibrationMode !== 'preview' || !calibrationState) return;
  try {
    rectifiedPhotoPixels = createRectifiedPhotoPixels();
    const width = rectifiedPhotoPixels.width;
    const height = rectifiedPhotoPixels.height;
    calibrationRectifiedCanvas.width = width;
    calibrationRectifiedCanvas.height = height;
    const context = calibrationRectifiedCanvas.getContext('2d');
    context.putImageData(rectifiedPhotoPixels, 0, 0);
    drawCalibrationGrid(context, width, height, calibrationState.orientation);

    const grid = createGridIntersections(calibrationState.orientation, width, height);
    const first = grid[0];
    const last = grid.at(-1);
    calibrationOrientationBadge.textContent = orientationLabel(calibrationState.orientation);
    calibrationPreviewStatus.textContent = `10 橫線 × 9 直線，共 ${grid.length} 個交叉點；左上對應 (${first.r},${first.c})，右下對應 (${last.r},${last.c})。`;
  } catch (error) {
    const message = calibrationErrorMessage(error);
    calibrationPreviewStatus.textContent = message;
    toast(message);
  }
}

function drawCalibrationGrid(context, width, height, orientation) {
  const xAt = (column) => (column / 8) * (width - 1);
  const yAt = (row) => (row / 9) * (height - 1);
  context.save();
  context.lineCap = 'round';
  for (const [strokeStyle, lineWidth] of [['rgba(18, 10, 5, 0.82)', 4], ['rgba(240, 196, 99, 0.92)', 1.35]]) {
    context.strokeStyle = strokeStyle;
    context.lineWidth = lineWidth;
    context.beginPath();
    for (let column = 0; column < 9; column++) {
      context.moveTo(xAt(column), 0);
      context.lineTo(xAt(column), height - 1);
    }
    for (let row = 0; row < 10; row++) {
      context.moveTo(0, yAt(row));
      context.lineTo(width - 1, yAt(row));
    }
    context.stroke();
  }
  context.fillStyle = '#fff0c7';
  context.strokeStyle = 'rgba(20, 12, 6, 0.9)';
  context.lineWidth = 2;
  for (let row = 0; row < 10; row++) {
    for (let column = 0; column < 9; column++) {
      context.beginPath();
      context.arc(xAt(column), yAt(row), 3.1, 0, Math.PI * 2);
      context.stroke();
      context.fill();
    }
  }
  const railY = orientation === CALIBRATION_ORIENTATION_RED_BOTTOM ? height - 5 : 5;
  context.strokeStyle = '#c05345';
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(5, railY);
  context.lineTo(width - 5, railY);
  context.stroke();
  context.restore();
}

function resetCalibrationCorners() {
  if (!calibrationState) return;
  calibrationState = resetCalibration(calibrationState);
  confirmedCalibration = null;
  invalidateRecognitionForCalibrationChange();
  calibrationMode = 'adjust';
  syncPhotoUI();
}

function confirmCalibrationResult() {
  if (!calibrationState) return;
  try {
    confirmedCalibration = exportCalibration(
      calibrationState,
      CALIBRATION_CANONICAL_WIDTH,
      CALIBRATION_CANONICAL_HEIGHT,
    );
    calibrationMode = 'reference';
    syncPhotoUI();
    setPhotoImportMessage(`棋盤校正已確認：${confirmedCalibration.gridIntersections.length} 個交叉點，未修改局面。`, 'success');
    toast('棋盤校正已確認，可掃描棋子候選。');
  } catch (error) {
    const message = calibrationErrorMessage(error);
    calibrationPreviewStatus.textContent = message;
    toast(message);
  }
}

function recognitionErrorMessage(error) {
  if (error instanceof PuzzlePhotoReviewError) return error.message;
  if (!(error instanceof PuzzlePhotoRecognitionError)) return '無法掃描棋子候選，請重新校正後再試。';
  if (error.code === 'UNREVIEWED_INTERSECTION') return `尚有交叉點未確認：(${error.r},${error.c})。`;
  return `棋子候選掃描失敗：${error.message}`;
}

function setRecognitionMessage(message, kind = '') {
  recognitionMessage.textContent = message;
  recognitionMessage.classList.toggle('success', kind === 'success');
  recognitionMessage.classList.toggle('error', kind === 'error');
}

function recognitionVersions() {
  return {
    photoVersion: photoRecognitionVersion,
    calibrationVersion: calibrationRecognitionVersion,
  };
}

function pieceTypeVersions() {
  return {
    ...recognitionVersions(),
    recognitionVersion: pieceTypeRecognitionVersion,
  };
}

function recognitionCandidateLabel(candidate) {
  const occupancy = {
    [RECOGNITION_OCCUPANCY_EMPTY]: '空',
    [RECOGNITION_OCCUPANCY_OCCUPIED]: '有子',
    [RECOGNITION_OCCUPANCY_UNCERTAIN]: '不確定',
  }[candidate.occupancy];
  const side = candidate.suggestedSide === RED
    ? `，偏紅方 ${Math.round(candidate.sideConfidence * 100)}%`
    : (candidate.suggestedSide === BLACK
      ? `，偏黑方 ${Math.round(candidate.sideConfidence * 100)}%`
      : '，紅黑不明');
  return `候選：${occupancy} ${Math.round(candidate.occupancyConfidence * 100)}%${candidate.occupancy === RECOGNITION_OCCUPANCY_EMPTY ? '' : side}`;
}

function recognitionMarkerText(candidate, reviewed, selection) {
  if (reviewed) return selection === null ? '空' : name(selection.side, selection.type);
  if (candidate.occupancy === RECOGNITION_OCCUPANCY_UNCERTAIN) return '?';
  if (candidate.occupancy === RECOGNITION_OCCUPANCY_EMPTY) return '○';
  return '●';
}

function syncRecognitionUI() {
  if (!recognitionSession || calibrationMode !== 'recognition') return;
  const { candidates, selections, review } = recognitionSession;
  selectedRecognitionKey = review.currentKey;
  const progress = reviewProgress(review);
  recognitionOccupiedCount.textContent = `偵測有子 ${progress.occupied}`;
  recognitionUncertainCount.textContent = `不確定 ${progress.uncertain}`;
  recognitionBulkCount.textContent = `批次空位 ${progress.bulkEmpty}`;
  recognitionManualCount.textContent = `人工棋子 ${progress.manualPieces}`;
  recognitionReviewedCount.textContent = `已確認 ${progress.confirmed} / ${progress.queueSize}`;
  recognitionRemainingCount.textContent = `剩餘 ${progress.remaining}`;
  recognitionUnresolvedOnlyInput.checked = recognitionUnresolvedOnly;
  btnRecognitionApply.disabled = !progress.canApply;
  btnRecognitionAcceptEmpty.textContent = `接受 ${progress.eligibleEmpty} 個明顯空位`;
  btnRecognitionAcceptEmpty.disabled = progress.eligibleEmpty === 0;
  btnRecognitionUndoEmpty.disabled = progress.bulkEmpty === 0;
  const queue = buildReviewQueue(review);
  document.getElementById('recognitionCountBadge').textContent = `待看 ${queue.length} / 90 點`;
  document.getElementById('btnReviewPrevious').disabled = queue.length === 0;
  document.getElementById('btnReviewNext').disabled = queue.length === 0;
  document.getElementById('btnReviewUnresolved').disabled = progress.remaining === 0;
  const kingsValid = progress.redKings === 1 && progress.blackKings === 1;
  recognitionKingSummary.textContent = `紅帥：${progress.redKings}　黑將：${progress.blackKings}${kingsValid ? '' : '　⚠ 雙方應各有一將／帥，請檢查或於編輯器修正。'}`;
  recognitionKingSummary.classList.toggle('warning', !kingsValid);

  recognitionMarkers.replaceChildren();
  for (const candidate of candidates) {
    const key = selectionKey(candidate.r, candidate.c);
    const reviewed = review.entries[key].status !== UNREVIEWED;
    const selection = selections[key];
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = `recognition-marker candidate-${candidate.occupancy}`;
    if (candidate.suggestedSide !== RECOGNITION_SIDE_UNKNOWN) marker.classList.add(`suggested-${candidate.suggestedSide}`);
    if (reviewed) marker.classList.add('reviewed', selection === null ? 'reviewed-empty' : `reviewed-${selection.side}`);
    if (key === selectedRecognitionKey) marker.classList.add('selected');
    if (recognitionUnresolvedOnly && reviewed) marker.classList.add('filtered');
    marker.dataset.reviewState = review.entries[key].status;
    marker.setAttribute('aria-pressed', String(key === selectedRecognitionKey));
    marker.style.left = `${(candidate.displayCol / 8) * 100}%`;
    marker.style.top = `${(candidate.displayRow / 9) * 100}%`;
    marker.textContent = recognitionMarkerText(candidate, reviewed, selection);
    marker.setAttribute('aria-label', `交叉點 (${candidate.r},${candidate.c})，${recognitionCandidateLabel(candidate)}${reviewed ? `，已指定${selection === null ? '空' : name(selection.side, selection.type)}` : '，尚未確認'}`);
    marker.title = marker.getAttribute('aria-label');
    marker.addEventListener('click', () => {
      recognitionSession.review = selectReviewCandidate(recognitionSession.review, key);
      syncRecognitionUI();
      recognitionPicker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    recognitionMarkers.append(marker);
  }

  const selectedCandidate = candidates.find((candidate) => selectionKey(candidate.r, candidate.c) === selectedRecognitionKey);
  const hasSelected = !!selectedCandidate;
  recognitionSelectedCoordinate.textContent = hasSelected
    ? `目前：(${selectedCandidate.r},${selectedCandidate.c})${review.entries[selectedRecognitionKey].status !== UNREVIEWED ? ' · 已確認' : ''}`
    : '沒有需逐點確認的位置';
  recognitionSuggestion.textContent = hasSelected ? recognitionCandidateLabel(selectedCandidate) : '請在棋盤上選一點';
  drawRecognitionTarget(selectedCandidate);
  const selectedReviewed = hasSelected && Object.prototype.hasOwnProperty.call(selections, selectedRecognitionKey);
  const typeSuggestion = hasSelected ? recognitionSession.typeSuggestions[selectedRecognitionKey] : null;
  const usableSuggestion = !selectedReviewed && typeSuggestion?.status === 'suggested'
    && typeSuggestion.type && typeSuggestion.side;
  const suggestionPiece = usableSuggestion
    ? name(typeSuggestion.side, typeSuggestion.type)
    : null;
  recognitionTypeCard.classList.toggle('hidden', !usableSuggestion);
  recognitionTypeSuggestion.textContent = usableSuggestion ? `建議：${typeSuggestion.side === RED ? '紅' : '黑'}${suggestionPiece}` : '';
  recognitionTypeConfidence.textContent = usableSuggestion ? `信心：${typeSuggestion.confidence >= 0.82 ? '高' : '中'}` : '';
  recognitionTemplateCount.textContent = `本次參考 ${listTemplates(recognitionSession.typeLibrary).length}`;
  btnRecognitionAdopt.disabled = selectedReviewed || typeSuggestion?.status !== 'suggested' || !suggestionPiece;
  btnRecognitionEmpty.disabled = !hasSelected;
  recognitionPieceButtons.forEach((button) => { button.disabled = !hasSelected; });
  recognitionPalettes.forEach((palette) => {
    const prioritized = hasSelected && selectedCandidate.sideConfidence >= 0.70
      && palette.classList.contains(selectedCandidate.suggestedSide);
    palette.classList.toggle('suggested', prioritized);
    palette.querySelector('span').textContent = `${palette.classList.contains('red') ? '紅方' : '黑方'}${prioritized ? ' ◀' : ''}`;
  });

  const selectedValue = selectedReviewed ? selections[selectedRecognitionKey] : undefined;
  btnRecognitionEmpty.classList.toggle('active', selectedValue === null);
  btnRecognitionEmpty.setAttribute('aria-pressed', String(selectedValue === null));
  recognitionPieceButtons.forEach((button) => {
    const active = selectedValue
      && selectedValue.side === button.dataset.recognitionSide
      && selectedValue.type === button.dataset.recognitionType;
    button.classList.toggle('active', !!active);
    button.setAttribute('aria-pressed', String(!!active));
  });

  if (progress.canApply) {
    setRecognitionMessage('確認完成：90 個位置都有明確決定，可以套用到編輯棋盤。', 'success');
  } else {
    setRecognitionMessage(`尚有 ${progress.unresolved} 個位置未確認。${progress.eligibleEmpty ? `其中 ${progress.eligibleEmpty} 個明顯空位可由你一鍵接受。` : ''}`);
  }
}

function drawRecognitionTarget(candidate) {
  const context = recognitionTargetCanvas.getContext('2d');
  context.clearRect(0, 0, 112, 112);
  if (!candidate || !rectifiedPhotoPixels) return;
  const x = (candidate.displayCol / 8) * (recognitionCanvas.width - 1);
  const y = (candidate.displayRow / 9) * (recognitionCanvas.height - 1);
  const radius = Math.min(recognitionCanvas.width / 8, recognitionCanvas.height / 9) * 0.65;
  const left = Math.max(0, x - radius);
  const top = Math.max(0, y - radius);
  const width = Math.min(recognitionCanvas.width, x + radius) - left;
  const height = Math.min(recognitionCanvas.height, y + radius) - top;
  context.drawImage(recognitionCanvas, left, top, width, height,
    ((left - x + radius) / (radius * 2)) * 112, ((top - y + radius) / (radius * 2)) * 112,
    (width / (radius * 2)) * 112, (height / (radius * 2)) * 112);
  context.strokeStyle = '#f0c463';
  context.lineWidth = 2;
  context.strokeRect(48, 48, 16, 16);
}

function scanRecognitionCandidates() {
  if (!confirmedCalibration || !calibrationState) {
    const message = '請先完成並確認棋盤校正。';
    setPhotoImportMessage(message, 'error');
    toast(message);
    return;
  }
  try {
    pieceTypeRecognitionVersion++;
    rectifiedPhotoPixels = createRectifiedPhotoPixels();
    recognitionCanvas.width = rectifiedPhotoPixels.width;
    recognitionCanvas.height = rectifiedPhotoPixels.height;
    recognitionCanvas.getContext('2d').putImageData(rectifiedPhotoPixels, 0, 0);
    const candidates = recognizeIntersections(
      { data: rectifiedPhotoPixels.data, width: rectifiedPhotoPixels.width, height: rectifiedPhotoPixels.height },
      confirmedCalibration.gridIntersections,
    );
    const previousReview = recognitionSession && isRecognitionTokenCurrent(recognitionSession.token, recognitionVersions())
      ? recognitionSession.review : null;
    const review = previousReview ? rescanReview(previousReview, candidates) : createReviewState(candidates);
    recognitionSession = {
      candidates: review.candidates,
      review,
      get selections() { return confirmedSelections(this.review); },
      token: createRecognitionToken(recognitionVersions()),
      typeLibrary: createTemplateLibrary(),
      typeSuggestions: {},
      typePatches: {},
      typeToken: createPieceTypeSessionToken(pieceTypeVersions()),
    };
    selectedRecognitionKey = review.currentKey;
    recognitionUnresolvedOnly = false;
    calibrationMode = 'recognition';
    syncPhotoUI();
    toast(previousReview ? '已重新掃描；所有人工確認與批次空位均已保留。' : `已掃描 90 個交叉點，${buildReviewQueue(review).length} 個位置需逐點確認。`);
  } catch (error) {
    const message = recognitionErrorMessage(error);
    setPhotoImportMessage(message, 'error');
    toast(message);
  }
}

function pieceTypePatchForCandidate(candidate) {
  if (!recognitionSession || !rectifiedPhotoPixels || !confirmedCalibration) return null;
  const key = selectionKey(candidate.r, candidate.c);
  if (recognitionSession.typePatches[key]) return recognitionSession.typePatches[key];
  const point = confirmedCalibration.gridIntersections.find((entry) => entry.r === candidate.r && entry.c === candidate.c);
  if (!point) return null;
  const patch = normalizePiecePatch(
    { data: rectifiedPhotoPixels.data, width: rectifiedPhotoPixels.width, height: rectifiedPhotoPixels.height },
    point,
    { radius: derivePatchRadius(rectifiedPhotoPixels.width, rectifiedPhotoPixels.height) },
  );
  recognitionSession.typePatches[key] = patch;
  return patch;
}

function setRecognitionSelection(selection) {
  if (!recognitionSession || !selectedRecognitionKey) return;
  const candidate = recognitionSession.candidates.find((entry) => selectionKey(entry.r, entry.c) === selectedRecognitionKey);
  recognitionSession.review = selection === null
    ? confirmEmpty(recognitionSession.review, selectedRecognitionKey)
    : confirmPiece(recognitionSession.review, selectedRecognitionKey, selection);
  recognitionSession.typeLibrary = removeTemplatesForSource(recognitionSession.typeLibrary, selectedRecognitionKey);
  if (selection && candidate) {
    const patch = pieceTypePatchForCandidate(candidate);
    if (patch) {
      recognitionSession.typeLibrary = addTemplate(recognitionSession.typeLibrary, {
        side: selection.side,
        type: selection.type,
        patch,
        sourceKey: selectedRecognitionKey,
        confirmedByHuman: true,
      });
    }
  }
  syncRecognitionUI();
}

function rematchUnresolvedPieceTypes() {
  if (!recognitionSession) return;
  if (!isPieceTypeSessionCurrent(recognitionSession.typeToken, pieceTypeVersions())) {
    invalidateRecognition();
    calibrationMode = 'reference';
    syncPhotoUI();
    toast('照片、校正或掃描已變更，舊辨識參考已清除。');
    return;
  }
  const patches = {};
  for (const candidate of recognitionSession.candidates) {
    const key = selectionKey(candidate.r, candidate.c);
    if (candidate.occupancy !== RECOGNITION_OCCUPANCY_OCCUPIED
      || Object.prototype.hasOwnProperty.call(recognitionSession.selections, key)) continue;
    const patch = pieceTypePatchForCandidate(candidate);
    if (patch) patches[key] = patch;
  }
  recognitionSession.typeSuggestions = suggestUnresolvedPieceTypes({
    candidates: recognitionSession.candidates,
    selections: recognitionSession.selections,
    patches,
    library: recognitionSession.typeLibrary,
  });
  const suggestions = Object.values(recognitionSession.typeSuggestions);
  const reliable = suggestions.filter((suggestion) => suggestion.status === 'suggested').length;
  const uncertain = suggestions.filter((suggestion) => suggestion.status !== 'suggested').length;
  syncRecognitionUI();
  toast(`已重新比對未確認棋子：可靠 ${reliable}，不確定 ${uncertain}。`);
}

function acceptRecognitionEmpty() {
  if (!recognitionSession) return;
  const count = reviewProgress(recognitionSession.review).eligibleEmpty;
  recognitionSession.review = acceptHighConfidenceEmpty(recognitionSession.review);
  syncRecognitionUI();
  toast(`已明確接受 ${count} 個明顯空位；可在套用前撤回。`);
}

function resetRecognitionReview() {
  if (!recognitionSession || !window.confirm('重設所有人工確認與批次空位？掃描候選會保留。')) return;
  recognitionSession.review = resetReview(recognitionSession.review);
  recognitionSession.typeLibrary = createTemplateLibrary();
  recognitionSession.typeSuggestions = {};
  syncRecognitionUI();
  toast('人工確認已重設，候選尚未套用到棋盤。');
}

function navigateRecognition(findKey) {
  if (!recognitionSession) return;
  const key = findKey(recognitionSession.review);
  if (!key) return;
  recognitionSession.review = selectReviewCandidate(recognitionSession.review, key);
  syncRecognitionUI();
}

function applyRecognitionToEditor() {
  if (!recognitionSession) return;
  if (!isRecognitionTokenCurrent(recognitionSession.token, recognitionVersions())) {
    invalidateRecognition();
    calibrationMode = 'reference';
    syncPhotoUI();
    const message = '照片或校正已變更，舊候選已作廢，請重新掃描。';
    setPhotoImportMessage(message, 'error');
    toast(message);
    return;
  }
  try {
    const nextBoard = buildReviewedBoard(recognitionSession.review);
    const { redKings, blackKings } = reviewProgress(recognitionSession.review);
    if ((redKings !== 1 || blackKings !== 1)
      && !window.confirm(`紅帥：${redKings}　黑將：${blackKings}。雙方應各有一將／帥。仍要套用並在編輯器修正嗎？`)) return;
    const nextSide = editorState?.sideToMove ?? RED;
    editorState = createEditorState({ board: nextBoard, sideToMove: nextSide });
    appState = APP_STATE.PUZZLE_EDITOR;
    confirmedPosition = null;
    recorderState = null;
    recordedPuzzleResult = null;
    editorPanel.classList.remove('recorder-active');
    recorderPanel.classList.add('hidden');
    document.querySelector(`input[name="editorSide"][value="${nextSide}"]`).checked = true;
    setEditorTool({ kind: 'move' });
    syncEditorScene();
    syncRecorderUI();
    calibrationMode = 'reference';
    syncPhotoUI();
    setEditorMessage('已套用完整確認結果（含明確接受的空位）；請在編輯棋盤繼續修正並確認局面。', 'success');
    toast('人工確認結果已套用到既有編輯棋盤。');
  } catch (error) {
    const message = recognitionErrorMessage(error);
    setRecognitionMessage(message, 'error');
    toast(message);
  }
}

function setEditorTool(tool) {
  editorTool = tool;
  clearSelection();
  editorPieceButtons.forEach((button) => {
    const active = tool.kind === 'piece'
      && button.dataset.editorSide === tool.piece.side
      && button.dataset.editorType === tool.piece.type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  btnEditorMove.classList.toggle('active', tool.kind === 'move');
  btnEditorMove.setAttribute('aria-pressed', String(tool.kind === 'move'));
  btnEditorErase.classList.toggle('active', tool.kind === 'erase');
  btnEditorErase.setAttribute('aria-pressed', String(tool.kind === 'erase'));
  if (tool.kind === 'piece') {
    const sideLabel = tool.piece.side === RED ? '紅方' : '黑方';
    editorToolText.textContent = `目前工具：放置${sideLabel}${name(tool.piece.side, tool.piece.type)}`;
  } else {
    editorToolText.textContent = `目前工具：${tool.kind === 'move' ? '移動棋子' : '刪除棋子'}`;
  }
}

function selectEditorPiece(r, c) {
  clearSelection();
  selected = { r, c };
  showSelectRingAt(selected);
  sfx.select();
}

function applyEditorAction(action, successMessage) {
  try {
    editorState = action();
    markEditorDirty();
    syncEditorScene();
    setEditorMessage(successMessage);
    refreshHUD();
    return true;
  } catch (error) {
    if (!(error instanceof PuzzleEditorError)) throw error;
    const messages = {
      OCCUPIED_SQUARE: '此處已有棋子，請先移動或刪除原棋子。',
      OCCUPIED_DESTINATION: '目的位置已有棋子，編輯模式不會自動覆蓋。',
      EMPTY_SOURCE: '來源位置沒有棋子。',
      EMPTY_SQUARE: '此處沒有可刪除的棋子。',
    };
    const message = messages[error.code] || error.message;
    setEditorMessage(message, 'error');
    toast(message);
    return false;
  }
}

function markEditorDirty() {
  if (appState !== APP_STATE.PUZZLE_CONFIRMED) return;
  appState = APP_STATE.PUZZLE_EDITOR;
  recorderState = null;
  syncRecorderUI();
}

function handleEditorBoardClick(hit) {
  if (!hit) {
    clearSelection();
    refreshHUD();
    return;
  }
  const coordinate = hit.userData?.piece
    ? { r: hit.userData.r, c: hit.userData.c }
    : { r: hit.r, c: hit.c };
  const occupied = editorState.board[coordinate.r][coordinate.c] !== null;

  if (editorTool.kind === 'piece') {
    if (occupied) {
      const message = '此處已有棋子，請先移動或刪除原棋子。';
      setEditorMessage(message, 'error');
      toast(message);
      return;
    }
    applyEditorAction(
      () => placeEditorPiece(editorState, editorTool.piece, coordinate),
      `已放置${name(editorTool.piece.side, editorTool.piece.type)}。`,
    );
    return;
  }

  if (editorTool.kind === 'erase') {
    applyEditorAction(
      () => removeEditorPiece(editorState, coordinate),
      '已刪除棋子。',
    );
    return;
  }

  if (!selected) {
    if (!occupied) {
      setEditorMessage('請先選擇要移動的棋子。', 'error');
      return;
    }
    selectEditorPiece(coordinate.r, coordinate.c);
    setEditorMessage('已選取棋子，請點擊空交叉點完成移動。');
    return;
  }

  if (selected.r === coordinate.r && selected.c === coordinate.c) {
    clearSelection();
    setEditorMessage('已取消選取。');
    refreshHUD();
    return;
  }
  if (occupied) {
    const message = '目的位置已有棋子，請選擇空交叉點。';
    setEditorMessage(message, 'error');
    toast(message);
    return;
  }
  const from = { ...selected };
  clearSelection();
  applyEditorAction(
    () => moveEditorPiece(editorState, from, coordinate),
    '已移動棋子。',
  );
}

const GAME_RECORD_MODE_LABELS = Object.freeze({
  pvp: '雙人對弈',
  easy: '人機・簡單',
  medium: '人機・中等',
  hard: '人機・困難',
});
const GAME_RECORD_REASON_LABELS = Object.freeze({
  checkmate: '將死',
  stalemate: '困斃',
  'perpetual-check': '長將判負',
  'threefold-repetition': '三次重複局面',
  'mutual-perpetual-check': '雙方長將',
});

function gameRecordModeLabel(modeValue) {
  return GAME_RECORD_MODE_LABELS[modeValue] || modeValue;
}

function gameRecordResultLabel(record) {
  const reason = GAME_RECORD_REASON_LABELS[record.result.terminationReason]
    || record.result.terminationReason;
  if (record.result.winner === null) return `和局・${reason}`;
  return `${record.result.winner === RED ? '紅方' : '黑方'}勝・${reason}`;
}

function formatGameRecordCompletedAt(timestamp) {
  try {
    const value = new Date(timestamp);
    if (!Number.isFinite(value.getTime())) return timestamp;
    return new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(value);
  } catch {
    return timestamp;
  }
}

function appendGameReviewMeta(label, value, target = gameReviewMeta) {
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value;
  target.append(term, description);
}

function createGameRecordCard(record) {
  const card = document.createElement('article');
  card.className = 'game-record-card';
  card.dataset.gameRecordId = record.id;

  const heading = document.createElement('div');
  heading.className = 'game-record-card-heading';
  const result = document.createElement('strong');
  result.textContent = gameRecordResultLabel(record);
  const completed = document.createElement('time');
  completed.dateTime = record.completedAt;
  completed.textContent = formatGameRecordCompletedAt(record.completedAt);
  heading.append(result, completed);

  const meta = document.createElement('p');
  meta.className = 'game-record-card-meta';
  meta.textContent = `${gameRecordModeLabel(record.mode)}・${record.moves.length} 著`;

  const actions = document.createElement('div');
  actions.className = 'game-record-card-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.dataset.gameRecordAction = 'open';
  open.textContent = '開啟複盤';
  open.setAttribute('aria-label', `開啟 ${completed.textContent} 的對局複盤`);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.dataset.gameRecordAction = 'delete';
  remove.textContent = '刪除';
  remove.setAttribute('aria-label', `刪除 ${completed.textContent} 的對局紀錄`);
  actions.append(open, remove);
  card.append(heading, meta, actions);
  return card;
}

function renderGameRecordLibrary() {
  const loaded = createGameRecordLibraryView(gameRecordStore.loadAll());
  const readFailed = loaded.status === 'unavailable';
  gameRecordLibraryCount.textContent = `${loaded.records.length} 局`;
  gameRecordLibraryIssues.classList.toggle('hidden', loaded.issues.length === 0);
  gameRecordLibraryIssues.textContent = loaded.issues.length === 0
    ? ''
    : readFailed
      ? '無法讀取對局紀錄；正常對弈與本局的記憶體複盤仍可使用，儲存內容未被改寫。'
      : `有 ${loaded.issues.length} 筆資料無法讀取；有效對局仍可複盤，儲存內容不會被自動修復。`;
  gameRecordLibraryList.replaceChildren(...loaded.records.map(createGameRecordCard));
  gameRecordLibraryEmpty.classList.toggle('hidden', loaded.records.length > 0);
  gameRecordLibraryEmpty.textContent = readFailed
    ? '目前無法載入已儲存的對局紀錄。'
    : '尚無可複盤的已完成對局。';
  return loaded;
}

function pauseLiveGameForGameRecords(invoker) {
  if (!normalGameActive() || busy) return false;
  gameReviewLivePresentation = {
    selected: selected ? { ...selected } : null,
    legal: legal.map((move) => ({ ...move })),
    overlayVisible: !overlay.classList.contains('hidden'),
    bannerVisible: !banner.classList.contains('hidden'),
  };
  gameReviewInvoker = invoker || document.activeElement;
  aiToken++;
  aiThinking = false;
  tweens.length = 0;
  stopConfetti();
  overlay.classList.add('hidden');
  banner.classList.add('hidden');
  clearSelection();
  lastFromMark.visible = false;
  lastToMark.visible = false;
  return true;
}

function restoreLiveGamePresentation() {
  const presentation = gameReviewLivePresentation;
  rebuildPieceMeshes(board, false);
  syncLastMoveMark();
  if (presentation?.selected) {
    selected = { ...presentation.selected };
    legal = presentation.legal.map((move) => ({ ...move }));
    showMoveDots(legal, board);
  }
  overlay.classList.toggle('hidden', !(presentation?.overlayVisible && over));
  banner.classList.toggle('hidden', !presentation?.bannerVisible);
  gameReviewLivePresentation = null;
}

function enterGameRecordLibrary(invoker = btnGameRecords) {
  if (!normalGameActive()) return false;
  if (busy) {
    toast('請等待目前棋步動畫完成後再開啟對局紀錄。');
    return false;
  }
  if (!pauseLiveGameForGameRecords(invoker)) return false;
  invalidateGameReviewAi();
  appState = APP_STATE.GAME_RECORD_LIBRARY;
  gameReviewSession = null;
  gameAnalysisState = null;
  gameReviewStored = false;
  gameReviewReturnState = APP_STATE.NORMAL_GAME;
  appEl.classList.add('game-record-active');
  gameRecordPanel.classList.remove('hidden');
  gameRecordLibraryView.classList.remove('hidden');
  gameReviewView.classList.add('hidden');
  gameAnalysisView.classList.add('hidden');
  renderGameRecordLibrary();
  refreshHUD();
  gameRecordLibraryHeading.focus({ preventScroll: true });
  return true;
}

function showGameRecordLibrary() {
  if (!gameRecordFlowActive()) return;
  invalidateGameReviewAi();
  clearGameAnalysisSelection();
  appState = APP_STATE.GAME_RECORD_LIBRARY;
  gameReviewSession = null;
  gameAnalysisState = null;
  gameReviewStored = false;
  gameRecordLibraryView.classList.remove('hidden');
  gameReviewView.classList.add('hidden');
  gameAnalysisView.classList.add('hidden');
  rebuildPieceMeshes(board, false);
  syncLastMoveMark();
  renderGameRecordLibrary();
  refreshHUD();
  gameRecordLibraryHeading.focus({ preventScroll: true });
}

function syncGameReviewMoveMark() {
  const move = gameReviewSession?.currentMove;
  lastFromMark.visible = lastToMark.visible = !!move;
  if (!move) return;
  const from = to3D(move.from.r, move.from.c);
  const to = to3D(move.to.r, move.to.c);
  lastFromMark.position.set(from.x, 0.012, from.z);
  lastToMark.position.set(to.x, 0.012, to.z);
}

function gameReviewAnnouncement() {
  const review = gameReviewSession;
  const move = review.currentMove ? `上一著：${review.currentMove.notation}。` : '開局位置。';
  if (review.atLast) {
    return `第 ${review.selectedPly} / ${review.totalPlies} 著。${move}終局：${gameRecordResultLabel(review.record)}。`;
  }
  const side = review.snapshot.sideToMove === RED ? '紅方' : '黑方';
  return `第 ${review.selectedPly} / ${review.totalPlies} 著。${move}${side}行棋。`;
}

function gameAnalysisTerminalLabel(terminal) {
  const reason = GAME_RECORD_REASON_LABELS[terminal.terminationReason] || terminal.terminationReason;
  return terminal.winner === null
    ? `和局・${reason}`
    : `${terminal.winner === RED ? '紅方' : '黑方'}勝・${reason}`;
}

function terminateGameReviewAiWorker(worker = gameReviewAiWorker) {
  if (!worker) return;
  worker.terminate();
  if (worker === gameReviewAiWorker) gameReviewAiWorker = null;
}

function invalidateGameReviewAi() {
  terminateGameReviewAiWorker();
  gameReviewAiState = invalidateGameReviewAiState(gameReviewAiState);
  gameReviewEvidenceState = null;
}

function gameReviewEvidenceTerminalText(label, terminal) {
  if (!terminal) return null;
  if (terminal.terminationReason === 'checkmate') return `${label}為一步將死`;
  if (terminal.terminationReason === 'stalemate') return `${label}立即形成困斃`;
  const reason = GAME_RECORD_REASON_LABELS[terminal.terminationReason] || terminal.terminationReason;
  return `${label}立即形成${reason}`;
}

function gameReviewEvidenceFactTexts(evidence) {
  if (!evidence || evidence.comparison.sameMove) return [];
  const facts = [];
  const branches = [
    ['實戰著', evidence.played],
    ['AI 候選', evidence.candidate],
  ];
  for (const [label, outcome] of branches) {
    if (outcome.capture) facts.push(`${label}立即吃到一${outcome.capture.name}`);
    if (outcome.givesCheck) facts.push(`${label}形成將軍`);
    const terminal = gameReviewEvidenceTerminalText(label, outcome.terminal);
    if (terminal) facts.push(terminal);
    if (outcome.movedPieceCaptureReplies?.length > 0) {
      facts.push(`${label}走後，對方有合法著法可吃到該棋子`);
    }
  }
  if (facts.length === 0) {
    facts.push('兩手皆為合法著；沒有可直接呈現的吃子、將軍或終局事實。');
  }
  return facts;
}

function renderGameReviewTeaching(evidence) {
  const [message] = deriveGameReviewTeaching(evidence);
  gameReviewTeaching.classList.toggle('hidden', !message);
  gameReviewTeachingTitle.textContent = message?.title ?? '';
  gameReviewTeachingBody.textContent = message?.body ?? '';
}

function renderGameReviewEvidence() {
  const evidence = gameReviewEvidenceState;
  gameReviewEvidence.classList.toggle('hidden', !evidence);
  renderGameReviewTeaching(evidence);
  if (!evidence) {
    gameReviewEvidencePlayed.textContent = '';
    gameReviewEvidenceCandidate.textContent = '';
    gameReviewEvidenceMatch.textContent = '';
    gameReviewEvidenceFacts.replaceChildren();
    return;
  }
  gameReviewEvidencePlayed.textContent = evidence.played.notation;
  gameReviewEvidenceCandidate.textContent = evidence.candidate.notation;
  gameReviewEvidenceMatch.textContent = evidence.comparison.sameMove
    ? '你的實戰著法與 AI 候選相同'
    : '';
  gameReviewEvidenceMatch.classList.toggle('hidden', !evidence.comparison.sameMove);
  gameReviewEvidenceFactsSection.classList.toggle('hidden', evidence.comparison.sameMove);
  gameReviewEvidenceFacts.replaceChildren(...gameReviewEvidenceFactTexts(evidence).map((fact) => {
    const item = document.createElement('li');
    item.textContent = fact;
    return item;
  }));
}

function renderGameReviewAi() {
  const terminal = !!gameReviewSession?.snapshot.terminal;
  const loading = gameReviewAiState.status === 'loading';
  btnGameReviewAiAnalyze.disabled = terminal || loading;
  btnGameReviewAiAnalyze.textContent = loading ? '分析中…' : 'AI 分析';
  btnGameReviewAiAnalyze.title = terminal ? '終局位置不可進行 AI 分析' : '';
  btnGameReviewAiAnalyze.setAttribute('aria-busy', String(loading));
  gameReviewAiPanel.classList.toggle('hidden', gameReviewAiState.status === 'idle');
  gameReviewAiPanel.classList.toggle('loading', loading);
  gameReviewAiPanel.classList.toggle('error', gameReviewAiState.status === 'error');
  gameReviewAiPanel.setAttribute('aria-busy', String(loading));
  if (loading) {
    gameReviewAiHeading.textContent = '電腦搜尋中…';
    gameReviewAiDetail.textContent = '正在分析目前的複盤局面。';
  } else if (gameReviewAiState.status === 'success') {
    gameReviewAiHeading.textContent = `AI 候選著法：${gameReviewAiState.candidate.notation}`;
    gameReviewAiDetail.textContent = `搜尋深度：${gameReviewAiState.candidate.depth}`;
  } else if (gameReviewAiState.status === 'error') {
    gameReviewAiHeading.textContent = gameReviewAiState.message;
    gameReviewAiDetail.textContent = '你可以再次按「AI 分析」重試。';
  } else {
    gameReviewAiHeading.textContent = '';
    gameReviewAiDetail.textContent = '';
  }
  renderGameReviewEvidence();
}

function handleGameReviewAiResponse(worker, response) {
  if (worker !== gameReviewAiWorker || appState !== APP_STATE.GAME_REVIEW || !gameReviewSession) return false;
  const settled = settleGameReviewAiResponse(gameReviewAiState, gameReviewSession, response);
  if (!settled.accepted) return false;
  terminateGameReviewAiWorker(worker);
  gameReviewAiState = settled.state;
  gameReviewEvidenceState = gameReviewAiState.status === 'success'
    ? createGameReviewEvidence(gameReviewSession, gameReviewAiState)
    : null;
  renderGameReviewAi();
  return true;
}

function createGameReviewAiWorker() {
  return new Worker(new URL('./ai-worker.js?v=4dd3e2c2ca', import.meta.url), { type: 'module' });
}

function requestGameReviewAiCandidate() {
  if (appState !== APP_STATE.GAME_REVIEW || !gameReviewSession || gameReviewSession.snapshot.terminal) return false;
  terminateGameReviewAiWorker();
  let started;
  try {
    started = beginGameReviewAiRequest(gameReviewAiState, gameReviewSession);
  } catch {
    return false;
  }
  gameReviewEvidenceState = null;
  gameReviewAiState = started.state;
  renderGameReviewAi();

  let worker;
  try {
    worker = createGameReviewAiWorker();
    gameReviewAiWorker = worker;
    worker.onmessage = (event) => handleGameReviewAiResponse(worker, event.data);
    worker.onerror = (event) => {
      event.preventDefault?.();
      handleGameReviewAiResponse(worker, {
        kind: 'review-candidate',
        recordId: started.request.recordId,
        ply: started.request.ply,
        revision: started.request.revision,
        error: 'Review AI worker failed.',
      });
    };
    worker.postMessage(started.request);
  } catch {
    handleGameReviewAiResponse(worker ?? gameReviewAiWorker, {
      kind: 'review-candidate',
      recordId: started.request.recordId,
      ply: started.request.ply,
      revision: started.request.revision,
      error: 'Review AI worker could not start.',
    });
  }
  return true;
}

function renderGameReview() {
  if (!gameReviewSession) return;
  const review = gameReviewSession;
  gameReviewMeta.replaceChildren();
  appendGameReviewMeta('模式', gameRecordModeLabel(review.record.mode));
  appendGameReviewMeta('完成時間', formatGameRecordCompletedAt(review.record.completedAt));
  appendGameReviewMeta('結果', gameRecordResultLabel(review.record));
  appendGameReviewMeta('進度', `${review.selectedPly} / ${review.totalPlies}`);
  gameReviewStatus.textContent = gameReviewAnnouncement();
  gameReviewMoveCount.textContent = `${review.totalPlies} 著`;
  gameReviewMoveList.replaceChildren(...review.moves.map((move) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'game-review-move';
    button.dataset.reviewPly = String(move.ply);
    button.setAttribute('aria-label', `第 ${move.ply} 著，${move.side === RED ? '紅方' : '黑方'}，${move.notation}`);
    if (move.ply === review.selectedPly) button.setAttribute('aria-current', 'step');
    const ply = document.createElement('span');
    ply.className = 'ply';
    ply.textContent = String(move.ply);
    const side = document.createElement('span');
    side.className = `side ${move.side}`;
    side.textContent = move.side === RED ? '紅' : '黑';
    const notationText = document.createElement('span');
    notationText.textContent = move.notation;
    button.append(ply, side, notationText);
    item.append(button);
    return item;
  }));
  btnGameReviewFirst.disabled = review.atFirst;
  btnGameReviewPrevious.disabled = review.atFirst;
  btnGameReviewNext.disabled = review.atLast;
  btnGameReviewLast.disabled = review.atLast;
  btnGameReviewAnalyze.disabled = !!review.snapshot.terminal;
  btnGameReviewAnalyze.title = review.snapshot.terminal ? '終局位置不可開始分析' : '';
  btnGameReviewCreatePuzzle.disabled = !!review.snapshot.terminal;
  btnGameReviewCreatePuzzle.title = review.snapshot.terminal ? '終局位置不可建立殺局題，請先返回較早著數' : '';
  renderGameReviewAi();
  btnGameReviewBack.classList.toggle('hidden', gameReviewReturnState !== APP_STATE.GAME_RECORD_LIBRARY);
  btnGameReviewDelete.classList.toggle('hidden', !gameReviewStored);
  rebuildPieceMeshes(review.snapshot.board, false);
  syncGameReviewMoveMark();
  const invariant = checkBoardMeshInvariant(review.snapshot.board);
  if (!invariant.ok) throw new Error(`Game review board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  refreshHUD();
  const selectedMove = gameReviewMoveList.querySelector('[aria-current="step"]');
  if (selectedMove) {
    const listRect = gameReviewMoveList.getBoundingClientRect();
    const moveRect = selectedMove.getBoundingClientRect();
    if (moveRect.top < listRect.top) gameReviewMoveList.scrollTop += moveRect.top - listRect.top;
    else if (moveRect.bottom > listRect.bottom) {
      gameReviewMoveList.scrollTop += moveRect.bottom - listRect.bottom;
    }
  }
}

function clearGameAnalysisSelection() {
  gameAnalysisSelected = null;
  gameAnalysisLegal = [];
  clearFX();
  selRing.visible = false;
}

function syncGameAnalysisMoveMark() {
  const move = gameAnalysisState?.moves.at(-1);
  lastFromMark.visible = lastToMark.visible = !!move;
  if (!move) return;
  const from = to3D(move.from.r, move.from.c);
  const to = to3D(move.to.r, move.to.c);
  lastFromMark.position.set(from.x, 0.012, from.z);
  lastToMark.position.set(to.x, 0.012, to.z);
}

function gameAnalysisAnnouncement() {
  const analysis = gameAnalysisState;
  const source = `來源：第 ${analysis.sourcePly} 著。`;
  const action = gameAnalysisNotice ? `${gameAnalysisNotice} ` : '';
  if (analysis.terminal) return `${action}${source}分析終止：${gameAnalysisTerminalLabel(analysis.terminal)}。`;
  const side = analysis.currentSide === RED ? '紅方' : '黑方';
  return `${action}${source}已試走 ${analysis.moves.length} 著，${side}行棋。`;
}

function renderGameAnalysis() {
  if (!gameAnalysisState) return;
  const analysis = gameAnalysisState;
  gameAnalysisMeta.replaceChildren();
  appendGameReviewMeta('原對局', analysis.sourceRecordId, gameAnalysisMeta);
  appendGameReviewMeta('來源進度', `${analysis.sourcePly} / ${analysis.sourceRecord.moves.length}`, gameAnalysisMeta);
  appendGameReviewMeta('分析進度', `${analysis.moves.length} 著`, gameAnalysisMeta);
  gameAnalysisStatus.textContent = gameAnalysisAnnouncement();
  gameAnalysisStatus.classList.toggle('terminal', !!analysis.terminal);
  gameAnalysisMoveCount.textContent = `${analysis.moves.length} 著`;
  gameAnalysisMoveList.replaceChildren(...analysis.moves.map((move, index) => {
    const item = document.createElement('li');
    if (index === analysis.moves.length - 1) item.setAttribute('aria-current', 'step');
    const ply = document.createElement('span');
    ply.className = 'ply';
    ply.textContent = String(move.ply);
    const side = document.createElement('span');
    side.className = `side ${move.side}`;
    side.textContent = move.side === RED ? '紅' : '黑';
    const notationText = document.createElement('span');
    notationText.textContent = move.notation;
    item.append(ply, side, notationText);
    return item;
  }));
  btnGameAnalysisUndo.disabled = analysis.moves.length === 0;
  btnGameAnalysisReset.disabled = analysis.moves.length === 0;
  rebuildPieceMeshes(analysis.currentBoard, false);
  syncGameAnalysisMoveMark();
  if (gameAnalysisSelected && !analysis.terminal) {
    showMoveDots(gameAnalysisLegal, analysis.currentBoard, gameAnalysisSelected);
  }
  const invariant = checkBoardMeshInvariant(analysis.currentBoard);
  if (!invariant.ok) throw new Error(`Game analysis board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  refreshHUD();
  gameAnalysisMoveList.scrollTop = gameAnalysisMoveList.scrollHeight;
}

function enterGameAnalysis(invoker = btnGameReviewAnalyze) {
  if (appState !== APP_STATE.GAME_REVIEW || !gameReviewSession || gameReviewSession.snapshot.terminal) return false;
  try {
    gameAnalysisState = createGameAnalysis(gameReviewSession.record, gameReviewSession.selectedPly);
  } catch {
    toast('目前的複盤位置無法建立分析沙盤。');
    return false;
  }
  invalidateGameReviewAi();
  clearGameAnalysisSelection();
  gameAnalysisNotice = '已建立臨時分析沙盤。';
  appState = APP_STATE.GAME_ANALYSIS;
  gameReviewView.classList.add('hidden');
  gameAnalysisView.classList.remove('hidden');
  gameRecordPanel.scrollTop = 0;
  renderGameAnalysis();
  gameAnalysisHeading.focus({ preventScroll: true });
  return true;
}

function makeGameAnalysisMove(from, to) {
  if (appState !== APP_STATE.GAME_ANALYSIS || !gameAnalysisState || gameAnalysisState.terminal) return false;
  try {
    gameAnalysisState = applyGameAnalysisMove(gameAnalysisState, from, to);
  } catch {
    return false;
  }
  clearGameAnalysisSelection();
  gameAnalysisNotice = '已加入一著分析。';
  renderGameAnalysis();
  return true;
}

function undoGameAnalysis() {
  if (appState !== APP_STATE.GAME_ANALYSIS || !gameAnalysisState || gameAnalysisState.moves.length === 0) return false;
  gameAnalysisState = undoGameAnalysisMove(gameAnalysisState);
  clearGameAnalysisSelection();
  gameAnalysisNotice = '已悔棋。';
  renderGameAnalysis();
  return true;
}

function resetGameAnalysisToSource() {
  if (appState !== APP_STATE.GAME_ANALYSIS || !gameAnalysisState) return false;
  gameAnalysisState = resetGameAnalysis(gameAnalysisState);
  clearGameAnalysisSelection();
  gameAnalysisNotice = '已重置到來源局面。';
  renderGameAnalysis();
  return true;
}

function returnToGameReview() {
  if (appState !== APP_STATE.GAME_ANALYSIS || !gameAnalysisState || !gameReviewSession) return false;
  clearGameAnalysisSelection();
  gameAnalysisState = null;
  gameAnalysisNotice = '';
  appState = APP_STATE.GAME_REVIEW;
  gameAnalysisView.classList.add('hidden');
  gameReviewView.classList.remove('hidden');
  gameRecordPanel.scrollTop = 0;
  renderGameReview();
  btnGameReviewAnalyze.focus({ preventScroll: true });
  return true;
}

function selectGameAnalysisPiece(r, c) {
  if (!gameAnalysisState || gameAnalysisState.terminal) return;
  gameAnalysisSelected = { r, c };
  gameAnalysisLegal = [...gameAnalysisLegalMoves(gameAnalysisState, gameAnalysisSelected)];
  showMoveDots(gameAnalysisLegal, gameAnalysisState.currentBoard, gameAnalysisSelected);
  refreshHUD();
}

function handleGameAnalysisBoardClick(hit) {
  if (!gameAnalysisState || gameAnalysisState.terminal) return;
  if (!hit) {
    clearGameAnalysisSelection();
    refreshHUD();
    return;
  }
  const target = hit.userData?.piece ? hit.userData : hit;
  const { r, c } = target;
  if (gameAnalysisSelected && gameAnalysisLegal.some((move) => move.r === r && move.c === c)) {
    makeGameAnalysisMove(gameAnalysisSelected, { r, c });
    return;
  }
  if (target.piece?.side === gameAnalysisState.currentSide) {
    if (gameAnalysisSelected?.r === r && gameAnalysisSelected?.c === c) {
      clearGameAnalysisSelection();
      refreshHUD();
    } else selectGameAnalysisPiece(r, c);
    return;
  }
  clearGameAnalysisSelection();
  refreshHUD();
}

function openGameReview(record, { returnState, invoker, stored = false } = {}) {
  let opened;
  try {
    opened = createGameReview(record);
  } catch {
    toast('此筆對局無法建立複盤。');
    return false;
  }
  const sourceState = appState;
  if (sourceState === APP_STATE.NORMAL_GAME && !pauseLiveGameForGameRecords(invoker)) return false;
  if (sourceState !== APP_STATE.NORMAL_GAME
    && sourceState !== APP_STATE.GAME_RECORD_LIBRARY
    && sourceState !== APP_STATE.GAME_REVIEW) return false;
  invalidateGameReviewAi();
  gameReviewReturnState = returnState
    || (sourceState === APP_STATE.GAME_RECORD_LIBRARY ? APP_STATE.GAME_RECORD_LIBRARY : APP_STATE.NORMAL_GAME);
  gameReviewSession = opened;
  gameAnalysisState = null;
  gameReviewStored = stored;
  appState = APP_STATE.GAME_REVIEW;
  appEl.classList.add('game-record-active');
  gameRecordPanel.classList.remove('hidden');
  gameRecordLibraryView.classList.add('hidden');
  gameReviewView.classList.remove('hidden');
  gameAnalysisView.classList.add('hidden');
  renderGameReview();
  gameReviewHeading.focus({ preventScroll: true });
  return true;
}

function openLastCompletedGameReview(invoker = btnReviewGame) {
  if (!lastCompletedGameRecord) {
    toast('目前沒有可複盤的已完成對局。');
    return false;
  }
  return openGameReview(lastCompletedGameRecord, {
    returnState: APP_STATE.NORMAL_GAME,
    invoker,
    stored: false,
  });
}

function openStoredGameReview(id, invoker) {
  const record = gameRecordStore.getGameRecord(id);
  if (!record) {
    toast('找不到這筆對局，可能已被刪除或目前無法讀取。');
    if (appState === APP_STATE.GAME_RECORD_LIBRARY) renderGameRecordLibrary();
    return false;
  }
  return openGameReview(record, {
    returnState: APP_STATE.GAME_RECORD_LIBRARY,
    invoker,
    stored: true,
  });
}

function navigateGameReview(target) {
  if (appState !== APP_STATE.GAME_REVIEW || !gameReviewSession) return false;
  let nextReview;
  if (target === 'first') nextReview = firstGameReviewPly(gameReviewSession);
  else if (target === 'previous') nextReview = previousGameReviewPly(gameReviewSession);
  else if (target === 'next') nextReview = nextGameReviewPly(gameReviewSession);
  else if (target === 'last') nextReview = lastGameReviewPly(gameReviewSession);
  else if (Number.isInteger(target)) nextReview = selectGameReviewPly(gameReviewSession, target);
  else return false;
  invalidateGameReviewAi();
  gameReviewSession = nextReview;
  renderGameReview();
  return true;
}

function deleteGameRecordFromLibrary(id) {
  if (!window.confirm('確定要刪除這筆已完成對局嗎？刪除後無法復原。')) return false;
  try {
    const deleted = gameRecordStore.deleteGameRecord(id);
    if (!deleted) {
      toast('找不到這筆對局，可能已被刪除。');
      if (appState === APP_STATE.GAME_RECORD_LIBRARY) renderGameRecordLibrary();
      return false;
    }
    if (gameReviewSession?.record.id === id) {
      invalidateGameReviewAi();
      gameReviewStored = false;
      btnGameReviewDelete.classList.add('hidden');
      toast('紀錄已刪除；目前的唯讀複盤仍可繼續。');
    } else {
      toast('對局紀錄已刪除。');
      renderGameRecordLibrary();
    }
    return true;
  } catch {
    toast('無法刪除對局紀錄；儲存內容未被改寫。');
    return false;
  }
}

function exitGameReview() {
  if (appState !== APP_STATE.GAME_REVIEW) return;
  if (gameReviewReturnState === APP_STATE.GAME_RECORD_LIBRARY) showGameRecordLibrary();
  else exitGameRecordFlow();
}

function exitGameRecordFlow() {
  if (!gameRecordFlowActive()) return;
  const invoker = gameReviewInvoker;
  invalidateGameReviewAi();
  clearGameAnalysisSelection();
  aiToken++;
  aiThinking = false;
  tweens.length = 0;
  appState = APP_STATE.NORMAL_GAME;
  gameReviewSession = null;
  gameAnalysisState = null;
  gameAnalysisNotice = '';
  gameReviewStored = false;
  gameReviewReturnState = APP_STATE.NORMAL_GAME;
  appEl.classList.remove('game-record-active');
  gameRecordPanel.classList.add('hidden');
  gameRecordLibraryView.classList.remove('hidden');
  gameReviewView.classList.add('hidden');
  gameAnalysisView.classList.add('hidden');
  restoreLiveGamePresentation();
  refreshHUD();
  maybeAIMove();
  invoker?.focus?.({ preventScroll: true });
  gameReviewInvoker = null;
}

function activatePuzzleEditor(initialEditorState, message) {
  aiToken++;
  aiThinking = false;
  tweens.length = 0;
  releasePhotoReference();
  clearSelection();
  editorState = initialEditorState;
  appState = APP_STATE.PUZZLE_EDITOR;
  confirmedPosition = null;
  recorderState = null;
  recordedPuzzleResult = null;
  appEl.classList.remove('game-record-active');
  gameRecordPanel.classList.add('hidden');
  appEl.classList.add('editor-active');
  editorPanel.classList.remove('hidden');
  lastFromMark.visible = false;
  lastToMark.visible = false;
  banner.classList.add('hidden');
  setEditorTool({ kind: 'move' });
  document.querySelector(`input[name="editorSide"][value="${editorState.sideToMove}"]`).checked = true;
  setEditorMessage(message);
  setPhotoImportMessage('支援 JPEG、PNG、WebP，檔案上限 10 MB。');
  syncEditorScene();
  syncRecorderUI();
  refreshHUD();
  editorHeading.focus({ preventScroll: true });
  return true;
}

function enterEditor() {
  if (!normalGameActive()) return true;
  if (busy) {
    toast('請等待目前棋步動畫完成後再進入編輯。');
    return false;
  }
  gameReviewPuzzleReturnContext = null;
  return activatePuzzleEditor(
    createEditorState(),
    '選擇棋子後點擊空交叉點即可放置。',
  );
}

function createPuzzleFromGameReview(invoker = btnGameReviewCreatePuzzle) {
  if (appState !== APP_STATE.GAME_REVIEW || !gameReviewSession || gameReviewSession.snapshot.terminal) {
    return false;
  }
  let handoff;
  try {
    handoff = createGameReviewPuzzleHandoff(gameReviewSession);
  } catch {
    toast('目前的複盤位置無法建立殺局題。');
    return false;
  }
  gameReviewPuzzleReturnContext = Object.freeze({
    reviewSession: gameReviewSession,
    sourceRecordId: handoff.sourceRecordId,
    sourcePly: handoff.sourcePly,
    invoker,
  });
  invalidateGameReviewAi();
  const sideLabel = handoff.editorState.sideToMove === RED ? '紅方' : '黑方';
  return activatePuzzleEditor(
    handoff.editorState,
    `已從複盤第 ${handoff.sourcePly} 著載入局面（${sideLabel}先行）。請確認或編輯後再錄製答案。`,
  );
}

function exitEditor() {
  if (!puzzleFlowActive()) return;
  const reviewReturn = gameReviewPuzzleReturnContext;
  if (appState === APP_STATE.PUZZLE_PRACTICING) finalizePracticeAttempt('abandoned');
  aiToken++;
  practiceToken++;
  aiThinking = false;
  tweens.length = 0;
  releasePhotoReference();
  appState = APP_STATE.NORMAL_GAME;
  editorState = null;
  confirmedPosition = null;
  recorderState = null;
  recordedPuzzleResult = null;
  practiceState = null;
  practiceAttempt = null;
  clearPracticeHint();
  libraryViewPuzzle = null;
  activeSavedPuzzleId = null;
  savedCurrentPuzzleId = null;
  clearPendingPuzzleImport({ clearStatus: true });
  gameReviewPuzzleReturnContext = null;
  busy = false;
  clearSelection();
  appEl.classList.remove('editor-active');
  appEl.classList.remove('library-active');
  editorPanel.classList.add('hidden');
  editorPanel.classList.remove('recorder-active');
  recorderPanel.classList.add('hidden');
  libraryPanel.classList.add('hidden');
  if (reviewReturn) {
    gameReviewSession = reviewReturn.reviewSession;
    appState = APP_STATE.GAME_REVIEW;
    appEl.classList.add('game-record-active');
    gameRecordPanel.classList.remove('hidden');
    gameRecordLibraryView.classList.add('hidden');
    gameReviewView.classList.remove('hidden');
    gameAnalysisView.classList.add('hidden');
    renderGameReview();
    reviewReturn.invoker?.focus?.({ preventScroll: true });
    return;
  }
  syncLastMoveMark();
  buildScene();
  refreshHUD();
  maybeAIMove();
}

function cloneConfirmedPosition() {
  if (!confirmedPosition) return null;
  return exportAuthoredPosition(createEditorState({
    board: confirmedPosition.initialBoard,
    sideToMove: confirmedPosition.sideToMove,
  }));
}

function cloneRecordedPuzzleResult() {
  return recordedPuzzleResult ? exportRecordedResult(recordedPuzzleResult) : null;
}

function activePuzzleBoard() {
  if (practiceActive()) return practiceState?.currentBoard || null;
  if (recorderBoardActive()) return recorderState?.board || null;
  if (authoringActive()) return editorState?.board || null;
  if (appState === APP_STATE.PUZZLE_VIEW) return libraryViewPuzzle?.initialBoard || null;
  return null;
}

function setRecorderMessage(message, kind = '') {
  recorderMessage.textContent = message;
  recorderMessage.classList.toggle('success', kind === 'success');
  recorderMessage.classList.toggle('error', kind === 'error');
}

function setSavePuzzleMessage(message, kind = '') {
  savePuzzleMessage.textContent = message;
  savePuzzleMessage.classList.toggle('success', kind === 'success');
  savePuzzleMessage.classList.toggle('error', kind === 'error');
}

function renderRecorderLog() {
  recorderLog.innerHTML = '';
  const records = recorderState?.records || [];
  recorderEmpty.classList.toggle('hidden', records.length > 0);
  for (const record of records) {
    const li = document.createElement('li');
    const side = document.createElement('span');
    side.className = `side ${record.move.side}`;
    side.textContent = record.move.side === RED ? '紅' : '黑';
    li.append(side, document.createTextNode(` ${record.notation}`));
    recorderLog.appendChild(li);
  }
  recorderLog.scrollTop = recorderLog.scrollHeight;
}

function syncRecorderUI() {
  const visible = recorderVisible();
  const inPractice = practiceActive();
  recorderPanel.classList.toggle('hidden', !visible);
  editorPanel.classList.toggle('recorder-active', puzzleBoardActive());
  recorderReady.classList.toggle('hidden', appState !== APP_STATE.PUZZLE_CONFIRMED);
  recorderWorkspace.classList.toggle('hidden', !recorderBoardActive());
  practiceWorkspace.classList.toggle('hidden', !inPractice);
  recorderMessage.classList.toggle('hidden', inPractice);
  btnPracticeStart.classList.toggle('hidden', appState !== APP_STATE.PUZZLE_RECORDED);
  savePuzzlePanel.classList.toggle('hidden', appState !== APP_STATE.PUZZLE_RECORDED);
  syncPhotoUI();
  if (!visible) return;

  if (inPractice) {
    syncPracticeUI();
    return;
  }

  if (appState === APP_STATE.PUZZLE_CONFIRMED) {
    recorderTitle.textContent = '答案錄製';
    recorderSubtitle.textContent = '局面已確認，可以開始錄製。';
    recorderBadge.textContent = '準備錄製';
    setRecorderMessage('局面已確認，可以開始錄製答案。');
    return;
  }

  const recorded = appState === APP_STATE.PUZZLE_RECORDED;
  const side = recorderState.currentSide;
  recorderTitle.textContent = recorded ? '答案已完成' : '錄製答案';
  recorderSubtitle.textContent = recorded ? '殺局答案已保留在記憶體中。' : '在棋盤上依序走出攻守雙方著法。';
  recorderBadge.textContent = recorded ? '已完成' : `第 ${recorderState.solution.length + 1} 著`;
  recorderTurnText.textContent = recorded ? '錄製完成' : (side === RED ? '紅方行棋' : '黑方行棋');
  const color = side === RED ? '#c05345' : '#8b93a1';
  recorderTurnDot.style.background = color;
  recorderTurnDot.style.boxShadow = `0 0 8px ${color}`;
  btnRecorderUndo.disabled = busy || recorded || recorderState.solution.length === 0;
  btnRecorderReset.disabled = busy;
  btnRecorderFinish.disabled = busy || recorded;
  if (recorded && !puzzleTitleInput.placeholder) puzzleTitleInput.placeholder = '例如：殺局 001';
  renderRecorderLog();
}

function setPracticeMessage(message, kind = '') {
  practiceMessage.textContent = message;
  practiceMessage.classList.toggle('success', kind === 'success');
  practiceMessage.classList.toggle('error', kind === 'error');
}

// Fixed accessibility convention: rows count from the red baseline toward
// black; files count from the red player's left. It does not change with camera rotation.
function formatPracticeCoordinate(coordinate) {
  return `紅方視角，自底線起第 ${coordinate.r + 1} 橫列、自左側起第 ${coordinate.c + 1} 直路`;
}

function formatPracticeHintMessage(hint) {
  const lines = [`提示：請考慮「${hint.piece.name}」`];
  if (hint.from) lines.push(`起點：${formatPracticeCoordinate(hint.from)}`);
  if (hint.to) lines.push(`目標：${formatPracticeCoordinate(hint.to)}`);
  if (hint.notation) lines.push(`答案：${hint.notation}`);
  return lines.join('\n');
}

function practiceHintAvailable() {
  return appState === APP_STATE.PUZZLE_PRACTICING
    && practiceState?.status === 'practicing'
    && practiceState.currentSide === practiceState.practiceSide
    && !busy
    && practiceHintLevel < PRACTICE_HINT_MAX_LEVEL;
}

function syncPracticeHintUI() {
  const labels = ['提示', '再提示', '再提示', '顯示答案', '已顯示答案'];
  btnPracticeHint.textContent = labels[practiceHintLevel];
  btnPracticeHint.disabled = !practiceHintAvailable();
  practiceHintMessage.textContent = practiceHint ? formatPracticeHintMessage(practiceHint) : '';
  practiceHintMessage.classList.toggle('hidden', !practiceHint);
}

function clearPracticeHint() {
  practiceHintLevel = 0;
  practiceHint = null;
  clearPracticeHintMarkers();
  syncPracticeHintUI();
}

function requestPracticeHint() {
  if (!practiceHintAvailable()) return;
  const nextLevel = practiceHintLevel + 1;
  try {
    practiceHint = derivePracticeHint(practiceState, nextLevel);
    practiceHintLevel = nextLevel;
    recordPracticeHintRequest(nextLevel);
    syncPracticeHintMarkers();
    syncPracticeHintUI();
  } catch (error) {
    if (!(error instanceof PuzzlePracticeError)) throw error;
    practiceHintMessage.textContent = '目前無法顯示提示，請重新開始本題。';
    practiceHintMessage.classList.remove('hidden');
  }
}

function syncPracticeUI() {
  if (!practiceState) return;
  const complete = appState === APP_STATE.PUZZLE_PRACTICE_COMPLETE;
  const playerTurn = practiceState.currentSide === practiceState.practiceSide;
  recorderTitle.textContent = complete ? '練習完成' : '殺局練習';
  recorderSubtitle.textContent = complete
    ? '已成功走出完整的錄製殺局。'
    : '依照已錄製答案走棋，對手會自動回應。';
  recorderBadge.textContent = complete ? '完成' : `第 ${practiceState.currentPly + 1} 手`;
  practiceTurnText.textContent = complete
    ? '練習完成'
    : (playerTurn
      ? `${practiceState.practiceSide === RED ? '紅方' : '黑方'}請走`
      : '對手回應中…');
  const color = practiceState.currentSide === RED ? '#c05345' : '#8b93a1';
  practiceTurnDot.style.background = color;
  practiceTurnDot.style.boxShadow = `0 0 8px ${color}`;
  practiceProgress.textContent = complete
    ? `共 ${practiceState.solution.length} 著`
    : `進度 ${practiceState.currentPly} / ${practiceState.solution.length}`;
  practiceMistakes.textContent = `錯誤 ${practiceState.mistakes} 次`;
  btnPracticeRestart.disabled = busy;
  btnPracticeExit.textContent = practiceReturnState === 'library' ? '返回題庫' : '返回答案';
  syncPracticeHintUI();
}

function syncRecorderScene() {
  tweens.length = 0;
  rebuildPieceMeshes(recorderState.board, false);
  const invariant = checkBoardMeshInvariant(recorderState.board);
  if (!invariant.ok) throw new Error(`Recorder board/mesh invariant failed: ${invariant.errors.join(' ')}`);
}

function startRecording() {
  if (appState !== APP_STATE.PUZZLE_CONFIRMED || !confirmedPosition) return;
  recorderState = createRecorder(confirmedPosition);
  appState = APP_STATE.PUZZLE_RECORDING;
  recordedPuzzleResult = null;
  savedCurrentPuzzleId = null;
  clearSelection();
  setRecorderMessage('請在棋盤上走出第一著。');
  syncRecorderScene();
  syncRecorderUI();
  refreshHUD();
}

function cancelRecording() {
  if (!recorderBoardActive() || !confirmedPosition) return;
  appState = APP_STATE.PUZZLE_CONFIRMED;
  recorderState = null;
  editorState = createEditorState({
    board: confirmedPosition.initialBoard,
    sideToMove: confirmedPosition.sideToMove,
  });
  clearSelection();
  syncEditorScene();
  syncRecorderUI();
  refreshHUD();
}

function resetRecorder() {
  if (!recorderState || busy) return;
  recorderState = resetRecording(recorderState);
  recordedPuzzleResult = null;
  savedCurrentPuzzleId = null;
  appState = APP_STATE.PUZZLE_RECORDING;
  clearSelection();
  syncRecorderScene();
  setRecorderMessage('已回到原始局面，請重新錄製。');
  syncRecorderUI();
  refreshHUD();
}

function undoRecorder() {
  if (appState !== APP_STATE.PUZZLE_RECORDING || busy || !recorderState?.solution.length) return;
  recorderState = undoRecordedMove(recorderState);
  clearSelection();
  syncRecorderScene();
  setRecorderMessage('已退回一著。');
  syncRecorderUI();
  refreshHUD();
}

function finishRecorder() {
  if (appState !== APP_STATE.PUZZLE_RECORDING || busy) return;
  const result = finishRecording(recorderState);
  if (!result.ok) {
    const message = result.error.code === 'EMPTY_SOLUTION'
      ? '請至少錄製一著後再完成答案。'
      : `答案無效：${result.error.message}`;
    setRecorderMessage(message, 'error');
    toast(message);
    return;
  }
  if (!result.checkmate) {
    setRecorderMessage('目前棋譜合法，但最後局面尚未將死。', 'error');
    toast('尚未形成將死。');
    return;
  }
  recorderState = result.recorder;
  recordedPuzzleResult = exportRecordedResult(result.result);
  savedCurrentPuzzleId = null;
  puzzleTitleInput.value = '';
  puzzleNotesInput.value = '';
  btnSavePuzzle.disabled = false;
  setSavePuzzleMessage('輸入名稱後即可儲存到此瀏覽器。');
  appState = APP_STATE.PUZZLE_RECORDED;
  clearSelection();
  const invariant = checkBoardMeshInvariant(recorderState.board);
  if (!invariant.ok) throw new Error(`Recorder board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  setRecorderMessage('答案有效：已形成將死', 'success');
  syncRecorderUI();
  refreshHUD();
  toast('答案有效：已形成將死');
}

function storeErrorMessage(error) {
  if (!(error instanceof PuzzleStoreError)) return '儲存空間發生未知錯誤。';
  if (error.code === 'EMPTY_TITLE') return '請輸入題目名稱。';
  if (error.code === 'STORAGE_CORRUPT') return '題庫含有損壞資料，為避免覆寫，這次操作已取消。';
  if (error.code === 'STORE_READ_FAILED') return '無法讀取瀏覽器儲存空間，請確認隱私設定；原有資料未變更。';
  if (error.code === 'STORE_WRITE_FAILED') return '無法寫入瀏覽器儲存空間，請確認空間或隱私設定。';
  return `題庫操作失敗：${error.message}`;
}

function transferErrorMessage(error) {
  if (!(error instanceof PuzzleTransferError)) return '無法讀取匯入檔案，請確認檔案仍可存取。';
  const messages = {
    INVALID_JSON: '檔案不是有效的 JSON。',
    INVALID_ROOT: '檔案不是有效的殺局匯出格式。',
    UNSUPPORTED_FORMAT: '檔案格式不受支援。',
    UNSUPPORTED_SCHEMA_VERSION: '檔案版本不受支援。',
    UNSUPPORTED_PUZZLE_VERSION: '檔案包含不受支援的題目版本。',
    INVALID_EXPORTED_AT: '檔案的匯出時間無效。',
    TOO_LARGE: '檔案超過 5 MiB 上限。',
    TOO_MANY_PUZZLES: '檔案超過 1000 題上限。',
    DUPLICATE_ID: '檔案內含重複的題目 ID，未匯入任何資料。',
    INVALID_PUZZLE: '檔案內含無效的殺局題目。',
    NOT_CHECKMATE: '檔案內含未以將死結束的答案。',
  };
  return messages[error.code] || `無法匯入：${error.message}`;
}

function setLibraryTransferStatus(message, kind = '') {
  libraryTransferStatus.textContent = message;
  libraryTransferStatus.classList.toggle('success', kind === 'success');
  libraryTransferStatus.classList.toggle('error', kind === 'error');
}

function preparePuzzleImportPreview(puzzles, existingPuzzles) {
  const existingIds = new Set(existingPuzzles.map((puzzle) => puzzle.id));
  const skippedIds = puzzles.filter((puzzle) => existingIds.has(puzzle.id)).map((puzzle) => puzzle.id);
  return Object.freeze({
    totalValidCount: puzzles.length,
    importableCount: puzzles.length - skippedIds.length,
    skippedCollisionCount: skippedIds.length,
    skippedIds: Object.freeze(skippedIds),
  });
}

function clearPendingPuzzleImport({ clearStatus = false } = {}) {
  puzzleImportToken++;
  pendingPuzzleImport = null;
  puzzleImportFile.value = '';
  libraryImportPreview.classList.add('hidden');
  libraryImportPreviewText.textContent = '';
  btnLibraryImportConfirm.disabled = true;
  if (clearStatus) {
    setLibraryTransferStatus(
      `匯入／匯出格式：${PUZZLE_TRANSFER_FORMAT} v${PUZZLE_TRANSFER_SCHEMA_VERSION}；統計與照片不包含在內。`,
    );
  }
}

function safeDownloadName(value) {
  const normalized = String(value || '').normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return normalized || 'puzzle';
}

function downloadPuzzleTransfer(records, filename) {
  const text = serializePuzzleExport(records);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return text;
}

function exportAllPuzzles() {
  const loaded = puzzleStore.loadAll();
  if (loaded.puzzles.length === 0) return;
  try {
    downloadPuzzleTransfer(loaded.puzzles, 'chinese-chess-puzzles.json');
    setLibraryTransferStatus(`已匯出 ${loaded.puzzles.length} 題；統計與照片未包含。`, 'success');
  } catch (error) {
    setLibraryTransferStatus(transferErrorMessage(error), 'error');
  }
}

function exportSelectedPuzzle() {
  if (!activeSavedPuzzleId) return;
  const puzzle = puzzleStore.getPuzzle(activeSavedPuzzleId);
  if (!puzzle) {
    setLibraryTransferStatus('找不到要匯出的題目。', 'error');
    return;
  }
  try {
    const filename = `chinese-chess-puzzle-${safeDownloadName(puzzle.title)}.json`;
    downloadPuzzleTransfer([puzzle], filename);
    setLibraryTransferStatus(`已匯出「${puzzle.title}」；統計與照片未包含。`, 'success');
  } catch (error) {
    setLibraryTransferStatus(transferErrorMessage(error), 'error');
  }
}

async function loadPuzzleImportFile(file) {
  const token = ++puzzleImportToken;
  pendingPuzzleImport = null;
  libraryImportPreview.classList.add('hidden');
  btnLibraryImportConfirm.disabled = true;
  if (!file) {
    puzzleImportFile.value = '';
    return;
  }
  setLibraryTransferStatus('正在本機驗證匯入檔案…');
  try {
    if (file.size > PUZZLE_TRANSFER_MAX_BYTES) {
      throw new PuzzleTransferError('TOO_LARGE', 'Puzzle transfer is too large.');
    }
    const text = await file.text();
    if (token !== puzzleImportToken || !libraryActive()) return;
    const puzzles = parsePuzzleImport(text);
    const loaded = puzzleStore.loadAll();
    if (loaded.issues.length) {
      const readFailed = loaded.issues.some((entry) => entry.code === 'STORE_READ_FAILED');
      throw new PuzzleStoreError(
        readFailed ? 'STORE_READ_FAILED' : 'STORAGE_CORRUPT',
        'Existing storage cannot be safely modified.',
      );
    }
    const preview = preparePuzzleImportPreview(puzzles, loaded.puzzles);
    pendingPuzzleImport = Object.freeze({ puzzles, preview });
    libraryImportPreviewText.textContent = `有效 ${preview.totalValidCount} 題；可匯入 ${preview.importableCount} 題；既有 ID 衝突 ${preview.skippedCollisionCount} 題將略過且不覆寫。`;
    libraryImportPreview.classList.remove('hidden');
    btnLibraryImportConfirm.disabled = preview.importableCount === 0;
    setLibraryTransferStatus(
      preview.importableCount
        ? '檔案驗證完成。請確認預覽後再匯入。'
        : '檔案驗證完成，但所有題目 ID 都已存在，沒有資料需要匯入。',
    );
  } catch (error) {
    if (token !== puzzleImportToken) return;
    const message = error instanceof PuzzleStoreError
      ? storeErrorMessage(error)
      : transferErrorMessage(error);
    setLibraryTransferStatus(message, 'error');
    pendingPuzzleImport = null;
    libraryImportPreview.classList.add('hidden');
  } finally {
    if (token === puzzleImportToken) puzzleImportFile.value = '';
  }
}

function cancelPuzzleImport() {
  clearPendingPuzzleImport();
  setLibraryTransferStatus('已取消匯入；題庫未變更。');
}

function confirmPuzzleImport() {
  if (!pendingPuzzleImport || pendingPuzzleImport.preview.importableCount === 0) return;
  try {
    const result = puzzleStore.importPuzzles(pendingPuzzleImport.puzzles);
    clearPendingPuzzleImport();
    renderLibraryList();
    setLibraryTransferStatus(
      `匯入完成：新增 ${result.importedCount} 題，略過既有 ID ${result.skippedCount} 題。`,
      'success',
    );
  } catch (error) {
    const message = storeErrorMessage(error);
    setLibraryTransferStatus(message, 'error');
  }
}

function saveCurrentPuzzle() {
  if (appState !== APP_STATE.PUZZLE_RECORDED || !recordedPuzzleResult || savedCurrentPuzzleId) return;
  if (!puzzleTitleInput.value.trim()) {
    setSavePuzzleMessage('請輸入題目名稱。', 'error');
    puzzleTitleInput.focus();
    return;
  }
  try {
    const saved = puzzleStore.savePuzzle({
      ...recordedPuzzleResult,
      title: puzzleTitleInput.value,
      notes: puzzleNotesInput.value,
    });
    savedCurrentPuzzleId = saved.id;
    activeSavedPuzzleId = saved.id;
    btnSavePuzzle.disabled = true;
    setSavePuzzleMessage(`已儲存「${saved.title}」。`, 'success');
    toast('題目已儲存到我的殺局。');
  } catch (error) {
    const message = storeErrorMessage(error);
    setSavePuzzleMessage(message, 'error');
    toast(message);
  }
}

function formatStoredDate(timestamp) {
  try {
    return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
  } catch {
    return timestamp;
  }
}

function appendDetailTerm(label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  libraryDetailMeta.append(term, description);
}

function renderLibraryDetail(puzzle) {
  libraryDetailTitle.textContent = puzzle.title;
  libraryDetailMeta.replaceChildren();
  appendDetailTerm('先行方', puzzle.sideToMove === RED ? '紅方' : '黑方');
  appendDetailTerm('答案長度', `${puzzle.solution.length} 著`);
  appendDetailTerm('練習次數', `${puzzle.practiceCount} 次`);
  appendDetailTerm('完成次數', `${puzzle.completedCount} 次`);
  appendDetailTerm('建立時間', formatStoredDate(puzzle.createdAt));
  appendDetailTerm('最近練習', puzzle.lastPracticedAt ? formatStoredDate(puzzle.lastPracticedAt) : '尚未練習');
  libraryDetailNotes.textContent = puzzle.notes || '沒有筆記。';
  libraryDetailSolution.replaceChildren();
  const replayBoard = puzzle.initialBoard.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
  puzzle.solution.forEach((move) => {
    const item = document.createElement('li');
    item.textContent = notation(replayBoard, move.from, move.to);
    libraryDetailSolution.appendChild(item);
    applyMove(replayBoard, move.from, move.to);
  });
  renderLibraryAnalytics(puzzle.id);
}

function appendAnalyticsTerm(label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value;
  libraryAnalyticsSummary.append(term, description);
}

function renderLibraryAnalytics(puzzleId) {
  libraryAnalyticsSummary.replaceChildren();
  libraryRecentAttempts.replaceChildren();
  try {
    const analytics = practiceAnalyticsStore.getPuzzleAnalytics(puzzleId);
    if (!analytics) {
      libraryAnalyticsStatus.textContent = '尚無練習紀錄';
      return;
    }
    libraryAnalyticsStatus.textContent = '';
    const { aggregate } = analytics;
    appendAnalyticsTerm('已記錄', `${aggregate.attemptCount} 次`);
    appendAnalyticsTerm('完成', `${aggregate.completedCount} 次`);
    appendAnalyticsTerm('中止', `${aggregate.abandonedCount} 次`);
    appendAnalyticsTerm('獨立完成', `${aggregate.cleanCompletionCount} 次`);
    appendAnalyticsTerm('累計錯誤', `${aggregate.totalMistakes} 次`);
    appendAnalyticsTerm('提示請求', `${aggregate.totalHintRequests} 次`);
    for (const attempt of analytics.recentAttempts) {
      const item = document.createElement('li');
      const outcome = attempt.outcome === 'completed' ? '完成' : '中止';
      const hint = attempt.hintRequests === 0
        ? '未使用提示'
        : `提示 ${attempt.hintRequests} 次（最高第 ${attempt.maxHintLevel} 級）`;
      item.textContent = `${outcome}・${formatStoredDate(attempt.endedAt)}・錯誤 ${attempt.mistakes}・${hint}`;
      libraryRecentAttempts.appendChild(item);
    }
  } catch (error) {
    if (!(error instanceof PracticeAnalyticsError)) throw error;
    libraryAnalyticsStatus.textContent = '練習統計目前無法讀取。';
  }
}

function createLibraryCard(puzzle) {
  const card = document.createElement('article');
  card.className = 'library-card';
  card.dataset.puzzleId = puzzle.id;
  const title = document.createElement('h3');
  title.textContent = puzzle.title;
  const meta = document.createElement('p');
  meta.className = 'library-card-meta';
  meta.textContent = `${puzzle.sideToMove === RED ? '紅方' : '黑方'}先行・${puzzle.solution.length} 著・練習 ${puzzle.practiceCount}・完成 ${puzzle.completedCount}`;
  const actions = document.createElement('div');
  actions.className = 'library-card-actions';
  for (const [action, label, className] of [
    ['view', '檢視', ''],
    ['practice', '練習', 'recorder-primary'],
    ['delete', '刪除', 'danger'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.libraryAction = action;
    button.textContent = label;
    if (className) button.className = className;
    actions.appendChild(button);
  }
  card.append(title, meta, actions);
  return card;
}

function renderLibraryList() {
  const loaded = puzzleStore.loadAll();
  libraryCount.textContent = `${loaded.puzzles.length} 題`;
  btnLibraryExportAll.disabled = loaded.puzzles.length === 0;
  libraryIssues.classList.toggle('hidden', loaded.issues.length === 0);
  libraryIssues.textContent = loaded.issues.length
    ? (loaded.issues.some((entry) => entry.code === 'STORE_READ_FAILED')
      ? '無法讀取瀏覽器儲存空間，請確認隱私設定；原有資料未變更。'
      : `有 ${loaded.issues.length} 筆資料無法讀取；有效題目仍可檢視，但題庫不會被覆寫。`)
    : '';
  libraryList.replaceChildren(...loaded.puzzles.map(createLibraryCard));
  libraryList.classList.remove('hidden');
  libraryEmpty.classList.toggle('hidden', loaded.puzzles.length > 0);
  libraryDetail.classList.add('hidden');
  return loaded;
}

function showLibraryList() {
  appState = APP_STATE.PUZZLE_LIBRARY;
  libraryViewPuzzle = null;
  activeSavedPuzzleId = null;
  clearSelection();
  buildScene();
  renderLibraryList();
  refreshHUD();
}

function openLibraryPuzzle(id) {
  const puzzle = puzzleStore.getPuzzle(id);
  if (!puzzle) {
    toast('找不到這道題目，可能已被刪除。');
    showLibraryList();
    return;
  }
  appState = APP_STATE.PUZZLE_VIEW;
  libraryViewPuzzle = puzzle;
  activeSavedPuzzleId = puzzle.id;
  libraryList.classList.add('hidden');
  libraryEmpty.classList.add('hidden');
  libraryDetail.classList.remove('hidden');
  renderLibraryDetail(puzzle);
  clearSelection();
  rebuildPieceMeshes(puzzle.initialBoard, false);
  const invariant = checkBoardMeshInvariant(puzzle.initialBoard);
  if (!invariant.ok) throw new Error(`Library board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  refreshHUD();
}

function enterLibrary(preferredId = null) {
  if (busy || (!normalGameActive() && appState !== APP_STATE.PUZZLE_RECORDED)) return;
  aiToken++;
  practiceToken++;
  aiThinking = false;
  tweens.length = 0;
  releasePhotoReference();
  clearSelection();
  appState = APP_STATE.PUZZLE_LIBRARY;
  appEl.classList.remove('editor-active');
  appEl.classList.add('library-active');
  editorPanel.classList.add('hidden');
  recorderPanel.classList.add('hidden');
  libraryPanel.classList.remove('hidden');
  banner.classList.add('hidden');
  clearPendingPuzzleImport({ clearStatus: true });
  renderLibraryList();
  const id = preferredId || savedCurrentPuzzleId;
  if (id) openLibraryPuzzle(id);
  else {
    buildScene();
    refreshHUD();
  }
}

function deleteStoredPuzzle(id) {
  const puzzle = puzzleStore.getPuzzle(id);
  if (!puzzle) {
    showLibraryList();
    return;
  }
  if (!window.confirm(`確定要刪除「${puzzle.title}」嗎？此操作無法復原。`)) return;
  try {
    if (!puzzleStore.deletePuzzle(id)) return;
    if (savedCurrentPuzzleId === id) savedCurrentPuzzleId = null;
    let analyticsWarning = false;
    try {
      practiceAnalyticsStore.deletePuzzleAnalytics(id);
    } catch (error) {
      if (!(error instanceof PracticeAnalyticsError)) throw error;
      analyticsWarning = true;
    }
    showLibraryList();
    if (analyticsWarning) {
      libraryIssues.textContent = '題目已刪除，但練習統計目前無法清除。';
      libraryIssues.classList.remove('hidden');
      toast('題目已刪除；練習統計清除失敗。');
    } else {
      toast('題目已刪除。');
    }
  } catch (error) {
    const message = storeErrorMessage(error);
    libraryIssues.textContent = message;
    libraryIssues.classList.remove('hidden');
    toast(message);
  }
}

function markPracticeStarted(id) {
  if (!id) return true;
  try {
    return !!puzzleStore.markPracticeStarted(id);
  } catch (error) {
    toast(storeErrorMessage(error));
    return false;
  }
}

function markPracticeCompleted(id) {
  if (!id || practiceCompletionRecorded) return;
  try {
    puzzleStore.markPracticeCompleted(id);
    practiceCompletionRecorded = true;
  } catch (error) {
    toast(storeErrorMessage(error));
  }
}

function beginPracticeAttempt(puzzleId) {
  practiceAttempt = null;
  if (!puzzleId) return;
  let startedAt;
  try {
    startedAt = practiceAnalyticsStore.now();
  } catch {
    return;
  }
  practiceAttempt = { puzzleId, startedAt, hintRequests: 0, maxHintLevel: 0 };
}

function recordPracticeHintRequest(level) {
  if (!practiceAttempt) return;
  practiceAttempt.hintRequests += 1;
  practiceAttempt.maxHintLevel = Math.max(practiceAttempt.maxHintLevel, level);
}

function finalizePracticeAttempt(outcome) {
  const attempt = practiceAttempt;
  practiceAttempt = null;
  if (!attempt) return false;
  try {
    const endedAt = practiceAnalyticsStore.now();
    practiceAnalyticsStore.recordAttempt({
      ...attempt,
      endedAt,
      outcome,
      mistakes: practiceState?.mistakes ?? 0,
    });
    return true;
  } catch (error) {
    toast('練習已繼續，但本次練習統計無法儲存。');
    return false;
  }
}

function selectRecorderPiece(r, c) {
  clearSelection();
  selected = { r, c };
  legal = legalMoves(recorderState.board, r, c);
  showSelectRingAt(selected);
  if (legal.length) showMoveDots(legal, recorderState.board);
  sfx.select();
  refreshHUD();
}

function finishRecorderMove(captured) {
  if (captured) sfx.capture(); else sfx.move();
  busy = false;
  const invariant = checkBoardMeshInvariant(recorderState.board);
  if (!invariant.ok) throw new Error(`Recorder board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  setRecorderMessage('著法已記錄。');
  syncRecorderUI();
  refreshHUD();
}

function doRecorderMove(from, to) {
  let next;
  try {
    next = recordMove(recorderState, from, to);
  } catch (error) {
    if (!(error instanceof PuzzleRecorderError)) throw error;
    const message = error.code === 'WRONG_SIDE' ? '請選擇目前行棋方的棋子。' : '此著不合法，棋盤未變更。';
    setRecorderMessage(message, 'error');
    toast(message);
    return;
  }
  const moving = pieceAt(from.r, from.c);
  const capturedMesh = pieceAt(to.r, to.c);
  const captured = next.records[next.records.length - 1].captured;
  recorderState = next;
  clearSelection();
  busy = true;
  moving.userData.r = to.r;
  moving.userData.c = to.c;
  moving.userData.piece = recorderState.board[to.r][to.c];
  const start = moving.position.clone();
  const end = to3D(to.r, to.c);
  tween(260, (k) => {
    moving.position.x = start.x + (end.x - start.x) * k;
    moving.position.z = start.z + (end.z - start.z) * k;
    moving.position.y = Y0 + Math.sin(Math.PI * k) * 0.65;
  }, () => {
    moving.position.y = Y0;
    if (capturedMesh) {
      releasePieceMesh(capturedMesh);
      pieces = pieces.filter((piece) => piece !== capturedMesh);
    }
    finishRecorderMove(captured);
  });
  syncRecorderUI();
  refreshHUD();
}

function handleRecorderBoardClick(hit) {
  if (!hit) { clearSelection(); refreshHUD(); return; }
  const coordinate = hit.userData?.piece
    ? { r: hit.userData.r, c: hit.userData.c }
    : { r: hit.r, c: hit.c };
  const piece = recorderState.board[coordinate.r][coordinate.c];
  if (selected && legal.some((move) => move.r === coordinate.r && move.c === coordinate.c)) {
    doRecorderMove(selected, coordinate);
    return;
  }
  if (piece) {
    if (piece.side !== recorderState.currentSide) {
      const message = '請選擇目前行棋方的棋子。';
      setRecorderMessage(message, 'error');
      toast(message);
      return;
    }
    if (selected && selected.r === coordinate.r && selected.c === coordinate.c) {
      clearSelection();
      refreshHUD();
      return;
    }
    selectRecorderPiece(coordinate.r, coordinate.c);
    setRecorderMessage('已選取棋子，請選擇合法落點。');
    return;
  }
  if (selected) {
    const message = '此著不合法，棋盤未變更。';
    setRecorderMessage(message, 'error');
    toast(message);
  }
  clearSelection();
  refreshHUD();
}

function syncPracticeScene() {
  tweens.length = 0;
  rebuildPieceMeshes(practiceState.currentBoard, false);
  const invariant = checkBoardMeshInvariant(practiceState.currentBoard);
  if (!invariant.ok) throw new Error(`Practice board/mesh invariant failed: ${invariant.errors.join(' ')}`);
}

function startPractice() {
  if (appState !== APP_STATE.PUZZLE_RECORDED || !recordedPuzzleResult || busy) return;
  try {
    practiceState = createPractice(recordedPuzzleResult);
  } catch (error) {
    if (!(error instanceof PuzzlePracticeError)) throw error;
    const message = `無法開始練習：${error.message}`;
    setRecorderMessage(message, 'error');
    toast(message);
    return;
  }
  const savedId = savedCurrentPuzzleId;
  if (savedId && !markPracticeStarted(savedId)) return;
  activeSavedPuzzleId = savedId;
  beginPracticeAttempt(savedId);
  practiceReturnState = 'recorded';
  practiceCompletionRecorded = false;
  practiceToken++;
  appState = APP_STATE.PUZZLE_PRACTICING;
  clearSelection();
  clearPracticeHint();
  setPracticeMessage('請走出本題的第一步。');
  syncPracticeScene();
  syncRecorderUI();
  refreshHUD();
}

function startSavedPractice(id) {
  const puzzle = puzzleStore.getPuzzle(id);
  if (!puzzle || busy) {
    if (!puzzle) toast('找不到這道題目，可能已被刪除。');
    return;
  }
  let nextPractice;
  try {
    nextPractice = createPractice(puzzle);
  } catch (error) {
    if (!(error instanceof PuzzlePracticeError)) throw error;
    toast(`無法開始練習：${error.message}`);
    return;
  }
  if (!markPracticeStarted(id)) return;
  practiceState = nextPractice;
  practiceToken++;
  practiceReturnState = 'library';
  practiceCompletionRecorded = false;
  activeSavedPuzzleId = id;
  beginPracticeAttempt(id);
  libraryViewPuzzle = puzzle;
  appState = APP_STATE.PUZZLE_PRACTICING;
  appEl.classList.remove('library-active');
  appEl.classList.add('editor-active');
  libraryPanel.classList.add('hidden');
  editorPanel.classList.remove('hidden');
  clearSelection();
  clearPracticeHint();
  setPracticeMessage('請走出本題的第一步。');
  syncPracticeScene();
  syncRecorderUI();
  refreshHUD();
}

function restartCurrentPractice() {
  if (!practiceState) return;
  finalizePracticeAttempt('abandoned');
  if (activeSavedPuzzleId && !markPracticeStarted(activeSavedPuzzleId)) return;
  practiceToken++;
  tweens.length = 0;
  busy = false;
  practiceState = restartPractice(practiceState);
  beginPracticeAttempt(activeSavedPuzzleId);
  practiceCompletionRecorded = false;
  appState = APP_STATE.PUZZLE_PRACTICING;
  clearSelection();
  clearPracticeHint();
  syncPracticeScene();
  setPracticeMessage('已回到原始局面，請重新開始。');
  syncRecorderUI();
  refreshHUD();
}

function exitPractice() {
  if (!practiceActive()) return;
  if (practiceState?.status === 'practicing') finalizePracticeAttempt('abandoned');
  practiceToken++;
  tweens.length = 0;
  busy = false;
  clearPracticeHint();
  practiceState = null;
  if (practiceReturnState === 'library') {
    const returnId = activeSavedPuzzleId;
    appState = APP_STATE.PUZZLE_LIBRARY;
    appEl.classList.remove('editor-active');
    appEl.classList.add('library-active');
    editorPanel.classList.add('hidden');
    recorderPanel.classList.add('hidden');
    libraryPanel.classList.remove('hidden');
    renderLibraryList();
    openLibraryPuzzle(returnId);
    return;
  }
  if (!recorderState) return;
  appState = APP_STATE.PUZZLE_RECORDED;
  clearSelection();
  syncRecorderScene();
  const invariant = checkBoardMeshInvariant(recorderState.board);
  if (!invariant.ok) throw new Error(`Recorder board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  setRecorderMessage('答案有效：已形成將死', 'success');
  syncRecorderUI();
  refreshHUD();
}

function selectPracticePiece(r, c) {
  clearSelection();
  selected = { r, c };
  legal = legalMoves(practiceState.currentBoard, r, c);
  showSelectRingAt(selected);
  if (legal.length) showMoveDots(legal, practiceState.currentBoard);
  sfx.select();
  refreshHUD();
}

function completePractice() {
  appState = APP_STATE.PUZZLE_PRACTICE_COMPLETE;
  busy = false;
  clearSelection();
  clearPracticeHint();
  const invariant = checkBoardMeshInvariant(practiceState.currentBoard);
  if (!invariant.ok) throw new Error(`Practice board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  markPracticeCompleted(activeSavedPuzzleId);
  finalizePracticeAttempt('completed');
  setPracticeMessage('完成！成功走出本題殺局', 'success');
  syncRecorderUI();
  refreshHUD();
  toast('完成！成功走出本題殺局');
}

function afterPracticeMove() {
  const invariant = checkBoardMeshInvariant(practiceState.currentBoard);
  if (!invariant.ok) throw new Error(`Practice board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  if (practiceState.status === 'complete') {
    completePractice();
    return;
  }
  if (practiceState.currentSide !== practiceState.practiceSide) {
    queueOpponentReply();
    return;
  }
  busy = false;
  setPracticeMessage('回答正確，請走下一步。', 'success');
  syncRecorderUI();
  refreshHUD();
}

function animatePracticeMove(result) {
  const { from, to } = result.move;
  const moving = pieceAt(from.r, from.c);
  const capturedMesh = pieceAt(to.r, to.c);
  if (!moving) throw new Error(`Practice move has no mesh at ${from.r},${from.c}.`);
  clearSelection();
  busy = true;
  moving.userData.r = to.r;
  moving.userData.c = to.c;
  moving.userData.piece = practiceState.currentBoard[to.r][to.c];
  const start = moving.position.clone();
  const end = to3D(to.r, to.c);
  tween(260, (k) => {
    moving.position.x = start.x + (end.x - start.x) * k;
    moving.position.z = start.z + (end.z - start.z) * k;
    moving.position.y = Y0 + Math.sin(Math.PI * k) * 0.65;
  }, () => {
    moving.position.y = Y0;
    if (capturedMesh) {
      releasePieceMesh(capturedMesh);
      pieces = pieces.filter((piece) => piece !== capturedMesh);
    }
    if (result.captured) sfx.capture(); else sfx.move();
    afterPracticeMove();
  });
  syncRecorderUI();
  refreshHUD();
}

function queueOpponentReply() {
  const token = practiceToken;
  busy = true;
  setPracticeMessage('對手依照錄製答案回應中…');
  syncRecorderUI();
  refreshHUD();
  setTimeout(() => {
    if (token !== practiceToken || appState !== APP_STATE.PUZZLE_PRACTICING) return;
    try {
      const result = applyOpponentReply(practiceState);
      practiceState = result.practice;
      animatePracticeMove(result);
    } catch (error) {
      if (!(error instanceof PuzzlePracticeError)) throw error;
      busy = false;
      const message = '題目資料不一致，已停止自動回應。';
      setPracticeMessage(message, 'error');
      syncRecorderUI();
      refreshHUD();
      toast(message);
    }
  }, 420);
}

function doPracticeMove(from, to) {
  const result = attemptPracticeMove(practiceState, from, to);
  practiceState = result.practice;
  if (!result.ok) {
    const messages = {
      WRONG_MOVE: '這一步不是本題答案，再試一次。',
      WRONG_SIDE: '練習時只能操作指定一方。',
      ILLEGAL_MOVE: '此著不合法，棋盤未變更。',
      EMPTY_SOURCE: '請選擇自己的棋子。',
      NOT_USER_TURN: '請等待對手回應完成。',
    };
    const message = messages[result.error.code] || result.error.message;
    clearSelection();
    setPracticeMessage(message, 'error');
    syncRecorderUI();
    refreshHUD();
    toast(message);
    return;
  }
  clearPracticeHint();
  setPracticeMessage('回答正確。', 'success');
  animatePracticeMove(result);
}

function handlePracticeBoardClick(hit) {
  if (!hit) {
    if (selected) setPracticeMessage('此著不合法，棋盤未變更。', 'error');
    clearSelection();
    refreshHUD();
    return;
  }
  const coordinate = hit.userData?.piece
    ? { r: hit.userData.r, c: hit.userData.c }
    : { r: hit.r, c: hit.c };
  const piece = practiceState.currentBoard[coordinate.r][coordinate.c];

  if (selected && legal.some((move) => move.r === coordinate.r && move.c === coordinate.c)) {
    doPracticeMove(selected, coordinate);
    return;
  }
  if (piece) {
    if (piece.side !== practiceState.practiceSide) {
      const message = '練習時只能操作指定一方。';
      setPracticeMessage(message, 'error');
      toast(message);
      return;
    }
    if (selected && selected.r === coordinate.r && selected.c === coordinate.c) {
      clearSelection();
      refreshHUD();
      return;
    }
    selectPracticePiece(coordinate.r, coordinate.c);
    setPracticeMessage('已選取棋子，請走出本題答案。');
    return;
  }
  if (selected) {
    const message = '此著不合法，棋盤未變更。';
    setPracticeMessage(message, 'error');
    toast(message);
  }
  clearSelection();
  refreshHUD();
}

function newGame() {
  if (!normalGameActive()) return;
  tweens.length = 0;
  aiToken++;
  aiThinking = false;
  history = [];
  capturedBy = { [RED]: [], [BLACK]: [] };
  over = false;
  winner = null;
  busy = false;
  board = initialBoard();
  turn = RED;
  posHistory = [hashBoard(board)];
  repHistory = [{ key: hashBoard(board) + '|' + turn, mover: null, check: false }];
  beginNormalGameRecordSession();
  gameStartTime = Date.now();
  undoCount = 0;
  stopConfetti();
  overlay.classList.add('hidden');
  banner.classList.add('hidden');
  logEl.innerHTML = '';
  logEmpty.style.display = '';
  syncLastMoveMark();
  buildScene();
  refreshHUD();
}

/** 測試用：直接佈局 */
function resetTo(customBoard, turnSide) {
  tweens.length = 0;
  aiToken++;
  aiThinking = false;
  board = customBoard;
  if (turnSide) turn = turnSide;
  posHistory = [hashBoard(board)];
  repHistory = [{ key: hashBoard(board) + '|' + turn, mover: null, check: false }];
  beginNormalGameRecordSession();
  history = [];
  capturedBy = { [RED]: [], [BLACK]: [] };
  over = false;
  winner = null;
  busy = false;
  gameStartTime = Date.now();
  undoCount = 0;
  stopConfetti();
  overlay.classList.add('hidden');
  banner.classList.add('hidden');
  logEl.innerHTML = '';
  logEmpty.style.display = '';
  syncLastMoveMark();
  buildScene();
  refreshHUD();
}

function animateCapture(m, done) {
  const y0 = m.position.y;
  const s0 = m.scale.x;
  tween(280, (k) => {
    const s = Math.max(0.06, s0 * (1 - 0.92 * k));
    m.scale.set(s, s, s);
    m.position.y = y0 * (1 - k) + 0.02;
    m.rotation.y = k * 1.1;
  }, done);
}

function doMove(from, to) {
  if (!normalGameActive()) return;
  const gameRecordSessionId = normalGameRecordSession?.id ?? null;
  const p = pieceAt(from.r, from.c);
  const cap = pieceAt(to.r, to.c);
  const captured = board[to.r][to.c];
  const nota = notation(board, from, to);
  applyMove(board, from, to);
  p.userData.r = to.r;
  p.userData.c = to.c;
  history.push({ from, to, captured, nota });
  posHistory.push(hashBoard(board));
  syncLastMoveMark();
  clearSelection();
  busy = true;
  refreshHUD();

  sfx.move();
  const from3 = p.position.clone();
  const to3 = to3D(to.r, to.c);
  tween(340, (k) => {
    p.position.lerpVectors(from3, to3, k);
    p.position.y = Y0 + Math.sin(Math.PI * k) * 0.55;
  }, () => {
    if (cap) {
      sfx.capture();
      animateCapture(cap, () => {
        releasePieceMesh(cap);
        const i = pieces.indexOf(cap);
        if (i >= 0) pieces.splice(i, 1);
        finishMove(nota, captured, gameRecordSessionId);
      });
    } else {
      finishMove(nota, captured, gameRecordSessionId);
    }
  });
}

function finishMove(nota, captured, gameRecordSessionId = normalGameRecordSession?.id) {
  if (over || gameRecordSessionId !== normalGameRecordSession?.id) return;
  const invariant = checkBoardMeshInvariant(board);
  if (!invariant.ok) throw new Error(`Normal board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  if (captured) capturedBy[turn].push(captured);
  addLog(nota, turn);
  const mover = turn;
  turn = turn === RED ? BLACK : RED;
  busy = false;

  const checked = inCheck(board, turn);
  const has = hasAnyLegalMove(board, turn);
  repHistory.push({ key: hashBoard(board) + '|' + turn, mover, check: checked });

  let endReason = null; // '將死' | '困斃' | '長將' | '三次重複局面' | '雙方長將'
  if (!has) {
    over = true;
    winner = turn === RED ? BLACK : RED;
    endReason = checked ? '將死' : '困斃';
  } else {
    // 長將判負／三次重複局面判和
    const verdict = repetitionVerdict(repHistory, repHistory[repHistory.length - 1].key);
    if (verdict) {
      over = true;
      if (verdict.result === 'loss') {
        winner = verdict.loser === RED ? BLACK : RED;
        endReason = '長將';
      } else {
        winner = null;
        endReason = verdict.reason;
      }
    }
  }
  if (checked) {
    sfx.check();
    showBanner();
  }
  if (over) {
    finalizeNormalGameRecord(endReason);
    refreshHUD();
    const token = aiToken;
    setTimeout(() => {
      if (token === aiToken && normalGameActive() && over) showGameOver(endReason);
    }, endReason === '將死' ? 900 : 300);
  }
  refreshHUD();
  maybeAIMove();
}

function cloneNormalGameRecordBoard(source) {
  return Object.freeze(source.map((row) => Object.freeze(row.map((piece) => (
    piece === null ? null : Object.freeze({ type: piece.type, side: piece.side })
  )))));
}

function beginNormalGameRecordSession() {
  const createdAt = gameRecordNow();
  normalGameRecordSession = Object.freeze({
    id: gameRecordIdFactory(),
    createdAt,
    initialPosition: Object.freeze({
      board: cloneNormalGameRecordBoard(board),
      sideToMove: turn,
    }),
    mode,
  });
  completedGameRecordSessionId = null;
}

function normalGameRecordTerminationReason(endReason) {
  if (endReason === '將死') return 'checkmate';
  if (endReason === '困斃') return 'stalemate';
  if (endReason === '長將') return 'perpetual-check';
  if (endReason === '三次重複局面') return 'threefold-repetition';
  if (endReason === '雙方長將') return 'mutual-perpetual-check';
  throw new Error(`Unsupported normal-game termination reason: ${endReason}`);
}

function finalizeNormalGameRecord(endReason) {
  const session = normalGameRecordSession;
  if (!over || !session || completedGameRecordSessionId === session.id) {
    return lastCompletedGameRecord;
  }
  const observedCompletedAt = gameRecordNow();
  const completedAt = observedCompletedAt < session.createdAt
    ? session.createdAt
    : observedCompletedAt;
  let record;
  try {
    record = createGameRecord({
      schemaVersion: 1,
      id: session.id,
      createdAt: session.createdAt,
      completedAt,
      initialPosition: session.initialPosition,
      moves: history.map(({ from, to }) => ({
        from: { r: from.r, c: from.c },
        to: { r: to.r, c: to.c },
      })),
      mode: session.mode,
      result: {
        winner,
        terminationReason: normalGameRecordTerminationReason(endReason),
      },
    });
  } catch {
    return null;
  }

  completedGameRecordSessionId = session.id;
  lastCompletedGameRecord = record;
  try {
    gameRecordStore.saveGameRecord(record);
  } catch {
    // Persistence is secondary. The canonical terminal state and immutable
    // in-memory record remain valid, with no retry loop.
  }
  return record;
}

function showBanner() {
  banner.classList.remove('hidden');
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => banner.classList.add('hidden'), 1500);
}

function undoPly() {
  const h = history.pop();
  posHistory.pop();
  repHistory.pop();
  const p = pieceAt(h.to.r, h.to.c);
  applyMove(board, h.to, h.from);
  p.userData.r = h.from.r;
  p.userData.c = h.from.c;
  const pos = to3D(h.from.r, h.from.c);
  p.position.set(pos.x, Y0, pos.z);
  if (h.captured) {
    board[h.to.r][h.to.c] = h.captured; // 被吃的子也要放回邏輯棋盤，不能只復原 mesh
    const cm = makePiece(h.captured, h.to.r, h.to.c);
    pieces.push(cm);
    scene.add(cm);
    capturedBy[turn === RED ? BLACK : RED].pop();
  }
  turn = turn === RED ? BLACK : RED;
  const invariant = checkBoardMeshInvariant(board);
  if (!invariant.ok) throw new Error(`Undo board/mesh invariant failed: ${invariant.errors.join(' ')}`);
}

function normalUndoAvailable() {
  return normalGameActive() && history.length > 0 && !busy && !aiThinking && !over;
}

function undo() {
  if (!normalUndoAvailable()) return;
  undoCount++;
  aiToken++; // 作廢進行中的 AI 計算
  undoPly();
  // 人機模式：連 AI 那一步一起退，回到玩家回合
  if (isAI() && turn === AI_SIDE && history.length) undoPly();
  addLog('悔棋', turn);
  stopConfetti();
  overlay.classList.add('hidden');
  clearSelection();
  syncLastMoveMark();
  refreshHUD();
}

// ---------------- 輸入 ----------------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  // 1) 先找棋子
  const hits = ray.intersectObjects(pieces, false);
  const obj = hits.length ? hits[0].object : null;
  if (obj && obj.userData.piece) return obj;
  // 2) 再找盤面，吸附到最近的交叉點
  const bh = ray.intersectObject(boardMesh, false);
  if (bh.length) {
    const p = bh[0].point;
    let best = null, bestD = 0.5 * 0.5;
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        const q = to3D(r, c);
        const dx = p.x - q.x, dz = p.z - q.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; best = { r, c }; }
      }
    if (best) return best;
  }
  return null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (gameRecordFlowActive() && appState !== APP_STATE.GAME_ANALYSIS) {
    renderer.domElement.style.cursor = viewLocked ? 'default' : 'grab';
    return;
  }
  const hit = pick(e);
  renderer.domElement.style.cursor = hit ? 'pointer' : (viewLocked ? 'default' : 'grab');
});

let downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
// 拖曳／滾輪結束後記住視角（個人化，存瀏覽器）
renderer.domElement.addEventListener('pointerup', queueSaveViewPrefs);
renderer.domElement.addEventListener('wheel', queueSaveViewPrefs, { passive: true });

renderer.domElement.addEventListener('click', (e) => {
  if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 8) {
    downXY = null; // 拖曳旋轉視角後產生的 click，忽略
    return;
  }
  downXY = null;
  if (appState === APP_STATE.GAME_RECORD_LIBRARY || appState === APP_STATE.GAME_REVIEW) return;
  const hit = pick(e);
  if (appState === APP_STATE.GAME_ANALYSIS) {
    handleGameAnalysisBoardClick(hit);
    return;
  }
  if (appState === APP_STATE.PUZZLE_PRACTICING) {
    if (!busy && practiceState.currentSide === practiceState.practiceSide) handlePracticeBoardClick(hit);
    return;
  }
  if (appState === APP_STATE.PUZZLE_PRACTICE_COMPLETE) return;
  if (appState === APP_STATE.PUZZLE_RECORDING) {
    if (!busy) handleRecorderBoardClick(hit);
    return;
  }
  if (appState === APP_STATE.PUZZLE_RECORDED) return;
  if (libraryActive()) return;
  if (authoringActive()) {
    handleEditorBoardClick(hit);
    return;
  }
  if (busy || over || aiThinking || (isAI() && turn === AI_SIDE)) return;
  if (!hit) { clearSelection(); refreshHUD(); return; }

  // 點到棋子
  if (hit.userData && hit.userData.piece) {
    const { r, c, piece } = hit.userData;
    if (piece.side !== turn) {
      // 敵子：若為合法目標則執行
      if (selected && legal.some((m) => m.r === r && m.c === c)) doMove(selected, { r, c });
      return;
    }
    if (selected && selected.r === r && selected.c === c) { clearSelection(); refreshHUD(); return; }
    select(r, c);
    return;
  }

  // 點到空交叉點：合法則走，否則取消選中
  const { r, c } = hit;
  if (selected && legal.some((m) => m.r === r && m.c === c)) {
    doMove(selected, { r, c });
  } else {
    clearSelection();
  }
  refreshHUD();
});

// ---------------- 終局畫面 / 彩帶 / 分享 ----------------
const SITE_URL = 'https://robinlee0929.github.io/chinese-chess-training/';
const DIFF = {
  easy:   { label: '簡單', stars: 1, winTitle: '旗開得勝！', winSub: '小試身手就拿下 AI，好的開始！' },
  medium: { label: '中等', stars: 2, winTitle: '運籌帷幄！', winSub: '攻守有度，中等 AI 也不是你的對手！' },
  hard:   { label: '困難', stars: 3, winTitle: '棋壇霸主！', winSub: '深算遠謀，最強 AI 也俯首稱臣！' },
};

const ovCard = document.getElementById('ovCard');
const ovBadge = document.getElementById('ovBadge');
const ovTitle = document.getElementById('ovTitle');
const ovStars = document.getElementById('ovStars');
const ovSub = document.getElementById('ovSub');
const ovReason = document.getElementById('ovReason');
const stRounds = document.getElementById('stRounds');
const stTime = document.getElementById('stTime');
const stCaps = document.getElementById('stCaps');
const stUndo = document.getElementById('stUndo');
const btnShare = document.getElementById('btnShare');
const toastEl = document.getElementById('toast');
let lastResult = null;

const fmtTime = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3600);
}

function showGameOver(endReason) {
  const pvp = !isAI();
  const draw = winner == null;
  const playerWin = !pvp && !draw && winner !== AI_SIDE;
  const d = pvp ? null : DIFF[mode];
  const plies = Math.max(1, history.length); // 棋譜著法數
  const secs = Math.max(1, Math.round((Date.now() - gameStartTime) / 1000));
  const caps = pvp ? capturedBy[winner ?? RED].length : capturedBy[RED].length;
  const pure = undoCount === 0; // 全程零悔棋：純度勳章
  const reasonChars = draw ? '和棋' : endReason; // 戰績卡紅印：將死/困斃/長將/和棋
  const winLabel = winner === RED ? '紅方' : '黑方';
  const celebrate = !draw && (pvp || playerWin);

  let title, sub, badge, cardTitle, cardSub, shareText;
  if (draw) {
    title = '和局';
    sub = pvp ? '棋逢敵手，握手言和！' : '勢均力敵，不分勝負！';
    badge = pvp ? '雙人對弈' : `人機對弈 ・ ${d.label}`;
    cardTitle = '和局';
    cardSub = `${pvp ? '雙人對弈' : `「${d.label}」AI`} ・ 鏖戰 ${plies} 著${pure ? ' ・ 零悔棋' : ''}`;
    shareText = `我們在 3D 中國象棋鏖戰 ${plies} 著，弈和不分勝負！來對弈一局：${SITE_URL}`;
  } else if (pvp) {
    title = `${winLabel}勝`;
    sub = '棋逢敵手，精彩對弈！';
    badge = '雙人對弈';
    cardTitle = `${winLabel}勝出`;
    cardSub = `雙人對弈 ・ 鏖戰 ${plies} 著${pure ? ' ・ 零悔棋' : ''}`;
    shareText = `我們在 3D 中國象棋鏖戰 ${plies} 著，${winLabel}獲勝！來對弈一局：${SITE_URL}`;
  } else if (playerWin) {
    title = d.winTitle;
    sub = d.winSub;
    badge = `人機對弈 ・ ${d.label}`;
    cardTitle = d.winTitle.replace('！', '');
    cardSub = `戰勝「${d.label}」AI ・ ${plies} 著${pure ? ' ・ 零悔棋' : ''}`;
    shareText = pure
      ? `我在 3D 中國象棋全程零悔棋、${plies} 著戰勝「${d.label}」AI 🏆 不服來戰：${SITE_URL}`
      : `我在 3D 中國象棋以 ${plies} 著戰勝「${d.label}」AI 🏆 不服來戰：${SITE_URL}`;
  } else {
    title = '惜敗…';
    sub = '勝敗乃兵家常事，捲土重來！';
    badge = `人機對弈 ・ ${d.label}`;
  }

  lastResult = { pvp, playerWin, draw, d, plies, secs, caps, undoCount, pure, reasonChars, cardTitle, cardSub, shareText };

  ovBadge.textContent = badge;
  ovTitle.textContent = title;
  ovSub.textContent = sub;
  if (d && !draw) {
    ovStars.innerHTML = [1, 2, 3].map((i) =>
      `<span class="${i <= d.stars ? 'on' : ''}" style="animation-delay:${0.2 + i * 0.14}s">★</span>`
    ).join('');
    ovStars.style.display = '';
  } else {
    ovStars.style.display = 'none';
  }
  stRounds.textContent = plies;
  stTime.textContent = fmtTime(secs);
  stCaps.textContent = caps;
  stUndo.textContent = undoCount;
  stUndo.classList.toggle('pure', pure);
  ovReason.textContent = draw
    ? `${endReason}，判和`
    : endReason === '長將'
      ? (celebrate ? '對方「長將」判負' : '「長將」判負')
      : (celebrate ? `以「${reasonChars}」取勝` : `遭「${reasonChars}」落敗`);
  ovCard.classList.toggle('win', celebrate);
  ovCard.classList.toggle('lose', !celebrate && !draw);
  btnShare.style.display = celebrate ? '' : 'none';
  btnReviewGame.classList.toggle('hidden', !lastCompletedGameRecord);
  overlay.classList.remove('hidden');
  if (celebrate) {
    sfx.win();
    startConfetti();
  } else {
    stopConfetti();
    if (!draw) sfx.lose();
  }
}

// ----- 彩帶 -----
const confettiCv = document.getElementById('confettiCv');
const CONF_COLORS = ['#f2c14e', '#e2736a', '#e9decb', '#d9a441', '#c05345', '#9fd68f'];
let confettiRAF = 0;

// rAF 在分頁進背景時會暫停，不能靠迴圈自己收尾；關閉 overlay 時須主動停止並清空
function stopConfetti() {
  cancelAnimationFrame(confettiRAF);
  confettiCv.getContext('2d').clearRect(0, 0, confettiCv.width, confettiCv.height);
}

function startConfetti() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = confettiCv.width = confettiCv.clientWidth * dpr;
  const h = confettiCv.height = confettiCv.clientHeight * dpr;
  const g = confettiCv.getContext('2d');
  const spawn = (initial) => ({
    x: Math.random() * w,
    y: initial ? Math.random() * h * 2 - h : -20 * dpr, // 開場一半灑在畫面內、一半自上方落下
    w: (5 + Math.random() * 6) * dpr,
    h: (8 + Math.random() * 9) * dpr,
    vx: (-0.6 + Math.random() * 1.2) * dpr,
    vy: (1.4 + Math.random() * 2.4) * dpr,
    rot: Math.random() * Math.PI,
    vr: -0.12 + Math.random() * 0.24,
    sway: Math.random() * Math.PI * 2,
    color: CONF_COLORS[(Math.random() * CONF_COLORS.length) | 0],
  });
  const parts = Array.from({ length: 130 }, () => spawn(true));
  cancelAnimationFrame(confettiRAF);
  const step = () => {
    if (overlay.classList.contains('hidden')) { g.clearRect(0, 0, w, h); return; }
    g.clearRect(0, 0, w, h);
    for (const p of parts) {
      p.sway += 0.05;
      p.x += p.vx + Math.sin(p.sway) * 0.9 * dpr;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > h + 24 * dpr) Object.assign(p, spawn(false));
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      g.globalAlpha = 0.6 + Math.abs(Math.sin(p.sway)) * 0.4; // 翻面時明暗變化
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.restore();
    }
    confettiRAF = requestAnimationFrame(step);
  };
  confettiRAF = requestAnimationFrame(step);
}

// ----- 戰績卡（分享圖）-----
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

async function buildShareCard(res) {
  const W = 1080, H = 1350;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const serif = '"Kaiti SC","STKaiti","KaiTi","Noto Serif TC",serif';
  const sans = '"PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif';

  // 底色 + 雙線描金外框
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#261c12');
  bg.addColorStop(1, '#120e09');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(217,164,65,0.4)';
  g.lineWidth = 3;
  g.strokeRect(30, 30, W - 60, H - 60);
  g.strokeStyle = 'rgba(217,164,65,0.16)';
  g.lineWidth = 1;
  g.strokeRect(44, 44, W - 88, H - 88);

  g.textAlign = 'center';
  g.fillStyle = '#9a8a74';
  g.font = `600 30px ${sans}`;
  g.fillText('中 國 象 棋 ・ 3 D 對 弈', W / 2, 118);

  g.fillStyle = '#f2c14e';
  g.shadowColor = 'rgba(242,193,78,0.45)';
  g.shadowBlur = 28;
  g.font = `900 96px ${serif}`;
  g.fillText(res.cardTitle, W / 2, 236);
  g.shadowBlur = 0;

  const starStr = res.d ? '★'.repeat(res.d.stars) + '☆'.repeat(3 - res.d.stars) + '　' : '';
  g.fillStyle = '#d9a441';
  g.font = `700 40px ${sans}`;
  g.fillText(`${starStr}${res.cardSub}`, W / 2, 306);

  // 終局棋盤：WebGL 緩衝在 present 後即失效，須重繪後立即 drawImage
  const bx = 90, by = 344, bw = 900, bh = 656;
  g.save();
  roundRectPath(g, bx, by, bw, bh, 22);
  g.clip();
  renderer.render(scene, camera);
  const shot = renderer.domElement;
  const sc = Math.max(bw / shot.width, bh / shot.height);
  const sw = bw / sc, sh = bh / sc;
  g.drawImage(shot, (shot.width - sw) / 2, (shot.height - sh) / 2, sw, sh, bx, by, bw, bh);
  g.restore();
  roundRectPath(g, bx, by, bw, bh, 22);
  g.strokeStyle = 'rgba(217,164,65,0.5)';
  g.lineWidth = 3;
  g.stroke();

  // 紅印：將死 / 困斃
  g.save();
  g.translate(bx + bw - 92, by + bh - 92);
  g.rotate(-0.1);
  const ss = 150;
  g.fillStyle = 'rgba(179,44,32,0.94)';
  roundRectPath(g, -ss / 2, -ss / 2, ss, ss, 14);
  g.fill();
  g.strokeStyle = 'rgba(245,233,214,0.85)';
  g.lineWidth = 4;
  roundRectPath(g, -ss / 2 + 9, -ss / 2 + 9, ss - 18, ss - 18, 8);
  g.stroke();
  g.fillStyle = '#f5e9d6';
  g.font = `900 56px ${serif}`;
  g.textBaseline = 'middle';
  g.fillText(res.reasonChars[0], 0, -33);
  g.fillText(res.reasonChars[1], 0, 35);
  g.restore();
  g.textBaseline = 'alphabetic';

  // 戰績統計
  g.strokeStyle = 'rgba(217,164,65,0.25)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(120, 1052);
  g.lineTo(W - 120, 1052);
  g.stroke();
  const stats = [
    [String(res.plies), '著法', false],
    [fmtTime(res.secs), '用時', false],
    [String(res.caps), '吃子', false],
    [String(res.undoCount), '悔棋', res.pure], // 零悔棋以金色高亮
  ];
  stats.forEach(([v, l, hi], i) => {
    const x = W / 2 + (i - 1.5) * 236;
    g.fillStyle = hi ? '#f2c14e' : '#e9decb';
    g.font = `800 64px ${sans}`;
    g.fillText(v, x, 1148);
    g.fillStyle = '#9a8a74';
    g.font = `600 26px ${sans}`;
    g.fillText(l, x, 1194);
  });

  g.fillStyle = '#d9a441';
  g.font = `700 34px ${sans}`;
  g.fillText('不 服 來 戰', W / 2, 1262);
  g.fillStyle = '#9a8a74';
  g.font = `500 28px ${sans}`;
  g.fillText('robinlee0929.github.io/chinese-chess-training', W / 2, 1306);

  return cv;
}

async function shareResult() {
  if (!lastResult) return;
  btnShare.disabled = true;
  const orig = btnShare.textContent;
  btnShare.textContent = '產生戰績圖…';
  try {
    const cv = await buildShareCard(lastResult);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    const file = new File([blob], 'chinese-chess-victory.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: lastResult.shareText });
        toast('分享成功，同喜同賀！🎉');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // 使用者取消分享
        // 其餘錯誤改走下載後備方案
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chinese-chess-victory.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    try {
      await navigator.clipboard.writeText(lastResult.shareText);
      toast('戰績圖已下載、炫耀文字已複製，貼上即可分享！');
    } catch {
      toast('戰績圖已下載，快分享你的勝利！');
    }
  } catch {
    toast('產生分享圖失敗，請再試一次');
  } finally {
    btnShare.disabled = false;
    btnShare.textContent = orig;
  }
}
btnShare.addEventListener('click', shareResult);
btnReviewGame.addEventListener('click', () => openLastCompletedGameReview(btnReviewGame));

// ---------------- 按鈕 ----------------
mode = modeSel.value;
modeSel.addEventListener('change', () => {
  mode = modeSel.value;
  newGame(); // 換對手就開新局，避免局中切換造成混亂
});
btnEditor.addEventListener('click', () => {
  if (puzzleFlowActive()) exitEditor();
  else enterEditor();
});
btnPhotoImport.addEventListener('click', openPhotoPicker);
document.getElementById('btnPhotoReplace').addEventListener('click', openPhotoPicker);
photoFileInput.addEventListener('change', () => loadSelectedPhoto(photoFileInput.files?.[0]));
document.getElementById('btnPhotoRemove').addEventListener('click', () => {
  if (!photoReferenceState.photo) return;
  releasePhotoReference();
  setPhotoImportMessage('照片已移除，棋盤配置保持不變。');
  toast('照片已移除，棋盤配置未變更。');
});
btnPhotoRotateLeft.addEventListener('click', () => applyPhotoState(rotatePhotoLeft));
btnPhotoRotateRight.addEventListener('click', () => applyPhotoState(rotatePhotoRight));
btnPhotoZoomOut.addEventListener('click', () => applyPhotoState(zoomPhotoOut));
btnPhotoZoomIn.addEventListener('click', () => applyPhotoState(zoomPhotoIn));
btnPhotoReset.addEventListener('click', () => applyPhotoState(resetPhotoTransform));
btnCalibrationStart.addEventListener('click', beginCalibration);
btnRecognitionScan.addEventListener('click', scanRecognitionCandidates);
btnCalibrationPreview.addEventListener('click', showCalibrationPreview);
document.getElementById('btnCalibrationBack').addEventListener('click', () => {
  calibrationMode = 'adjust';
  syncPhotoUI();
});
document.getElementById('btnCalibrationReset').addEventListener('click', resetCalibrationCorners);
document.getElementById('btnCalibrationPreviewReset').addEventListener('click', resetCalibrationCorners);
document.getElementById('btnCalibrationCancel').addEventListener('click', () => {
  calibrationMode = 'reference';
  syncPhotoUI();
});
document.getElementById('btnCalibrationConfirm').addEventListener('click', confirmCalibrationResult);
document.getElementById('btnRecognitionRescan').addEventListener('click', scanRecognitionCandidates);
document.getElementById('btnRecognitionBack').addEventListener('click', () => {
  calibrationMode = 'reference';
  syncPhotoUI();
});
btnRecognitionAcceptEmpty.addEventListener('click', acceptRecognitionEmpty);
btnRecognitionUndoEmpty.addEventListener('click', () => {
  if (!recognitionSession) return;
  recognitionSession.review = undoBulkEmpty(recognitionSession.review);
  syncRecognitionUI();
  toast('已撤回批次空位；後續人工改正的內容保持不變。');
});
document.getElementById('btnRecognitionReset').addEventListener('click', resetRecognitionReview);
document.getElementById('btnReviewPrevious').addEventListener('click', () => navigateRecognition(previousCandidate));
document.getElementById('btnReviewNext').addEventListener('click', () => navigateRecognition(nextCandidate));
document.getElementById('btnReviewUnresolved').addEventListener('click', () => navigateRecognition(nextUnresolved));
btnRecognitionRematch.addEventListener('click', rematchUnresolvedPieceTypes);
btnRecognitionApply.addEventListener('click', applyRecognitionToEditor);
btnRecognitionEmpty.addEventListener('click', () => setRecognitionSelection(null));
btnRecognitionAdopt.addEventListener('click', () => {
  if (!recognitionSession || !selectedRecognitionKey) return;
  const suggestion = recognitionSession.typeSuggestions[selectedRecognitionKey];
  if (suggestion?.status !== 'suggested' || !suggestion.side || !suggestion.type) return;
  setRecognitionSelection({ side: suggestion.side, type: suggestion.type });
});
btnRecognitionManual.addEventListener('click', () => {
  const firstEnabled = recognitionPieceButtons.find((button) => !button.disabled);
  firstEnabled?.focus({ preventScroll: true });
  firstEnabled?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
recognitionPieceButtons.forEach((button) => {
  button.addEventListener('click', () => setRecognitionSelection({
    side: button.dataset.recognitionSide,
    type: button.dataset.recognitionType,
  }));
});
recognitionUnresolvedOnlyInput.addEventListener('change', () => {
  recognitionUnresolvedOnly = recognitionUnresolvedOnlyInput.checked;
  syncRecognitionUI();
});
calibrationCornerButtons.forEach((button) => {
  button.addEventListener('click', () => selectCalibrationCorner(button.dataset.calibrationCorner));
});
calibrationNudgeButtons.forEach((button) => {
  button.addEventListener('click', () => nudgeCalibrationCorner(button.dataset.calibrationNudge));
});
calibrationOrientationInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked || !calibrationState) return;
    calibrationState = setCalibrationOrientation(calibrationState, input.value);
    confirmedCalibration = null;
    invalidateRecognitionForCalibrationChange();
    if (calibrationMode === 'preview') renderRectifiedPreview();
    else renderCalibrationAdjustment();
  });
});
calibrationCornerCanvas.addEventListener('pointerdown', (event) => {
  if (!calibrationState || calibrationMode !== 'adjust') return;
  const point = canvasNormalizedPointer(event);
  const corner = nearestCalibrationCorner(point);
  if (!corner) return;
  event.preventDefault();
  calibrationPointerId = event.pointerId;
  activeCalibrationCorner = corner;
  calibrationCornerCanvas.setPointerCapture(event.pointerId);
  selectCalibrationCorner(corner);
  moveCalibrationCorner(corner, point);
});
calibrationCornerCanvas.addEventListener('pointermove', (event) => {
  if (event.pointerId !== calibrationPointerId || !calibrationState) return;
  event.preventDefault();
  moveCalibrationCorner(activeCalibrationCorner, canvasNormalizedPointer(event));
});
const finishCalibrationPointer = (event) => {
  if (event.pointerId !== calibrationPointerId) return;
  if (calibrationCornerCanvas.hasPointerCapture(event.pointerId)) {
    calibrationCornerCanvas.releasePointerCapture(event.pointerId);
  }
  calibrationPointerId = null;
};
calibrationCornerCanvas.addEventListener('pointerup', finishCalibrationPointer);
calibrationCornerCanvas.addEventListener('pointercancel', finishCalibrationPointer);
btnLibrary.addEventListener('click', () => {
  if (libraryActive()) exitEditor();
  else enterLibrary();
});
btnGameRecords.addEventListener('click', () => {
  if (gameRecordFlowActive()) exitGameRecordFlow();
  else enterGameRecordLibrary(btnGameRecords);
  closeHudMenu();
});
document.getElementById('btnGameRecordLibraryExit').addEventListener('click', exitGameRecordFlow);
btnGameReviewBack.addEventListener('click', showGameRecordLibrary);
document.getElementById('btnGameReviewExit').addEventListener('click', exitGameRecordFlow);
btnGameReviewFirst.addEventListener('click', () => navigateGameReview('first'));
btnGameReviewPrevious.addEventListener('click', () => navigateGameReview('previous'));
btnGameReviewNext.addEventListener('click', () => navigateGameReview('next'));
btnGameReviewLast.addEventListener('click', () => navigateGameReview('last'));
btnGameReviewAnalyze.addEventListener('click', () => enterGameAnalysis(btnGameReviewAnalyze));
btnGameReviewAiAnalyze.addEventListener('click', requestGameReviewAiCandidate);
btnGameReviewCreatePuzzle.addEventListener('click', () => createPuzzleFromGameReview(btnGameReviewCreatePuzzle));
btnGameAnalysisUndo.addEventListener('click', undoGameAnalysis);
btnGameAnalysisReset.addEventListener('click', resetGameAnalysisToSource);
btnGameAnalysisReturn.addEventListener('click', returnToGameReview);
document.getElementById('btnGameAnalysisExit').addEventListener('click', exitGameRecordFlow);
btnGameReviewDelete.addEventListener('click', () => {
  if (gameReviewSession) deleteGameRecordFromLibrary(gameReviewSession.record.id);
});
gameRecordLibraryList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-game-record-action]');
  const card = button?.closest('[data-game-record-id]');
  if (!button || !card) return;
  const { gameRecordId } = card.dataset;
  if (button.dataset.gameRecordAction === 'open') openStoredGameReview(gameRecordId, button);
  else if (button.dataset.gameRecordAction === 'delete') deleteGameRecordFromLibrary(gameRecordId);
});
gameReviewMoveList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-review-ply]');
  if (!button) return;
  navigateGameReview(Number(button.dataset.reviewPly));
});
editorPieceButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setEditorTool({
      kind: 'piece',
      piece: { side: button.dataset.editorSide, type: button.dataset.editorType },
    });
    setEditorMessage('請點擊空交叉點放置棋子。');
  });
});
btnEditorMove.addEventListener('click', () => {
  setEditorTool({ kind: 'move' });
  setEditorMessage('請先點選要移動的棋子，再點擊空交叉點。');
});
btnEditorErase.addEventListener('click', () => {
  setEditorTool({ kind: 'erase' });
  setEditorMessage('請點擊要刪除的棋子。');
});
document.querySelectorAll('input[name="editorSide"]').forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    editorState = setEditorSideToMove(editorState, input.value);
    markEditorDirty();
    setEditorMessage(input.value === RED ? '已設定紅方先行。' : '已設定黑方先行。');
    refreshHUD();
  });
});
document.getElementById('btnEditorClear').addEventListener('click', () => {
  releasePhotoReference();
  editorState = createEditorState({ sideToMove: editorState.sideToMove });
  markEditorDirty();
  syncEditorScene();
  setEditorMessage('棋盤已清空。');
  refreshHUD();
});
document.getElementById('btnEditorStandard').addEventListener('click', () => {
  releasePhotoReference();
  editorState = createEditorState({ board: initialBoard(), sideToMove: editorState.sideToMove });
  markEditorDirty();
  syncEditorScene();
  setEditorMessage('已載入標準開局配置。');
  refreshHUD();
});
document.getElementById('btnEditorConfirm').addEventListener('click', () => {
  const result = confirmAuthoredPosition(editorState);
  if (!result.ok) {
    const messages = {
      MISSING_RED_KING: '確認失敗：局面需要恰好一枚紅帥。',
      MISSING_BLACK_KING: '確認失敗：局面需要恰好一枚黑將。',
      DUPLICATE_RED_KING: '確認失敗：紅帥只能有一枚。',
      DUPLICATE_BLACK_KING: '確認失敗：黑將只能有一枚。',
      INVALID_SIDE_TO_MOVE: '確認失敗：請選擇先行方。',
    };
    const message = messages[result.error.code] || `確認失敗：${result.error.message}`;
    setEditorMessage(message, 'error');
    toast(message);
    return;
  }
  confirmedPosition = result.position;
  appState = APP_STATE.PUZZLE_CONFIRMED;
  recorderState = null;
  const sideLabel = confirmedPosition.sideToMove === RED ? '紅方' : '黑方';
  setEditorMessage(`局面確認成功，已保留給後續解法錄製（${sideLabel}先行）。`, 'success');
  syncRecorderUI();
  refreshHUD();
  toast('局面確認成功。');
});
document.getElementById('btnEditorExit').addEventListener('click', exitEditor);
document.getElementById('btnRecorderStart').addEventListener('click', startRecording);
btnRecorderUndo.addEventListener('click', undoRecorder);
btnRecorderReset.addEventListener('click', resetRecorder);
btnRecorderFinish.addEventListener('click', finishRecorder);
btnSavePuzzle.addEventListener('click', saveCurrentPuzzle);
document.getElementById('btnOpenLibrary').addEventListener('click', () => enterLibrary(savedCurrentPuzzleId));
document.getElementById('btnRecorderCancel').addEventListener('click', cancelRecording);
document.getElementById('btnRecorderExit').addEventListener('click', exitEditor);
btnPracticeStart.addEventListener('click', startPractice);
btnPracticeHint.addEventListener('click', requestPracticeHint);
btnPracticeRestart.addEventListener('click', restartCurrentPractice);
btnPracticeExit.addEventListener('click', exitPractice);
document.getElementById('btnPracticePuzzleExit').addEventListener('click', exitEditor);
libraryList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-library-action]');
  const card = button?.closest('[data-puzzle-id]');
  if (!button || !card) return;
  const { puzzleId } = card.dataset;
  if (button.dataset.libraryAction === 'view') openLibraryPuzzle(puzzleId);
  else if (button.dataset.libraryAction === 'practice') startSavedPractice(puzzleId);
  else if (button.dataset.libraryAction === 'delete') deleteStoredPuzzle(puzzleId);
});
document.getElementById('btnLibraryBack').addEventListener('click', showLibraryList);
btnLibraryDetailPractice.addEventListener('click', () => startSavedPractice(activeSavedPuzzleId));
btnLibraryDetailDelete.addEventListener('click', () => deleteStoredPuzzle(activeSavedPuzzleId));
btnLibraryDetailExport.addEventListener('click', exportSelectedPuzzle);
btnLibraryExportAll.addEventListener('click', exportAllPuzzles);
btnLibraryImport.addEventListener('click', () => puzzleImportFile.click());
puzzleImportFile.addEventListener('change', () => loadPuzzleImportFile(puzzleImportFile.files?.[0]));
btnLibraryImportConfirm.addEventListener('click', confirmPuzzleImport);
btnLibraryImportCancel.addEventListener('click', cancelPuzzleImport);
document.getElementById('btnLibraryExit').addEventListener('click', exitEditor);
btnNew.addEventListener('click', newGame);
btnUndo.addEventListener('click', undo);
document.getElementById('btnSound').addEventListener('click', (e) => {
  muted = !muted;
  e.currentTarget.textContent = muted ? '音效：關' : '音效：開';
  e.currentTarget.setAttribute('aria-pressed', String(!muted));
});
// 「⋯」更多選單（小螢幕）：開合、點外處／Esc 關閉、玩法說明開關
const hudMore = document.getElementById('hudMore');
const btnMore = document.getElementById('btnMore');
const btnHelp = document.getElementById('btnHelp');
function closeHudMenu() {
  hudMore.classList.remove('open');
  btnMore.setAttribute('aria-expanded', 'false');
}
btnMore.addEventListener('click', () => {
  const open = hudMore.classList.toggle('open');
  btnMore.setAttribute('aria-expanded', String(open));
});
document.addEventListener('pointerdown', (e) => {
  if (hudMore.classList.contains('open') && !hudMore.contains(e.target) && !btnMore.contains(e.target)) closeHudMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (appState === APP_STATE.GAME_ANALYSIS) returnToGameReview();
    else if (appState === APP_STATE.GAME_REVIEW) exitGameReview();
    else if (appState === APP_STATE.GAME_RECORD_LIBRARY) exitGameRecordFlow();
    closeHudMenu();
    return;
  }
  if (appState !== APP_STATE.GAME_REVIEW) return;
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement || target?.isContentEditable) return;
  const action = {
    ArrowLeft: 'previous',
    ArrowRight: 'next',
    Home: 'first',
    End: 'last',
  }[e.key];
  if (!action) return;
  e.preventDefault();
  navigateGameReview(action);
});
btnHelp.addEventListener('click', () => {
  const on = document.getElementById('left').classList.toggle('show-help');
  btnHelp.setAttribute('aria-pressed', String(on));
  closeHudMenu();
});
function flyTo(pos, tgt, done) {
  cancelCameraTween();
  const tgtFrom = controls.target.clone();
  // 以「球座標」補間（繞著目標水平環繞），直線 lerp 在 180° 換邊時
  // 相機會橫越棋盤正上方，畫面劇烈甩動、體感很差
  const sphFrom = new THREE.Spherical().setFromVector3(camera.position.clone().sub(tgtFrom));
  const sphTo = new THREE.Spherical().setFromVector3(pos.clone().sub(tgt));
  let dTheta = sphTo.theta - sphFrom.theta;
  // 取最短角距離；剛好半圈時固定逆時針，方向不會忽左忽右
  while (dTheta > Math.PI) dTheta -= Math.PI * 2;
  while (dTheta < -Math.PI) dTheta += Math.PI * 2;
  if (dTheta === -Math.PI) dTheta = Math.PI;
  // 旋轉角度越大、補間越久，讓換邊時節奏依然從容
  const dur = 480 + (Math.abs(dTheta) / Math.PI) * 480;
  tween(dur, (k) => {
    const tgtNow = tgtFrom.clone().lerp(tgt, k);
    const sph = new THREE.Spherical(
      sphFrom.radius + (sphTo.radius - sphFrom.radius) * k,
      sphFrom.phi + (sphTo.phi - sphFrom.phi) * k,
      sphFrom.theta + dTheta * k,
    );
    camera.position.setFromSpherical(sph).add(tgtNow);
    // 補間途中需自行更新相機朝向（tick 可能正跳過 controls.update()），
    // 否則抵達後視線方向是舊的
    camera.lookAt(tgtNow);
  }, () => { saveViewPrefs(); if (done) done(); }, 0, 'camera');
}
function cancelCameraTween() {
  for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].tag === 'camera') tweens.splice(i, 1);
}

// 「視角」按鈕：在多個預設機位之間循環切換
const CAMERA_VIEWS = [
  { label: '紅方', dist: 14.8, polar: 45, azimuth: -90, tgt: HOME_TGT },
  { label: '黑方', dist: 14.8, polar: 45, azimuth: 90, tgt: new THREE.Vector3(0, -0.1, -0.2) },
  { label: '側面', dist: 14.8, polar: 55, azimuth: 0, tgt: new THREE.Vector3(0, -0.1, 0.2) },
  { label: '俯視', dist: 14.2, polar: 8, azimuth: -90, tgt: new THREE.Vector3(0, 0, 0.2) },
];
let viewIdx = 0;
document.getElementById('btnView').addEventListener('click', () => {
  viewIdx = (viewIdx + 1) % CAMERA_VIEWS.length;
  const v = CAMERA_VIEWS[viewIdx];
  const pos = new THREE.Vector3()
    .setFromSphericalCoords(v.dist, THREE.MathUtils.degToRad(v.polar), THREE.MathUtils.degToRad(v.azimuth))
    .add(v.tgt);
  flyTo(pos, v.tgt);
  toast(`視角：${v.label}`);
});

// 固定視角：鎖定鏡頭後拖曳／滾輪都不再改變視角（Issue #2）
let viewLocked = false;
const btnLock = document.getElementById('btnLock');
function syncLockUI() {
  controls.enabled = !viewLocked;
  document.getElementById('btnLockText').textContent = viewLocked ? '固定視角：開' : '固定視角：關';
  btnLock.setAttribute('aria-pressed', String(viewLocked));
  btnLock.classList.toggle('on', viewLocked);
}
btnLock.addEventListener('click', () => {
  viewLocked = !viewLocked;
  syncLockUI();
  saveViewPrefs();
  // 以「現狀」固定：凍結當下視角與進行中的相機補間，不做歸位
  if (viewLocked) cancelCameraTween();
});
syncLockUI();

// ---------------- 個人化：記住 3D 視角與固定視角設定（localStorage） ----------------
const VIEW_PREF_KEY = 'xiangqi.viewPrefs.v1';
let saveViewTimer = 0;
function saveViewPrefs() {
  try {
    localStorage.setItem(VIEW_PREF_KEY, JSON.stringify({
      pos: camera.position.toArray(),
      tgt: controls.target.toArray(),
      locked: viewLocked,
      viewIdx,
    }));
  } catch { /* 無法寫入（如隱私模式）時靜默略過 */ }
}
function queueSaveViewPrefs() {
  clearTimeout(saveViewTimer);
  saveViewTimer = setTimeout(saveViewPrefs, 600); // 等慣性減速大致停止再存
}
function loadViewPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(VIEW_PREF_KEY) || 'null');
    const okVec = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
    if (!p || !okVec(p.pos) || !okVec(p.tgt)) return null;
    return p;
  } catch { return null; }
}
// 啟動時還原個人化設定
const savedPrefs = loadViewPrefs();
if (savedPrefs) {
  camera.position.fromArray(savedPrefs.pos);
  controls.target.fromArray(savedPrefs.tgt);
  camera.lookAt(controls.target);
  if (savedPrefs.locked) {
    viewLocked = true;
    syncLockUI();
  }
  if (Number.isInteger(savedPrefs.viewIdx)) {
    viewIdx = ((savedPrefs.viewIdx % CAMERA_VIEWS.length) + CAMERA_VIEWS.length) % CAMERA_VIEWS.length;
  }
}
window.addEventListener('pagehide', saveViewPrefs);
document.getElementById('btnAgain').addEventListener('click', newGame);

// 全螢幕（含 Safari webkit 前綴）
const btnFull = document.getElementById('btnFull');
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
btnFull.addEventListener('click', async () => {
  try {
    if (fsElement()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
    } else {
      const root = document.documentElement;
      await (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.());
    }
  } catch {
    /* 使用者拒絕或瀏覽器不支援時忽略 */
  }
});
function syncFullBtn() {
  const on = !!fsElement();
  btnFull.textContent = on ? '離開全螢幕' : '全螢幕';
  btnFull.setAttribute('aria-pressed', String(on));
}
document.addEventListener('fullscreenchange', syncFullBtn);
document.addEventListener('webkitfullscreenchange', syncFullBtn);
syncFullBtn();

// ---------------- resize / loop ----------------
function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
new ResizeObserver(resize).observe(container);
resize();

function tick(now) {
  stepTweens(now);
  if (selRing.visible) {
    const s = 1 + Math.sin(now * 0.006) * 0.05;
    selRing.scale.set(s, s, 1);
  }
  if (!viewLocked) controls.update(); // 鎖定時不套用控制器更新，慣性晃動一併凍結
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(tick);

newGame();
