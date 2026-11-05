// Real localhost UI + IndexedDB. Fixtures are synthetic and contexts disposable.
// Run with PLAYWRIGHT_MODULE, CHROME_PATH and SAVE_CURRENT_EVIDENCE_DIR.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { capacityFixture } from './idb-capacity-fixture.mjs';
import { validateCustomPositionEnvelope } from '../custom-position-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.env.SAVE_CURRENT_EVIDENCE_DIR, 'Evidence directory required');
const output = path.resolve(process.env.SAVE_CURRENT_EVIDENCE_DIR);
assert.ok(!output.startsWith(root + path.sep));
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[path.extname(file)] || 'text/plain');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port + '/';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
const write = (name, value) => writeFile(path.join(output, name), JSON.stringify(value, null, 2));
const idle = p => p.waitForFunction(() => {
  const dialog = document.getElementById('savedPositionsDialog');
  return !dialog.open || dialog.getAttribute('aria-busy') === 'false';
});
async function toolbar(p, id) {
  if (!await p.locator(id).isVisible()) await p.locator('#btnMore').click();
  await p.locator(id).click();
}
async function saveDialog(p) { await toolbar(p, '#btnSaveCurrentPosition'); await idle(p); }
async function manager(p) { await toolbar(p, '#btnSavedPositions'); await idle(p); }
async function submit(p) { await p.locator('#savedPositionSubmit').click(); await idle(p); }
const game = p => p.evaluate(() => ({
  board: __chess.board, turn: __chess.turn, history: __chess.history,
  session: __chess.normalGameRecordSession, mode: __chess.mode, humanSide: __chess.humanSide,
  completed: __chess.lastCompletedGameRecord,
  records: localStorage.getItem('chinese-chess-training:game-records:v1'),
}));
const read = p => p.evaluate(async () => {
  const { createCustomPositionIDB } = await import('./custom-position-idb.js');
  const adapter = createCustomPositionIDB({ initializeEmpty: false });
  try { const r = await adapter.read(); if (!r.ok) throw Error(r.code); return r.snapshot; }
  finally { adapter.dispose(); }
});
async function move(p) {
  // Choose a legal move using the existing engine, then deliver real pointer input.
  const chosen = await p.evaluate(async () => {
    const { legalMoves } = await import('./game.js');
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      if (__chess.board[r][c]?.side !== __chess.turn) continue;
      const moves = legalMoves(__chess.board, r, c);
      if (moves.length) return { from: { r, c }, to: moves[0] };
    }
  });
  assert.ok(chosen);
  for (let i = 0; i < 5 && await p.evaluate(() => __chess.viewIdx) !== 2; i++) await toolbar(p, '#btnView');
  if (await p.locator('#btnMore').getAttribute('aria-expanded') === 'true') await p.locator('#btnMore').click();
  const square = async (pos, piece) => {
    await p.locator('#stage').scrollIntoViewIfNeeded();
    await p.evaluate(async () => {
      let last = '', stable = 0;
      for (let i = 0; i < 180 && stable < 4; i++) {
        await new Promise(requestAnimationFrame);
        const now = __chess.camera.position.toArray().map(n => n.toFixed(4)).join();
        stable = now === last ? stable + 1 : 0; last = now;
      }
    });
    const project = () => p.evaluate(({ pos, piece }) => {
      const v = __chess.camera.position.clone().set(pos.c - 4, piece ? .18 : 0, 4.5 - pos.r).project(__chess.camera);
      const r = __chess.renderer.domElement.getBoundingClientRect();
      return { x: r.x + (v.x + 1) * r.width / 2, y: r.y + (1 - v.y) * r.height / 2 };
    }, { pos, piece });
    let pt = await project();
    for (let attempt = 0; attempt < 12; attempt++) {
      const box = await p.locator('#stage canvas').boundingBox(), viewport = p.viewportSize();
      if (pt.x > Math.max(24, box.x + 24) && pt.x < Math.min(viewport.width - 24, box.x + box.width - 24)
        && pt.y > Math.max(100, box.y + 24) && pt.y < Math.min(viewport.height - 24, box.y + box.height - 24)) break;
      // The existing mobile camera can crop edge pieces. Zoom with real input,
      // as a player would, rather than bypassing hit testing or moving via hooks.
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.wheel(0, 240);
      await p.evaluate(() => new Promise(resolve => {
        let last = '', stable = 0, count = 0;
        const tick = () => {
          const now = __chess.camera.position.toArray().map(n => n.toFixed(4)).join();
          stable = last === now ? stable + 1 : 0; last = now;
          if (stable >= 4 || ++count >= 180) resolve(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }));
      pt = await project();
    }
    await p.waitForFunction(pt => document.elementFromPoint(pt.x, pt.y) === __chess.renderer.domElement, pt);
    await p.mouse.click(pt.x, pt.y);
  };
  await square(chosen.from, true);
  assert.deepEqual(await p.evaluate(() => __chess.selected), chosen.from);
  await square(chosen.to, false);
}

await write('environment.json', { url, chrome: browser.version(), root, browserPath: 'Browser plugin/browser skill unavailable; existing Playwright', profiles: 'fresh isolated contexts; synthetic data only' });
try {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport }), p = await context.newPage(), errors = [];
    p.setDefaultTimeout(20000);
    const result = { label, viewport, checks: [], status: 'RUNNING' };
    context.on('page', tab => { tab.on('pageerror', e => errors.push(e.message)); tab.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); });
    p.on('pageerror', e => errors.push(e.message)); p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await context.addInitScript(() => {
      window.__saveQA = { posts: [], hold: true, replies: [], errors: [], moves: [], longTasks: [] };
      window.addEventListener('unhandledrejection', e => __saveQA.errors.push(String(e.reason)));
      const Native = Worker;
      window.Worker = class extends Native {
        constructor(...args) {
          super(...args); let handler;
          Object.defineProperty(this, 'onmessage', { get: () => handler, set: fn => { handler = fn; } });
          this.addEventListener('message', e => {
            const callback = handler;
            if (__saveQA.hold) __saveQA.replies.push(() => callback?.(e)); else callback?.(e);
          });
        }
        postMessage(value) { if (value.kind === 'normal-game') __saveQA.posts.push(value); return super.postMessage(value); }
      };
      new PerformanceObserver(list => __saveQA.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask', buffered: true });
      new MutationObserver(() => {
        if (!window.__chess) return;
        const disabled = document.getElementById('btnSaveCurrentPosition')?.disabled;
        if (__chess.busy || __chess.aiThinking) __saveQA.moves.push({ busy: __chess.busy, thinking: __chess.aiThinking, disabled });
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['disabled'] });
    });
    try {
      await p.goto(url); await p.waitForFunction(() => window.__chess?.board);
      assert.match(await p.title(), /中國象棋/); assert.equal(await p.locator('#btnSaveCurrentPosition').isDisabled(), true);
      await p.locator('#modeSel').selectOption('easy');
      await p.locator('label[for="humanSideBlack"]').click();
      await p.waitForFunction(() => __saveQA.replies.length > 0);
      assert.equal(await p.evaluate(() => __chess.aiThinking), true);
      assert.equal(await p.locator('#btnSaveCurrentPosition').isDisabled(), true);
      await p.evaluate(() => { __saveQA.hold = false; __saveQA.replies.splice(0).forEach(fn => fn()); });
      await p.waitForFunction(() => __chess.history.length === 1 && !__chess.busy && !__chess.aiThinking);
      result.checks.push('fresh game and real AI thinking blocked; first AI move exactly once');
      const original = await game(p), posts = await p.evaluate(() => __saveQA.posts.length);
      await saveDialog(p);
      assert.equal(await p.locator('#savedPositionHumanSide').inputValue(), 'black');
      assert.equal(await p.locator('#savedPositionDifficulty').inputValue(), 'easy');
      assert.match(await p.locator('#savedPositionSummary').innerText(), /不保存完整對局進度/);
      await p.locator('#savedPositionTitle').fill('目前局面快照'); await submit(p);
      const saved = await read(p), position = saved.envelope.positions[0];
      assert.deepEqual(position.initialBoard, original.board); assert.equal(position.sideToMove, original.turn);
      assert.deepEqual(position.playPreferences, { humanSide: 'black', difficulty: 'easy' });
      assert.equal(saved.metadata.committedOperationIds.length, 1);
      await p.keyboard.press('Escape'); assert.deepEqual(await game(p), original);
      assert.equal(await p.evaluate(() => __saveQA.posts.length), posts);
      await saveDialog(p); await p.locator('#savedPositionTitle').fill('取消不儲存'); await p.keyboard.press('Escape');
      assert.deepEqual(await game(p), original); assert.deepEqual(await read(p), saved);
      result.checks.push('snapshot preferences/90 squares; save and cancel preserve session/history/AI');
      await saveDialog(p); await p.locator('#savedPositionTitle').fill('重複棋面'); await submit(p);
      assert.match(await p.locator('#savedPositionsNotice').innerText(), /已存在/);
      assert.equal((await read(p)).envelope.positions.length, 1); await p.keyboard.press('Escape');
      await saveDialog(p); await p.locator('#savedPositionTitle').fill('過期提交');
      const other = await context.newPage(); await other.goto(url); await other.waitForFunction(() => window.__chess?.board);
      await manager(other); await other.locator('[data-action="rename"]').click();
      await other.locator('#savedPositionTitle').fill('另一分頁的新名稱'); await submit(other);
      const changed = await read(other);
      // Focus refresh may reject the stale form before submit; both paths must keep it stale.
      await p.bringToFront(); await idle(p);
      if (!await p.locator('#savedPositionSubmit').isDisabled()) await submit(p);
      assert.match(await p.locator('#savedPositionError').innerText(), /其他分頁|重新載入/);
      assert.deepEqual(await read(p), changed); await p.keyboard.press('Escape'); await other.close();
      result.checks.push('duplicate deduplicated; real second-tab revision rejects stale save');
      await move(p); await p.waitForFunction(() => __chess.history.length === 3 && !__chess.busy && !__chess.aiThinking);
      assert.equal((await game(p)).session.id, original.session.id);
      assert.ok(await p.evaluate(() => __saveQA.moves.some(m => m.busy && m.disabled)));
      assert.ok(await p.evaluate(() => __saveQA.moves.every(m => m.disabled)));
      result.checks.push('real pointer move continues original game; animation and AI disable save');
      await p.reload(); await p.waitForFunction(() => window.__chess?.board);
      await manager(p); assert.deepEqual(await read(p), changed);
      await p.locator('[data-action="challenge"]').click();
      if (await p.locator('#savedPositionAcknowledgement').isVisible()) await p.locator('#savedPositionAcknowledge').check();
      await submit(p); await p.waitForFunction(() => !document.getElementById('savedPositionsDialog').open);
      const restarted = await game(p);
      assert.deepEqual(restarted.board, original.board); assert.equal(restarted.turn, original.turn);
      assert.equal(restarted.history.length, 0); assert.notEqual(restarted.session.id, original.session.id);
      assert.equal(restarted.completed, null); assert.equal(await p.locator('#btnUndo').isDisabled(), true);
      assert.equal(await p.locator('#btnSaveCurrentPosition').isDisabled(), true);
      await p.evaluate(() => { __saveQA.hold = false; }); await move(p);
      await p.waitForFunction(() => __chess.history.length === 2 && !__chess.busy && !__chess.aiThinking);
      await saveDialog(p); await p.screenshot({ path: path.join(output, label + '-save.png'), fullPage: true }); await p.keyboard.press('Escape');
      result.checks.push('reload exact IDB; independent challenge/root/history/record; current game can continue');
      // Capacity fixture is written only in this disposable test context.
      const full = capacityFixture(100);
      const candidateJSON = JSON.stringify(validateCustomPositionEnvelope(full.metadata.baseEnvelope));
      const fingerprint = createHash('sha256').update(candidateJSON).digest('hex');
      full.metadata.migration = { version: 1, state: 'ACTIVE', migrationId: 'legacy-v1:' + fingerprint,
        sourceFingerprint: fingerprint, sourceRevision: 2, initialRevision: 2,
        stagedOperationId: '33333333-3333-4333-8333-333333333333', activatedOperationId: '44444444-4444-4444-8444-444444444444',
        stagedAt: '2026-11-02T00:00:00.000Z', activatedAt: '2026-11-02T00:00:00.000Z', candidateJSON };
      await p.evaluate(async full => {
        const { validateCustomPositionIDBState } = await import('./custom-position-idb.js');
        validateCustomPositionIDBState(full.envelope, full.metadata);
        const db = await new Promise((resolve, reject) => { const q = indexedDB.open('chinese-chess-training:custom-positions'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(full.envelope, 'envelope'); tx.objectStore('state').put(full.metadata, 'metadata'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.commit(); }); db.close();
      }, full);
      await saveDialog(p); await p.locator('#savedPositionTitle').fill('超過容量'); await submit(p);
      assert.match(await p.locator('#savedPositionError').innerText(), /數量上限/);
      assert.deepEqual(await read(p), full); await p.keyboard.press('Escape');
      await p.locator('#modeSel').selectOption('pvp');
      assert.equal(await p.locator('#btnSaveCurrentPosition').isDisabled(), true);
      result.checks.push('100 positions + 128 witnesses unchanged on capacity rejection; pvp blocked');
      assert.deepEqual(errors, []); assert.deepEqual(await p.evaluate(() => __saveQA.errors), []);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      result.final = await read(p); result.status = 'PASS';
    } catch (error) {
      result.status = 'FAIL'; result.error = { message: error.message, stack: error.stack };
      await p.screenshot({ path: path.join(output, label + '-FAIL.png'), fullPage: true }); throw error;
    } finally {
      result.errors = errors; result.observations = await p.evaluate(() => ({ ...__saveQA, replies: __saveQA.replies.length })).catch(() => null);
      results.push(result); await write(label + '.json', result); await write('summary.json', results);
      await context.close();
    }
    console.log(label + ': PASS');
  }
} finally { await browser.close(); server.close(); }
