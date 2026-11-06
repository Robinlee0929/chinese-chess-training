import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  validateBoardPhotoFile, validateBoardPhotoDimensions, inspectBoardPhoto,
  boardPhotoPlacement, DEFAULT_BOARD_APPEARANCE, createBoardAppearanceController,
  BoardPhotoError,
} from './board-appearance.js';
import { createBoardAppearanceStore } from './board-appearance-store.js';
import { createBoardAppearanceUI } from './board-appearance-ui.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const asset = name => ({ image: { name }, blob: name, disposed: 0, dispose() { this.disposed++; } });
function harness(options = {}) {
  const calls = [], frames = [], states = [];
  const store = { load: async () => null, save: async record => calls.push(['save', record]),
    clear: async () => calls.push(['clear']), ...options.store };
  const controller = createBoardAppearanceController({ store,
    prepare: options.prepare || (async file => asset(file)),
    apply: (image, settings) => frames.push({ image, settings }), onChange: s => states.push(s) });
  return { controller, store, calls, frames, states };
}

test('file format, byte and dimension boundaries reject before decoding', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) validateBoardPhotoFile({ type, size: 10 * 1024 * 1024 });
  for (const f of [{ type: 'image/svg+xml', size: 1 }, { type: 'image/jpeg', size: 0 },
    { type: 'image/png', size: 10 * 1024 * 1024 + 1 }, { type: '', size: 1 }]) assert.throws(() => validateBoardPhotoFile(f));
  validateBoardPhotoDimensions(6000, 4000);
  validateBoardPhotoDimensions(8192, 1);
  for (const size of [[6001, 4000], [8193, 1], [0, 1], [NaN, 2]]) assert.throws(() => validateBoardPhotoDimensions(...size));
});

function png(width, height, animated = false) {
  const b = Buffer.alloc(animated ? 65 : 45);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  if (animated) { b.writeUInt32BE(8, 33); b.write('acTL', 37); b.write('IEND', 57); }
  else b.write('IEND', 37);
  return b;
}
function webp(kind) {
  const b = Buffer.alloc(kind === 'VP8L' ? 26 : 30);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WEBP', 8); b.write(kind, 12);
  b.writeUInt32LE(kind === 'VP8L' ? 5 : 10, 16);
  if (kind === 'VP8L') { b[20] = 47; b.writeUInt32LE(639 | (479 << 14), 21); }
  else if (kind === 'VP8X') { b.writeUIntLE(639, 24, 3); b.writeUIntLE(479, 27, 3); }
  else { b.set([157, 1, 42], 23); b.writeUInt16LE(640, 26); b.writeUInt16LE(480, 28); }
  return b;
}
test('PNG/JPEG/three WebP headers, MIME mismatch, malformed chunks and animation', () => {
  assert.deepEqual(inspectBoardPhoto(png(640, 480), 'image/png'), { width: 640, height: 480 });
  const jpeg = Buffer.from([255,216,255,224,0,2,255,192,0,8,8,1,224,2,128,1,255,217]);
  assert.deepEqual(inspectBoardPhoto(jpeg, 'image/jpeg'), { width: 640, height: 480 });
  for (const kind of ['VP8 ', 'VP8L', 'VP8X']) assert.deepEqual(inspectBoardPhoto(webp(kind), 'image/webp'), { width: 640, height: 480 });
  assert.throws(() => inspectBoardPhoto(png(640, 480, true), 'image/png'), /靜態/);
  const animation = webp('VP8X'); animation[20] = 2;
  assert.throws(() => inspectBoardPhoto(animation, 'image/webp'), /靜態/);
  const malformed = webp('VP8 '); malformed.writeUInt32LE(9999, 16);
  for (const [b, type] of [[malformed, 'image/webp'], [jpeg.subarray(0, 10), 'image/jpeg'],
    [png(640, 480).subarray(0, 35), 'image/png'], [png(640, 480), 'image/jpeg'],
    [Buffer.alloc(0), 'image/png'], [png(8193, 1), 'image/png']]) assert.throws(() => inspectBoardPhoto(b, type));
});

test('cover/contain preserve aspect and position the excess or margins', () => {
  const base = DEFAULT_BOARD_APPEARANCE;
  assert.deepEqual(boardPhotoPlacement(2000, 1000, 920, 1020, { ...base, x: 0 }), { x: -0, y: 0, width: 2040, height: 1020 });
  assert.equal(boardPhotoPlacement(2000, 1000, 920, 1020, { ...base, x: 1 }).x, -1120);
  assert.deepEqual(boardPhotoPlacement(2000, 1000, 920, 1020, { ...base, fit: 'contain', y: 1 }),
    { x: 0, y: 560, width: 920, height: 460 });
  assert.throws(() => boardPhotoPlacement(1, 1, 920, 1020, { ...base, opacity: NaN }));
});

