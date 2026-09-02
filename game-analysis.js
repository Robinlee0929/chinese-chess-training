import {
  RED,
  BLACK,
  legalMoves,
  applyMove,
  notation,
  inCheck,
  hasAnyLegalMove,
  hashBoard,
  repetitionVerdict,
} from './game.js?v=b35d58d934';
import { createGameRecord, replayGameRecord } from './game-record.js?v=b35d58d934';

const SIDES = new Set([RED, BLACK]);

export class GameAnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameAnalysisError';
    this.code = code;
  }
}

export function createGameAnalysis(record, sourcePly) {
  const sourceRecord = createGameRecord(record);
  const snapshot = replayGameRecord(sourceRecord, sourcePly);
  if (snapshot.terminal) {
    fail('TERMINAL_SOURCE', 'Analysis cannot begin from a terminal review position.');
  }
  return buildState({
    sourceRecord,
    sourcePly,
    anchorBoard: snapshot.board,
    anchorSide: snapshot.sideToMove,
    anchorRepetitionHistory: snapshot.repetitionHistory,
    moves: [],
    revision: 0,
  });
}

export function gameAnalysisLegalMoves(analysis, from) {
  requireAnalysis(analysis);
  const coordinate = requireCoordinate(from, 'from');
  if (analysis.terminal) return Object.freeze([]);
  const piece = analysis.currentBoard[coordinate.r][coordinate.c];
  if (!piece || piece.side !== analysis.currentSide) return Object.freeze([]);
  return Object.freeze(legalMoves(analysis.currentBoard, coordinate.r, coordinate.c)
    .map((move) => Object.freeze({ r: move.r, c: move.c })));
}

export function applyGameAnalysisMove(analysis, from, to) {
  requireAnalysis(analysis);
  if (analysis.terminal) fail('ANALYSIS_TERMINAL', 'No move may be made after analysis is terminal.');
  const source = requireCoordinate(from, 'from');
  const destination = requireCoordinate(to, 'to');
  const piece = analysis.currentBoard[source.r][source.c];
  if (!piece) fail('EMPTY_SOURCE', 'Analysis move starts from an empty square.');
  if (piece.side !== analysis.currentSide) fail('WRONG_SIDE', 'Analysis move uses the wrong side.');
  const legal = legalMoves(analysis.currentBoard, source.r, source.c)
    .some(({ r, c }) => r === destination.r && c === destination.c);
  if (!legal) fail('ILLEGAL_MOVE', 'Analysis move is not legal.');

  const move = {
    ply: analysis.moves.length + 1,
    side: analysis.currentSide,
    from: source,
    to: destination,
    captured: clonePiece(analysis.currentBoard[destination.r][destination.c]),
    notation: notation(analysis.currentBoard, source, destination),
  };
  return buildState({
    sourceRecord: analysis.sourceRecord,
    sourcePly: analysis.sourcePly,
    anchorBoard: analysis.anchorBoard,
    anchorSide: analysis.anchorSideToMove,
    anchorRepetitionHistory: analysis.anchorRepetitionHistory,
    moves: [...analysis.moves, move],
    revision: analysis.revision + 1,
  });
}

export function undoGameAnalysisMove(analysis) {
  requireAnalysis(analysis);
  if (analysis.moves.length === 0) return analysis;
  return buildState({
    sourceRecord: analysis.sourceRecord,
    sourcePly: analysis.sourcePly,
    anchorBoard: analysis.anchorBoard,
    anchorSide: analysis.anchorSideToMove,
    anchorRepetitionHistory: analysis.anchorRepetitionHistory,
    moves: analysis.moves.slice(0, -1),
    revision: analysis.revision + 1,
  });
}

export function resetGameAnalysis(analysis) {
  requireAnalysis(analysis);
  return buildState({
    sourceRecord: analysis.sourceRecord,
    sourcePly: analysis.sourcePly,
    anchorBoard: analysis.anchorBoard,
    anchorSide: analysis.anchorSideToMove,
    anchorRepetitionHistory: analysis.anchorRepetitionHistory,
    moves: [],
    revision: analysis.revision + 1,
  });
}

