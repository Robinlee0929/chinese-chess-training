import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import worker, { createCoachHandler } from './src/index.js';
import { REQUEST_KEYS, SAFE_FRAMING, validateRequest, validateFraming, parseRequestJSON } from './src/contract.js';
import { RULE_PURPOSES } from './src/rule-policy.js';
import { DEFAULT_PROFILE_POLICY, validateProfilePolicy } from './src/profile-policy.js';
import { localFakeAdmission } from './src/admission.js';
import { reply, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from './src/http.js';
import { R3C2_B_PROVIDER_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from './src/provider.js';
import { harness, payload, request, assertResponse, assertHeaders, ORIGIN, SENTINEL,
  FakeClock, deferred, flush, chunked, observeSideEffects, productionSources, importVariant,
  isNodeBuiltinSpecifier, productionIsolationIssues, productionGraphIssues,
  assertProductionIsolation, runProductionSandbox, SANDBOX_EXPOSED_GLOBALS } from './test-support.mjs';

const profiles = ['economy', 'balanced', 'quality'];
const rules = ['immediate-mate', 'immediate-repetition-terminal', 'immediate-stalemate', 'check-difference',
  'capture-with-capture-reply', 'capture-difference', 'moved-piece-capturable-difference'];
const extras = ['extra', 'model', 'modelId', 'providerModel', 'openaiModel', 'provider', 'apiKey', 'prompt',
  'system', 'messages', 'ruleDescription', 'title', 'body', 'board', 'position', 'record', 'recordId',
  'gameRecord', 'GameRecord', 'notation', 'move', 'score', 'pv', 'PV', 'evaluation', '__proto__', 'constructor'];

async function rejected(data, status = 400) {
  const server = harness();
  await assertResponse(await server.handle(request({ data })), status);
  assert.equal(server.calls.length, 0);
}

for (const modelProfile of profiles) test(`success v2 ${modelProfile}`, async () => {
  const server = harness();
  const response = await server.handle(request({ data: payload({ modelProfile }) }));
  await assertResponse(response, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(), { version: 2, requestId: 'b1-request', sourceRuleId: 'check-difference',
    style: 'child-neutral-teacher-v1', modelProfile, framing: { leadIn: '可以一起看看這個地方。', encouragement: '下次也可以先停一下想想。' } });
  assert.equal(server.calls.length, 1);
});
for (const sourceRuleId of rules) test(`server-owned purpose for ${sourceRuleId}`, async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ data: payload({ sourceRuleId }) })), 200);
  assert.deepEqual(server.calls[0].input, { sourceRuleId, locale: 'zh-Hant', style: 'child-neutral-teacher-v1',
    modelProfile: 'economy', purpose: RULE_PURPOSES[sourceRuleId] });
  assert.ok(Object.isFrozen(server.calls[0].input));
});
for (const key of extras) test(`reject extra field ${key} before provider`, async () => {
  await rejected({ ...payload(), [key]: 'BROWSER_PROMPT_SENTINEL' });
});
for (const key of ['version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile']) {
  test(`missing ${key}`, async () => { const data = payload(); delete data[key]; await rejected(data); });
}
for (const [key, values] of Object.entries({
  version: [1, '2', null, 3, true],
  requestId: ['', ' ', 'x y', 'x\ny', 'x\u0000y', 'x\u0085y', 'x\u2028y', 'x'.repeat(65), 2, null],
  locale: ['en', 'zh-hant', 'zh-Hant ', null],
  style: ['other', 'child-neutral-teacher-v1 ', null],
  sourceRuleId: ['unknown', 'Check-difference', 'check-difference ', ' check-difference', null, 1, {}],
  modelProfile: ['unknown', 'Economy', 'economy ', ' economy', 'gpt-arbitrary', null, 1, true, {}],
})) for (const [index, value] of values.entries()) test(`invalid ${key} ${index}`, () => rejected(payload({ [key]: value })));

test('requestId boundary is codepoints, no coercion; valid frozen input remains valid', async () => {
  for (const requestId of ['a', '象'.repeat(64), '😀'.repeat(64)]) {
    const server = harness();
    const response = await server.handle(request({ data: payload({ requestId }) }));
    await assertResponse(response, 200);
    assert.equal((await response.json()).requestId, requestId);
  }
  const object = Object.freeze(payload());
  assert.ok(validateRequest(object));
  assert.equal(Object.isFrozen(object), true);
});

for (const [index, body] of ['', '{', '{}x', '{"version":2,}', 'null', '[]', 'true', '2', '"text"',
  '\ufeff' + JSON.stringify(payload()), JSON.stringify(payload()) + '\v',
  '{"version":02}', '{"version":+2}', '{"version":2.}', '{"version":NaN}',
  '{"version":2,"requestId":"bad\nraw"}', '{"version":2,"requestId":"\\q"}',
  '{"version":2,/*comment*/"requestId":"x"}', JSON.stringify({ ...payload(), nested: {} }),
  JSON.stringify(payload()).replace('"version":2', '"version":1,"version":2'),
  JSON.stringify(payload()).replace('"requestId":"b1-request"', '"requestId":"bad","request\\u0049d":"b1-request"'),
  JSON.stringify(payload()).replace('"modelProfile":"economy"', '"modelProfile":"quality","model\\u0050rofile":"economy"'),
].entries()) test(`invalid JSON/duplicate member ${index}`, async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ body })), 400);
  assert.equal(server.calls.length, 0);
});

test('valid JSON escapes accepted without renaming unknown or duplicate keys', async () => {
  const server = harness();
  const body = JSON.stringify(payload()).replace('requestId', 'request\\u0049d');
  await assertResponse(await server.handle(request({ body })), 200);
  assert.equal(parseRequestJSON('{"__proto__":"x"}').__proto__, 'x');
  assert.equal(validateRequest(parseRequestJSON('{"__proto__":"x"}')), null);
});
for (const bytes of [[0xc3, 0x28], [0xff], [0xed, 0xa0, 0x80]]) test(`fatal UTF-8 ${bytes}`, async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ body: new Uint8Array(bytes) })), 400);
  assert.equal(server.calls.length, 0);
});

for (const [header, value, status] of [
  ['Content-Type', 'text/plain', 415], ['Content-Type', '', 415], ['Content-Type', 'application/json; charset=latin1', 415],
  ['Content-Type', 'application/json; boundary=x', 415], ['Content-Encoding', 'gzip', 415],
  ['Content-Encoding', 'br', 415], ['Content-Encoding', 'identity', 415], ['Content-Length', '1025', 413],
  ['Content-Length', '-1', 400], ['Content-Length', 'bad', 400], ['Content-Length', '1.2', 400],
]) test(`header rejected ${header}=${value}`, async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ headers: { [header]: value } })), status);
  assert.equal(server.calls.length, 0);
});
test('missing media type rejected; UTF-8 charset accepted precisely', async () => {
  const server = harness();
  const noType = request(); noType.headers.delete('Content-Type');
  await assertResponse(await server.handle(noType), 415);
  await assertResponse(await server.handle(request({ headers: { 'Content-Type': 'Application/JSON; Charset=UTF-8' } })), 200);
  assert.equal(server.calls.length, 1);
});

for (const length of [1024, 1025]) for (const declared of [null, '1', String(length)]) {
  test(`actual streamed body ${length} bytes Content-Length=${declared}`, async () => {
    const data = JSON.stringify(payload());
    const bytes = new TextEncoder().encode(data + ' '.repeat(length - new TextEncoder().encode(data).length));
    let canceled = 0;
    const server = harness();
    const headers = declared === null ? {} : { 'Content-Length': declared };
    const response = await server.handle(request({ body: chunked(bytes, 19, () => { canceled++; }), headers }));
    await assertResponse(response, length === 1024 ? 200 : 413);
    assert.equal(server.calls.length, length === 1024 ? 1 : 0);
    if (length === 1025 && declared !== '1025') assert.equal(canceled, 1);
  });
}
test('byte limit is UTF-8 bytes, not characters', async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ body: JSON.stringify(payload({ prompt: '象'.repeat(400) })) })), 413);
  assert.equal(server.calls.length, 0);
});
test('single oversize stream chunk canceled and never parsed', async () => {
  let canceled = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { canceled++; } });
  const server = harness();
  await assertResponse(await server.handle(request({ body })), 413);
  assert.equal(canceled, 1); assert.equal(server.calls.length, 0);
});
test('stream errors fail closed', async () => {
  const body = new ReadableStream({ pull(controller) { controller.error(new Error(SENTINEL)); } });
  const server = harness();
  await assertResponse(await server.handle(request({ body })), 400);
  assert.equal(server.calls.length, 0);
});

