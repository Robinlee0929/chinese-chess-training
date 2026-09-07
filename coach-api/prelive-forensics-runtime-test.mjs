import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const fixture of [
  { name: 'owned started incident', state: 'started', owner: true, terminated: 0 },
  { name: 'orphaned started incident', state: 'started', owner: false, terminated: 0 },
  { name: 'orphaned dispatch intent', state: 'dispatching', owner: false, terminated: 0 },
  { name: 'orphaned terminated awaiting finalize', state: 'started', owner: false, terminated: 1 },
]) test(`C1J actual workerd existing SQLite reopen -> production constructor -> forensic RPC: ${fixture.name}`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coach-c1j-runtime-'));
  const dumpSource = `function dump(storage) {
    return storage.sql.exec("SELECT name, sql FROM sqlite_master ORDER BY name").toArray().map(row => ({ ...row,
      rows: row.sql?.startsWith('CREATE TABLE') ? storage.sql.exec('SELECT * FROM "' + row.name + '" ORDER BY rowid').toArray() : [] }));
  }`;
  const seedSource = `
    import { DurableObject } from 'cloudflare:workers';
    import { provisionCoordinator, INITIAL_PROVISIONING } from './prelive/provision.js';
    ${dumpSource}
    export class CoachRealProviderCoordinator extends DurableObject {
      async seed() {
        provisionCoordinator(this.ctx.storage, INITIAL_PROVISIONING);
        this.ctx.storage.sql.exec("UPDATE coach_one_shot SET state = 'CONSUMED'");
        this.ctx.storage.sql.exec("INSERT INTO coach_days VALUES ('2026-09-07', 1)");
        this.ctx.storage.sql.exec("INSERT INTO coach_reservations (day, units, state, terminated) VALUES ('2026-09-07', 1, ?, ?)", '${fixture.state}', ${fixture.terminated});
        ${fixture.owner ? `this.ctx.storage.sql.exec('UPDATE coach_slot SET owner = 1');
        this.ctx.storage.sql.exec("UPDATE coach_recovery SET owner = 1, state = 'ACTIVE_PROVIDER'");` : ''}
        await this.ctx.storage.sync(); return JSON.stringify(dump(this.ctx.storage));
      }
    }
    export default { async fetch(request, env) { return new Response(await env.COACH_REAL_COORDINATOR.getByName('review-coach-real-provider-global-v1').seed()); } };
  `;
  const readSource = `
    import worker, { CoachRealProviderCoordinator as Production } from './prelive/worker.js';
    ${dumpSource}
    const counters = new WeakMap();
    export class CoachRealProviderCoordinator extends Production {
      constructor(ctx, env) {
        const counts = { writes: 0, secretReads: 0 };
        const sql = ctx.storage.sql;
        const originalExec = sql.exec.bind(sql);
        sql.exec = (query, ...args) => {
          if (!/^\\s*SELECT\\b/i.test(query)) { counts.writes++; throw new Error('WRITE ATTEMPT'); }
          return originalExec(query, ...args);
        };
        for (const key of ['put', 'delete', 'deleteAll', 'setAlarm', 'deleteAlarm', 'onNextSessionRestoreBookmark', 'transaction', 'transactionSync'])
          ctx.storage[key] = () => { counts.writes++; throw new Error('WRITE ATTEMPT'); };
        super(ctx, new Proxy(env, { get() { counts.secretReads++; throw new Error('ENV READ'); } }));
        counters.set(this, counts);
      }
      async inspectTestOnly() {
        const before = dump(this.ctx.storage);
        const snapshots = await Promise.all([this.forensicSnapshot(), this.forensicSnapshot()]);
        let denied = false; try { await this.forensicSnapshot({ object: 'client', initialize: true }); } catch { denied = true; }
        return JSON.stringify({ before, after: dump(this.ctx.storage), snapshots, counts: counters.get(this), denied });
      }
    }
    export default { async fetch(request, env, ctx) {
      if (new URL(request.url).pathname === '/__test/snapshot') return new Response(await env.COACH_REAL_COORDINATOR.getByName('review-coach-real-provider-global-v1').inspectTestOnly());
      return worker.fetch(request, env, ctx);
    } };
  `;
  let runtime; let calls = 0;
  async function boot(contents) {
    const output = await build({ stdin: { contents, resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
      bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], write: false });
    return new Miniflare({ ...convertV4MiniflareOptions({ name: 'c1j-local-runtime', modules: true, script: output.outputFiles[0].text,
      compatibilityDate: '2026-09-03', cf: false,
      bindings: { COACH_REAL_PROVIDER_ENABLED: 'false', COACH_REAL_DAILY_UNITS: '0', COACH_REAL_PROVIDER_PUBLIC_ENABLED: 'false' },
      durableObjects: { COACH_REAL_COORDINATOR: { className: 'CoachRealProviderCoordinator', useSQLite: true, unsafeUniqueKey: 'c1j-local-existing-only' } },
      outboundService: () => { calls++; return new Response(null, { status: 503 }); },
    }), resourcePersistencePath: directory, telemetry: { enabled: false } });
  }
  try {
    runtime = await boot(seedSource);
    const seeded = await (await runtime.dispatchFetch('https://local.invalid/')).json();
    await runtime.dispose(); runtime = await boot(readSource);
    const response = await runtime.dispatchFetch('https://local.invalid/__test/snapshot');
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const result = JSON.parse(responseText);
    assert.deepEqual(result.before, seeded); assert.deepEqual(result.after, seeded);
    assert.deepEqual(result.counts, { writes: 0, secretReads: 0 }); assert.equal(result.denied, true);
    assert.deepEqual(result.snapshots[0], result.snapshots[1]);
    const snapshot = JSON.parse(result.snapshots[0]);
    assert.equal(snapshot.raw.oneShot.state, 'CONSUMED');
    assert.equal(snapshot.raw.recovery.state, fixture.owner ? 'ACTIVE_PROVIDER' : 'NORMAL');
    assert.equal(snapshot.raw.slot.ownerGeneration, fixture.owner ? 1 : null);
    assert.equal(snapshot.raw.reservations[0].state, fixture.state);
    assert.equal(snapshot.raw.reservations[0].terminated, fixture.terminated);
    assert.equal(snapshot.derived.accountingConsistency, fixture.owner ? 'CONSISTENT' : 'INVALID');
    assert.equal(snapshot.derived.recoveryRequired, true);
    const publicResult = await runtime.dispatchFetch('https://local.invalid/__operator/forensics');
    assert.equal(publicResult.status, 403); assert.equal(calls, 0);
  } finally { await runtime?.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
