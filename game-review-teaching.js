export const GAME_REVIEW_TEACHING_KIND = 'review-teaching-message';
export const GAME_REVIEW_TEACHING_VERSION = 1;
export const GAME_REVIEW_TEACHING_TONE = 'child-neutral-zh-Hant';
export const GAME_REVIEW_TEACHING_CONFIDENCE = 'canonical';
export const GAME_REVIEW_TEACHING_MAX_MESSAGES = 1;

const EMPTY_MESSAGES = Object.freeze([]);
const EVIDENCE_KIND = 'review-move-comparison';
const CANONICAL_FACT = 'CANONICAL_FACT';
const SIDES = Object.freeze(['red', 'black']);
const TYPES = Object.freeze(['K', 'A', 'B', 'N', 'R', 'C', 'P']);
const PIECE_NAMES = Object.freeze({
  red: Object.freeze({ K: '帥', A: '仕', B: '相', N: '傌', R: '俥', C: '炮', P: '兵' }),
  black: Object.freeze({ K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' }),
});
const REPETITION_REASONS = new Set([
  'threefold-repetition',
  'perpetual-check',
  'mutual-perpetual-check',
]);
const TERMINATION_REASONS = new Set([
  'checkmate',
  'stalemate',
  ...REPETITION_REASONS,
]);
const PRIORITIES = Object.freeze({
  'same-move': 1000,
  'immediate-mate': 900,
  'immediate-repetition-terminal': 850,
  'immediate-stalemate': 800,
  'check-difference': 700,
  'capture-with-capture-reply': 650,
  'capture-difference': 600,
  'moved-piece-capturable-difference': 500,
});
const TITLE_LIMIT = 12;
const BODY_LIMIT = 72;

export function deriveGameReviewTeaching(evidence) {
  try {
    if (!validEvidence(evidence)) return EMPTY_MESSAGES;
    if (evidence.comparison.sameMove) return EMPTY_MESSAGES;
    if (terminalFamilyConflict(evidence.played.terminal, evidence.candidate.terminal)) {
      return EMPTY_MESSAGES;
    }

    const selected = immediateMate(evidence)
      || immediateRepetitionTerminal(evidence)
      || immediateStalemate(evidence)
      || checkDifference(evidence)
      || captureWithReply(evidence)
      || captureDifference(evidence)
      || movedPieceCapturableDifference(evidence);
    if (!selected) return EMPTY_MESSAGES;
    const message = createMessage(evidence, selected);
    return message ? Object.freeze([message]) : EMPTY_MESSAGES;
  } catch {
    return EMPTY_MESSAGES;
  }
}

function validEvidence(evidence) {
  if (!plainObject(evidence) || evidence.kind !== EVIDENCE_KIND
    || evidence.evidenceType !== CANONICAL_FACT || !validSource(evidence.source)
    || !plainObject(evidence.comparison)
    || !['MATCH', 'DIFFERENT'].includes(evidence.comparison.status)
    || typeof evidence.comparison.sameMove !== 'boolean'
    || (evidence.comparison.status === 'MATCH') !== evidence.comparison.sameMove
    || !validOutcome(evidence.played, evidence.source.sideToMove)
    || !validOutcome(evidence.candidate, evidence.source.sideToMove)) return false;

  const coordinatesMatch = sameMove(evidence.played.move, evidence.candidate.move);
  return coordinatesMatch === evidence.comparison.sameMove;
}

function validSource(source) {
  return plainObject(source) && nonemptyString(source.recordId, 200)
    && Number.isInteger(source.ply) && source.ply >= 0
    && SIDES.includes(source.sideToMove)
    && nonemptyString(source.positionKey, 1000)
    && Number.isInteger(source.r3aRevision) && source.r3aRevision >= 1;
}

function validOutcome(outcome, mover) {
  if (!plainObject(outcome) || outcome.evidenceType !== CANONICAL_FACT
    || outcome.legal !== true || !validMove(outcome.move)
    || !validPiece(outcome.movedPiece) || outcome.movedPiece.side !== mover
    || !nonemptyString(outcome.notation, 24)
    || !(outcome.capture === null || validPiece(outcome.capture))
    || outcome.capture?.side === mover
    || typeof outcome.givesCheck !== 'boolean'
    || outcome.sideToMoveAfter !== otherSide(mover)
    || !validTerminal(outcome.terminal, outcome.repetitionVerdict, mover)) return false;

  if (outcome.terminal?.terminationReason === 'checkmate' && !outcome.givesCheck) return false;
  if (outcome.terminal?.terminationReason === 'stalemate' && outcome.givesCheck) return false;

  if (outcome.terminal) {
    return outcome.legalReplyCount === null && outcome.movedPieceCaptureReplies === null;
  }
  return Number.isInteger(outcome.legalReplyCount) && outcome.legalReplyCount >= 0
    && Array.isArray(outcome.movedPieceCaptureReplies)
    && outcome.movedPieceCaptureReplies.length <= outcome.legalReplyCount
    && outcome.movedPieceCaptureReplies.every((reply) => (
      validReply(reply) && sameCoordinate(reply.move.to, outcome.move.to)
    ));
}

function validTerminal(terminal, verdict, mover) {
  if (terminal === null) return verdict === null;
  if (!plainObject(terminal) || !TERMINATION_REASONS.has(terminal.terminationReason)
    || !(terminal.winner === null || SIDES.includes(terminal.winner))) return false;

  const reason = terminal.terminationReason;
  if (reason === 'checkmate' || reason === 'stalemate') {
    return terminal.winner === mover && verdict === null;
  }
  if (!plainObject(verdict) || typeof verdict.result !== 'string'
    || typeof verdict.reason !== 'string') return false;
  if (reason === 'threefold-repetition') {
    return terminal.winner === null && verdict.result === 'draw'
      && verdict.reason === '三次重複局面' && verdict.loser === undefined;
  }
  if (reason === 'mutual-perpetual-check') {
    return terminal.winner === null && verdict.result === 'draw'
      && verdict.reason === '雙方長將' && verdict.loser === undefined;
  }
  return verdict.result === 'loss' && verdict.reason === '長將'
    && verdict.loser === mover && terminal.winner === otherSide(mover);
}

function validReply(reply) {
  return plainObject(reply) && validMove(reply.move) && nonemptyString(reply.notation, 24);
}

function validPiece(piece) {
  return plainObject(piece) && SIDES.includes(piece.side) && TYPES.includes(piece.type)
    && piece.name === PIECE_NAMES[piece.side][piece.type];
}

function validMove(move) {
  return plainObject(move) && validCoordinate(move.from) && validCoordinate(move.to)
    && (move.from.r !== move.to.r || move.from.c !== move.to.c);
}

function validCoordinate(coordinate) {
  return plainObject(coordinate) && Number.isInteger(coordinate.r)
    && coordinate.r >= 0 && coordinate.r < 10 && Number.isInteger(coordinate.c)
    && coordinate.c >= 0 && coordinate.c < 9;
}

function immediateMate(evidence) {
  if (!terminalCombinationSupported(evidence, 'checkmate')) return null;
  const playedMate = evidence.played.terminal?.terminationReason === 'checkmate';
  const candidateMate = evidence.candidate.terminal?.terminationReason === 'checkmate';
  if (!playedMate && !candidateMate) return null;
  if (playedMate && candidateMate) {
    return selection('immediate-mate', '兩手都是一步將死', '兩手都會直接將死。', [
      'played.terminal.terminationReason', 'candidate.terminal.terminationReason',
    ]);
  }
  const branch = candidateMate ? 'candidate' : 'played';
  return selection(
    'immediate-mate',
    candidateMate ? '先找一步將死' : '實戰的一步將死',
    candidateMate
      ? `這個局面有一步將死：AI 候選「${evidence.candidate.notation}」會直接將死。`
      : `你的實戰著「${evidence.played.notation}」會直接將死。`,
    [`${branch}.notation`, `${branch}.terminal.terminationReason`, `${branch}.terminal.winner`],
  );
}

function immediateRepetitionTerminal(evidence) {
  const branches = terminalBranches(evidence, (reason) => REPETITION_REASONS.has(reason));
  if (branches.length === 0 || !terminalFamiliesOnly(evidence, 'repetition')) return null;
  const body = `${branches.map(({ key, outcome }) => repetitionClause(key, outcome)).join('；')}。`;
  const refs = branches.flatMap(({ key, outcome }) => {
    const base = [`${key}.notation`, `${key}.terminal.terminationReason`, `${key}.terminal.winner`,
      `${key}.repetitionVerdict.result`, `${key}.repetitionVerdict.reason`];
    if (outcome.terminal.terminationReason === 'perpetual-check') {
      base.push(`${key}.repetitionVerdict.loser`);
    }
    return base;
  });
  return selection('immediate-repetition-terminal', '注意重複局面', body, refs);
}

function repetitionClause(key, outcome) {
  const label = branchLabel(key);
  const move = `「${outcome.notation}」`;
  const reason = outcome.terminal.terminationReason;
  if (reason === 'threefold-repetition') return `${label}${move}會立即形成三次重複局面並判和`;
  if (reason === 'mutual-perpetual-check') return `${label}${move}會立即因雙方長將判和`;
  return `${label}${move}會立即觸發長將判負，${sideLabel(outcome.repetitionVerdict.loser)}方判負`;
}

function immediateStalemate(evidence) {
  const branches = terminalBranches(evidence, (reason) => reason === 'stalemate');
  if (branches.length === 0 || !terminalFamiliesOnly(evidence, 'stalemate')) return null;
  const body = `${branches.map(({ key, outcome }) => (
    `${branchLabel(key)}「${outcome.notation}」會立即形成困斃，${sideLabel(outcome.terminal.winner)}方獲勝`
  )).join('；')}。`;
  const refs = branches.flatMap(({ key }) => [
    `${key}.notation`, `${key}.terminal.terminationReason`, `${key}.terminal.winner`,
  ]);
  return selection('immediate-stalemate', '注意困斃結果', body, refs);
}

function checkDifference(evidence) {
  if (evidence.played.terminal || evidence.candidate.terminal
    || evidence.played.givesCheck === evidence.candidate.givesCheck) return null;
  const candidate = evidence.candidate.givesCheck;
  const key = candidate ? 'candidate' : 'played';
  return selection(
    'check-difference',
    candidate ? '先看看將軍手' : '實戰形成將軍',
    candidate
      ? `可以先檢查看看有沒有將軍手。AI 候選「${evidence.candidate.notation}」會形成將軍。`
      : `你的實戰著「${evidence.played.notation}」會形成將軍。遇到類似局面，也可以先檢查將軍手。`,
    ['played.givesCheck', 'candidate.givesCheck', `${key}.notation`,
      'played.terminal', 'candidate.terminal'],
  );
}

function captureWithReply(evidence) {
  if (evidence.played.terminal || evidence.candidate.terminal) return null;
  const played = hasCaptureWithReply(evidence.played);
  const candidate = hasCaptureWithReply(evidence.candidate);
  if (played === candidate) return null;
  const key = candidate ? 'candidate' : 'played';
  const outcome = evidence[key];
  const body = `${branchLabel(key)}「${outcome.notation}」會吃到一枚${pieceLabel(outcome.capture)}；`
    + `對方至少有一個合法回應可吃到剛移動的${pieceLabel(outcome.movedPiece)}。`;
  return selection('capture-with-capture-reply', '吃子後看對方回應', body, [
    `${key}.notation`, `${key}.capture.side`, `${key}.capture.name`,
    `${key}.movedPiece.side`, `${key}.movedPiece.name`, `${key}.movedPieceCaptureReplies`,
  ]);
}

function captureDifference(evidence) {
  if (evidence.played.terminal || evidence.candidate.terminal) return null;
  const played = evidence.played.capture;
  const candidate = evidence.candidate.capture;
  if (!played && !candidate) return null;
  if (played && candidate && samePieceClass(played, candidate)) return null;
  if (played && candidate) {
    return selection(
      'capture-difference',
      '兩手吃到不同棋子',
      `實戰著「${evidence.played.notation}」吃到一枚${pieceLabel(played)}；AI 候選「${evidence.candidate.notation}」吃到一枚${pieceLabel(candidate)}。`,
      ['played.notation', 'played.capture.side', 'played.capture.type', 'played.capture.name',
        'candidate.notation', 'candidate.capture.side', 'candidate.capture.type',
        'candidate.capture.name'],
    );
  }
  const key = candidate ? 'candidate' : 'played';
  const outcome = evidence[key];
  return selection(
    'capture-difference',
    candidate ? '看看立即吃子' : '實戰立即吃子',
    candidate
      ? `可以先檢查看看有沒有立即吃子的走法。AI 候選「${outcome.notation}」會吃到一枚${pieceLabel(outcome.capture)}。`
      : `你的實戰著「${outcome.notation}」會吃到一枚${pieceLabel(outcome.capture)}。`,
    [`${key}.notation`, `${key}.capture.side`, `${key}.capture.name`,
      `${key === 'candidate' ? 'played' : 'candidate'}.capture`],
  );
}

function movedPieceCapturableDifference(evidence) {
  if (evidence.played.terminal || evidence.candidate.terminal) return null;
  const played = evidence.played.movedPieceCaptureReplies.length > 0;
  const candidate = evidence.candidate.movedPieceCaptureReplies.length > 0;
  if (played === candidate) return null;
  const key = candidate ? 'candidate' : 'played';
  const outcome = evidence[key];
  return selection(
    'moved-piece-capturable-difference',
    '走完也看對方',
    `${branchLabel(key)}「${outcome.notation}」走完後，對方至少有一個合法回應可吃到剛移動的${pieceLabel(outcome.movedPiece)}。`
      + '這只是合法選擇，不代表對方會這樣走。',
    [`${key}.notation`, `${key}.movedPiece.side`, `${key}.movedPiece.name`,
      'played.movedPieceCaptureReplies', 'candidate.movedPieceCaptureReplies'],
  );
}

function terminalCombinationSupported(evidence, reason) {
  const reasons = [evidence.played.terminal?.terminationReason,
    evidence.candidate.terminal?.terminationReason].filter(Boolean);
  return reasons.length > 0 && reasons.every((value) => value === reason);
}

function terminalFamiliesOnly(evidence, family) {
  const terminals = [evidence.played.terminal, evidence.candidate.terminal].filter(Boolean);
  return terminals.length > 0 && terminals.every((terminal) => terminalFamily(terminal) === family);
}

function terminalFamilyConflict(left, right) {
  return !!left && !!right && terminalFamily(left) !== terminalFamily(right);
}

function terminalFamily(terminal) {
  if (!terminal) return null;
  if (terminal.terminationReason === 'checkmate') return 'checkmate';
  if (terminal.terminationReason === 'stalemate') return 'stalemate';
  return REPETITION_REASONS.has(terminal.terminationReason) ? 'repetition' : 'unsupported';
}

function terminalBranches(evidence, predicate) {
  return ['played', 'candidate'].flatMap((key) => {
    const outcome = evidence[key];
    return outcome.terminal && predicate(outcome.terminal.terminationReason)
      ? [{ key, outcome }]
      : [];
  });
}

function hasCaptureWithReply(outcome) {
  return outcome.capture !== null && outcome.movedPieceCaptureReplies.length > 0;
}

function selection(ruleId, title, body, evidenceRefs) {
  return { ruleId, priority: PRIORITIES[ruleId], title, body, evidenceRefs };
}

function createMessage(evidence, selected) {
  if (Array.from(selected.title).length > TITLE_LIMIT
    || Array.from(selected.body).length > BODY_LIMIT) return null;
  return deepFreeze({
    kind: GAME_REVIEW_TEACHING_KIND,
    version: GAME_REVIEW_TEACHING_VERSION,
    ruleId: selected.ruleId,
    priority: selected.priority,
    title: selected.title,
    body: selected.body,
    evidenceRefs: [...new Set([
      'source.recordId', 'source.ply', 'source.positionKey', 'source.r3aRevision',
      ...selected.evidenceRefs,
    ])],
    source: {
      recordId: evidence.source.recordId,
      ply: evidence.source.ply,
      positionKey: evidence.source.positionKey,
      r3aRevision: evidence.source.r3aRevision,
    },
    tone: GAME_REVIEW_TEACHING_TONE,
    confidence: GAME_REVIEW_TEACHING_CONFIDENCE,
  });
}

function sameMove(left, right) {
  return sameCoordinate(left.from, right.from) && sameCoordinate(left.to, right.to);
}

function sameCoordinate(left, right) {
  return left.r === right.r && left.c === right.c;
}

function samePieceClass(left, right) {
  return left.side === right.side && left.type === right.type;
}

function pieceLabel(piece) {
  return `${sideLabel(piece.side)}${piece.name}`;
}

function sideLabel(side) {
  return side === 'red' ? '紅' : '黑';
}

function branchLabel(key) {
  return key === 'candidate' ? 'AI 候選' : '你的實戰著';
}

function otherSide(side) {
  return side === 'red' ? 'black' : 'red';
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
