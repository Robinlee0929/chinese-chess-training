// Complete Three.js / isolated Chrome / synthetic records. Keep evidence outside checkout.
// PLAYWRIGHT_MODULE=... node tools/mobile-review-browser-test.mjs SITE OUT
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { longGame } from './game-transfer-fixtures.mjs';
import { serializeGameTransfer } from '../game-transfer/game-transfer.js';
import { replayGameTimeline } from '../game-record.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
assert.ok(out !== root && !out.startsWith(root + path.sep)); await mkdir(out, { recursive: false });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const fixture = longGame(40, 'red', true), results = [], metrics = [], errors = [];
const server = createServer(async (q, r) => { try {
  const name = new URL(q.url, 'http://localhost').pathname;
  if (name === '/favicon.ico') { r.writeHead(204); r.end(); return; }
  const file = path.resolve(site, '.' + (name === '/' ? '/index.html' : name));
  assert.ok(file.startsWith(site + path.sep) && !file.endsWith('.mjs'));
  r.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  r.end(await readFile(file));
} catch { r.writeHead(404); r.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`, browser = await chromium.launch({ channel: 'chrome', headless: true });
const watchdog = setTimeout(() => void browser.close(), 600000);
const navIds = ['btnGameReviewFirst', 'btnGameReviewPrevious', 'btnGameReviewNext', 'btnGameReviewLast'];
const idle = p => p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking && __chess.pieces.every(m => Math.abs(m.position.y - .18) < .0001));
const live = p => p.evaluate(() => ({ board: __chess.board, history: __chess.history, turn: __chess.turn, mode: __chess.mode, side: __chess.humanSide, session: __chess.normalGameRecordSession }));
const storage = p => p.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k !== 'xiangqi.viewPrefs.v1')));
const toolbar = async (p, id) => { if (!await p.locator(id).isVisible()) await p.locator('#btnMore').click(); await p.locator(id).click(); };
async function importGame(p) {
  await p.locator('#btnGameImport').click();
  await p.locator('#gameImportFile').setInputFiles({ name: 'synthetic-40.json', mimeType: 'application/json', buffer: Buffer.from(serializeGameTransfer(fixture)) });
  await p.waitForFunction(() => !document.querySelector('#gameImportConfirm').disabled);
  await p.locator('#gameImportConfirm').click(); await idle(p);
}
async function visible(p, selector) { return p.locator(selector).evaluate(e => {
  const b = e.getBoundingClientRect(), at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
  return b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && (at === e || e.contains(at)) && !e.closest('[hidden],.hidden,[inert],[aria-hidden="true"]');
}); }
async function measure(p) { return p.evaluate(() => {
  const rect = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom }; };
  const ids = ['btnMore', 'btnGameReviewBack', 'btnGameReviewExit', 'btnGameRecordLibraryExit', 'gameRecordLibraryHeading', 'btnGameReviewFirst', 'btnGameReviewPrevious', 'btnGameReviewNext', 'btnGameReviewLast', 'gameRecordPanel', 'gameReviewContent', 'gameReviewMoveList'];
  const move = document.querySelector('[data-review-ply="20"]');
  return { viewport: { width: innerWidth, height: innerHeight }, rects: Object.fromEntries(ids.map(id => [id, rect(document.getElementById(id))])), moveTarget: move ? rect(move) : null, scroll: Object.fromEntries(['gameRecordPanel', 'gameReviewContent', 'gameReviewMoveList'].map(id => { const e = document.getElementById(id); return [id, { top: e.scrollTop, height: e.scrollHeight, client: e.clientHeight }]; })), focus: document.activeElement.id, page: { width: document.documentElement.scrollWidth, x: scrollX, y: scrollY } };
}); }
async function navigationVisible(p) {
  // ResizeObserver and mobile viewport changes settle on separate animation frames.
  await p.waitForFunction(ids => ids.every(id => {
    const e = document.getElementById(id), b = e.getBoundingClientRect(), at = document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
    return b.width>0 && b.top>=0 && b.bottom<=innerHeight && (at===e || e.contains(at));
  }), navIds, { timeout: 5000 });
  for (const id of navIds) { assert.equal(await p.locator('#' + id).count(), 1); assert.ok(await visible(p, '#' + id), id + ' must be fully visible'); }
}
async function check(name, fn) { await fn(); results.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
let current;
try {
  for (const [width, height] of [[320,568],[375,812],[390,844],[430,932],[844,390],[1440,1000]]) {
    const tag = `${width}x${height}`, c = await browser.newContext({ viewport: { width, height }, isMobile: width <= 900, hasTouch: true, acceptDownloads: true });
    const p = current = await c.newPage(); p.setDefaultTimeout(20000); p.on('pageerror', e => errors.push({ tag, error: e.message }));
    p.on('console', m => { if (m.type() === 'error') errors.push({ tag, error: m.text() }); });
    await p.goto(url); await idle(p); assert.ok(await p.evaluate(() => __chess.renderer.getContext() instanceof WebGL2RenderingContext));
    await p.locator('#modeSel').selectOption('pvp'); await idle(p);
    for (const [from, to] of [[[3,4],[4,4]], [[6,4],[5,4]]]) {
      for (const [rc, y] of [[from, .36], [to, 0]]) {
        const pt = await p.evaluate(({ rc, y }) => { const x = __chess, b = x.renderer.domElement.getBoundingClientRect(), v = x.camera.position.clone().set(rc[1]-4, y, 4.5-rc[0]).project(x.camera); return { x: b.x+(v.x+1)*b.width/2, y: b.y+(1-v.y)*b.height/2 }; }, { rc, y });
        await p.touchscreen.tap(pt.x, pt.y);
      } await idle(p);
    }
    const original = await live(p), saved = await storage(p); assert.equal(original.history.length, 2);
    await toolbar(p, '#btnGameRecords'); await importGame(p);
    await check(tag + ' initial navigation, one set of controls, no overflow', async () => {
      await navigationVisible(p); const m = await measure(p); assert.ok(m.page.width <= width); assert.equal(m.page.x, 0); assert.equal(m.page.y, 0);
      metrics.push({ tag, phase: 'entry', ...m }); await p.screenshot({ path: path.join(out, tag + '-entry.png') });
    });
    await check(tag + ' first/previous/next/last through UI and replay oracle', async () => {
      for (const [id, ply] of [['btnGameReviewNext',1],['btnGameReviewLast',40],['btnGameReviewPrevious',39],['btnGameReviewFirst',0]]) {
        await p.locator('#' + id).tap(); const actual = await p.evaluate(() => ({ ply: __chess.gameReview.selectedPly, snapshot: __chess.gameReview.snapshot }));
        assert.equal(actual.ply, ply); assert.deepEqual(actual.snapshot, replayGameTimeline({ id: 'oracle', createdAt: fixture.exportedAt, initialPosition: fixture.initialPosition, moves: fixture.moves, mode: fixture.mode }, ply));
      }
    });
    await check(tag + ' forty-ply touch scroll, last item, navigation stays accessible', async () => {
      await p.locator('[data-review-ply="1"]').scrollIntoViewIfNeeded();
      const scroller = p.locator(width <= 900 ? '#gameReviewContent' : '#gameReviewMoveList');
      for (let i = 0; i < 25 && !await visible(p, '[data-review-ply="40"]'); i++) {
        const box = await scroller.boundingBox(), x = box.x + box.width / 2, bottom = Math.min(box.y + box.height, height) - 8;
        const cd = await c.newCDPSession(p); await cd.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: bottom }] });
        for (let j=1;j<=5;j++) await cd.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x,y:bottom-(Math.min(100,box.height-16)*j/5)}] });
        await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await cd.detach(); await p.waitForTimeout(80);
      }
      // Wheel is also an actual scrolling input; use it to finish a long list on very short screens.
      for (let i=0;i<25&&!await visible(p,'[data-review-ply="40"]');i++) { const box=await scroller.boundingBox(); await p.mouse.move(box.x+box.width/2,Math.min(height-12,box.y+box.height/2)); await p.mouse.wheel(0,300); await p.waitForTimeout(60); }
      assert.ok(await visible(p, '[data-review-ply="40"]')); await navigationVisible(p);
      await p.locator('[data-review-ply="40"]').tap(); assert.equal(await p.evaluate(() => __chess.gameReview.selectedPly), 40); await navigationVisible(p);
      metrics.push({ tag, phase: 'list-bottom', ...await measure(p) }); await p.screenshot({ path: path.join(out, tag + '-list-bottom.png') });
      await p.locator('#btnGameReviewPrevious').tap(); assert.equal(await p.evaluate(() => __chess.gameReview.selectedPly), 39);
    });
    await check(tag + ' selected touch sizes and adjacent controls', async () => {
      for(const id of [...(width<=900?['btnMore']:[]),'btnGameReviewBack','btnGameReviewExit']) { const r=await p.locator('#'+id).boundingBox(); assert.ok(r.width>=44&&r.height>=44,JSON.stringify({id,r})); }
      const r=await p.locator('[data-review-ply="20"]').boundingBox();assert.ok(r.width>=44&&r.height>=44);
      await p.locator('#btnGameReviewNext').tap(); assert.equal(await p.evaluate(() => __chess.gameReview.selectedPly),40);
      await p.locator('#btnGameReviewPrevious').tap(); assert.equal(await p.evaluate(() => __chess.gameReview.selectedPly),39);
      await p.locator('[data-review-ply="20"]').tap(); assert.equal(await p.evaluate(() => __chess.gameReview.selectedPly),20);
    });
    await check(tag + ' resize, orientation and no unexpected live game writes', async () => {
      for(const size of [{width:844,height:390},{width:390,height:844},{width,height}]) { await p.setViewportSize(size); await p.waitForTimeout(100); await navigationVisible(p); assert.ok((await measure(p)).page.width<=size.width); }
      // The public getter returns a clone; compare its stable ID and complete contents.
      assert.deepEqual(await live(p), original); assert.deepEqual(await storage(p), saved);
      assert.equal(await p.evaluate(() => __chess.normalGameRecordSession.id), original.session.id);
    });
    await check(tag + ' Escape returns visible focus, reimport and keyboard navigation', async () => {
      await p.locator('#btnGameReviewPrevious').focus();
      for (const [key, ply] of [['Home',0],['ArrowRight',1],['End',40],['ArrowLeft',39]]) {
        await p.keyboard.press(key); assert.equal(await p.evaluate(() => __chess.gameReview.selectedPly), ply);
      }
      for (const key of ['Tab', 'Shift+Tab']) {
        await p.keyboard.press(key); const id = await p.evaluate(() => document.activeElement.id);
        assert.ok(id && await visible(p, '#' + id), 'keyboard focus must stay visible');
      }
      await p.keyboard.press('Escape'); assert.equal(await p.evaluate(() => document.activeElement.id), 'gameRecordLibraryHeading'); assert.ok(await visible(p, '#gameRecordLibraryHeading'));
      const exitTarget = await p.locator('#btnGameRecordLibraryExit').boundingBox(); assert.ok(exitTarget.width >= 44 && exitTarget.height >= 44);
      assert.deepEqual(await live(p), original); assert.deepEqual(await storage(p),saved); metrics.push({tag,phase:'return-focus',...await measure(p)});
      await p.screenshot({path:path.join(out,tag+'-return-focus.png')}); await importGame(p); await navigationVisible(p);
      await p.locator('#btnGameReviewBack').tap(); assert.ok(await visible(p,'#gameRecordLibraryHeading')); await importGame(p);
    });
    await check(tag + ' continuation cancel, return restores whole original game', async () => {
      await p.locator('#btnGameReviewNext').tap(); await p.locator('#btnGameReviewContinue').tap();
      await p.locator('#btnGameReviewContinuationCancel').click(); assert.deepEqual(await live(p),original);
      await p.locator('#btnGameReviewExit').tap(); assert.deepEqual(await live(p),original);assert.deepEqual(await storage(p),saved);
    });
    await c.close();
  }
  assert.deepEqual(errors, []);
} catch (error) { results.push({name:'failure',status:'FAIL',error:error.stack}); if(current&&!current.isClosed())await current.screenshot({path:path.join(out,'failure.png')}); throw error; }
finally { clearTimeout(watchdog); await writeFile(path.join(out,'result.json'),JSON.stringify({url,chrome:browser.version(),results,metrics,errors,realDevice:'NOT_TESTED'},null,2)); await browser.close(); await new Promise(r=>server.close(r)); }
