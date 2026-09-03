export const GAME_REVIEW_COACH_VERSION = 2;
export const GAME_REVIEW_COACH_MODEL_PROFILES = Object.freeze(['economy', 'balanced', 'quality']);
export const GAME_REVIEW_COACH_DEFAULT_PROFILE = 'economy';
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
  'version', 'requestId', 'sourceRuleId', 'style', 'modelProfile', 'framing',
]);
const FRAMING_KEYS = Object.freeze(['leadIn', 'encouragement']);
const STATE_KEYS = Object.freeze([
  'version', 'status', 'revision', 'identity', 'request', 'framing', 'modelProfile',
]);
const IDENTITY_KEYS = Object.freeze([
  'recordId', 'ply', 'positionKey', 'r3aRevision', 'teachingVersion',
  'ruleId', 'teachingFingerprint', 'coachRevision', 'modelProfile',
]);
const STATE_REQUEST_KEYS = Object.freeze(['requestId', 'sourceRuleId', 'style', 'modelProfile']);
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
  '將軍', '将军', '將死', '将死', '困斃', '困毙', '長將', '长将',
  '重複', '重复', '判和', '判負', '判负', '獲勝', '获胜', '吃',
  '這步', '此步', '那步', '實戰', '候選', '走法', '著法', '棋步',
  '紅方', '黑方', '對方', '局面', '棋子',
]);
const ENGLISH_QUALITY = /\b(?:score|evaluation|depth|pv|best|blunder|mistake)\b/i;
const URL_OR_SCHEME = /(?:https?:\/\/|www\.|javascript\s*:|data\s*:)/i;
const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/u;
const QUOTE_OR_BRACKET = /[「」『』【】\[\]{}]/u;
const MOVE_NOTATION = /(?:[前中後]?[車车馬马炮砲俥傌相象仕士帥帅將将兵卒][一二三四五六七八九][平進进退][一二三四五六七八九])/u;
const COORDINATE_LIKE = /(?:[甲乙丙丁戊己庚辛壬癸一二三四五六七八九十Ａ-Ｚ][一二三四五六七八九十])/u;
const SAFE_HOMOGRAPH_WORDS = Object.freeze(['相信', '互相', '相同', '將來', '即將', '馬上', '士氣']);
const PIECE_VOCABULARY = /[車车馬马炮砲俥傌相象仕士帥帅將将兵卒]/u;
const CHESS_CONTEXT_BEFORE = /[紅红黑棋前中後后車车馬马炮砲俥傌相象仕士帥帅將将兵卒]/u;
const CHESS_CONTEXT_AFTER = /[前後后左右進进退平移動动走吃攻守將将軍军棋步著着]/u;
const CONTROL_OR_MULTILINE = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_FRAMING_CHARACTER = /^(?:\p{Script=Han}|\p{Extended_Pictographic}|\p{Punctuation}|\p{Separator})$/u;
const STATUSES = Object.freeze(['disabled', 'idle', 'loading', 'success']);

export function createDisabledCoachState(revision = 0, modelProfile = GAME_REVIEW_COACH_DEFAULT_PROFILE) {
  return createEmptyState('disabled', validRevision(revision) ? revision : 0,
    validModelProfile(modelProfile) ? modelProfile : GAME_REVIEW_COACH_DEFAULT_PROFILE);
}

export function createIdleCoachState(revision = 0, modelProfile = GAME_REVIEW_COACH_DEFAULT_PROFILE) {
  return validRevision(revision) && validModelProfile(modelProfile)
    ? createEmptyState('idle', revision, modelProfile)
    : createDisabledCoachState();
}

export function createTeachingFingerprint(teachingMessage) {
  try {
    const message = snapshotTeachingMessage(teachingMessage);
    return message ? fingerprintFromSnapshot(message) : null;
  } catch {
    return null;
  }
}

export function createCoachRequestPayload(teachingMessage, requestId, modelProfile) {
  try {
    const message = snapshotTeachingMessage(teachingMessage);
    return message ? createCoachRequestPayloadFromSnapshot(message, requestId, modelProfile) : null;
  } catch {
    return null;
  }
}

