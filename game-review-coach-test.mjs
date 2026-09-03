import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  beginCoachRequest,
  createCoachRequestPayload,
  createDisabledCoachState,
  createIdleCoachState,
  createTeachingFingerprint,
  GAME_REVIEW_COACH_ALLOWED_RULES,
  GAME_REVIEW_COACH_LOCALE,
  GAME_REVIEW_COACH_MAX_GENERATED_CODEPOINTS,
  GAME_REVIEW_COACH_MAX_SEGMENT_CODEPOINTS,
  GAME_REVIEW_COACH_STYLE,
  GAME_REVIEW_COACH_VERSION,
  GAME_REVIEW_COACH_MODEL_PROFILES,
  selectCoachModelProfile,
  validateCoachRequestPayload,
  invalidateCoachState,
  settleCoachResponse,
} from './game-review-coach.js';

const source = readFileSync(new URL('./game-review-coach.js', import.meta.url), 'utf8');
const OUTBOUND_KEYS = Object.freeze([
  'version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile',
]);
const RESPONSE_KEYS = Object.freeze([
  'version', 'requestId', 'sourceRuleId', 'style', 'modelProfile', 'framing',
]);
const STATE_KEYS = Object.freeze([
  'version', 'status', 'revision', 'identity', 'request', 'framing', 'modelProfile',
]);
const clone = (value) => structuredClone(value);

// Historical transport fixtures stay literal and are never a compatibility runtime.
const HISTORICAL_V1_REQUEST = Object.freeze({ version: 1, requestId: 'historical-v1',
  locale: 'zh-Hant', sourceRuleId: 'check-difference', style: 'child-neutral-teacher-v1' });

test('v2 literal schema, three profiles, private identity and historical rejection', () => {
  assert.equal(GAME_REVIEW_COACH_VERSION, 2);
  assert.deepEqual(GAME_REVIEW_COACH_MODEL_PROFILES, ['economy', 'balanced', 'quality']);
  assert.equal(createIdleCoachState().modelProfile, 'economy');
  assert.equal(validateCoachRequestPayload(HISTORICAL_V1_REQUEST), false);
  assert.equal(validateCoachRequestPayload({ ...HISTORICAL_V1_REQUEST, modelProfile: 'economy' }), false);
  assert.equal(validateCoachRequestPayload({ ...HISTORICAL_V1_REQUEST, version: 2 }), false);
  for (const modelProfile of ['economy', 'balanced', 'quality']) {
    const message = teaching();
    const fingerprint = createTeachingFingerprint(message);
    const state = createIdleCoachState(0, modelProfile);
    const result = beginCoachRequest({ state, teachingMessage: message, requestId: 'v2', modelProfile });
    assert.equal(result.accepted, true);
    assert.equal(result.request.version, 2);
    assertExactKeys(result.request, ['version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile']);
    assert.equal(validateCoachRequestPayload(result.request), true);
    assert.equal(result.request.modelProfile, modelProfile);
    assert.equal(result.state.identity.modelProfile, modelProfile);
    assert.equal(result.state.request.modelProfile, modelProfile);
    assert.equal(result.state.identity.teachingFingerprint, fingerprint);
    assert.deepEqual(Object.keys(result.state.identity).sort(), ['recordId', 'ply', 'positionKey',
      'r3aRevision', 'teachingVersion', 'ruleId', 'teachingFingerprint', 'coachRevision', 'modelProfile'].sort());
    const accepted = settleCoachResponse({ state: result.state, currentTeachingMessage: message,
      currentModelProfile: modelProfile, response: responseFor(result.request) });
    assert.equal(accepted.accepted, true);
    for (const bad of [undefined, 'unknown', 'gpt-anything', modelProfile === 'quality' ? 'economy' : 'quality']) {
      assert.equal(settleCoachResponse({ state: result.state, currentTeachingMessage: message,
        currentModelProfile: modelProfile, response: { ...responseFor(result.request), modelProfile: bad } }).accepted, false);
    }
    assert.equal(createTeachingFingerprint(message), fingerprint);
    assert.equal(invalidateCoachState(accepted.state).modelProfile, modelProfile);
  }
});

test('profile inputs have no coercion, implicit fallback, extra authority or getter execution', () => {
  const request = createCoachRequestPayload(teaching(), 'profile-input', 'economy');
  const state = createIdleCoachState();
  for (const bad of [undefined, null, '', 'Economy', ' ECONOMY', 'economy ', 'unknown', 'gpt-anything',
    [], {}, new String('economy'), 0, true]) {
    assert.equal(createCoachRequestPayload(teaching(), 'bad', bad), null);
    assert.equal(validateCoachRequestPayload({ ...request, modelProfile: bad }), false);
    assert.equal(beginCoachRequest({ state, teachingMessage: teaching(), requestId: 'bad', modelProfile: bad }).accepted, false);
    assert.equal(selectCoachModelProfile(state, bad), state);
  }
  assert.equal(beginCoachRequest({ state, teachingMessage: teaching(), requestId: 'missing' }).accepted, false);
  for (const key of ['model', 'modelId', 'providerModel', 'openaiModel', 'provider', 'apiKey',
    'board', 'recordId', 'GameRecord', 'prompt', 'title', 'body', 'score', 'PV']) {
    assert.equal(validateCoachRequestPayload({ ...request, [key]: 'injected' }), false);
    const started = begin();
    assert.equal(settle(started, teaching(), { ...responseFor(started.request), [key]: 'injected' }).accepted, false);
  }
  let calls = 0;
  const hostile = { state, teachingMessage: teaching(), requestId: 'accessor-profile' };
  Object.defineProperty(hostile, 'modelProfile', { enumerable: true, get() { calls++; return 'economy'; } });
  const descriptors = Object.getOwnPropertyDescriptors(hostile);
  assert.equal(beginCoachRequest(hostile).accepted, false);
  assert.equal(calls, 0, 'R3C2_MODEL_PROFILE_ACCESSOR_GETTER_INVOCATIONS=0');
  assert.equal(Object.isFrozen(hostile), false);
  assert.deepEqual(Object.getOwnPropertyDescriptors(hostile), descriptors);
  const response = responseFor(begin().request);
  Object.defineProperty(response, 'modelProfile', { enumerable: true, get() { calls++; return 'economy'; } });
  assert.equal(settle(begin(), teaching(), response).accepted, false);
  assert.equal(calls, 0);
});

