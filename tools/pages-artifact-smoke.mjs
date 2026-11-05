#!/usr/bin/env node
// Smoke-test ONLY the built artifact, with no checkout fallback or QA fixture route.
// Usage: node tools/pages-artifact-smoke.mjs SITE NEW_EVIDENCE_DIRECTORY
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkArtifact, sourceRoot } from './check-pages-artifact.mjs';

assert.ok(process.argv[2] && process.argv[3], 'Provide built site and new evidence directory');
const site = await realpath(path.resolve(process.argv[2]));
const output = path.resolve(process.argv[3]);
await checkArtifact(site);
assert.ok(output !== sourceRoot && !output.startsWith(sourceRoot + path.sep), 'Keep evidence outside checkout');
assert.ok(output !== site && !output.startsWith(site + path.sep), 'Keep evidence outside artifact');
await mkdir(output, { recursive: false }); // Never overwrite existing evidence.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const prefix = '/chinese-chess-training/';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const file = path.resolve(site, pathname.slice(prefix.length) || 'index.html');
    if (!file.startsWith(site + path.sep)) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${prefix}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  const forbiddenURLs = ['tools/idb-browser.html', 'tools/idb-browser-fixture.js',
    'tools/idb-migration-fixture.js', 'tools/custom-position-repository-fixture.js',
    'tools/pages-artifact-smoke.mjs', 'custom-position-idb-test.mjs',
    'staging/review-coach.html', 'coach-api/src/index.js'];
  const excluded = [];
  for (const name of forbiddenURLs) {
    const response = await fetch(url + name);
    excluded.push({ name, status: response.status });
    assert.equal(response.status, 404, `Excluded URL is accessible: ${name}`);
  }
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(), errors = [], workers = [], resources = [], jobs = [];
    const result = { label, viewport, status: 'RUNNING', errors, workers, resources };
    results.push(result); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('worker', worker => workers.push(worker.url()));
    page.on('response', response => {
      if (!response.url().startsWith(url)) return;
      jobs.push((async () => {
        const name = new URL(response.url()).pathname.slice(prefix.length) || 'index.html';
        const bytes = await response.body();
        resources.push({ name, status: response.status(), matchesArtifact: bytes.equals(await readFile(path.join(site, name))) });
      })());
    });
    await page.addInitScript(() => {
      window.artifactQA = { rejections: [], legacyWrites: [] };
      addEventListener('unhandledrejection', event => artifactQA.rejections.push(String(event.reason)));
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'chinese-chess-training:custom-positions:v1') {
          artifactQA.legacyWrites.push(key); throw Error('Legacy custom-position write');
        }
        return set.call(this, key, value);
      };
    });
    const idle = () => page.waitForFunction(() => document.getElementById('savedPositionsDialog').getAttribute('aria-busy') === 'false');
    const toolbar = async id => {
      if (!await page.locator(id).isVisible()) await page.locator('#btnMore').click();
      await page.locator(id).click();
    };
    await page.goto(url); assert.equal(page.url(), url);
    assert.match(await page.title(), /中國象棋/);
    await page.waitForFunction(() => !!window.__chess?.board);
    assert.equal(await page.locator('#stage canvas').count(), 1);
    await toolbar('#btnSavedPositions'); await idle();
    await page.keyboard.press('Escape');
    await toolbar('#btnEditor');
    await page.locator('#btnEditorStandard').click();
    await page.locator('#btnEditorConfirm').click();
    await page.locator('#btnSaveCustomPosition').click(); await idle();
    await page.locator('#savedPositionTitle').fill('Artifact synthetic position');
    await page.locator('#savedPositionSubmit').click(); await idle();
    assert.equal(await page.locator('#savedPositionsList li').count(), 1);
    await page.locator('[data-action=rename]').click();
    await page.locator('#savedPositionTitle').fill('Artifact verified');
    await page.locator('#savedPositionSubmit').click(); await idle();
    await page.locator('[data-action=challenge]').click();
    await page.locator('#savedPositionHumanSide').selectOption('black');
    await page.locator('#savedPositionDifficulty').selectOption('easy');
    if (await page.locator('#savedPositionAcknowledgement').isVisible()) await page.locator('#savedPositionAcknowledge').check();
    await page.locator('#savedPositionOnce').click();
    await page.waitForFunction(() => __chess.history.length === 1 && !__chess.busy);
    assert.equal(await page.evaluate(() => __chess.turn), 'black');
    assert.equal(await page.evaluate(() => __chess.pieces.length === __chess.board.flat().filter(Boolean).length
      && __chess.pieces.every(mesh => { const p = __chess.board[mesh.userData.r][mesh.userData.c];
        return p && p.type === mesh.userData.piece.type && p.side === mesh.userData.piece.side; })), true);
    result.snapshot = await page.evaluate(async () => {
      const { createCustomPositionIDB } = await import('./custom-position-idb.js');
      const adapter = createCustomPositionIDB({ initializeEmpty: false });
      try { return await adapter.read(); } finally { adapter.dispose(); }
    });
    assert.equal(result.snapshot.snapshot.envelope.revision, 2);
    assert.equal(result.snapshot.snapshot.envelope.positions[0].title, 'Artifact verified');
    result.guard = await page.evaluate(() => artifactQA);
    assert.deepEqual(result.guard, { rejections: [], legacyWrites: [] });
    await Promise.all(jobs);
    assert.ok(resources.length > 25 && resources.every(r => r.status === 200 && r.matchesArtifact));
    assert.ok(workers.some(worker => worker.startsWith(url + 'ai-worker.js?v=')));
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, label + '.png') });
    result.status = 'PASS'; await context.close();
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'PASS', chrome: browser.version(), url, excluded, results }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', chrome: browser.version(), excluded: excluded.length, viewports: results.map(r => r.label) }));
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, results }, null, 2));
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
