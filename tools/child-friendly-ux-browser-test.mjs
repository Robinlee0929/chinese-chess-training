// Isolated Chrome only. Evidence is never written into the checkout.
// PLAYWRIGHT_MODULE=... node tools/child-friendly-ux-browser-test.mjs SITE NEW_EVIDENCE_DIR
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
assert.ok(out !== root && !out.startsWith(root + path.sep));
await mkdir(out, { recursive: false });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const baseline = '7e474bfcaded4f63fa8719737c3fa075b3859c6d', prefix = '/chinese-chess-training/';
const recordKey = 'chinese-chess-training:game-records:v1', results = [], errors = [];
let legacy = false;
const oldFiles = new Map();
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!pathname.startsWith(prefix)) throw Error('outside prefix');
    const rel = pathname.slice(prefix.length) || 'index.html', file = path.resolve(site, rel);
    if (!file.startsWith(site + path.sep)) throw Error('outside site');
    if (legacy && !oldFiles.has(rel)) oldFiles.set(rel, execFileSync('git', ['show', baseline + ':' + rel], { cwd: root }));
    const body = legacy ? oldFiles.get(rel) : await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${prefix}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const watchdog = setTimeout(() => { void browser.close(); }, 8 * 60 * 1000);
const ready = p => p.waitForFunction(() => window.__chess?.pieces.length === 32 && !__chess.busy);
const settled = async p => { await p.waitForFunction(() => !__chess.busy && !__chess.aiThinking); await p.waitForTimeout(1100); };
const toolbar = async (p, id) => { if (!await p.locator(id).isVisible()) await p.locator('#btnMore').click(); await p.locator(id).click(); };
const check = async (name, fn) => { await fn(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); };
async function move(p, from, to) {
  await settled(p);
  if (await p.locator('#btnMore').isVisible() && await p.locator('#btnMore').getAttribute('aria-expanded') === 'true') await p.locator('#btnMore').click();
  for (const square of [from, to]) {
    const pt = await p.evaluate(s => { const x = __chess, rect = x.renderer.domElement.getBoundingClientRect(); const v = x.camera.position.clone().set(s.c - 4, x.board[s.r][s.c] ? .18 : 0, 4.5 - s.r).project(x.camera); return { x: rect.x + (v.x + 1) * rect.width / 2, y: rect.y + (1 - v.y) * rect.height / 2 }; }, square);
    await p.mouse.click(pt.x, pt.y);
    if (square === from) assert.deepEqual(await p.evaluate(() => __chess.selected), from);
  }
}
async function positions(p) {
  return p.evaluate(async () => {
    const { createCustomPositionRepository } = await import('./custom-position-repository.js');
    const repository = createCustomPositionRepository({ indexedDB: () => indexedDB, storage: () => localStorage });
    const scope = repository.createScope();
    try { const r = await scope.loadAll().completion; if (r.status !== 'SUCCESS') throw Error(JSON.stringify(r)); return r.snapshot.envelope.positions; }
    finally { scope.close(); repository.suspend('test-read-complete'); }
  });
}
const perspective = p => p.evaluate(() => ({ index: __chess.viewIdx, side: __chess.viewerSide, snap: __chess.boardViewRotationDeg, pos: __chess.camera.position.toArray() }));
let currentPage;
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const name = viewport.width === 1440 ? 'desktop' : 'mobile-emulation';
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      window.qaPosts = []; window.qaWrites = [];
      const NativeWorker = Worker; window.Worker = class extends NativeWorker { postMessage(data, ...args) { qaPosts.push(data); return super.postMessage(data, ...args); } };
      const original = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { qaWrites.push({ key: k, value: v }); return original.call(this, k, v); };
    });
    const p = currentPage = await context.newPage(); p.setDefaultTimeout(20000);
    p.on('pageerror', error => errors.push(error.message));
    p.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await p.goto(url); await ready(p); await settled(p);
    await check(name + ': names, first red-bottom camera and 32 pieces', async () => {
      assert.ok(await p.title());
      for (const id of ['modeSel', 'customPlayDifficulty', 'gameReviewContinuationDifficulty', 'savedPositionDifficulty']) assert.match(await p.locator(`#${id} option[value="experimental-b"]`).textContent(), /挑戰級（試玩）/);
      const camera = await perspective(p); assert.equal(camera.index, 2); assert.equal(camera.side, 'red'); assert.equal(camera.snap, 0);
      assert.ok(await p.evaluate(() => __chess.pieces.every(piece => {
        const v = piece.position.clone().project(__chess.camera); return Math.abs(v.x) < .94 && Math.abs(v.y) < .94;
      })), 'all initial piece centers fit with a margin');
      await p.screenshot({ path: path.join(out, name + '-initial.png') });
    });
    await check(name + ': B snapshot, hard preference and unchanged live Session', async () => {
      await p.locator('#modeSel').selectOption('experimental-b');
      await move(p, { r: 3, c: 4 }, { r: 4, c: 4 }); await p.waitForFunction(() => __chess.history.length === 2); await settled(p);
      const before = await p.evaluate(key => ({ board: __chess.board, turn: __chess.turn, session: __chess.normalGameRecordSession, mode: __chess.mode, record: localStorage.getItem(key) }), recordKey);
      await toolbar(p, '#btnSaveCurrentPosition'); await p.locator('#savedPositionTitle').fill('孩子試玩快照');
      assert.equal(await p.locator('#savedPositionDifficulty').inputValue(), 'hard'); assert.ok(await p.locator('#savedPositionDifficulty').isDisabled());
      await p.locator('#savedPositionSubmit').click(); await p.waitForFunction(() => document.querySelector('#savedPositionsNotice').textContent.includes('下次預設為困難級'));
      const saved = (await positions(p)).find(x => x.title === '孩子試玩快照');
      assert.deepEqual(saved.initialBoard, before.board); assert.equal(saved.sideToMove, before.turn); assert.deepEqual(saved.playPreferences, { humanSide: 'red', difficulty: 'hard' });
      await p.screenshot({ path: path.join(out, name + '-saved-snapshot.png') });
      await p.locator('#savedPositionsClose').click();
      assert.deepEqual(await p.evaluate(key => ({ board: __chess.board, turn: __chess.turn, session: __chess.normalGameRecordSession, mode: __chess.mode, record: localStorage.getItem(key) }), recordKey), before);
      const posts = await p.evaluate(() => qaPosts); assert.ok(posts.some(x => x.level === 'experimental-b'));
      assert.equal((await p.evaluate(() => qaWrites)).filter(x => x.key === 'chinese-chess-training:game-records:v1').length, 0);
      await p.reload(); await ready(p); assert.equal(await p.evaluate(() => __chess.lastCompletedGameRecord), null);
      assert.deepEqual((await positions(p)).find(x => x.id === saved.id), saved);
    });
    await check(name + ': saved position once-only B, black camera and black snapshot', async () => {
      await toolbar(p, '#btnSavedPositions'); await p.locator('[data-action="challenge"]').click();
      await p.locator('#savedPositionDifficulty').selectOption('experimental-b'); await p.locator('#savedPositionHumanSide').selectOption('black');
      if (await p.locator('#savedPositionAcknowledge').isVisible()) await p.locator('#savedPositionAcknowledge').check();
      const before = await positions(p); await p.locator('#savedPositionOnce').click(); await settled(p);
      assert.equal((await perspective(p)).index, 4); assert.equal((await perspective(p)).side, 'black'); assert.equal((await perspective(p)).snap, 180);
      assert.deepEqual(await positions(p), before);
      await toolbar(p, '#btnSaveCurrentPosition'); await p.locator('#savedPositionTitle').fill('黑方快照'); await p.locator('#savedPositionSubmit').click();
      await p.waitForFunction(() => document.querySelector('#savedPositionsNotice').textContent.includes('下次預設為困難級'));
      assert.deepEqual((await positions(p)).find(x => x.title === '黑方快照').playPreferences, { humanSide: 'black', difficulty: 'hard' });
      await p.locator('#savedPositionsClose').click(); await p.screenshot({ path: path.join(out, name + '-black.png') });
    });
    await check(name + ': red/black switching, manual view, lock and reload preferences', async () => {
      await p.locator('#modeSel').selectOption('easy'); await settled(p);
      await p.locator('label[for="humanSideBlack"]').click(); await settled(p); assert.equal((await perspective(p)).index, 4);
      await toolbar(p, '#btnLock'); const locked = await perspective(p);
      await p.locator('label[for="humanSideRed"]').click(); await settled(p); assert.deepEqual(await perspective(p), locked);
      await p.reload(); await ready(p); await settled(p); assert.deepEqual(await perspective(p), locked); assert.equal(await p.locator('#btnLock').getAttribute('aria-pressed'), 'true');
      await toolbar(p, '#btnLock'); await p.locator('label[for="humanSideBlack"]').click(); await settled(p);
      await p.locator('label[for="humanSideRed"]').click(); await settled(p); assert.equal((await perspective(p)).index, 2);
      await toolbar(p, '#btnView'); await settled(p); const manual = await perspective(p); assert.equal(manual.index, 3);
      await move(p, { r: 3, c: 4 }, { r: 4, c: 4 }); await settled(p); assert.deepEqual(await perspective(p), manual);
      await p.reload(); await ready(p); await settled(p); assert.deepEqual(await perspective(p), manual);
    });
    await check(name + ': custom position aligns to human black', async () => {
      await toolbar(p, '#btnEditor'); await p.locator('#btnEditorStandard').click(); await p.locator('#btnEditorConfirm').click();
      await p.locator('#btnCustomPlay').click(); await p.locator('#customPlayHumanSide').selectOption('black'); await p.locator('#customPlayDifficulty').selectOption('easy');
      await p.locator('#customPlayForm button[type="submit"]').click(); await settled(p); assert.equal((await perspective(p)).index, 4); assert.equal((await perspective(p)).side, 'black');
    });
    await check(name + ': old version reads, edits and deletes the new snapshots', async () => {
      const before = await positions(p); legacy = true; await p.reload(); await ready(p);
      assert.deepEqual(await positions(p), before); await toolbar(p, '#btnSavedPositions');
      const row = p.locator('[data-position-id]').filter({ hasText: '黑方快照' });
      await row.locator('[data-action="rename"]').click(); await p.locator('#savedPositionTitle').fill('舊版修改成功'); await p.locator('#savedPositionSubmit').click();
      await p.waitForFunction(() => document.querySelector('#savedPositionsNotice').textContent.includes('已完成更新'));
      assert.ok((await positions(p)).some(x => x.title === '舊版修改成功'));
      await p.locator('[data-position-id]').filter({ hasText: '舊版修改成功' }).locator('[data-action="delete"]').click(); await p.locator('#savedPositionSubmit').click();
      await p.waitForFunction(() => document.querySelector('#savedPositionsNotice').textContent.includes('已刪除'));
      assert.deepEqual(await positions(p), before.filter(x => x.title !== '黑方快照')); legacy = false; await p.reload(); await ready(p);
    });
    await check(name + ': background photo persists and restores wood', async () => {
      await toolbar(p, '#btnBoardAppearance');
      const b64 = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 600; const g = c.getContext('2d'); g.fillStyle = '#22aa99'; g.fillRect(0, 0, 900, 600); g.fillStyle = '#f0b549'; g.fillRect(120, 80, 400, 300); return c.toDataURL().split(',')[1]; });
      await p.locator('#boardAppearanceFile').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
      await p.waitForFunction(() => !document.querySelector('#boardAppearanceSettings').disabled); await p.locator('#boardAppearanceRemember').check();
      await p.waitForFunction(() => document.querySelector('#boardAppearancePersistence').textContent.includes('已在'));
      await p.reload(); await ready(p); await toolbar(p, '#btnBoardAppearance');
      await p.waitForFunction(() => document.querySelector('#boardAppearancePersistence').textContent.includes('已在'));
      assert.equal(await p.locator('#boardAppearanceRemember').isChecked(), true); await p.screenshot({ path: path.join(out, name + '-photo.png') });
      await p.locator('#boardAppearanceReset').click(); await p.waitForFunction(() => document.querySelector('#boardAppearanceStatus').textContent.includes('已移除'));
      await p.locator('#boardAppearanceClose').click();
    });
    assert.deepEqual(errors, []); await context.close();
  }
} catch (error) {
  results.push({ status: 'FAIL', error: error.stack }); if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: path.join(out, 'failure.png') }); process.exitCode = 1; console.error(error);
} finally {
  clearTimeout(watchdog); await writeFile(path.join(out, 'result.json'), JSON.stringify({ url, chrome: browser.version(), results, errors }, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