test('profile transition preserves same state, invalidates loading/success and prevents ABA reuse', () => {
  for (const state of [createIdleCoachState(), createDisabledCoachState(), begin().state, settle(begin()).state]) {
    assert.equal(selectCoachModelProfile(state, 'economy'), state);
    assert.equal(selectCoachModelProfile(state, 'unknown'), state);
    const next = selectCoachModelProfile(state, 'quality');
    assert.equal(next.revision, state.revision + 1);
    assert.equal(next.modelProfile, 'quality');
    assert.equal(next.status, state.status === 'disabled' ? 'disabled' : 'idle');
    assert.equal(next.framing, null);
    assert.equal(next.request, null);
    assert.equal(next.identity, null);
  }
  const old = begin();
  assert.equal(settleCoachResponse({ state: old.state, currentTeachingMessage: teaching(),
    currentModelProfile: 'quality', response: responseFor(old.request) }).accepted, false);
  const back = selectCoachModelProfile(selectCoachModelProfile(old.state, 'quality'), 'economy');
  const latest = begin(teaching(), 'latest', back);
  assert.equal(settle(latest, teaching(), responseFor(old.request)).accepted, false);
  const exhausted = createIdleCoachState(Number.MAX_SAFE_INTEGER, 'balanced');
  const inert = selectCoachModelProfile(exhausted, 'quality');
  assert.equal(inert.status, 'disabled');
  assert.equal(inert.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(inert.modelProfile, 'balanced');
});

test('profile accessors and hostile scalar values reject throughout transport, state and settlement', () => {
  const started = begin();
  let calls = 0;
  const accessor = target => {
    const copy = { ...target };
    Object.defineProperty(copy, 'modelProfile', { enumerable: true, get() { calls++; return 'economy'; } });
    return copy;
  };
  const request = accessor(started.request);
  assert.equal(validateCoachRequestPayload(request), false);
  assert.equal(Object.isFrozen(request), false);
  for (const field of ['root', 'identity', 'request']) {
    const state = field === 'root' ? Object.freeze(accessor(started.state))
      : Object.freeze({ ...started.state, [field]: Object.freeze(accessor(started.state[field])) });
    assert.equal(settleCoachResponse({ state, currentTeachingMessage: teaching(), currentModelProfile: 'economy',
      response: responseFor(started.request) }).accepted, false);
  }
  const options = { state: started.state, currentTeachingMessage: teaching(), response: responseFor(started.request) };
  Object.defineProperty(options, 'currentModelProfile', { enumerable: true, get() { calls++; return 'economy'; } });
  assert.equal(settleCoachResponse(options).accepted, false);
  assert.equal(Object.isFrozen(options), false);
  const hostileScalar = { get poison() { calls++; return 'private'; } };
  assert.equal(createCoachRequestPayload(teaching(), 'hostile-profile', hostileScalar), null);
  assert.equal(validateCoachRequestPayload({ ...started.request, modelProfile: hostileScalar }), false);
  assert.equal(Object.isFrozen(hostileScalar), false);
  assert.equal(calls, 0, 'profile getter calls remain zero at every consumed depth');
});

test('profile mutation gates execute broken production code on LF and CRLF', async () => {
  const detects = (label, assertion) => assert.throws(assertion,
    error => error?.code === 'ERR_ASSERTION', label);
  for (const [eol, candidate] of sourceForms()) {
    const permissive = await importReplacedModule(candidate,
      "  return typeof value === 'string' && GAME_REVIEW_COACH_MODEL_PROFILES.includes(value);",
      "  return typeof value === 'string';", eol);
    detects('BROKEN_R3C2_MODEL_PROFILE_UNKNOWN_WOULD_FAIL', () =>
      assert.equal(permissive.createCoachRequestPayload(teaching(), 'mut', 'unknown'), null));
    detects('BROKEN_R3C2_ARBITRARY_MODEL_ID_WOULD_FAIL', () =>
      assert.equal(permissive.createCoachRequestPayload(teaching(), 'mut', 'gpt-anything'), null));
    const provider = await importMutatedModule(candidate, '    style: GAME_REVIEW_COACH_STYLE,',
      "    provider: 'arbitrary',", eol);
    detects('BROKEN_R3C2_MODEL_PROVIDER_FIELD_WOULD_FAIL', () =>
      assertExactKeys(provider.createCoachRequestPayload(teaching(), 'mut', 'economy'), OUTBOUND_KEYS));
    const missing = await importMutatedModule(candidate,
      'export function createCoachRequestPayload(teachingMessage, requestId, modelProfile) {',
      "  const broken = { ...createCoachRequestPayloadFromSnapshot(snapshotTeachingMessage(teachingMessage), requestId, modelProfile) }; delete broken.modelProfile; return broken;", eol);
    detects('BROKEN_R3C2_MODEL_PROFILE_NOT_SENT_WOULD_FAIL', () =>
      assertExactKeys(missing.createCoachRequestPayload(teaching(), 'mut', 'economy'), OUTBOUND_KEYS));
    const mismatch = await importReplacedModule(candidate,
      '    && response.modelProfile === activeRequest.modelProfile', '    && true', eol);
    const started = begin();
    detects('BROKEN_R3C2_MODEL_PROFILE_RESPONSE_MISMATCH_WOULD_FAIL', () =>
      assert.equal(mismatch.settleCoachResponse({ state: started.state, currentTeachingMessage: teaching(),
        currentModelProfile: 'economy', response: { ...responseFor(started.request), modelProfile: 'quality' } }).accepted, false));
    let changed = replaceUniqueLine(candidate,
      "    if (!validModelProfile(input.currentModelProfile) || input.currentModelProfile !== state.modelProfile) {",
      '    if (false) {', eol);
    changed = replaceUniqueLine(changed,
      '    const currentIdentity = createIdentity(currentTeachingMessage, state.identity.coachRevision, input.currentModelProfile);',
      '    const currentIdentity = createIdentity(currentTeachingMessage, state.identity.coachRevision, state.modelProfile);', eol);
    const stale = await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
    detects('BROKEN_R3C2_MODEL_PROFILE_CHANGED_DURING_REQUEST_WOULD_FAIL', () =>
      assert.equal(stale.settleCoachResponse({ state: started.state, currentTeachingMessage: teaching(),
        currentModelProfile: 'quality', response: responseFor(started.request) }).accepted, false));
    const accessor = await importReplacedModule(candidate,
      "    const input = snapshotExactDataObject(options, ['state', 'teachingMessage', 'requestId', 'modelProfile']);",
      '    const input = { ...options };', eol);
    let calls = 0;
    const hostile = { state: createIdleCoachState(), teachingMessage: teaching(), requestId: 'mut',
      get modelProfile() { calls++; return 'economy'; } };
    assert.equal(accessor.beginCoachRequest(hostile).accepted, true);
    detects('BROKEN_R3C2_MODEL_PROFILE_ACCESSOR_WOULD_FAIL', () => assert.equal(calls, 0));
    assert.equal(calls, 1, 'mutant executed the getter');
  }
});

function teaching(overrides = {}) {
  const base = {
    kind: 'review-teaching-message',
    version: 1,
    ruleId: 'check-difference',
    priority: 700,
    title: '先看看將軍手',
    body: '可以先檢查看看有沒有將軍手。',
    evidenceRefs: ['source.recordId', 'source.ply', 'candidate.givesCheck'],
    source: {
      recordId: 'coach-fixture',
      ply: 8,
      positionKey: 'position|red|fixture',
      r3aRevision: 3,
    },
    tone: 'child-neutral-zh-Hant',
    confidence: 'canonical',
  };
  return { ...base, ...overrides, source: { ...base.source, ...overrides.source } };
}

function responseFor(request, framing = {}) {
  return {
    version: 2,
    requestId: request.requestId,
    sourceRuleId: request.sourceRuleId,
    style: request.style,
    modelProfile: request.modelProfile,
    framing: {
      leadIn: '先停一下，慢慢想一想。',
      encouragement: '你可以照自己的步調思考。',
      ...framing,
    },
  };
}

function begin(message = teaching(), requestId = 'request-001', state = createIdleCoachState()) {
  const result = beginCoachRequest({ modelProfile: 'economy', state, teachingMessage: message, requestId });
  assert.equal(result.accepted, true);
  return result;
}

function settle(beginResult, message = teaching(), response = responseFor(beginResult.request)) {
  return settleCoachResponse({ currentModelProfile: 'economy',
    state: beginResult.state,
    currentTeachingMessage: message,
    response,
  });
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertExactKeys(value, expected) {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
}

function tokenizeDependencySyntax(candidate) {
  const tokens = [];
  let index = 0;
  const identifierStart = (character) => /[A-Za-z_$]/.test(character || '');
  const identifierPart = (character) => /[A-Za-z0-9_$]/.test(character || '');

  const readString = (quote) => {
    const start = ++index;
    while (index < candidate.length) {
      if (candidate[index] === '\\') index += 2;
      else if (candidate[index] === quote) {
        tokens.push({ type: 'string', value: candidate.slice(start, index) });
        index++;
        return;
      } else index++;
    }
    tokens.push({ type: 'string', value: candidate.slice(start) });
  };

  const readCode = (stopAtTemplateBrace = false) => {
    let braceDepth = 0;
    while (index < candidate.length) {
      const character = candidate[index];
      if (/\s/.test(character)) {
        index++;
        continue;
      }
      if (character === '/' && candidate[index + 1] === '/') {
        index += 2;
        while (index < candidate.length && !/[\r\n]/.test(candidate[index])) index++;
        continue;
      }
      if (character === '/' && candidate[index + 1] === '*') {
        index += 2;
        while (index < candidate.length
          && !(candidate[index] === '*' && candidate[index + 1] === '/')) index++;
        index = Math.min(candidate.length, index + 2);
        continue;
      }
      if (character === '"' || character === "'") {
        readString(character);
        continue;
      }
      if (character === '`') {
        index++;
        while (index < candidate.length) {
          if (candidate[index] === '\\') index += 2;
          else if (candidate[index] === '`') {
            index++;
            break;
          } else if (candidate[index] === '$' && candidate[index + 1] === '{') {
            index += 2;
            readCode(true);
          } else index++;
        }
        continue;
      }
      if (stopAtTemplateBrace && character === '}' && braceDepth === 0) {
        index++;
        return;
      }
      if (identifierStart(character)) {
        const start = index++;
        while (identifierPart(candidate[index])) index++;
        tokens.push({ type: 'identifier', value: candidate.slice(start, index) });
        continue;
      }
      if (character === '{') braceDepth++;
      if (character === '}' && braceDepth > 0) braceDepth--;
      tokens.push({ type: 'punctuator', value: character });
      index++;
    }
  };

  readCode();
  return tokens;
}

function productionDependencies(candidate) {
  const tokens = tokenizeDependencySyntax(candidate);
  const dependencies = [];
  const tokenIs = (token, type, value) => token?.type === type && token.value === value;
  const add = (kind, token) => dependencies.push({
    kind,
    specifier: token?.type === 'string' ? token.value : '<computed>',
  });

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (tokenIs(token, 'identifier', 'import') && !tokenIs(previous, 'punctuator', '.')) {
      if (tokenIs(next, 'punctuator', '.')) continue;
      if (tokenIs(next, 'punctuator', '(')) {
        add('dynamic-import', tokens[index + 2]);
        continue;
      }
      if (next?.type === 'string') {
        add('static-import', next);
        continue;
      }
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        if (tokenIs(tokens[cursor], 'punctuator', ';')) break;
        if (tokenIs(tokens[cursor], 'identifier', 'from')
          && tokens[cursor + 1]?.type === 'string') {
          add('static-import', tokens[cursor + 1]);
          break;
        }
      }
      continue;
    }
    if (tokenIs(token, 'identifier', 'export')
      && (tokenIs(next, 'punctuator', '*') || tokenIs(next, 'punctuator', '{'))) {
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        if (tokenIs(tokens[cursor], 'punctuator', ';')) break;
        if (tokenIs(tokens[cursor], 'identifier', 'from')
          && tokens[cursor + 1]?.type === 'string') {
          add('export-from', tokens[cursor + 1]);
          break;
        }
      }
      continue;
    }
    if (tokenIs(token, 'identifier', 'require')
      && !tokenIs(previous, 'punctuator', '.')
      && tokenIs(next, 'punctuator', '(')) {
      add('commonjs-require', tokens[index + 2]);
    }
  }
  return dependencies;
}

