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
const reviewCoachQaMode = qaParams.get('reviewCoach');
let reviewCoachRequestCount = 0;
let reviewCoachActiveCount = 0;
let reviewCoachMaxActiveCount = 0;

if (reviewCoachQaMode) {
  Object.defineProperty(globalThis, '__CHINESE_CHESS_REVIEW_COACH_REQUESTER__', {
    configurable: true,
    value(request, { signal }) {
      return new Promise((resolve, reject) => {
        reviewCoachRequestCount++;
        reviewCoachActiveCount++;
        reviewCoachMaxActiveCount = Math.max(reviewCoachMaxActiveCount, reviewCoachActiveCount);
        let active = true;
        const finish = (callback, value) => {
          if (!active) return;
          active = false;
          reviewCoachActiveCount--;
          callback(value);
        };
        const timer = setTimeout(() => {
          if (reviewCoachQaMode === 'reject') {
            finish(reject, new Error('Controlled Review coach failure.'));
            return;
          }
          const response = {
            version: request.version,
            requestId: request.requestId,
            sourceRuleId: request.sourceRuleId,
            style: request.style,
            framing: {
              leadIn: '可以一起看看這個地方。',
              encouragement: '下次也可以先停一下想想。',
            },
          };
          if (reviewCoachQaMode === 'malformed') response.extra = true;
          finish(resolve, response);
        }, reviewCoachQaMode === 'stale' ? 2500 : 120);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          finish(reject, new Error('Controlled Review coach abort.'));
        }, { once: true });
      });
    },
  });
}

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
      else {
        const controlledMoves = {
          'candidate-mate': [{ r: 2, c: 3 }, { r: 2, c: 4 }],
          check: [{ r: 4, c: 3 }, { r: 9, c: 3 }],
          capture: [{ r: 4, c: 3 }, { r: 4, c: 1 }],
          exposure: [{ r: 4, c: 1 }, { r: 3, c: 3 }],
          none: [{ r: 4, c: 1 }, { r: 2, c: 0 }],
          'capture-reply': [{ r: 4, c: 3 }, { r: 4, c: 4 }],
          repetition: [{ r: 5, c: 3 }, { r: 6, c: 3 }],
          stalemate: [{ r: 0, c: 5 }, { r: 1, c: 5 }],
        };
        const [from, to] = controlledMoves[reviewAiQaMode]
          || [{ r: 2, c: 3 }, reviewAiQaMode === 'different' ? { r: 3, c: 3 } : { r: 2, c: 4 }];
        data.result = { from, to, score: 99998, depth: 2 };
      }
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
  const qaMode = qaParams.get('qa');
  if (r4FixtureSeeded || !['r4', 'r3a', 'r3b', 'r3c-mate', 'r3c-cycle',
    'r3c-capture-reply', 'r3c-stalemate'].includes(qaMode)) return;
  r4FixtureSeeded = true;
  if (qaMode === 'r3c-cycle') {
    const board = Array.from({ length: 10 }, () => Array(9).fill(null));
    board[0][0] = { type: 'K', side: 'red' };
    board[4][3] = { type: 'R', side: 'red' };
    board[4][1] = { type: 'N', side: 'black' };
    board[9][4] = { type: 'K', side: 'black' };
    const cycle = [
      [{ r: 9, c: 4 }, { r: 9, c: 5 }],
      [{ r: 4, c: 3 }, { r: 5, c: 3 }],
      [{ r: 9, c: 5 }, { r: 9, c: 4 }],
      [{ r: 5, c: 3 }, { r: 4, c: 3 }],
    ];
    seedCompletedFixture(chess, board, 'black', [...cycle, ...cycle]);
    return;
  }
  if (qaMode === 'r3c-capture-reply') {
    const board = Array.from({ length: 10 }, () => Array(9).fill(null));
    board[0][4] = { type: 'K', side: 'red' };
    board[4][3] = { type: 'R', side: 'red' };
    board[4][4] = { type: 'P', side: 'black' };
    board[4][6] = { type: 'R', side: 'black' };
    board[5][5] = { type: 'P', side: 'red' };
    board[6][4] = { type: 'P', side: 'black' };
    board[9][4] = { type: 'K', side: 'black' };
    const cycle = [
      [{ r: 0, c: 4 }, { r: 0, c: 5 }],
      [{ r: 9, c: 4 }, { r: 9, c: 5 }],
      [{ r: 0, c: 5 }, { r: 0, c: 4 }],
      [{ r: 9, c: 5 }, { r: 9, c: 4 }],
    ];
    seedCompletedFixture(chess, board, 'red', [...cycle, ...cycle]);
    return;
  }
  if (qaMode === 'r3c-stalemate') {
    const board = Array.from({ length: 10 }, () => Array(9).fill(null));
    board[9][5] = { type: 'K', side: 'black' };
    board[0][5] = { type: 'K', side: 'red' };
    board[4][5] = { type: 'P', side: 'red' };
    board[7][5] = { type: 'N', side: 'red' };
    board[7][0] = { type: 'R', side: 'red' };
    seedCompletedFixture(chess, board, 'red', [[{ r: 7, c: 0 }, { r: 8, c: 0 }]]);
    return;
  }
  const board = Array.from({ length: 10 }, () => Array(9).fill(null));
  board[0][4] = { type: 'K', side: 'red' };
  board[2][3] = { type: 'R', side: 'red' };
  board[2][4] = { type: 'P', side: 'black' };
  if (qaMode === 'r3c-mate') board[4][1] = { type: 'N', side: 'black' };
  board[9][0] = { type: 'R', side: 'red' };
  board[9][4] = { type: 'K', side: 'black' };
  board[9][8] = { type: 'R', side: 'red' };
  const moves = qaMode === 'r3c-mate' ? [
    [{ r: 0, c: 4 }, { r: 0, c: 5 }],
    [{ r: 9, c: 4 }, { r: 8, c: 4 }],
    [{ r: 9, c: 0 }, { r: 9, c: 4 }],
  ] : [[{ r: 2, c: 3 }, { r: 2, c: 4 }]];
  seedCompletedFixture(chess, board, 'red', moves);
}

