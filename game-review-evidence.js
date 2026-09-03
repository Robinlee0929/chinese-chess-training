import {
  RED,
  BLACK,
  legalMoves,
  notation,
  inCheck,
  name,
  repetitionVerdict,
} from './game.js?v=51be239e94';
import { createGameAnalysis, applyGameAnalysisMove } from './game-analysis.js?v=51be239e94';

export const GAME_REVIEW_EVIDENCE_KIND = 'review-move-comparison';
export const GAME_REVIEW_EVIDENCE_CANONICAL = 'CANONICAL_FACT';
export const GAME_REVIEW_EVIDENCE_ENGINE = 'ENGINE_SEARCH_EVIDENCE';

const PIECE_TYPES = Object.freeze(['K', 'A', 'B', 'N', 'R', 'C', 'P']);
const REPETITION_TERMINATIONS = new Set([
  'perpetual-check',
  'threefold-repetition',
  'mutual-perpetual-check',
]);

export function createGameReviewEvidence(review, r3aState) {
  try {
    if (!eligibleIdentity(review, r3aState)) return null;
    const selectedPly = review.selectedPly;
    const playedMove = review.record.moves[selectedPly];
    const candidateMove = r3aState.candidate;
    const anchor = createGameAnalysis(review.record, selectedPly);
    if (!sameBoard(anchor.anchorBoard, review.snapshot.board)
      || anchor.anchorSideToMove !== review.snapshot.sideToMove
      || !sameRepetitionHistory(anchor.anchorRepetitionHistory, review.snapshot.repetitionHistory)) {
      return null;
    }

    const materialBefore = countPieces(review.snapshot.board);
    const sameMove = sameCoordinates(playedMove, candidateMove);
    const played = deriveOutcome(anchor, playedMove, materialBefore);
    const candidate = sameMove ? played : deriveOutcome(anchor, candidateMove, materialBefore);
    if (r3aState.candidate.notation !== candidate.notation) return null;

    return Object.freeze({
      kind: GAME_REVIEW_EVIDENCE_KIND,
      evidenceType: GAME_REVIEW_EVIDENCE_CANONICAL,
      source: Object.freeze({
        recordId: review.record.id,
        ply: selectedPly,
        sideToMove: review.snapshot.sideToMove,
        positionKey: review.snapshot.repetitionHistory.at(-1).key,
        r3aRevision: r3aState.revision,
      }),
      candidateProvenance: Object.freeze({
        evidenceType: GAME_REVIEW_EVIDENCE_ENGINE,
        preset: r3aState.request.analysisPreset,
        completedDepth: r3aState.candidate.depth,
      }),
      materialBefore,
      played,
      candidate,
      comparison: Object.freeze({
        status: sameMove ? 'MATCH' : 'DIFFERENT',
        sameMove,
      }),
    });
  } catch {
    return null;
  }
}

function eligibleIdentity(review, state) {
  if (!review || typeof review !== 'object' || !review.record || !review.snapshot
    || !Number.isInteger(review.selectedPly) || review.selectedPly < 0
    || review.selectedPly >= review.record.moves?.length
    || !review.record.moves[review.selectedPly] || review.snapshot.terminal
    || review.snapshot.selectedPly !== review.selectedPly
    || review.snapshot.sideToMove !== RED && review.snapshot.sideToMove !== BLACK
    || !Array.isArray(review.snapshot.board) || !Array.isArray(review.snapshot.repetitionHistory)
    || review.snapshot.repetitionHistory.length === 0) return false;
  if (!state || state.status !== 'success' || !Number.isInteger(state.revision)
    || !state.request || !state.candidate || state.request.kind !== 'review-candidate'
    || state.request.recordId !== review.record.id
    || state.request.ply !== review.selectedPly
    || state.request.revision !== state.revision
    || state.request.analysisPreset !== 'review-v1'
    || state.request.sideToMove !== review.snapshot.sideToMove
    || !Number.isInteger(state.candidate.depth) || state.candidate.depth < 1
    || state.candidate.depth > 3
    || !sameBoard(state.request.board, review.snapshot.board)
    || !sameRepetitionHistory(state.request.repetitionPrefix, review.snapshot.repetitionHistory)) {
    return false;
  }
  return state.request.repetitionPrefix.at(-1).key === review.snapshot.repetitionHistory.at(-1).key;
}