for (const [method, path, status, allow] of [
  ['GET', '/api/review-coach', 405, 'POST, OPTIONS'], ['HEAD', '/api/review-coach', 405, 'POST, OPTIONS'],
  ['POST', '/api/review-coach/capabilities', 405, 'GET, OPTIONS'], ['PUT', '/api/review-coach', 405, 'POST, OPTIONS'],
  ['POST', '/other', 404, null], ['POST', '/api/review-coach/', 404, null],
  ['GET', '/api/review-coach/capabilities/', 404, null], ['OPTIONS', '/unknown', 404, null],
  ['POST', '/api/review-coach?fault=timeout', 400, null], ['POST', '/api/review-coach?', 400, null],
  ['GET', '/api/review-coach/capabilities?profile=quality', 400, null],
]) test(`route ${method} ${path}`, async () => {
  const server = harness();
  const response = await server.handle(request({ method, path }));
  await assertResponse(response, status);
  assert.equal(response.headers.get('Allow'), allow);
  assert.equal(server.calls.length, 0);
});
for (const origin of [null, 'null', 'https://evil.invalid', ORIGIN + '/', ORIGIN + '/chinese-chess-training',
  'http://robinlee0929.github.io', ORIGIN + '.evil.invalid']) test(`origin rejected ${origin}`, async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ origin })), 403, null);
  assert.equal(server.calls.length, 0);
});
for (const header of ['Cookie', 'Authorization']) test(`credentials rejected ${header}`, async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ headers: { [header]: SENTINEL } })), 403);
  assert.equal(server.calls.length, 0);
});

