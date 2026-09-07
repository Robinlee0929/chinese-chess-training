import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';

const source = await readFile(new URL('./prelive-sql-write-detector.mjs', import.meta.url), 'utf8');
const gateSite = '    if (!isReadOnlySQL(query)) return deny();';
const cases = [
  ['pure SELECT', 'SELECT value FROM x', false],
  ['multi SELECT', 'SELECT 1; SELECT value FROM x;', false],
  ['keyword literal', "SELECT 'UPDATE x SET y=1; DELETE FROM x'", false],
  ['quoted identifiers', 'SELECT "UPDATE", [UPDATE], `UPDATE` FROM x', false],
  ['quoted comment delimiters', "SELECT '--; UPDATE', '/* DELETE */', 'it''s; CREATE'", false],
  ['comment keywords', '/* UPDATE; */ SELECT 1; -- DELETE;\nSELECT 2', false],
  ['CTE SELECT', 'WITH c AS (SELECT value FROM x) SELECT * FROM c', false],
  ['replace function and CASE', "SELECT replace('a', 'a', 'b'), CASE WHEN 1 THEN 2 END", false],
  ['bound value', 'SELECT ? AS value', false, ['UPDATE x; DELETE']],
  ['table info', "SELECT name FROM pragma_table_info('x')", false],
  ['same value', 'UPDATE x SET value=value', true],
  ['SELECT then same value', 'SELECT 1; UPDATE x SET value=value', true],
  ['SELECT then INSERT', 'SELECT 1; INSERT INTO x(value) VALUES(2)', true],
  ['SELECT then DELETE', 'SELECT 1; DELETE FROM x', true],
  ['SELECT then CREATE', 'SELECT 1; CREATE TABLE y(value INTEGER)', true],
  ['SELECT then DROP', 'SELECT 1; DROP TABLE x', true],
  ['ALTER', 'ALTER TABLE x ADD COLUMN extra TEXT', true],
  ['REPLACE', 'REPLACE INTO x(rowid,value) VALUES(1,1)', true],
  ['whitespace', ' \n\t UPDATE x SET value=value', true],
  ['block comment', '/* harmless */ UPDATE x SET value=value', true],
  ['line comment', '-- harmless\nUPDATE x SET value=value', true],
  ['CTE UPDATE', 'WITH c AS (SELECT 1) UPDATE x SET value=value', true],
  ['CTE REPLACE', 'WITH c AS (SELECT 1) REPLACE INTO x(rowid,value) SELECT 1,1 FROM c', true],
  ['no-row UPDATE', 'UPDATE x SET value=value WHERE 0', true],
  ['ignored INSERT', 'INSERT OR IGNORE INTO x(rowid,value) VALUES(1,1)', true],
  ['existing CREATE', 'CREATE TABLE IF NOT EXISTS x(value INTEGER)', true],
  ['no-row CTE REPLACE', 'WITH c AS (SELECT 1) REPLACE INTO x(value) SELECT 1 FROM c WHERE 0', true],
  ['writable PRAGMA', 'PRAGMA defer_foreign_keys=ON', true],
  ['SELECT then writable PRAGMA', 'SELECT 1; PRAGMA defer_foreign_keys=ON', true],
  ['foreign keys PRAGMA', 'PRAGMA foreign_keys=OFF', true],
  ['optimize', 'PRAGMA optimize', true],
  ['ANALYZE', 'ANALYZE x', true],
  ['REINDEX', 'REINDEX', true],
];

