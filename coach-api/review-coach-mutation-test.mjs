import assert from 'node:assert/strict';
import test from 'node:test';
import { importVariant, harness, payload, request, ORIGIN, SENTINEL,
  FakeClock, deferred, flush, observeSideEffects } from './test-support.mjs';
import { SAFE_FRAMING } from './src/contract.js';
import { localFakeAdmission } from './src/admission.js';

const definitions = [];
const add = (name, file, before, after, probe, expected) => definitions.push({
  gate: `BROKEN_R3C2_B_${name}_WOULD_FAIL`, file, before, after, probe, expected,
});
const post = async (variant, options = {}, requestOptions = {}) => {
  const server = harness(options, variant.entry.createCoachHandler);
  const response = await server.handle(request(requestOptions));
  return { response, calls: server.calls };
};
const statusAndCalls = async (variant, options, requestOptions) => {
  const { response, calls } = await post(variant, options, requestOptions);
  return { status: response.status, calls: calls.length };
};
const discardExtras = 'const request = snapshotExact(Object.fromEntries(REQUEST_KEYS.map((key) => [key, value[key]])), REQUEST_KEYS);';
for (const [name, key] of [['ACCEPTS_EXTRA_REQUEST_FIELD', 'extra'], ['ACCEPTS_PROMPT_FIELD', 'prompt']]) {
  add(name, 'contract.js', 'const request = snapshotExact(value, REQUEST_KEYS);', discardExtras,
    (variant) => statusAndCalls(variant, {}, { data: payload({ [key]: 'BROWSER_PROMPT_SENTINEL' }) }), { status: 400, calls: 0 });
}
add('ACCEPTS_UNKNOWN_RULE', 'contract.js', 'if (purposeFor(request.sourceRuleId) === null) return null;',
  'if (false) return null;', (variant) => Boolean(variant.contract.validateRequest(payload({ sourceRuleId: 'unknown-rule' }))), false);
for (const [name, modelProfile] of [['ACCEPTS_UNKNOWN_PROFILE', 'unknown'], ['ACCEPTS_ARBITRARY_MODEL_ID', 'gpt-arbitrary-model']]) {
  add(name, 'contract.js', 'if (!PROFILES.includes(request.modelProfile)) return null;', 'if (false) return null;',
    (variant) => Boolean(variant.contract.validateRequest(payload({ modelProfile }))), false);
}
add('CORS_WILDCARD', 'http.js', "headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);",
  "headers.set('Access-Control-Allow-Origin', '*');", async (variant) => {
    const { response } = await post(variant); return response.headers.get('Access-Control-Allow-Origin');
  }, ORIGIN);
add('ALLOWS_WRONG_ORIGIN', 'http.js', 'return origin === ALLOWED_ORIGIN;', 'return true;',
  (variant) => statusAndCalls(variant, {}, { origin: 'https://evil.invalid' }), { status: 403, calls: 0 });
add('RETURNS_UNVALIDATED_PROVIDER_OUTPUT', 'index.js', 'const framing = validateFraming(result.value);',
  'const framing = result.value;', (variant) => statusAndCalls(variant,
    { provider: () => ({ ...SAFE_FRAMING, extra: 'unvalidated' }) }), { status: 502, calls: 1 });
const framingGuard = 'if (framing.leadIn !== SAFE_FRAMING.leadIn || framing.encouragement !== SAFE_FRAMING.encouragement) return null;';
for (const [name, leadIn] of [['ACCEPTS_CHESS_FACT_OUTPUT', '這步可以將軍。'], ['ACCEPTS_QUALITY_LANGUAGE', '這是最好的一步。']]) {
  add(name, 'contract.js', framingGuard, 'if (false) return null;',
    (variant) => statusAndCalls(variant, { provider: () => ({ ...SAFE_FRAMING, leadIn }) }), { status: 502, calls: 1 });
}
add('PROFILE_UNAVAILABLE_FALLBACK', 'index.js',
  "if (!policy[validated.modelProfile]) return reply(409, origin, { version: 2, error: { code: 'profile_unavailable' } });",
  'if (!policy[validated.modelProfile]) validated = { ...validated, modelProfile: \'economy\' };',
  async (variant) => {
    const { response, calls } = await post(variant, { getProfilePolicy: () => ({ economy: true, balanced: true, quality: false }) },
      { data: payload({ modelProfile: 'quality' }) });
    return { status: response.status, calls: calls.length, body: await response.json() };
  }, { status: 409, calls: 0, body: { version: 2, error: { code: 'profile_unavailable' } } });
add('PROVIDER_RECEIVES_BROWSER_PROMPT', 'index.js', 'purpose: purposeFor(validated.sourceRuleId)',
  'purpose: validated.requestId', async (variant) => {
    const { calls } = await post(variant, {}, { data: payload({ requestId: 'BROWSER_PROMPT_SENTINEL' }) });
    assert.equal(calls.length, 1, 'fixture reached provider');
    return { keys: Object.keys(calls[0].input).sort(), purpose: calls[0].input.purpose,
      leaked: JSON.stringify(calls[0].input).includes('BROWSER_PROMPT_SENTINEL') };
  }, { keys: ['sourceRuleId', 'locale', 'style', 'modelProfile', 'purpose'].sort(),
    purpose: 'Invite a quiet pause before rereading the existing teaching note.', leaked: false });
