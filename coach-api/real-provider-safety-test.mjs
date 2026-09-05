import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import worker from './src/index.js';
import { createOpenAIProvider } from './src/openai-provider.js';
import {
  createSingleFlightConcurrencyAuthority,
  executeRealCoachProvider,
  MAX_REAL_PROVIDER_CONCURRENCY,
  PROVIDER_USAGE_IS_BUDGET_AUTHORITY,
  RATE_LIMITER_IS_GLOBAL_COST_ACCOUNTING,
} from './src/real-provider-safety.js';
import { purposeFor } from './src/rule-policy.js';
import { deferred, FakeClock, flush, payload, request } from './test-support.mjs';

const SECRET = 'C1B_SYNTHETIC_SECRET_NEVER_REAL';
const framing = Object.freeze({ leadIn: '請慢慢看看提示。', encouragement: '相信自己，繼續學習。' });
const providerInput = (modelProfile = 'economy') => ({ sourceRuleId: 'check-difference', locale: 'zh-Hant',
  style: 'child-neutral-teacher-v1', modelProfile, purpose: purposeFor('check-difference') });
const envelope = (text = JSON.stringify(framing)) => ({ object: 'response', status: 'completed', error: null,
  incomplete_details: null, output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }] });
const response = (body = envelope(), status = 200) => new Response(JSON.stringify(body), { status });

function redacted(error) {
  assert.deepEqual(error, { name: 'CoachProviderError', code: 'provider_unavailable', message: 'Provider unavailable' });
  assert.equal(Object.hasOwn(error, 'stack'), false);
  assert.equal(JSON.stringify(error).includes(SECRET), false);
  return true;
}

function approvedConfiguration(provider, { trace = [], finalizations = [], concurrency } = {}) {
  const acquire = concurrency ?? createSingleFlightConcurrencyAuthority();
  return {
    enabledAuthority: async () => { trace.push('enable'); return true; },
    rateLimitAuthority: async () => { trace.push('rate-limit'); return 'allowed'; },
    budgetAuthority: async () => {
      trace.push('budget');
      let finalized = false;
      return { finalize: async (details) => {
        assert.equal(finalized, false, 'a reservation must finalize exactly once');
        finalized = true;
        finalizations.push(details);
        trace.push('finalize');
        return true;
      } };
    },
    concurrencyAuthority: async (options) => {
      trace.push('concurrency');
      const lease = await acquire(options);
      if (!lease) return null;
      return { release: async () => { trace.push('release'); return lease.release(); } };
    },
    provider: async (...args) => { trace.push('provider'); return provider(...args); },
  };
}

function openAI(fetchImpl, clock) {
  return createOpenAIProvider({ apiKey: SECRET, fetch: fetchImpl, ...(clock ? { clock } : {}) });
}

test('C1B approved execution follows exact guards and preserves the bounded C1A request', async () => {
  assert.equal(RATE_LIMITER_IS_GLOBAL_COST_ACCOUNTING, false);
  assert.equal(PROVIDER_USAGE_IS_BUDGET_AUTHORITY, false);
  const trace = [];
  const finalizations = [];
  const calls = [];
  const provider = openAI(async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return response(); });
  assert.deepEqual(await executeRealCoachProvider(
    approvedConfiguration(provider, { trace, finalizations }), providerInput(),
  ), framing);
  assert.deepEqual(trace.slice(0, 5), ['enable', 'rate-limit', 'budget', 'concurrency', 'provider']);
  assert.deepEqual(trace.slice(5), ['release', 'finalize']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(Object.keys(calls[0].body).sort(),
    ['model', 'store', 'reasoning', 'max_output_tokens', 'instructions', 'input', 'text'].sort());
  assert.equal(calls[0].body.model, 'gpt-5.6-luna');
  assert.equal(calls[0].body.store, false);
  assert.deepEqual(calls[0].body.reasoning, { effort: 'none' });
  assert.equal(calls[0].body.max_output_tokens, 128);
  assert.equal(Object.hasOwn(calls[0].body, 'tools'), false);
  assert.equal(Object.hasOwn(calls[0].body, 'requestId'), false);
  assert.equal(JSON.stringify(calls[0].body).includes(SECRET), false);
  assert.deepEqual(finalizations, [{ attempted: true, outcome: 'succeeded' }]);
});