for (const [path, method] of [['/api/review-coach', 'POST'], ['/api/review-coach/capabilities', 'GET']]) {
  for (const requestedHeaders of [null, 'Content-Type', 'content-type', 'CONTENT-TYPE']) {
    test(`preflight ${method} ${requestedHeaders}`, async () => {
      let gates = 0;
      const server = harness({ admission: { enabled: () => { gates++; return false; } } });
      const headers = { 'Access-Control-Request-Method': method };
      if (requestedHeaders !== null) headers['Access-Control-Request-Headers'] = requestedHeaders;
      const response = await server.handle(request({ path, method: 'OPTIONS', body: null, headers }));
      await assertResponse(response, 204);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('Access-Control-Allow-Methods'), `${method}, OPTIONS`);
      assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
      assert.equal(response.headers.get('Access-Control-Max-Age'), '0');
      assert.equal(response.headers.get('Vary'), 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      assert.equal(gates, 0); assert.equal(server.calls.length, 0);
    });
  }
}
for (const headers of [{}, { 'Access-Control-Request-Method': 'GET' },
  { 'Access-Control-Request-Method': 'post' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization' },
  { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-fault-mode' },
  { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': '*' },
]) test(`bad preflight ${JSON.stringify(headers)}`, async () => {
  const server = harness();
  const response = await server.handle(request({ method: 'OPTIONS', headers }));
  await assertResponse(response, 403);
  assert.equal(response.headers.get('Vary'), 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
  assert.equal(response.headers.get('Access-Control-Max-Age'), '0');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), null);
  assert.equal(server.calls.length, 0);
});

for (const availability of [DEFAULT_PROFILE_POLICY, { economy: true, balanced: false, quality: true },
  { economy: false, balanced: false, quality: false }]) test(`exact capabilities ${JSON.stringify(availability)}`, async () => {
  const server = harness({ getProfilePolicy: () => availability });
  const response = await server.handle(request({ method: 'GET', path: '/api/review-coach/capabilities' }));
  await assertResponse(response, 200);
  assert.deepEqual(await response.json(), { version: 1, profiles: profiles.map((id) => ({ id, available: availability[id] })), defaultProfile: 'economy' });
  assert.equal(server.calls.length, 0);
});
for (const modelProfile of profiles) test(`fresh availability ${modelProfile}, 409 without fallback`, async () => {
  let policy = { ...DEFAULT_PROFILE_POLICY };
  let reads = 0;
  const server = harness({ getProfilePolicy: () => { reads++; return policy; } });
  const cap = await server.handle(request({ method: 'GET', path: '/api/review-coach/capabilities' }));
  assert.equal((await cap.json()).profiles.find((p) => p.id === modelProfile).available, true);
  policy = { ...policy, [modelProfile]: false };
  const response = await server.handle(request({ data: payload({ modelProfile }) }));
  await assertResponse(response, 409);
  assert.deepEqual(await response.json(), { version: 2, error: { code: 'profile_unavailable' } });
  assert.equal(reads, 2); assert.equal(server.calls.length, 0);
});
for (const policy of [null, {}, { ...DEFAULT_PROFILE_POLICY, quality: 'false' },
  { ...DEFAULT_PROFILE_POLICY, modelId: 'arbitrary' }]) test(`invalid policy ${JSON.stringify(policy)}`, async () => {
  const server = harness({ getProfilePolicy: () => policy });
  await assertResponse(await server.handle(request()), 503);
  assert.equal(server.calls.length, 0);
});

const unsafeTexts = ['這步將軍。', '可以將死。', '這步會吃子。', '這是最好的一步。', '你真棒。', '高品質解說。',
  '<b>看看</b>', '**看看**', '[看看](https://evil.invalid)', 'https://evil.invalid', 'www.evil.invalid',
  '看看\u0000', '看看\n', 'ＡＩ很厲害', 'ｈｔｔｐｓ：／／evil.invalid', '这步将军。', '將\u200b軍',
  '可以一起看看這個地方。 ', '可以一起看看這個地方!', '', '象'.repeat(25), '😀'.repeat(25)];
for (const [index, leadIn] of unsafeTexts.entries()) test(`untrusted provider text ${index}`, async () => {
  const server = harness({ provider: () => ({ ...SAFE_FRAMING, leadIn }) });
  // C1A accepts variable A1-safe framing; these were rejected only by B1's literal-pair gate.
  const nowSafe = ['你真棒。', '高品質解說。', '**看看**', '可以一起看看這個地方!'].includes(leadIn);
  await assertResponse(await server.handle(request()), nowSafe ? 200 : 502);
  assert.equal(server.calls.length, 1);
});
for (const [index, value] of [null, undefined, [], 'text', 1, {}, { ...SAFE_FRAMING, extra: 'x' },
  { framing: SAFE_FRAMING }, { ...SAFE_FRAMING, requestId: 'wrong' }, { ...SAFE_FRAMING, leadIn: 2 },
  { ...SAFE_FRAMING, encouragement: new String(SAFE_FRAMING.encouragement) },
].entries()) test(`malformed provider result ${index}`, async () => {
  const server = harness({ provider: () => value });
  await assertResponse(await server.handle(request()), 502);
  assert.equal(server.calls.length, 1);
});
test('provider exception sanitized; no retry or side effects', async () => {
  const server = harness({ provider: () => { throw new Error(SENTINEL); } });
  const observed = await observeSideEffects(() => server.handle(request()));
  await assertResponse(observed.value, 502);
  assert.deepEqual(observed.observations, { logs: [], network: [], storage: [] });
  assert.equal(server.calls.length, 1);
});

for (const [name, validator, valid] of [['request', validateRequest, payload()],
  ['framing', validateFraming, { ...SAFE_FRAMING }], ['policy', validateProfilePolicy, { ...DEFAULT_PROFILE_POLICY }]]) {
  test(`${name} descriptor boundary: accessors, symbols, prototypes, reflection, no freezing`, () => {
    let getters = 0;
    for (const key of Object.keys(valid)) {
      const hostile = { ...valid };
      Object.defineProperty(hostile, key, { enumerable: true, get() { getters++; return valid[key]; } });
      assert.equal(validator(hostile), null);
      assert.equal(Object.isFrozen(hostile), false);
      const hidden = { ...valid }; Object.defineProperty(hidden, key, { enumerable: false });
      assert.equal(validator(hidden), null);
    }
    for (const value of [Object.assign(Object.create(null), valid), Object.assign(Object.create({ inherited: true }), valid),
      { ...valid, [Symbol('extra')]: true }, new Proxy(valid, { ownKeys() { throw new Error(SENTINEL); } }),
      new Proxy(valid, { getPrototypeOf() { throw new Error(SENTINEL); } })]) assert.equal(validator(value), null);
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    assert.equal(validator(revoked.proxy), null);
    assert.equal(getters, 0);
    assert.equal(Object.isFrozen(valid), false);
  });
}
test('hostile request strings never coerce or freeze', () => {
  let coercions = 0;
  const stringLike = { toString() { coercions++; return 'economy'; }, valueOf() { coercions++; return 2; } };
  for (const key of REQUEST_KEYS) {
    for (const value of [stringLike, new String(String(payload()[key]))]) assert.equal(validateRequest(payload({ [key]: value })), null);
  }
  assert.equal(coercions, 0); assert.equal(Object.isFrozen(stringLike), false);
});
test('provider accessor not executed through the live handler', async () => {
  let getters = 0;
  const value = { ...SAFE_FRAMING };
  Object.defineProperty(value, 'leadIn', { enumerable: true, get() { getters++; return SAFE_FRAMING.leadIn; } });
  const server = harness({ provider: () => value });
  await assertResponse(await server.handle(request()), 502);
  assert.equal(getters, 0); assert.equal(Object.isFrozen(value), false);
});
test('framing rejects unsafe encouragement and hidden fields independently', async () => {
  for (const encouragement of ['這是最好的一步。', '<b>繼續</b>', 'https://evil.invalid', '', '象'.repeat(25)]) {
    const server = harness({ provider: () => ({ ...SAFE_FRAMING, encouragement }) });
    await assertResponse(await server.handle(request()), 502);
    assert.equal(server.calls.length, 1);
  }
  const value = { ...SAFE_FRAMING };
  Object.defineProperty(value, 'hidden', { value: SENTINEL });
  assert.equal(validateFraming(value), null);
});

for (const [gate, value, status] of [['enabled', false, 503], ['enabled', 'true', 503], ['enabled', undefined, 503],
  ['rateLimit', 'denied', 429], ['rateLimit', false, 503], ['rateLimit', undefined, 503],
  ['costBreaker', 'temporarily_disabled', 503], ['costBreaker', undefined, 503], ['costBreaker', true, 503]]) {
  test(`admission fail closed ${gate}=${value}`, async () => {
    const server = harness({ admission: { ...localFakeAdmission(true), [gate]: () => value } });
    await assertResponse(await server.handle(request()), status);
    assert.equal(server.calls.length, 0);
  });
}
for (const gate of ['enabled', 'rateLimit', 'costBreaker']) {
  test(`admission ${gate} throws`, async () => {
    const server = harness({ admission: { ...localFakeAdmission(true), [gate]: () => { throw new Error(SENTINEL); } } });
    await assertResponse(await server.handle(request()), 503);
    assert.equal(server.calls.length, 0);
  });
  test(`admission ${gate} times out, aborts, ignores late allow`, async () => {
    const clock = new FakeClock(); const pending = deferred(); let signal;
    const server = harness({ clock, admission: { ...localFakeAdmission(true),
      [gate]: (options) => { signal = options.signal; return pending.promise; } } });
    const result = server.handle(request()); await flush();
    assert.ok(signal); await clock.advance(499); assert.equal(signal.aborted, false);
    await clock.advance(1); const response = await result;
    await assertResponse(response, 503); assert.equal(signal.aborted, true);
    pending.resolve(gate === 'enabled' ? true : gate === 'rateLimit' ? 'allowed' : 'enabled'); await flush();
    assert.equal(server.calls.length, 0); assert.equal(clock.timers.size, 0);
  });
}
for (const admission of [undefined, null, {}, { enabled: true }, { ...localFakeAdmission(true), rateLimit: null }]) {
  test(`missing admission fails closed ${JSON.stringify(admission)}`, async () => {
    const server = harness({ admission });
    await assertResponse(await server.handle(request()), 503); assert.equal(server.calls.length, 0);
  });
}
test('default Worker is disabled; only explicit nonsecret local enable flag runs fake', async () => {
  await assertResponse(await createCoachHandler()(request()), 503);
  await assertResponse(await worker.fetch(request(), { COACH_FAKE_ENABLED: false }), 503);
  await assertResponse(await worker.fetch(request(), { COACH_FAKE_ENABLED: 'true' }), 200);
  await assertResponse(await worker.fetch(request({ method: 'GET', path: '/api/review-coach/capabilities' }), {}), 503);
});
test('Worker never inspects unrelated environment secrets or resource bindings', async () => {
  let inspected = 0;
  const env = { COACH_FAKE_ENABLED: 'true' };
  for (const key of ['UNUSED_SECRET', 'DB', 'KV', 'LIMITER']) {
    Object.defineProperty(env, key, { enumerable: true, get() { inspected++; throw new Error(SENTINEL); } });
  }
  const observed = await observeSideEffects(() => worker.fetch(request(), env));
  await assertResponse(observed.value, 200);
  assert.equal(inspected, 0);
  assert.deepEqual(observed.observations, { logs: [], network: [], storage: [] });
});
test('repeated request IDs do not cache, deduplicate or bypass fresh admission', async () => {
  let admitted = 0;
  const server = harness({ admission: { ...localFakeAdmission(true), enabled: () => { admitted++; return true; } } });
  await assertResponse(await server.handle(request()), 200);
  await assertResponse(await server.handle(request()), 200);
  assert.equal(admitted, 2); assert.equal(server.calls.length, 2);
});

test('provider accepts result at 2999 ms and clears deadline', async () => {
  const clock = new FakeClock(); const pending = deferred();
  const server = harness({ clock, provider: () => pending.promise });
  const result = server.handle(request()); await flush();
  assert.equal(server.calls.length, 1); await clock.advance(2999);
  pending.resolve({ ...SAFE_FRAMING }); await flush();
  await assertResponse(await result, 200);
  assert.equal(clock.timers.size, 0); assert.equal(server.calls[0].options.signal.aborted, false);
});
for (const settlement of ['never', 'late-resolve', 'late-reject']) test(`provider deadline 3000 ms ${settlement}`, async () => {
  const clock = new FakeClock(); const pending = deferred(); const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const server = harness({ clock, provider: () => pending.promise });
    let completed = false;
    const result = server.handle(request()).then((response) => { completed = true; return response; });
    await flush(); assert.equal(server.calls.length, 1);
    await clock.advance(2999); assert.equal(completed, false); assert.equal(server.calls[0].options.signal.aborted, false);
    await clock.advance(1); const response = await result;
    await assertResponse(response, 504); assert.equal(server.calls[0].options.signal.aborted, true);
    if (settlement === 'late-resolve') pending.resolve({ ...SAFE_FRAMING });
    if (settlement === 'late-reject') pending.reject(new Error(SENTINEL));
    await flush(); await new Promise((resolve) => setImmediate(resolve));
    await assertResponse(response, 504); assert.equal(server.calls.length, 1);
    assert.equal(clock.timers.size, 0); assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});
test('provider resolving exactly at deadline is too late', async () => {
  const clock = new FakeClock();
  const server = harness({ clock, provider: () => { clock.time = 3000; return { ...SAFE_FRAMING }; } });
  await assertResponse(await server.handle(request()), 504);
  assert.equal(server.calls[0].options.signal.aborted, true);
});
test('provider rejected promise is observed and sanitized', async () => {
  const server = harness({ provider: () => Promise.reject(new Error(SENTINEL)) });
  await assertResponse(await server.handle(request()), 502); assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].options.signal.aborted, true);
});
test('client cancellation before body invokes no provider', async () => {
  const controller = new AbortController(); controller.abort();
  const server = harness(); await assertResponse(await server.handle(request({ signal: controller.signal })), 400);
  assert.equal(server.calls.length, 0);
});
test('client cancellation aborts in-flight provider without retry', async () => {
  const controller = new AbortController(); const clock = new FakeClock();
  const server = harness({ clock, provider: () => new Promise(() => {}) });
  const result = server.handle(request({ signal: controller.signal })); await flush();
  controller.abort(); await assertResponse(await result, 504);
  assert.equal(server.calls.length, 1); assert.equal(server.calls[0].options.signal.aborted, true);
  assert.equal(clock.timers.size, 0);
});
test('stalled body bounded by total deadline and canceled', async () => {
  const clock = new FakeClock(); let canceled = 0;
  const body = new ReadableStream({ cancel() { canceled++; } });
  const server = harness({ clock }); const result = server.handle(request({ body }));
  await flush(); await clock.advance(3500); await assertResponse(await result, 400);
  assert.equal(canceled, 1); assert.equal(server.calls.length, 0); assert.equal(clock.timers.size, 0);
});
test('slow body reduces provider deadline to remaining total budget', async () => {
  const clock = new FakeClock(); let streamController;
  const body = new ReadableStream({ start(controller) { streamController = controller; } });
  const server = harness({ clock, provider: () => new Promise(() => {}) });
  const result = server.handle(request({ body })); await flush(); await clock.advance(1000);
  streamController.enqueue(new TextEncoder().encode(JSON.stringify(payload()))); streamController.close(); await flush();
  assert.equal(server.calls.length, 1); await clock.advance(2499); assert.equal(server.calls[0].options.signal.aborted, false);
  await clock.advance(1); await assertResponse(await result, 504); assert.equal(clock.time, 3500);
});