function buildState({
  sourceRecord,
  sourcePly,
  anchorBoard,
  anchorSide,
  anchorRepetitionHistory,
  moves,
  revision,
}) {
  const board = cloneBoard(anchorBoard);
  let sideToMove = anchorSide;
  const repetitionHistory = anchorRepetitionHistory.map(cloneRepetitionEntry);
  const builtMoves = [];
  let terminal = adjudicate(board, sideToMove, repetitionHistory);

  for (const inputMove of moves) {
    if (terminal) fail('MOVE_AFTER_TERMINAL', 'Analysis line contains a move after terminal.');
    const piece = board[inputMove.from.r][inputMove.from.c];
    if (!piece || piece.side !== sideToMove) fail('INVALID_ANALYSIS_LINE', 'Analysis line cannot be replayed.');
    const legal = legalMoves(board, inputMove.from.r, inputMove.from.c)
      .some(({ r, c }) => r === inputMove.to.r && c === inputMove.to.c);
    if (!legal) fail('INVALID_ANALYSIS_LINE', 'Analysis line contains an illegal move.');
    const mover = sideToMove;
    const derivedNotation = notation(board, inputMove.from, inputMove.to);
    const captured = clonePiece(board[inputMove.to.r][inputMove.to.c]);
    applyMove(board, inputMove.from, inputMove.to);
    sideToMove = opposite(sideToMove);
    const checked = inCheck(board, sideToMove);
    const positionHash = hashBoard(board);
    repetitionHistory.push({
      key: `${positionHash}|${sideToMove}`,
      mover,
      check: checked,
    });
    terminal = adjudicate(board, sideToMove, repetitionHistory, checked);
    builtMoves.push({
      ply: builtMoves.length + 1,
      side: mover,
      from: cloneCoordinate(inputMove.from),
      to: cloneCoordinate(inputMove.to),
      captured,
      notation: derivedNotation,
    });
  }

  return freezeState({
    sourceRecord,
    sourceRecordId: sourceRecord.id,
    sourcePly,
    anchorBoard,
    anchorSideToMove: anchorSide,
    anchorRepetitionHistory,
    currentBoard: board,
    currentSide: sideToMove,
    moves: builtMoves,
    repetitionHistory,
    terminal,
    revision,
  });
}

function adjudicate(board, sideToMove, repetitionHistory, knownCheck) {
  const checked = knownCheck === undefined ? inCheck(board, sideToMove) : knownCheck;
  if (!hasAnyLegalMove(board, sideToMove)) {
    return {
      winner: opposite(sideToMove),
      terminationReason: checked ? 'checkmate' : 'stalemate',
    };
  }
  const key = repetitionHistory.at(-1).key;
  const verdict = repetitionVerdict(repetitionHistory, key);
  if (!verdict) return null;
  if (verdict.result === 'loss') {
    return { winner: opposite(verdict.loser), terminationReason: 'perpetual-check' };
  }
  return {
    winner: null,
    terminationReason: verdict.reason === '雙方長將'
      ? 'mutual-perpetual-check'
      : 'threefold-repetition',
  };
}

function requireAnalysis(analysis) {
  if (!analysis || typeof analysis !== 'object' || !analysis.sourceRecord
    || !Number.isInteger(analysis.sourcePly) || !Array.isArray(analysis.currentBoard)
    || !SIDES.has(analysis.currentSide) || !Array.isArray(analysis.moves)
    || !Array.isArray(analysis.repetitionHistory)) {
    throw new TypeError('A valid game analysis state is required.');
  }
}

function requireCoordinate(coordinate, label) {
  if (!coordinate || typeof coordinate !== 'object'
    || !Number.isInteger(coordinate.r) || !Number.isInteger(coordinate.c)
    || coordinate.r < 0 || coordinate.r >= 10 || coordinate.c < 0 || coordinate.c >= 9) {
    fail('INVALID_COORDINATE', `Analysis ${label} coordinate is invalid.`);
  }
  return { r: coordinate.r, c: coordinate.c };
}

function freezeState(state) {
  return Object.freeze({
    sourceRecord: state.sourceRecord,
    sourceRecordId: state.sourceRecordId,
    sourcePly: state.sourcePly,
    anchorBoard: freezeBoard(state.anchorBoard),
    anchorSideToMove: state.anchorSideToMove,
    anchorRepetitionHistory: freezeRepetitionHistory(state.anchorRepetitionHistory),
    currentBoard: freezeBoard(state.currentBoard),
    currentSide: state.currentSide,
    moves: Object.freeze(state.moves.map(freezeMove)),
    repetitionHistory: freezeRepetitionHistory(state.repetitionHistory),
    terminal: state.terminal === null ? null : Object.freeze({ ...state.terminal }),
    revision: state.revision,
  });
}

function freezeMove(move) {
  return Object.freeze({
    ply: move.ply,
    side: move.side,
    from: Object.freeze(cloneCoordinate(move.from)),
    to: Object.freeze(cloneCoordinate(move.to)),
    captured: move.captured === null ? null : Object.freeze(clonePiece(move.captured)),
    notation: move.notation,
  });
}

function freezeBoard(board) {
  return Object.freeze(cloneBoard(board).map((row) => Object.freeze(row.map((piece) => (
    piece === null ? null : Object.freeze(piece)
  )))));
}

function freezeRepetitionHistory(history) {
  return Object.freeze(history.map((entry) => Object.freeze(cloneRepetitionEntry(entry))));
}

function cloneBoard(board) {
  return board.map((row) => row.map(clonePiece));
}

function clonePiece(piece) {
  return piece === null ? null : { type: piece.type, side: piece.side };
}

function cloneCoordinate(coordinate) {
  return { r: coordinate.r, c: coordinate.c };
}

function cloneRepetitionEntry(entry) {
  return { key: entry.key, mover: entry.mover, check: entry.check };
}

function opposite(side) {
  return side === RED ? BLACK : RED;
}

function fail(code, message) {
  throw new GameAnalysisError(code, message);
}