test('C1B denial matrix fails closed before every OpenAI fetch', async () => {
  const cases = [
    ['configuration missing', () => null, providerInput()],
    ['provider disabled', (base) => ({ ...base, enabledAuthority: async () => false }), providerInput()],
    ['enable authority missing', (base) => ({ ...base, enabledAuthority: undefined }), providerInput()],
    ['client enable ignored', (base) => ({ ...base, enabledAuthority: async () => false }),
      { ...providerInput(), realProviderEnabled: true }],
    ['rate limit denied', (base) => ({ ...base, rateLimitAuthority: async () => 'denied' }), providerInput()],
    ['rate limit missing', (base) => ({ ...base, rateLimitAuthority: undefined }), providerInput()],
    ['rate limit throws', (base) => ({ ...base, rateLimitAuthority: async () => { throw new Error(SECRET); } }), providerInput()],
    ['budget denied', (base) => ({ ...base, budgetAuthority: async () => null }), providerInput()],
    ['budget missing', (base) => ({ ...base, budgetAuthority: undefined }), providerInput()],
    ['budget throws', (base) => ({ ...base, budgetAuthority: async () => { throw new Error(SECRET); } }), providerInput()],
    ['concurrency denied', (base) => ({ ...base, concurrencyAuthority: async () => null }), providerInput()],
    ['concurrency missing', (base) => ({ ...base, concurrencyAuthority: undefined }), providerInput()],
    ['concurrency throws', (base) => ({ ...base, concurrencyAuthority: async () => { throw new Error(SECRET); } }), providerInput()],
    ['unknown model profile', (base) => base, providerInput('unknown')],
    ['invalid provider input', (base) => base, { ...providerInput(), board: [[SECRET]] }],
  ];
  for (const [name, alter, input] of cases) {
    let fetches = 0;
    const base = approvedConfiguration(openAI(async () => { fetches++; return response(); }));
    await assert.rejects(executeRealCoachProvider(alter(base), input), redacted, name);
    assert.equal(fetches, 0, name);
  }
});

test('C1B budget reservation finalizes once for success, provider failure and no-attempt denial', async () => {
  for (const [name, provider, concurrencyAuthority, expected] of [
    ['success', async () => framing, async () => ({ release: () => true }), { attempted: true, outcome: 'succeeded' }],
    ['provider failure', async () => { throw new Error(SECRET); }, async () => ({ release: () => true }),
      { attempted: true, outcome: 'failed' }],
    ['concurrency denial', async () => framing, async () => null, { attempted: false, outcome: 'not_attempted' }],
  ]) {
    const finalizations = [];
    const config = approvedConfiguration(provider, { finalizations });
    config.concurrencyAuthority = concurrencyAuthority;
    if (name === 'success') await executeRealCoachProvider(config, providerInput());
    else await assert.rejects(executeRealCoachProvider(config, providerInput()), redacted);
    assert.deepEqual(finalizations, [expected], name);
    assert.deepEqual(Object.keys(finalizations[0]).sort(), ['attempted', 'outcome']);
  }
});

test('C1B single-flight concurrency is one, denies without a queue, and releases after success', async () => {
  assert.equal(MAX_REAL_PROVIDER_CONCURRENCY, 1);
  const pending = deferred();
  let fetches = 0;
  let inFlight = 0;
  let maximum = 0;
  const provider = openAI(async () => {
    fetches++;
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    const value = fetches === 1 ? await pending.promise : response();
    inFlight--;
    return value;
  });
  const concurrency = createSingleFlightConcurrencyAuthority();
  const first = executeRealCoachProvider(approvedConfiguration(provider, { concurrency }), providerInput());
  await flush();
  await assert.rejects(executeRealCoachProvider(
    approvedConfiguration(provider, { concurrency }), providerInput(),
  ), redacted);
  assert.equal(fetches, 1);
  assert.equal(maximum, 1);
  pending.resolve(response());
  assert.deepEqual(await first, framing);
  assert.deepEqual(await executeRealCoachProvider(
    approvedConfiguration(provider, { concurrency }), providerInput(),
  ), framing);
  assert.equal(fetches, 2);
  assert.equal(maximum, 1);
});

