// Real Chrome keyboard regression. Synthetic game data and evidence stay isolated.
// PLAYWRIGHT_MODULE=... node tools/game-export-keyboard-test.mjs SITE OUTSIDE_REPO_DIR
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { terminal } from './game-transfer-fixtures.mjs';
import { parseGameTransfer, serializeGameTransferTXT } from '../game-transfer/game-transfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
assert.ok(out !== root && !out.startsWith(root + path.sep), 'Evidence must stay outside the checkout');
await mkdir(out, { recursive: false });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const prefix = '/chinese-chess-training/', results = [], errors = [];
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    assert.ok(pathname.startsWith(prefix));
    const relative = pathname.slice(prefix.length) || 'index.html', file = path.resolve(site, relative);
    assert.ok(file.startsWith(site + path.sep) && !relative.endsWith('.mjs') && !relative.startsWith('tools/'));
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${prefix}`;
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const watchdog = setTimeout(() => void browser.close(), 180000);
const idle = p => p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking);
const state = p => p.evaluate(() => ({ appState: __chess.appState, mode: __chess.mode,
  board: __chess.board, turn: __chess.turn, history: __chess.history, session: __chess.normalGameRecordSession,
  review: __chess.gameReview, records: localStorage.getItem('chinese-chess-training:game-records:v1') }));
const toolbar = async (p, id) => { if (!await p.locator(id).isVisible()) await p.locator('#btnMore').click(); await p.locator(id).click(); };
const closed = p => p.waitForFunction(() => !document.querySelector('#gameExportDialog').open);
const focused = p => p.evaluate(() => document.activeElement.id || document.activeElement.dataset.exportFormat);
let downloadIndex = 0;
async function keyboardDialog(p, entry, label) {
  const before = await state(p);
  await toolbar(p, entry);
  assert.equal(await focused(p), 'txt');
  for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    await p.keyboard.press(key);
    assert.deepEqual(await state(p), before, `${label}: ${key} must not change the background game/review`);
    assert.equal(await p.locator('#gameExportDialog').evaluate(d => d.open), true);
  }
  // Native dialog tab order; do not replace Chrome's browser-chrome edge behavior with a custom focus trap.
  for (const [key, target] of [['Tab', 'json'], ['Tab', 'gameExportClose'], ['Shift+Tab', 'json'], ['Shift+Tab', 'txt']]) {
    await p.keyboard.press(key); assert.equal(await focused(p), target, label + ' native focus navigation');
  }
  await p.keyboard.press('Escape'); await closed(p);
  assert.deepEqual(await state(p), before, label + ': Escape only dismisses export');
  const returnFocus = await focused(p);
  assert.ok([entry.slice(1), ...(entry === '#btnGameExport' ? ['btnMore'] : [])].includes(returnFocus), label + ': restore focus to entry or its menu trigger, got ' + returnFocus);
  await toolbar(p, entry); await p.locator('#gameExportClose').focus(); await p.keyboard.press('Enter'); await closed(p);
  assert.deepEqual(await state(p), before, label + ': native button activation only dismisses export');
  assert.equal(await focused(p), returnFocus, label + ': close button restores the same focus');
}
async function downloadPair(p) {
  const values = {};
  for (const format of ['json', 'txt']) {
    await p.locator(`[data-export-format="${format}"]`).focus();
    const event = p.waitForEvent('download'); await p.keyboard.press('Enter');
    const download = await event, target = path.join(out, `${++downloadIndex}-${download.suggestedFilename()}`);
    await download.saveAs(target); assert.equal(await download.failure(), null);
    values[format] = await readFile(target);
  }
  const canonical = parseGameTransfer(values.json);
  assert.equal(values.txt.toString('utf8'), serializeGameTransferTXT(canonical.document));
  return canonical.document;
}
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, acceptDownloads: true }), p = await context.newPage();
    p.setDefaultTimeout(15000);
    await context.addInitScript(() => {
      window.keyboardQA = { hold: false, replies: [], workers: [] };
      const NativeWorker = Worker;
      window.Worker = class {
        constructor(url, options) {
          if (!keyboardQA.hold || !String(url).includes('game-transfer/validation-worker.js')) return new NativeWorker(url, options);
          this.inner = new NativeWorker(url, options); this.terminations = 0; keyboardQA.workers.push(this);
          this.inner.onerror = event => this.onerror?.(event);
          this.inner.onmessageerror = event => this.onmessageerror?.(event);
          this.inner.onmessage = event => { const callback = this.onmessage; keyboardQA.replies.push(() => callback?.(event)); };
        }
        postMessage(data) { this.inner.postMessage(data); }
        terminate() { this.terminations++; this.inner.terminate(); }
      };
    });
    const downloads = []; p.on('download', d => downloads.push(d));
    p.on('pageerror', e => errors.push({ viewport, message: e.message }));
    p.on('console', m => { if (m.type() === 'error') errors.push({ viewport, message: m.text() }); });
    const check = async (name, run) => { await run(); results.push({ viewport, name, status: 'PASS' }); console.log(`PASS ${viewport.width}: ${name}`); };
    try {
      await p.goto(url); await idle(p); await p.waitForFunction(() => !document.querySelector('#btnGameExport').hidden);
      assert.match(await p.title(), /中國象棋/); assert.equal(await p.locator('#stage canvas').count(), 1);
      const reviewFixture = terminal('threefold-repetition');
      await p.evaluate(async d => {
        const { createGameRecordStore } = await import('./game-record-store.js');
        assertSave(createGameRecordStore({ storage: localStorage }).saveGameRecord({ schemaVersion: 1, id: 'keyboard-review', createdAt: d.exportedAt, completedAt: d.exportedAt, initialPosition: d.initialPosition, moves: d.moves, mode: 'hard', result: d.result }));
        function assertSave(result) { if (result.record?.id !== 'keyboard-review') throw Error('Synthetic record save failed'); }
        __chess.enterGameRecordLibrary(); __chess.openStoredGameReview('keyboard-review'); __chess.navigateGameReview(4);
      }, reviewFixture);
      await check('review modal owns navigation, Escape and native Tab; restores focus and ply', async () => {
        assert.equal((await state(p)).review.selectedPly, 4);
        await keyboardDialog(p, '#btnGameReviewExport', 'historical review');
        for (const [key, ply] of [['ArrowLeft', 3], ['ArrowRight', 4], ['Home', 0], ['End', 8]]) {
          await p.keyboard.press(key); assert.equal((await state(p)).review.selectedPly, ply, 'shortcuts resume after dialog closes');
        }
        await p.keyboard.press('Escape'); assert.equal((await state(p)).appState, 'GAME_RECORD_LIBRARY');
        await p.evaluate(() => { __chess.openStoredGameReview('keyboard-review'); __chess.navigateGameReview(4); });
      });
      await check('repeated open/close and rapid separate Escape presses are handled once per layer', async () => {
        for (let i = 0; i < 3; i++) await keyboardDialog(p, '#btnGameReviewExport', 'repeated historical review');
        await p.locator('#btnGameReviewExport').click();
        await p.keyboard.press('Escape'); await closed(p);
        assert.equal((await state(p)).appState, 'GAME_REVIEW'); assert.equal((await state(p)).review.selectedPly, 4);
        // Once export has closed, a second distinct Escape retains the original review behavior.
        await p.keyboard.press('Escape'); assert.equal((await state(p)).appState, 'GAME_RECORD_LIBRARY');
        await p.evaluate(() => { __chess.openStoredGameReview('keyboard-review'); __chess.navigateGameReview(4); });
      });
      await check('existing continuation dialog still owns review keyboard and cancellation focus', async () => {
        const before = await state(p); await p.locator('#btnGameReviewContinue').click();
        // Buttons avoid native select navigation, which should remain available inside this dialog.
        await p.locator('#btnGameReviewContinuationCancel').focus();
        for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) { await p.keyboard.press(key); assert.deepEqual(await state(p), before); }
        await p.keyboard.press('Escape');
        await p.waitForFunction(() => !document.querySelector('#gameReviewContinuationDialog').open);
        assert.deepEqual(await state(p), before); assert.equal(await focused(p), 'btnGameReviewContinue');
      });
      await check('pending validation cancellation rejects retained reply; reopening downloads whole original game', async () => {
        const before = await state(p), count = downloads.length;
        await p.evaluate(() => keyboardQA.hold = true); await p.locator('#btnGameReviewExport').click();
        await p.locator('[data-export-format="json"]').focus(); await p.keyboard.press('Enter');
        await p.waitForFunction(() => keyboardQA.replies.length === 1);
        for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) { await p.keyboard.press(key); assert.deepEqual(await state(p), before); }
        await p.keyboard.press('Escape'); await closed(p);
        assert.deepEqual(await state(p), before); assert.equal(await focused(p), 'btnGameReviewExport');
        assert.deepEqual(await p.evaluate(() => keyboardQA.workers.map(w => ({ stopped: w.terminations, cleared: w.onmessage === null && w.onerror === null && w.onmessageerror === null }))), [{ stopped: 1, cleared: true }]);
        await p.evaluate(() => { for (const reply of keyboardQA.replies.splice(0)) { reply(); reply(); } keyboardQA.hold = false; });
        await p.waitForTimeout(150); assert.equal(downloads.length, count); assert.deepEqual(await state(p), before);
        await p.locator('#btnGameReviewExport').click(); const document = await downloadPair(p);
        assert.deepEqual(document.moves, reviewFixture.moves); assert.equal(document.playerSide, null); assert.equal(document.status, 'completed');
        assert.deepEqual(await state(p), before); await p.screenshot({ path: path.join(out, viewport.width + '-review-export.png') });
        await p.keyboard.press('Escape'); await closed(p); assert.deepEqual(await state(p), before);
      });
      await check('live-game export keyboard preserves Session and confirmed moves', async () => {
        await p.evaluate(() => { __chess.exitGameRecordFlow(); __chess.newGame(); __chess.setMode('pvp'); __chess.doMove({ r: 3, c: 4 }, { r: 4, c: 4 }); }); await idle(p);
        await keyboardDialog(p, '#btnGameExport', 'live game');
        const before = await state(p); await toolbar(p, '#btnGameExport'); const document = await downloadPair(p);
        assert.equal(document.status, 'in-progress'); assert.equal(document.moves.length, 1); assert.deepEqual(await state(p), before);
        await p.keyboard.press('Escape'); await closed(p);
      });
      await check('completed-game export keyboard preserves terminal state and memory record', async () => {
        await p.evaluate(d => { __chess.newGame(); __chess.setMode('hard'); __chess.resetTo(d.initialPosition.board, d.initialPosition.sideToMove); __chess.doMove(d.moves[0].from, d.moves[0].to); }, terminal()); await idle(p);
        await p.locator('#btnGameExportEnd').waitFor({ state: 'visible' });
        await keyboardDialog(p, '#btnGameExportEnd', 'completed game');
        const before = await state(p); await p.locator('#btnGameExportEnd').click(); const document = await downloadPair(p);
        assert.equal(document.status, 'completed'); assert.deepEqual(document.result, terminal().result); assert.deepEqual(await state(p), before);
        await p.keyboard.press('Escape'); await closed(p);
      });
      await check('existing board appearance dialog retains its native Escape behavior', async () => {
        await p.evaluate(() => __chess.newGame()); await idle(p); const before = await state(p);
        await toolbar(p, '#btnBoardAppearance'); await p.locator('#boardAppearanceClose').focus();
        await p.keyboard.press('Tab'); assert.equal(await focused(p), 'boardAppearanceChoose');
        await p.keyboard.press('Shift+Tab'); assert.equal(await focused(p), 'boardAppearanceClose');
        await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('#boardAppearanceDialog').open);
        assert.deepEqual(await state(p), before);
      });
    } catch (error) {
      results.push({ viewport, status: 'FAIL', error: error.stack }); console.error(error); process.exitCode = 1;
      await p.screenshot({ path: path.join(out, viewport.width + '-failure.png') });
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
} finally {
  clearTimeout(watchdog);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ url, chrome: browser.version(), results, errors, downloads: downloadIndex }, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
