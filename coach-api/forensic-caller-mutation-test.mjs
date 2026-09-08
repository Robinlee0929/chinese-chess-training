import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import * as implementation from './prelive/forensic-caller.js';
import * as readerImplementation from './prelive/forensic-reader.js';

const SOURCE_URL = new URL('./prelive/forensic-caller.js', import.meta.url);
const READER_SOURCE_URL = new URL('./prelive/forensic-reader.js', import.meta.url);
const ORIGIN = 'https://chinese-chess-coach-forensic-staging.robinlee700929.workers.dev';
const EMAIL = 'robinlee700929@gmail.com';
const AUDIENCE = 'synthetic-forensic-audience';
const snapshot = { version: 1,
  schema: { tablesPresent: { coach_days: true, coach_reservations: true, coach_slot: true,
    coach_recovery: true, coach_one_shot: true }, consistencyStatus: 'VALID' },
  raw: { oneShot: { rowPresent: true, state: 'DISARMED' }, slot: { rowPresent: true, ownerGeneration: null },
    recovery: { rowPresent: true, state: 'NORMAL', ownerGeneration: null }, budgetRows: [], reservations: [] },
  derived: { recoveryRequired: false, recoveryReason: 'NONE', accountingConsistency: 'CONSISTENT',
    attempted: 'UNKNOWN', providerFetchStarted: 'UNKNOWN', upstreamDelivery: 'UNKNOWN',
    transitionTimestamp: 'NOT_AVAILABLE', lastTransitionKind: 'NOT_AVAILABLE' },
  completeness: { truncated: false, budgetRows: 0, reservations: 0, readComplete: true } };

async function variant(target, before, after, useCRLF) {
  let source = (await readFile(target === 'reader' ? READER_SOURCE_URL : SOURCE_URL, 'utf8')).replace(/\r\n/gu, '\n');
  const replacements = Array.isArray(before) ? before.map((value, index) => [value, after[index]]) : [[before, after]];
  for (const [from, to] of replacements) {
    assert.equal(source.split(from).length, 2, `exactly one mutation site: ${from}`);
    source = source.replace(from, to);
  }
  if (useCRLF) source = source.replace(/\n/gu, '\r\n');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
}

async function observe(module, scenario = {}) {
  const state = { calls: Object.create(null), identities: [], args: [], reads: [], leaked: false };
  const called = name => { state.calls[name] = (state.calls[name] ?? 0) + 1; };
  const stub = {
    async forensicSnapshot(...args) { called('forensicSnapshot'); state.args.push(args);
      if (scenario.reject) throw new Error('PRIVATE_STACK_SENTINEL'); return scenario.value ?? JSON.stringify(snapshot); },
    async execute() { called('execute'); return JSON.stringify(snapshot); },
    async accessOperator(action) { called(action); return '{}'; }, async recover() { called('recover'); },
    async clearRecovery() { called('clearRecovery'); }, async reserve() { called('reserve'); },
  };
  const target = { COACH_FORENSIC_ACCESS_AUD: AUDIENCE, COACH_REAL_FORENSICS: stub,
    OPENAI_API_KEY: 'PRIVATE_SECRET_SENTINEL', COACH_PROVIDER: { execute: async () => called('provider') },
    COACH_REAL_RATE_LIMITER: { limit: async () => { called('rate'); return { success: true }; } },
    CALLER_KV: { put: async () => called('storage') } };
  const env = new Proxy(target, { get(object, key, receiver) { state.reads.push(String(key)); return Reflect.get(object, key, receiver); } });
  const ctx = scenario.unauthenticated ? {} : { access: { aud: scenario.audience ?? AUDIENCE,
    getIdentity: async () => ({ email: scenario.email ?? EMAIL }) } };
  const headers = { Origin: scenario.origin ?? ORIGIN, ...(scenario.headers ?? {}) };
  const path = scenario.path ?? '/__operator/forensics';
  const response = await module.createForensicCaller()(new Request(`${ORIGIN}${path}`,
    { method: scenario.method ?? 'POST', headers, body: scenario.body }), env, ctx);
  const text = await response.text(); state.leaked = text.includes('PRIVATE_STACK_SENTINEL');
  return { status: response.status, calls: state.calls, identities: state.identities, args: state.args,
    reads: state.reads, leaked: state.leaked };
}

async function observeReader(module) {
  const identities = [];
  const reader = module.createForensicReader({ COACH_REAL_COORDINATOR: { getByName(name) {
    identities.push(name); return { forensicSnapshot: async () => JSON.stringify(snapshot) };
  } } });
  try { await reader.forensicSnapshot('client-selected'); } catch {}
  return { selected: identities[0] ?? null };
}

