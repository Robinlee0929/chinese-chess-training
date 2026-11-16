// Full Three.js browser QA. Fresh contexts, synthetic data, evidence outside checkout.
// PLAYWRIGHT_MODULE=... node tools/quick-start-browser-test.mjs SITE EVIDENCE_DIR
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { terminal } from './game-transfer-fixtures.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
assert.ok(out !== root && !out.startsWith(root + path.sep));
await mkdir(out, { recursive: false });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.resolve(site, '.' + pathname.replace(/\/$/, '/index.html'));
    assert.ok(file.startsWith(site + path.sep));
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' })[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], errors = [], warnings = [];
const watchdog = setTimeout(() => void browser.close(), 600000);
let currentPage;
const check = async (name, fn) => { const evidence = await fn(); results.push({ name, status: 'PASS', evidence }); console.log('PASS ' + name); };
const idle = async p => { await p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking); await p.waitForTimeout(1100); };
const action = async (p, id) => { if (!await p.locator(id).isVisible()) await p.locator('#btnMore').click(); await p.locator(id).click(); };
const state = p => p.evaluate(() => ({ board: __chess.board, history: __chess.history, turn: __chess.turn, mode: __chess.mode, side: __chess.humanSide, session: __chess.normalGameRecordSession, appState: __chess.appState, review: __chess.gameReview, editor: __chess.editorDraft, view: __chess.viewIdx, camera: __chess.camera.position.toArray(), local: { ...localStorage } }));
async function context(width, height) {
  const c = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const p = await c.newPage(); currentPage = p; p.setDefaultTimeout(20000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (['error', 'warning'].includes(m.type())) warnings.push(m.text()); });
  await p.goto(url); await idle(p);
  await p.waitForFunction(() => !document.querySelector('#btnGameExport').hidden && !document.querySelector('#btnBoardAppearance').disabled);
  return { c, p };
}
async function bounds(p) {
  const m = await p.evaluate(() => {
    const rect = id => { const b = document.getElementById(id).getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right }; };
    const body = document.getElementById('quickStartBody');
    return { dialog: rect('quickStartDialog'), close: rect('quickStartClose'), body: rect('quickStartBody'), scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth };
  });
  assert.ok(m.dialog.top >= 0 && m.dialog.bottom <= m.height && m.dialog.left >= 0 && m.dialog.right <= m.width, JSON.stringify(m));
  assert.ok(m.close.top >= 0 && m.close.bottom <= m.height); assert.ok(m.clientHeight > 60); assert.ok(m.pageWidth <= m.width, JSON.stringify(m));
  return m;
}
async function clickSquare(p, r, c) {
  const pt = await p.evaluate(({ r, c }) => {
    const x = __chess, box = x.renderer.domElement.getBoundingClientRect();
    const piece = x.pieces.find(m => m.userData.r === r && m.userData.c === c);
    const v = piece ? piece.position.clone() : x.camera.position.clone().set(c - 4, 0, 4.5 - r);
    v.y = piece ? .18 : 0; v.project(x.camera);
    return { x: box.x + (v.x + 1) * box.width / 2, y: box.y + (1 - v.y) * box.height / 2 };
  }, { r, c });
  await p.mouse.click(pt.x, pt.y);
}
async function help(p) { await action(p, '#btnHelp'); assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), true); assert.equal(await p.locator('#quickStartBody').evaluate(b => b.scrollTop), 0); }
async function exportDownload(p, selector, name) {
  const promise = p.waitForEvent('download'); await p.locator(selector).click();
  const download = await promise, file = path.join(out, name);
  await download.saveAs(file); assert.equal(await download.failure(), null); return file;
}
try {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1440, 1000]]) {
    const tag = `${width}x${height}`, { c, p } = await context(width, height);
    await check(tag + ' initial screen has no unsolicited help; WebGL renders', async () => {
      assert.equal(p.url(), url); assert.equal(await p.title(), '中國象棋殺局訓練 · Xiangqi Mate Puzzle');
      assert.ok(await p.locator('#stage canvas').isVisible()); assert.equal(await p.evaluate(() => __chess.pieces.length), 32);
      assert.ok(await p.evaluate(() => __chess.renderer.getContext() instanceof WebGL2RenderingContext));
      assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), false);
    });
    await p.locator('#modeSel').selectOption('pvp'); await idle(p);
    await clickSquare(p, 3, 4); await clickSquare(p, 4, 4); await idle(p);
    assert.equal(await p.evaluate(() => __chess.history.length), 1);
    await p.evaluate(() => {
      window.helpWrites = [];
      for (const method of ['setItem', 'removeItem', 'clear']) { const fn = Storage.prototype[method]; Storage.prototype[method] = function (...args) { helpWrites.push(['storage', method]); return fn.apply(this, args); }; }
      for (const method of ['add', 'put', 'delete', 'clear']) { const fn = IDBObjectStore.prototype[method]; IDBObjectStore.prototype[method] = function (...args) { helpWrites.push(['idb', method]); return fn.apply(this, args); }; }
    });
    const before = await state(p);
    await check(tag + ' student, teacher, full text and file guide are scrollable', async () => {
      await help(p); assert.equal(await p.locator('#quickStartStudent').getAttribute('aria-pressed'), 'true');
      assert.equal(await p.locator('#teacherQuickStart').isVisible(), false); await bounds(p);
      await p.screenshot({ path: path.join(out, tag + '-student.png') });
      for (const role of ['Student', 'Teacher']) {
        await p.locator('#quickStart' + role).click();
        const panel = p.locator('#' + role.toLowerCase() + 'QuickStart');
        for (const item of await panel.locator('li,p,h3,h4').all()) {
          await item.scrollIntoViewIfNeeded();
          assert.ok(await item.evaluate(el => { const b = el.getBoundingClientRect(), s = document.getElementById('quickStartBody').getBoundingClientRect(); return b.top >= s.top - 1 && b.bottom <= s.bottom + 1; }), await item.textContent());
        }
      }
      await p.locator('#quickStartFiles summary').click();
      await p.locator('#quickStartBody').evaluate(b => { b.scrollTop = b.scrollHeight; });
      const m = await bounds(p); assert.ok(m.scrollTop > 0); assert.ok(Math.abs(m.scrollHeight - m.clientHeight - m.scrollTop) < 2);
      await p.screenshot({ path: path.join(out, tag + '-files-bottom.png') });
      await p.locator('#quickStartTeacher').click(); await p.screenshot({ path: path.join(out, tag + '-teacher.png') });
      assert.deepEqual(await state(p), before); return m;
    });
    await check(tag + ' keyboard, Escape, close button and hidden focus safety', async () => {
      await p.locator('#quickStartClose').focus();
      for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
        await p.keyboard.press(key);
        assert.ok(await p.evaluate(() => { const el = document.activeElement; return el === document.body || (document.querySelector('#quickStartDialog').contains(el) && !!el.getClientRects().length && !el.closest('[hidden]')); }));
      }
      await p.keyboard.press('Escape'); assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), false);
      assert.equal(await p.locator('#btnHelp').getAttribute('aria-expanded'), 'false');
      assert.equal(await p.evaluate(() => document.activeElement.id), width <= 900 ? 'btnMore' : 'btnHelp');
      assert.deepEqual(await state(p), before); assert.deepEqual(await p.evaluate(() => helpWrites), []);
      await help(p); assert.equal(await p.locator('#quickStartStudent').getAttribute('aria-pressed'), 'true');
      await p.locator('#quickStartClose').click(); assert.ok(await p.locator(':focus').isVisible());
    });
    await check(tag + ' rapid close/reopen rejects old close focus; resize keeps close reachable', async () => {
      await help(p);
      await p.evaluate(() => { document.getElementById('quickStartClose').click(); document.getElementById('btnHelp').click(); });
      await p.waitForTimeout(100);
      assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), true);
      assert.equal(await p.evaluate(() => document.activeElement.id), 'quickStartHeading');
      for (const viewport of [{ width: 844, height: 390 }, { width: 320, height: 568 }, { width, height }]) { await p.setViewportSize(viewport); await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await bounds(p); }
      await p.keyboard.press('Escape'); assert.ok(await p.locator(':focus').isVisible());
      await idle(p);
    });
    await check(tag + ' return to board, U0 cancellation and single new session', async () => {
      await clickSquare(p, 6, 4); await clickSquare(p, 5, 4); await idle(p);
      assert.equal(await p.evaluate(() => __chess.history.length), 2);
      const saved = await state(p); await p.locator('#modeSel').selectOption('easy');
      assert.equal(await p.locator('#newGameConfirmDialog').evaluate(d => d.open), true);
      await p.keyboard.press('Escape'); assert.deepEqual(await state(p), saved);
      await p.locator('#btnNew').click(); await p.locator('#newGameConfirmDialog button').last().click(); await idle(p);
      assert.equal(await p.evaluate(() => __chess.history.length), 0);
      assert.notEqual((await state(p)).session.id, saved.session.id);
      assert.equal((await state(p)).session.modeRevision, saved.session.modeRevision + 1);
    });
    if (width === 390 || width === 1440) await check(tag + ' terminal completion during help returns focus to result, not hidden help', async () => {
      const game = terminal();
      await p.evaluate(game => __chess.resetTo(game.initialPosition.board, game.initialPosition.sideToMove), game);
      await help(p);
      // Synthetic legal completion arriving while the modal is open.
      await p.evaluate(move => __chess.doMove(move.from, move.to), game.moves[0]);
      await p.waitForFunction(() => !document.querySelector('#overlay').classList.contains('hidden'));
      assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), true);
      await p.keyboard.press('Escape');
      assert.ok(await p.evaluate(() => document.querySelector('#overlay').contains(document.activeElement) && document.activeElement.getClientRects().length > 0));
      assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), false);
    });
    await c.close();
  }

  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    const tag = width + '-workflow', { c, p } = await context(width, height);
    let puzzleFile, gameFile;
    await check(tag + ' teacher creates, records, saves and exports a legal mate through UI', async () => {
      await p.locator('#btnEditor').click(); await p.locator('#btnEditorClear').click();
      for (const [r, col, side, type] of [[0, 3, 'red', 'K'], [9, 4, 'black', 'K'], [8, 0, 'red', 'R'], [6, 8, 'red', 'R'], [5, 3, 'red', 'P']]) {
        await p.locator(`[data-editor-side="${side}"][data-editor-type="${type}"]`).click(); await clickSquare(p, r, col);
        assert.deepEqual(await p.evaluate(({ r, col }) => __chess.editorDraft.initialBoard[r][col], { r, col }), { side, type });
      }
      await p.locator('input[name="editorSide"][value="red"]').check();
      const draft = await state(p); await help(p); await p.locator('#quickStartTeacher').click(); await p.keyboard.press('Escape'); assert.deepEqual(await state(p), draft);
      await p.locator('#btnEditorConfirm').click(); await p.locator('#btnRecorderStart').click();
      await clickSquare(p, 6, 8); await clickSquare(p, 9, 8); await idle(p);
      await p.locator('#btnRecorderFinish').click(); await p.locator('#puzzleTitleInput').fill('U1b 合成一著殺局'); await p.locator('#btnSavePuzzle').click();
      await p.waitForFunction(() => document.querySelector('#savePuzzleMessage').textContent.includes('已儲存'));
      await p.locator('#btnOpenLibrary').click();
      assert.ok(await p.locator('#btnLibraryDetailExport').isVisible());
      await p.locator('#btnLibraryBack').click(); await p.locator('[data-library-action="view"]').click();
      puzzleFile = await exportDownload(p, '#btnLibraryDetailExport', tag + '-puzzle.json');
    });
    await c.close();
    const student = await context(width, height), q = student.p;
    await check(tag + ' student imports teacher puzzle and completes the recorded route', async () => {
      await q.locator('#btnLibrary').click(); await q.locator('#puzzleImportFile').setInputFiles(puzzleFile);
      await q.waitForFunction(() => !document.querySelector('#btnLibraryImportConfirm').disabled); await q.locator('#btnLibraryImportConfirm').click();
      await q.locator('[data-library-action="view"]').click(); await q.locator('#btnLibraryDetailPractice').click();
      await clickSquare(q, 6, 8); await clickSquare(q, 9, 8); await idle(q);
      assert.match(await q.locator('#practiceMessage').textContent(), /完成/);
      await q.locator('#btnPracticePuzzleExit').click();
    });
    await check(tag + ' student plays, undoes, uses teaching and downloads JSON/TXT', async () => {
      await q.locator('#modeSel').selectOption('easy'); await idle(q);
      await action(q, '#btnTeachingMode');
      if (await q.locator('#btnMore').getAttribute('aria-expanded') === 'true') await q.locator('#btnMore').click();
      await clickSquare(q, 3, 4); await clickSquare(q, 4, 4); await idle(q);
      assert.equal(await q.evaluate(() => __chess.history.length), 2);
      await q.locator('#btnUndo').click(); await idle(q); assert.equal(await q.evaluate(() => __chess.history.length), 0);
      await clickSquare(q, 3, 4); await clickSquare(q, 4, 4); await idle(q);
      await action(q, '#btnGameExport'); gameFile = await exportDownload(q, '[data-export-format="json"]', tag + '-game.json');
      await exportDownload(q, '[data-export-format="txt"]', tag + '-game.txt'); await q.keyboard.press('Escape');
    });
    await student.c.close();
    const review = await context(width, height), v = review.p;
    await check(tag + ' teacher imports full game, reviews each ply, opens help, then continues', async () => {
      await action(v, '#btnGameRecords'); await v.locator('#btnGameImport').click(); await v.locator('#gameImportFile').setInputFiles(gameFile);
      await v.waitForFunction(() => !document.querySelector('#gameImportConfirm').disabled); await v.locator('#gameImportConfirm').click();
      await v.locator('#btnGameReviewNext').click(); assert.equal(await v.evaluate(() => __chess.gameReview.selectedPly), 1);
      await v.locator('#btnGameReviewNext').click(); assert.equal(await v.evaluate(() => __chess.gameReview.selectedPly), 2);
      await v.locator('#btnGameReviewPrevious').click(); await idle(v);
      const before = await state(v); await help(v); await v.locator('#quickStartTeacher').click();
      for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']) await v.keyboard.press(key);
      assert.deepEqual(await state(v), before);
      await v.locator('#btnGameReviewContinue').click(); await v.locator('#gameReviewContinuationDifficulty').selectOption('easy');
      await v.locator('#gameReviewContinuationHumanSide').selectOption('black');
      await v.locator('#gameReviewContinuationForm button[type="submit"]').click(); await idle(v);
      assert.equal(await v.evaluate(() => __chess.appState), 'NORMAL_GAME');
      assert.deepEqual((await state(v)).session.initialPosition, { board: before.review.snapshot.board, sideToMove: before.review.snapshot.sideToMove });
      assert.deepEqual((await state(v)).history, []);
    });
    await review.c.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(warnings, []);
} catch (error) {
  results.push({ name: 'failure', status: 'FAIL', error: error.stack }); process.exitCode = 1; console.error(error);
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
} finally {
  clearTimeout(watchdog);
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ url, chrome: browser.version(), results, errors, warnings, realUserAndPhoneUAT: 'NOT_TESTED' }, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