add('BODY_LIMIT_REMOVED', 'http.js', 'if (size > MAX_REQUEST_BYTES) { cancel(); return { status: 413 }; }',
  'if (false) { cancel(); return { status: 413 }; }', (variant) => {
    const json = JSON.stringify(payload()); const body = json + ' '.repeat(1025 - Buffer.byteLength(json));
    return statusAndCalls(variant, {}, { body });
  }, { status: 413, calls: 0 });
add('TIMEOUT_REMOVED', 'provider.js', 'export const R3C2_B_PROVIDER_TIMEOUT_MS = 3000;',
  'export const R3C2_B_PROVIDER_TIMEOUT_MS = Infinity;', async (variant) => {
    const clock = new FakeClock(); const pending = deferred();
    const server = harness({ clock, provider: () => pending.promise }, variant.entry.createCoachHandler);
    let response = null;
    const operation = server.handle(request()).then((value) => { response = value; });
    await flush(); assert.equal(server.calls.length, 1, 'fixture reached provider');
    await clock.advance(3000);
    const observed = { status: response?.status ?? null, aborted: server.calls[0].options.signal.aborted, calls: server.calls.length };
    // Clean up the deliberately broken pending operation without depending on wall time.
    pending.resolve({ ...SAFE_FRAMING }); await flush(); await operation;
    assert.equal(clock.timers.size, 0, 'fixture cleanup completed');
    return observed;
  }, { status: 504, aborted: true, calls: 1 });
add('CACHEABLE_RESPONSE', 'http.js', "headers.set('Cache-Control', 'no-store');", "headers.set('Cache-Control', 'public, max-age=60');",
  async (variant) => (await post(variant)).response.headers.get('Cache-Control'), 'no-store');
add('RATE_LIMIT_BYPASS', 'admission.js', "if (rate === 'denied') return 429;\n  if (rate !== 'allowed') return 503;",
  "if (false) return 429;\n  if (false) return 503;", (variant) => statusAndCalls(variant,
    { admission: { ...localFakeAdmission(true), rateLimit: () => 'denied' } }), { status: 429, calls: 0 });
add('BREAKER_BYPASS', 'admission.js', "if (await gates.costBreaker({ signal }) !== 'enabled' || signal.aborted) return 503;",
  'if (false) return 503;', (variant) => statusAndCalls(variant,
    { admission: { ...localFakeAdmission(true), costBreaker: () => 'temporarily_disabled' } }), { status: 503, calls: 0 });
add('LEAKS_SECRET', 'http.js', "headers.set('X-Content-Type-Options', 'nosniff');",
  `headers.set('X-Content-Type-Options', 'nosniff');\n  headers.set('X-Debug', '${SENTINEL}');`, async (variant) => {
    const { response } = await post(variant, { provider: () => Promise.reject(new Error(SENTINEL)) });
    assert.equal(response.status, 502, 'fixture exercised provider failure');
    return (JSON.stringify([...response.headers]) + await response.text()).includes(SENTINEL);
  }, false);
add('LOGS_REQUEST_CONTENT', 'index.js', 'const input = Object.freeze({ sourceRuleId: validated.sourceRuleId, locale: validated.locale,',
  'console.log(validated.requestId);\n      const input = Object.freeze({ sourceRuleId: validated.sourceRuleId, locale: validated.locale,', async (variant) => {
    const { value, observations } = await observeSideEffects(() => post(variant, {}, { data: payload({ requestId: SENTINEL }) }));
    assert.equal(value.response.status, 200, 'fixture completes with recording logger');
    return observations.logs.length;
  }, 0);
add('CAPABILITIES_EXPOSE_MODEL_ID', 'profile-policy.js', '({ id, available: policy[id] })',
  "({ id, available: policy[id], modelId: 'arbitrary-private-model' })", async (variant) => {
    const { response } = await post(variant, {}, { method: 'GET', path: '/api/review-coach/capabilities' });
    assert.equal(response.status, 200, 'fixture reached capabilities');
    return await response.json();
  }, { version: 1, profiles: ['economy', 'balanced', 'quality'].map((id) => ({ id, available: true })), defaultProfile: 'economy' });

assert.equal(definitions.length, 20, 'all required mutation definitions exist');
assert.equal(new Set(definitions.map((definition) => definition.gate)).size, 20, 'no duplicate gate names');
for (const eol of ['\n', '\r\n']) {
  const healthy = await importVariant({ eol });
  for (const definition of definitions) {
    test(`${definition.gate} ${eol === '\n' ? 'LF' : 'CRLF'}`, async (context) => {
      // Same oracle must pass healthy production, then fail the executable mutant.
      const invariant = (actual) => assert.deepEqual(actual, definition.expected, definition.gate);
      const baseline = await definition.probe(healthy);
      invariant(baseline);
      const mutant = await importVariant({ ...definition, eol });
      assert.equal(mutant.applied, 1); assert.equal(mutant.importable, true);
      // Fixture/import errors are outside the expected assertion catch.
      const actual = await definition.probe(mutant);
      assert.notDeepEqual(actual, baseline, 'mutation reached an observable production path');
      let failure;
      try { invariant(actual); } catch (error) { failure = error; }
      assert.ok(failure instanceof assert.AssertionError, 'intended assertion failed, not fixture/import');
      assert.equal(failure.code, 'ERR_ASSERTION');
      assert.ok(failure.message.includes(definition.gate), 'failure belongs to the intended invariant');
      context.diagnostic('applied=1 importable=YES baseline=PASS intended_assertion=FAILED');
    });
  }
}
