import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import * as outer from './prelive/outer.js';
import * as coordinator from './prelive/coordinator.js';
import * as budget from './prelive/budget.js';
import * as policy from './prelive/policy.js';
import { purposeFor } from './src/rule-policy.js';
import { FakeClock, deferred, flush, payload, request } from './test-support.mjs';
export { deferred, flush, payload, request };

export const SENTINEL = 'C1C_SYNTHETIC_NOT_A_REAL_KEY';
export const framing = { leadIn: '請慢慢看看提示。', encouragement: '相信自己，繼續學習。' };
export const modules = { outer, coordinator, budget, policy };
export const input = (profile = 'economy') => ({ sourceRuleId: 'check-difference', locale: 'zh-Hant',
  style: 'child-neutral-teacher-v1', modelProfile: profile, purpose: purposeFor('check-difference') });

export function response(text = JSON.stringify(framing), status = 200) {
  return new Response(JSON.stringify({ object: 'response', status: 'completed', error: null,
    incomplete_details: null, usage: { total_tokens: 0, refund: true }, output: [{ type: 'message',
      role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] }), { status });
}

// Real SQLite queries/transactions; state never lives in a JS budget or concurrency counter.
export function sqliteStorage(db = new DatabaseSync(':memory:')) {
  const storage = {
    db,
    sql: { exec(query, ...args) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...args).map((row) => ({ ...row })) : (statement.run(...args), []);
      return { toArray: () => rows };
    } },
    transactionSync(callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const value = callback(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    sync: async () => {},
  };
  return storage;
}

export function harness(implementation = modules, overrides = {}) {
  const clock = new FakeClock();
  const state = { calls: 0, active: 0, maximum: 0, aborts: 0, rateCalls: 0, identities: [], requests: [],
    date: Date.UTC(2026, 8, 6, 12), fetch: null };
  // C1C/C1D regression fixture explicitly models a FUTURE authorized public phase.
  // C1E tests override this to absent/false; committed configuration never enables it.
  const env = { COACH_REAL_PROVIDER_PUBLIC_ENABLED: 'true', COACH_REAL_PROVIDER_ENABLED: 'true', COACH_REAL_DAILY_UNITS: '20', OPENAI_API_KEY: SENTINEL,
    COACH_REAL_RATE_LIMITER: { limit: async () => { state.rateCalls++; return { success: true }; } }, ...overrides };
  const instances = new Map(); // Namespace routing only; all authority is in each SQLite database.
  function instance(name) {
    if (!instances.has(name)) {
      const storage = sqliteStorage();
      instances.set(name, { storage, core: null });
    }
    const entry = instances.get(name);
    if (!entry.core) entry.core = implementation.coordinator.createCoordinator(entry.storage, env, {
      clock, utcNow: () => state.date,
      fetch: async (url, options) => {
        state.calls++; state.active++; state.maximum = Math.max(state.maximum, state.active);
        state.requests.push({ url, ...options, body: JSON.parse(options.body) });
        options.signal.addEventListener('abort', () => state.aborts++, { once: true });
        try { return state.fetch ? await state.fetch(url, options) : response(); }
        finally { state.active--; }
      },
    });
    return entry;
  }
  const namespace = { getByName(name) {
    state.identities.push(name);
    return { execute: async (value) => JSON.stringify(await instance(name).core.execute(value)) };
  } };
  if (!Object.hasOwn(overrides, 'COACH_REAL_COORDINATOR')) env.COACH_REAL_COORDINATOR = namespace;
  const call = (profile = 'economy', extra = {}, outerEnv = env) => {
    // A freshly constructed outer handler and env represent independent Worker contexts.
    const handle = implementation.outer.createRealStagingHandler({ ...outerEnv }, { clock });
    return handle(request({ data: payload({ modelProfile: profile, ...extra }) }));
  };
  return { state, env, clock, call, instance,
    restart() { for (const entry of instances.values()) entry.core = null; },
    rows(table) { return instance(policy.COORDINATOR_NAME).storage.sql.exec(`SELECT * FROM ${table}`).toArray(); },
    close() { for (const entry of instances.values()) entry.storage.db.close(); },
  };
}

export async function variant(target, before, after, eol) {
  const loaded = {};
  const urls = {};
  for (const name of ['policy', 'budget', 'operator-dispatch', 'access-operator', 'coordinator', 'outer']) {
    let source = (await readFile(new URL(`./prelive/${name}.js`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    if (name === target) {
      const replacements = Array.isArray(before) ? before.map((text, i) => [text, after[i]]) : [[before, after]];
      for (const [from, to] of replacements) {
        assert.equal(source.split(from).length, 2, 'exactly one mutation site');
        source = source.replace(from, to);
      }
    }
    source = source.replace(/from '(\.[^']+)'/g, (_match, relative) => {
      const dependency = relative.match(/^\.\/(.*)\.js$/)?.[1];
      return `from '${urls[dependency] ?? new URL(relative, new URL('./prelive/', import.meta.url)).href}'`;
    }).replace(/\n/g, eol);
    urls[name] = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`;
    loaded[name] = await import(urls[name]);
  }
  return loaded;
}