for (const [name, failingReply] of [
  ['network', () => { throw new Error(SECRET); }],
  ['429', () => response({ error: SECRET }, 429)],
  ['500', () => response({ error: SECRET }, 500)],
  ['malformed response', () => response({ secret: SECRET })],
  ['parser rejection', () => response(envelope('{invalid JSON'))],
  ['unsafe framing', () => response(envelope(JSON.stringify({ ...framing, leadIn: '這步將軍。' })))],
]) test(`C1B releases concurrency and finalizes budget after ${name}`, async () => {
  let fail = true;
  let fetches = 0;
  let active = 0;
  let maximum = 0;
  const finalizations = [];
  const concurrency = createSingleFlightConcurrencyAuthority();
  const provider = openAI(async () => {
    fetches++; active++; maximum = Math.max(maximum, active);
    try { return fail ? failingReply() : response(); }
    finally { active--; }
  });
  await assert.rejects(executeRealCoachProvider(
    approvedConfiguration(provider, { concurrency, finalizations }), providerInput(),
  ), redacted);
  assert.equal(fetches, 1, 'no retry');
  assert.equal(active, 0, 'underlying fetch settled before reuse');
  fail = false;
  assert.deepEqual(await executeRealCoachProvider(
    approvedConfiguration(provider, { concurrency, finalizations }), providerInput(),
  ), framing);
  assert.equal(fetches, 2, 'released lease permits one later call');
  assert.equal(maximum, 1);
  assert.deepEqual(finalizations, [
    { attempted: true, outcome: 'failed' }, { attempted: true, outcome: 'succeeded' },
  ]);
});

test('C1B timeout aborts, releases concurrency, finalizes budget, and permits recovery', async () => {
  const clock = new FakeClock();
  const pending = deferred();
  const signals = [];
  let fetches = 0;
  const finalizations = [];
  const concurrency = createSingleFlightConcurrencyAuthority();
  const provider = openAI((_url, options) => {
    fetches++;
    signals.push(options.signal);
    return fetches === 1 ? pending.promise : response();
  }, clock);
  const first = assert.rejects(executeRealCoachProvider(
    approvedConfiguration(provider, { concurrency, finalizations }), providerInput(),
  ), redacted);
  await flush();
  await clock.advance(3000);
  await first;
  assert.equal(fetches, 1);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(finalizations, [], 'active attempt keeps its budget reservation');
  await assert.rejects(executeRealCoachProvider(
    approvedConfiguration(provider, { concurrency }), providerInput(),
  ), redacted);
  assert.equal(fetches, 1);
  pending.resolve(response());
  await flush();
  assert.deepEqual(await executeRealCoachProvider(
    approvedConfiguration(provider, { concurrency, finalizations }), providerInput(),
  ), framing);
  assert.equal(fetches, 2);
  assert.deepEqual(finalizations, [
    { attempted: true, outcome: 'failed' }, { attempted: true, outcome: 'succeeded' },
  ]);
});

test('C1B cleanup authorities fail closed while both settlement paths are attempted', async () => {
  let releases = 0;
  let finalizations = 0;
  const config = approvedConfiguration(async () => framing);
  config.concurrencyAuthority = async () => ({ release: async () => { releases++; throw new Error(SECRET); } });
  config.budgetAuthority = async () => ({ finalize: async () => { finalizations++; return true; } });
  await assert.rejects(executeRealCoachProvider(config, providerInput()), redacted);
  assert.equal(releases, 1);
  assert.equal(finalizations, 1);

  const concurrency = createSingleFlightConcurrencyAuthority();
  const failingFinalize = approvedConfiguration(async () => framing, { concurrency });
  failingFinalize.budgetAuthority = async () => ({ finalize: async () => { throw new Error(SECRET); } });
  await assert.rejects(executeRealCoachProvider(failingFinalize, providerInput()), redacted);
  assert.deepEqual(await executeRealCoachProvider(
    approvedConfiguration(async () => framing, { concurrency }), providerInput(),
  ), framing, 'lease is released even when budget finalization fails');
});

