import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createOpenAIProvider } from './src/openai-provider.js';
import { validateFraming, SAFE_FRAMING } from './src/contract.js';
import { purposeFor } from './src/rule-policy.js';
import { createCoachHandler } from './src/index.js';
import { localFakeAdmission } from './src/admission.js';
import { beginCoachRequest, createIdleCoachState, settleCoachResponse } from '../game-review-coach.js';
import { FakeClock, deferred, flush, request } from './test-support.mjs';

const SECRET = 'OPENAI_TEST_SECRET_SENTINEL_DO_NOT_LEAK';
const input = (modelProfile = 'economy') => ({ sourceRuleId: 'check-difference', locale: 'zh-Hant',
  style: 'child-neutral-teacher-v1', modelProfile, purpose: purposeFor('check-difference') });
const framing = { leadIn: '請慢慢看看提示。', encouragement: '相信自己，繼續學習。' };
const envelope = (text = JSON.stringify(framing)) => ({ object: 'response', status: 'completed',
  error: null, incomplete_details: null, output: [{ type: 'message', role: 'assistant',
    status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] });
const response = (body = envelope(), status = 200) => new Response(JSON.stringify(body), { status });
const redacted = (error) => {
  assert.deepEqual(error, { name: 'CoachProviderError', code: 'provider_unavailable', message: 'Provider unavailable' });
  assert.equal(Object.hasOwn(error, 'stack'), false);
  assert.equal(JSON.stringify(error).includes(SECRET), false);
  return true;
};
function mocked(factory = createOpenAIProvider, reply = () => response()) {
  const calls = [];
  const provider = factory({ apiKey: SECRET, fetch: async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return reply();
  } });
  return { calls, provider };
}

for (const [profile, model] of [['economy', 'gpt-5.6-luna'], ['balanced', 'gpt-5.6-terra'], ['quality', 'gpt-5.6-sol']]) {
  test(`C1A exact request and safe variable framing: ${profile}`, async () => {
    const { provider, calls } = mocked();
    assert.deepEqual(await provider(input(profile)), framing);
    assert.equal(calls.length, 1);
    const { url, options, body } = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' });
    assert.deepEqual(Object.keys(body).sort(), ['model', 'store', 'reasoning', 'max_output_tokens', 'instructions', 'input', 'text'].sort());
    assert.equal(body.model, model);
    assert.equal(body.store, false);
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.max_output_tokens, 128);
    assert.equal(body.input, 'Invite a quiet pause before rereading the existing teaching note.');
    assert.match(body.instructions, /sole chess authority/);
    assert.deepEqual(body.text.format, { type: 'json_schema', name: 'review_coach_framing', strict: true,
      schema: { type: 'object', additionalProperties: false, required: ['leadIn', 'encouragement'],
        properties: { leadIn: { type: 'string', minLength: 1, maxLength: 24 }, encouragement: { type: 'string', minLength: 1, maxLength: 24 } } } });
    assert.equal(JSON.stringify(body).includes(SECRET), false);
  });
}

const unsafe = ['', ' 好', '好 ', '好\n呀', '好\u0000', '<b>好</b>', 'https://example.com', '[好](x)',
  '最好的一步。', '這步可以將軍。', '車一進一', '甲一', '帥', '將。軍', '１２３', 'Ａ一', 'ｊａｖａｓｃｒｉｐｔ：',
  '好'.repeat(25), '你好\u2028呀', '紅相信', '相信進', '棋子', '優勢', '「你好」', 'hello'];
for (const value of unsafe) {
  test(`C1A rejects unsafe framing ${JSON.stringify(value)}`, async () => {
    for (const key of ['leadIn', 'encouragement']) {
      const { provider, calls } = mocked(createOpenAIProvider, () => response(envelope(JSON.stringify({ ...framing, [key]: value }))));
      await assert.rejects(provider(input()), redacted);
      assert.equal(calls.length, 1);
    }
  });
}