function assertPureCoachSource(candidate) {
  assert.deepEqual(productionDependencies(candidate), [],
    'game-review-coach.js must have zero production dependencies');
  const forbidden = [
    /\b(?:legalMoves|applyMove|replay|inCheck|findBestMove|Worker)\b/u,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/u,
    /\b(?:localStorage|sessionStorage|indexedDB|CacheStorage|serviceWorker)\b/u,
    /\b(?:document|window|HTMLElement|querySelector|textContent)\b/u,
    /\b(?:setTimeout|setInterval|AbortController)\b/u,
    /\b(?:Authorization|Bearer|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|apiKey|providerSecret)\b/u,
    /\b(?:prompt|system|messages|conversation|chat)\b/u,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(candidate, pattern);
}

function sourceWithLineEnding(candidate, eol) {
  return candidate.replace(/\r\n|\r|\n/g, '\n').replaceAll('\n', eol);
}

function logicalLineMatches(candidate, targetLine) {
  const matches = [];
  const pattern = /([^\r\n]*)(\r\n|\n|$)/g;
  let match;
  while ((match = pattern.exec(candidate)) !== null) {
    if (match[1] === targetLine) {
      matches.push({ index: match.index, line: match[1], eol: match[2] });
    }
    if (match[0] === '') break;
  }
  return matches;
}

function injectAfterUniqueLine(candidate, targetLine, injectedLine, label) {
  const matches = logicalLineMatches(candidate, targetLine);
  assert.equal(matches.length, 1, `${label} mutation target occurs exactly once`);
  const [{ index, line, eol }] = matches;
  assert.notEqual(eol, '', `${label} mutation target must have a line ending`);
  const insertAt = index + line.length + eol.length;
  return `${candidate.slice(0, insertAt)}${injectedLine}${eol}${candidate.slice(insertAt)}`;
}

function replaceUniqueLine(candidate, targetLine, replacementLine, label) {
  const matches = logicalLineMatches(candidate, targetLine);
  assert.equal(matches.length, 1, `${label} mutation target occurs exactly once`);
  const [{ index, line }] = matches;
  return `${candidate.slice(0, index)}${replacementLine}${candidate.slice(index + line.length)}`;
}

async function importMutatedModule(candidate, targetLine, injectedLine, label) {
  const mutated = injectAfterUniqueLine(candidate, targetLine, injectedLine, label);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`;
  return import(dataUrl);
}

async function importReplacedModule(candidate, targetLine, replacementLine, label) {
  const mutated = replaceUniqueLine(candidate, targetLine, replacementLine, label);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`;
  return import(dataUrl);
}

function sourceForms() {
  const lf = sourceWithLineEnding(source, '\n');
  return [
    ['LF', lf],
    ['CRLF', sourceWithLineEnding(source, '\r\n')],
    ['actual checkout', source],
  ];
}

test('disabled and idle states are exact immutable values', () => {
  const disabled = createDisabledCoachState();
  const idle = createIdleCoachState(4);
  assertExactKeys(disabled, STATE_KEYS);
  assert.deepEqual(disabled, {
    version: 2, status: 'disabled', revision: 0, identity: null, request: null, framing: null, modelProfile: 'economy',
  });
  assert.deepEqual(idle, {
    version: 2, status: 'idle', revision: 4, identity: null, request: null, framing: null, modelProfile: 'economy',
  });
  assertDeepFrozen(disabled);
  assertDeepFrozen(idle);
});

test('disabled state cannot begin or build a sendable request', () => {
  const result = beginCoachRequest({ modelProfile: 'economy',
    state: createDisabledCoachState(), teachingMessage: teaching(), requestId: 'disabled-request',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.request, null);
  assert.equal(result.reason, 'DISABLED');
});

test('valid begin emits the exact six-key v2 outbound payload and localizes identity', () => {
  const input = teaching();
  const before = clone(input);
  const result = begin(input);
  assert.deepEqual(result.request, {
    version: 2,
    requestId: 'request-001',
    locale: GAME_REVIEW_COACH_LOCALE,
    sourceRuleId: 'check-difference',
    style: GAME_REVIEW_COACH_STYLE,
    modelProfile: 'economy',
  });
  assertExactKeys(result.request, OUTBOUND_KEYS);
  for (const key of [
    'board', 'GameRecord', 'score', 'PV', 'recordId', 'ply', 'positionKey',
    'title', 'body', 'prompt', 'system', 'messages',
  ]) assert.equal(Object.hasOwn(result.request, key), false, `${key} is outbound-absent`);
  assert.deepEqual(input, before);
  assert.equal(result.state.status, 'loading');
  assert.equal(result.state.identity.recordId, input.source.recordId);
  assert.equal(result.state.identity.ply, input.source.ply);
  assert.equal(Object.hasOwn(result.state, 'title'), false);
  assert.equal(Object.hasOwn(result.state, 'body'), false);
  assertDeepFrozen(result);
});

test('all seven allowed R3C1 emitting rules can begin with their canonical priorities', () => {
  const priorities = [900, 850, 800, 700, 650, 600, 500];
  assert.equal(GAME_REVIEW_COACH_ALLOWED_RULES.length, 7);
  for (let index = 0; index < GAME_REVIEW_COACH_ALLOWED_RULES.length; index++) {
    const ruleId = GAME_REVIEW_COACH_ALLOWED_RULES[index];
    const message = teaching({ ruleId, priority: priorities[index] });
    assert.equal(begin(message, `rule-${index}`).request.sourceRuleId, ruleId);
  }
});

test('same-move, unknown-rule and malformed teaching messages fail closed', () => {
  for (const message of [
    teaching({ ruleId: 'same-move', priority: 1000 }),
    teaching({ ruleId: 'unknown-rule', priority: 1 }),
    { ...teaching(), extra: true },
    { ...teaching(), title: '' },
  ]) {
    const result = beginCoachRequest({ modelProfile: 'economy',
      state: createIdleCoachState(), teachingMessage: message, requestId: 'bad-teaching',
    });
    assert.equal(result.accepted, false);
    assert.equal(result.request, null);
  }
});

test('request identifiers are bounded opaque strings', () => {
  assert.ok(createCoachRequestPayload(teaching(), 'x'.repeat(64), 'economy'));
  for (const requestId of ['', ' x', 'x y', 'x\n', 'x'.repeat(65), 1, null]) {
    assert.equal(createCoachRequestPayload(teaching(), requestId, 'economy'), null);
  }
});

test('valid exact response is accepted without owning canonical title or body', () => {
  const started = begin();
  const result = settle(started);
  assert.equal(result.accepted, true);
  assert.equal(result.state.status, 'success');
  assertExactKeys(result.state, STATE_KEYS);
  assertExactKeys(result.state.framing, ['leadIn', 'encouragement']);
  assert.equal(Object.hasOwn(result.state, 'title'), false);
  assert.equal(Object.hasOwn(result.state, 'body'), false);
  assertDeepFrozen(result);
});

test('response identifier, rule and style mismatches are rejected', () => {
  const started = begin();
  for (const patch of [
    { requestId: 'other' },
    { sourceRuleId: 'capture-difference' },
    { style: 'other-style' },
    { sourceRuleId: 'unknown-rule' },
    { sourceRuleId: 'same-move' },
  ]) {
    const candidate = { ...responseFor(started.request), ...patch };
    assert.equal(settle(started, teaching(), candidate).accepted, false);
  }
});

test('response schema rejects extra and missing keys at both levels', () => {
  const started = begin();
  const exact = responseFor(started.request);
  assertExactKeys(exact, RESPONSE_KEYS);
  assertExactKeys(exact.framing, ['leadIn', 'encouragement']);
  const cases = [
    { ...exact, extra: true },
    { ...exact, framing: { ...exact.framing, extra: true } },
    Object.fromEntries(Object.entries(exact).filter(([key]) => key !== 'version')),
    { ...exact, framing: { leadIn: exact.framing.leadIn } },
  ];
  for (const candidate of cases) assert.equal(settle(started, teaching(), candidate).accepted, false);
});

test('framing requires two nonempty segments of at most 24 Unicode code points', () => {
  assert.equal(GAME_REVIEW_COACH_MAX_SEGMENT_CODEPOINTS, 24);
  assert.equal(GAME_REVIEW_COACH_MAX_GENERATED_CODEPOINTS, 48);
  const started = begin();
  for (const framing of [
    { leadIn: '', encouragement: '慢慢想。' },
    { leadIn: '慢慢想。', encouragement: '' },
    { leadIn: '想'.repeat(25), encouragement: '慢慢想。' },
    { leadIn: '慢慢想。', encouragement: '想'.repeat(25) },
  ]) assert.equal(settle(started, teaching(), responseFor(started.request, framing)).accepted, false);

  const boundary = {
    leadIn: `鼓勵${'🙂'.repeat(22)}`,
    encouragement: `加油${'🌱'.repeat(22)}`,
  };
  assert.equal(Array.from(boundary.leadIn).length, 24);
  assert.equal(Array.from(boundary.encouragement).length, 24);
  assert.equal(settle(started, teaching(), responseFor(started.request, boundary)).accepted, true);
  assert.equal(settle(started, teaching(), responseFor(started.request, {
    ...boundary, leadIn: `${boundary.leadIn}🙂`,
  })).accepted, false);
});

test('HTML, Markdown, URL, controls and multiline framing are rejected whole', () => {
  const started = begin();
  const hostile = [
    '<b>慢慢想</b>',
    '[慢慢想](https://example.test)',
    'https://example.test',
    'www.example.test',
    'javascript:慢慢想',
    'data:text/plain,慢慢想',
    '慢慢\n想',
    '慢慢\u0000想',
  ];
  for (const leadIn of hostile) {
    assert.equal(settle(started, teaching(), responseFor(started.request, { leadIn })).accepted, false);
  }
});

test('quality, score, evaluation, depth, PV and best-move language is rejected', () => {
  const started = begin();
  const terms = [
    '最佳', '最好', '最佳著', '比較好', '比較差', '失誤', '大錯', '大漏著',
    '白送', '掉子', '懸子', '優勢', '勝率', '評分', '評估', '評估值', '分數',
    'score', 'evaluation', 'depth', 'PV', 'best', 'blunder', 'mistake',
  ];
  for (const term of terms) {
    assert.equal(settle(started, teaching(), responseFor(started.request, {
      leadIn: `慢慢想${term}`,
    })).accepted, false, term);
  }
});

test('chess facts, piece claims, coordinate-like text and move notation are rejected', () => {
  const started = begin();
  const hostile = [
    '這步會將軍', '下一手會將死', '結果是困斃', '形成長將', '形成重複',
    '結果判和', '結果判負', '紅方獲勝', '可以吃車', '炮二平五很好',
    '請走Ａ一', '請走甲一', '請走一二', '請看A1', '請看二三', '「炮二平五」',
    '【下一手】',
    ...'車馬炮相象仕士帥將兵卒'.split(''),
    ...'車馬炮相象仕士帥將兵卒'.split('').map((piece) => `紅${piece}要移動`),
  ];
  for (const leadIn of hostile) {
    assert.equal(settle(started, teaching(), responseFor(started.request, { leadIn })).accepted, false,
      leadIn);
  }
});

test('generic Traditional Chinese teacher wording is accepted without substring false positives', () => {
  const started = begin();
  for (const leadIn of [
    '先停一下，慢慢想一想。',
    '相信自己，慢慢練習。',
    '將來也可以再試一次。',
    '馬上可以再試一次。',
    '保持士氣，再試一次。',
    '保持好奇，再想想看。',
  ]) {
    assert.equal(settle(started, teaching(), responseFor(started.request, { leadIn })).accepted, true,
      leadIn);
  }
});

test('fingerprint is deterministic and changes for every canonical identity field', () => {
  const base = teaching();
  const fingerprint = createTeachingFingerprint(base);
  assert.equal(createTeachingFingerprint(clone(base)), fingerprint);
  const variants = [
    teaching({ version: 2 }),
    teaching({ ruleId: 'capture-difference', priority: 600 }),
    teaching({ title: '換個提醒' }),
    teaching({ body: '換個方式慢慢想。' }),
    teaching({ tone: 'other' }),
    teaching({ confidence: 'other' }),
  ];
  for (const variant of variants) {
    const changed = createTeachingFingerprint(variant);
    if (changed !== null) assert.notEqual(changed, fingerprint);
    else assert.notEqual(changed, fingerprint);
  }
});

test('invalidate removes active and successful framing, advances revision and rejects old response', () => {
  const started = begin();
  const oldResponse = responseFor(started.request);
  const invalidatedLoading = invalidateCoachState(started.state);
  assert.deepEqual(invalidatedLoading, {
    version: 2, status: 'idle', revision: 2, identity: null, request: null, framing: null, modelProfile: 'economy',
  });
  assert.equal(settleCoachResponse({ currentModelProfile: 'economy',
    state: invalidatedLoading, currentTeachingMessage: teaching(), response: oldResponse,
  }).accepted, false);

  const success = settle(started).state;
  const invalidatedSuccess = invalidateCoachState(success);
  assert.equal(invalidatedSuccess.status, 'idle');
  assert.equal(invalidatedSuccess.framing, null);
  assert.equal(invalidatedSuccess.revision, success.revision + 1);
});

test('all local source and canonical teaching changes reject stale responses', () => {
  const started = begin();
  const changes = [
    { source: { ply: 9 } },
    { source: { recordId: 'other-record' } },
    { source: { positionKey: 'other-position' } },
    { source: { r3aRevision: 4 } },
    { title: '換個提醒' },
    { body: '換個方式慢慢想。' },
    { ruleId: 'capture-difference', priority: 600 },
  ];
  for (const patch of changes) {
    assert.equal(settle(started, teaching(patch)).accepted, false, JSON.stringify(patch));
  }
});

test('hostile malformed values and exotic objects never throw or partially accept', () => {
  class Exotic {}
  const throwing = {};
  Object.defineProperty(throwing, 'state', { get() { throw new Error('hostile getter'); } });
  const hostile = [
    null, undefined, [], new Date(), new Map(), new Set(), new Exotic(),
    () => {}, Symbol('x'), throwing, Object.create(null), 1, 'x',
  ];
  for (const value of hostile) {
    assert.doesNotThrow(() => beginCoachRequest(value));
    assert.doesNotThrow(() => settleCoachResponse(value));
    assert.doesNotThrow(() => invalidateCoachState(value));
    assert.equal(beginCoachRequest(value).accepted, false);
    assert.equal(settleCoachResponse(value).accepted, false);
  }
});

test('accessor properties are rejected at every consumed depth without invoking getters', () => {
  const getterCounts = [];
  const accessor = (target, key, safeValue) => {
    let calls = 0;
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        calls++;
        return calls === 1 ? safeValue : '私密內容';
      },
    });
    getterCounts.push(() => calls);
  };

  const messageAccessor = teaching();
  delete messageAccessor.ruleId;
  accessor(messageAccessor, 'ruleId', 'check-difference');
  assert.equal(createCoachRequestPayload(messageAccessor, 'accessor-message', 'economy'), null);
  const accessorBegin = beginCoachRequest({ modelProfile: 'economy',
    state: createIdleCoachState(), teachingMessage: messageAccessor, requestId: 'accessor-message',
  });
  assert.equal(accessorBegin.accepted, false);
  assert.equal(Object.hasOwn(accessorBegin.state, 'title'), false);
  assert.equal(Object.hasOwn(accessorBegin.state, 'body'), false);

  const sourceAccessor = teaching();
  delete sourceAccessor.source.recordId;
  accessor(sourceAccessor.source, 'recordId', 'coach-fixture');
  assert.equal(createCoachRequestPayload(sourceAccessor, 'accessor-source', 'economy'), null);

  const evidenceAccessor = teaching();
  const evidenceRefs = [];
  let evidenceGetterCalls = 0;
  Object.defineProperty(evidenceRefs, '0', {
    enumerable: true,
    configurable: true,
    get() {
      evidenceGetterCalls++;
      return 'source.recordId';
    },
  });
  getterCounts.push(() => evidenceGetterCalls);
  evidenceRefs.length = 1;
  evidenceAccessor.evidenceRefs = evidenceRefs;
  assert.equal(createCoachRequestPayload(evidenceAccessor, 'accessor-array', 'economy'), null);

  const started = begin();
  const response = responseFor(started.request);
  delete response.framing.leadIn;
  accessor(response.framing, 'leadIn', '慢慢想一想。');
  assert.equal(settle(started, teaching(), response).accepted, false);

  const topLevelResponse = responseFor(started.request);
  const safeFraming = topLevelResponse.framing;
  delete topLevelResponse.framing;
  accessor(topLevelResponse, 'framing', safeFraming);
  assert.equal(settle(started, teaching(), topLevelResponse).accepted, false);

  const optionAccessor = { modelProfile: 'economy', teachingMessage: teaching(), requestId: 'accessor-options' };
  accessor(optionAccessor, 'state', createIdleCoachState());
  assert.equal(beginCoachRequest(optionAccessor).accepted, false);

  const stateAccessor = { ...createIdleCoachState() };
  delete stateAccessor.revision;
  accessor(stateAccessor, 'revision', 0);
  Object.freeze(stateAccessor);
  assert.equal(beginCoachRequest({ modelProfile: 'economy',
    state: stateAccessor, teachingMessage: teaching(), requestId: 'accessor-state',
  }).accepted, false);
  assert.ok(getterCounts.every((readCount) => readCount() === 0),
    'R3C2_ACCESSOR_GETTER_INVOCATIONS_DURING_VALIDATION=0');
});