const calls = (state, name) => state.calls[name] ?? 0;
const gates = [
  { name: 'trust raw email header', before: '|| identity.email !== EXPECTED_OPERATOR_EMAIL) return failure();',
    after: "|| (request.headers.get('X-User-Email') ?? identity.email) !== EXPECTED_OPERATOR_EMAIL) return failure();",
    scenario: { email: 'other@example.invalid', headers: { 'X-User-Email': EMAIL } }, observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'skip audience validation', before: '|| access.aud !== env.COACH_FORENSIC_ACCESS_AUD', after: '|| false',
    scenario: { audience: 'wrong' }, observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'allow wrong email', before: '|| identity.email !== EXPECTED_OPERATOR_EMAIL) return failure();', after: '|| false) return failure();',
    scenario: { email: 'other@example.invalid' }, observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'bypass origin restriction', before: "if (url.origin !== FORENSIC_ORIGIN || request.headers.get('Origin') !== FORENSIC_ORIGIN) return failure();",
    after: 'if (false) return failure();', scenario: { origin: 'https://foreign.invalid' }, observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'allow GET', before: "request.method !== 'POST'", after: 'false', scenario: { method: 'GET' },
    observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'allow arbitrary action field', before: '|| !await emptyBody(request, clock)', after: '|| false',
    scenario: { body: '{"action":"execute"}' }, observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'allow client object identity', target: 'reader',
    before: ["      if (args.length) throw new Error('Forensic arguments denied');", 'namespace.getByName(FORENSIC_COORDINATOR_NAME)'],
    after: ['', 'namespace.getByName(args[0])'], reader: true, observe: state => state.selected, good: null, bad: 'client-selected' },
  { name: 'forward caller RPC args', before: 'service.forensicSnapshot()', after: 'service.forensicSnapshot({ request })',
    observe: state => state.args[0]?.length ?? 0, good: 0, bad: 1 },
  { name: 'call generic method', before: 'service.forensicSnapshot()', after: "service[request.headers.get('X-RPC-Method')]()",
    scenario: { headers: { 'X-RPC-Method': 'execute' } }, observe: state => calls(state, 'execute'), good: 0, bad: 1 },
  { name: 'call execute instead of forensicSnapshot', before: 'service.forensicSnapshot()', after: 'service.execute()',
    observe: state => calls(state, 'execute'), good: 0, bad: 1 },
  { name: 'read provider secret', before: '      const service = env?.COACH_REAL_FORENSICS;',
    after: '      void env.OPENAI_API_KEY;\n      const service = env?.COACH_REAL_FORENSICS;',
    observe: state => state.reads.includes('OPENAI_API_KEY'), good: false, bad: true },
  { name: 'invoke provider capability', before: '      const service = env?.COACH_REAL_FORENSICS;',
    after: '      await env.COACH_PROVIDER.execute();\n      const service = env?.COACH_REAL_FORENSICS;',
    observe: state => calls(state, 'provider'), good: 0, bad: 1 },
  { name: 'invoke rate limiter', before: '      const service = env?.COACH_REAL_FORENSICS;',
    after: '      await env.COACH_REAL_RATE_LIMITER.limit();\n      const service = env?.COACH_REAL_FORENSICS;',
    observe: state => calls(state, 'rate'), good: 0, bad: 1 },
  { name: 'automatic retry once', before: 'const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    after: 'const outcome = await singleAttempt(async () => { try { return await service.forensicSnapshot(); } catch { return service.forensicSnapshot(); } }, clock, SNAPSHOT_TIMEOUT_MS);',
    scenario: { reject: true }, observe: state => calls(state, 'forensicSnapshot'), good: 1, bad: 2 },
  { name: 'poll snapshot', before: '      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    after: '      await service.forensicSnapshot();\n      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    observe: state => calls(state, 'forensicSnapshot'), good: 1, bad: 2 },
  { name: 'expose raw exception stack',
    before: ["Promise.resolve(operation()).then(value => finish('success', value), () => finish('error'));",
      "if (outcome.kind !== 'success') return failure(503);"],
    after: ["Promise.resolve(operation()).then(value => finish('success', value), error => finish('error', error));",
      "if (outcome.kind !== 'success') return Response.json({ error: outcome.value.stack }, { status: 503 });"], scenario: { reject: true },
    observe: state => state.leaked, good: false, bad: true },
  { name: 'allow extra output keys', before: 'return actual.length === keys.length && actual.every(key => keys.includes(key));',
    after: 'return actual.every(key => keys.includes(key) || key === \'secret\');', scenario: { value: JSON.stringify({ ...snapshot, secret: 'PRIVATE' }) },
    observe: state => state.status, good: 503, bad: 200 },
  { name: 'invoke binding before authorization', before: '      const url = new URL(request.url);',
    after: '      await env.COACH_REAL_FORENSICS.forensicSnapshot();\n      const url = new URL(request.url);',
    scenario: { unauthenticated: true }, observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'invoke recovery mutation', before: '      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    after: '      await service.recover();\n      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    observe: state => calls(state, 'recover'), good: 0, bad: 1 },
  { name: 'invoke budget mutation', before: '      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    after: '      await service.reserve();\n      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    observe: state => calls(state, 'reserve'), good: 0, bad: 1 },
  { name: 'expose ARM', before: '      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    after: "      await service.accessOperator('arm', {});\n      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);",
    observe: state => calls(state, 'arm'), good: 0, bad: 1 },
  { name: 'expose DISPATCH', before: '      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);',
    after: "      await service.accessOperator('dispatch', {});\n      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);",
    observe: state => calls(state, 'dispatch'), good: 0, bad: 1 },
  { name: 'add caller persistent storage use', before: '      const service = env?.COACH_REAL_FORENSICS;',
    after: "      await env.CALLER_KV.put('retry', '1');\n      const service = env?.COACH_REAL_FORENSICS;",
    observe: state => calls(state, 'storage'), good: 0, bad: 1 },
];

for (const [index, gate] of gates.entries()) test(`C1K P2B viable mutation ${gate.name}`, async () => {
  const invariant = value => assert.deepEqual(value, gate.good);
  const baseline = gate.observe(gate.reader ? await observeReader(readerImplementation) : await observe(implementation, gate.scenario));
  invariant(baseline);
  // The transform canonicalizes either LF or CRLF before exact replacement, then
  // alternates emitted endings. Each viable gate therefore executes exactly once.
  const mutant = await variant(gate.target ?? 'caller', gate.before, gate.after, index % 2 === 1);
  const broken = gate.observe(gate.reader ? await observeReader(mutant) : await observe(mutant, gate.scenario));
  assert.deepEqual(broken, gate.bad, 'the intended semantic defect must execute');
  assert.throws(() => invariant(broken), { name: 'AssertionError', code: 'ERR_ASSERTION' });
});

assert.equal(gates.length, 23);