// Every mutant changes the actual exec detector, stays importable, and runs in
// native workerd. No-op mutations isolate attempt classification from the
// independent native rowsWritten backstop. The prefix/same-value mutants must
// disable that backstop too: otherwise the second control correctly kills them.
const gates = [
  { name: 'restore SELECT prefix', query: 'SELECT 1; UPDATE x SET value=value',
    replacements: [[gateSite, '    if (!/^\\s*SELECT\\b/i.test(query)) return deny();'],
      ['if (cursor.rowsWritten !== 0)', 'if (false)']] },
  { name: 'inspect only first statement', query: 'SELECT 1; UPDATE x SET value=value WHERE 0',
    replacements: [['return programs.every(tokens =>', 'return programs.slice(0, 1).every(tokens =>']] },
  { name: 'ignore same-value UPDATE', query: 'UPDATE x SET value=value',
    replacements: [[gateSite, "    if (query !== 'UPDATE x SET value=value' && !isReadOnlySQL(query)) return deny();"],
      ['if (cursor.rowsWritten !== 0)', "if (query !== 'UPDATE x SET value=value' && cursor.rowsWritten !== 0)"]] },
  { name: 'ignore semicolon suffix', query: 'SELECT 1; CREATE TABLE IF NOT EXISTS x(value INTEGER)',
    replacements: [[gateSite, "    if (!isReadOnlySQL(query.split(';')[0])) return deny();"]] },
  { name: 'ignore block-comment mutation', query: '/* harmless */ UPDATE x SET value=value WHERE 0',
    replacements: [[gateSite, "    if (!query.startsWith('/*') && !isReadOnlySQL(query)) return deny();"]] },
  { name: 'ignore line-comment mutation', query: '-- harmless\nUPDATE x SET value=value WHERE 0',
    replacements: [[gateSite, "    if (!query.startsWith('--') && !isReadOnlySQL(query)) return deny();"]] },
  { name: 'ignore DDL', query: 'CREATE TABLE IF NOT EXISTS x(value INTEGER)',
    replacements: [[gateSite, "    if (!query.startsWith('CREATE ') && !isReadOnlySQL(query)) return deny();"]] },
  { name: 'overmatch literal keyword', query: "SELECT 'UPDATE x SET value=value'", readonly: true,
    replacements: [[gateSite, "    if (query.includes('UPDATE') || !isReadOnlySQL(query)) return deny();"]] },
];
assert.equal(gates.length, 8);