test('hostile scalar objects reject without executing getters or freezing caller input', () => {
  const hostileScalar = () => {
    let getterCalls = 0;
    const value = {};
    Object.defineProperty(value, 'poison', {
      enumerable: true,
      get() {
        getterCalls++;
        return '私密內容';
      },
    });
    return { value, getterCalls: () => getterCalls };
  };

  const title = hostileScalar();
  const titleMessage = teaching({ title: title.value });
  assert.equal(createCoachRequestPayload(titleMessage, 'scalar-title', 'economy'), null);
  assert.equal(beginCoachRequest({ modelProfile: 'economy',
    state: createIdleCoachState(), teachingMessage: titleMessage, requestId: 'scalar-title',
  }).accepted, false);
  assert.equal(title.getterCalls(), 0, 'R3C2_SCALAR_OBJECT_TITLE_GETTER_INVOCATIONS=0');
  assert.equal(Object.isFrozen(title.value), false);
  assert.equal(Object.isFrozen(titleMessage), false);

  const sourceRecordId = hostileScalar();
  const sourceMessage = teaching({ source: { recordId: sourceRecordId.value } });
  assert.equal(createCoachRequestPayload(sourceMessage, 'scalar-source', 'economy'), null);
  assert.equal(sourceRecordId.getterCalls(), 0,
    'R3C2_SCALAR_OBJECT_SOURCE_GETTER_INVOCATIONS=0');
  assert.equal(Object.isFrozen(sourceRecordId.value), false);
  assert.equal(Object.isFrozen(sourceMessage.source), false);

  const started = begin(teaching(), 'scalar-framing');
  const framingLeadIn = hostileScalar();
  const hostileResponse = responseFor(started.request, { leadIn: framingLeadIn.value });
  const settlement = settle(started, teaching(), hostileResponse);
  assert.equal(settlement.accepted, false);
  assert.equal(settlement.state.status, 'loading');
  assert.equal(settlement.state.framing, null);
  assert.equal(framingLeadIn.getterCalls(), 0,
    'R3C2_SCALAR_OBJECT_FRAMING_GETTER_INVOCATIONS=0');
  assert.equal(Object.isFrozen(framingLeadIn.value), false);
  assert.equal(Object.isFrozen(hostileResponse), false);

  const revision = hostileScalar();
  const hostileState = Object.freeze({ ...createIdleCoachState(), revision: revision.value });
  assert.equal(beginCoachRequest({ modelProfile: 'economy',
    state: hostileState, teachingMessage: teaching(), requestId: 'scalar-revision',
  }).accepted, false);
  const invalidated = invalidateCoachState(hostileState);
  assert.equal(invalidated.status, 'disabled');
  assert.equal(invalidated.revision, 0);
  assert.equal(revision.getterCalls(), 0,
    'R3C2_SCALAR_OBJECT_REVISION_GETTER_INVOCATIONS=0');
  assert.equal(Object.isFrozen(revision.value), false);

  const fingerprint = hostileScalar();
  const validLoading = begin(teaching(), 'scalar-fingerprint').state;
  const hostileIdentity = Object.freeze({
    ...validLoading.identity, teachingFingerprint: fingerprint.value,
  });
  const hostileIdentityState = Object.freeze({ ...validLoading, identity: hostileIdentity });
  assert.equal(invalidateCoachState(hostileIdentityState).status, 'disabled');
  assert.equal(fingerprint.getterCalls(), 0);
  assert.equal(Object.isFrozen(fingerprint.value), false);

  assert.ok([title, sourceRecordId, framingLeadIn, revision, fingerprint]
    .every((hostile) => hostile.getterCalls() === 0),
  'R3C2_ACCESSOR_GETTER_INVOCATIONS_DURING_VALIDATION=0');
  assert.ok([
    title.value, sourceRecordId.value, framingLeadIn.value, revision.value, fingerprint.value,
  ]
    .every((value) => !Object.isFrozen(value)),
  'R3C2_CALLER_OWNED_INVALID_INPUT_NOT_FROZEN=PASS');
});