test('session default, explicit remember, adjustments and opt-out use only own store', async () => {
  const h = harness(), c = h.controller;
  await c.select('A'); assert.equal(c.state().remember, false); assert.deepEqual(h.calls, []);
  c.setRemember(true); await c.settled(); assert.equal(c.state().persistence, 'saved');
  c.update({ ...c.state().settings, opacity: .8 }, false);
  assert.equal(c.state().persistence, 'unsaved'); assert.equal(h.calls.length, 1);
  c.update(c.state().settings); await c.settled(); assert.equal(h.calls[1][1].settings.opacity, .8);
  c.setRemember(false); await c.settled(); assert.deepEqual(h.calls.at(-1), ['clear']);
  assert.equal(h.frames.at(-1).image.name, 'A');
});

test('rapid replacement serializes decoding, drops queued intermediate files and releases obsolete results', async () => {
  const pending = deferred(), a = asset('A'), started = [];
  const h = harness({ prepare: async f => { started.push(f); return f === 'A' ? pending.promise : asset(f); } });
  const first = h.controller.select('A'); await tick();
  const middle = h.controller.select('B'), last = h.controller.select('C');
  pending.resolve(a); await Promise.all([first, middle, last]);
  assert.deepEqual(started, ['A', 'C']); assert.equal(a.disposed, 1);
  assert.deepEqual(h.frames.map(f => f.image.name), ['C']); assert.equal(h.controller.state().loading, false);
});

test('reset during decoding cannot resurrect a photo', async () => {
  const pending = deferred(), a = asset('A'); const h = harness({ prepare: () => pending.promise });
  const selecting = h.controller.select('A'); await tick(); await h.controller.reset();
  pending.resolve(a); await selecting;
  assert.equal(a.disposed, 1); assert.equal(h.controller.state().hasPhoto, false);
  assert.equal(h.frames.at(-1).image, null);
});

test('load failure preserves last working photo and does not rewrite saved data', async () => {
  const a = asset('A'), h = harness({ prepare: async f => { if (f === 'bad') throw new BoardPhotoError('無效圖片'); return a; } });
  await h.controller.select('A'); h.controller.setRemember(true); await h.controller.settled();
  await h.controller.select('bad');
  assert.equal(h.controller.state().hasPhoto, true); assert.equal(a.disposed, 0);
  assert.equal(h.controller.state().message, '無效圖片'); assert.equal(h.calls.length, 1);
});

test('late restore cannot overwrite a new selection, or a reset', async () => {
  for (const reset of [false, true]) {
    const pending = deferred(), h = harness({ store: { load: () => pending.promise } });
    const restoring = h.controller.restore();
    if (reset) await h.controller.reset(); else await h.controller.select('new');
    pending.resolve({ blob: 'old', settings: DEFAULT_BOARD_APPEARANCE }); await restoring;
    assert.equal(h.frames.at(-1).image?.name ?? null, reset ? null : 'new');
  }
});

test('save failure keeps usable photo; retry only happens after explicit request', async () => {
  let count = 0; const h = harness({ store: { save: async () => { if (++count === 1) throw Error('quota'); } } });
  await h.controller.select('A'); h.controller.setRemember(true); await h.controller.settled();
  assert.equal(h.controller.state().persistence, 'error'); assert.equal(count, 1);
  assert.equal(h.controller.state().hasPhoto, true);
  await h.controller.retry(); assert.equal(count, 2); assert.equal(h.controller.state().persistence, 'saved');
});

test('in-flight save completes before newer reset deletion; late status cannot claim saved', async () => {
  const pending = deferred(), order = [];
  const h = harness({ store: { save: async () => { order.push('save:start'); await pending.promise; order.push('save:end'); }, clear: async () => order.push('clear') } });
  await h.controller.select('A'); h.controller.setRemember(true); await tick();
  const resetting = h.controller.reset(); pending.resolve(); await resetting;
  assert.deepEqual(order, ['save:start', 'save:end', 'clear']);
  assert.equal(h.controller.state().hasPhoto, false); assert.equal(h.controller.state().persistence, 'session');
});

test('clear failure is visible, corrupt restore never writes, and disposal releases resources', async () => {
  const a = asset('A'); const h = harness({ prepare: async () => a, store: { clear: async () => { throw Error(); }, load: async () => { throw Error(); } } });
  await h.controller.restore(); assert.match(h.controller.state().message, /無法讀取/); assert.deepEqual(h.calls, []);
  await h.controller.select('A'); await h.controller.reset();
  assert.equal(a.disposed, 1); assert.equal(h.controller.state().persistence, 'error'); assert.match(h.controller.state().message, /下次/);
  const pending = deferred(), b = asset('B'), h2 = harness({ prepare: () => pending.promise });
  const task = h2.controller.select('B'); await tick(); h2.controller.dispose(); pending.resolve(b); await task;
  assert.equal(b.disposed, 1); assert.equal(h2.frames.at(-1).image, null);
});

