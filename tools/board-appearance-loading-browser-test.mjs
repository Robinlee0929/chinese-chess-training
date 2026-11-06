#!/usr/bin/env node
// Isolated real-browser regression for optional appearance module loading.
// Usage: BOARD_APPEARANCE_LOADING_EVIDENCE_DIR=<outside checkout> node tools/board-appearance-loading-browser-test.mjs [JEKYLL_SITE]
// Reuse installed Playwright via PLAYWRIGHT_MODULE and Chrome via CHROME_PATH.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { checkArtifact } from './check-pages-artifact.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = await realpath(process.argv[2] ? path.resolve(process.argv[2]) : root);
if (site !== await realpath(root)) await checkArtifact(site);
assert.ok(process.env.BOARD_APPEARANCE_LOADING_EVIDENCE_DIR, 'Evidence directory required');
const output = path.resolve(process.env.BOARD_APPEARANCE_LOADING_EVIDENCE_DIR);
assert.ok(output !== root && !output.startsWith(root + path.sep), 'Keep evidence outside checkout');
assert.ok(output !== site && !output.startsWith(site + path.sep), 'Keep evidence outside served site');
await mkdir(output, { recursive: false });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const prefix = '/chinese-chess-training/';
const beforeFeature = 'a033d7fd7b94369afb1b530a7a827ecf25a8454c';
const beforeFix = '22f781d1efeee0fbd24242ece5ea60377aedf085';
const gitFile = (ref, file) => execFileSync('git', ['show', ref + ':' + file], { cwd: root });
const oldHTML = new Map([beforeFeature, beforeFix].map(ref => [ref, gitFile(ref, 'index.html')]));
const oldJS = new Map();
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const file = path.resolve(site, pathname.slice(prefix.length) || 'index.html');
    if (!file.startsWith(site + path.sep)) { res.writeHead(403); res.end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}${prefix}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [];
