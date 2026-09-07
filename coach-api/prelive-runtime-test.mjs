import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bootstrapSource } from './prelive-runtime-bootstrap.mjs';

test('C1E actual Workers public/RPC deny while private synthetic operator consumes once', async () => {
  // This entire transport and approving verifier exist ONLY in the local test
  // bundle. Neither is an entry point in any Wrangler/deployment configuration.
  const output = await build({ stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
    import { DurableObject } from 'cloudflare:workers';
    import publicWorker, { CoachRealProviderCoordinator } from './prelive/worker.js';
    import { createCoordinator } from './prelive/coordinator.js';
    import { provisionCoordinator, INITIAL_PROVISIONING } from './prelive/provision.js';
    import { purposeFor } from './src/rule-policy.js';
    export { CoachRealProviderCoordinator };
    export class SyntheticOperatorCoordinator extends DurableObject {
      #core;
      constructor(ctx, env) { super(ctx, env); ctx.blockConcurrencyWhile(async () => {
        if (!ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").toArray().length) provisionCoordinator(ctx.storage, INITIAL_PROVISIONING);
        this.#core = createCoordinator(ctx.storage, env, { operatorAuthority: async () => true,
          fetch: (url, options) => fetch(url, { ...options, redirect: 'manual' }) });
        await ctx.storage.sync();
      }); }
      async run() { const armed = await this.#core.operator.arm();
        const results = await Promise.all([this.#core.operator.dispatch(), this.#core.operator.dispatch()]);
        return JSON.stringify({ armed, results }); }
    }
    export default { async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path === '/test-operator') return new Response(await env.TEST_COORDINATOR.getByName('test-only').run());
      if (path === '/test-rpc') {
        try { await env.COACH_REAL_COORDINATOR.getByName('review-coach-real-provider-global-v1').execute({
          sourceRuleId: 'check-difference', locale: 'zh-Hant', style: 'child-neutral-teacher-v1',
          modelProfile: 'economy', purpose: purposeFor('check-difference') }); return new Response('unexpected'); }
        catch { return new Response(null, { status: 503 }); }
      }
      if (path === '/test-no-operator-rpc') {
        const stub = env.COACH_REAL_COORDINATOR.getByName('review-coach-real-provider-global-v1');
        for (const method of ['arm', 'dispatch', 'operator', 'recover', 'resetOneShot']) {
          try { await stub[method](); return new Response('unexpected'); } catch {}
        }
        return new Response(null, { status: 503 });
      }
      return publicWorker.fetch(request, env);
    } };
  ` }, bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
  let calls = 0;
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: output.outputFiles[0].text,
    compatibilityDate: '2026-09-03', cf: false,
    bindings: { COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_DAILY_UNITS: '20', OPENAI_API_KEY: 'LOCAL_SYNTHETIC_ONLY' },
    durableObjects: { COACH_REAL_COORDINATOR: { className: 'CoachRealProviderCoordinator', useSQLite: true },
      TEST_COORDINATOR: { className: 'SyntheticOperatorCoordinator', useSQLite: true } },
    ratelimits: { COACH_REAL_RATE_LIMITER: { namespace_id: '1', simple: { limit: 100, period: 60 } } },
    outboundService: async request => {
      calls++; assert.equal(request.url, 'https://api.openai.com/v1/responses');
      assert.equal((await request.json()).model, 'gpt-5.6-luna');
      return new Response(JSON.stringify({ object: 'response', status: 'completed', output: [{ type: 'message',
        role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: JSON.stringify({ leadIn: '請慢慢看看提示。', encouragement: '相信自己，繼續學習。' }) }] }] }));
    },
  }), telemetry: { enabled: false } });
  try {
    const publicReply = await runtime.dispatchFetch('https://local.invalid/api/review-coach', { method: 'POST',
      headers: { Origin: 'https://robinlee0929.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 2, requestId: 'local', locale: 'zh-Hant', sourceRuleId: 'check-difference',
        style: 'child-neutral-teacher-v1', modelProfile: 'economy' }) });
    assert.equal(publicReply.status, 503); assert.equal(await publicReply.text(), '');
    const rpc = await runtime.dispatchFetch('https://local.invalid/test-rpc'); assert.equal(rpc.status, 503);
    const operatorRpc = await runtime.dispatchFetch('https://local.invalid/test-no-operator-rpc'); assert.equal(operatorRpc.status, 503);
    assert.equal(calls, 0);
    const first = await (await runtime.dispatchFetch('https://local.invalid/test-operator')).json();
    assert.deepEqual(first.armed, { status: 'armed' });
    assert.equal(first.results.filter(x => x.status === 'completed').length, 1); assert.equal(calls, 1);
    const second = await (await runtime.dispatchFetch('https://local.invalid/test-operator')).json();
    assert.deepEqual(second, { armed: { status: 'denied' }, results: [{ status: 'denied' }, { status: 'denied' }] });
    assert.equal(calls, 1);
  } finally { await runtime.dispose(); }
});

test('C1C actual local Workers RPC, SQLite and rate binding reject redirects and enforce budget', async () => {
  const configuration = JSON.parse(await readFile(new URL('./wrangler.real-prelive.jsonc', import.meta.url), 'utf8'));
  const output = await build({ stdin: { contents: bootstrapSource, resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
  const calls = [];
  let redirect = false;
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({
    modules: true, script: output.outputFiles[0].text, compatibilityDate: configuration.compatibility_date, cf: false,
    bindings: { ...configuration.vars, COACH_REAL_PROVIDER_PUBLIC_ENABLED: 'true', COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_DAILY_UNITS: '2', OPENAI_API_KEY: 'LOCAL_SYNTHETIC_ONLY' },
    durableObjects: { COACH_REAL_COORDINATOR: { className: configuration.durable_objects.bindings[0].class_name,
      useSQLite: configuration.migrations[0].new_sqlite_classes.includes('CoachRealProviderCoordinator') } },
    // Local-only simulator namespace; no account ID or remote binding is used.
    ratelimits: { COACH_REAL_RATE_LIMITER: { namespace_id: '1', simple: { limit: 100, period: 60 } } },
    // All outbound traffic is intercepted. There is no passthrough network service.
    outboundService: async (request) => {
      calls.push(request.url);
      assert.equal(request.url, 'https://api.openai.com/v1/responses');
      if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://must-not-follow.invalid/' } });
      const body = await request.json();
      assert.equal(body.max_output_tokens, 128); assert.equal(body.store, false);
      return new Response(JSON.stringify({ object: 'response', status: 'completed', output: [{ type: 'message',
        role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: JSON.stringify({ leadIn: '請慢慢看看提示。', encouragement: '相信自己，繼續學習。' }) }] }] }));
    },
  }), telemetry: { enabled: false } });
  try {
    const send = () => runtime.dispatchFetch('https://local.invalid/api/review-coach', { method: 'POST',
      headers: { Origin: 'https://robinlee0929.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 2, requestId: 'local', locale: 'zh-Hant', sourceRuleId: 'check-difference',
        style: 'child-neutral-teacher-v1', modelProfile: 'economy' }) });
    const first = await send(); assert.equal(first.status, 200); await first.text();
    redirect = true;
    const second = await send(); assert.equal(second.status, 502); assert.equal(await second.text(), '');
    const exhausted = await send(); assert.equal(exhausted.status, 502);
    assert.deepEqual(calls, ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/responses']);
  } finally { await runtime.dispose(); }
});
