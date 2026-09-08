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
    getIdentity: async () => { state.identities.push('getIdentity'); return { email: scenario.email ?? EMAIL }; } } };
  const headers = { Origin: scenario.origin ?? ORIGIN, ...(scenario.headers ?? {}) };
  const path = scenario.path ?? '/__operator/forensics';
  const response = await module.createForensicCaller()(new Request(`${ORIGIN}${path}`,
    { method: scenario.method ?? 'POST', headers, body: scenario.body }), env, ctx);
  const text = await response.text(); state.leaked = text.includes('PRIVATE_STACK_SENTINEL');
  return { status: response.status, calls: state.calls, identities: state.identities, args: state.args,
    reads: state.reads, leaked: state.leaked, text,
    contentType: response.headers.get('Content-Type'), csp: response.headers.get('Content-Security-Policy') };
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
  { name: 'allow root query', before: "url.pathname === '/' && !url.search", after: "url.pathname === '/'",
    scenario: { method: 'GET', path: '/?action=execute' }, observe: state => state.status, good: 403, bad: 200 },
  { name: 'invoke binding while rendering root page',
    before: "      if (url.origin === FORENSIC_ORIGIN && request.method === 'GET' && url.pathname === '/' && !url.search) {\n        return forensicPage();\n      }",
    after: "      if (url.origin === FORENSIC_ORIGIN && request.method === 'GET' && url.pathname === '/' && !url.search) {\n        await env.COACH_REAL_FORENSICS.forensicSnapshot();\n        return forensicPage();\n      }",
    scenario: { method: 'GET', path: '/' }, observe: state => calls(state, 'forensicSnapshot'), good: 0, bad: 1 },
  { name: 'read Access identity while rendering root page',
    before: "      if (url.origin === FORENSIC_ORIGIN && request.method === 'GET' && url.pathname === '/' && !url.search) {\n        return forensicPage();\n      }",
    after: "      if (url.origin === FORENSIC_ORIGIN && request.method === 'GET' && url.pathname === '/' && !url.search) {\n        await ctx.access.getIdentity();\n        return forensicPage();\n      }",
    scenario: { method: 'GET', path: '/' }, observe: state => state.identities.length, good: 0, bad: 1 },
  { name: 'retarget root form', before: 'action="/__operator/forensics"',
    after: 'action="/__operator/one-shot/arm"', scenario: { method: 'GET', path: '/' },
    observe: state => state.text.includes('action="/__operator/forensics"'), good: true, bad: false },
  { name: 'change root form method', before: '<form method="post" action="/__operator/forensics">',
    after: '<form method="get" action="/__operator/forensics">', scenario: { method: 'GET', path: '/' },
    observe: state => state.text.includes('<form method="post" action="/__operator/forensics">'), good: true, bad: false },
  { name: 'add successful root form control', before: '<button type="submit">Request forensic snapshot</button>',
    after: '<input type="hidden" name="action" value="execute">\n<button type="submit">Request forensic snapshot</button>',
    scenario: { method: 'GET', path: '/' },
    observe: state => (state.text.match(/<(?:button|input|select|textarea)\b[^>]*\sname\s*=/giu) ?? []).length, good: 0, bad: 1 },
  { name: 'add executable root script', before: '<body>',
    after: '<body>\n<script src="https://foreign.invalid/x.js"></script>', scenario: { method: 'GET', path: '/' },
    observe: state => /<script\b/iu.test(state.text), good: false, bad: true },
  { name: 'add automatic root form submission',
    before: ['</form>', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"],
    after: ['</form>\n<script>document.forms[0].submit()</script>',
      "default-src 'none'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"],
    scenario: { method: 'GET', path: '/' }, observe: state => /document\.forms\[0\]\.submit\(\)/u.test(state.text)
      && (state.csp?.includes("script-src 'unsafe-inline'") ?? false), good: false, bad: true },
  { name: 'remove root form-action restriction',
    before: "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    after: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", scenario: { method: 'GET', path: '/' },
    observe: state => state.csp?.includes("form-action 'self'") ?? false, good: true, bad: false },
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

for (const gate of gates) for (const [lineEnding, useCRLF] of [['LF', false], ['CRLF', true]]) {
  test(`C1K P2B viable mutation ${gate.name} ${lineEnding}`, async () => {
    const invariant = value => assert.deepEqual(value, gate.good);
    const baseline = gate.observe(gate.reader ? await observeReader(readerImplementation) : await observe(implementation, gate.scenario));
    invariant(baseline);
    const mutant = await variant(gate.target ?? 'caller', gate.before, gate.after, useCRLF);
    const broken = gate.observe(gate.reader ? await observeReader(mutant) : await observe(mutant, gate.scenario));
    assert.deepEqual(broken, gate.bad, 'the intended semantic defect must execute');
    assert.throws(() => invariant(broken), { name: 'AssertionError', code: 'ERR_ASSERTION' });
  });
}

assert.equal(gates.length, 32);
