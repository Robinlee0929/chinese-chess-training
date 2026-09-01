import * as THREE from 'three';

// Test-only browser QA hook. The local QA server loads this before main.js so
// canvas clicks can be aimed from the real Three.js camera instead of guessed pixels.
const originalUpdateProjectionMatrix = THREE.PerspectiveCamera.prototype.updateProjectionMatrix;
let activeCamera = null;

THREE.PerspectiveCamera.prototype.updateProjectionMatrix = function captureAnalysisQaCamera() {
  activeCamera = this;
  return originalUpdateProjectionMatrix.call(this);
};

const probe = document.createElement('output');
probe.id = 'gameAnalysisQaProbe';
probe.hidden = true;
probe.setAttribute('aria-hidden', 'true');
document.body.append(probe);

const normalAiTrigger = document.createElement('button');
normalAiTrigger.id = 'normalAiQaTrigger';
normalAiTrigger.hidden = true;
normalAiTrigger.setAttribute('aria-hidden', 'true');
normalAiTrigger.addEventListener('click', () => {
  const chess = window.__chess;
  chess?.setMode('medium');
  chess?.newGame();
  chess?.doMove({ r: 2, c: 1 }, { r: 2, c: 4 });
});
document.body.append(normalAiTrigger);

let r4FixtureSeeded = false;
let reviewSeenForNormalAiResume = false;
let normalAiResumeTriggered = false;
const qaParams = new URLSearchParams(location.search);
const reviewAiQaMode = qaParams.get('reviewAi');

if (reviewAiQaMode) {
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = class ReviewAiQaWorker {
    constructor(url, options) {
      this.native = new NativeWorker(url, options);
      this.onmessage = null;
      this.onerror = null;
      this.scheduled = null;
      this.native.onmessage = (event) => this.onmessage?.(event);
      this.native.onerror = (event) => this.onerror?.(event);
    }

    postMessage(message) {
      if (message.kind !== 'review-candidate') {
        this.native.postMessage(message);
        return;
      }
      this.native.terminate();
      const data = {
        kind: 'review-candidate',
        recordId: message.recordId,
        ply: message.ply,
        revision: message.revision,
      };
      if (reviewAiQaMode === 'error') data.error = 'Controlled Review AI failure.';
      else data.result = {
        from: { r: 2, c: 3 },
        to: { r: 2, c: 4 },
        score: 99998,
        depth: 2,
      };
      const delay = reviewAiQaMode === 'stale' ? 800 : 120;
      this.scheduled = setTimeout(() => this.onmessage?.({ data }), delay);
    }

    terminate() {
      this.native.terminate();
      if (reviewAiQaMode !== 'stale') clearTimeout(this.scheduled);
    }
  };
}

function seedR4Fixture(chess) {
  if (r4FixtureSeeded || !['r4', 'r3a'].includes(qaParams.get('qa'))) return;
  r4FixtureSeeded = true;
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  board[0][4] = { type: 'K', side: 'red' };
  board[2][3] = { type: 'R', side: 'red' };
  board[2][4] = { type: 'P', side: 'black' };
  board[9][0] = { type: 'R', side: 'red' };
  board[9][4] = { type: 'K', side: 'black' };
  board[9][8] = { type: 'R', side: 'red' };
  chess.setMode('pvp');
  chess.resetTo(board, 'red');
  chess.doMove({ r: 2, c: 3 }, { r: 2, c: 4 });
}

function project(world) {
  const canvas = document.querySelector('#stage canvas');
  if (!canvas || !activeCamera) return null;
  const rect = canvas.getBoundingClientRect();
  const projected = world.clone().project(activeCamera);
  const clientX = rect.left + ((projected.x + 1) / 2) * rect.width;
  const clientY = rect.top + ((1 - projected.y) / 2) * rect.height;
  return {
    clientX,
    clientY,
    canvasX: clientX - rect.left,
    canvasY: clientY - rect.top,
  };
}

function squareWorld(r, c) {
  return new THREE.Vector3(c - 4, 0.015, 4.5 - r);
}

function readProbe() {
  const chess = window.__chess;
  const canvas = document.querySelector('#stage canvas');
  if (!chess || !canvas || !activeCamera) {
    return { ready: false, chess: !!chess, canvas: !!canvas, camera: !!activeCamera };
  }
  seedR4Fixture(chess);
  const squares = {};
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) squares[`${r},${c}`] = project(squareWorld(r, c));
  }
  const pieces = {};
  for (const mesh of chess.pieces) {
    if (!mesh.userData?.piece) continue;
    pieces[`${mesh.userData.r},${mesh.userData.c}`] = project(mesh.getWorldPosition(new THREE.Vector3()));
  }
  const analysis = chess.gameAnalysis;
  const review = chess.gameReview;
  const reviewAi = chess.gameReviewAi;
  return {
    ready: true,
    appState: chess.appState,
    normalSelected: chess.selected,
    live: {
      board: chess.board,
      turn: chess.turn,
      history: chess.history,
      mode: chess.mode,
      aiThinking: chess.aiThinking,
      session: chess.normalGameRecordSession,
    },
    review: review ? {
      recordId: review.record.id,
      selectedPly: review.selectedPly,
      totalPlies: review.totalPlies,
      board: review.snapshot.board,
      sideToMove: review.snapshot.sideToMove,
      terminal: review.snapshot.terminal,
    } : null,
    reviewAi,
    analysis: analysis ? {
      sourceRecordId: analysis.sourceRecordId,
      sourcePly: analysis.sourcePly,
      moves: analysis.moves,
      terminal: analysis.terminal,
      boardEqualsAnchor: JSON.stringify(analysis.currentBoard) === JSON.stringify(analysis.anchorBoard),
    } : null,
    editor: chess.editorDraft,
    reviewPuzzleReturn: chess.gameReviewPuzzleReturnContext,
    recordedPuzzle: chess.recordedPuzzleResult,
    storage: localStorage.getItem('chinese-chess-training:game-records:v1'),
    canvas: canvas.getBoundingClientRect().toJSON(),
    projections: { squares, pieces },
  };
}

setInterval(() => {
  try {
    const chess = window.__chess;
    if (qaParams.has('normalAiResume') && chess?.appState === 'GAME_REVIEW') {
      reviewSeenForNormalAiResume = true;
    }
    if (qaParams.has('normalAiResume') && reviewSeenForNormalAiResume &&
        !normalAiResumeTriggered && chess?.appState === 'NORMAL_GAME') {
      normalAiResumeTriggered = true;
      normalAiTrigger.dispatchEvent(new MouseEvent('click'));
    }
    probe.textContent = JSON.stringify(readProbe());
  } catch (error) {
    probe.textContent = JSON.stringify({ ready: false, error: String(error) });
  }
}, 50);