const badResponses = [null, [], {}, { ...envelope(), status: 'incomplete' },
  { ...envelope(), error: { message: SECRET } }, { ...envelope(), incomplete_details: {} },
  { ...envelope(), output: [] }, { ...envelope(), output: [...envelope().output, ...envelope().output] },
  { ...envelope(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: SECRET }] }] },
  envelope('not json'), envelope(JSON.stringify({ ...framing, extra: 'no' })), envelope('{"leadIn":"好"}'),
  envelope('{"leadIn":"好","leadIn":"好","encouragement":"好"}'),
  envelope(JSON.stringify({ leadIn: 1, encouragement: '好' })),
  envelope(JSON.stringify({ leadIn: '好'.repeat(25), encouragement: '好'.repeat(24) })),
  { ...envelope(), output: [{ type: 'reasoning', summary: [] }] },
  { ...envelope(), output: [{ ...envelope().output[0], role: 'user' }] },
  { ...envelope(), output: [{ ...envelope().output[0], status: 'in_progress' }] },
  { ...envelope(), output: [{ ...envelope().output[0], content: [...envelope().output[0].content, ...envelope().output[0].content] }] },
  envelope(' '.repeat(1025)), { ...envelope(), padding: 'x'.repeat(16385) }, framing];
for (const [index, body] of badResponses.entries()) {
  test(`C1A response rejection ${index}`, async () => {
    const { provider, calls } = mocked(createOpenAIProvider, () => response(body));
    await assert.rejects(provider(input()), redacted);
    assert.equal(calls.length, 1);
  });
}

test('C1A opaque reasoning ignored; fake framing and 24-codepoint emoji segments accepted', async () => {
  const body = envelope();
  body.output.unshift({ type: 'reasoning', summary: [{ text: SECRET }] });
  assert.deepEqual(await mocked(createOpenAIProvider, () => response(body)).provider(input()), framing);
  assert.ok(validateFraming(SAFE_FRAMING));
  assert.ok(validateFraming({ leadIn: '🙂'.repeat(24), encouragement: '好'.repeat(24) }));
});

test('C1A strict input prevents all caller authorities before fetch', async () => {
  const { provider, calls } = mocked();
  for (const key of ['requestId', 'board', 'position', 'GameRecord', 'record', 'recordId', 'move', 'notation',
    'score', 'PV', 'evaluation', 'evidence', 'title', 'body', 'prompt', 'messages', 'apiKey', 'headers', 'cookies', 'model', 'provider', 'endpoint']) {
    await assert.rejects(provider({ ...input(), [key]: SECRET }), redacted);
  }
  for (const profile of ['unknown', 'gpt-5.6-sol', '__proto__', null, {}]) {
    await assert.rejects(provider(input(profile)), redacted);
  }
  for (const key of ['purpose', 'sourceRuleId', 'locale', 'style']) {
    await assert.rejects(provider({ ...input(), [key]: SECRET }), redacted);
  }
  let getterCalls = 0;
  const accessor = input();
  Object.defineProperty(accessor, 'purpose', { enumerable: true, get() { getterCalls++; return SECRET; } });
  await assert.rejects(provider(accessor), redacted);
  assert.equal(getterCalls, 0);
  assert.equal(calls.length, 0);
  assert.throws(() => createOpenAIProvider({ apiKey: SECRET }), redacted);
});

for (const status of [429, 500, 502, 503, 504]) {
  test(`C1A no retry / redaction on HTTP ${status}`, async () => {
    const { provider, calls } = mocked(createOpenAIProvider, () => response({ secret: SECRET }, status));
    await assert.rejects(provider(input()), redacted);
    assert.equal(calls.length, 1);
  });
}
test('C1A network exception, HTTP fixture, logs and diagnostics redact synthetic secret', async (t) => {
  const logs = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  const { provider, calls } = mocked(createOpenAIProvider, () => { throw new Error(SECRET); });
  await assert.rejects(provider(input()), redacted);
  const http = await createCoachHandler({ provider, admission: localFakeAdmission(true) })(request());
  assert.equal(http.status, 502);
  assert.equal((await http.text()).includes(SECRET), false);
  assert.equal(calls.length, 2, 'one attempt per independent invocation');
  assert.deepEqual(logs, []);
});