test('hostile reflection failures reject without throwing', () => {
  const hostileProxies = [
    new Proxy({}, {
      getPrototypeOf() { throw new Error('prototype reflection blocked'); },
    }),
    new Proxy({}, {
      ownKeys() { throw new Error('descriptor reflection blocked'); },
    }),
  ];
  for (const hostileProxy of hostileProxies) {
    assert.doesNotThrow(() => createCoachRequestPayload(hostileProxy, 'proxy', 'economy'));
    assert.equal(createCoachRequestPayload(hostileProxy, 'proxy', 'economy'), null);
    assert.doesNotThrow(() => beginCoachRequest(hostileProxy));
    assert.equal(beginCoachRequest(hostileProxy).accepted, false);
    assert.doesNotThrow(() => settleCoachResponse(hostileProxy));
    assert.equal(settleCoachResponse(hostileProxy).accepted, false);

    const nestedMessage = teaching();
    nestedMessage.source = hostileProxy;
    assert.doesNotThrow(() => createCoachRequestPayload(nestedMessage, 'nested-proxy', 'economy'));
    assert.equal(createCoachRequestPayload(nestedMessage, 'nested-proxy', 'economy'), null);

    const started = begin();
    const nestedResponse = responseFor(started.request);
    nestedResponse.framing = hostileProxy;
    assert.doesNotThrow(() => settle(started, teaching(), nestedResponse));
    assert.equal(settle(started, teaching(), nestedResponse).accepted, false);
  }
});

