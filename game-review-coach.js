export const GAME_REVIEW_COACH_VERSION = 1;
export const GAME_REVIEW_COACH_LOCALE = 'zh-Hant';
export const GAME_REVIEW_COACH_STYLE = 'child-neutral-teacher-v1';
export const GAME_REVIEW_COACH_MAX_SEGMENT_CODEPOINTS = 24;
export const GAME_REVIEW_COACH_MAX_GENERATED_CODEPOINTS = 48;
export const GAME_REVIEW_COACH_ALLOWED_RULES = Object.freeze([
  'immediate-mate',
  'immediate-repetition-terminal',
  'immediate-stalemate',
  'check-difference',
  'capture-with-capture-reply',
  'capture-difference',
  'moved-piece-capturable-difference',
]);

const TEACHING_KIND = 'review-teaching-message';
const TEACHING_VERSION = 1;
const TEACHING_TONE = 'child-neutral-zh-Hant';
const TEACHING_CONFIDENCE = 'canonical';
const TEACHING_KEYS = Object.freeze([
  'kind', 'version', 'ruleId', 'priority', 'title', 'body',
  'evidenceRefs', 'source', 'tone', 'confidence',
]);
const SOURCE_KEYS = Object.freeze(['recordId', 'ply', 'positionKey', 'r3aRevision']);
const RESPONSE_KEYS = Object.freeze([
  'version', 'requestId', 'sourceRuleId', 'style', 'framing',
]);
const FRAMING_KEYS = Object.freeze(['leadIn', 'encouragement']);
const STATE_KEYS = Object.freeze([
  'version', 'status', 'revision', 'identity', 'request', 'framing',
]);
const IDENTITY_KEYS = Object.freeze([
  'recordId', 'ply', 'positionKey', 'r3aRevision', 'teachingVersion',
  'ruleId', 'teachingFingerprint', 'coachRevision',
]);
const STATE_REQUEST_KEYS = Object.freeze(['requestId', 'sourceRuleId', 'style']);
const PRIORITIES = Object.freeze({
  'immediate-mate': 900,
  'immediate-repetition-terminal': 850,
  'immediate-stalemate': 800,
  'check-difference': 700,
  'capture-with-capture-reply': 650,
  'capture-difference': 600,
  'moved-piece-capturable-difference': 500,
});
const QUALITY_TERMS = Object.freeze([
  '最佳著', '最佳', '最好', '比較好', '比較差', '失誤', '大錯', '大漏著',
  '白送', '掉子', '懸子', '優勢', '勝率', '評分', '評估值', '評估', '分數',
]);
const CHESS_FACT_TERMS = Object.freeze([
  '將軍', '將死', '困斃', '長將', '重複', '判和', '判負', '獲勝', '吃',
  '這步', '此步', '那步', '實戰', '候選', '走法', '著法', '棋步',
  '紅方', '黑方', '對方', '局面', '棋子',
]);
const ENGLISH_QUALITY = /\b(?:score|evaluation|depth|pv|best|blunder|mistake)\b/i;
const URL_OR_SCHEME = /(?:https?:\/\/|www\.|javascript\s*:|data\s*:)/i;
const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/u;
const QUOTE_OR_BRACKET = /[「」『』【】\[\]{}]/u;
const MOVE_NOTATION = /(?:[前中後]?[車馬炮砲俥傌相象仕士帥將兵卒][一二三四五六七八九][平進退][一二三四五六七八九])/u;
const COORDINATE_LIKE = /(?:[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十Ａ-Ｚ][一二三四五六七八九十])/u;
const NON_CHESS_HOMOGRAPHS = /(?:相信|互相|相同|將來|即將|馬上|士氣)/gu;
const PIECE_VOCABULARY = /[車馬炮砲俥傌相象仕士帥將兵卒]/u;
const CONTROL_OR_MULTILINE = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_FRAMING_CHARACTER = /^(?:\p{Script=Han}|\p{Extended_Pictographic}|\p{Punctuation}|\p{Separator})$/u;
const STATUSES = Object.freeze(['disabled', 'idle', 'loading', 'success']);

export function createDisabledCoachState(revision = 0) {
  return createEmptyState('disabled', validRevision(revision) ? revision : 0);
}

export function createIdleCoachState(revision = 0) {
  return createEmptyState('idle', validRevision(revision) ? revision : 0);
}