test('C1A timeout aborts once and suppresses non-cooperative late completion', async () => {
  const clock = new FakeClock();
  const pending = deferred();
  const calls = [];
  const provider = createOpenAIProvider({ apiKey: SECRET, clock, fetch: (_url, options) => {
    calls.push(options); return pending.promise;
  } });
  const operation = assert.rejects(provider(input()), redacted);
  await flush();
  await clock.advance(3000);
  await operation;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  pending.resolve(response());
  await flush();
  assert.equal(clock.timers.size, 0);
});

test('C1A independent A1/backend framing parity', () => {
  const teachingMessage = { kind: 'review-teaching-message', version: 1, ruleId: 'check-difference', priority: 700,
    title: '先看提示', body: '看看提示。', evidenceRefs: ['source.recordId'],
    source: { recordId: 'parity', ply: 2, positionKey: 'parity', r3aRevision: 1 }, tone: 'child-neutral-zh-Hant', confidence: 'canonical' };
  const begun = beginCoachRequest({ state: createIdleCoachState(), teachingMessage, requestId: 'parity', modelProfile: 'economy' });
  assert.equal(begun.accepted, true);
  for (const value of [...unsafe, '好', '相信自己。', '互相學習。', '即將開始。', '🙂'.repeat(24), '好'.repeat(24)]) {
    const candidate = { leadIn: value, encouragement: '加油。' };
    const accepted = settleCoachResponse({ state: begun.state, currentTeachingMessage: teachingMessage, currentModelProfile: 'economy',
      response: { version: 2, requestId: 'parity', sourceRuleId: 'check-difference', style: 'child-neutral-teacher-v1', modelProfile: 'economy', framing: candidate } }).accepted;
    // C1A explicitly forbids multiline, including Unicode separators A1 currently permits.
    if (/[\u2028\u2029]/u.test(value)) assert.equal(Boolean(validateFraming(candidate)), false);
    else assert.equal(Boolean(validateFraming(candidate)), accepted, JSON.stringify(value));
  }
});

test('C1A successful B1 handler composition preserves v2 response identity', async () => {
  const { provider, calls } = mocked();
  const http = await createCoachHandler({ provider, admission: localFakeAdmission(true) })(request());
  assert.equal(http.status, 200);
  const body = await http.json();
  assert.equal(body.version, 2);
  assert.deepEqual(body.framing, framing);
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
  assert.equal(Object.hasOwn(calls[0].body, 'requestId'), false);
});

test('C1A stalled body timeout cancels reader; pre-abort never fetches', async () => {
  const clock = new FakeClock();
  let cancels = 0;
  let calls = 0;
  const provider = createOpenAIProvider({ apiKey: SECRET, clock, fetch: async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancels++; } }));
  } });
  const pending = assert.rejects(provider(input()), redacted);
  await flush();
  await clock.advance(3000);
  await pending;
  assert.equal(cancels, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider(input(), { signal: controller.signal }), redacted);
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
});