test('HTTP metadata/requestId never forwarded; unknown public fault header has no effect', async () => {
  const server = harness();
  await assertResponse(await server.handle(request({ data: payload({ requestId: 'BROWSER_PROMPT_SENTINEL' }),
    headers: { 'X-Fault-Mode': 'timeout', 'X-Prompt': SENTINEL, 'X-Forwarded-For': '192.0.2.1', 'CF-Connecting-IP': '192.0.2.2' } })), 200);
  assert.deepEqual(Object.keys(server.calls[0].input).sort(), ['sourceRuleId', 'locale', 'style', 'modelProfile', 'purpose'].sort());
  assert.deepEqual(Object.keys(server.calls[0].options), ['signal']);
  assert.ok(server.calls[0].options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify(server.calls).includes('BROWSER_PROMPT_SENTINEL'), false);
  assert.equal(JSON.stringify(server.calls).includes(SENTINEL), false);
  assert.equal(server.calls[0].input.purpose, RULE_PURPOSES['check-difference']);
});
test('success/failure/capabilities paths make zero network, storage and application log calls', async () => {
  const observed = await observeSideEffects(async () => {
    const responses = [];
    for (const options of [{}, { provider: () => Promise.reject(new Error(SENTINEL)) },
      { provider: () => ({ ...SAFE_FRAMING, leadIn: SENTINEL }) }, { getProfilePolicy: () => { throw new Error(SENTINEL); } },
      { admission: localFakeAdmission(false) }]) responses.push(await harness(options).handle(request()));
    responses.push(await worker.fetch(request(), { COACH_FAKE_ENABLED: 'true', UNUSED_SECRET: SENTINEL }));
    responses.push(await harness().handle(request({ method: 'GET', path: '/api/review-coach/capabilities' })));
    return responses;
  });
  assert.deepEqual(observed.observations, { logs: [], network: [], storage: [] });
  assert.deepEqual(observed.value.map((r) => r.status), [200, 502, 502, 500, 503, 200, 200]);
  for (const response of observed.value) {
    assertHeaders(response);
    assert.equal((await response.text()).includes(SENTINEL), false);
    assert.equal(JSON.stringify([...response.headers]).includes(SENTINEL), false);
  }
});
test('serialized response UTF-8 cap enforces 1024/1025 boundary', async () => {
  for (const bytes of [1024, 1025]) {
    const body = { value: 'x'.repeat(bytes - 12) }; // {"value":""} is 12 bytes.
    assert.equal(new TextEncoder().encode(JSON.stringify(body)).byteLength, bytes);
    const response = reply(200, ORIGIN, body);
    await assertResponse(response, bytes === 1024 ? 200 : 500);
  }
  await assertResponse(reply(200, ORIGIN, { value: '象'.repeat(400) }), 500);
});

const fakeProviderStart = 'export function fakeProvider(_input, { signal }) {';
const sandboxWorkerOperation = Object.freeze({
  type: 'worker', url: `${ORIGIN}/api/review-coach`,
  init: { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload()) },
  env: { COACH_FAKE_ENABLED: 'true' },
});

function assertSandboxBlocked(result, expectedCode) {
  assert.equal(result.ok, false, `sandbox unexpectedly completed: ${JSON.stringify(result)}`);
  if (expectedCode) assert.equal(result.error.code, expectedCode);
  assert.equal(result.sandboxSentinel, false);
  assert.equal(result.hostSentinel, false);
}

function assertSandboxWorker200(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 200);
  assert.equal(JSON.parse(result.value.body).version, 2);
}

function assertSandboxWorkerDenied(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.status, 502);
  assert.equal(result.sandboxSentinel, false);
  assert.equal(result.hostSentinel, false);
}

const isolationDefinitions = [
  {
    gate: 'BROKEN_R3C2_B_NODE_AMBIENT_PROCESS_WOULD_FAIL',
    after: `${fakeProviderStart}\n  void process.env;`,
    expectedIssues: ['reserved-identifier:process'],
    isolationPolicy: { reservedIdentifiers: ['Buffer', 'globalThis'] },
    sandboxPolicy: { exposeProcess: true },
  },
  {
    gate: 'BROKEN_R3C2_B_NODE_AMBIENT_BUFFER_WOULD_FAIL',
    after: `${fakeProviderStart}\n  Buffer.from('hostile-node-global');`,
    expectedIssues: ['reserved-identifier:Buffer'],
    isolationPolicy: { reservedIdentifiers: ['process', 'globalThis'] },
    sandboxPolicy: { exposeBuffer: true },
  },
  {
    gate: 'BROKEN_R3C2_B_BARE_NODE_BUILTIN_FS_WOULD_FAIL',
    after: `import { readFileSync as nodeRead } from 'fs';\n${fakeProviderStart}\n  void nodeRead;`,
    expectedIssues: ['module-specifier:non-relative:fs', 'node-builtin:fs'],
    isolationPolicy: { forbidBareBuiltins: false, forbidNonRelativeSpecifiers: false },
    sandboxCode: 'SANDBOX_NON_RELATIVE_MODULE',
  },
  {
    gate: 'BROKEN_R3C2_B_NODE_PREFIX_BUILTIN_FS_WOULD_FAIL',
    after: `import { readFileSync as nodeRead } from 'node:fs';\n${fakeProviderStart}\n  void nodeRead;`,
    expectedIssues: ['module-specifier:non-relative:node:fs', 'node-builtin:node:fs'],
    isolationPolicy: { forbidNodePrefixedBuiltins: false, forbidNonRelativeSpecifiers: false },
    sandboxCode: 'SANDBOX_NON_RELATIVE_MODULE',
  },
  {
    gate: 'BROKEN_R3C2_B_NODE_BUILTIN_SUBPATH_WOULD_FAIL',
    after: `import { readFile as bareRead } from 'fs/promises';\nimport { writeFile as prefixedWrite } from 'node:fs/promises';\n${fakeProviderStart}\n  void bareRead; void prefixedWrite;`,
    expectedIssues: ['module-specifier:non-relative:fs/promises', 'module-specifier:non-relative:node:fs/promises',
      'node-builtin:fs/promises', 'node-builtin:node:fs/promises'],
    isolationPolicy: { forbidBareBuiltins: false, forbidNodePrefixedBuiltins: false,
      forbidNonRelativeSpecifiers: false },
    sandboxCode: 'SANDBOX_NON_RELATIVE_MODULE',
  },
  {
    gate: 'BROKEN_R3C2_B_GLOBALTHIS_PROCESS_WOULD_FAIL',
    after: `${fakeProviderStart}\n  void globalThis.process.env;`,
    expectedIssues: ['reserved-identifier:globalThis', 'reserved-identifier:process'],
    isolationPolicy: { reservedIdentifiers: ['Buffer'] },
    sandboxPolicy: { exposeProcess: true },
  },
  {
    gate: 'BROKEN_R3C2_B_GLOBALTHIS_BUFFER_WOULD_FAIL',
    after: `${fakeProviderStart}\n  globalThis.Buffer.from('hostile-node-global');`,
    expectedIssues: ['reserved-identifier:Buffer', 'reserved-identifier:globalThis'],
    isolationPolicy: { reservedIdentifiers: ['process'] },
    sandboxPolicy: { exposeBuffer: true },
  },
  {
    gate: 'BROKEN_R3C2_B_PARENTHESIZED_GLOBALTHIS_WOULD_FAIL',
    after: `${fakeProviderStart}\n  void (globalThis).process.env; void (globalThis)['Buffer'];`,
    expectedIssues: ['reserved-identifier:globalThis', 'reserved-identifier:process'],
    isolationPolicy: { reservedIdentifiers: [] },
    sandboxPolicy: { exposeProcess: true, exposeBuffer: true },
  },
];

for (const eol of ['\n', '\r\n']) for (const definition of isolationDefinitions) {
  test(`node production isolation: ${definition.gate} ${eol === '\n' ? 'LF' : 'CRLF'}`, async (context) => {
    const normalizedAfter = definition.after.replace(/\n/gu, eol);
    const normalizedBefore = fakeProviderStart.replace(/\n/gu, eol);
    const original = productionSources().get('fake-provider.js').replace(/\r\n?/gu, '\n').replace(/\n/gu, eol);
    assert.equal(original.split(normalizedBefore).length - 1, 1, 'fixture replacement count');
    const hostile = original.replace(normalizedBefore, normalizedAfter);
    assert.deepEqual(productionIsolationIssues(hostile), definition.expectedIssues, 'expected Node authority identified');

    // Even when the scanner mutation misses the authority, the sandbox still denies it.
    const blocked = runProductionSandbox({ file: 'fake-provider.js', before: fakeProviderStart,
      after: definition.after, eol, isolationPolicy: definition.isolationPolicy,
      operation: sandboxWorkerOperation });
    assert.equal(blocked.applied, 1);
    if (definition.sandboxCode) assertSandboxBlocked(blocked, definition.sandboxCode);
    else assertSandboxWorkerDenied(blocked);

    // Ambient authorities are valid executable fixtures only under a deliberate sandbox mutation.
    if (definition.sandboxPolicy) {
      const mutant = runProductionSandbox({ file: 'fake-provider.js', before: fakeProviderStart,
        after: definition.after, eol, isolationPolicy: definition.isolationPolicy,
        sandboxPolicy: definition.sandboxPolicy, operation: sandboxWorkerOperation });
      assert.equal(mutant.applied, 1);
      assertSandboxWorker200(mutant);
    }

    let failure;
    try {
      await importVariant({ file: 'fake-provider.js', before: fakeProviderStart, after: definition.after, eol });
    } catch (error) { failure = error; }
    assert.ok(failure instanceof assert.AssertionError, 'isolation assertion failed, not syntax/import/fixture');
    for (const issue of definition.expectedIssues) assert.ok(failure.message.includes(issue), issue);
    context.diagnostic(`fixture=YES syntax=VALID sandbox=BLOCKED scanner=FAILED authority=${definition.expectedIssues.join(',')}`);
  });
}

