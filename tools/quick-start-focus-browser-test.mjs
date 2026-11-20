// Full Chrome/Three.js, isolated contexts, synthetic games; evidence outside checkout.
// node tools/quick-start-focus-browser-test.mjs SITE OUT [--negative BASELINE_SITE]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { terminal } from './game-transfer-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const negativeIndex = process.argv.indexOf('--negative'), negative = negativeIndex >= 0;
for (const source of [root, site]) assert.ok(out !== source && !out.startsWith(source + path.sep));
await mkdir(out, { recursive: false });
let originalClose;
if (negative) {
  const source = await readFile(path.join(path.resolve(process.argv[negativeIndex + 1]), 'main.js'), 'utf8');
  originalClose = source.slice(source.indexOf('function finishQuickStartClose() {'), source.indexOf('function closeQuickStart()'));
  assert.ok(originalClose.includes('candidates.find('), 'Negative control must restore the original focus defect');
}
const server = createServer(async (request, response) => {
  try {
    const name = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(site, '.' + (name === '/' ? '/index.html' : name));
    assert.ok(file.startsWith(site + path.sep));
    let body = await readFile(file);
    if (negative && name === '/main.js') {
      const text = body.toString(), start = text.indexOf('function finishQuickStartClose() {');
      const end = text.indexOf('function closeQuickStart()', start);
      assert.ok(start > 0 && end > start);
      body = Buffer.from(text.slice(0, start) + originalClose + text.slice(end));
    }
    response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.html': 'text/html',
      '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' })[path.extname(file)]
      || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], sizes = [[320, 568], [375, 812], [390, 844], [844, 390], [1440, 1000]];
const idle = async p => {
  await p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking
    && __chess.pieces.every(m => Math.abs(m.position.y - .18) < 1e-8));
  await p.evaluate(() => new Promise(resolve => {
    let last = '', stable = 0;
    const frame = () => {
      const now = __chess.camera.position.toArray().map(n => n.toFixed(6)).join(',');
      stable = now === last ? stable + 1 : 0; last = now;
      if (stable >= 6) resolve(); else requestAnimationFrame(frame);
    }; frame();
  }));
};
const game = p => p.evaluate(() => ({ board: __chess.board, history: __chess.history,
  session: __chess.normalGameRecordSession, turn: __chess.turn, mode: __chess.mode,
  side: __chess.humanSide, appState: __chess.appState,
  local: Object.fromEntries(Object.entries(localStorage).filter(([k]) => k !== 'xiangqi.viewPrefs.v1')) }));
const layout = p => p.evaluate(() => ({ page: [scrollX, scrollY],
  stage: [document.querySelector('#stage').scrollLeft, document.querySelector('#stage').scrollTop],
  camera: __chess.camera.position.toArray(), target: __chess.controls.target.toArray(),
  tabAttributes: [...document.querySelectorAll('[tabindex]')].map(e => [e.id, e.getAttribute('tabindex')]) }));
