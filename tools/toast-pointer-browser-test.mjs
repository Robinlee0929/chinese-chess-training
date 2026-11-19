// Full Three.js/WebGL, isolated Chrome contexts, real pointer input.
// node tools/toast-pointer-browser-test.mjs SITE OUT [--negative]
// --negative restores only the old toast hit-testing in the served CSS.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const negative = process.argv.includes('--negative');
for (const source of [root, site]) assert.ok(out !== source && !out.startsWith(source + path.sep));
await mkdir(out, { recursive: false });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    const file = path.resolve(site, '.' + (name === '/' ? '/index.html' : name));
    assert.ok(file.startsWith(site + path.sep));
    let body = await readFile(file);
    if (negative && name === '/css/style.css') body = Buffer.concat([body,
      Buffer.from('\n#toast { pointer-events: auto !important; }\n')]);
    res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.html': 'text/html',
      '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' })[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const idle = async p => {
  await p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking
    && __chess.pieces.every(m => Math.abs(m.position.y - .18) < 1e-8));
  await p.waitForTimeout(400);
};
const state = p => p.evaluate(() => ({ board: __chess.board, history: __chess.history,
  session: __chess.normalGameRecordSession, turn: __chess.turn, mode: __chess.mode,
  appState: __chess.appState, over: __chess.over }));
const point = (p, r, c, y = .36) => p.evaluate(({ r, c, y }) => {
  const x = __chess, b = x.renderer.domElement.getBoundingClientRect();
  const v = x.camera.position.clone().set(c - 4, y, 4.5 - r).project(x.camera);
  return { x: b.x + (v.x + 1) * b.width / 2, y: b.y + (1 - v.y) * b.height / 2 };
}, { r, c, y });
const input = (p, modality, q) => modality === 'touch'
  ? p.touchscreen.tap(q.x, q.y) : p.mouse.click(q.x, q.y);
