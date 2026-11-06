// Localhost, synthetic photos and isolated browser contexts only.
// Browser skill is not installed; reuse the repository's Playwright/Chrome path.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.BOARD_APPEARANCE_EVIDENCE_DIR, 'Evidence directory required');
const output = path.resolve(process.env.BOARD_APPEARANCE_EVIDENCE_DIR);
assert.ok(output !== root && !output.startsWith(root + path.sep), 'Keep evidence outside checkout');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const prefix = '/chinese-chess-training/';
const baselineHTML = execFileSync('git', ['show', 'a033d7fd7b94369afb1b530a7a827ecf25a8454c:index.html'], { cwd: root });
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
  const file = path.resolve(root, pathname.slice(prefix.length) || 'index.html');
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    let body = await readFile(file);
    // Test-only observation, never shipped in the production main module.
    if (file === path.join(root, 'main.js')) body = Buffer.from(body.toString() + '\nwindow.__boardSurfaceQA = { surface: boardSurface, mesh: boardMesh };\n');
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[path.extname(file)] || 'text/plain' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${prefix}`;
let browser;
const results = [];
const write = (name, value) => writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
async function toolbar(p, id) {
  if (!await p.locator(id).isVisible()) await p.locator('#btnMore').click();
  await p.locator(id).click();
}
const idle = p => p.waitForFunction(() => document.getElementById('boardAppearanceDialog').getAttribute('aria-busy') === 'false');
const open = async p => { await toolbar(p, '#btnBoardAppearance'); await p.locator('#boardAppearanceDialog').waitFor({ state: 'visible' }); };
const close = p => p.locator('#boardAppearanceClose').click();
const signature = p => p.evaluate(() => __boardSurfaceQA.surface.canvas.toDataURL());
const game = p => p.evaluate(() => JSON.stringify({ board: __chess.board, history: __chess.history, turn: __chess.turn, session: __chess.normalGameRecordSession }));
const saved = p => p.evaluate(async () => {
  const { createBoardAppearanceStore } = await import('./board-appearance-store.js');
  const s = createBoardAppearanceStore();
  try { const r = await s.load(); return r ? { version: r.version, size: r.blob.size, type: r.blob.type, settings: r.settings } : null; }
  finally { s.dispose(); }
});
async function fixture(p, type = 'image/png', width = 1600, height = 900, color = '#006d77') {
  const data = await p.evaluate(async ({ type, width, height, color }) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, width, height);
    g.fillStyle = '#e9c46a'; g.beginPath(); g.arc(width * .2, height * .28, height * .16, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#83c5be'; g.beginPath(); g.moveTo(0, height); g.lineTo(width * .45, height * .35); g.lineTo(width, height); g.fill();
    return c.toDataURL(type, .9).split(',')[1];
  }, { type, width, height, color });
  return { name: 'synthetic.' + type.split('/')[1], mimeType: type, buffer: Buffer.from(data, 'base64') };
}
async function upload(p, file) { await p.locator('#boardAppearanceFile').setInputFiles(file); await idle(p); }
const shareCard = async p => createHash('sha256').update(await p.evaluate(async () => (await __chess.buildShareCard({ cardTitle: '測試', cardSub: '本機合成', reasonChars: ['將', '死'], plies: 2, secs: 3, caps: 0, undoCount: 0, pure: true })).toDataURL())).digest('hex');

try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  await write('environment', { url, chrome: browser.version(), browserPath: 'Browser skill unavailable; existing Playwright', realMobile: false });
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport }), p = await context.newPage(), errors = [], requests = [];
    p.setDefaultTimeout(20000);
    p.on('pageerror', error => errors.push(error.message));
    p.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    p.on('request', request => requests.push({ method: request.method(), url: request.url() }));
    await context.addInitScript(() => {
      window.__appearanceQA = { opened: 0, closed: 0, liveURLs: [], hold: false, release: null,
        holdSave: false, releaseSave: null, inputBeforeSave: null, failSave: false, failClear: false };
      const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
      Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...complete, set(fn) {
        const tx = this;
        complete.set.call(this, function (event) {
          if (__appearanceQA.holdSave && tx.db.name === 'chinese-chess-training:board-appearance' && tx.mode === 'readwrite') {
            __appearanceQA.holdSave = false;
            __appearanceQA.releaseSave = () => { __appearanceQA.releaseSave = null; fn.call(tx, event); };
          } else fn.call(tx, event);
        });
      } });
      const nativeBitmap = window.createImageBitmap.bind(window);
      window.createImageBitmap = async (...args) => {
        const bitmap = await nativeBitmap(...args); __appearanceQA.opened++;
        const close = bitmap.close.bind(bitmap); let closed = false;
        bitmap.close = () => { if (!closed) { __appearanceQA.closed++; closed = true; } close(); };
        if (__appearanceQA.hold) { __appearanceQA.hold = false; await new Promise(resolve => { __appearanceQA.release = resolve; }); }
        return bitmap;
      };
      const put = IDBObjectStore.prototype.put, del = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.put = function (...args) {
        if (__appearanceQA.failSave && this.transaction.db.name === 'chinese-chess-training:board-appearance') throw new DOMException('injected quota', 'QuotaExceededError');
        return put.apply(this, args);
      };
      IDBObjectStore.prototype.delete = function (...args) {
        if (__appearanceQA.failClear && this.transaction.db.name === 'chinese-chess-training:board-appearance') throw new DOMException('injected failure', 'UnknownError');
        return del.apply(this, args);
      };
    });
    const result = { label, checks: [], status: 'RUNNING' };
    try {
      await p.goto(url); await p.waitForFunction(() => !!window.__boardSurfaceQA && !!window.__chess?.board);
      await p.evaluate(() => document.fonts.ready);
      assert.equal(new URL(p.url()).origin, new URL(url).origin); assert.match(await p.title(), /中國象棋/);
      assert.equal(await p.locator('#stage canvas').count(), 1);
      await p.locator('#modeSel').selectOption('pvp');
      await p.waitForTimeout(1600);
      const initial = await game(p), wood = await signature(p), defaultShare = await shareCard(p);
      await p.evaluate(() => localStorage.setItem('appearance-isolation-sentinel', 'unchanged'));
      const localBefore = await p.evaluate(() => JSON.stringify({ ...localStorage }));
      const png = await fixture(p), jpeg = await fixture(p, 'image/jpeg'), webp = await fixture(p, 'image/webp');
      await open(p); assert.equal(await p.locator('#boardAppearanceRemember').isChecked(), false);
      for (const file of [png, jpeg, webp]) { await upload(p, file); assert.notEqual(await signature(p), wood); }
      assert.equal(await saved(p), null); assert.equal(await game(p), initial);
      assert.equal(await p.evaluate(() => JSON.stringify({ ...localStorage })), localBefore);
      result.checks.push('page identity/content/console; JPEG PNG WebP; session default; unchanged game/localStorage');

      await p.locator('#boardAppearanceopacity').focus(); await p.keyboard.press('End');
      await p.locator('#boardAppearancex').focus(); await p.keyboard.press('End'); await p.keyboard.press('Tab');
      await p.waitForTimeout(150);
      assert.equal(await p.locator('#boardAppearanceopacity').inputValue(), '100');
      assert.equal(await p.locator('#boardAppearancex').inputValue(), '100');
      const custom = await signature(p);
      await p.screenshot({ path: path.join(output, `${label}-appearance.png`), fullPage: true });
      await close(p);
      assert.equal(await shareCard(p), defaultShare, 'Real share card excludes photo pixel-for-pixel');
      assert.equal(await signature(p), custom, 'Share restores live photo');
      const restoredAfterFailure = await p.evaluate(async () => {
        const before = __boardSurfaceQA.surface.canvas.toDataURL();
        const original = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          if (this.canvas.width === 1080 && args[0] === __chess.renderer.domElement) throw Error('capture failed');
          return original.apply(this, args);
        };
        let rejected = false;
        try { await __chess.buildShareCard({ cardTitle: '', cardSub: '', reasonChars: ['將','死'], plies: 0, secs: 0, caps: 0, undoCount: 0 }); }
        catch { rejected = true; } finally { CanvasRenderingContext2D.prototype.drawImage = original; }
        return rejected && before === __boardSurfaceQA.surface.canvas.toDataURL();
      });
      assert.equal(restoredAfterFailure, true);
      result.checks.push('keyboard opacity/crop; default-only share and exception restoration');

      await open(p);
      await p.evaluate(() => { __appearanceQA.failSave = true; }); await p.locator('#boardAppearanceRemember').check();
      await p.waitForFunction(() => document.getElementById('boardAppearanceStatus').textContent.includes('無法確認保存'));
      assert.equal(await saved(p), null); assert.equal(await signature(p), custom);
      await p.evaluate(() => { __appearanceQA.failSave = false; }); await p.locator('#boardAppearanceRetry').click();
      await p.waitForFunction(() => document.getElementById('boardAppearancePersistence').textContent.includes('已在'));
      const record = await saved(p); assert.equal(record.type, 'image/jpeg'); assert.ok(record.size <= 2 * 1024 * 1024); assert.equal(record.settings.opacity, 1);
      await p.reload(); await p.waitForFunction(() => !!window.__boardSurfaceQA);
      await open(p); await p.waitForFunction(() => document.getElementById('boardAppearanceRemember').checked);
      assert.equal(await p.locator('#boardAppearanceopacity').inputValue(), '100');
      const restored = await signature(p); assert.notEqual(restored, wood);
      const beforeBad = await signature(p);
      await upload(p, { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
      assert.equal(await signature(p), beforeBad); assert.match(await p.locator('#boardAppearanceStatus').innerText(), /無效/);
      await p.evaluate(() => { __appearanceQA.failClear = true; }); await p.locator('#boardAppearanceReset').click();
      await p.waitForFunction(() => document.getElementById('boardAppearanceStatus').textContent.includes('下次'));
      assert.notEqual(await saved(p), null);
      await p.evaluate(() => { __appearanceQA.failClear = false; }); await p.locator('#boardAppearanceRetry').click();
      await p.waitForFunction(() => document.getElementById('boardAppearanceStatus').textContent.includes('已移除'));
      assert.equal(await saved(p), null);
      result.checks.push('native IDB save failure/retry/reload/settings; bad photo preservation; clear failure/retry');

      result.saveRaces = [];
      for (const completion of ['before-debounce', 'after-debounce']) {
        await upload(p, png);
        await p.locator('#boardAppearanceopacity').scrollIntoViewIfNeeded();
        await p.evaluate(() => { __appearanceQA.holdSave = true; });
        await p.locator('#boardAppearanceRemember').check();
        await p.waitForFunction(() => !!__appearanceQA.releaseSave);
        await p.evaluate(completion => {
          const input = document.getElementById('boardAppearanceopacity');
          input.addEventListener('input', () => {
            __appearanceQA.inputBeforeSave = input.value;
            if (completion === 'before-debounce') queueMicrotask(() => __appearanceQA.releaseSave?.());
          }, { once: true });
        }, completion);
        await p.locator('#boardAppearanceopacity').scrollIntoViewIfNeeded();
        const box = await p.locator('#boardAppearanceopacity').boundingBox();
        await p.mouse.move(box.x + box.width * .9, box.y + box.height / 2);
        await p.mouse.down();
        await p.waitForTimeout(150);
        if (completion === 'after-debounce') await p.evaluate(() => __appearanceQA.releaseSave());
        await p.waitForFunction(() => !__appearanceQA.releaseSave);
        const latest = await p.evaluate(() => __appearanceQA.inputBeforeSave);
        assert.ok(Number(latest) >= 90, 'Real pointer enters a newer value above 50%');
        assert.equal(await p.locator('#boardAppearanceopacity').inputValue(), latest);
        assert.match(await p.locator('#boardAppearancePersistence').innerText(), /尚未保存/);
        assert.equal((await saved(p)).settings.opacity, .5, 'Earlier real transaction saved only 50%');
        await p.mouse.up();
        await p.waitForFunction(() => document.getElementById('boardAppearancePersistence').textContent.includes('已在'));
        const current = await saved(p);
        assert.equal(current.settings.opacity, Number(latest) / 100);
        result.saveRaces.push({ completion, input: Number(latest), storedBefore: .5, storedAfter: current.settings.opacity, status: 'PASS' });
        await p.locator('#boardAppearanceReset').click();
        await p.waitForFunction(() => document.getElementById('boardAppearanceStatus').textContent.includes('已移除'));
      }
      result.checks.push('P2: old 50% completion before/after debounce cannot overwrite newer pointer input or claim it saved; latest native IDB save matches');

      await p.evaluate(() => { __appearanceQA.hold = true; });
      await p.locator('#boardAppearanceFile').setInputFiles(png);
      await p.waitForFunction(() => !!__appearanceQA.release); await p.locator('#boardAppearanceReset').click();
      const resetImage = await signature(p);
      await p.evaluate(() => { __appearanceQA.release(); __appearanceQA.release = null; });
      await p.waitForFunction(() => __appearanceQA.opened === __appearanceQA.closed);
      assert.equal(await signature(p), resetImage);
      result.checks.push('reset while native bitmap decode is pending; obsolete bitmap closed');

      // Exercise the native Image/Object URL path too, without a new dependency.
      const fallback = await p.evaluate(async data => {
        const { prepareBoardPhoto } = await import('./board-appearance.js');
        const bitmap = window.createImageBitmap, create = URL.createObjectURL, revoke = URL.revokeObjectURL;
        const live = new Set(); let opened = 0;
        URL.createObjectURL = blob => { const url = create.call(URL, blob); live.add(url); opened++; return url; };
        URL.revokeObjectURL = url => { live.delete(url); return revoke.call(URL, url); };
        window.createImageBitmap = undefined;
        try {
          const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
          const asset = await prepareBoardPhoto(new Blob([bytes], { type: 'image/png' }));
          const dimensions = [asset.image.width, asset.image.height]; asset.dispose();
          return { dimensions, released: asset.image.width === 1, opened, live: live.size };
        } finally { window.createImageBitmap = bitmap; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
      }, png.buffer.toString('base64'));
      assert.deepEqual(fallback, { dimensions: [1600, 900], released: true, opened: 1, live: 0 });
      for (const [width, height] of [[8192, 1], [1, 8192]]) {
        await upload(p, await fixture(p, 'image/png', width, height));
        await p.locator('#boardAppearanceFit').selectOption('contain');
        assert.match(await p.locator('#boardAppearanceStatus').innerText(), /照片已套用/);
      }
      result.checks.push('native Image fallback revokes Object URL and disposes canvas; extreme aspect ratios in contain mode');

      await upload(p, png); await close(p);
      const background = await signature(p);
      await p.locator('#modeSel').selectOption('pvp');
      await p.locator('#btnNew').click(); assert.equal(await signature(p), background);
      // Use the existing fixture hook for board setup; user-facing undo/review use real buttons.
      await p.evaluate(() => __chess.doMove({ r: 3, c: 0 }, { r: 4, c: 0 }));
      await p.waitForFunction(() => __chess.history.length === 1 && !__chess.busy);
      await p.locator('#btnUndo').click();
      assert.equal(await p.evaluate(() => __chess.history.length), 0); assert.equal(await signature(p), background);
      await p.evaluate(() => {
        const b = Array.from({ length: 10 }, () => Array(9).fill(null));
        for (const [side, type, r, c] of [['red','K',0,3], ['black','K',9,4], ['red','R',8,8], ['red','R',7,0]]) b[r][c] = { side, type };
        __chess.resetTo(b, 'red'); __chess.doMove({ r: 7, c: 0 }, { r: 9, c: 0 });
      });
      await p.locator('#btnReviewGame').waitFor({ state: 'visible' }); await p.locator('#btnReviewGame').click();
      await p.locator('#gameReviewHeading').waitFor({ state: 'visible' });
      assert.equal(await signature(p), background);
      await p.keyboard.press('Escape'); await p.locator('#overlay').waitFor({ state: 'visible' });
      await p.locator('#btnAgain').click(); assert.equal(await signature(p), background);
      result.checks.push('normal move/undo; completed game review and Again retain background');
      await toolbar(p, '#btnView'); await p.waitForTimeout(700); assert.equal(await signature(p), background);
      if (await p.locator('#btnMore').getAttribute('aria-expanded') === 'true') await p.locator('#btnMore').click();
      await p.locator('#btnEditor').click();
      await p.locator('#photoFileInput').setInputFiles(png);
      await p.waitForFunction(() => document.getElementById('photoPreviewImage').naturalWidth > 0);
      await p.locator('#btnPhotoRotateRight').click(); await p.locator('#btnPhotoRemove').click();
      await p.locator('#btnEditorExit').click();
      assert.equal(await signature(p), background);
      await toolbar(p, '#btnSavedPositions'); await p.locator('#savedPositionsDialog').waitFor({ state: 'visible' });
      await p.locator('#savedPositionsClose').click(); assert.equal(await signature(p), background);
      result.checks.push('new game/view/editor/photo reference import-rotate-remove/saved positions retain background');

      if (label === 'desktop') {
        await open(p);
        const baseline = await p.evaluate(() => ({ ...__chess.renderer.info.memory }));
        for (let i = 0; i < 100; i++) { await upload(p, i % 2 ? jpeg : png); await p.locator('#boardAppearanceReset').click(); }
        await p.waitForTimeout(100);
        assert.deepEqual(await p.evaluate(() => ({ ...__chess.renderer.info.memory })), baseline);
        assert.equal(await p.evaluate(() => __appearanceQA.opened - __appearanceQA.closed), 0);
        result.checks.push('100 real upload/reset cycles: stable WebGL texture/geometry count and zero live ImageBitmap');
        const large = await fixture(p, 'image/jpeg', 4000, 2000);
        const samples = [];
        for (let i = 0; i < 10; i++) {
          const start = performance.now(); await upload(p, large);
          await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          samples.push(performance.now() - start);
        }
        result.upload8MPSamplesMs = samples;
        result.upload8MPP95Ms = [...samples].sort((a,b) => a-b)[Math.ceil(samples.length * .95)-1];
        assert.ok(result.upload8MPP95Ms < 2000, 'Desktop 8MP upload-to-frame opportunity p95 under 2s');
        await close(p);
      }
      await p.screenshot({ path: path.join(output, `${label}-board.png`), fullPage: true });
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      assert.deepEqual(requests.filter(r => r.method !== 'GET'), []);
      result.status = 'PASS'; result.errors = errors;
    } catch (error) {
      result.status = 'FAIL'; result.error = error.stack;
      await p.screenshot({ path: path.join(output, `${label}-FAIL.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally { results.push(result); await write('summary', results); await context.close(); }
  }
  // A stale or partially updated entry page must still initialize and play a game.
  const compatibility = [];
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const missing of ['old-html', 'boardAppearancePreview', 'boardAppearanceSettings', 'boardAppearanceClose']) {
      const context = await browser.newContext({ viewport }), p = await context.newPage(), errors = [];
      const result = { label, missing, status: 'RUNNING' };
      p.setDefaultTimeout(20000);
      p.on('pageerror', error => errors.push(error.message));
      p.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
      try {
        await context.addInitScript(() => {
          window.__appearanceOpenCount = 0;
          const open = indexedDB.open.bind(indexedDB);
          indexedDB.open = (name, ...args) => {
            if (name === 'chinese-chess-training:board-appearance') __appearanceOpenCount++;
            return open(name, ...args);
          };
        });
        const html = missing === 'old-html' ? baselineHTML
          : Buffer.from((await readFile(path.join(root, 'index.html'), 'utf8')).replace(`id="${missing}"`, `id="missing-${missing}"`));
        await p.route(url, route => route.fulfill({ contentType: 'text/html', body: html }));
        await p.goto(url);
        await p.waitForFunction(() => window.__chess?.pieces?.length === 32);
        assert.equal(await p.evaluate(() => __appearanceOpenCount), 0, 'Disabled appearance must not restore a remembered photo');
        if (missing !== 'old-html') assert.equal(await p.locator('#btnBoardAppearance').isDisabled(), true);
        // Default wood gradient at an unmarked corner, not a restored photograph.
        const corner = await p.evaluate(() => [...__boardSurfaceQA.surface.canvas.getContext('2d').getImageData(0, 0, 1, 1).data]);
        assert.ok(corner[0] > 180 && corner[1] > 140 && corner[0] > corner[1] && corner[1] > corner[2]);
        await p.locator('#modeSel').selectOption('pvp'); await p.waitForTimeout(1600);
        const square = async (r, c, piece) => {
          const pt = await p.evaluate(({ r, c, piece }) => {
            const x = __chess, box = x.renderer.domElement.getBoundingClientRect();
            const v = x.camera.position.clone().set(c - 4, piece ? .18 : 0, 4.5 - r).project(x.camera);
            return { x: box.x + (v.x + 1) * box.width / 2, y: box.y + (1 - v.y) * box.height / 2 };
          }, { r, c, piece });
          await p.mouse.click(pt.x, pt.y);
        };
        await square(3, 4, true);
        assert.deepEqual(await p.evaluate(() => __chess.selected), { r: 3, c: 4 });
        await square(4, 4, false);
        await p.waitForFunction(() => __chess.history.length === 1 && !__chess.busy);
        assert.equal(await p.evaluate(() => __chess.board[4][4]?.side), 'red');
        assert.deepEqual(errors, []);
        await p.screenshot({ path: path.join(output, `${label}-${missing}.png`) });
        result.status = 'PASS'; result.pieces = 32; result.plies = 1; result.errors = errors;
      } catch (error) { result.status = 'FAIL'; result.error = error.stack; throw error; }
      finally { compatibility.push(result); await write('compatibility', compatibility); await context.close(); }
    }
  }
} finally { await browser?.close(); server.close(); }
console.log(JSON.stringify(results, null, 2));