test('node production isolation: generic built-ins, re-exports and dynamic imports', () => {
  for (const bare of ['fs', 'fs/promises', 'process', 'buffer', 'path', 'crypto', 'stream', 'util', 'events']) {
    assert.equal(isNodeBuiltinSpecifier(bare), true, bare);
    assert.equal(isNodeBuiltinSpecifier(`node:${bare}`), true, `node:${bare}`);
  }
  for (const prefixedOnly of ['node:test', 'node:test/reporters', 'node:sea', 'node:sqlite']) {
    assert.equal(isNodeBuiltinSpecifier(prefixedOnly), true, prefixedOnly);
  }
  assert.deepEqual(productionIsolationIssues("import 'path'; export { inspect } from 'node:util';"),
    ['module-specifier:non-relative:node:util', 'module-specifier:non-relative:path',
      'node-builtin:node:util', 'node-builtin:path']);
  assert.deepEqual(productionIsolationIssues('import "node:fs"; export * from "fs/promises";'),
    ['module-specifier:non-relative:fs/promises', 'module-specifier:non-relative:node:fs',
      'node-builtin:fs/promises', 'node-builtin:node:fs']);
  assert.deepEqual(productionIsolationIssues("import value from '\\x66s';"),
    ['module-specifier:non-relative:fs', 'node-builtin:fs']);
  for (const expression of ["import('./rule-policy.js')", "import('fs')", "import('node:fs')",
    "import('data:text/javascript,export default 1')", 'import(name)']) {
    assert.deepEqual(productionIsolationIssues(`const load = () => ${expression};`),
      ['dynamic-import:forbidden'], expression);
  }
  assert.deepEqual(productionIsolationIssues("void proce\\u0073s.env; void Buff\\u0065r.from('x');"),
    ['reserved-identifier:Buffer', 'reserved-identifier:process']);
  assert.deepEqual(productionIsolationIssues("void globalThis?.['process']; void globalThis[\"Buffer\"];"),
    ['reserved-identifier:globalThis']);
});

test('node production isolation: conservative identifiers and lexical false-positive controls', async () => {
  const nonBuiltins = ['filesystem-helper', 'path-browserify', 'buffer-utils', 'process-helper', '@scope/fs', 'node:filesystem-helper'];
  assert.equal(nonBuiltins.filter(isNodeBuiltinSpecifier).length, 0);
  const harmless = `
    const text = 'process.env Buffer globalThis fs';
    const other = "globalThis.process";
    const template = \`process.env Buffer globalThis\`;
    const pattern = /process|Buffer|globalThis|fs/u;
    // process.env Buffer fs node:fs
    /* node:fs and globalThis.process */
  `;
  assert.deepEqual(productionIsolationIssues(harmless), []);

  assert.deepEqual(productionIsolationIssues(`
    const object = { process() {}, Buffer() {}, globalThis() {} };
    void object.process; void object?.Buffer; void object.globalThis;
    function local(process, Buffer, globalThis) { return [process, Buffer, globalThis]; }
  `), ['reserved-identifier:Buffer', 'reserved-identifier:globalThis', 'reserved-identifier:process']);
  assert.deepEqual(productionIsolationIssues("import process from 'process-helper'; export { Buffer } from 'buffer-utils';"),
    ['module-specifier:non-relative:buffer-utils', 'module-specifier:non-relative:process-helper',
      'reserved-identifier:Buffer', 'reserved-identifier:process']);

  const after = `${fakeProviderStart}\n  const harmless = { authority: 'process.env', bytes: 'Buffer', root: 'globalThis', specifier: 'node:fs' };\n  // node:fs process Buffer globalThis\n  void harmless.authority; void harmless.bytes;`;
  const imported = await importVariant({ file: 'fake-provider.js', before: fakeProviderStart, after });
  await assertResponse(await imported.entry.default.fetch(request(), { COACH_FAKE_ENABLED: 'true' }), 200);
});

test('node production isolation: template raw text is ignored and expressions are scanned', () => {
  assert.deepEqual(productionIsolationIssues('const words = `process Buffer globalThis`;'), []);
  assert.deepEqual(productionIsolationIssues('const value = `${process.env}`;'), ['reserved-identifier:process']);
  assert.deepEqual(productionIsolationIssues("const value = `${Buffer.from('x')}`;"), ['reserved-identifier:Buffer']);
  assert.deepEqual(productionIsolationIssues("const value = `${globalThis['process']}`;"),
    ['reserved-identifier:globalThis']);
});

const newIsolationMutations = [
  { category: 'globalThis isolation', gate: 'BROKEN_R3C2_B_COMPUTED_GLOBALTHIS_PROCESS_WOULD_FAIL',
    after: `${fakeProviderStart}\n  void globalThis[\`process\`].env;`,
    expectedIssues: ['reserved-identifier:globalThis'],
    isolationPolicy: { reservedIdentifiers: ['process', 'Buffer'] }, sandboxPolicy: { exposeProcess: true } },
  { category: 'globalThis isolation', gate: 'BROKEN_R3C2_B_COMPUTED_GLOBALTHIS_BUFFER_WOULD_FAIL',
    after: `${fakeProviderStart}\n  globalThis[\`Buffer\`].from('x');`,
    expectedIssues: ['reserved-identifier:globalThis'],
    isolationPolicy: { reservedIdentifiers: ['process', 'Buffer'] }, sandboxPolicy: { exposeBuffer: true } },
  { category: 'globalThis isolation', gate: 'BROKEN_R3C2_B_GLOBALTHIS_ALIAS_WOULD_FAIL',
    after: `${fakeProviderStart}\n  const root = globalThis; root['process'].env; root['Buffer'].from('x');`,
    expectedIssues: ['reserved-identifier:globalThis'],
    isolationPolicy: { reservedIdentifiers: ['process', 'Buffer'] },
    sandboxPolicy: { exposeProcess: true, exposeBuffer: true } },
  { category: 'ASI isolation', gate: 'BROKEN_R3C2_B_ASI_IMPORT_PROCESS_WOULD_FAIL',
    after: `import './rule-policy.js'\nprocess.env;\n${fakeProviderStart}`,
    expectedIssues: ['reserved-identifier:process'],
    isolationPolicy: { reservedIdentifiers: ['Buffer', 'globalThis'] }, sandboxPolicy: { exposeProcess: true } },
  { category: 'ASI isolation', gate: 'BROKEN_R3C2_B_ASI_IMPORT_BUFFER_WOULD_FAIL',
    after: `import './rule-policy.js'\nBuffer.from('x');\n${fakeProviderStart}`,
    expectedIssues: ['reserved-identifier:Buffer'],
    isolationPolicy: { reservedIdentifiers: ['process', 'globalThis'] }, sandboxPolicy: { exposeBuffer: true } },
  { category: 'ASI isolation', gate: 'BROKEN_R3C2_B_ASI_EXPORT_PROCESS_WOULD_FAIL',
    after: `export * from './rule-policy.js'\nprocess.env;\n${fakeProviderStart}`,
    expectedIssues: ['reserved-identifier:process'],
    isolationPolicy: { reservedIdentifiers: ['Buffer', 'globalThis'] }, sandboxPolicy: { exposeProcess: true } },
  { category: 'ASI isolation', gate: 'BROKEN_R3C2_B_ASI_EXPORT_BUFFER_WOULD_FAIL',
    after: `export * from './rule-policy.js'\nBuffer.from('x');\n${fakeProviderStart}`,
    expectedIssues: ['reserved-identifier:Buffer'],
    isolationPolicy: { reservedIdentifiers: ['process', 'globalThis'] }, sandboxPolicy: { exposeBuffer: true } },
  { category: 'opaque module isolation', gate: 'BROKEN_R3C2_B_STATIC_DATA_MODULE_WOULD_FAIL',
    after: `import 'data:text/javascript,export default process.env';\n${fakeProviderStart}`,
    expectedIssues: ['module-specifier:non-relative:data:text/javascript,export default process.env'],
    isolationPolicy: { forbidNonRelativeSpecifiers: false }, sandboxCode: 'SANDBOX_NON_RELATIVE_MODULE' },
  { category: 'opaque module isolation', gate: 'BROKEN_R3C2_B_REEXPORT_DATA_MODULE_WOULD_FAIL',
    after: `export { default as hostileData } from 'data:text/javascript,export default process.env';\n${fakeProviderStart}`,
    expectedIssues: ['module-specifier:non-relative:data:text/javascript,export default process.env'],
    isolationPolicy: { forbidNonRelativeSpecifiers: false }, sandboxCode: 'SANDBOX_NON_RELATIVE_MODULE' },
  { category: 'opaque module isolation', gate: 'BROKEN_R3C2_B_DYNAMIC_DATA_MODULE_WOULD_FAIL',
    after: `await import('data:text/javascript,globalThis.Buffer');\n${fakeProviderStart}`,
    expectedIssues: ['dynamic-import:forbidden'], isolationPolicy: { forbidDynamicImports: false },
    sandboxCode: 'SANDBOX_DYNAMIC_IMPORT_FORBIDDEN', sandboxPolicy: { useDefaultDynamicImportLoader: true } },
  { category: 'opaque module isolation', gate: 'BROKEN_R3C2_B_DYNAMIC_IMPORT_ALLOWED_WOULD_FAIL',
    after: `await import('node:path');\n${fakeProviderStart}`,
    expectedIssues: ['dynamic-import:forbidden'], isolationPolicy: { forbidDynamicImports: false },
    sandboxCode: 'SANDBOX_DYNAMIC_IMPORT_FORBIDDEN', sandboxPolicy: { useDefaultDynamicImportLoader: true } },
  { category: 'opaque module isolation', gate: 'BROKEN_R3C2_B_NON_RELATIVE_MODULE_ALLOWED_WOULD_FAIL',
    after: `import { sep as nodeSeparator } from 'path';\n${fakeProviderStart}\n  void nodeSeparator;`,
    expectedIssues: ['module-specifier:non-relative:path', 'node-builtin:path'],
    isolationPolicy: { forbidBareBuiltins: false, forbidNonRelativeSpecifiers: false },
    sandboxCode: 'SANDBOX_NON_RELATIVE_MODULE' },
];