test('C1B default Worker remains fake-only and browser fields cannot enable real provider', async () => {
  let injectedProviderCalls = 0;
  const env = { COACH_FAKE_ENABLED: 'true', REAL_PROVIDER_ENABLED: true,
    OPENAI_PROVIDER: () => { injectedProviderCalls++; return framing; } };
  const normal = await worker.fetch(request(), env);
  assert.equal(normal.status, 200);
  assert.equal(injectedProviderCalls, 0);
  const hostile = await worker.fetch(request({ data: { ...payload(), realProviderEnabled: true } }), env);
  assert.equal(hostile.status, 400);
  assert.equal(injectedProviderCalls, 0);
});

test('C1B failures redact secret, budget state, provider diagnostics and logs', async (t) => {
  const logs = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  const config = approvedConfiguration(async () => { throw new Error(`${SECRET}:model:budget=999`); });
  config.budgetAuthority = async () => ({ finalize: async () => { throw new Error(`${SECRET}:budget`); } });
  await assert.rejects(executeRealCoachProvider(config, providerInput()), redacted);
  assert.deepEqual(logs, []);
});

async function drainProbe(implementation = { executeRealCoachProvider, createSingleFlightConcurrencyAuthority },
  mode = 'late success') {
  const clock = new FakeClock();
  const pending = deferred();
  const controller = new AbortController();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  let releases = 0;
  let callerResults = 0;
  let abortObserved = false;
  const finalizations = [];
  const provider = openAI(async (_url, { signal }) => {
    const ordinal = ++calls;
    active++;
    maximum = Math.max(maximum, active);
    try {
      if (ordinal === 1) {
        signal.addEventListener('abort', () => {
          abortObserved = true;
          if (mode === 'cooperative') pending.reject(new Error(SECRET));
        }, { once: true });
        await pending.promise;
      }
      return response();
    } finally { active--; }
  }, clock);
  const acquire = implementation.createSingleFlightConcurrencyAuthority();
  const concurrency = async (options) => {
    const lease = await acquire(options);
    return lease && { release: () => { releases++; return lease.release(); } };
  };
  const config = () => approvedConfiguration(provider, { concurrency, finalizations });
  let firstSucceeded = false;
  const first = implementation.executeRealCoachProvider(config(), providerInput(), { signal: controller.signal })
    .then(() => { firstSucceeded = true; callerResults++; }, (error) => { redacted(error); callerResults++; });
  await flush();
  if (mode === 'caller abort') controller.abort();
  else await clock.advance(3000);
  await first; // Must finish even though the underlying operation is still pending.
  const before = { active, calls, releases, finalizations: finalizations.length };
  let secondDenied = false;
  try { await implementation.executeRealCoachProvider(config(), providerInput()); }
  catch (error) { redacted(error); secondDenied = true; }
  const secondFetches = calls - before.calls;
  if (mode === 'late failure') pending.reject(new Error(SECRET));
  else pending.resolve();
  await flush();
  const afterDrain = { active, releases, callerResults, finalizations: [...finalizations] };
  const recovered = await implementation.executeRealCoachProvider(config(), providerInput());
  return { maximum, abortObserved, before, secondDenied, secondFetches, afterDrain,
    callerResults, firstSucceeded, recovered, releases, finalizations };
}

