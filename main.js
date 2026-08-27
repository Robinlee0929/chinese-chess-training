// ============================================================
// 中國象棋 3D —— Three.js 呈現 + 互動
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  ROWS, COLS, RED, BLACK,
  initialBoard, legalMoves, applyMove, inCheck,
  hasAnyLegalMove, name, notation,
} from './game.js';
import {
  PuzzleEditorError,
  createEditorState,
  placeEditorPiece,
  moveEditorPiece,
  removeEditorPiece,
  setEditorSideToMove,
  confirmAuthoredPosition,
  exportAuthoredPosition,
} from './puzzle-editor.js';
import {
  PuzzleRecorderError,
  createRecorder,
  recordMove,
  undoRecordedMove,
  resetRecording,
  finishRecording,
  exportRecorderBoard,
  exportRecordedResult,
} from './puzzle-recorder.js';
import {
  PuzzlePracticeError,
  createPractice,
  attemptPracticeMove,
  applyOpponentReply,
  restartPractice,
  exportPracticeSnapshot,
} from './puzzle-practice.js';

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
function showMoveDots(moves, sourceBoard = board) {
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
  showSelectRingAt(selected);
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
function tween(dur, fn, done, delay = 0) {
  tweens.push({ t0: performance.now() + delay, dur, fn, done });
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
let capturedBy = { [RED]: [], [BLACK]: [] };
let over = false, winner = null, busy = false;
let gameStartTime = Date.now();
let undoCount = 0;     // 本局悔棋次數（人機模式一次連退兩著仍計 1 次）

// ---------------- 殺局工作流程 ----------------
const APP_STATE = Object.freeze({
  NORMAL_GAME: 'NORMAL_GAME',
  PUZZLE_EDITOR: 'PUZZLE_EDITOR',
  PUZZLE_CONFIRMED: 'PUZZLE_CONFIRMED',
  PUZZLE_RECORDING: 'PUZZLE_RECORDING',
  PUZZLE_RECORDED: 'PUZZLE_RECORDED',
  PUZZLE_PRACTICING: 'PUZZLE_PRACTICING',
  PUZZLE_PRACTICE_COMPLETE: 'PUZZLE_PRACTICE_COMPLETE',
});
let appState = APP_STATE.NORMAL_GAME;
let editorState = null;
let editorTool = { kind: 'move' };
let confirmedPosition = null;
let recorderState = null;
let recordedPuzzleResult = null;
let practiceState = null;
let practiceToken = 0;

const puzzleFlowActive = () => appState !== APP_STATE.NORMAL_GAME;
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
const puzzleBoardActive = () => recorderBoardActive() || practiceActive();

// ---------------- 對弈模式 / AI ----------------
let mode = 'medium';   // 'pvp' | 'easy' | 'medium' | 'hard'
const AI_SIDE = BLACK; // 人機模式：玩家執紅，AI 執黑
const isAI = () => mode !== 'pvp';
let aiThinking = false;
let aiToken = 0;       // 用於作廢過期的 AI 計算（開新局、悔棋後）
let aiMoveStart = 0;

let aiWorker = null;
let aiModule = null;   // Worker 不可用時的主執行緒後備
try {
  aiWorker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
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
    board: board.map((row) => row.map((p) => (p ? { ...p } : null))),
    side: turn,
    level: mode,
    token,
  };
  if (aiWorker) {
    aiWorker.postMessage(payload);
  } else {
    (aiModule ??= import('./ai.js')).then(({ findBestMove }) => {
      setTimeout(() => {
        if (token !== aiToken) return;
        onAIResult({ token, result: findBestMove(payload.board, payload.side, payload.level) });
      }, 30);
    });
  }
}

function maybeAIMove() {
  if (puzzleFlowActive() || !isAI() || over || busy || turn !== AI_SIDE || aiThinking) return;
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
    if (puzzleFlowActive() || over || busy || turn !== AI_SIDE) { refreshHUD(); return; }
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
  get editorActive() { return puzzleFlowActive(); },
  get puzzleState() { return appState; },
  get editorResult() { return cloneConfirmedPosition(); },
  get recordedPuzzleResult() { return cloneRecordedPuzzleResult(); },
  get practiceState() { return practiceState ? exportPracticeSnapshot(practiceState) : null; },
  setMode(m) { mode = m; const el = document.getElementById('modeSel'); if (el) el.value = m; },
  get lastResult() { return lastResult; },
  buildShareCard: (r) => buildShareCard(r || lastResult),
  resetTo,
  newGame,
  undo,
  doMove,
  enterEditor,
  exitEditor,
  checkEditorMeshInvariant: () => checkBoardMeshInvariant(editorState?.board),
  checkPuzzleMeshInvariant: () => checkBoardMeshInvariant(activePuzzleBoard()),
  camera, renderer, scene,
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
const modeSel = document.getElementById('modeSel');
const editorPanel = document.getElementById('editorPanel');
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
const btnPracticeRestart = document.getElementById('btnPracticeRestart');

function refreshHUD() {
  const showSide = practiceActive()
    ? practiceState.currentSide
    : (recorderBoardActive()
      ? recorderState.currentSide
      : (authoringActive() ? editorState.sideToMove : (over && winner ? winner : turn)));
  const isRed = showSide === RED;
  if (appState === APP_STATE.PUZZLE_EDITOR) {
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
  } else if (over) {
    turnText.textContent = winner === RED ? '紅方勝' : '黑方勝';
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
  turnBox.classList.toggle('thinking', !puzzleFlowActive() && aiThinking && !over);
  capRedEl.innerHTML = capturedBy[RED].map((p) => `<span class="chip ${p.side}">${name(p.side, p.type)}</span>`).join('') || '<em>—</em>';
  capBlackEl.innerHTML = capturedBy[BLACK].map((p) => `<span class="chip ${p.side}">${name(p.side, p.type)}</span>`).join('') || '<em>—</em>';
  btnUndo.disabled = puzzleFlowActive() || history.length === 0 || busy || aiThinking;
  btnNew.disabled = puzzleFlowActive();
  modeSel.disabled = puzzleFlowActive();
  btnEditor.textContent = puzzleFlowActive() ? '退出殺局' : '建立殺局';
  btnEditor.setAttribute('aria-pressed', String(puzzleFlowActive()));
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

function rebuildPieceMeshes(sourceBoard, animate = false) {
  clearSelection();
  for (const m of [...pieces]) scene.remove(m);
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
    const logical = sourceBoard[r]?.[c];
    if (!logical) errors.push(`Mesh at ${key} has no logical piece.`);
    else if (!piece || logical.side !== piece.side || logical.type !== piece.type) {
      errors.push(`Mesh at ${key} does not match its logical piece.`);
    }
  }

  if (pieces.length !== boardPieceCount) {
    errors.push(`Expected ${boardPieceCount} meshes but found ${pieces.length}.`);
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

function enterEditor() {
  if (puzzleFlowActive()) return true;
  if (busy) {
    toast('請等待目前棋步動畫完成後再進入編輯。');
    return false;
  }
  aiToken++;
  aiThinking = false;
  tweens.length = 0;
  clearSelection();
  editorState = createEditorState();
  appState = APP_STATE.PUZZLE_EDITOR;
  confirmedPosition = null;
  recorderState = null;
  appEl.classList.add('editor-active');
  editorPanel.classList.remove('hidden');
  lastFromMark.visible = false;
  lastToMark.visible = false;
  banner.classList.add('hidden');
  setEditorTool({ kind: 'move' });
  document.querySelector(`input[name="editorSide"][value="${RED}"]`).checked = true;
  setEditorMessage('選擇棋子後點擊空交叉點即可放置。');
  syncEditorScene();
  syncRecorderUI();
  refreshHUD();
  return true;
}

function exitEditor() {
  if (!puzzleFlowActive()) return;
  aiToken++;
  practiceToken++;
  aiThinking = false;
  tweens.length = 0;
  appState = APP_STATE.NORMAL_GAME;
  editorState = null;
  confirmedPosition = null;
  recorderState = null;
  practiceState = null;
  busy = false;
  clearSelection();
  appEl.classList.remove('editor-active');
  editorPanel.classList.add('hidden');
  editorPanel.classList.remove('recorder-active');
  recorderPanel.classList.add('hidden');
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
  return null;
}

function setRecorderMessage(message, kind = '') {
  recorderMessage.textContent = message;
  recorderMessage.classList.toggle('success', kind === 'success');
  recorderMessage.classList.toggle('error', kind === 'error');
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
  renderRecorderLog();
}

function setPracticeMessage(message, kind = '') {
  practiceMessage.textContent = message;
  practiceMessage.classList.toggle('success', kind === 'success');
  practiceMessage.classList.toggle('error', kind === 'error');
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
  appState = APP_STATE.PUZZLE_RECORDED;
  clearSelection();
  const invariant = checkBoardMeshInvariant(recorderState.board);
  if (!invariant.ok) throw new Error(`Recorder board/mesh invariant failed: ${invariant.errors.join(' ')}`);
  setRecorderMessage('答案有效：已形成將死', 'success');
  syncRecorderUI();
  refreshHUD();
  toast('答案有效：已形成將死');
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
      scene.remove(capturedMesh);
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
  practiceToken++;
  appState = APP_STATE.PUZZLE_PRACTICING;
  clearSelection();
  setPracticeMessage('請走出本題的第一步。');
  syncPracticeScene();
  syncRecorderUI();
  refreshHUD();
}

function restartCurrentPractice() {
  if (!practiceState) return;
  practiceToken++;
  tweens.length = 0;
  busy = false;
  practiceState = restartPractice(practiceState);
  appState = APP_STATE.PUZZLE_PRACTICING;
  clearSelection();
  syncPracticeScene();
  setPracticeMessage('已回到原始局面，請重新開始。');
  syncRecorderUI();
  refreshHUD();
}

function exitPractice() {
  if (!practiceActive() || !recorderState) return;
  practiceToken++;
  tweens.length = 0;
  busy = false;
  practiceState = null;
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
  const invariant = checkBoardMeshInvariant(practiceState.currentBoard);
  if (!invariant.ok) throw new Error(`Practice board/mesh invariant failed: ${invariant.errors.join(' ')}`);
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
      scene.remove(capturedMesh);
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
  const p = pieceAt(from.r, from.c);
  const cap = pieceAt(to.r, to.c);
  const captured = board[to.r][to.c];
  const nota = notation(board, from, to);
  applyMove(board, from, to);
  p.userData.r = to.r;
  p.userData.c = to.c;
  history.push({ from, to, captured, nota });
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
        scene.remove(cap);
        const i = pieces.indexOf(cap);
        if (i >= 0) pieces.splice(i, 1);
        finishMove(nota, captured);
      });
    } else {
      finishMove(nota, captured);
    }
  });
}

