import test from 'node:test';
import assert from 'node:assert/strict';
import { createPointerSafety } from './pointer-safety.js';

function harness() {
  const target = () => ({ listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    removeEventListener(type) { this.listeners.delete(type); },
    emit(type, extra = {}) { const e = { type, target: this, ...extra }; this.listeners.get(type)?.(e); return e; } });
  const document = target(), window = target(), board = target(), confirm = target();
  let context = [1];
  const safety = createPointerSafety({ document, window, surface: board, readContext: () => context });
  const event = (type, init = {}) => document.emit(type, { pointerId: 1, pointerType: 'touch',
    isPrimary: true, button: 0, clientX: 100, clientY: 100, target: board, detail: 1, ...init });
  return { document, window, board, confirm, safety, event,
    change: () => { context = [2]; },
    click: (target = board, options, init) => safety.allowClick(event('click', { target, ...init }), target, options) };
}

for (const type of ['mouse', 'touch', 'pen']) for (const distance of [0, 4, 8, 9, 12, 60]) {
  test(`${type} maximum displacement ${distance}px survives return to start`, () => {
    const h = harness(); h.event('pointerdown', { pointerType: type });
    h.event('pointermove', { pointerType: type, clientX: 100 + distance });
    h.event('pointermove', { pointerType: type }); h.event('pointerup', { pointerType: type });
    assert.equal(h.click(h.board, {}, { pointerType: type }), distance <= 8);
    assert.equal(h.click(h.board, {}, { pointerType: type }), false, 'cannot consume a click twice');
  });
}
test('coalesced points count even when final position returns to start', () => {
  const h = harness(); h.event('pointerdown');
  h.event('pointermove', { getCoalescedEvents: () => [{ clientX: 120, clientY: 100 }] });
  h.event('pointerup'); assert.equal(h.click(), false);
});
for (const phase of ['active', 'ended']) test(`captured element blur preserves ${phase} tap`, () => {
  const h = harness(); h.event('pointerdown');
  if (phase === 'ended') h.event('pointerup');
  h.window.emit('blur', { target: h.confirm, currentTarget: h.window, eventPhase: 1 });
  if (phase === 'active') h.event('pointerup');
  assert.equal(h.click(), true);
});
test('element blur does not erase a fresh keyboard activation while old touch is active', () => {
  const h = harness(); h.event('pointerdown'); const after = h.safety.checkpoint();
  h.document.emit('keydown', { target: h.confirm, key: ' ', repeat: false });
  h.window.emit('blur', { target: h.board, currentTarget: h.window, eventPhase: 1 });
  assert.equal(h.click(h.confirm, { after, virtual: true }, { pointerId: -1, pointerType: '', detail: 0 }), true);
  h.event('pointerup'); assert.equal(h.click(h.confirm, { after, virtual: true }), false);
});
for (const end of ['pointercancel', 'blur', 'pagehide', 'visibilitychange', 'wheel', 'context']) {
  test(`${end} invalidates old activation and next fresh tap recovers`, () => {
    const h = harness(); h.event('pointerdown');
    if (end === 'blur' || end === 'pagehide') h.window.emit(end);
    else if (end === 'visibilitychange') { h.document.hidden = true; h.document.emit(end); }
    else if (end === 'wheel') h.board.emit('wheel');
    else if (end === 'context') h.change();
    else h.event('pointercancel');
    h.event('pointerup'); assert.equal(h.click(), false);
    h.event('pointerdown'); h.event('pointerup'); assert.equal(h.click(), true);
  });
}
test('second pointer poisons both lifetimes, including when first finger lifts first', () => {
  const h = harness(); h.event('pointerdown'); h.event('pointerdown', { pointerId: 2, isPrimary: false });
  h.event('pointerup'); assert.equal(h.click(), false);
  h.event('pointerup', { pointerId: 2 }); assert.equal(h.click(h.board, {}, { pointerId: 2 }), false);
  h.event('pointerdown', { pointerId: 3 }); h.event('pointerup', { pointerId: 3 });
  assert.equal(h.click(h.board, {}, { pointerId: 3 }), true);
});
test('unknown pointer ID cannot reuse another completed lifetime', () => {
  const h = harness(); h.event('pointerdown'); h.event('pointerup');
  assert.equal(h.click(h.board, {}, { pointerId: 2 }), false);
});
test('old pointer retargeted to a new dialog is rejected, even without any movement', () => {
  const h = harness(); h.event('pointerdown'); const after = h.safety.checkpoint();
  h.event('pointerup', { target: h.confirm }); assert.equal(h.click(h.confirm, { after, virtual: true }), false);
  h.event('pointerdown', { target: h.confirm }); h.event('pointerup', { target: h.confirm });
  assert.equal(h.click(h.confirm, { after, virtual: true }), true);
});
test('close/reopen boundary cannot reuse a formerly fresh confirmation pointer', () => {
  const h = harness(); h.event('pointerdown', { target: h.confirm });
  const after = h.safety.checkpoint(); h.event('pointerup', { target: h.confirm });
  assert.equal(h.click(h.confirm, { after, virtual: true }), false);
});
for (const key of ['Enter', ' ']) test(`fresh ${key} works while unrelated old touch is still active`, () => {
  const h = harness(); h.event('pointerdown'); const after = h.safety.checkpoint();
  h.document.emit('keydown', { target: h.confirm, key, repeat: false });
  assert.equal(h.click(h.confirm, { after, virtual: true }, { pointerId: -1, pointerType: '', detail: 0 }), true);
  h.event('pointerup'); assert.equal(h.click(h.confirm, { after, virtual: true }), false);
});
test('virtual activation is not a physical-click exception', () => {
  const h = harness(), options = { after: h.safety.checkpoint(), virtual: true };
  assert.equal(h.click(h.confirm, options, { pointerId: -1, pointerType: '', detail: 0 }), true);
  h.event('pointerdown');
  assert.equal(h.click(h.confirm, options, { pointerId: -1, pointerType: '', detail: 0 }), false);
  h.event('pointerup');
  assert.equal(h.click(h.confirm, options, { detail: 0 }), false);
});
test('legacy MouseEvent uses observed pointer lifetime, not detail alone', () => {
  const h = harness(); h.event('pointerdown'); h.event('pointermove', { clientX: 112 }); h.event('pointerup');
  assert.equal(h.click(h.board, {}, { pointerId: undefined, pointerType: undefined }), false);
});
test('disposed tracker removes listeners and rejects physical clicks', () => {
  const h = harness(); h.event('pointerdown'); h.event('pointerup'); h.safety.dispose();
  assert.equal(h.document.listeners.size, 0); assert.equal(h.window.listeners.size, 0);
  assert.equal(h.board.listeners.size, 0); assert.equal(h.click(), false);
});
