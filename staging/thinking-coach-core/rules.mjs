import { legalMoves, applyMove, inCheck, hashBoard, repetitionVerdict } from '../../game.js';
import { validateCustomPlayPosition } from '../../custom-position-play.js';
import { copyData, exact, fingerprint, freeze, identifier, requireCondition, stable } from './identity.mjs';

export const EVIDENCE_KIND = freeze({
  FACT: 'CANONICAL_FACT', SEARCH: 'ENGINE_SEARCH_EVIDENCE', HYPOTHESIS: 'UNPROVEN_HYPOTHESIS',
});

const otherSide = side => side === 'red' ? 'black' : 'red';
const positionKey = (board, side) => `${hashBoard(board)}|${side}`;

export function canonicalMove(input) {
  const move = copyData(input);
  exact(move, ['from', 'to']);
  for (const point of [move.from, move.to]) {
    exact(point, ['r', 'c']);
    requireCondition(Number.isInteger(point.r) && point.r >= 0 && point.r < 10
      && Number.isInteger(point.c) && point.c >= 0 && point.c < 9, 'INVALID_COORDINATE');
  }
  return freeze(move);
}

export function allLegalMoves(board, side) {
  const moves = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    if (board[r][c]?.side !== side) continue;
    for (const to of legalMoves(board, r, c)) moves.push({ from: { r, c }, to: { r: to.r, c: to.c } });
  }
  return freeze(moves);
}

export const sameMove = (a, b) => stable(a) === stable(b);

function position(board, sideToMove, history, completeness, capture = null, lastMove = null) {
  const replies = allLegalMoves(board, sideToMove);
  const checked = inCheck(board, sideToMove);
  const boardTerminal = replies.length === 0 ? {
    winner: otherSide(sideToMove), reason: checked ? 'checkmate' : 'stalemate',
  } : null;
  // Missing history never becomes a full-game repetition judgment.
  const verdict = completeness === 'complete'
    ? repetitionVerdict(history, positionKey(board, sideToMove)) : null;
  const terminal = boardTerminal || (verdict ? {
    winner: verdict.result === 'loss' ? otherSide(verdict.loser) : null,
    reason: verdict.result === 'loss' ? 'perpetual-check'
      : verdict.reason === '雙方長將' ? 'mutual-perpetual-check' : 'threefold-repetition',
  } : null);
  return freeze({ board, sideToMove, history, completeness, capture, lastMove,
    checked, boardTerminal, terminal,
    terminalScope: completeness === 'complete' ? 'declared-game-root' : 'position-only',
    historyAdjudication: completeness === 'complete' ? 'VERIFIED_FROM_DECLARED_ROOT' : 'NOT_PROVEN',
    legalMoves: terminal ? [] : replies,
    positionFingerprint: fingerprint({ board, sideToMove, history, completeness }),
  });
}

export function advance(current, inputMove) {
  requireCondition(!current.terminal, 'TERMINAL_POSITION');
  const move = canonicalMove(inputMove);
  requireCondition(current.legalMoves.some(candidate => sameMove(candidate, move)), 'ILLEGAL_MOVE');
  const board = copyData(current.board);
  const capture = applyMove(board, move.from, move.to);
  const side = otherSide(current.sideToMove);
  const history = [...current.history, { key: positionKey(board, side), mover: current.sideToMove,
    check: inCheck(board, side) }];
  return position(board, side, history, current.completeness, capture, move);
}

function validatedBoard(board, sideToMove) {
  const validation = validateCustomPlayPosition({ initialBoard: board, sideToMove });
  requireCondition(validation.ok, validation.error?.code || 'INVALID_POSITION');
  return validation.position.board;
}

export function prepareSource(input) {
  const source = copyData(input);
  exact(source, ['sourceId', 'sourceSessionId', 'board', 'sideToMove', 'history']);
  identifier(source.sourceId);
  identifier(source.sourceSessionId);
  const board = validatedBoard(source.board, source.sideToMove);
  const history = source.history;
  requireCondition(history && ['complete', 'partial', 'unknown'].includes(history.kind), 'INVALID_HISTORY');
  let current;
  if (history.kind === 'unknown') {
    exact(history, ['kind']);
    current = position(board, source.sideToMove, [{ key: positionKey(board, source.sideToMove),
      mover: null, check: false }], 'unknown');
  } else {
    exact(history, ['kind', 'root', 'moves']);
    exact(history.root, ['board', 'sideToMove']);
    requireCondition(Array.isArray(history.moves) && history.moves.length <= 1024, 'HISTORY_LIMIT');
    const root = validatedBoard(history.root.board, history.root.sideToMove);
    current = position(root, history.root.sideToMove, [{ key: positionKey(root, history.root.sideToMove),
      mover: null, check: false }], history.kind);
    for (const move of history.moves) current = advance(current, move);
    requireCondition(stable(current.board) === stable(board)
      && current.sideToMove === source.sideToMove, 'HISTORY_MISMATCH');
    requireCondition(!current.terminal, 'TERMINAL_SOURCE');
  }
  // Normalize supplied objects before fingerprinting; full history participates in identity.
  const canonical = { ...source, board, history: copyData(history) };
  return freeze({ source: canonical, sourceFingerprint: fingerprint(canonical), position: current });
}

export function facts(current, identity) {
  return freeze({ kind: EVIDENCE_KIND.FACT, identity, legal: true,
    checked: current.checked, capture: current.capture, legalReplyCount: current.legalMoves.length,
    terminal: current.terminal, terminalScope: current.terminalScope,
    historyAdjudication: current.historyAdjudication,
    scope: 'verified-position-and-immediate-replies',
  });
}