function finishMove(nota, captured) {
  if (captured) capturedBy[turn].push(captured);
  addLog(nota, turn);
  turn = turn === RED ? BLACK : RED;
  busy = false;

  const checked = inCheck(board, turn);
  const has = hasAnyLegalMove(board, turn);
  if (checked) {
    sfx.check();
    showBanner();
  }
  if (!has) {
    over = true;
    winner = turn === RED ? BLACK : RED;
    refreshHUD();
    setTimeout(() => showGameOver(checked), checked ? 900 : 300);
  }
  refreshHUD();
  maybeAIMove();
}

function showBanner() {
  banner.classList.remove('hidden');
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => banner.classList.add('hidden'), 1500);
}

function undoPly() {
  const h = history.pop();
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
}

function undo() {
  if (puzzleFlowActive() || !history.length || busy || aiThinking) return;
  undoCount++;
  aiToken++; // 作廢進行中的 AI 計算
  undoPly();
  // 人機模式：連 AI 那一步一起退，回到玩家回合
  if (isAI() && turn === AI_SIDE && history.length) undoPly();
  addLog('悔棋', turn);
  if (over) { over = false; winner = null; }
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
  const hit = pick(e);
  renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
});

let downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });

renderer.domElement.addEventListener('click', (e) => {
  if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 8) {
    downXY = null; // 拖曳旋轉視角後產生的 click，忽略
    return;
  }
  downXY = null;
  const hit = pick(e);
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
const SITE_URL = 'https://chinese-chess.gh.miniasp.com/';
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

function showGameOver(checked) {
  const pvp = !isAI();
  const playerWin = !pvp && winner !== AI_SIDE;
  const d = pvp ? null : DIFF[mode];
  const plies = Math.max(1, history.length); // 棋譜著法數
  const secs = Math.max(1, Math.round((Date.now() - gameStartTime) / 1000));
  const caps = pvp ? capturedBy[winner].length : capturedBy[RED].length;
  const pure = undoCount === 0; // 全程零悔棋：純度勳章
  const reasonChars = checked ? '將死' : '困斃';
  const winLabel = winner === RED ? '紅方' : '黑方';
  const celebrate = pvp || playerWin;

  let title, sub, badge, cardTitle, cardSub, shareText;
  if (pvp) {
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

  lastResult = { pvp, playerWin, d, plies, secs, caps, undoCount, pure, reasonChars, cardTitle, cardSub, shareText };

  ovBadge.textContent = badge;
  ovTitle.textContent = title;
  ovSub.textContent = sub;
  if (d) {
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
  ovReason.textContent = celebrate ? `以「${reasonChars}」取勝` : `遭「${reasonChars}」落敗`;
  ovCard.classList.toggle('win', celebrate);
  ovCard.classList.toggle('lose', !celebrate);
  btnShare.style.display = celebrate ? '' : 'none';
  overlay.classList.remove('hidden');
  if (celebrate) {
    sfx.win();
    startConfetti();
  } else {
    stopConfetti();
    sfx.lose();
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
  g.fillText('chinese-chess.gh.miniasp.com', W / 2, 1306);

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
  editorState = createEditorState({ sideToMove: editorState.sideToMove });
  markEditorDirty();
  syncEditorScene();
  setEditorMessage('棋盤已清空。');
  refreshHUD();
});
document.getElementById('btnEditorStandard').addEventListener('click', () => {
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
document.getElementById('btnRecorderCancel').addEventListener('click', cancelRecording);
document.getElementById('btnRecorderExit').addEventListener('click', exitEditor);
btnPracticeStart.addEventListener('click', startPractice);
btnPracticeRestart.addEventListener('click', restartCurrentPractice);
document.getElementById('btnPracticeExit').addEventListener('click', exitPractice);
document.getElementById('btnPracticePuzzleExit').addEventListener('click', exitEditor);
btnNew.addEventListener('click', newGame);
btnUndo.addEventListener('click', undo);
document.getElementById('btnSound').addEventListener('click', (e) => {
  muted = !muted;
  e.currentTarget.textContent = muted ? '音效：關' : '音效：開';
  e.currentTarget.setAttribute('aria-pressed', String(!muted));
});
document.getElementById('btnView').addEventListener('click', () => {
  const camFrom = camera.position.clone();
  const tgtFrom = controls.target.clone();
  tween(650, (k) => {
    camera.position.lerpVectors(camFrom, HOME.pos, k);
    controls.target.lerpVectors(tgtFrom, HOME.tgt, k);
  });
});
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
  controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(tick);

newGame();