function seedCompletedFixture(chess, board, sideToMove, moves) {
  chess.setMode('pvp');
  chess.resetTo(board, sideToMove);
  let index = 0;
  const advance = () => {
    if (index >= moves.length) return;
    if (chess.busy) {
      setTimeout(advance, 30);
      return;
    }
    const [from, to] = moves[index++];
    chess.doMove(from, to);
    setTimeout(advance, 30);
  };
  advance();
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
  const reviewEvidence = chess.gameReviewEvidence;
  const reviewCoach = chess.gameReviewCoach;
  const teaching = document.getElementById('gameReviewTeaching');
  const coachButton = document.getElementById('btnGameReviewCoach');
  const coachStatus = document.getElementById('gameReviewCoachStatus');
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
    reviewEvidence,
    reviewTeaching: teaching ? {
      visible: !teaching.classList.contains('hidden'),
      title: document.getElementById('gameReviewTeachingTitle')?.textContent || '',
      body: document.getElementById('gameReviewTeachingBody')?.textContent || '',
    } : null,
    reviewCoach: {
      state: reviewCoach,
      buttonVisible: !!coachButton && !coachButton.classList.contains('hidden'),
      buttonDisabled: !!coachButton?.disabled,
      buttonBusy: coachButton?.getAttribute('aria-busy') || null,
      buttonHeight: coachButton?.getBoundingClientRect().height || 0,
      leadIn: document.getElementById('gameReviewCoachLeadIn')?.textContent || '',
      encouragement: document.getElementById('gameReviewCoachEncouragement')?.textContent || '',
      status: coachStatus?.textContent || '',
      activeElementId: document.activeElement?.id || '',
      requestCount: reviewCoachRequestCount,
      activeCount: reviewCoachActiveCount,
      maxActiveCount: reviewCoachMaxActiveCount,
    },
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