function deriveOutcome(anchor, move, materialBefore) {
  const from = cloneCoordinate(move.from);
  const to = cloneCoordinate(move.to);
  const sourceBoard = anchor.anchorBoard;
  const movedPiece = sourceBoard[from.r]?.[from.c];
  if (!movedPiece || movedPiece.side !== anchor.anchorSideToMove) throw new TypeError('Wrong mover.');
  const legal = legalMoves(sourceBoard, from.r, from.c)
    .some(({ r, c }) => r === to.r && c === to.c);
  if (!legal) throw new TypeError('Illegal comparison move.');

  const captured = clonePiece(sourceBoard[to.r][to.c]);
  const branch = applyGameAnalysisMove(anchor, from, to);
  const givesCheck = inCheck(branch.currentBoard, branch.currentSide);
  const materialAfter = countPieces(branch.currentBoard);
  const terminal = branch.terminal === null ? null : Object.freeze({ ...branch.terminal });
  const branchRepetitionVerdict = terminal && REPETITION_TERMINATIONS.has(terminal.terminationReason)
    ? repetitionVerdict(branch.repetitionHistory, branch.repetitionHistory.at(-1).key)
    : null;
  const replies = terminal ? null : enumerateReplies(branch.currentBoard, branch.currentSide);

  return Object.freeze({
    evidenceType: GAME_REVIEW_EVIDENCE_CANONICAL,
    move: freezeMove({ from, to }),
    movedPiece: freezePieceIdentity(movedPiece),
    notation: notation(sourceBoard, from, to),
    legal: true,
    capture: captured === null ? null : freezePieceIdentity(captured),
    givesCheck,
    sideToMoveAfter: branch.currentSide,
    terminal,
    repetitionVerdict: branchRepetitionVerdict === null
      ? null : Object.freeze({ ...branchRepetitionVerdict }),
    materialAfter,
    materialDeltaBySide: materialDelta(materialBefore, materialAfter),
    legalReplyCount: replies?.length ?? null,
    movedPieceCaptureReplies: replies === null
      ? null
      : Object.freeze(replies.filter((reply) => (
        reply.move.to.r === to.r && reply.move.to.c === to.c
      ))),
  });
}

function enumerateReplies(board, side) {
  const replies = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      const piece = board[r][c];
      if (!piece || piece.side !== side) continue;
      for (const to of legalMoves(board, r, c)) {
        const from = { r, c };
        replies.push(Object.freeze({
          move: freezeMove({ from, to }),
          notation: notation(board, from, to),
        }));
      }
    }
  }
  return replies;
}

function countPieces(board) {
  const counts = {
    [RED]: emptyCounts(),
    [BLACK]: emptyCounts(),
  };
  for (const row of board) {
    for (const piece of row) if (piece) counts[piece.side][piece.type]++;
  }
  return freezeCountsBySide(counts);
}

function materialDelta(before, after) {
  const delta = { [RED]: {}, [BLACK]: {} };
  for (const side of [RED, BLACK]) {
    for (const type of PIECE_TYPES) {
      const difference = after[side][type] - before[side][type];
      if (difference !== 0) delta[side][type] = difference;
    }
    Object.freeze(delta[side]);
  }
  return Object.freeze(delta);
}

function emptyCounts() {
  return { K: 0, A: 0, B: 0, N: 0, R: 0, C: 0, P: 0 };
}

function freezeCountsBySide(counts) {
  return Object.freeze({
    [RED]: Object.freeze({ ...counts[RED] }),
    [BLACK]: Object.freeze({ ...counts[BLACK] }),
  });
}

function freezePieceIdentity(piece) {
  return Object.freeze({ side: piece.side, type: piece.type, name: name(piece.side, piece.type) });
}

function freezeMove(move) {
  return Object.freeze({
    from: Object.freeze(cloneCoordinate(move.from)),
    to: Object.freeze(cloneCoordinate(move.to)),
  });
}

function cloneCoordinate(coordinate) {
  if (!coordinate || !Number.isInteger(coordinate.r) || !Number.isInteger(coordinate.c)) {
    throw new TypeError('Invalid coordinate.');
  }
  return { r: coordinate.r, c: coordinate.c };
}

function clonePiece(piece) {
  return piece === null ? null : { side: piece.side, type: piece.type };
}

function sameCoordinates(a, b) {
  return !!a && !!b && a.from?.r === b.from?.r && a.from?.c === b.from?.c
    && a.to?.r === b.to?.r && a.to?.c === b.to?.c;
}

function sameBoard(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (!Array.isArray(a[r]) || !Array.isArray(b[r]) || a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c++) {
      const left = a[r][c];
      const right = b[r][c];
      if (left === null || right === null) {
        if (left !== right) return false;
      } else if (left.type !== right.type || left.side !== right.side) return false;
    }
  }
  return true;
}

function sameRepetitionHistory(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && a.every((entry, index) => {
      const other = b[index];
      return !!entry && !!other && entry.key === other.key
        && entry.mover === other.mover && entry.check === other.check;
    });
}