// Mutants execute the actual adapter source with actual backend validation and injected fetch.
// Import/setup errors occur outside the expected AssertionError boundary.
const source = await readFile(new URL('./src/openai-provider.js', import.meta.url), 'utf8');
async function variant(before, after, eol) {
  const normalized = source.replace(/\r\n/g, '\n');
  assert.equal(normalized.split(before).length, 2, 'unique viable mutation site');
  const code = normalized.replace(before, after).replace(/from '(\.\/[^']+)'/g,
    (_match, relative) => `from '${new URL(relative, new URL('./src/', import.meta.url)).href}'`).replace(/\n/g, eol);
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`)).createOpenAIProvider;
}
const mutants = [
  ['CLIENT_MODEL_ID', 'model: MODELS[input.modelProfile]', 'model: input.modelProfile', 'model'],
  ['ARBITRARY_ENDPOINT', 'fetchImpl(ENDPOINT,', "fetchImpl('https://example.com',", 'url'],
  ['API_KEY_IN_BODY', 'body: JSON.stringify(body)', 'body: JSON.stringify({ ...body, apiKey })', 'keys'],
  ['STORE_TRUE', 'store: false', 'store: true', 'store'],
  ['RETRY_ENABLED', 'return readResponse(response, requestSignal);', "if (response.status === 429) await fetchImpl(ENDPOINT, { method: 'POST', body: JSON.stringify(body) }); return readResponse(response, requestSignal);", 'retry'],
  ['TOOLS_ENABLED', 'max_output_tokens: 128,', "max_output_tokens: 128, tools: [{ type: 'web_search' }],", 'keys'],
  ['REQUEST_ID_SENT_TO_MODEL', 'input: purposeFor(input.sourceRuleId)', "requestId: 'browser-id', input: purposeFor(input.sourceRuleId)", 'keys'],
  ['BOARD_SENT_TO_MODEL', 'input: purposeFor(input.sourceRuleId)', "board: [[null]], input: purposeFor(input.sourceRuleId)", 'keys'],
  ['RAW_OUTPUT_ACCEPTED', 'return parseResponse(JSON.parse(new TextDecoder', 'return JSON.parse(new TextDecoder', 'raw'],
  ['BACKEND_VALIDATOR_BYPASS', 'validateFraming(parseRequestJSON(text))', 'parseRequestJSON(text)', 'unsafe'],
  ['SECRET_ERROR_LEAK', "message: 'Provider unavailable'", "message: 'OPENAI_TEST_SECRET_SENTINEL_DO_NOT_LEAK'", 'error'],
];
for (const [name, before, replacement, kind] of mutants) {
  for (const eol of ['\n', '\r\n']) {
    test(`BROKEN_C1A_${name}_WOULD_FAIL ${eol.length === 1 ? 'LF' : 'CRLF'}`, async () => {
      // Raw-output mutant removes the corresponding wrapper closing parenthesis too.
      let after = replacement;
      let match = before;
      if (kind === 'raw') {
        match = "return parseResponse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));";
        after = "return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));";
      }
      const factory = await variant(match, after, eol);
      const reply = kind === 'retry' || kind === 'error' ? () => response({ error: SECRET }, 429)
        : kind === 'unsafe' ? () => response(envelope(JSON.stringify({ ...framing, leadIn: '這步將軍。' }))) : () => response();
      const check = ({ calls, result, error }) => {
        if (kind === 'model') assert.equal(calls[0].body.model, 'gpt-5.6-luna');
        else if (kind === 'url') assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
        else if (kind === 'keys') assert.deepEqual(Object.keys(calls[0].body).sort(), ['model', 'store', 'reasoning', 'max_output_tokens', 'instructions', 'input', 'text'].sort());
        else if (kind === 'store') assert.equal(calls[0].body.store, false);
        else if (kind === 'retry') assert.equal(calls.length, 1);
        else if (kind === 'raw') assert.deepEqual(result, framing);
        else if (kind === 'unsafe') assert.equal(result, undefined);
        else redacted(error);
      };
      const execute = async (implementation) => {
        const { provider, calls } = mocked(implementation, reply);
        let result;
        let error;
        try { result = await provider(input()); } catch (caught) { error = caught; }
        assert.ok(calls.length >= 1, 'intended fetch path reached');
        if (kind !== 'retry' && kind !== 'error' && kind !== 'unsafe') {
          assert.equal(error, undefined, 'successful transport/parser path executed');
        }
        return { calls, result, error };
      };
      check(await execute(createOpenAIProvider));
      const mutated = await execute(factory);
      assert.throws(() => check(mutated), { name: 'AssertionError', code: 'ERR_ASSERTION' });
    });
  }
}