test('homograph policy rejects the pre-fix claim without lossy deletion and keeps generic prose', () => {
  const started = begin();
  const rejected = [
    '紅馬上前進。',
    '紅將來移動。',
    '將 軍',
    '將　軍',
    '將・軍',
    '將/**/軍',
    '将军',
    '红马向前進。',
    '帅会移動。',
    '车向前進。',
  ];
  for (const leadIn of rejected) {
    assert.equal(settle(started, teaching(), responseFor(started.request, { leadIn })).accepted,
      false, leadIn);
  }
  for (const leadIn of [
    '可以先注意這個地方。',
    '再仔細看看也很好。',
    '下次可以先停一下想想。',
    '馬上可以再試一次。',
    '將來也可以再試一次。',
    '相信自己，慢慢練習。',
  ]) {
    assert.equal(settle(started, teaching(), responseFor(started.request, { leadIn })).accepted,
      true, leadIn);
  }
});

test('revision exhaustion stays safe, inert and stale-response resistant', () => {
  const message = teaching();
  const nearMax = createIdleCoachState(Number.MAX_SAFE_INTEGER - 1);
  const atMax = begin(message, 'max-revision-request', nearMax);
  assert.equal(atMax.state.revision, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isSafeInteger(atMax.state.identity.coachRevision), true);

  const oldResponse = responseFor(atMax.request);
  const exhausted = invalidateCoachState(atMax.state);
  assert.deepEqual(exhausted, {
    version: 2,
    status: 'disabled',
    revision: Number.MAX_SAFE_INTEGER,
    identity: null,
    request: null,
    framing: null, modelProfile: 'economy',
  });
  assert.equal(settleCoachResponse({ currentModelProfile: 'economy',
    state: exhausted, currentTeachingMessage: message, response: oldResponse,
  }).accepted, false);
  const retry = beginCoachRequest({ modelProfile: 'economy',
    state: exhausted, teachingMessage: message, requestId: 'max-revision-request',
  });
  assert.equal(retry.accepted, false);
  assert.equal(retry.reason, 'DISABLED');

  const idleAtMax = createIdleCoachState(Number.MAX_SAFE_INTEGER);
  const exhaustedBegin = beginCoachRequest({ modelProfile: 'economy',
    state: idleAtMax, teachingMessage: message, requestId: 'exhausted-begin',
  });
  assert.equal(exhaustedBegin.accepted, false);
  assert.equal(exhaustedBegin.reason, 'REVISION_EXHAUSTED');
  assert.equal(exhaustedBegin.state.status, 'disabled');
  assert.equal(exhaustedBegin.state.revision, Number.MAX_SAFE_INTEGER);

  for (const revision of [NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const hostileState = Object.freeze({
      version: 2,
      status: 'idle',
      revision,
      identity: null,
      request: null,
      framing: null, modelProfile: 'economy',
    });
    const result = beginCoachRequest({ modelProfile: 'economy',
      state: hostileState, teachingMessage: message, requestId: 'invalid-revision',
    });
    assert.equal(result.accepted, false, String(revision));
    assert.equal(result.state.status, 'disabled', String(revision));
    assert.equal(Number.isSafeInteger(invalidateCoachState(hostileState).revision), true);
  }
});

test('production source has no dependency, R3C1 import, engine, network, storage, DOM or secret', () => {
  assertPureCoachSource(source);
  assert.equal(productionDependencies(source).length, 0, 'R3C2_PRODUCTION_IMPORT_COUNT=0');
  assert.doesNotMatch(source, /game-review-teaching\.js/u);
});

test('dependency scanner rejects broad import forms and ignores non-executable lookalikes', () => {
  const mutants = [
    "import './game.js';\n",
    "import/**/rules from './game.js';\n",
    "import\n/* comment */\nrules from './ai.js';\n",
    "export { legalMoves }/**/from './game.js';\n",
    "export * /**/ from './ai.js';\n",
    "const mod = await import/*x*/('./game.js');\n",
    "const mod = await import(specifier);\n",
    "const rules = require/**/('./game.js');\n",
  ];
  for (const prefix of mutants) assert.notEqual(productionDependencies(`${prefix}${source}`).length, 0);
  const harmless = [
    '// import("./fake.js")',
    '/* require("./fake.js") */',
    'const text = "import(\'./fake.js\')";',
    'const template = `import("./fake.js")`;',
    'const metadata = import.meta;',
    'const member = object.require("./fake.js");',
  ].join('\n');
  assert.deepEqual(productionDependencies(harmless), []);
  assert.deepEqual(productionDependencies("const value = `${import('./game.js')}`;"), [{
    kind: 'dynamic-import', specifier: './game.js',
  }]);
});

test('accessor snapshot mutants leak or accept unsafe framing on every EOL', async () => {
  for (const [eolLabel, candidate] of sourceForms()) {
    const outboundMutant = await importMutatedModule(
      candidate,
      'export function createCoachRequestPayload(teachingMessage, requestId, modelProfile) {',
      "  return deepFreeze({ version: 2, requestId, locale: 'zh-Hant', sourceRuleId: teachingMessage.ruleId, style: 'child-neutral-teacher-v1', modelProfile });",
      `${eolLabel} accessor outbound`,
    );
    let outboundGetterCalls = 0;
    const accessorMessage = teaching();
    delete accessorMessage.ruleId;
    Object.defineProperty(accessorMessage, 'ruleId', {
      enumerable: true,
      get() {
        outboundGetterCalls++;
        return accessorMessage.body;
      },
    });
    const leaked = outboundMutant.createCoachRequestPayload(accessorMessage, 'accessor-leak', 'economy');
    assert.throws(() => assert.equal(leaked, null),
      (error) => error?.code === 'ERR_ASSERTION',
      `${eolLabel} BROKEN_R3C2_ACCESSOR_TOCTOU_LEAK_WOULD_FAIL`);
    assert.equal(outboundGetterCalls, 1, `${eolLabel} outbound mutant actually executed`);

    const framingMutant = await importReplacedModule(
      candidate,
      '    const response = snapshotCoachResponse(input.response, state.request);',
      '    const response = input.response;',
      `${eolLabel} accessor framing`,
    );
    const started = framingMutant.beginCoachRequest({ modelProfile: 'economy',
      state: framingMutant.createIdleCoachState(),
      teachingMessage: teaching(),
      requestId: 'accessor-framing',
    });
    let framingGetterCalls = 0;
    const hostileResponse = {
      version: 2,
      requestId: started.request.requestId,
      sourceRuleId: started.request.sourceRuleId,
      style: started.request.style,
      modelProfile: started.request.modelProfile,
    };
    Object.defineProperty(hostileResponse, 'framing', {
      enumerable: true,
      get() {
        framingGetterCalls++;
        return framingGetterCalls === 1
          ? { leadIn: '慢慢想一想。', encouragement: '你可以再試一次。' }
          : { leadIn: '這步會將軍', encouragement: '<b>可以吃車</b>' };
      },
    });
    const unsafe = framingMutant.settleCoachResponse({ currentModelProfile: 'economy',
      state: started.state,
      currentTeachingMessage: teaching(),
      response: hostileResponse,
    });
    assert.throws(() => assert.equal(unsafe.accepted, false),
      (error) => error?.code === 'ERR_ASSERTION',
      `${eolLabel} BROKEN_R3C2_ACCESSOR_TOCTOU_FRAMING_WOULD_FAIL`);
    assert.ok(framingGetterCalls >= 2, `${eolLabel} framing mutant actually re-read accessor`);
  }
});

test('pre-validation freeze mutants execute getters and freeze caller input on every EOL',
  async () => {
    for (const [eolLabel, candidate] of sourceForms()) {
      const mutant = await importMutatedModule(
        candidate,
        '  const snapshot = { ...root, evidenceRefs, source };',
        '  deepFreeze(snapshot);',
        `${eolLabel} pre-validation freeze`,
      );
      let getterCalls = 0;
      const hostileTitle = {};
      Object.defineProperty(hostileTitle, 'poison', {
        enumerable: true,
        get() {
          getterCalls++;
          return '私密內容';
        },
      });
      const result = mutant.createCoachRequestPayload(
        teaching({ title: hostileTitle }), `freeze-mutant-${eolLabel}`, 'economy',
      );
      assert.equal(result, null);
      assert.throws(() => assert.equal(getterCalls, 0),
        (error) => error?.code === 'ERR_ASSERTION',
        `${eolLabel} BROKEN_R3C2_PREVALIDATION_FREEZE_GETTER_WOULD_FAIL`);
      assert.throws(() => assert.equal(Object.isFrozen(hostileTitle), false),
        (error) => error?.code === 'ERR_ASSERTION',
        `${eolLabel} BROKEN_R3C2_FREEZES_INVALID_CALLER_INPUT_WOULD_FAIL`);
      assert.equal(getterCalls, 1, `${eolLabel} getter mutant actually executed`);
      assert.equal(Object.isFrozen(hostileTitle), true,
        `${eolLabel} caller-freeze mutant actually executed`);
    }
  });

test('lossy homograph removal mutant restores the exact pre-fix chess-claim bypass', async () => {
  const preFixClaim = '紅馬上前進。';
  const started = begin();
  assert.equal(settle(started, teaching(), responseFor(started.request, {
    leadIn: preFixClaim,
  })).accepted, false, 'BROKEN_R3C2_HOMOGRAPH_CHESS_CLAIM_WOULD_FAIL');

  for (const [eolLabel, candidate] of sourceForms()) {
    const mutant = await importMutatedModule(
      candidate,
      'function containsChessPieceVocabulary(value) {',
      "  value = value.replace(/(?:馬上|將來)/gu, '');",
      `${eolLabel} lossy homograph`,
    );
    const mutantStarted = mutant.beginCoachRequest({ modelProfile: 'economy',
      state: mutant.createIdleCoachState(), teachingMessage: teaching(), requestId: 'lossy-homograph',
    });
    const mutantResponse = responseFor(mutantStarted.request, { leadIn: preFixClaim });
    const accepted = mutant.settleCoachResponse({ currentModelProfile: 'economy',
      state: mutantStarted.state,
      currentTeachingMessage: teaching(),
      response: mutantResponse,
    });
    assert.throws(() => assert.equal(accepted.accepted, false),
      (error) => error?.code === 'ERR_ASSERTION',
      `${eolLabel} BROKEN_R3C2_LOSSY_HOMOGRAPH_REMOVAL_WOULD_FAIL`);
  }
});

test('overflow and wrap mutants violate the bounded revision contract on every EOL', async () => {
  for (const [eolLabel, candidate] of sourceForms()) {
    const overflowMutant = await importMutatedModule(
      candidate,
      'function nextCoachRevision(current) {',
      '  return current + 1;',
      `${eolLabel} revision overflow`,
    );
    const overflow = overflowMutant.beginCoachRequest({ modelProfile: 'economy',
      state: overflowMutant.createIdleCoachState(Number.MAX_SAFE_INTEGER),
      teachingMessage: teaching(),
      requestId: 'overflow-mutant',
    });
    assert.throws(() => assert.equal(Number.isSafeInteger(overflow.state.revision), true),
      (error) => error?.code === 'ERR_ASSERTION',
      `${eolLabel} BROKEN_R3C2_REVISION_OVERFLOW_WOULD_FAIL`);

    const wrapMutant = await importMutatedModule(
      candidate,
      'function nextCoachRevision(current) {',
      '  if (current === Number.MAX_SAFE_INTEGER) return 0;',
      `${eolLabel} revision wrap`,
    );
    const original = wrapMutant.beginCoachRequest({ modelProfile: 'economy',
      state: wrapMutant.createIdleCoachState(Number.MAX_SAFE_INTEGER - 1),
      teachingMessage: teaching(),
      requestId: 'wrapped-request',
    });
    const oldResponse = responseFor(original.request);
    const wrapped = wrapMutant.invalidateCoachState(original.state);
    const replacement = wrapMutant.beginCoachRequest({ modelProfile: 'economy',
      state: wrapped,
      teachingMessage: teaching(),
      requestId: 'wrapped-request',
    });
    const stale = wrapMutant.settleCoachResponse({ currentModelProfile: 'economy',
      state: replacement.state,
      currentTeachingMessage: teaching(),
      response: oldResponse,
    });
    assert.throws(() => assert.equal(stale.accepted, false),
      (error) => error?.code === 'ERR_ASSERTION',
      `${eolLabel} BROKEN_R3C2_REVISION_WRAP_WOULD_FAIL`);
  }
});

test('exact outbound allowlist rejects isolated raw-data and arbitrary-interface mutants on every EOL',
  async () => {
    const target = '    style: GAME_REVIEW_COACH_STYLE,';
    const mutations = [
      ["    board: 'raw-position',", 'BROKEN_R3C2_SENDS_RAW_BOARD_WOULD_FAIL'],
      ["    GameRecord: 'record',", 'BROKEN_R3C2_SENDS_GAME_RECORD_WOULD_FAIL'],
      ['    score: 12,', 'BROKEN_R3C2_SENDS_SCORE_WOULD_FAIL'],
      ['    title: message.title,', 'BROKEN_R3C2_REMOVES_R3C1_FALLBACK_WOULD_FAIL'],
      ['    recordId: message.source.recordId,', 'source identity outbound mutant'],
      ["    prompt: 'arbitrary',", 'BROKEN_R3C2_ARBITRARY_PROMPT_WOULD_FAIL'],
    ];
    assert.throws(() => injectAfterUniqueLine('', target, mutations[0][0], 'missing'),
      /mutation target occurs exactly once/);
    const lf = sourceWithLineEnding(source, '\n');
    assert.throws(() => injectAfterUniqueLine(`${lf}\n${lf}`, target, mutations[0][0], 'duplicate'),
      /mutation target occurs exactly once/);
    for (const [eolLabel, candidate] of sourceForms()) {
      for (const [mutation, label] of mutations) {
        const mutant = await importMutatedModule(candidate, target, mutation, `${eolLabel} ${label}`);
        const payload = mutant.createCoachRequestPayload(teaching(), 'mutation-request', 'economy');
        assert.throws(() => assertExactKeys(payload, OUTBOUND_KEYS),
          (error) => error?.code === 'ERR_ASSERTION', `${eolLabel} ${label}`);
      }
    }
  });

test('unknown-move and new-fact response mutants are rejected', () => {
  const started = begin();
  for (const leadIn of ['炮二平五很好', '這步會將軍', '可以吃車']) {
    assert.equal(settle(started, teaching(), responseFor(started.request, { leadIn })).accepted, false,
      leadIn === '炮二平五很好'
        ? 'BROKEN_R3C2_ACCEPTS_UNKNOWN_MOVE_WOULD_FAIL'
        : 'BROKEN_R3C2_ACCEPTS_NEW_CHESS_FACT_WOULD_FAIL');
  }
});

test('stale invalidation and canonical fallback mutants execute and fail on every EOL', async () => {
  for (const [eolLabel, candidate] of sourceForms()) {
    const staleMutant = await importMutatedModule(
      candidate,
      'export function invalidateCoachState(state) {',
      '  return state;',
      `${eolLabel} stale`,
    );
    const staleStarted = staleMutant.beginCoachRequest({ modelProfile: 'economy',
      state: staleMutant.createIdleCoachState(), teachingMessage: teaching(), requestId: 'stale-r1',
    });
    const staleState = staleMutant.invalidateCoachState(staleStarted.state);
    const staleSettled = staleMutant.settleCoachResponse({ currentModelProfile: 'economy',
      state: staleState,
      currentTeachingMessage: teaching(),
      response: responseFor(staleStarted.request),
    });
    assert.throws(() => assert.equal(staleSettled.accepted, false),
      (error) => error?.code === 'ERR_ASSERTION',
      `${eolLabel} BROKEN_R3C2_STALE_RESPONSE_WOULD_FAIL`);

    const fallbackMutant = await importMutatedModule(
      candidate,
      '      framing: {',
      '      title: currentTeachingMessage.title,',
      `${eolLabel} fallback`,
    );
    const fallbackStarted = fallbackMutant.beginCoachRequest({ modelProfile: 'economy',
      state: fallbackMutant.createIdleCoachState(),
      teachingMessage: teaching(),
      requestId: 'fallback-r1',
    });
    const fallbackSettled = fallbackMutant.settleCoachResponse({ currentModelProfile: 'economy',
      state: fallbackStarted.state,
      currentTeachingMessage: teaching(),
      response: responseFor(fallbackStarted.request),
    });
    assert.throws(() => {
      assertExactKeys(fallbackSettled.state, STATE_KEYS);
      assertExactKeys(fallbackSettled.state.framing, ['leadIn', 'encouragement']);
    },
      (error) => error?.code === 'ERR_ASSERTION',
      `${eolLabel} BROKEN_R3C2_REMOVES_R3C1_FALLBACK_WOULD_FAIL`);
  }
});

test('API-key, engine and storage source mutants fail guards on LF, CRLF and checkout EOLs', () => {
  const target = 'export const GAME_REVIEW_COACH_VERSION = 2;';
  const mutants = [
    ["const OPENAI_API_KEY = 'secret';", 'BROKEN_R3C2_BROWSER_API_KEY_WOULD_FAIL'],
    ["import/**/'./game.js';", 'BROKEN_R3C2_CALLS_ENGINE_WOULD_FAIL'],
    ["localStorage.setItem('coach', 'text');", 'BROKEN_R3C2_PERSISTS_COACH_TEXT_WOULD_FAIL'],
  ];
  for (const [eolLabel, candidate] of sourceForms()) {
    for (const [mutation, label] of mutants) {
      const mutated = injectAfterUniqueLine(candidate, target, mutation, `${eolLabel} ${label}`);
      assert.throws(() => assertPureCoachSource(mutated),
        (error) => error?.code === 'ERR_ASSERTION', `${eolLabel} ${label}`);
    }
  }
});

test('deterministic hostile fuzz covers 3000 cases with replay equivalence', () => {
  const makeRun = () => {
    let seed = 0x3c2a1001;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const outcomes = [];
    const values = [null, undefined, 0, '', [], {}, new Date(0), new Map(), new Set(), () => {}];
    for (let index = 0; index < 3000; index++) {
      const choice = next() % 10;
      let result;
      if (choice === 0) result = beginCoachRequest(values[next() % values.length]);
      else if (choice === 1) result = settleCoachResponse(values[next() % values.length]);
      else if (choice === 2) result = invalidateCoachState(values[next() % values.length]);
      else if (choice === 3) {
        const started = begin(teaching(), `fuzz-${index}`);
        const text = `${String.fromCodePoint(0x4e00 + (next() % 100))}${index}`;
        result = settle(started, teaching(), responseFor(started.request, { leadIn: text }));
      } else if (choice === 4) result = createCoachRequestPayload(teaching(), `fuzz-${next()}`, 'economy');
      else if (choice === 5) {
        const accessorMessage = teaching();
        delete accessorMessage.ruleId;
        Object.defineProperty(accessorMessage, 'ruleId', {
          enumerable: true,
          get() { return index % 2 ? 'check-difference' : accessorMessage.body; },
        });
        result = createCoachRequestPayload(accessorMessage, `fuzz-accessor-${index}`, 'economy');
      } else if (choice === 6) {
        const revisions = [
          Number.MAX_SAFE_INTEGER - 1,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER + 1,
          NaN,
          Infinity,
          -1,
          1.5,
        ];
        const state = createIdleCoachState(revisions[next() % revisions.length]);
        result = beginCoachRequest({ modelProfile: 'economy',
          state, teachingMessage: teaching(), requestId: `fuzz-revision-${index}`,
        });
      } else if (choice === 7) {
        const started = begin(teaching(), `fuzz-framing-${index}`);
        const hostileResponse = responseFor(started.request);
        delete hostileResponse.framing.leadIn;
        Object.defineProperty(hostileResponse.framing, 'leadIn', {
          enumerable: true,
          get() { return index % 2 ? '慢慢想一想。' : '這步會將軍'; },
        });
        result = settle(started, teaching(), hostileResponse);
      } else if (choice === 8) {
        let getterCalls = 0;
        const hostileTitle = {};
        Object.defineProperty(hostileTitle, 'poison', {
          enumerable: true,
          get() { getterCalls++; return '私密內容'; },
        });
        result = {
          result: createCoachRequestPayload(
            teaching({ title: hostileTitle }), `fuzz-scalar-title-${index}`, 'economy',
          ),
          getterCalls,
          frozen: Object.isFrozen(hostileTitle),
        };
      } else {
        const started = begin(teaching(), `fuzz-scalar-framing-${index}`);
        let getterCalls = 0;
        const hostileLeadIn = {};
        Object.defineProperty(hostileLeadIn, 'poison', {
          enumerable: true,
          get() { getterCalls++; return '這步會將軍'; },
        });
        result = {
          result: settle(started, teaching(), responseFor(started.request, {
            leadIn: hostileLeadIn,
          })),
          getterCalls,
          frozen: Object.isFrozen(hostileLeadIn),
        };
      }
      outcomes.push(JSON.stringify(result, (_key, value) => (
        typeof value === 'function' ? '<function>' : value
      )));
    }
    return outcomes;
  };
  const first = makeRun();
  const replay = makeRun();
  assert.equal(first.length, 3000, 'FUZZ_3000=PASS');
  assert.deepEqual(replay, first, 'FUZZ_REPLAY_EQUIVALENCE=PASS');
});