test('C1J native SQL detector calibration, adversarial matrix and viable mutations', async t => {
  const variants = [source];
  for (const gate of gates) for (const eol of ['\n', '\r\n']) {
    let changed = source.replace(/\r\n/gu, '\n');
    for (const [before, after] of gate.replacements) {
      assert.equal(changed.split(before).length, 2, 'unique mutation site');
      changed = changed.replace(before, after);
    }
    changed = changed.replace(/\n/gu, eol);
    // A successful import is mandatory, never an accepted mutant kill.
    await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
    variants.push(changed);
  }
  const imports = variants.map((text, i) => `import { createSQLWriteDetector as d${i} } from '${'data:text/javascript;base64,' + Buffer.from(text).toString('base64')}';`).join('\n');
  const script = `${imports}
    import { DurableObject } from 'cloudflare:workers';
    const detectors = [${variants.map((_, i) => `d${i}`).join(',')}];
    export class DetectorProbe extends DurableObject {
      async probe(query, mode, params) {
        const sql = this.ctx.storage.sql;
        sql.exec('CREATE TABLE x(value INTEGER, "UPDATE" TEXT)');
        sql.exec("INSERT INTO x VALUES(1,'ok')");
        const raw = sql.exec.bind(sql);
        const before = raw('SELECT * FROM x').toArray();
        const counts = { writes: 0 }; let nativeCalls = 0; let actualRowsWritten = 0;
        const execute = (q, ...args) => { nativeCalls++; const cursor = raw(q, ...args);
          const rows = cursor.toArray(); actualRowsWritten += cursor.rowsWritten;
          return { toArray: () => rows, rowsWritten: cursor.rowsWritten }; };
        const guarded = mode === 'accounting-control'
          ? detectors[0](() => execute('UPDATE x SET value=value'), counts)
          : mode === 'raw' ? execute : mode === 'legacy'
          ? (q, ...args) => { if (!/^\\s*SELECT\\b/i.test(q)) { counts.writes++; throw Error('WRITE ATTEMPT'); } return execute(q, ...args); }
          : detectors[mode](execute, counts);
        let error = null; let rows = null;
        try { rows = guarded(query, ...params).toArray(); } catch (e) { error = e.message; }
        const present = raw("SELECT name FROM sqlite_master WHERE name='x'").toArray().length;
        return { counts, nativeCalls, actualRowsWritten, error, rows, before,
          after: present ? raw('SELECT * FROM x').toArray() : null };
      }
    }
    export default { async fetch(r,e) { const {query,mode,params,id} = await r.json();
      return Response.json(await e.PROBE.getByName(id).probe(query,mode,params)); } };`;
  let outbound = 0; let id = 0;
  const bundled = await build({ stdin: { contents: script }, bundle: true, write: false,
    format: 'esm', platform: 'neutral', external: ['cloudflare:workers'] });
  const runtime = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-09-03', cf: false,
    durableObjects: { PROBE: { className: 'DetectorProbe', useSQLite: true } },
    outboundService: () => { outbound++; throw Error('NETWORK FORBIDDEN'); },
  }), telemetry: { enabled: false } });
  const probe = async (query, mode = 0, params = []) => {
    const r = await runtime.dispatchFetch('https://local.invalid/', { method: 'POST',
      body: JSON.stringify({ query, mode, params, id: String(++id) }) });
    assert.equal(r.status, 200); return r.json();
  };
  try {
    await t.test('fresh exact legacy bypass and native read-only capability audit', async () => {
      const old = await probe('SELECT 1; UPDATE x SET value=value', 'legacy');
      assert.equal(old.error, null); assert.equal(old.counts.writes, 0);
      assert.equal(old.actualRowsWritten, 1); assert.deepEqual(old.after, old.before);
      for (const query of ['PRAGMA query_only=ON', 'PRAGMA user_version=1', 'PRAGMA writable_schema=ON']) {
        const r = await probe(query, 'raw'); assert.match(r.error, /not authorized/u);
      }
    });
    await t.test('native accounting independently detects an execution-layer same-value write', async () => {
      const result = await probe('SELECT 1', 'accounting-control');
      assert.equal(result.nativeCalls, 1); assert.equal(result.actualRowsWritten, 1);
      assert.equal(result.counts.writes, 1); assert.equal(result.error, 'WRITE ATTEMPT');
      assert.deepEqual(result.after, result.before);
    });
    for (const [name, query, mutation, params = []] of cases) await t.test(`detector matrix: ${name}`, async () => {
      const raw = await probe(query, 'raw', params);
      assert.equal(raw.error, null, 'fixture SQL must actually be supported');
      const result = await probe(query, 0, params);
      assert.equal(result.counts.writes, mutation ? 1 : 0);
      assert.equal(result.error, mutation ? 'WRITE ATTEMPT' : null);
      assert.equal(result.nativeCalls, mutation ? 0 : 1);
      assert.equal(result.actualRowsWritten, 0); assert.deepEqual(result.after, result.before);
      if (!mutation) assert.deepEqual(result.rows, raw.rows);
    });
    let variant = 0;
    for (const gate of gates) for (const eol of ['LF', 'CRLF']) await t.test(`detector viable mutation: ${gate.name} ${eol}`, async () => {
      const index = ++variant;
      const native = await probe(gate.query, 'raw'); assert.equal(native.error, null);
      const baseline = await probe(gate.query);
      const expected = gate.readonly ? 0 : 1;
      const invariant = r => assert.equal(r.counts.writes, expected);
      invariant(baseline);
      const broken = await probe(gate.query, index);
      assert.equal(broken.counts.writes, gate.readonly ? 1 : 0, 'intended false classification');
      assert.equal(broken.nativeCalls, gate.readonly ? 0 : 1, 'actual native forwarding or rejection');
      assert.equal(broken.error, gate.readonly ? 'WRITE ATTEMPT' : null);
      if (!gate.readonly) assert.equal(broken.actualRowsWritten, native.actualRowsWritten);
      assert.throws(() => invariant(broken), { name: 'AssertionError', code: 'ERR_ASSERTION' });
    });
    assert.equal(outbound, 0);
  } finally { await runtime.dispose(); }
});
