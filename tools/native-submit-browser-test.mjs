// Full Chrome/WebGL, isolated contexts and synthetic saved positions.
// node tools/native-submit-browser-test.mjs SITE OUT [--baseline]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const baseline = process.argv.includes('--baseline');
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
    const bytes = await readFile(file);
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': ({ '.html': 'text/html',
      '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' })[path.extname(file)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome', headless: true }), results = [];
const idle = async p => {
  await p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking
    && __chess.pieces.every(m => Math.abs(m.position.y - .18) < .0001));
  await p.evaluate(() => new Promise(resolve => {
    let last = '', stable = 0;
    const frame = () => {
      const now = __chess.camera.position.toArray().map(x => x.toFixed(5)).join(',');
      stable = now === last ? stable + 1 : 0; last = now;
      if (stable >= 6) resolve(); else requestAnimationFrame(frame);
    }; frame();
  }));
};
const snapshot = p => p.evaluate(() => __nativeSubmitQA.snapshot());
const storage = p => p.evaluate(async () => {
  const normalize = async value => {
    if (value instanceof Blob) return { type: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] };
    if (value instanceof ArrayBuffer) return { bytes: [...new Uint8Array(value)] };
    if (Array.isArray(value)) return Promise.all(value.map(normalize));
    if (value && typeof value === 'object') {
      const result = {}; for (const key of Object.keys(value).sort()) result[key] = await normalize(value[key]);
      return result;
    } return value;
  };
  const databases = [];
  for (const info of (await indexedDB.databases()).sort((a, b) => a.name.localeCompare(b.name))) {
    const request = q => new Promise((resolve, reject) => { q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    const db = await request(indexedDB.open(info.name)), stores = {};
    for (const name of [...db.objectStoreNames].sort()) {
      const store = db.transaction(name, 'readonly').objectStore(name);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      stores[name] = await normalize(keys.map((key, i) => ({ key, value: values[i] })));
    }
    db.close(); databases.push({ name: info.name, version: info.version, stores });
  }
  return { local: Object.fromEntries(Object.entries(localStorage).sort()), databases };
});
function sameStorage(before, after) {
  // Keep raw camera preferences in evidence; their normal writes are not game-data corruption.
  const protectedLocal = value => Object.fromEntries(Object.entries(value.local)
    .filter(([key]) => key !== 'xiangqi.viewPrefs.v1'));
  assert.deepEqual(after.databases, before.databases, 'INDEXEDDB_PRESERVED');
  assert.deepEqual(protectedLocal(after), protectedLocal(before), 'LOCAL_GAME_DATA_PRESERVED');
}
async function tap(p, r, c, y = .36) {
  const point = await p.evaluate(({ r, c, y }) => {
    const box = __chess.renderer.domElement.getBoundingClientRect();
    const v = __chess.camera.position.clone().set(c - 4, y, 4.5 - r).project(__chess.camera);
    return { x: box.x + (v.x + 1) * box.width / 2, y: box.y + (1 - v.y) * box.height / 2 };
  }, { r, c, y });
  await p.touchscreen.tap(point.x, point.y);
}
async function play(p, from, to) {
  const before = await snapshot(p), board = structuredClone(before.game.board);
  board[to.r][to.c] = board[from.r][from.c]; board[from.r][from.c] = null;
  await tap(p, from.r, from.c); assert.deepEqual(await p.evaluate(() => __chess.selected), from);
  await tap(p, to.r, to.c, 0); await idle(p);
  const after = await snapshot(p);
  assert.deepEqual(after.game.board, board); assert.equal(after.game.history.length, before.game.history.length + 1);
  assert.equal(after.game.session.id, before.game.session.id);
}
async function seed(p) {
  await p.locator('#modeSel').selectOption('easy'); await idle(p);
  await tap(p, 3, 0); await tap(p, 4, 0, 0);
  await p.waitForFunction(() => __chess.history.length === 2 && !__chess.aiThinking && !__chess.busy);
  await idle(p);
  if (!await p.locator('#btnSaveCurrentPosition').isVisible()) await p.locator('#btnMore').click();
  await p.locator('#btnSaveCurrentPosition').click();
  await p.locator('#savedPositionTitle').fill('NS1 synthetic position'); await p.locator('#savedPositionSubmit').click();
  await p.waitForFunction(() => document.querySelector('#savedPositionForm').hidden && document.querySelector('#savedPositionsList').children.length === 1);
  await p.locator('#savedPositionsClose').click(); await p.locator('#modeSel').selectOption('pvp');
  await p.locator('#btnNewGameConfirm').click(); await idle(p);
  await play(p, { r: 3, c: 0 }, { r: 4, c: 0 });
  await p.evaluate(() => __nativeSubmitQA.remember());
}
function preserved(before, after) {
  assert.equal(after.documentId, before.documentId, 'NO_DOCUMENT_RELOAD');
  assert.equal(after.timeOrigin, before.timeOrigin); assert.equal(after.url, before.url);
  assert.deepEqual(after.game, before.game, 'ORIGINAL_GAME_PRESERVED');
  assert.equal(after.identity, true, 'ORIGINAL_OBJECT_IDENTITY');
}
async function check(size, method, confirmation = 'mouse') {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: true, isMobile: size[0] < 1000 });
  const p = await context.newPage(), r = { size, method, confirmation, baseline, events: [], navigations: [], errors: [] };
  p.setDefaultTimeout(20000);
  p.on('pageerror', e => r.errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') r.errors.push(m.text()); });
  p.on('request', req => { if (req.isNavigationRequest() && req.frame() === p.mainFrame()) r.navigations.push({ url: req.url(), method: req.method() }); });
  await p.exposeFunction('__recordNativeSubmit', event => r.events.push(event));
  await context.addInitScript(() => {
    window.__nativeDocumentId = crypto.randomUUID();
    document.addEventListener('submit', e => void __recordNativeSubmit({ type: 'submit', form: e.target.id, submitter: e.submitter?.id, documentId: __nativeDocumentId }), true);
    window.addEventListener('unhandledrejection', e => void __recordNativeSubmit({ type: 'unhandledrejection', reason: String(e.reason) }));
  });
  // Read-only observations, served in memory: no product source is rewritten.
  await p.route('**/main.js*', async route => {
    let main = await readFile(path.join(site, 'main.js'), 'utf8');
    const anchor = 'function commitNormalNewGame(settings) {';
    assert.equal(main.split(anchor).length, 2);
    main = main.replace(anchor, anchor + " void __recordNativeSubmit({type:'commitNormalNewGame',documentId:__nativeDocumentId});");
    main += `\nlet nativeSubmitOwner;
window.__nativeSubmitQA = {
 remember(){ nativeSubmitOwner={board,history,session:normalGameRecordSession}; },
 snapshot(){return { documentId:__nativeDocumentId,timeOrigin:performance.timeOrigin,url:location.href,
  game:{board,history,session:normalGameRecordSession,modeRevision:normalGameModeRevision,mode,humanSide,turn},
  identity:!nativeSubmitOwner||(nativeSubmitOwner.board===board&&nativeSubmitOwner.history===history&&nativeSubmitOwner.session===normalGameRecordSession)};}
};\n`;
    await route.fulfill({ contentType: 'text/javascript', body: main });
  });
  try {
    await p.goto(url); await idle(p);
    assert.equal(await p.evaluate(() => __chess.renderer.getContext() instanceof WebGL2RenderingContext), true);
    await seed(p); await p.locator('#btnNew').click();
    await p.locator('#newGameConfirmDialog').waitFor({ state: 'visible' });
    r.before = await snapshot(p); r.storageBefore = await storage(p);
    assert.ok(JSON.stringify(r.storageBefore.databases).includes('NS1 synthetic position'));
    const navCount = r.navigations.length, eventCount = r.events.length;
    await p.evaluate(method => {
      const form = document.getElementById('newGameConfirmForm');
      if (method === 'direct') form.submit();
      else if (method === 'prototype') HTMLFormElement.prototype.submit.call(form);
      else if (method === 'request') form.requestSubmit();
      else if (method === 'request-submitter') form.requestSubmit(document.getElementById('btnNewGameConfirm'));
      else form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: document.getElementById('btnNewGameConfirm') }));
    }, method);
    // Observation window for native navigation; never used to authorize an input.
    await p.waitForTimeout(250); await p.waitForLoadState('load'); await idle(p);
    r.after = await snapshot(p); r.storageAfter = await storage(p);
    r.submissionEvents = r.events.slice(eventCount); r.newNavigations = r.navigations.slice(navCount);
    if (baseline) {
      assert.ok(r.newNavigations.length > 0, 'baseline must actually navigate');
      assert.notEqual(r.after.documentId, r.before.documentId); assert.notEqual(r.after.timeOrigin, r.before.timeOrigin);
      assert.equal(r.after.game.history.length, 0); assert.notEqual(r.after.game.session.id, r.before.game.session.id);
      assert.equal(r.submissionEvents.filter(x => x.type === 'submit').length, 0);
      assert.equal(r.submissionEvents.filter(x => x.type === 'commitNormalNewGame').length, 0);
      sameStorage(r.storageBefore, r.storageAfter);
      r.status = 'EXPECTED_FAIL_DETECTED'; r.assertion = 'NO_TOP_LEVEL_NAVIGATION';
    } else {
      assert.equal(r.newNavigations.length, 0, 'NO_TOP_LEVEL_NAVIGATION'); preserved(r.before, r.after);
      assert.equal(r.submissionEvents.filter(x => x.type === 'commitNormalNewGame').length, 0, 'NO_UNAUTHORIZED_COMMIT');
      assert.equal(r.submissionEvents.filter(x => x.type === 'submit').length, ['direct', 'prototype'].includes(method) ? 0 : 1);
      sameStorage(r.storageBefore, r.storageAfter);
      if (['direct', 'prototype'].includes(method)) {
        await p.locator('#newGameConfirmDialog').waitFor({ state: 'hidden' });
        assert.equal(await p.evaluate(() => document.activeElement.id), 'btnNew');
        // A second native submission while the dialog is closed must also be inert.
        await p.evaluate(() => HTMLFormElement.prototype.submit.call(document.getElementById('newGameConfirmForm')));
        await p.waitForTimeout(250); preserved(r.before, await snapshot(p));
      } else await p.locator('#btnNewGameCancel').click();
      await p.locator('#btnNew').click(); await p.keyboard.press('Escape');
      preserved(r.before, await snapshot(p));
      await play(p, { r: 6, c: 8 }, { r: 5, c: 8 }); // Cancel/native close keeps the original game usable.
      await p.locator('#btnNew').click();
      const commitsBefore = r.events.filter(x => x.type === 'commitNormalNewGame').length;
      if (confirmation === 'touch') await p.locator('#btnNewGameConfirm').tap();
      else if (confirmation === 'mouse') await p.locator('#btnNewGameConfirm').click();
      else { await p.keyboard.press('Tab'); await p.keyboard.press(confirmation === 'space' ? ' ' : 'Enter'); }
      await idle(p); r.confirmed = await snapshot(p);
      assert.notEqual(r.confirmed.game.session.id, r.before.game.session.id);
      assert.equal(r.confirmed.game.modeRevision, r.before.game.modeRevision + 1);
      assert.equal(r.confirmed.game.history.length, 0); assert.equal(r.confirmed.game.board.flat().filter(Boolean).length, 32);
      assert.equal(r.events.filter(x => x.type === 'commitNormalNewGame').length, commitsBefore + 1);
      await play(p, { r: 3, c: 0 }, { r: 4, c: 0 });
      await p.evaluate(() => document.getElementById('newGameConfirmForm').requestSubmit());
      assert.equal((await snapshot(p)).game.history.length, 1);
      assert.equal(r.events.filter(x => x.type === 'commitNormalNewGame').length, commitsBefore + 1);
      r.storageFinal = await storage(p); sameStorage(r.storageBefore, r.storageFinal);
      assert.equal(r.navigations.length, navCount); r.status = 'PASS';
    }
    assert.deepEqual(r.errors, []); assert.equal(r.events.filter(x => x.type === 'unhandledrejection').length, 0);
  } catch (error) { r.status = 'FAIL'; r.error = error.stack; process.exitCode = 1; }
  finally {
    await p.screenshot({ path: path.join(out, `${size.join('x')}-${method}-${confirmation}.png`) }).catch(() => {});
    results.push(r); await writeFile(path.join(out, 'result.json'), JSON.stringify({ chrome: browser.version(), url, site, baseline, results }, null, 2));
    await context.close(); console.log(`${r.status} ${size.join('x')} ${method} ${confirmation}`);
  }
  if (r.status === 'FAIL') throw new Error(r.error);
}
try {
  if (baseline) {
    for (let i = 0; i < 2; i++) for (const method of ['direct', 'prototype']) await check([390, 844], method, String(i));
  } else {
    const sizes = [[320,568], [375,812], [390,844], [430,932], [844,390], [1440,1000]];
    for (const size of sizes) {
      await check(size, 'direct', 'space'); await check(size, 'prototype', 'enter');
      await check(size, 'request', 'mouse'); await check(size, 'request-submitter', 'touch');
      await check(size, 'dispatch', 'mouse');
    }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