for (const eol of ['\n', '\r\n']) for (const definition of newIsolationMutations) {
  test(`${definition.category}: ${definition.gate} ${eol === '\n' ? 'LF' : 'CRLF'}`, async (context) => {
    const original = productionSources().get('fake-provider.js').replace(/\r\n?/gu, '\n').replace(/\n/gu, eol);
    const before = fakeProviderStart.replace(/\n/gu, eol);
    const after = definition.after.replace(/\n/gu, eol);
    assert.equal(original.split(before).length - 1, 1, 'fixture replacement count');
    const hostile = original.replace(before, after);
    assert.deepEqual(productionIsolationIssues(hostile), definition.expectedIssues, 'specific authority identified');
    assert.deepEqual(productionIsolationIssues(hostile, definition.isolationPolicy), [], 'weakened mutant is sensitive');

    const blocked = runProductionSandbox({ file: 'fake-provider.js', before: fakeProviderStart,
      after: definition.after, eol, isolationPolicy: definition.isolationPolicy,
      operation: sandboxWorkerOperation });
    assert.equal(blocked.applied, 1);
    if (definition.category === 'globalThis isolation') assertSandboxWorkerDenied(blocked);
    else assertSandboxBlocked(blocked, definition.sandboxCode);

    if (definition.sandboxPolicy) {
      const mutant = runProductionSandbox({ file: 'fake-provider.js', before: fakeProviderStart,
        after: definition.after, eol, isolationPolicy: definition.isolationPolicy,
        sandboxPolicy: definition.sandboxPolicy, operation: sandboxWorkerOperation });
      assert.equal(mutant.applied, 1);
      assertSandboxWorker200(mutant);
    }

    let failure;
    try { await importVariant({ file: 'fake-provider.js', before: fakeProviderStart, after: definition.after, eol }); }
    catch (error) { failure = error; }
    assert.ok(failure instanceof assert.AssertionError, 'authority assertion failed before unrelated import/runtime failure');
    for (const issue of definition.expectedIssues) assert.ok(failure.message.includes(issue), issue);
    context.diagnostic(`fixture=YES syntax=VALID sandbox=BLOCKED scanner=FAILED authority=${definition.expectedIssues.join(',')}`);
  });
}

function sandboxExports(source, { isolationPolicy, sandboxPolicy, exports = ['value'] } = {}) {
  return runProductionSandbox({ sources: new Map([['index.js', source]]), isolationPolicy, sandboxPolicy,
    operation: { type: 'exports', exports } });
}

