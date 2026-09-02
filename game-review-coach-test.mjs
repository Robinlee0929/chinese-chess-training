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
  invalidateCoachState,
  settleCoachResponse,
} from './game-review-coach.js';

const source = readFileSync(new URL('./game-review-coach.js', import.meta.url), 'utf8');
const OUTBOUND_KEYS = Object.freeze([
  'version', 'requestId', 'locale', 'sourceRuleId', 'style',
]);
const RESPONSE_KEYS = Object.freeze([
  'version', 'requestId', 'sourceRuleId', 'style', 'framing',
]);
const STATE_KEYS = Object.freeze([
  'version', 'status', 'revision', 'identity', 'request', 'framing',
]);
const clone = (value) => structuredClone(value);

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
    version: GAME_REVIEW_COACH_VERSION,
    requestId: request.requestId,
    sourceRuleId: request.sourceRuleId,
    style: request.style,
    framing: {
      leadIn: '先停一下，慢慢想一想。',
      encouragement: '你可以照自己的步調思考。',
      ...framing,
    },
  };
}

function begin(message = teaching(), requestId = 'request-001', state = createIdleCoachState()) {
  const result = beginCoachRequest({ state, teachingMessage: message, requestId });
  assert.equal(result.accepted, true);
  return result;
}

function settle(beginResult, message = teaching(), response = responseFor(beginResult.request)) {
  return settleCoachResponse({
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
    /\b(?:localStorage|sessionStorage|indexedDB)\b/u,
    /\b(?:document|HTMLElement|querySelector|textContent)\b/u,
    /\b(?:setTimeout|setInterval|AbortController)\b/u,
    /\b(?:Authorization|Bearer|OPENAI_API_KEY|apiKey|providerSecret)\b/u,
    /\b(?:prompt|system|messages)\b/u,
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

async function importMutatedModule(candidate, targetLine, injectedLine, label) {
  const mutated = injectAfterUniqueLine(candidate, targetLine, injectedLine, label);
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
    version: 1, status: 'disabled', revision: 0, identity: null, request: null, framing: null,
  });
  assert.deepEqual(idle, {
    version: 1, status: 'idle', revision: 4, identity: null, request: null, framing: null,
  });
  assertDeepFrozen(disabled);
  assertDeepFrozen(idle);
});

test('disabled state cannot begin or build a sendable request', () => {
  const result = beginCoachRequest({
    state: createDisabledCoachState(), teachingMessage: teaching(), requestId: 'disabled-request',
  });
  assert.equal(result.accepted, false);
  assert.equal(result.request, null);
  assert.equal(result.reason, 'DISABLED');
});

test('valid begin emits the exact five-key outbound payload and localizes identity', () => {
  const input = teaching();
  const before = clone(input);
  const result = begin(input);
  assert.deepEqual(result.request, {
    version: 1,
    requestId: 'request-001',
    locale: GAME_REVIEW_COACH_LOCALE,
    sourceRuleId: 'check-difference',
    style: GAME_REVIEW_COACH_STYLE,
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
    const result = beginCoachRequest({
      state: createIdleCoachState(), teachingMessage: message, requestId: 'bad-teaching',
    });
    assert.equal(result.accepted, false);
    assert.equal(result.request, null);
  }
});

test('request identifiers are bounded opaque strings', () => {
  assert.ok(createCoachRequestPayload(teaching(), 'x'.repeat(64)));
  for (const requestId of ['', ' x', 'x y', 'x\n', 'x'.repeat(65), 1, null]) {
    assert.equal(createCoachRequestPayload(teaching(), requestId), null);
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
    version: 1, status: 'idle', revision: 2, identity: null, request: null, framing: null,
  });
  assert.equal(settleCoachResponse({
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

test('exact outbound allowlist rejects isolated raw-data and arbitrary-interface mutants on every EOL',
  async () => {
    const target = '      style: GAME_REVIEW_COACH_STYLE,';
    const mutations = [
      ["      board: 'raw-position',", 'BROKEN_R3C2_SENDS_RAW_BOARD_WOULD_FAIL'],
      ["      GameRecord: 'record',", 'BROKEN_R3C2_SENDS_GAME_RECORD_WOULD_FAIL'],
      ['      score: 12,', 'BROKEN_R3C2_SENDS_SCORE_WOULD_FAIL'],
      ['      title: teachingMessage.title,', 'BROKEN_R3C2_REMOVES_R3C1_FALLBACK_WOULD_FAIL'],
      ['      recordId: teachingMessage.source.recordId,', 'source identity outbound mutant'],
      ["      prompt: 'arbitrary',", 'BROKEN_R3C2_ARBITRARY_PROMPT_WOULD_FAIL'],
    ];
    assert.throws(() => injectAfterUniqueLine('', target, mutations[0][0], 'missing'),
      /mutation target occurs exactly once/);
    const lf = sourceWithLineEnding(source, '\n');
    assert.throws(() => injectAfterUniqueLine(`${lf}\n${lf}`, target, mutations[0][0], 'duplicate'),
      /mutation target occurs exactly once/);
    for (const [eolLabel, candidate] of sourceForms()) {
      for (const [mutation, label] of mutations) {
        const mutant = await importMutatedModule(candidate, target, mutation, `${eolLabel} ${label}`);
        const payload = mutant.createCoachRequestPayload(teaching(), 'mutation-request');
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
    const staleStarted = staleMutant.beginCoachRequest({
      state: staleMutant.createIdleCoachState(), teachingMessage: teaching(), requestId: 'stale-r1',
    });
    const staleState = staleMutant.invalidateCoachState(staleStarted.state);
    const staleSettled = staleMutant.settleCoachResponse({
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
    const fallbackStarted = fallbackMutant.beginCoachRequest({
      state: fallbackMutant.createIdleCoachState(),
      teachingMessage: teaching(),
      requestId: 'fallback-r1',
    });
    const fallbackSettled = fallbackMutant.settleCoachResponse({
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
  const target = 'export const GAME_REVIEW_COACH_VERSION = 1;';
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
      const choice = next() % 5;
      let result;
      if (choice === 0) result = beginCoachRequest(values[next() % values.length]);
      else if (choice === 1) result = settleCoachResponse(values[next() % values.length]);
      else if (choice === 2) result = invalidateCoachState(values[next() % values.length]);
      else if (choice === 3) {
        const started = begin(teaching(), `fuzz-${index}`);
        const text = `${String.fromCodePoint(0x4e00 + (next() % 100))}${index}`;
        result = settle(started, teaching(), responseFor(started.request, { leadIn: text }));
      } else result = createCoachRequestPayload(teaching(), `fuzz-${next()}`);
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