export function beginCoachRequest(options) {
  try {
    const input = snapshotExactDataObject(options, ['state', 'teachingMessage', 'requestId', 'modelProfile']);
    if (!input) {
      return rejectedBegin(createDisabledCoachState(), 'INVALID_ARGUMENTS');
    }
    const state = snapshotCoachState(input.state);
    if (!state) return rejectedBegin(createDisabledCoachState(), 'INVALID_STATE');
    if (!validModelProfile(input.modelProfile) || input.modelProfile !== state.modelProfile) {
      return rejectedBegin(state, 'INVALID_MODEL_PROFILE');
    }
    if (state.status === 'disabled') return rejectedBegin(state, 'DISABLED');
    if (state.status === 'loading') return rejectedBegin(state, 'ALREADY_LOADING');
    const teachingMessage = snapshotTeachingMessage(input.teachingMessage);
    if (!teachingMessage) {
      return rejectedBegin(state, 'INVALID_TEACHING_MESSAGE');
    }
    const request = createCoachRequestPayloadFromSnapshot(teachingMessage, input.requestId, input.modelProfile);
    if (!request) return rejectedBegin(state, 'INVALID_REQUEST_ID');

    const revision = nextCoachRevision(state.revision);
    if (revision === null) {
      return rejectedBegin(createEmptyState('disabled', state.revision, state.modelProfile), 'REVISION_EXHAUSTED');
    }
    const identity = createIdentity(teachingMessage, revision, state.modelProfile);
    if (!identity) return rejectedBegin(state, 'INVALID_TEACHING_MESSAGE');
    const requestMetadata = deepFreeze({
      requestId: request.requestId,
      sourceRuleId: request.sourceRuleId,
      style: request.style,
      modelProfile: request.modelProfile,
    });
    const nextState = deepFreeze({
      version: GAME_REVIEW_COACH_VERSION,
      status: 'loading',
      modelProfile: state.modelProfile,
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
    const input = snapshotExactDataObject(
      options, ['state', 'currentTeachingMessage', 'response', 'currentModelProfile'],
    );
    if (!input) {
      return rejectedSettlement(createDisabledCoachState(), 'INVALID_ARGUMENTS');
    }
    const state = snapshotCoachState(input.state);
    if (!state) {
      return rejectedSettlement(createDisabledCoachState(), 'INVALID_STATE');
    }
    if (state.status !== 'loading') return rejectedSettlement(state, 'NOT_LOADING');
    if (!validModelProfile(input.currentModelProfile) || input.currentModelProfile !== state.modelProfile) {
      return rejectedSettlement(state, 'STALE_MODEL_PROFILE');
    }
    const currentTeachingMessage = snapshotTeachingMessage(input.currentTeachingMessage);
    if (!currentTeachingMessage) {
      return rejectedSettlement(state, 'STALE_TEACHING');
    }
    const currentIdentity = createIdentity(currentTeachingMessage, state.identity.coachRevision, input.currentModelProfile);
    if (!sameIdentity(state.identity, currentIdentity)) {
      return rejectedSettlement(state, 'STALE_TEACHING');
    }
    const response = snapshotCoachResponse(input.response, state.request);
    if (!response) {
      return rejectedSettlement(state, 'INVALID_RESPONSE');
    }
    const successState = deepFreeze({
      version: GAME_REVIEW_COACH_VERSION,
      status: 'success',
      modelProfile: state.modelProfile,
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
    const current = snapshotCoachState(state);
    if (!current) return createDisabledCoachState();
    const revision = nextCoachRevision(current.revision);
    if (revision === null) return createEmptyState('disabled', current.revision, current.modelProfile);
    const status = current.status === 'disabled' ? 'disabled' : 'idle';
    return createEmptyState(status, revision, current.modelProfile);
  } catch {
    return createDisabledCoachState();
  }
}

// Invalid selections leave a valid caller state untouched. Only validated snapshots
// are frozen; caller objects/accessors are never traversed by deepFreeze.
export function selectCoachModelProfile(state, nextProfile) {
  try {
    const current = snapshotCoachState(state);
    if (!current) return createDisabledCoachState();
    if (!validModelProfile(nextProfile) || nextProfile === current.modelProfile) return state;
    const revision = nextCoachRevision(current.revision);
    if (revision === null) return createEmptyState('disabled', current.revision, current.modelProfile);
    return createEmptyState(current.status === 'disabled' ? 'disabled' : 'idle', revision, nextProfile);
  } catch {
    return createDisabledCoachState();
  }
}

// An exact six-field transport check for adapters and historical-version fixtures.
export function validateCoachRequestPayload(payload) {
  try {
    const value = snapshotExactDataObject(payload,
      ['version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile']);
    return !!value && value.version === 2 && validRequestId(value.requestId)
      && value.locale === GAME_REVIEW_COACH_LOCALE
      && GAME_REVIEW_COACH_ALLOWED_RULES.includes(value.sourceRuleId)
      && value.style === GAME_REVIEW_COACH_STYLE && validModelProfile(value.modelProfile);
  } catch {
    return false;
  }
}

function validModelProfile(value) {
  return typeof value === 'string' && GAME_REVIEW_COACH_MODEL_PROFILES.includes(value);
}

function createEmptyState(status, revision, modelProfile = GAME_REVIEW_COACH_DEFAULT_PROFILE) {
  return deepFreeze({
    version: GAME_REVIEW_COACH_VERSION,
    status,
    modelProfile,
    revision,
    identity: null,
    request: null,
    framing: null,
  });
}

function createIdentity(message, coachRevision, modelProfile) {
  const teachingFingerprint = fingerprintFromSnapshot(message);
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
    modelProfile,
  });
}

function createCoachRequestPayloadFromSnapshot(message, requestId, modelProfile) {
  if (!validRequestId(requestId) || !validModelProfile(modelProfile)) return null;
  return deepFreeze({
    version: GAME_REVIEW_COACH_VERSION,
    requestId,
    locale: GAME_REVIEW_COACH_LOCALE,
    sourceRuleId: message.ruleId,
    style: GAME_REVIEW_COACH_STYLE,
    modelProfile,
  });
}

function fingerprintFromSnapshot(message) {
  const canonical = JSON.stringify([
    message.version,
    message.ruleId,
    message.title,
    message.body,
    message.tone,
    message.confidence,
  ]);
  let hash = 0xcbf29ce484222325n;
  for (const character of canonical) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `r3c2-${hash.toString(16).padStart(16, '0')}`;
}

function snapshotTeachingMessage(message) {
  const root = snapshotExactDataObject(message, TEACHING_KEYS);
  if (!root) return null;
  const source = snapshotExactDataObject(root.source, SOURCE_KEYS);
  const evidenceRefs = snapshotStringArray(root.evidenceRefs);
  if (!source || !evidenceRefs) return null;
  const snapshot = { ...root, evidenceRefs, source };
  if (!validTeachingSnapshot(snapshot)) return null;
  return deepFreeze(snapshot);
}

function validTeachingSnapshot(message) {
  return message.kind === TEACHING_KIND
    && message.version === TEACHING_VERSION
    && GAME_REVIEW_COACH_ALLOWED_RULES.includes(message.ruleId)
    && message.priority === PRIORITIES[message.ruleId]
    && boundedNonemptyString(message.title, 12)
    && boundedNonemptyString(message.body, 72)
    && Array.isArray(message.evidenceRefs)
    && message.evidenceRefs.length > 0
    && message.evidenceRefs.every((value) => boundedNonemptyString(value, 200))
    && new Set(message.evidenceRefs).size === message.evidenceRefs.length
    && boundedNonemptyString(message.source.recordId, 200)
    && Number.isInteger(message.source.ply) && message.source.ply >= 0
    && boundedNonemptyString(message.source.positionKey, 1000)
    && Number.isInteger(message.source.r3aRevision) && message.source.r3aRevision >= 1
    && message.tone === TEACHING_TONE
    && message.confidence === TEACHING_CONFIDENCE;
}

function snapshotCoachResponse(response, activeRequest) {
  const root = snapshotExactDataObject(response, RESPONSE_KEYS);
  if (!root) return null;
  const framing = snapshotExactDataObject(root.framing, FRAMING_KEYS);
  if (!framing) return null;
  const snapshot = { ...root, framing };
  if (!validCoachResponse(snapshot, activeRequest)) return null;
  return deepFreeze(snapshot);
}

function validCoachResponse(response, activeRequest) {
  return response.version === GAME_REVIEW_COACH_VERSION
    && response.requestId === activeRequest.requestId
    && response.sourceRuleId === activeRequest.sourceRuleId
    && GAME_REVIEW_COACH_ALLOWED_RULES.includes(response.sourceRuleId)
    && response.style === activeRequest.style
    && response.style === GAME_REVIEW_COACH_STYLE
    && validModelProfile(response.modelProfile)
    && response.modelProfile === activeRequest.modelProfile
    && validFraming(response.framing.leadIn)
    && validFraming(response.framing.encouragement)
    && codePointLength(response.framing.leadIn)
      + codePointLength(response.framing.encouragement)
      <= GAME_REVIEW_COACH_MAX_GENERATED_CODEPOINTS;
}

function validFraming(value) {
  if (typeof value !== 'string') return false;
  let normalized;
  try {
    normalized = value.normalize('NFKC');
  } catch {
    return false;
  }
  return validFramingForm(value) && validFramingForm(normalized);
}

function validFramingForm(value) {
  if (!boundedNonemptyString(value, GAME_REVIEW_COACH_MAX_SEGMENT_CODEPOINTS)
    || value !== value.trim() || CONTROL_OR_MULTILINE.test(value)
    || /[<>]/u.test(value) || MARKDOWN_LINK.test(value) || URL_OR_SCHEME.test(value)
    || QUOTE_OR_BRACKET.test(value) || /[0-9]/u.test(value)
    || ENGLISH_QUALITY.test(value) || MOVE_NOTATION.test(value) || COORDINATE_LIKE.test(value)
    || containsChessPieceVocabulary(value)) {
    return false;
  }
  const factSkeleton = framingFactSkeleton(value);
  for (const term of QUALITY_TERMS) {
    if (value.includes(term) || factSkeleton.includes(term)) return false;
  }
  for (const term of CHESS_FACT_TERMS) {
    if (value.includes(term) || factSkeleton.includes(term)) return false;
  }
  return Array.from(value).every((character) => SAFE_FRAMING_CHARACTER.test(character));
}

function containsChessPieceVocabulary(value) {
  const characters = Array.from(value);
  for (let index = 0; index < characters.length; index++) {
    if (PIECE_VOCABULARY.test(characters[index])
      && !safeHomographOccurrence(characters, index)) return true;
  }
  return false;
}

function safeHomographOccurrence(characters, pieceIndex) {
  for (const word of SAFE_HOMOGRAPH_WORDS) {
    const wordCharacters = Array.from(word);
    for (let start = pieceIndex - wordCharacters.length + 1; start <= pieceIndex; start++) {
      if (start < 0 || start + wordCharacters.length > characters.length) continue;
      if (!wordCharacters.every((character, offset) => characters[start + offset] === character)) {
        continue;
      }
      const before = characters[start - 1] || '';
      const after = characters[start + wordCharacters.length] || '';
      if ((!before || !CHESS_CONTEXT_BEFORE.test(before))
        && (!after || !CHESS_CONTEXT_AFTER.test(after))) return true;
    }
  }
  return false;
}

function framingFactSkeleton(value) {
  return Array.from(value)
    .filter((character) => /[\p{Script=Han}A-Za-z0-9]/u.test(character))
    .join('');
}

function snapshotCoachState(state) {
  const root = snapshotExactDataObject(state, STATE_KEYS);
  if (!root || !Object.isFrozen(state)) return null;
  let identity = null;
  let request = null;
  let framing = null;
  if (root.identity !== null) {
    if (!Object.isFrozen(root.identity)) return null;
    identity = snapshotExactDataObject(root.identity, IDENTITY_KEYS);
    if (!identity) return null;
  }
  if (root.request !== null) {
    if (!Object.isFrozen(root.request)) return null;
    request = snapshotExactDataObject(root.request, STATE_REQUEST_KEYS);
    if (!request) return null;
  }
  if (root.framing !== null) {
    if (!Object.isFrozen(root.framing)) return null;
    framing = snapshotExactDataObject(root.framing, FRAMING_KEYS);
    if (!framing) return null;
  }
  const snapshot = { ...root, identity, request, framing };
  if (!validCoachStateSnapshot(snapshot)) return null;
  return deepFreeze(snapshot);
}

function validCoachStateSnapshot(state) {
  if (state.version !== GAME_REVIEW_COACH_VERSION || !STATUSES.includes(state.status)
    || !validRevision(state.revision) || !validModelProfile(state.modelProfile)) return false;
  if (state.status === 'disabled' || state.status === 'idle') {
    return state.identity === null && state.request === null && state.framing === null;
  }
  if (!validIdentity(state.identity)
    || state.identity.coachRevision !== state.revision
    || state.identity.modelProfile !== state.modelProfile
    || state.request?.modelProfile !== state.modelProfile
    || !validStateRequest(state.request)) return false;
  if (state.status === 'loading') return state.framing === null;
  return validFraming(state.framing.leadIn) && validFraming(state.framing.encouragement);
}

function validIdentity(identity) {
  return validModelProfile(identity.modelProfile) && boundedNonemptyString(identity.recordId, 200)
    && Number.isInteger(identity.ply) && identity.ply >= 0
    && boundedNonemptyString(identity.positionKey, 1000)
    && Number.isInteger(identity.r3aRevision) && identity.r3aRevision >= 1
    && identity.teachingVersion === TEACHING_VERSION
    && GAME_REVIEW_COACH_ALLOWED_RULES.includes(identity.ruleId)
    && typeof identity.teachingFingerprint === 'string'
    && /^r3c2-[0-9a-f]{16}$/u.test(identity.teachingFingerprint)
    && validRevision(identity.coachRevision) && identity.coachRevision > 0;
}

function validStateRequest(request) {
  return validModelProfile(request.modelProfile) && validRequestId(request.requestId)
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

function snapshotExactDataObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
    || !actual.every((key) => typeof key === 'string' && keys.includes(key))) return null;
  const snapshot = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.get !== undefined || descriptor.set !== undefined
      || descriptor.enumerable !== true) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotStringArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1
    || lengthDescriptor.value > 1000) return null;
  const length = lengthDescriptor.value;
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== length + 1
    || actual.some((key) => typeof key !== 'string'
      || (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key)))) return null;
  const snapshot = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.get !== undefined || descriptor.set !== undefined
      || descriptor.enumerable !== true) return null;
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nextCoachRevision(current) {
  return validRevision(current) && current < Number.MAX_SAFE_INTEGER
    ? current + 1
    : null;
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
