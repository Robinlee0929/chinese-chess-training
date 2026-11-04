import test from 'node:test';
import assert from 'node:assert/strict';
import { attachTerminalOverlayFocus } from './terminal-overlay-focus.js';

function harness({ resolveReturn = null } = {}) {
  let hidden = true, modal = null, notify;
  const events = () => ({ listeners: new Map(), addEventListener(k, fn) { this.listeners.set(k, fn); }, removeEventListener(k) { this.listeners.delete(k); } });
  const document = { ...events(), activeElement: null, querySelector: () => modal,
    defaultView: { MutationObserver: class { constructor(fn) { notify = fn; } observe() {} disconnect() { notify = () => {}; } } } };
  const node = id => ({ id, disabled: false, visible: true, inert: false, getClientRects() { return this.visible ? [{}] : []; },
    focus() { document.activeElement = this; document.listeners.get('focusin')?.({ target: this }); } });
  const header = node('header'), main = node('main'), heading = node('heading'), again = node('again'), manager = node('manager'), unavailable = node('unavailable'), fallback = node('new');
  document.body = node('body');
  unavailable.disabled = true;
  const buttons = [again, unavailable, manager];
  const overlay = { ...events(), classList: { contains: () => hidden }, querySelector: () => heading,
    querySelectorAll: () => buttons, contains: n => [heading, ...buttons].includes(n) };
  const dispose = attachTerminalOverlayFocus({ document, overlay, background: [header, main], returnTarget: resolveReturn || fallback });
  return { document, header, main, heading, again, manager, fallback, overlay, buttons, dispose,
    show() { hidden = false; notify(); }, hide() { hidden = true; notify(); }, notify() { notify(); }, modal(value) { modal = value; },
    key(key, shiftKey = false) { const e = { key, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; overlay.listeners.get('keydown')?.(e); return e; } };
}

test('hidden terminal leaves background usable and does not steal focus', () => {
  const h = harness(); assert.equal(h.header.inert, false); assert.equal(h.main.inert, false); assert.equal(h.document.activeElement, null);
});
test('shown terminal focuses its heading and makes covered controls inert', () => {
  const h = harness(); h.show(); assert.equal(h.document.activeElement, h.heading); assert.equal(h.header.inert, true); assert.equal(h.main.inert, true);
});
test('Tab/Shift-Tab stay inside visible enabled terminal actions', () => {
  const h = harness(); h.show(); h.key('Tab'); assert.equal(h.document.activeElement, h.again);
  h.key('Tab'); assert.equal(h.document.activeElement, h.manager); h.key('Tab'); assert.equal(h.document.activeElement, h.again);
  h.key('Tab', true); assert.equal(h.document.activeElement, h.manager);
  h.manager.visible = false; h.again.focus(); h.key('Tab'); assert.equal(h.document.activeElement, h.again);
});
test('background focus cannot bypass the terminal overlay', () => {
  const h = harness(); h.show(); h.fallback.focus(); assert.equal(h.document.activeElement, h.heading);
});
test('a native manager dialog owns focus and Escape above the terminal', () => {
  const h = harness(); h.show(); h.modal({}); h.fallback.focus(); assert.equal(h.document.activeElement, h.fallback);
  assert.equal(h.key('Tab').prevented, false); assert.equal(h.key('Escape').prevented, false);
  h.modal(null); h.manager.focus(); h.notify(); assert.equal(h.document.activeElement, h.manager);
});
test('Escape on the terminal does not dismiss the result or start a game', () => {
  const h = harness(); h.show(); const event = h.key('Escape'); assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  assert.equal(h.header.inert, true); assert.equal(h.document.activeElement, h.heading);
});
test('hiding restores original inert state and moves focus out of hidden result', () => {
  const h = harness(); h.main.inert = true; h.show(); h.manager.focus(); h.hide();
  assert.equal(h.header.inert, false); assert.equal(h.main.inert, true); assert.equal(h.document.activeElement, h.fallback);
});
test('hiding never steals focus from another native dialog', () => {
  const h = harness(); h.show(); h.modal({}); h.hide(); assert.equal(h.document.activeElement, h.heading); assert.equal(h.header.inert, false);
});

test('hiding recovers focus when the browser already blurred the hidden action', () => {
  const h = harness(); h.show(); h.document.activeElement = h.document.body; h.hide();
  assert.equal(h.document.activeElement, h.fallback);
});

test('destination focus resolves after restoring the background, not while inert', () => {
  let h, returned = false;
  h = harness({ resolveReturn: () => {
    assert.equal(h.main.inert, false);
    return { focus() { returned = true; } };
  } });
  h.show(); h.hide(); assert.equal(returned, true);
});
test('a result becoming ready behind the manager leaves its focus alone', () => {
  const h = harness(); h.modal({}); h.fallback.focus(); h.show(); assert.equal(h.document.activeElement, h.fallback);
  h.modal(null); h.fallback.focus(); assert.equal(h.document.activeElement, h.heading);
});
test('unrelated class changes do not reset the selected terminal action', () => {
  const h = harness(); h.show(); h.manager.focus(); h.notify(); h.notify(); assert.equal(h.document.activeElement, h.manager);
});
test('disposing restores background and removes listeners', () => {
  const h = harness(); h.show(); h.dispose(); assert.equal(h.header.inert, false); assert.equal(h.document.listeners.has('focusin'), false);
  assert.equal(h.overlay.listeners.has('keydown'), false);
});
test('negative control: removing focus containment violates the background invariant', () => {
  const h = harness(); h.show(); h.document.removeEventListener('focusin'); h.fallback.focus();
  assert.throws(() => assert.equal(h.document.activeElement, h.heading), { code: 'ERR_ASSERTION' });
});