const storage = p => p.evaluate(async () => {
  const databases = [];
  for (const info of await indexedDB.databases()) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(info.name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const stores = {};
    for (const name of db.objectStoreNames) {
      stores[name] = await new Promise((resolve, reject) => {
        const req = db.transaction(name).objectStore(name).getAll();
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
    }
    databases.push({ name: info.name, version: info.version, stores }); db.close();
  }
  return { local: { ...localStorage }, databases };
});
function sameStorage(a, b) {
  const protectedLocal = x => Object.fromEntries(Object.entries(x.local).filter(([k]) => k !== 'xiangqi.viewPrefs.v1'));
  assert.deepEqual(protectedLocal(b), protectedLocal(a), 'PROTECTED_LOCAL_STORAGE');
  assert.deepEqual(b.databases, a.databases, 'INDEXEDDB_PRESERVED');
}
const toastAt = (p, q) => p.evaluate(q => {
  const e = document.getElementById('toast'), b = e.getBoundingClientRect(), style = getComputedStyle(e);
  return { text: e.textContent, role: e.getAttribute('role'), visible: !e.classList.contains('hidden'),
    opacity: style.opacity, pointerEvents: style.pointerEvents,
    rect: { x: b.x, y: b.y, width: b.width, height: b.height },
    hit: document.elementFromPoint(q.x, q.y)?.id || document.elementFromPoint(q.x, q.y)?.tagName,
    overlaps: q.x >= b.x && q.x <= b.right && q.y >= b.y && q.y <= b.bottom };
}, q);

try {
  const sizes = negative ? [[844, 390]] : [[320, 568], [375, 812], [390, 844], [844, 390]];
  for (const [width, height] of sizes) for (const modality of ['touch', 'mouse']) {
    const c = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
    const p = await c.newPage(), errors = [], r = { size: [width, height], modality, negative };
    p.on('pageerror', e => errors.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      await p.goto(url); await idle(p);
      assert.match(await p.title(), /象棋/); assert.ok(await p.locator('canvas').count());
      await p.locator('#modeSel').selectOption('pvp'); await idle(p);
      await input(p, modality, await point(p, 3, 4));
      await input(p, modality, await point(p, 4, 4, 0)); await idle(p);
      assert.equal((await state(p)).history.length, 1);
      // Use the original UI camera flow. The final change shows the real toast.
      for (let i = 0; i < 5 && await p.evaluate(() => __chess.viewIdx) !== 4; i++) {
        if (!await p.locator('#btnView').isVisible()) await p.locator('#btnMore').click();
        await p.locator('#btnView').click(); await idle(p);
      }
      if (await p.locator('#btnMore').getAttribute('aria-expanded') === 'true') await p.locator('#btnMore').click();
      assert.equal(await p.evaluate(() => __chess.viewIdx), 4);
      await p.waitForFunction(() => Math.abs(__chess.camera.position.x) < 1e-6 && __chess.camera.position.z < -12);
      r.point = await point(p, 9, 4); r.point.y += 4;
      r.before = await state(p); r.storageBefore = await storage(p); r.toast = await toastAt(p, r.point);
      assert.equal(r.toast.visible, true); assert.equal(r.toast.opacity, '1');
      assert.equal(r.toast.text, '視角：黑方在下'); assert.equal(r.toast.role, 'status');
      if (height === 390) assert.equal(r.toast.overlaps, true, 'ORIGINAL_F4_OVERLAP_REQUIRED');
      await p.evaluate(() => {
        window.toastPointerTrace = [];
        for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, e => {
          toastPointerTrace.push({ type, x: e.clientX, y: e.clientY, target: e.target.id || e.target.tagName,
            pointerType: e.pointerType, pointerId: e.pointerId, time: e.timeStamp });
        }, true);
      });
      await input(p, modality, r.point);
      r.selected = await p.evaluate(() => __chess.selected); r.events = await p.evaluate(() => toastPointerTrace);
      r.afterSelection = await state(p); r.toastAfterSelection = await toastAt(p, r.point);
      await p.screenshot({ path: path.join(out, `${width}x${height}-${modality}-selection.png`) });
      // Assert the real selection and delivered events before inspecting CSS.
      assert.deepEqual(r.selected, { r: 9, c: 4 }, 'TOAST_MUST_NOT_INTERCEPT_PIECE');
      assert.equal(r.events.filter(e => e.type === 'click').at(-1)?.target, 'CANVAS', 'CLICK_REACHED_CANVAS');
      assert.equal(r.toastAfterSelection.visible, true); assert.equal(r.toastAfterSelection.text, r.toast.text);
      assert.deepEqual(r.afterSelection, r.before, 'SELECTION_PRESERVES_GAME_AND_SESSION');
      sameStorage(r.storageBefore, await storage(p));
      assert.equal(r.toast.pointerEvents, 'none');
      r.target = await point(p, 8, 4, 0);
      assert.equal((await toastAt(p, r.target)).visible, true);
      await input(p, modality, r.target); await idle(p); r.afterMove = await state(p);
      const expectedBoard = structuredClone(r.before.board);
      expectedBoard[8][4] = expectedBoard[9][4]; expectedBoard[9][4] = null;
      assert.deepEqual(r.afterMove.board, expectedBoard, 'EXACT_LEGAL_MOVE');
      assert.equal(r.afterMove.history.length, 2); assert.deepEqual(r.afterMove.history[0], r.before.history[0]);
      assert.equal(r.afterMove.session.id, r.before.session.id);
      assert.equal(r.afterMove.session.modeRevision, r.before.session.modeRevision);
      assert.equal((await toastAt(p, r.target)).visible, true, 'MOVE_COMPLETED_WHILE_TOAST_VISIBLE');
      sameStorage(r.storageBefore, await storage(p));
      // Exempt only the noninteractive toast; a real modal must still stop the board.
      await p.locator('#btnNew').click(); await p.locator('#newGameConfirmDialog').waitFor({ state: 'visible' });
      const beforeModalInput = await state(p), canvas = p.locator('#stage canvas');
      const box = await canvas.boundingBox(); await input(p, modality, { x: box.x + 3, y: box.y + 3 });
      assert.deepEqual(await state(p), beforeModalInput, 'MODAL_BLOCKS_BACKGROUND');
      await p.keyboard.press('Escape'); await p.locator('#newGameConfirmDialog').waitFor({ state: 'hidden' });
      assert.deepEqual(await state(p), beforeModalInput, 'ESC_PRESERVES_GAME');
      assert.equal(await p.evaluate(() => document.activeElement.id), 'btnNew');
      await p.waitForFunction(() => document.getElementById('toast').classList.contains('hidden'));
      assert.equal(await p.locator('#toast').getAttribute('role'), 'status');
      sameStorage(r.storageBefore, await storage(p));
      assert.deepEqual(errors, []); r.status = 'PASS';
      if (negative) throw new Error('NEGATIVE_CONTROL_NOT_DETECTED');
    } catch (e) {
      r.error = e.stack;
      const expected = negative && e instanceof assert.AssertionError && /TOAST_MUST_NOT_INTERCEPT_PIECE/.test(e.message);
      if (expected) {
        assert.equal(r.selected, null); assert.equal(r.toast.hit, 'toast');
        assert.equal(r.events.filter(e => e.type === 'click').at(-1)?.target, 'toast');
        assert.deepEqual(r.afterSelection, r.before); assert.deepEqual(errors, []);
        r.status = 'EXPECTED_FAIL_DETECTED';
      } else { r.status = 'FAIL'; process.exitCode = 1; }
    } finally {
      r.errors = errors; results.push(r);
      await writeFile(path.join(out, 'result.json'), JSON.stringify({ url, chrome: browser.version(),
        note: 'Chrome mouse and simulated touch, not real-phone or screen-reader UAT', negative, results }, null, 2));
      console.log(JSON.stringify({ size: r.size, modality, status: r.status, error: r.status === 'FAIL' ? r.error : undefined }));
      await c.close();
    }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