const write = (name, value) => writeFile(path.join(output, name + '.json'), JSON.stringify(value, null, 2));
await write('environment', { url, site, chrome: browser.version(), realMobile: false });
const toolbar = async (p, id) => { if (!await p.locator(id).isVisible()) await p.locator('#btnMore').click(); await p.locator(id).click(); };
const boot = p => p.waitForFunction(() => window.__chess?.pieces.length === 32);
const ready = p => p.waitForFunction(() => !document.getElementById('btnBoardAppearance').disabled && document.getElementById('boardAppearancePersistence').textContent.includes('已在'));
const game = p => p.evaluate(() => JSON.stringify({ board: __chess.board, history: __chess.history, mode: __chess.mode, turn: __chess.turn }));
const wood = p => p.evaluate(() => __loadingQA.canvases[0].toDataURL() === __loadingQA.canvases[1].toDataURL());
async function snapshot(p) {
  return p.evaluate(async () => {
    const norm = async v => {
      if (v instanceof Blob) { const hash = await crypto.subtle.digest('SHA-256', await v.arrayBuffer()); return { type: v.type, size: v.size, sha256: [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('') }; }
      if (Array.isArray(v)) return Promise.all(v.map(norm));
      if (v && typeof v === 'object') { const result = {}; for (const key of Object.keys(v).sort()) result[key] = await norm(v[key]); return result; }
      return v;
    };
    const output = {};
    for (const name of ['chinese-chess-training:board-appearance', 'qa:existing-unrelated']) {
      const db = await new Promise((resolve, reject) => { const q = indexedDB.open(name); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
      output[name] = { version: db.version, stores: {} };
      for (const store of db.objectStoreNames) {
        const values = await new Promise((resolve, reject) => {
          const tx = db.transaction(store), req = tx.objectStore(store).openCursor(), rows = [];
          req.onsuccess = () => { const c = req.result; if (c) { rows.push({ key: c.key, value: c.value }); c.continue(); } };
          tx.oncomplete = () => resolve(rows); tx.onabort = () => reject(tx.error);
        });
        output[name].stores[store] = await norm(values);
      }
      db.close();
    }
    return output;
  });
}
async function seed(p) {
  await p.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const g = c.getContext('2d'); g.fillStyle = '#037dbe'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#ffdd40'; g.fillRect(20, 20, 70, 110);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg'));
    for (const [name, store, key, value] of [
      ['chinese-chess-training:board-appearance', 'appearance', 'current', { version: 1, blob, settings: { fit: 'cover', opacity: .73, x: .26, y: .84 } }],
      ['qa:existing-unrelated', 'data', 'sentinel', { text: 'Preserve existing data', version: 7 }],
    ]) await new Promise((resolve, reject) => {
      const q = indexedDB.open(name, 1); q.onupgradeneeded = () => q.result.createObjectStore(store);
      q.onerror = () => reject(q.error); q.onsuccess = () => { const db = q.result, tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); }; };
    });
  });
}
async function pointerMove(p) {
  for (const [r, c, piece] of [[3, 4, true], [4, 4, false]]) {
    const point = await p.evaluate(({ r, c, piece }) => {
      const x = __chess, rect = x.renderer.domElement.getBoundingClientRect();
      const v = x.camera.position.clone().set(c - 4, piece ? .18 : 0, 4.5 - r).project(x.camera);
      return { x: rect.x + (v.x + 1) * rect.width / 2, y: rect.y + (1 - v.y) * rect.height / 2 };
    }, { r, c, piece });
    await p.mouse.click(point.x, point.y);
  }
}
async function exerciseGame(p) {
  assert.equal(await p.locator('#stage canvas').count(), 1);
  assert.equal(await p.evaluate(() => __chess.pieces.length), 32);
  await p.locator('#modeSel').selectOption('pvp'); await p.waitForTimeout(1600);
  await pointerMove(p); await p.waitForFunction(() => __chess.history.length === 1 && !__chess.busy);
  await toolbar(p, '#btnUndo'); await p.waitForFunction(() => __chess.history.length === 0);
  await p.locator('#modeSel').selectOption('easy'); await p.waitForTimeout(1600);
  await pointerMove(p); await p.waitForFunction(() => __chess.history.length === 2 && !__chess.busy && !__chess.aiThinking);
  return { initialPieces: 32, pvpMove: true, undo: true, aiReply: true };
}
const cases = [
  ['ui-network-abort', 'board-appearance-ui.js', 'abort'],
  ['store-network-abort', 'board-appearance-store.js', 'abort'],
  ['ui-http', 'board-appearance-ui.js', 'http'],
  ['store-http', 'board-appearance-store.js', 'http'],
  ['ui-invalid-js', 'board-appearance-ui.js', 'syntax'],
  ['store-invalid-js', 'board-appearance-store.js', 'syntax'],
  ['ui-evaluation-error', 'board-appearance-ui.js', 'evaluation'],
  ['ui-initializer-error', 'board-appearance-ui.js', 'initializer'],
  ['old-html-before-feature', null, 'old-html', beforeFeature],
  ['old-html-before-fix', null, 'old-html', beforeFix],
  ['new-html-old-js-before-feature', null, 'old-js', beforeFeature],
  ['new-html-old-js-before-fix', null, 'old-js', beforeFix],
  ['new-all', null, 'healthy'],
  ['delayed-mode-switch', 'board-appearance-ui.js', 'delay'],
  ['delayed-page-leave', 'board-appearance-ui.js', 'delay'],
  ['delayed-bfcache-lifecycle', 'board-appearance-ui.js', 'delay'],
  ['required-core-boundary', 'board-appearance.js', 'core'],
];
try {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    for (const [name, target, kind, ref] of cases) {
      const context = await browser.newContext({ viewport }), p = await context.newPage();
      p.setDefaultTimeout(18000);
      const result = { label, name, kind, status: 'RUNNING', expectedResourceErrors: [], handledWarnings: [], pageErrors: [] };
      results.push(result);
      let phase = 'seed', release, requested = false;
      const gate = new Promise(resolve => { release = resolve; });
      const requests = [];
      p.on('pageerror', e => result.pageErrors.push(e.message));
      p.on('console', m => {
        if (m.type() === 'error') {
          const location = m.location().url || '';
          if (['abort', 'http', 'core'].includes(kind) && /Failed to load resource/.test(m.text()) && location.includes(target)) result.expectedResourceErrors.push({ text: m.text(), url: location });
          else result.pageErrors.push(m.text());
        }
        if (m.type() === 'warning') result.handledWarnings.push(m.text());
      });
      await context.addInitScript(() => {
        window.__loadingQA = { appearanceOpens: 0, rejections: [], canvases: [] };
        addEventListener('unhandledrejection', e => __loadingQA.rejections.push(String(e.reason)));
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, ...args) => { if (name === 'chinese-chess-training:board-appearance') __loadingQA.appearanceOpens++; return open(name, ...args); };
        const get = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (...args) {
          const value = get.apply(this, args);
          if (args[0] === '2d' && this.width === 920 && this.height === 1020 && !__loadingQA.canvases.includes(this)) __loadingQA.canvases.push(this);
          return value;
        };
      });
      await context.route('**/*', async route => {
        const u = new URL(route.request().url());
        if (u.origin !== new URL(url).origin) return route.continue();
        const file = u.pathname.slice(prefix.length) || 'index.html';
        requests.push({ phase, file, url: u.href });
        if (phase === 'seed' && file === 'index.html') return route.fulfill({ contentType: 'text/html', body: '<title>Isolated test data setup</title>' });
        if (phase === 'test') {
          if (kind === 'old-html' && file === 'index.html') return route.fulfill({ contentType: 'text/html', body: oldHTML.get(ref) });
          if (kind === 'old-js' && file.endsWith('.js')) {
            const key = ref + ':' + file;
            if (!oldJS.has(key)) { try { oldJS.set(key, gitFile(ref, file)); } catch { oldJS.set(key, null); } }
            if (oldJS.get(key)) return route.fulfill({ contentType: 'text/javascript', body: oldJS.get(key) });
          }
          if (file === target) {
            requested = true;
            if (kind === 'abort') return route.abort('failed');
            if (kind === 'http' || kind === 'core') return route.fulfill({ status: 503, contentType: 'text/javascript', body: 'Unavailable' });
            if (kind === 'syntax') return route.fulfill({ contentType: 'text/javascript', body: 'export const = ;' });
            if (kind === 'evaluation') return route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("Injected optional module evaluation failure");' });
            if (kind === 'initializer') return route.fulfill({ contentType: 'text/javascript', body: 'export function createBoardAppearanceUI() { throw new Error("Injected optional initializer failure"); }' });
            if (kind === 'delay') { await gate; try { return await route.continue(); } catch (error) { result.navigationCancellation = error.message; return; } }
          }
        }
        return route.continue();
      });
      try {
        await p.goto(url); await seed(p); const original = await snapshot(p);
        phase = 'test';
        await p.reload({ waitUntil: 'domcontentloaded' });
        assert.equal(p.url(), url);
        assert.match(await p.title(), /中國象棋/);
        if (kind === 'core') {
          await p.waitForTimeout(600);
          result.boundary = await p.evaluate(() => ({ pieces: window.__chess?.pieces.length || 0, canvases: document.querySelectorAll('#stage canvas').length }));
          assert.deepEqual(result.boundary, { pieces: 0, canvases: 0 });
          result.fallbackSupported = false; // Explicit boundary, never claim core-file degradation.
        } else {
          await boot(p);
          if (kind === 'healthy' || (kind === 'old-html' && ref === beforeFix)) await ready(p);
          if (['abort', 'http', 'syntax', 'evaluation', 'initializer'].includes(kind)) {
            await p.waitForFunction(() => document.getElementById('btnBoardAppearance').title.includes('暫時無法'));
            assert.equal(await p.locator('#btnBoardAppearance').isDisabled(), true);
            assert.equal(await wood(p), true);
            assert.doesNotMatch(await p.locator('#boardAppearancePersistence').textContent(), /已在|saved/);
          }
          if (kind === 'delay') {
            assert.equal(requested, true);
            assert.equal(await p.locator('#btnBoardAppearance').isDisabled(), true);
            assert.equal(await wood(p), true);
          }
          if (['abort', 'http', 'syntax', 'evaluation', 'initializer', 'delay'].includes(kind) || (ref === beforeFeature)) {
            assert.equal(await p.evaluate(() => __loadingQA.appearanceOpens), 0, 'Unavailable optional UI never opens the photo database');
          }
          result.game = await exerciseGame(p);
          const beforeLoad = await game(p);
          if (kind === 'delay') {
            if (name === 'delayed-page-leave') {
              await p.goto('about:blank'); release(); await p.waitForTimeout(150);
              assert.equal(p.url(), 'about:blank');
              phase = 'recovery'; await p.goto(url); await boot(p); await ready(p);
              result.realNavigation = true;
            } else {
              if (name === 'delayed-bfcache-lifecycle') await p.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
              release(); await p.waitForTimeout(400);
              if (name === 'delayed-bfcache-lifecycle') {
                assert.equal(await p.evaluate(() => __loadingQA.appearanceOpens), 0);
                assert.equal(await p.locator('#btnBoardAppearance').isDisabled(), true);
                assert.equal(await wood(p), true);
                assert.equal(await game(p), beforeLoad);
                await p.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
                result.lifecycleEvents = 'Controlled pagehide/pageshow; real navigation tested separately';
              }
              await ready(p); assert.equal(await game(p), beforeLoad);
              assert.equal(await p.evaluate(() => __loadingQA.appearanceOpens), 1, 'Only the current initialization restores once');
            }
            assert.equal(await wood(p), false);
          }
        }
        assert.deepEqual(await snapshot(p), original, 'Previously saved photo and unrelated records remain intact');
        assert.deepEqual(await p.evaluate(() => __loadingQA.rejections), []);
        assert.deepEqual(result.pageErrors, []);
        result.screenshot = label + '-' + name + '.png';
        await p.screenshot({ path: path.join(output, result.screenshot) });
        // A new document retries after resources recover, including old/mixed HTML and JS.
        phase = 'recovery'; release();
        await p.reload(); await boot(p); await ready(p);
        assert.equal(await p.locator('#boardAppearanceopacity').inputValue(), '73');
        assert.equal(await wood(p), false);
        assert.deepEqual(await snapshot(p), original);
        result.recovery = 'PASS'; result.existingData = 'UNCHANGED';
        if (kind === 'healthy') {
          await toolbar(p, '#btnBoardAppearance');
          const b64 = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 200; const g = c.getContext('2d'); g.fillStyle = '#db00df'; g.fillRect(0, 0, 400, 200); return c.toDataURL().split(',')[1]; });
          const chooser = p.waitForEvent('filechooser'); await p.locator('#boardAppearanceChoose').click();
          await (await chooser).setFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') });
          await p.waitForFunction(() => document.getElementById('boardAppearanceDialog').getAttribute('aria-busy') === 'false');
          const slider = p.locator('#boardAppearanceopacity'); await slider.focus(); await slider.press('End');
          for (let i = 0; i < 8; i++) await slider.press('ArrowLeft');
          await ready(p); const saved = await snapshot(p);
          assert.equal(saved['chinese-chess-training:board-appearance'].stores.appearance[0].value.settings.opacity, .92);
          await p.reload(); await boot(p); await ready(p); assert.equal(await p.locator('#boardAppearanceopacity').inputValue(), '92');
          assert.deepEqual(await snapshot(p), saved);
          await toolbar(p, '#btnBoardAppearance'); await p.locator('#boardAppearanceReset').click();
          await p.waitForFunction(() => document.getElementById('boardAppearanceStatus').textContent.includes('已移除'));
          assert.equal(await wood(p), true); await p.reload(); await boot(p);
          await p.waitForFunction(() => !document.getElementById('btnBoardAppearance').disabled);
          assert.equal(await wood(p), true);
          const reset = await snapshot(p); assert.deepEqual(reset['chinese-chess-training:board-appearance'].stores.appearance, []);
          assert.deepEqual(reset['qa:existing-unrelated'], original['qa:existing-unrelated']);
          result.photoRegression = 'Upload, adjust, confirmed real save, reload, reset, reload PASS';
        }
        assert.deepEqual(result.pageErrors, []); assert.deepEqual(await p.evaluate(() => __loadingQA.rejections), []);
        if (['abort', 'http', 'syntax', 'evaluation', 'initializer'].includes(kind)) assert.ok(result.handledWarnings.some(x => x.includes('棋盤外觀初始化失敗')));
        result.status = 'PASS';
      } catch (error) {
        result.status = 'FAIL'; result.error = error.stack;
        await p.screenshot({ path: path.join(output, label + '-' + name + '-FAIL.png') }).catch(() => {});
      } finally {
        release(); result.requests = requests;
        await write('results', results); await context.close();
      }
      console.log(label, name, result.status);
    }
  }
} finally { await browser.close(); server.close(); }
if (results.some(r => r.status !== 'PASS')) process.exitCode = 1;