function sameLayout(after, before) {
  for (const key of ['page', 'stage', 'tabAttributes']) assert.deepEqual(after[key], before[key], 'NO_SCROLL_OR_TAB_STOP_CHANGE');
  // OrbitControls settles near-identical IEEE-754 values even without interaction.
  // Preserve raw vectors in evidence; 1e-10 world units is far below a rendered pixel.
  for (const key of ['camera', 'target']) for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(after[key][i] - before[key][i]) < 1e-10, 'NO_CAMERA_MOVEMENT');
  }
}
const focus = p => p.evaluate(() => {
  const e = document.activeElement, s = getComputedStyle(e), b = e.getBoundingClientRect();
  return { id: e.id || e.tagName, tag: e.tagName, connected: e.isConnected,
    disabled: e.matches(':disabled'), inert: !!e.closest('[inert]'), visibility: s.visibility,
    display: s.display, visible: e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
    tabIndex: e.tabIndex, documentFocus: document.hasFocus(),
    rect: { x: b.x, y: b.y, width: b.width, height: b.height } };
});
const validFocus = f => f.id !== 'BODY' && f.connected && !f.disabled && !f.inert && f.visible;
async function open(p, entry = 'btnHelp') {
  if (!await p.locator('#' + entry).isVisible()) await p.locator('#btnMore').click();
  await p.locator('#' + entry).click();
  assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), true);
  assert.equal((await focus(p)).id, 'quickStartHeading');
}
async function close(p, method, terminalFocus = false) {
  if (method === 'Escape') await p.keyboard.press('Escape');
  else await p.locator('#quickStartClose').click();
  const immediateFocus = terminalFocus ? await focus(p) : null;
  if (terminalFocus) {
    assert.equal(immediateFocus.id, 'ovTitle', 'TERMINAL_FOCUS_SYNCHRONOUS');
    assert.ok(validFocus(immediateFocus), 'TERMINAL_FOCUS_VISIBLE_IMMEDIATELY');
  }
  await p.waitForTimeout(80); // Also observe queued close events after synchronous restoration.
  assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), false);
  return immediateFocus;
}
async function invalidate(p, id, defect) {
  await p.evaluate(({ id, defect }) => {
    const e = document.getElementById(id);
    if (defect === 'removed') e.remove();
    if (defect === 'display-none') e.style.display = 'none';
    if (defect === 'visibility-hidden') e.style.visibility = 'hidden';
    if (defect === 'inert') e.inert = true;
    if (defect === 'disabled') e.disabled = true;
    if (defect === 'opacity-zero') e.style.opacity = '0';
    if (defect === 'aria-disabled') e.setAttribute('aria-disabled', 'true');
  }, { id, defect });
}
async function check(name, size, run, expectedFailure = false) {
  const context = await browser.newContext({ viewport: { width: size[0], height: size[1] }, hasTouch: true });
  const p = await context.newPage(), r = { name, size, negative, errors: [], warnings: [] };
  p.setDefaultTimeout(20000); let failure;
  p.on('pageerror', e => r.errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error') r.errors.push(m.text()); if (m.type() === 'warning') r.warnings.push(m.text()); });
  try {
    await p.goto(url); await idle(p);
    assert.equal(p.url(), url); assert.equal(await p.title(), '中國象棋殺局訓練 · Xiangqi Mate Puzzle');
    assert.equal(await p.locator('#stage canvas').isVisible(), true);
    assert.equal(await p.evaluate(() => __chess.renderer.getContext() instanceof WebGL2RenderingContext), true);
    await p.locator('#modeSel').selectOption('pvp'); await idle(p);
    await p.evaluate(() => {
      window.quickStartFocusTrace = [];
      for (const type of ['focusin', 'focusout', 'keydown']) document.addEventListener(type, e => {
        quickStartFocusTrace.push({ type, target: e.target.id || e.target.tagName,
          active: document.activeElement.id || document.activeElement.tagName, key: e.key, trusted: e.isTrusted });
      }, true);
    });
    await run(p, r); assert.deepEqual(r.errors, []);
    assert.equal(expectedFailure, false, 'NEGATIVE_CONTROL_NOT_DETECTED'); r.status = 'PASS';
  } catch (error) {
    r.error = error.stack;
    if (expectedFailure && error instanceof assert.AssertionError
      && error.message.includes('FOCUS_MUST_LAND_ON_VALID_CONTROL')) {
      assert.equal(r.focus.id, 'BODY'); assert.deepEqual(r.errors, []);
      r.status = 'EXPECTED_FAIL_DETECTED';
    } else { r.status = 'FAIL'; failure = error; }
  } finally {
    r.events = await p.evaluate(() => window.quickStartFocusTrace || []).catch(() => []);
    await p.screenshot({ path: path.join(out, `${results.length}-${size[0]}-${name}.png`) }).catch(() => {});
    results.push(r);
    await writeFile(path.join(out, 'result.json'), JSON.stringify({ url, chrome: browser.version(),
      note: 'Isolated Chrome, synthetic games; simulated input, not real-device or screen-reader UAT', negative, results }, null, 2));
    await context.close(); console.log(JSON.stringify({ name, size, status: r.status, error: failure?.message }));
  }
  if (failure) throw failure;
}
async function matrix(p, r, entry, defect, method) {
  r.before = await game(p); r.layoutBefore = await layout(p);
  await open(p, entry); await invalidate(p, entry, defect);
  r.entry = await p.evaluate(id => {
    const e = document.getElementById(id);
    return e ? { connected: e.isConnected, disabled: e.matches(':disabled'), inert: !!e.closest('[inert]'),
      visible: e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }),
      display: getComputedStyle(e).display, visibility: getComputedStyle(e).visibility } : { connected: false };
  }, entry);
  await close(p, method);
  r.after = await game(p); r.focus = await focus(p); r.layoutAfter = await layout(p);
  assert.deepEqual(r.after, r.before, 'HELP_PRESERVES_GAME');
  sameLayout(r.layoutAfter, r.layoutBefore);
  assert.ok(validFocus(r.focus), 'FOCUS_MUST_LAND_ON_VALID_CONTROL');
  const expected = r.size[0] <= 900 ? 'btnMore' : defect === 'normal' ? entry
    : entry === 'btnHelp' ? 'btnLeftHelp' : 'btnHelp';
  assert.equal(r.focus.id, expected, 'INVOKER_FIRST_THEN_VISIBLE_HELP_FALLBACK');
  await p.keyboard.press('Tab'); r.afterTab = await focus(p);
  if (r.afterTab.documentFocus) assert.ok(validFocus(r.afterTab), 'TAB_STAYS_ON_OPERABLE_CONTROL');
}
try {
  for (const size of negative ? [[1440, 1000]] : sizes) {
    for (const entry of size[0] > 900 ? ['btnHelp', 'btnLeftHelp'] : ['btnHelp']) {
      for (const defect of negative
        ? entry === 'btnHelp' ? ['visibility-hidden', 'disabled'] : ['removed', 'display-none', 'visibility-hidden', 'inert', 'disabled']
        : ['normal', 'removed', 'display-none', 'visibility-hidden', 'inert', 'disabled']) {
        for (const method of ['Escape', 'button']) await check(`${entry}-${defect}-${method}`, size,
          (p, r) => matrix(p, r, entry, defect, method), negative);
      }
    }
  }
  if (!negative) for (const size of sizes) {
    for (const defect of ['disabled', 'visibility-hidden', 'inert', 'opacity-zero', 'aria-disabled']) {
      await check('unavailable-fallback-' + defect, size, async (p, r) => {
        const entry = size[0] > 900 ? 'btnLeftHelp' : 'btnHelp';
        r.before = await game(p); r.layoutBefore = await layout(p); await open(p, entry);
        await invalidate(p, entry, 'removed'); await invalidate(p, size[0] > 900 ? 'btnHelp' : 'btnMore', defect);
        await close(p, 'Escape'); r.focus = await focus(p);
        assert.ok(validFocus(r.focus), 'FOCUS_MUST_LAND_ON_VALID_CONTROL'); assert.equal(r.focus.id, 'btnNew');
        assert.deepEqual(await game(p), r.before); sameLayout(await layout(p), r.layoutBefore);
      });
    }
    await check('role-switch-and-rapid-reopen', size, async (p, r) => {
      r.before = await game(p); r.layoutBefore = await layout(p); await open(p);
      for (const role of ['Teacher', 'Student', 'Teacher']) {
        await p.locator('#quickStart' + role).click(); assert.equal((await focus(p)).id, 'quickStart' + role);
        assert.equal(await p.locator('#quickStart' + role).getAttribute('aria-pressed'), 'true');
      }
      for (let i = 0; i < 6; i++) {
        await p.evaluate(() => { document.querySelector('#quickStartClose').click(); document.querySelector('#btnHelp').click(); });
        await p.waitForTimeout(100);
        assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), true);
        assert.equal((await focus(p)).id, 'quickStartHeading');
        assert.equal(await p.locator('#btnHelp').getAttribute('aria-expanded'), 'true');
      }
      await close(p, 'button'); r.focus = await focus(p); assert.ok(validFocus(r.focus));
      assert.deepEqual(await game(p), r.before); sameLayout(await layout(p), r.layoutBefore);
    });
    await check('terminal-animation-rapid-reopen', size, async (p, r) => {
      const fixture = terminal();
      await p.evaluate(f => __chess.resetTo(f.initialPosition.board, f.initialPosition.sideToMove), fixture);
      await idle(p); await open(p);
      await p.evaluate(m => __chess.doMove(m.from, m.to), fixture.moves[0]);
      await p.waitForFunction(() => !document.querySelector('#overlay').classList.contains('hidden'));
      r.before = await game(p);
      // Exercise queued focus work while the terminal entrance animation is active.
      await p.evaluate(() => { document.querySelector('#quickStartClose').click(); document.querySelector('#btnHelp').click(); });
      await p.waitForTimeout(150);
      assert.equal(await p.locator('#quickStartDialog').evaluate(d => d.open), true);
      assert.equal((await focus(p)).id, 'quickStartHeading');
      assert.equal(await p.locator('#btnHelp').getAttribute('aria-expanded'), 'true');
      r.immediateFocus = await close(p, 'Escape', true); r.focus = await focus(p);
      assert.equal(r.focus.id, 'ovTitle'); assert.ok(validFocus(r.focus));
      assert.deepEqual(await game(p), r.before);
    });
    for (const method of ['Escape', 'button']) await check('terminal-priority-' + method, size, async (p, r) => {
      const fixture = terminal();
      await p.evaluate(f => __chess.resetTo(f.initialPosition.board, f.initialPosition.sideToMove), fixture);
      await idle(p); await open(p);
      await p.evaluate(m => __chess.doMove(m.from, m.to), fixture.moves[0]);
      await p.waitForFunction(() => !document.querySelector('#overlay').classList.contains('hidden'));
      r.before = await game(p); r.immediateFocus = await close(p, method, true); r.focus = await focus(p);
      assert.equal(r.focus.id, 'ovTitle'); assert.ok(validFocus(r.focus)); assert.deepEqual(await game(p), r.before);
      await p.keyboard.press('Tab'); r.afterTab = await focus(p);
      assert.ok(await p.evaluate(() => document.querySelector('#overlay').contains(document.activeElement)));
      assert.ok(validFocus(r.afterTab));
      // The inert HUD is intentionally not a user entry; invoke its existing handler
      // only to exercise reopening Help over an already active terminal presentation.
      await p.evaluate(() => document.querySelector('#btnHelp').click());
      assert.equal((await focus(p)).id, 'quickStartHeading'); r.reopenedImmediateFocus = await close(p, method, true);
      assert.equal((await focus(p)).id, 'ovTitle'); assert.deepEqual(await game(p), r.before);
    });
  }
} catch (error) { process.exitCode = 1; console.error(error); }
finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