for (const mode of ['late success', 'late failure', 'cooperative', 'caller abort']) {
  test(`C1B actual underlying lifetime remains single-flight: ${mode}`, async () => {
    const unhandled = [];
    const listener = (error) => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
      const result = await drainProbe(undefined, mode);
      assert.equal(result.maximum, 1);
      assert.equal(result.abortObserved, true);
      assert.equal(result.firstSucceeded, false);
      assert.equal(result.callerResults, 1);
      assert.deepEqual(result.recovered, framing);
      assert.equal(result.afterDrain.active, 0);
      if (mode !== 'cooperative') {
        assert.deepEqual(result.before, { active: 1, calls: 1, releases: 0, finalizations: 0 });
        assert.equal(result.secondDenied, true);
        assert.equal(result.secondFetches, 0);
        assert.equal(result.afterDrain.releases, 1);
        assert.deepEqual(result.afterDrain.finalizations, [
          { attempted: false, outcome: 'not_attempted' }, { attempted: true, outcome: 'failed' },
        ]);
        assert.equal(result.releases, 2);
      } else {
        assert.equal(result.before.active, 0);
        assert.equal(result.secondDenied, false);
        assert.equal(result.releases, 3);
      }
      assert.equal(result.finalizations.filter((v) => v.attempted && v.outcome === 'failed').length, 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally { process.removeListener('unhandledRejection', listener); }
  });
}

test('C1B response-body cancellation must settle before capacity and budget are released', async () => {
  const clock = new FakeClock();
  const drain = deferred();
  let calls = 0;
  let cancellations = 0;
  const finalizations = [];
  const provider = openAI(async () => {
    calls++;
    if (calls > 1) return response();
    return new Response(new ReadableStream({ cancel() { cancellations++; return drain.promise; } }));
  }, clock);
  const concurrency = createSingleFlightConcurrencyAuthority();
  const config = () => approvedConfiguration(provider, { concurrency, finalizations });
  const first = assert.rejects(executeRealCoachProvider(config(), providerInput()), redacted);
  await flush();
  await clock.advance(3000);
  await first;
  assert.equal(cancellations, 1);
  assert.deepEqual(finalizations, []);
  await assert.rejects(executeRealCoachProvider(config(), providerInput()), redacted);
  assert.equal(calls, 1);
  drain.resolve();
  await flush();
  assert.deepEqual(await executeRealCoachProvider(config(), providerInput()), framing);
  assert.equal(calls, 2);
  assert.equal(cancellations, 1);
});

const sources = {
  safety: await readFile(new URL('./src/real-provider-safety.js', import.meta.url), 'utf8'),
  openai: await readFile(new URL('./src/openai-provider.js', import.meta.url), 'utf8'),
  index: await readFile(new URL('./src/index.js', import.meta.url), 'utf8'),
};
const healthy = {
  safety: { executeRealCoachProvider, createSingleFlightConcurrencyAuthority },
  openai: { createOpenAIProvider },
  index: { default: worker },
};

async function variant(target, before, after, eol) {
  const normalized = sources[target].replace(/\r\n/g, '\n');
  assert.equal(normalized.split(before).length, 2, 'mutation replacement must be unique');
  const code = normalized.replace(before, after).replace(/from '(\.\/[^']+)'/g,
    (_match, relative) => `from '${new URL(relative, new URL('./src/', import.meta.url)).href}'`).replace(/\n/g, eol);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`);
  return { module: loaded, applied: 1, syntacticallyValid: true, importable: true };
}

function simpleConfig(provider, overrides = {}) {
  return {
    enabledAuthority: async () => true,
    rateLimitAuthority: async () => 'allowed',
    budgetAuthority: async () => ({ finalize: async () => true }),
    concurrencyAuthority: async () => ({ release: async () => true }),
    provider,
    ...overrides,
  };
}

const mutationDefinitions = [
  { name: 'PROVIDER_ENABLED_BY_DEFAULT', target: 'safety', before: 'const DEFAULT_ENABLE = false;',
    after: 'const DEFAULT_ENABLE = true;', expected: 0, probe: async (implementation) => {
      let calls = 0;
      const config = simpleConfig(async () => { calls++; return framing; }, { enabledAuthority: undefined });
      try { await implementation.executeRealCoachProvider(config, providerInput()); } catch {}
      return calls;
    } },
  { name: 'CLIENT_CONTROLLED_ENABLE', target: 'safety',
    before: 'if (await enabledAuthority({ signal }) !== true || signal?.aborted) throw failure();',
    after: 'if (input?.realProviderEnabled !== true && (await enabledAuthority({ signal }) !== true || signal?.aborted)) throw failure();',
    expected: 0, probe: async (implementation) => {
      let calls = 0;
      const config = simpleConfig(async () => { calls++; return framing; }, { enabledAuthority: async () => false });
      try { await implementation.executeRealCoachProvider(config, { ...providerInput(), realProviderEnabled: true }); } catch {}
      return calls;
    } },
  { name: 'RATE_LIMITER_BYPASS', target: 'safety',
    before: "if (await config.rateLimitAuthority({ signal }) !== 'allowed' || signal?.aborted) throw failure();",
    after: 'await config.rateLimitAuthority({ signal }); if (signal?.aborted) throw failure();', expected: 0,
    probe: async (implementation) => {
      let calls = 0;
      const config = simpleConfig(async () => { calls++; return framing; }, { rateLimitAuthority: async () => 'denied' });
      try { await implementation.executeRealCoachProvider(config, providerInput()); } catch {}
      return calls;
    } },
  { name: 'BUDGET_AUTHORITY_BYPASS', target: 'safety',
    before: "const reservation = snapshotExact(rawReservation, ['finalize']);",
    after: "const reservation = snapshotExact(rawReservation, ['finalize']) || { finalize: () => true };", expected: 0,
    probe: async (implementation) => {
      let calls = 0;
      const config = simpleConfig(async () => { calls++; return framing; }, { budgetAuthority: async () => null });
      try { await implementation.executeRealCoachProvider(config, providerInput()); } catch {}
      return calls;
    } },
  { name: 'PROVIDER_BEFORE_BUDGET_APPROVAL', target: 'safety',
    before: 'const rawReservation = await budgetAuthority({ signal });',
    after: 'await config.provider(input, { signal }); const rawReservation = await budgetAuthority({ signal });',
    expected: { beforeApproval: 0, total: 1 }, probe: async (implementation) => {
      const approval = deferred();
      let calls = 0;
      const config = simpleConfig(async () => { calls++; return framing; }, {
        budgetAuthority: async () => { await approval.promise; return { finalize: async () => true }; },
      });
      const execution = implementation.executeRealCoachProvider(config, providerInput()).catch(() => null);
      await flush();
      const beforeApproval = calls;
      approval.resolve();
      await execution;
      return { beforeApproval, total: calls };
    } },
  { name: 'MISSING_BUDGET_FAILS_OPEN', target: 'safety',
    before: "if (typeof budgetAuthority !== 'function') throw failure();",
    after: "if (typeof budgetAuthority !== 'function') budgetAuthority = async () => ({ finalize: () => true });",
    expected: 0, probe: async (implementation) => {
      let calls = 0;
      const config = simpleConfig(async () => { calls++; return framing; }, { budgetAuthority: undefined });
      try { await implementation.executeRealCoachProvider(config, providerInput()); } catch {}
      return calls;
    } },
  { name: 'CONCURRENCY_BYPASS', target: 'safety',
    before: 'const rawLease = await config.concurrencyAuthority({ signal });',
    after: 'const rawLease = { release: () => true };', expected: 0, probe: async (implementation) => {
      let calls = 0;
      const config = simpleConfig(async () => { calls++; return framing; }, { concurrencyAuthority: async () => null });
      try { await implementation.executeRealCoachProvider(config, providerInput()); } catch {}
      return calls;
    } },
  { name: 'LEASE_NOT_RELEASED_ON_TIMEOUT', target: 'safety',
    before: 'if (await lease.release() !== true) cleanupFailed = true;',
    after: 'if (false) cleanupFailed = true;', expected: { fetches: 2, recovered: true },
    probe: async (implementation) => {
      const clock = new FakeClock();
      const pending = deferred();
      let fetches = 0;
      const provider = openAI(() => { fetches++; return fetches === 1 ? pending.promise : response(); }, clock);
      const concurrency = implementation.createSingleFlightConcurrencyAuthority();
      const config = simpleConfig(provider, { concurrencyAuthority: concurrency });
      const first = implementation.executeRealCoachProvider(config, providerInput()).catch(() => null);
      await flush();
      await clock.advance(3000);
      await first;
      pending.resolve(response());
      await flush();
      let recovered = true;
      try { await implementation.executeRealCoachProvider(config, providerInput()); } catch { recovered = false; }
      pending.resolve(response());
      await flush();
      return { fetches, recovered };
    } },
  { name: 'SAFETY_LAYER_RETRY', target: 'safety',
    before: 'value = await config.provider(input, { signal, registerTermination });',
    after: 'try { value = await config.provider(input, { signal, registerTermination }); } catch { value = await config.provider(input, { signal, registerTermination }); }',
    expected: { calls: 1, succeeded: false }, probe: async (implementation) => {
      let calls = 0;
      const config = simpleConfig(async () => { calls++; if (calls === 1) throw new Error(SECRET); return framing; });
      let succeeded = true;
      try { await implementation.executeRealCoachProvider(config, providerInput()); } catch { succeeded = false; }
      return { calls, succeeded };
    } },
  { name: 'MAX_OUTPUT_TOKENS_INCREASED', target: 'openai', before: 'max_output_tokens: 128,',
    after: 'max_output_tokens: 2048,', expected: 128, probe: async (implementation) => {
      let observed;
      const provider = implementation.createOpenAIProvider({ apiKey: SECRET, fetch: async (_url, options) => {
        observed = JSON.parse(options.body).max_output_tokens;
        return response();
      } });
      await provider(providerInput());
      return observed;
    } },
  { name: 'API_KEY_MOVED_INTO_BODY', target: 'openai', before: 'body: JSON.stringify(body),',
    after: 'body: JSON.stringify({ ...body, apiKey }),', expected: false, probe: async (implementation) => {
      let leaked = false;
      const provider = implementation.createOpenAIProvider({ apiKey: SECRET, fetch: async (_url, options) => {
        leaked = options.body.includes(SECRET);
        return response();
      } });
      await provider(providerInput());
      return leaked;
    } },
  { name: 'FAKE_STAGING_SWITCHED_TO_OPENAI', target: 'index',
    before: "return createCoachHandler({ admission: localFakeAdmission(env?.COACH_FAKE_ENABLED === 'true') })(request);",
    after: "return createCoachHandler({ provider: env?.OPENAI_PROVIDER, admission: localFakeAdmission(env?.COACH_FAKE_ENABLED === 'true') })(request);",
    expected: { status: 200, injectedCalls: 0 }, probe: async (implementation) => {
      let injectedCalls = 0;
      const result = await implementation.default.fetch(request(), { COACH_FAKE_ENABLED: 'true',
        OPENAI_PROVIDER: () => { injectedCalls++; return framing; } });
      return { status: result.status, injectedCalls };
    } },
];

mutationDefinitions.push({ name: 'EARLY_TIMEOUT_LEASE_RELEASE', target: 'safety',
  before: 'if (!terminated) {', after: 'if (false) {', expected: 1,
  probe: async (implementation) => (await drainProbe(implementation)).maximum,
});
assert.equal(mutationDefinitions.length, 13, 'all required C1B safety mutations are defined');
for (const definition of mutationDefinitions) {
  for (const eol of ['\n', '\r\n']) {
    test(`BROKEN_C1B_${definition.name}_WOULD_FAIL ${eol === '\n' ? 'LF' : 'CRLF'}`, async () => {
      const invariant = (actual) => assert.deepEqual(actual, definition.expected, definition.name);
      invariant(await definition.probe(healthy[definition.target]));
      const mutant = await variant(definition.target, definition.before, definition.after, eol);
      assert.equal(mutant.applied, 1);
      assert.equal(mutant.syntacticallyValid, true);
      assert.equal(mutant.importable, true);
      const actual = await definition.probe(mutant.module);
      if (definition.name === 'EARLY_TIMEOUT_LEASE_RELEASE') {
        assert.equal(actual, 2, 'early release must reproduce exactly two underlying fetches');
      }
      assert.notDeepEqual(actual, definition.expected, 'mutant path executed and broken behavior observed');
      assert.throws(() => invariant(actual), { name: 'AssertionError', code: 'ERR_ASSERTION' });
      console.log('mutation_applied=YES syntax_valid=YES importable=YES path_executed=YES broken_behavior=YES intended_assertion=FAILED');
    });
  }
}
