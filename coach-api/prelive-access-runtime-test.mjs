import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { response, input } from './prelive-test-support.mjs';

test('C1F real workerd Access identity, production routing/RPC/SQLite, mocked outbound only', async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL('./prelive/worker.js', import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
  for (const access of [undefined, { aud: 'synthetic-audience' },
    { aud: 'wrong', identity: { email: 'operator@example.invalid' } },
    { aud: 'synthetic-audience', identity: { email: 'other@example.invalid' } },
    { aud: 'synthetic-audience', identity: { email: 'operator@example.invalid' } }]) {
    let calls = 0;
    const runtime = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: output.outputFiles[0].text,
      compatibilityDate: '2026-09-03', cf: false, access,
      bindings: { COACH_OPERATOR_ACCESS_AUD: 'synthetic-audience', COACH_OPERATOR_EMAIL: 'operator@example.invalid',
        COACH_OPERATOR_ORIGIN: 'https://local.invalid', COACH_REAL_PROVIDER_ENABLED: 'true',
        COACH_REAL_DAILY_UNITS: '20', OPENAI_API_KEY: 'C1F_SYNTHETIC_ONLY' },
      durableObjects: { COACH_REAL_COORDINATOR: { className: 'CoachRealProviderCoordinator', useSQLite: true } },
      ratelimits: { COACH_REAL_RATE_LIMITER: { namespace_id: '1', simple: { limit: 100, period: 60 } } },
      outboundService: async request => {
        calls++; assert.equal(request.url, 'https://api.openai.com/v1/responses');
        const body = await request.json(); assert.equal(body.model, 'gpt-5.6-luna');
        assert.equal(body.input, input().purpose); assert.equal(JSON.stringify(body).includes('@'), false);
        return response();
      },
    }), telemetry: { enabled: false } });
    try {
      const send = (action, options = {}) => runtime.dispatchFetch(`https://local.invalid/__operator/one-shot/${action}`,
        { method: 'POST', headers: { Origin: 'https://local.invalid' }, ...options });
      const approved = access?.aud === 'synthetic-audience' && access.identity?.email === 'operator@example.invalid';
      assert.equal((await send('dispatch')).status, 403); assert.equal(calls, 0);
      assert.equal((await send('arm', { method: 'GET' })).status, 403);
      assert.equal((await send('arm', { headers: { Origin: 'https://foreign.invalid' } })).status, 403);
      assert.equal((await send('arm')).status, approved ? 200 : 403); assert.equal(calls, 0);
      const results = await Promise.all([send('dispatch'), send('dispatch')]);
      assert.equal(results.filter(r => r.status === 200).length, approved ? 1 : 0);
      assert.equal(calls, approved ? 1 : 0);
      assert.equal((await send('arm')).status, 403);
      assert.equal((await send('dispatch')).status, 403);
    } finally { await runtime.dispose(); }
  }
});
