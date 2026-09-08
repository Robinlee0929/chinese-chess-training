import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CONFIG_URL = new URL('./wrangler.real-prelive.jsonc', import.meta.url);
const EXPECTED_NAME = 'chinese-chess-coach-openai-staging';
const EXPECTED_ORIGIN = 'https://chinese-chess-coach-openai-staging.robinlee700929.workers.dev';
const EXPECTED_DO_BINDINGS = [{ name: 'COACH_REAL_COORDINATOR', class_name: 'CoachRealProviderCoordinator' }];
const EXPECTED_RATE_BINDINGS = [{ name: 'COACH_REAL_RATE_LIMITER', namespace_id: '41064290422425',
  simple: { limit: 1, period: 60 } }];
const EXPECTED_MIGRATIONS = [{ tag: 'real-provider-v1', new_sqlite_classes: ['CoachRealProviderCoordinator'] }];
const EXTERNAL_ROLLOUT_STATE = Object.freeze({ operatorOrigin: EXPECTED_ORIGIN,
  accessApplicationRetained: true, accessAudienceRetained: true, accessEmailRetained: true });

const config = JSON.parse(await readFile(CONFIG_URL, 'utf8'));
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const workersDevOrigin = value => `https://${value.name}.robinlee700929.workers.dev`;

function violations(value, rollout = EXTERNAL_ROLLOUT_STATE) {
  const found = [];
  if (!has(value, 'workers_dev') || value.workers_dev !== true) found.push('WORKERS_DEV_NOT_EXPLICITLY_ENABLED');
  if (value.name !== EXPECTED_NAME) found.push('WORKER_NAME_CHANGED');
  if (value.main !== 'prelive/worker.js') found.push('PRODUCTION_ENTRYPOINT_CHANGED');
  if (value.preview_urls !== false) found.push('PREVIEW_URLS_ENABLED');
  if (has(value, 'route') || has(value, 'routes')) found.push('CUSTOM_ROUTE_INTRODUCED');
  if (workersDevOrigin(value) !== EXPECTED_ORIGIN || rollout.operatorOrigin !== EXPECTED_ORIGIN) found.push('OPERATOR_ORIGIN_DRIFT');
  if (!rollout.accessApplicationRetained || !rollout.accessAudienceRetained || !rollout.accessEmailRetained) {
    found.push('ACCESS_AUTHORITY_REMOVED');
  }
  if (value.access !== undefined) found.push('ACCESS_SIMULATION_INTRODUCED');
  for (const key of ['COACH_OPERATOR_ACCESS_AUD', 'COACH_OPERATOR_EMAIL', 'COACH_OPERATOR_ORIGIN', 'OPENAI_API_KEY']) {
    if (has(value.vars ?? {}, key)) found.push('LIVE_AUTHORITY_COMMITTED');
  }
  if (JSON.stringify(value.durable_objects?.bindings) !== JSON.stringify(EXPECTED_DO_BINDINGS)) found.push('DO_BINDING_CHANGED');
  if (JSON.stringify(value.ratelimits) !== JSON.stringify(EXPECTED_RATE_BINDINGS)) found.push('RATE_BINDING_CHANGED');
  if (JSON.stringify(value.migrations) !== JSON.stringify(EXPECTED_MIGRATIONS)) found.push('MIGRATION_CHANGED');
  if (value.vars?.COACH_REAL_PROVIDER_ENABLED !== 'false') found.push('PROVIDER_NOT_DISABLED');
  if (value.vars?.COACH_REAL_DAILY_UNITS !== '0') found.push('BUDGET_NOT_ZERO');
  if (has(value.vars ?? {}, 'COACH_REAL_PROVIDER_PUBLIC_ENABLED')
    && value.vars.COACH_REAL_PROVIDER_PUBLIC_ENABLED !== 'false') found.push('PUBLIC_PROVIDER_ENABLED');
  return found;
}

test('C1K P2A committed config explicitly preserves only the expected workers.dev ingress', () => {
  assert.deepEqual(violations(config), []);
  assert.equal(workersDevOrigin(config), EXPECTED_ORIGIN);
});

test('C1K P2A pinned Wrangler 4.129.0 accepts the corrected configuration', () => {
  assert.equal(require('./package.json').devDependencies.wrangler, '4.129.0');
  const parsed = require('wrangler').unstable_readConfig({ config: fileURLToPath(CONFIG_URL) });
  assert.equal(parsed.name, EXPECTED_NAME);
  assert.equal(parsed.workers_dev, true);
  assert.equal(parsed.preview_urls, false);
  assert.equal(parsed.routes, undefined);
});

