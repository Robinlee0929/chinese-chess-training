import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import fakeWorker from './src/index.js';
import './prelive-access-runtime-test.mjs';
import * as access from './prelive/access-operator.js';
import { modules, sqliteStorage, response, input, request, variant } from './prelive-test-support.mjs';

const origin = 'https://operator.example.invalid';
const identity = { email: 'operator@example.invalid' };
const context = () => ({ access: { aud: 'synthetic-audience', getIdentity: async () => identity } });
const implementation = { ...modules, 'access-operator': access };

test('C1F fake staging has no operator routes and retains public fake behavior', async () => {
  for (const action of ['arm', 'dispatch']) {
    const r = await fakeWorker.fetch(request({ path: `/__operator/one-shot/${action}` }), { COACH_FAKE_ENABLED: 'true' }, context());
    assert.equal(r.status, 404);
  }
  assert.equal((await fakeWorker.fetch(request(), { COACH_FAKE_ENABLED: 'true' }, context())).status, 200);
});
test('C1F committed configuration has no Access simulation or live authority', async () => {
  const config = JSON.parse(await readFile(new URL('./wrangler.real-prelive.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.access, undefined);
  for (const key of ['COACH_OPERATOR_ACCESS_AUD', 'COACH_OPERATOR_EMAIL', 'COACH_OPERATOR_ORIGIN',
    'OPENAI_API_KEY', 'COACH_REAL_PROVIDER_PUBLIC_ENABLED']) assert.equal(config.vars[key], undefined);
  assert.equal(config.vars.COACH_REAL_PROVIDER_ENABLED, 'false');
  assert.equal(config.vars.COACH_REAL_DAILY_UNITS, '0');
});
function fixture(m = implementation, overrides = {}) {
  const storage = sqliteStorage();
  const state = { calls: 0, requests: [], inputs: [] };
  const env = { COACH_OPERATOR_ACCESS_AUD: 'synthetic-audience', COACH_OPERATOR_EMAIL: identity.email,
    COACH_OPERATOR_ORIGIN: origin, COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_DAILY_UNITS: '20',
    OPENAI_API_KEY: 'C1F_SYNTHETIC_ONLY', COACH_REAL_RATE_LIMITER: { limit: async () => ({ success: true }) }, ...overrides };
  const core = m.coordinator.createCoordinator(storage, env, { fetch: async (url, options) => {
    state.calls++; state.requests.push({ url, ...options, body: JSON.parse(options.body) }); return response();
  } });
  env.COACH_REAL_COORDINATOR = { getByName(name) {
    assert.equal(name, 'review-coach-real-provider-global-v1');
    return { execute: async value => JSON.stringify(await core.execute(value)),
      accessOperator: async (action, claim) => JSON.stringify(await m['access-operator'].executeAccessOperator(storage, env,
        value => { state.inputs.push(value); return core.execute(value); }, action, claim)) };
  } };
  const send = (action, options = {}, ctx = context()) => m.outer.default.fetch(new Request(`${origin}/__operator/one-shot/${action}`, {
    method: 'POST', headers: { Origin: origin }, ...options,
  }), env, ctx);
  return { env, state, storage, send, close: () => storage.db.close() };
}

async function deniedCase(m, { action = 'arm', options = {}, ctx = context(), overrides = {} } = {}) {
  const h = fixture(m, overrides);
  try {
    if (action === 'dispatch') await h.send('arm');
    const before = h.storage.sql.exec('SELECT state FROM coach_one_shot').toArray()[0].state;
    const result = await h.send(action, options, ctx);
    assert.equal(h.storage.sql.exec('SELECT state FROM coach_one_shot').toArray()[0].state,
      before, 'denied request cannot mutate one-shot');
    assert.equal(result.status, 403, 'operator request denied');
    assert.deepEqual(await result.json(), { status: 'denied' });
    assert.equal(h.state.calls, 0, 'no provider dispatch');
  } finally { h.close(); }
}
const bad = [
  ['missing context', { ctx: {} }],
  ['null identity', { ctx: { access: { aud: 'synthetic-audience', getIdentity: async () => null } } }],
  ['identity error', { ctx: { access: { aud: 'synthetic-audience', getIdentity: async () => { throw Error('PRIVATE'); } } } }],
  ['malformed identity', { ctx: { access: { aud: 'synthetic-audience', getIdentity: async () => ({ email: [] }) } } }],
  ['wrong identity', { ctx: { access: { aud: 'synthetic-audience', getIdentity: async () => ({ email: 'other@example.invalid' }) } } }],
  ['wrong audience', { ctx: { access: { aud: 'wrong', getIdentity: async () => identity } } }],
  ['missing audience policy', { overrides: { COACH_OPERATOR_ACCESS_AUD: undefined } }],
  ['missing identity policy', { overrides: { COACH_OPERATOR_EMAIL: undefined } }],
  ['missing origin policy', { overrides: { COACH_OPERATOR_ORIGIN: undefined } }],
  ['GET', { options: { method: 'GET' } }],
  ['OPTIONS', { options: { method: 'OPTIONS' } }],
  ['foreign origin', { options: { headers: { Origin: 'https://foreign.invalid' } } }],
  ['missing origin', { options: { headers: {} } }],
  ['body', { options: { body: '{}' } }],
  ['quality body', { options: { body: '{"modelProfile":"quality"}' } }],
  ['prompt body', { options: { body: '{"prompt":"private prompt"}' } }],
  ['query', { action: 'arm?aud=synthetic-audience&email=operator@example.invalid' }],
  ['spoofed email', { ctx: {}, options: { headers: { Origin: origin, 'Cf-Access-Authenticated-User-Email': identity.email } } }],
  ['static token', { ctx: {}, options: { headers: { Origin: origin, 'X-Admin-Key': 'synthetic-token' } } }],
];
for (const [label, scenario] of bad) for (const action of ['arm', 'dispatch']) {
  test(`C1F ${action} denies ${label}`, () => deniedCase(implementation, { action, ...scenario }));
}

async function endToEnd(m) {
  const h = fixture(m);
  try {
    const disarmed = await h.send('dispatch');
    assert.equal(h.state.calls, 0, 'Access alone does not dispatch');
    assert.equal(disarmed.status, 403);
    assert.equal((await h.send('arm')).status, 200);
    assert.equal(h.state.calls, 0, 'ARM does not dispatch');
    const replies = await Promise.all([h.send('dispatch'), h.send('dispatch')]);
    assert.equal(replies.filter(r => r.status === 200).length, 1);
    assert.equal(h.state.calls, 1, 'one dispatch');
    await h.send('arm'); await h.send('dispatch');
    assert.equal(h.state.calls, 1, 'replay cannot dispatch');
    assert.equal(h.state.requests[0].body.model, 'gpt-5.6-luna');
    assert.equal(JSON.stringify(h.state.requests).includes(identity.email), false, 'identity not sent to provider');
    assert.equal(h.state.requests[0].body.input, input().purpose);
  } finally { h.close(); }
}
test('C1F Access ARM / concurrent DISPATCH / replay end-to-end', () => endToEnd(implementation));

const gates = [
  ['enable', { COACH_REAL_PROVIDER_ENABLED: 'false' }],
  ['secret', { OPENAI_API_KEY: undefined }],
  ['budget', { COACH_REAL_DAILY_UNITS: '0' }],
  ['rate', { COACH_REAL_RATE_LIMITER: { limit: async () => ({ success: false }) } }],
];
async function prerequisite(m, overrides = {}, recovery = false) {
  const h = fixture(m, overrides);
  try {
    if (recovery) h.storage.sql.exec("UPDATE coach_recovery SET state = 'RECOVERY_REQUIRED'");
    assert.equal((await h.send('arm')).status, 200);
    await h.send('dispatch');
    assert.equal(h.state.calls, 0, 'prerequisite prevents provider');
  } finally { h.close(); }
}
for (const [label, overrides] of gates) test(`C1F does not bypass ${label}`, () => prerequisite(implementation, overrides));
test('C1F does not bypass recovery', () => prerequisite(implementation, {}, true));

async function publicDenied(m) {
  const h = fixture(m);
  try {
    await h.send('arm');
    const r = await m.outer.default.fetch(request(), h.env, context());
    assert.equal(h.state.calls, 0, 'public traffic cannot dispatch provider');
    assert.equal(r.status, 503, 'public path remains disabled');
    assert.equal(await r.text(), ''); assert.equal(h.state.calls, 0);
  } finally { h.close(); }
}
test('C1F Access authenticated public coach remains disabled', () => publicDenied(implementation));

test('C1F stalled identity lookup is bounded and cannot mutate', () => deniedCase(implementation,
  { ctx: { access: { aud: 'synthetic-audience', getIdentity: () => new Promise(() => {}) } } }));
test('C1F malformed server identity policy fails closed', () => deniedCase(implementation,
  { overrides: { COACH_OPERATOR_EMAIL: 'not-an-email' } }));

for (const kind of ['occupied concurrency', 'exhausted budget', 'missing coordinator']) {
  test(`C1F transport cannot bypass ${kind}`, async () => {
    const h = fixture();
    try {
      await h.send('arm');
      if (kind === 'occupied concurrency') h.storage.sql.exec('UPDATE coach_slot SET owner = 999');
      if (kind === 'exhausted budget') h.storage.sql.exec('INSERT INTO coach_days (day, units) VALUES (?, 20)', new Date().toISOString().slice(0, 10));
      if (kind === 'missing coordinator') h.env.COACH_REAL_COORDINATOR = undefined;
      assert.notEqual((await h.send('dispatch')).status, 200);
      assert.equal(h.state.calls, 0);
    } finally { h.close(); }
  });
}
test('C1F operator replies cannot relay private binding diagnostics', async () => {
  const h = fixture();
  try {
    h.env.COACH_REAL_COORDINATOR = { getByName: () => ({ accessOperator: async () => JSON.stringify({
      status: 'armed', email: identity.email, secret: 'PRIVATE', prompt: 'PRIVATE', budget: 99,
    }) }) };
    const r = await h.send('arm');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await r.json(), { status: 'armed' });
  } finally { h.close(); }
});

async function clientInputDenied(m, field, value) {
  const h = fixture(m);
  try {
    await h.send('arm');
    await h.send('dispatch', { body: JSON.stringify({ [field]: value }) });
    // Witness the exact attempted override before asserting the invariant.
    if (h.state.inputs.length) {
      assert.equal(h.state.inputs[0][field === 'prompt' ? 'purpose' : field], value, 'intended override reached coordinator');
      if (field === 'modelProfile') assert.equal(h.state.requests[0].body.model, 'gpt-5.6-sol', 'quality reached mocked provider');
    }
    assert.equal(h.state.inputs.length, 0, 'client policy never reaches coordinator');
  } finally { h.close(); }
}
for (const [field, value] of [['modelProfile', 'quality'], ['prompt', 'private prompt']]) {
  test(`C1F client ${field} cannot reach coordinator`, () => clientInputDenied(implementation, field, value));
}

// Each gate imports an executable mutant, then requires its intended behavioral
// assertion to fail. No syntax/setup error is accepted as a mutation kill.
const mutations = [
  ['missing Access', 'access-operator', 'const access = ctx?.access;', 'const access = ctx?.access ?? { aud: env.COACH_OPERATOR_ACCESS_AUD, getIdentity: async () => ({ email: env.COACH_OPERATOR_EMAIL }) };', m => deniedCase(m, { ctx: {} })],
  ['raw email', 'access-operator', 'email: identity?.email', "email: request.headers.get('Cf-Access-Authenticated-User-Email') ?? identity?.email", m => deniedCase(m, { ctx: { access: { aud: 'synthetic-audience', getIdentity: async () => ({ email: 'other@example.invalid' }) } }, options: { headers: { Origin: origin, 'Cf-Access-Authenticated-User-Email': identity.email } } })],
  ['wrong identity', 'access-operator', 'claim?.email === env.COACH_OPERATOR_EMAIL', 'typeof claim?.email === \'string\'', m => deniedCase(m, bad[4][1])],
  ['client audience', 'access-operator', 'aud: access.aud', "aud: request.headers.get('X-Audience') ?? access.aud", m => deniedCase(m, { ...bad[5][1], options: { headers: { Origin: origin, 'X-Audience': 'synthetic-audience' } } })],
  ...['arm', 'dispatch'].map(action => [`GET ${action}`, 'access-operator', "request.method !== 'POST'", "!['POST', 'GET'].includes(request.method)", m => deniedCase(m, { action, options: { method: 'GET' } })]),
  ...['arm', 'dispatch'].map(action => [`foreign Origin ${action}`, 'access-operator', "request.headers.get('Origin') !== origin", 'false', m => deniedCase(m, { action, options: { headers: { Origin: 'https://foreign.invalid' } } })]),
  ['ARM dispatch', 'access-operator', ['requested === action && operatorClaimAllowed(env, claim)', 'return operator[action]();'], ['operatorClaimAllowed(env, claim)', "const result = await operator[action](); if (action === 'arm') await operator.dispatch(); return result;"], endToEnd],
  ['public routing', 'outer', ["new URL(request.url).pathname.startsWith('/__operator/')", 'accessOperatorResponse(request, env, ctx)'], ['true', "accessOperatorResponse(new URL(request.url).pathname === '/api/review-coach' ? new Request(env.COACH_OPERATOR_ORIGIN + '/__operator/one-shot/dispatch', { method: 'POST', headers: { Origin: env.COACH_OPERATOR_ORIGIN } }) : request, env, ctx)"], publicDenied],
  ['Access alone', 'operator-dispatch', 'if (!await consume()) return denied();', 'await consume();', endToEnd],
  ['secret bypass', 'policy', "const key = env?.OPENAI_API_KEY;", "const key = env?.OPENAI_API_KEY ?? 'MUTANT_SYNTHETIC';", m => prerequisite(m, gates[1][1])],
  ['budget bypass', 'policy', 'if (limit === 0) return null;', 'if (limit === 0) return 20;', m => prerequisite(m, gates[2][1])],
  ['rate bypass', 'policy', "result?.success === true ? 'allowed'", "true ? 'allowed'", m => prerequisite(m, gates[3][1])],
  ['enable bypass', 'policy', "env?.COACH_REAL_PROVIDER_ENABLED === 'true'", "true", m => prerequisite(m, gates[0][1])],
  ['recovery bypass', 'budget', "if (sql.exec('SELECT state FROM coach_recovery WHERE singleton = 1').toArray()[0].state === 'RECOVERY_REQUIRED') return false;", '', m => prerequisite(m, {}, true)],
  ['replay', 'operator-dispatch', "state = 'DISARMED' RETURNING id", "state IN ('DISARMED', 'CONSUMED') RETURNING id", endToEnd],
  ...[['modelProfile', 'quality'], ['prompt', 'private prompt']].map(([field, value]) => [
    `${field} forwarding`, 'access-operator', ['request.body !== null', 'email: identity?.email', 'operatorClaimAllowed(env, claim), execute,'],
    ['false', "email: identity?.email, client: request.body ? await request.json() : {}", `operatorClaimAllowed(env, claim), execute: value => execute({ ...value, ${field === 'prompt' ? 'purpose' : field}: claim.client?.${field} ?? value.${field === 'prompt' ? 'purpose' : field} }),`],
    m => clientInputDenied(m, field, value)]),
  ['static fallback', 'access-operator', 'const access = ctx?.access;', "const access = ctx?.access ?? (request.headers.has('X-Admin-Key') ? { aud: env.COACH_OPERATOR_ACCESS_AUD, getIdentity: async () => ({ email: env.COACH_OPERATOR_EMAIL }) } : undefined);", m => deniedCase(m, bad[18][1])],
  ['identity input', 'coordinator', 'return fetchImpl(url, options);', 'return fetchImpl(url, { ...options, body: JSON.stringify({ ...JSON.parse(options.body), input: env.COACH_OPERATOR_EMAIL }) });', endToEnd],
];
for (const [label, target, before, after, verify] of mutations) for (const eol of ['\n', '\r\n']) {
  test(`C1F mutation ${label} ${JSON.stringify(eol)}`, async () => {
    await verify(implementation);
    const m = await variant(target, before, after, eol);
    const expected = label === 'public routing' ? 'public traffic cannot dispatch provider'
      : label === 'identity input' ? 'identity not sent to provider'
      : label.endsWith('forwarding') ? 'client policy never reaches coordinator'
      : label.includes('bypass') ? 'prerequisite prevents provider'
      : label === 'ARM dispatch' ? 'ARM does not dispatch'
      : label === 'Access alone' ? 'Access alone does not dispatch'
      : label === 'replay' ? 'replay cannot dispatch' : 'denied request cannot mutate one-shot';
    await assert.rejects(() => verify(m), error => error?.code === 'ERR_ASSERTION'
      && (!expected || error.message.includes(expected)), 'intended behavioral assertion must kill mutant');
  });
}