test('vm error realm ownership: dynamic import rejection stays inside the vm context', () => {
  const source = `
    export let caught;
    export let facts = { rejected: false, loaded: false };
    try {
      await import('data:text/javascript,export default 1');
      facts = { rejected: false, loaded: true };
    } catch (error) {
      caught = error;
      facts = {
        rejected: true,
        loaded: false,
        processType: typeof process,
        bufferType: typeof Buffer,
      };
    }
  `;
  const result = runProductionSandbox({
    sources: new Map([['index.js', source]]),
    isolationPolicy: { forbidDynamicImports: false, reservedIdentifiers: [] },
    operation: { type: 'inspect-error-realm', exportName: 'caught', factsExportName: 'facts' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.phase, 'complete');
  assert.equal(result.value.code, 'SANDBOX_DYNAMIC_IMPORT_FORBIDDEN');
  assert.deepEqual(result.value.facts, {
    rejected: true, loaded: false, processType: 'undefined', bufferType: 'undefined',
  });
  assert.deepEqual(result.value.guest, {
    constructorIsError: true,
    prototypeIsErrorPrototype: true,
    constructorConstructorIsFunction: true,
  });
  assert.deepEqual(result.value.host, {
    prototypeIsHostErrorPrototype: false,
    constructorIsHostError: false,
    constructorConstructorIsHostFunction: false,
  });
});

test('sandbox authority: production context exposes only the explicit context-owned Web allowlist', () => {
  assert.deepEqual(SANDBOX_EXPOSED_GLOBALS, [
    'Request', 'Response', 'Headers', 'URL', 'TextEncoder', 'TextDecoder',
    'AbortController', 'performance', 'setTimeout', 'clearTimeout',
  ]);
  const result = sandboxExports(`
    export const types = {
      process: typeof process, Buffer: typeof Buffer, global: typeof global, require: typeof require,
      module: typeof module, exports: typeof exports, dirname: typeof __dirname, filename: typeof __filename,
      globalProcess: typeof globalThis.process, globalBuffer: typeof globalThis.Buffer,
      globalGlobal: typeof globalThis.global,
      Request: typeof Request, Response: typeof Response, Headers: typeof Headers, URL: typeof URL,
      TextEncoder: typeof TextEncoder, TextDecoder: typeof TextDecoder,
      AbortController: typeof AbortController,
      performance: typeof performance, setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout,
    };
  `, { isolationPolicy: { reservedIdentifiers: [] }, exports: ['types'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.types, {
    process: 'undefined', Buffer: 'undefined', global: 'undefined', require: 'undefined',
    module: 'undefined', exports: 'undefined', dirname: 'undefined', filename: 'undefined',
    globalProcess: 'undefined', globalBuffer: 'undefined', globalGlobal: 'undefined',
    Request: 'function', Response: 'function',
    Headers: 'function', URL: 'function', TextEncoder: 'function', TextDecoder: 'function',
    AbortController: 'function', performance: 'object',
    setTimeout: 'function', clearTimeout: 'function',
  });
});

test('sandbox authority: fatal UTF-8 and BOM behavior match the Worker decoding contract', () => {
  const result = sandboxExports(`
    const decode = (bytes, options) => {
      try { return new TextDecoder('utf-8', options).decode(new Uint8Array(bytes)); }
      catch (error) { return error.name; }
    };
    export const values = {
      badContinuation: decode([0xc3, 0x28], { fatal: true }),
      overlong: decode([0xc0, 0x80], { fatal: true }),
      surrogate: decode([0xed, 0xa0, 0x80], { fatal: true }),
      outOfRange: decode([0xf4, 0x90, 0x80, 0x80], { fatal: true }),
      preserveBOM: decode([0xef, 0xbb, 0xbf, 0x7b], { fatal: true, ignoreBOM: true }).codePointAt(0),
      stripBOM: decode([0xef, 0xbb, 0xbf, 0x7b], { fatal: true }).codePointAt(0),
    };
  `, { exports: ['values'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.values, {
    badContinuation: 'TypeError', overlong: 'TypeError', surrogate: 'TypeError', outOfRange: 'TypeError',
    preserveBOM: 0xfeff, stripBOM: 0x7b,
  });
});

for (const definition of [
  { gate: 'BROKEN_R3C2_B_SANDBOX_EXPOSES_PROCESS_WOULD_FAIL',
    source: 'export const value = process.version;', expected: ['reserved-identifier:process'],
    isolationPolicy: { reservedIdentifiers: ['Buffer', 'globalThis'] }, sandboxPolicy: { exposeProcess: true } },
  { gate: 'BROKEN_R3C2_B_SANDBOX_EXPOSES_BUFFER_WOULD_FAIL',
    source: "export const value = Buffer.from('x').toString();", expected: ['reserved-identifier:Buffer'],
    isolationPolicy: { reservedIdentifiers: ['process', 'globalThis'] }, sandboxPolicy: { exposeBuffer: true } },
]) test(`sandbox authority: ${definition.gate}`, () => {
  assert.deepEqual(productionIsolationIssues(definition.source), definition.expected);
  assert.deepEqual(productionIsolationIssues(definition.source, definition.isolationPolicy), []);
  const blocked = sandboxExports(definition.source, { isolationPolicy: definition.isolationPolicy });
  assertSandboxBlocked(blocked);
  assert.equal(blocked.error.name, 'ReferenceError');
  const mutant = sandboxExports(definition.source, {
    isolationPolicy: definition.isolationPolicy, sandboxPolicy: definition.sandboxPolicy,
  });
  assert.equal(mutant.ok, true, JSON.stringify(mutant));
  assert.notEqual(mutant.value.value, undefined);
});

test('global Node alias: BROKEN_R3C2_B_SANDBOX_EXPOSES_NODE_GLOBAL_WOULD_FAIL', () => {
  for (const [source, expected] of [
    ["export const value = global['process'].version;", /^v\d+/u],
    ["export const value = global[`Buffer`].from('x').toString();", 'x'],
  ]) {
    assert.deepEqual(productionIsolationIssues(source), [], 'computed global alias is a scanner-hostile fixture');
    const blocked = sandboxExports(source);
    assertSandboxBlocked(blocked);
    assert.equal(blocked.error.name, 'ReferenceError');
    const mutant = sandboxExports(source, { sandboxPolicy: { exposeNodeGlobal: true } });
    assert.equal(mutant.ok, true, JSON.stringify(mutant));
    if (expected instanceof RegExp) assert.match(mutant.value.value, expected);
    else assert.equal(mutant.value.value, expected);
  }
});

for (const [name, expression, isolationPolicy] of [
  ['direct eval', "eval('1')"],
  ['indirect eval', "(0, eval)('1')"],
  ['globalThis eval', "globalThis.eval('1')", { reservedIdentifiers: [] }],
  ['Function', "Function('return 1')()"],
  ['Function Node authority', "Function('return process')()"],
  ['new Function', "new Function('return 1')()"],
  ['function constructor', "(function () {}).constructor('return 1')()"],
  ['async-function constructor', "await (async function () {}).constructor('return 1')()"],
]) test(`code generation isolation: ${name} is disabled`, () => {
  const blocked = sandboxExports(`export const value = ${expression};`, { isolationPolicy });
  assertSandboxBlocked(blocked);
  assert.equal(blocked.error.name, 'EvalError');
});

test('code generation isolation: context-owned Web facades do not bridge to a host Function constructor', () => {
  const source = `export const value = new Headers().constructor.constructor('return process')();`;
  const blocked = sandboxExports(source, { isolationPolicy: { reservedIdentifiers: ['Buffer', 'globalThis'] } });
  assertSandboxBlocked(blocked);
  assert.equal(blocked.error.name, 'EvalError');
});

test('code generation isolation: BROKEN_R3C2_B_SANDBOX_STRING_CODEGEN_ENABLED_WOULD_FAIL', () => {
  const source = `export const value = Function('return 7')();`;
  const blocked = sandboxExports(source);
  assertSandboxBlocked(blocked);
  assert.equal(blocked.error.name, 'EvalError');
  const mutant = sandboxExports(source, { sandboxPolicy: { codeGenerationStrings: true } });
  assert.equal(mutant.ok, true, JSON.stringify(mutant));
  assert.equal(mutant.value.value, 7);
});

test('code generation isolation: WebAssembly compilation is disabled and mutation-sensitive', () => {
  const source = `export const value = (await WebAssembly.compile(
    new Uint8Array([0,97,115,109,1,0,0,0]))) instanceof WebAssembly.Module;`;
  const blocked = sandboxExports(source);
  assertSandboxBlocked(blocked);
  assert.equal(blocked.error.name, 'CompileError');
  const mutant = sandboxExports(source, { sandboxPolicy: { codeGenerationWasm: true } });
  assert.equal(mutant.ok, true, JSON.stringify(mutant));
  assert.equal(mutant.value.value, true);
});

test('generated dynamic import: BROKEN_R3C2_B_SANDBOX_DEFAULT_DYNAMIC_IMPORT_LOADER_WOULD_FAIL', () => {
  const source = `export const value = (await import(
    'data:text/javascript,globalThis.__sandboxHostOpaqueSentinel=true;export default 7')).default;`;
  assert.deepEqual(productionIsolationIssues(source), ['dynamic-import:forbidden']);
  const isolationPolicy = { forbidDynamicImports: false };
  const blocked = sandboxExports(source, { isolationPolicy, sandboxPolicy: { trackSentinel: true } });
  assertSandboxBlocked(blocked, 'SANDBOX_DYNAMIC_IMPORT_FORBIDDEN');
  const mutant = sandboxExports(source, { isolationPolicy,
    sandboxPolicy: { trackSentinel: true, useDefaultDynamicImportLoader: true } });
  assert.equal(mutant.ok, true, JSON.stringify(mutant));
  assert.equal(mutant.value.value, 7);
  assert.equal(mutant.hostSentinel, true, 'default-loader mutant executed the data module');
});

test('generated dynamic import: BROKEN_R3C2_B_FUNCTION_GENERATED_DATA_IMPORT_WOULD_FAIL', () => {
  const source = `export const value = await Function(
    "return import('data:text/javascript,globalThis.__sandboxHostOpaqueSentinel=true;export default 7')"
  )().then((loaded) => loaded.default);`;
  assert.deepEqual(productionIsolationIssues(source), [], 'import syntax inside a string evades the scanner');
  const blocked = sandboxExports(source, { sandboxPolicy: { trackSentinel: true } });
  assertSandboxBlocked(blocked);
  assert.equal(blocked.error.name, 'EvalError');
  const codegenOnly = sandboxExports(source, { sandboxPolicy: {
    trackSentinel: true, codeGenerationStrings: true,
  } });
  assertSandboxBlocked(codegenOnly, 'SANDBOX_DYNAMIC_IMPORT_FORBIDDEN');
  const mutant = sandboxExports(source, { sandboxPolicy: {
    trackSentinel: true, codeGenerationStrings: true, useDefaultDynamicImportLoader: true,
  } });
  assert.equal(mutant.ok, true, JSON.stringify(mutant));
  assert.equal(mutant.value.value, 7);
  assert.equal(mutant.hostSentinel, true, 'deliberate default-loader mutant executes in the Node host realm');
});

test('code generation isolation: BROKEN_R3C2_B_INDIRECT_EVAL_AUTHORITY_WOULD_FAIL', () => {
  const source = `export const value = (0, eval)('process.version');`;
  assert.deepEqual(productionIsolationIssues(source), [], 'authority inside eval string evades the scanner');
  const blocked = sandboxExports(source);
  assertSandboxBlocked(blocked);
  assert.equal(blocked.error.name, 'EvalError');
  const mutant = sandboxExports(source, {
    sandboxPolicy: { codeGenerationStrings: true, exposeProcess: true },
  });
  assert.equal(mutant.ok, true, JSON.stringify(mutant));
  assert.match(mutant.value.value, /^v\d+/u);
});

test('globalThis isolation: direct, computed and alias forms are conservatively rejected', () => {
  const fixtures = ['globalThis.process', 'globalThis.Buffer', "globalThis['process']", 'globalThis["Buffer"]',
    'globalThis[`process`]', 'globalThis[`Buffer`]', 'const g = globalThis; g.process',
    "const g = globalThis; g['process']", 'const g = globalThis; g.Buffer', "const g = globalThis; g['Buffer']"];
  for (const fixture of fixtures) {
    assert.ok(productionIsolationIssues(fixture).includes('reserved-identifier:globalThis'), fixture);
  }
});

test('opaque module isolation: static imports and re-exports reject every non-relative authority edge', () => {
  for (const specifier of ['some-package', 'lodash', 'hono', 'openai', 'data:text/javascript,export default 1',
    'blob:opaque-id', 'http://example.invalid/module.js', 'https://example.invalid/module.js',
    'file:///tmp/module.js', 'npm:package', 'jsr:@scope/package']) {
    assert.ok(productionIsolationIssues(`import '${specifier}';`)
      .includes(`module-specifier:non-relative:${specifier}`), `import ${specifier}`);
    assert.ok(productionIsolationIssues(`export * from '${specifier}';`)
      .includes(`module-specifier:non-relative:${specifier}`), `re-export ${specifier}`);
  }
});

function normalizedGraph(entries, eol) {
  return new Map(entries.map(([name, source]) => [name, source.replace(/\n/gu, eol)]));
}

for (const eol of ['\n', '\r\n']) {
  test(`production graph boundary: BROKEN_R3C2_B_PRODUCTION_GRAPH_ROOT_ESCAPE_WOULD_FAIL ${eol === '\n' ? 'LF' : 'CRLF'}`, async () => {
    for (const [specifier, escapedName] of [['../../../outside.js', '../../../outside.js'],
      ['../../test-support.mjs', '../../test-support.mjs']]) {
      const sources = normalizedGraph([
        ['index.js', `import '${specifier}';\nexport const ok = true;`],
        [escapedName, 'export const escaped = true;'],
      ], eol);
      const issue = `index.js:module-specifier:root-escape:${specifier}`;
      assert.deepEqual(productionGraphIssues(sources), [issue]);
      assert.throws(() => assertProductionIsolation(sources), (error) => error instanceof assert.AssertionError
        && error.message.includes(issue));
      const blocked = runProductionSandbox({ sources, eol, isolationPolicy: { forbidRootEscape: false },
        operation: { type: 'exports', exports: ['ok'] } });
      assertSandboxBlocked(blocked, 'SANDBOX_ROOT_ESCAPE');
    }
  });
}

const transitiveAuthorities = [
  ['process', 'void process.env;', 'hostile.js:reserved-identifier:process'],
  ['Buffer', "Buffer.from('x');", 'hostile.js:reserved-identifier:Buffer'],
  ['builtin', "import 'fs';", 'hostile.js:module-specifier:non-relative:fs'],
  ['opaque module', "import 'data:text/javascript,export default process.env';",
    'hostile.js:module-specifier:non-relative:data:text/javascript,export default process.env'],
];

for (const eol of ['\n', '\r\n']) for (const [name, hostile, expectedIssue] of transitiveAuthorities) {
  test(`production graph boundary: transitive ${name} ${eol === '\n' ? 'LF' : 'CRLF'}`, async () => {
    const sources = normalizedGraph([
      ['index.js', "import './safe.js';\nexport const ok = true;"],
      ['safe.js', "import './hostile.js';"],
      ['hostile.js', hostile],
    ], eol);
    assert.ok(productionGraphIssues(sources).includes(expectedIssue));
    assert.throws(() => assertProductionIsolation(sources), (error) => error instanceof assert.AssertionError
      && error.message.includes(expectedIssue));
    assert.doesNotThrow(() => assertProductionIsolation(sources, { recursive: false }));
    const blocked = runProductionSandbox({ sources, eol, isolationPolicy: { recursive: false },
      operation: { type: 'exports', exports: ['ok'] } });
    assertSandboxBlocked(blocked, name === 'process' || name === 'Buffer'
      ? undefined : 'SANDBOX_NON_RELATIVE_MODULE');
    if (name === 'process' || name === 'Buffer') {
      assert.equal(blocked.phase, 'evaluate');
      assert.equal(blocked.error.name, 'ReferenceError');
    }
  });
}

const APPROVED_PACKAGE_SCRIPTS = Object.freeze({
  test: 'node --test review-coach-api-test.mjs review-coach-contract-parity-test.mjs review-coach-mutation-test.mjs',
  'wrangler:version': 'wrangler --version',
  'cloudflare:whoami': 'wrangler whoami --json',
});

function assertPackagePolicy(pkg) {
  assert.equal(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0, true,
    'B2B0_RUNTIME_DEPENDENCIES_ZERO');
  assert.deepEqual(pkg.devDependencies, { wrangler: '4.129.0' },
    'B2B0_DEV_DEPENDENCIES_EXACT');
  assert.deepEqual(pkg.scripts, APPROVED_PACKAGE_SCRIPTS,
    'B2B0_PACKAGE_SCRIPTS_EXACT');
}

function assertPackagePolicyMutation(pkg, label, expectedMarker, mutate) {
  const mutant = structuredClone(pkg);
  mutate(mutant);
  const serialized = JSON.stringify(mutant);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(serialized); }, `${label}: mutant JSON remains valid`);
  let caught = null;
  try { assertPackagePolicy(parsed); } catch (error) { caught = error; }
  assert.equal(caught?.code, 'ERR_ASSERTION', `${label}: intended assertion failed`);
  assert.match(caught.message, new RegExp(expectedMarker), `${label}: correct policy assertion failed`);
}

test('literal constants/policies immutable, no frontend/Node/fixtures/dependencies in production graph', () => {
  assert.equal(MAX_REQUEST_BYTES, 1024); assert.equal(MAX_RESPONSE_BYTES, 1024);
  assert.equal(R3C2_B_PROVIDER_TIMEOUT_MS, 3000); assert.equal(TOTAL_TIMEOUT_MS, 3500);
  assert.deepEqual(Object.keys(RULE_PURPOSES), rules); assert.ok(Object.isFrozen(RULE_PURPOSES));
  assert.ok(Object.isFrozen(DEFAULT_PROFILE_POLICY));
  assertProductionIsolation(productionSources());
  for (const [name, source] of productionSources()) {
    assert.doesNotMatch(source, /(?:test-support|fault-fixture|\.\.\/|game-review|console\.|localStorage|sessionStorage|indexedDB|caches\.|WebSocket|\bglobalThis\b|\b(?:await|return)\s*fetch\s*\()/u, name);
  }
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.private, true); assert.equal(pkg.type, 'module');
  assertPackagePolicy(pkg);
  for (const [name, source] of productionSources()) assert.doesNotMatch(source, /\bwrangler\b/u, name);
  const capabilities = runProductionSandbox({ operation: { type: 'worker',
    url: `${ORIGIN}/api/review-coach/capabilities`, init: { method: 'GET', headers: { Origin: ORIGIN } },
    env: { COACH_FAKE_ENABLED: 'true' } } });
  assert.equal(capabilities.ok, true, JSON.stringify(capabilities));
  assert.equal(capabilities.value.status, 200);
  assert.deepEqual(JSON.parse(capabilities.value.body), {
    version: 1, profiles: profiles.map((id) => ({ id, available: true })), defaultProfile: 'economy',
  });
  assert.equal(capabilities.moduleCount, 9);
  const review = runProductionSandbox({ operation: sandboxWorkerOperation });
  assertSandboxWorker200(review);
  assert.equal(review.moduleCount, 9);
});

test('package policy keeps Wrangler exact, dev-only and limited to non-deploying scripts', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  assertPackagePolicy(pkg);
  const cases = [
    ['BROKEN_RUNTIME_DEPENDENCY_WOULD_FAIL', 'B2B0_RUNTIME_DEPENDENCIES_ZERO', (mutant) => {
      mutant.dependencies = { wrangler: mutant.devDependencies.wrangler };
      delete mutant.devDependencies;
    }],
    ['BROKEN_UNPINNED_WRANGLER_WOULD_FAIL', 'B2B0_DEV_DEPENDENCIES_EXACT', (mutant) => {
      mutant.devDependencies.wrangler = '^4.129.0';
    }],
    ['BROKEN_WRONG_WRANGLER_VERSION_WOULD_FAIL', 'B2B0_DEV_DEPENDENCIES_EXACT', (mutant) => {
      mutant.devDependencies.wrangler = '4.128.0';
    }],
    ['BROKEN_EXTRA_DEVDEPENDENCY_WOULD_FAIL', 'B2B0_DEV_DEPENDENCIES_EXACT', (mutant) => {
      mutant.devDependencies.typescript = '5.9.3';
    }],
    ['BROKEN_EXTRA_SCRIPT_WOULD_FAIL', 'B2B0_PACKAGE_SCRIPTS_EXACT', (mutant) => {
      mutant.scripts.lint = 'node --check src/index.js';
    }],
    ['BROKEN_DEPLOY_SCRIPT_WOULD_FAIL', 'B2B0_PACKAGE_SCRIPTS_EXACT', (mutant) => {
      mutant.scripts['deploy:staging'] = 'wrangler deploy --env staging';
    }],
    ['BROKEN_WHOAMI_DEPLOY_COMMAND_WOULD_FAIL', 'B2B0_PACKAGE_SCRIPTS_EXACT', (mutant) => {
      mutant.scripts['cloudflare:whoami'] = 'wrangler deploy --env staging';
    }],
    ['BROKEN_WRANGLER_VERSION_NPX_LATEST_WOULD_FAIL', 'B2B0_PACKAGE_SCRIPTS_EXACT', (mutant) => {
      mutant.scripts['wrangler:version'] = 'npx wrangler@latest --version';
    }],
  ];
  for (const [label, expectedMarker, mutate] of cases) {
    assertPackagePolicyMutation(pkg, label, expectedMarker, mutate);
  }
});
