#!/usr/bin/env node
// Validate a REAL Jekyll artifact, not an emulation of Jekyll's exclude rules.
// Usage: node tools/check-pages-artifact.mjs /absolute/path/to/built-site
import assert from 'node:assert/strict';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const forbiddenArtifact = name => /(^|\/)(tools|staging|coach-api|node_modules|test-results|playwright-report|coverage|demo-output|\.git)(\/|$)/.test(name)
  || /\.mjs$/i.test(name) || /(^|\/)(?:Gemfile(?:\.lock)?|_config\.yml)$/.test(name);

async function filesIn(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    assert.ok(!entry.isSymbolicLink(), `Unexpected artifact symlink: ${name}`);
    if (entry.isDirectory()) names.push(...await filesIn(path.join(directory, entry.name), name + '/'));
    else names.push(name);
  }
  return names.sort();
}

export async function checkArtifact(directory) {
  const site = await realpath(path.resolve(directory));
  const source = await realpath(sourceRoot);
  assert.ok(site !== source && !site.startsWith(source + path.sep), 'Build outside the checkout');
  assert.ok(!source.startsWith(site + path.sep), 'Artifact cannot contain the checkout');
  const published = await filesIn(site);
  assert.deepEqual(published.filter(forbiddenArtifact), [], 'Test/development assets leaked into artifact');

  // Preserve every root JS, including lazy modules and all Worker dependencies.
  // This intentionally checks more than the graph reachable on the first screen.
  const required = new Set(['index.html', 'css/style.css', 'favicon.ico',
    'apple-touch-icon.png', 'og-image.jpg', 'LICENSE', 'docs/assets/mate-puzzle-editor.png']);
  for (const name of await readdir(source)) if (name.endsWith('.js')) required.add(name);
  const visited = new Set();
  const queue = [...required];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!/\.(html|js|css)$/.test(file)) continue;
    const text = await readFile(path.join(source, file), 'utf8');
    // Follow relative static imports, dynamic imports, new URL/Worker paths,
    // HTML attributes and CSS url(). A browser smoke additionally checks requests.
    const references = [...text.matchAll(/["'`](\.{1,2}\/[^"'`\s<>]+)["'`]/g)].map(m => m[1]);
    for (const match of text.matchAll(/url\(\s*["']?(\.{1,2}\/[^"')\s]+)["']?\s*\)/g)) references.push(match[1]);
    for (const reference of references) {
      const clean = reference.split(/[?#]/)[0];
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), clean));
      assert.ok(!next.startsWith('../'), `Resource escapes site: ${file} -> ${reference}`);
      assert.ok(!forbiddenArtifact(next), `Runtime references excluded asset: ${file} -> ${reference}`);
      assert.ok((await lstat(path.join(source, next))).isFile(), `Missing source resource ${next}`);
      required.add(next); queue.push(next);
    }
  }
  const hashes = [];
  for (const name of [...required].sort()) {
    assert.ok(published.includes(name), `Missing runtime asset: ${name}`);
    const expected = await readFile(path.join(source, name));
    const actual = await readFile(path.join(site, name));
    assert.ok(actual.equals(expected), `Runtime asset changed during build: ${name}`);
    hashes.push({ name, bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') });
  }
  return { status: 'PASS', artifactFiles: published, runtimeAssets: hashes, excludedAssetLeaks: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], 'Provide a real Jekyll artifact directory');
  console.log(JSON.stringify(await checkArtifact(process.argv[2]), null, 2));
}
