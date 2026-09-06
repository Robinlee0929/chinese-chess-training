import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('C1C actual local Workers RPC, SQLite and rate binding reject redirects and enforce budget', async () => {
  const configuration = JSON.parse(await readFile(new URL('./wrangler.real-prelive.jsonc', import.meta.url), 'utf8'));
  const output = await build({ entryPoints: [fileURLToPath(new URL(configuration.main, import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
  const calls = [];
  let redirect = false;
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({
    modules: true, script: output.outputFiles[0].text, compatibilityDate: configuration.compatibility_date, cf: false,
    bindings: { ...configuration.vars, COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_DAILY_UNITS: '2', OPENAI_API_KEY: 'LOCAL_SYNTHETIC_ONLY' },
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
