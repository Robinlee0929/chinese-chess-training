import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

const toolSource = readFileSync(new URL('./bump-cache.mjs', import.meta.url), 'utf8');
// Deliberately create modules out of order. Unrelated nested directories stay excluded.
const files = {
  'z.js': "export const label = '棋盤';\n",
  'main.js': "import './a.js?v=deadbeef00';\n",
  'a.js': "import './z.js?v=deadbeef00';\nexport const turn = 1;\n",
  'css/style.css': '/* 棋盤 */\nbody { color: red; }\n',
  'index.html': '<link href="./css/style.css?v=deadbeef00">\n<script type="module" src="./main.js?v=deadbeef00"></script>\n',
  'ignored.mjs': 'not a cache asset\n',
  'nested/ignored.js': 'not a root module\n',
};
const canonicalInput = [
  files['css/style.css'],
  "import './z.js';\nexport const turn = 1;\n",
  "import './a.js';\n",
  files['z.js'],
].join('\0');
const expectedVersion = createHash('sha256').update(canonicalInput).digest('hex').slice(0, 10);

for (const eol of ['LF', 'CRLF', 'CR', 'MIXED']) {
  test(`${eol}: canonical cache version, read-only check, and idempotent bump`, (t) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'chess-cache-eol-'));
    t.after(() => {
      // Delete only this test's freshly created directory under the real temp directory.
      const target = realpathSync(fixtureRoot);
      assert.equal(dirname(target), realpathSync(tmpdir()));
      assert.match(basename(target), /^chess-cache-eol-/);
      rmSync(target, { recursive: true, force: true });
    });
    const convert = (text) => {
      let line = 0;
      return text.replace(/\n/g, () => eol === 'LF' ? '\n' : eol === 'CRLF' ? '\r\n'
        : eol === 'CR' ? '\r' : ['\r\n', '\r', '\n'][line++ % 3]);
    };
    const originals = new Map();
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(fixtureRoot, path)), { recursive: true });
      const text = convert(content);
      originals.set(path, text);
      writeFileSync(join(fixtureRoot, path), text);
    }
    const binary = Buffer.from([0, 255, 13, 10, 128]);
    writeFileSync(join(fixtureRoot, 'ignored.png'), binary);
    mkdirSync(join(fixtureRoot, 'tools'));
    const fixtureTool = join(fixtureRoot, 'tools', 'bump-cache.mjs');
    writeFileSync(fixtureTool, toolSource);
    const run = (...args) => spawnSync(process.execPath, [fixtureTool, ...args], { encoding: 'utf8' });
    const snapshot = () => Object.fromEntries(Object.keys(files).map(path =>
      [path, readFileSync(join(fixtureRoot, path), 'utf8')]));

    const bump = run();
    assert.equal(bump.status, 0, bump.stderr);
    const generated = snapshot();
    const version = generated['index.html'].match(/style\.css\?v=([0-9a-f]+)/)?.[1];
    assert.equal(version, expectedVersion, `${eol} must hash the canonical LF input`);
    console.log(`${eol}_FIXTURE_CACHE_VERSION: ${version}`);
    // The existing bump may replace tokens, but must not rewrite source EOL or other bytes.
    for (const [path, before] of originals) {
      assert.equal(generated[path], before.replace(/\?v=deadbeef00/g, `?v=${expectedVersion}`), path);
    }
    assert.deepEqual(readFileSync(join(fixtureRoot, 'ignored.png')), binary);

    const check = run('--check');
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.deepEqual(snapshot(), generated, '--check must not write');
    assert.equal(run().status, 0);
    assert.deepEqual(snapshot(), generated, 'a second bump must not change content');

    // Meaningful source changes must still invalidate the cache, without --check fixing them.
    writeFileSync(join(fixtureRoot, 'z.js'), convert("export const label = '新棋盤';\n"));
    const changed = snapshot();
    const stale = run('--check');
    assert.equal(stale.status, 1, 'changed source must fail the cache check');
    assert.deepEqual(snapshot(), changed, 'a failing --check must also remain read-only');
  });
}

test('transfer subdirectory, Worker URLs and parent imports share the content cache version', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'chess-cache-transfer-'));
  t.after(() => {
    const target = realpathSync(fixtureRoot);
    assert.equal(dirname(target), realpathSync(tmpdir()));
    assert.match(basename(target), /^chess-cache-transfer-/);
    rmSync(target, { recursive: true, force: true });
  });
  const fixtureFiles = { ...files,
    'main.js': "void import('./game-transfer/ui.js');\n",
    'game-transfer/ui.js': "new Worker(new URL('./validation-worker.js', import.meta.url), {type:'module'});\n",
    'game-transfer/validation-worker.js': "import '../a.js';\nimport './core/parser.js';\n",
    'game-transfer/core/parser.js': "export const version = 1;\n",
  };
  for (const [file, text] of Object.entries(fixtureFiles)) {
    mkdirSync(dirname(join(fixtureRoot, file)), { recursive: true });
    writeFileSync(join(fixtureRoot, file), text);
  }
  mkdirSync(join(fixtureRoot, 'tools'));
  writeFileSync(join(fixtureRoot, 'tools/bump-cache.mjs'), toolSource);
  const run = (...args) => spawnSync(process.execPath, [join(fixtureRoot, 'tools/bump-cache.mjs'), ...args], { encoding:'utf8' });
  assert.equal(run().status, 0); assert.equal(run('--check').status, 0);
  const version = readFileSync(join(fixtureRoot, 'index.html'), 'utf8').match(/\?v=([a-f0-9]+)/)[1];
  for (const file of ['main.js','game-transfer/ui.js','game-transfer/validation-worker.js']) {
    const text=readFileSync(join(fixtureRoot,file),'utf8');
    assert.ok([...text.matchAll(/\.{1,2}\/[^'"\s]+\.js\?v=([a-f0-9]+)/g)].every(match=>match[1]===version));
    assert.doesNotMatch(text,/\.js['"]/);
  }
  writeFileSync(join(fixtureRoot,'game-transfer/core/parser.js'), 'export const version = 2;\n');
  assert.equal(run('--check').status,1);assert.equal(run().status,0);
  assert.notEqual(readFileSync(join(fixtureRoot,'index.html'),'utf8').match(/\?v=([a-f0-9]+)/)[1],version);
  assert.equal(readFileSync(join(fixtureRoot,'nested/ignored.js'),'utf8'),files['nested/ignored.js']);
});