test('store rejects unavailable IDB and malformed data without other persistence APIs', async () => {
  const s = createBoardAppearanceStore({ factory: () => undefined });
  await assert.rejects(s.load()); await assert.rejects(s.clear());
  assert.throws(() => s.save({ version: 1, blob: new Blob(['x'], { type: 'image/png' }), settings: DEFAULT_BOARD_APPEARANCE }));
  s.dispose(); await assert.rejects(s.load());
  for (const file of ['board-appearance.js', 'board-appearance-store.js', 'board-appearance-ui.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|sendBeacon|localStorage|sessionStorage)\b/);
    assert.doesNotMatch(source, /from ['"]\.\/(?:game|ai|puzzle|custom-position)/);
  }
});

test('P2: a completed 50% save cannot mark a newer 90% preview saved', async () => {
  const pending = deferred(); let stored;
  const h = harness({ store: { save: async record => { await pending.promise; stored = record; } } });
  const c = h.controller;
  await c.select('A'); c.setRemember(true); await tick();
  c.update({ ...c.state().settings, opacity: .9 }, false);
  pending.resolve(); await c.settled();
  assert.equal(stored.settings.opacity, .5);
  assert.equal(c.state().settings.opacity, .9);
  assert.equal(c.state().persistence, 'unsaved');
  // Closing the dialog commits an unsaved preview even after the earlier save finished.
  c.update(c.state().settings); await c.settled();
  assert.equal(stored.settings.opacity, .9); assert.equal(c.state().persistence, 'saved');
});

test('P2: rapid edits coalesce and writes stay serialized until the latest 92% save completes', async () => {
  const first = deferred(), last = deferred(), writes = []; let stored, active = 0, peak = 0;
  const h = harness({ store: { save: async record => {
    peak = Math.max(peak, ++active); writes.push(record.settings.opacity);
    await (writes.length === 1 ? first : last).promise;
    stored = record; active--;
  } } });
  const c = h.controller;
  await c.select('A'); c.setRemember(true); await tick();
  for (const opacity of [.6, .8, .92]) c.update({ ...c.state().settings, opacity });
  assert.deepEqual(writes, [.5]);
  first.resolve(); await tick();
  assert.deepEqual(writes, [.5, .92]); assert.equal(c.state().persistence, 'saving');
  last.resolve(); await c.settled();
  assert.equal(peak, 1); assert.equal(stored.settings.opacity, .92);
  assert.equal(c.state().persistence, 'saved');
});

test('P2: old success/failure on either side of preview edits never loses the latest settings', async () => {
  for (const fail of [false, true]) for (const completeFirst of [false, true]) {
    const pending = deferred(); let attempt = 0, stored;
    const h = harness({ store: { save: async record => {
      if (++attempt === 1) await pending.promise;
      stored = record;
    } } });
    const c = h.controller;
    await c.select('A'); c.setRemember(true); await tick();
    if (!completeFirst) c.update({ ...c.state().settings, opacity: .92 }, false);
    if (fail) pending.reject(Error('quota')); else pending.resolve();
    await c.settled();
    if (completeFirst) c.update({ ...c.state().settings, opacity: .92 }, false);
    assert.equal(c.state().settings.opacity, .92); assert.equal(c.state().persistence, 'unsaved');
    await c.retry();
    assert.equal(stored.settings.opacity, .92); assert.equal(c.state().persistence, 'saved');
  }
});

test('P2: latest save failure retains preview and explicit retry saves that same version', async () => {
  let fail = false, stored;
  const h = harness({ store: { save: async record => { if (fail) throw Error('quota'); stored = record; } } });
  const c = h.controller;
  await c.select('A'); c.setRemember(true); await c.settled();
  fail = true; c.update({ ...c.state().settings, opacity: .92 }); await c.settled();
  assert.equal(c.state().persistence, 'error'); assert.equal(c.state().settings.opacity, .92);
  assert.equal(stored.settings.opacity, .5);
  fail = false; await c.retry();
  assert.equal(stored.settings.opacity, .92); assert.equal(c.state().persistence, 'saved');
});

const appearanceIds = [...readFileSync(new URL('./index.html', import.meta.url), 'utf8')
  .matchAll(/id="((?:boardAppearance|btnBoardAppearance)[^"]*)"/g)].map(match => match[1]);
test('P2: old HTML and every missing appearance element disable only the optional UI', () => {
  for (const missing of [null, ...appearanceIds]) {
    const elements = Object.fromEntries(appearanceIds.map(id => [id, {
      showModal() {}, close() {},
      getContext() { throw Error('Must preflight every element before touching canvas'); },
      addEventListener() { throw Error('Must not attach a partially initialized UI'); },
    }]));
    const doc = { getElementById: id => missing === null || missing === id ? null : elements[id] };
    const ui = createBoardAppearanceUI({ doc });
    assert.doesNotThrow(() => ui.dispose());
    if (missing !== null && missing !== 'btnBoardAppearance') assert.equal(elements.btnBoardAppearance.disabled, true);
  }
});

test('P2: the optional UI guard does not swallow unexpected initialization errors', () => {
  const elements = Object.fromEntries(appearanceIds.map(id => [id, { showModal() {}, close() {} }]));
  elements.boardAppearancePreview.getContext = () => { throw Error('unexpected canvas error'); };
  assert.throws(() => createBoardAppearanceUI({ doc: { getElementById: id => elements[id] } }), /unexpected canvas error/);
});