export function createTeachingFingerprint(teachingMessage) {
  try {
    if (!validTeachingMessage(teachingMessage)) return null;
    const canonical = JSON.stringify([
      teachingMessage.version,
      teachingMessage.ruleId,
      teachingMessage.title,
      teachingMessage.body,
      teachingMessage.tone,
      teachingMessage.confidence,
    ]);
    let hash = 0xcbf29ce484222325n;
    for (const character of canonical) {
      hash ^= BigInt(character.codePointAt(0));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `r3c2-${hash.toString(16).padStart(16, '0')}`;
  } catch {
    return null;
  }
}

export function createCoachRequestPayload(teachingMessage, requestId) {
  try {
    if (!validTeachingMessage(teachingMessage) || !validRequestId(requestId)) return null;
    const payload = {
      version: GAME_REVIEW_COACH_VERSION,
      requestId,
      locale: GAME_REVIEW_COACH_LOCALE,
      sourceRuleId: teachingMessage.ruleId,
      style: GAME_REVIEW_COACH_STYLE,
    };
    return deepFreeze(payload);
  } catch {
    return null;
  }
}

export function beginCoachRequest(options) {
  try {
    if (!exactKeys(options, ['state', 'teachingMessage', 'requestId'])) {
      return rejectedBegin(createDisabledCoachState(), 'INVALID_ARGUMENTS');
    }
    const { state, teachingMessage, requestId } = options;
    if (!validCoachState(state)) return rejectedBegin(createDisabledCoachState(), 'INVALID_STATE');
    if (state.status === 'disabled') return rejectedBegin(state, 'DISABLED');
    if (state.status === 'loading') return rejectedBegin(state, 'ALREADY_LOADING');
    if (!validTeachingMessage(teachingMessage)) {
      return rejectedBegin(state, 'INVALID_TEACHING_MESSAGE');
    }
    const request = createCoachRequestPayload(teachingMessage, requestId);
    if (!request) return rejectedBegin(state, 'INVALID_REQUEST_ID');

    const revision = state.revision + 1;
    const identity = createIdentity(teachingMessage, revision);
    if (!identity) return rejectedBegin(state, 'INVALID_TEACHING_MESSAGE');
    const requestMetadata = deepFreeze({
      requestId: request.requestId,
      sourceRuleId: request.sourceRuleId,
      style: request.style,
    });
    const nextState = deepFreeze({
      version: GAME_REVIEW_COACH_VERSION,
      status: 'loading',
      revision,
      identity,
      request: requestMetadata,
      framing: null,
    });
    return deepFreeze({ accepted: true, state: nextState, request, reason: null });
  } catch {
    return rejectedBegin(createDisabledCoachState(), 'INVALID_ARGUMENTS');
  }
}

export function settleCoachResponse(options) {
  try {
    if (!exactKeys(options, ['state', 'currentTeachingMessage', 'response'])) {
      return rejectedSettlement(createDisabledCoachState(), 'INVALID_ARGUMENTS');
    }
    const { state, currentTeachingMessage, response } = options;
    if (!validCoachState(state)) {
      return rejectedSettlement(createDisabledCoachState(), 'INVALID_STATE');
    }
    if (state.status !== 'loading') return rejectedSettlement(state, 'NOT_LOADING');
    if (!validTeachingMessage(currentTeachingMessage)) {
      return rejectedSettlement(state, 'STALE_TEACHING');
    }
    const currentIdentity = createIdentity(currentTeachingMessage, state.identity.coachRevision);
    if (!sameIdentity(state.identity, currentIdentity)) {
      return rejectedSettlement(state, 'STALE_TEACHING');
    }
    if (!validCoachResponse(response, state.request)) {
      return rejectedSettlement(state, 'INVALID_RESPONSE');
    }
    const successState = deepFreeze({
      version: GAME_REVIEW_COACH_VERSION,
      status: 'success',
      revision: state.revision,
      identity: state.identity,
      request: state.request,
      framing: {
        leadIn: response.framing.leadIn,
        encouragement: response.framing.encouragement,
      },
    });
    return deepFreeze({ accepted: true, state: successState, reason: null });
  } catch {
    return rejectedSettlement(createDisabledCoachState(), 'INVALID_ARGUMENTS');
  }
}

export function invalidateCoachState(state) {
  try {
    if (!validCoachState(state)) return createDisabledCoachState();
    const status = state.status === 'disabled' ? 'disabled' : 'idle';
    return createEmptyState(status, state.revision + 1);
  } catch {
    return createDisabledCoachState();
  }
}

function createEmptyState(status, revision) {
  return deepFreeze({
    version: GAME_REVIEW_COACH_VERSION,
    status,
    revision,
    identity: null,
    request: null,
    framing: null,
  });
}

function createIdentity(message, coachRevision) {
  const teachingFingerprint = createTeachingFingerprint(message);
  if (!teachingFingerprint) return null;
  return deepFreeze({
    recordId: message.source.recordId,
    ply: message.source.ply,
    positionKey: message.source.positionKey,
    r3aRevision: message.source.r3aRevision,
    teachingVersion: message.version,
    ruleId: message.ruleId,
    teachingFingerprint,
    coachRevision,
  });
}

function validTeachingMessage(message) {
  return exactKeys(message, TEACHING_KEYS)
    && message.kind === TEACHING_KIND
    && message.version === TEACHING_VERSION
    && GAME_REVIEW_COACH_ALLOWED_RULES.includes(message.ruleId)
    && message.priority === PRIORITIES[message.ruleId]
    && boundedNonemptyString(message.title, 12)
    && boundedNonemptyString(message.body, 72)
    && Array.isArray(message.evidenceRefs)
    && message.evidenceRefs.length > 0
    && message.evidenceRefs.every((value) => boundedNonemptyString(value, 200))
    && new Set(message.evidenceRefs).size === message.evidenceRefs.length
    && exactKeys(message.source, SOURCE_KEYS)
    && boundedNonemptyString(message.source.recordId, 200)
    && Number.isInteger(message.source.ply) && message.source.ply >= 0
    && boundedNonemptyString(message.source.positionKey, 1000)
    && Number.isInteger(message.source.r3aRevision) && message.source.r3aRevision >= 1
    && message.tone === TEACHING_TONE
    && message.confidence === TEACHING_CONFIDENCE;
}

function validCoachResponse(response, activeRequest) {
  return exactKeys(response, RESPONSE_KEYS)
    && response.version === GAME_REVIEW_COACH_VERSION
    && exactKeys(activeRequest, STATE_REQUEST_KEYS)
    && response.requestId === activeRequest.requestId
    && response.sourceRuleId === activeRequest.sourceRuleId
    && GAME_REVIEW_COACH_ALLOWED_RULES.includes(response.sourceRuleId)
    && response.style === activeRequest.style
    && response.style === GAME_REVIEW_COACH_STYLE
    && exactKeys(response.framing, FRAMING_KEYS)
    && validFraming(response.framing.leadIn)
    && validFraming(response.framing.encouragement)
    && codePointLength(response.framing.leadIn)
      + codePointLength(response.framing.encouragement)
      <= GAME_REVIEW_COACH_MAX_GENERATED_CODEPOINTS;
}

function validFraming(value) {
  if (!boundedNonemptyString(value, GAME_REVIEW_COACH_MAX_SEGMENT_CODEPOINTS)
    || value !== value.trim() || CONTROL_OR_MULTILINE.test(value)
    || /[<>]/u.test(value) || MARKDOWN_LINK.test(value) || URL_OR_SCHEME.test(value)
    || QUOTE_OR_BRACKET.test(value) || /[0-9]/u.test(value)
    || ENGLISH_QUALITY.test(value) || MOVE_NOTATION.test(value) || COORDINATE_LIKE.test(value)
    || PIECE_VOCABULARY.test(value.replace(NON_CHESS_HOMOGRAPHS, ''))) {
    return false;
  }
  for (const term of QUALITY_TERMS) if (value.includes(term)) return false;
  for (const term of CHESS_FACT_TERMS) if (value.includes(term)) return false;
  return Array.from(value).every((character) => SAFE_FRAMING_CHARACTER.test(character));
}

function validCoachState(state) {
  if (!exactKeys(state, STATE_KEYS) || !Object.isFrozen(state)
    || state.version !== GAME_REVIEW_COACH_VERSION || !STATUSES.includes(state.status)
    || !validRevision(state.revision)) return false;
  if (state.status === 'disabled' || state.status === 'idle') {
    return state.identity === null && state.request === null && state.framing === null;
  }
  if (!validIdentity(state.identity) || !Object.isFrozen(state.identity)
    || state.identity.coachRevision !== state.revision
    || !validStateRequest(state.request) || !Object.isFrozen(state.request)) return false;
  if (state.status === 'loading') return state.framing === null;
  return exactKeys(state.framing, FRAMING_KEYS) && Object.isFrozen(state.framing)
    && validFraming(state.framing.leadIn) && validFraming(state.framing.encouragement);
}

function validIdentity(identity) {
  return exactKeys(identity, IDENTITY_KEYS)
    && boundedNonemptyString(identity.recordId, 200)
    && Number.isInteger(identity.ply) && identity.ply >= 0
    && boundedNonemptyString(identity.positionKey, 1000)
    && Number.isInteger(identity.r3aRevision) && identity.r3aRevision >= 1
    && identity.teachingVersion === TEACHING_VERSION
    && GAME_REVIEW_COACH_ALLOWED_RULES.includes(identity.ruleId)
    && /^r3c2-[0-9a-f]{16}$/u.test(identity.teachingFingerprint)
    && validRevision(identity.coachRevision) && identity.coachRevision > 0;
}

function validStateRequest(request) {
  return exactKeys(request, STATE_REQUEST_KEYS)
    && validRequestId(request.requestId)
    && GAME_REVIEW_COACH_ALLOWED_RULES.includes(request.sourceRuleId)
    && request.style === GAME_REVIEW_COACH_STYLE;
}

function sameIdentity(left, right) {
  return !!left && !!right && IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function rejectedBegin(state, reason) {
  return deepFreeze({ accepted: false, state, request: null, reason });
}

function rejectedSettlement(state, reason) {
  return deepFreeze({ accepted: false, state, reason });
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRequestId(value) {
  return typeof value === 'string' && value === value.trim()
    && codePointLength(value) >= 1 && codePointLength(value) <= 64
    && !CONTROL_OR_MULTILINE.test(value) && !/\s/u.test(value);
}

function boundedNonemptyString(value, maxCodePoints) {
  return typeof value === 'string' && value.trim().length > 0
    && codePointLength(value) <= maxCodePoints;
}

function codePointLength(value) {
  return Array.from(value).length;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