const mutations = [
  { name: 'WORKERS_DEV_FALSE', issue: 'WORKERS_DEV_NOT_EXPLICITLY_ENABLED',
    mutate: value => { value.workers_dev = false; }, witness: value => value.workers_dev === false },
  { name: 'WORKERS_DEV_OMITTED', issue: 'WORKERS_DEV_NOT_EXPLICITLY_ENABLED',
    mutate: value => { delete value.workers_dev; }, witness: value => !has(value, 'workers_dev') },
  { name: 'WORKER_NAME_CHANGED', issue: 'WORKER_NAME_CHANGED',
    mutate: value => { value.name = 'another-worker'; }, witness: value => value.name === 'another-worker' },
  { name: 'OPERATOR_ORIGIN_DRIFT', issue: 'OPERATOR_ORIGIN_DRIFT',
    mutateRollout: value => { value.operatorOrigin = 'https://wrong.example.invalid'; },
    witness: (_value, rollout) => rollout.operatorOrigin === 'https://wrong.example.invalid' },
  { name: 'ACCESS_AUTHORITY_REMOVED', issue: 'ACCESS_AUTHORITY_REMOVED',
    mutateRollout: value => { value.accessAudienceRetained = false; },
    witness: (_value, rollout) => rollout.accessAudienceRetained === false },
  { name: 'DO_BINDING_CLASS_CHANGED', issue: 'DO_BINDING_CHANGED',
    mutate: value => { value.durable_objects.bindings[0].class_name = 'OtherCoordinator'; },
    witness: value => value.durable_objects.bindings[0].class_name === 'OtherCoordinator' },
  { name: 'RATE_NAMESPACE_CHANGED', issue: 'RATE_BINDING_CHANGED',
    mutate: value => { value.ratelimits[0].namespace_id = '99999999999999'; },
    witness: value => value.ratelimits[0].namespace_id === '99999999999999' },
  { name: 'MIGRATION_CHANGED', issue: 'MIGRATION_CHANGED',
    mutate: value => { value.migrations[0].tag = 'unexpected-v2'; },
    witness: value => value.migrations[0].tag === 'unexpected-v2' },
  { name: 'PUBLIC_PROVIDER_ENABLED', issue: 'PUBLIC_PROVIDER_ENABLED',
    mutate: value => { value.vars.COACH_REAL_PROVIDER_PUBLIC_ENABLED = 'true'; },
    witness: value => value.vars.COACH_REAL_PROVIDER_PUBLIC_ENABLED === 'true' },
  { name: 'PROVIDER_ENABLED', issue: 'PROVIDER_NOT_DISABLED',
    mutate: value => { value.vars.COACH_REAL_PROVIDER_ENABLED = 'true'; },
    witness: value => value.vars.COACH_REAL_PROVIDER_ENABLED === 'true' },
  { name: 'BUDGET_POSITIVE', issue: 'BUDGET_NOT_ZERO',
    mutate: value => { value.vars.COACH_REAL_DAILY_UNITS = '1'; },
    witness: value => value.vars.COACH_REAL_DAILY_UNITS === '1' },
  { name: 'CUSTOM_ROUTE_ADDED', issue: 'CUSTOM_ROUTE_INTRODUCED',
    mutate: value => { value.routes = [{ pattern: 'example.invalid/*' }]; },
    witness: value => value.routes?.[0]?.pattern === 'example.invalid/*' },
  { name: 'PREVIEW_URLS_ENABLED', issue: 'PREVIEW_URLS_ENABLED',
    mutate: value => { value.preview_urls = true; }, witness: value => value.preview_urls === true },
];

for (const mutation of mutations) for (const eol of ['\n', '\r\n']) {
  test(`C1K P2A ingress config mutation ${mutation.name} ${eol === '\n' ? 'LF' : 'CRLF'}`, () => {
    const mutated = structuredClone(config);
    const rollout = structuredClone(EXTERNAL_ROLLOUT_STATE);
    mutation.mutate?.(mutated);
    mutation.mutateRollout?.(rollout);
    const parsed = JSON.parse(JSON.stringify(mutated, null, 2).replace(/\n/g, eol));
    assert.equal(mutation.witness(parsed, rollout), true, 'the intended broken config or rollout state executed');
    const found = violations(parsed, rollout);
    assert.ok(found.includes(mutation.issue), `${mutation.issue} was not detected: ${found.join(', ')}`);
    assert.throws(() => assert.deepEqual(found, []), { code: 'ERR_ASSERTION', name: 'AssertionError' });
  });
}

assert.equal(mutations.length, 13);
