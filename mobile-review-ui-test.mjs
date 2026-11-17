import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const helper = main.match(/^function focusGameRecordPanel\([^]*?^}/m)?.[0];
assert.ok(helper, 'The panel focus policy must be available for behavioral testing');
function setup({ top = 167, bottom = 191, nested = false, overflow = 'auto', hidden = false, attached = true } = {}) {
  const panel = { scrollTop: 72, getBoundingClientRect: () => ({ top: 226, bottom: 390 }) };
  const content = { scrollTop: 300, getBoundingClientRect: () => ({ top: 290, bottom: 386 }) };
  let focused = false, options;
  const target = {
    getClientRects: () => attached ? [{}] : [],
    getBoundingClientRect: () => ({ top, bottom }),
    closest: selector => selector === '#gameReviewContent' ? nested && content : hidden,
    focus: value => { focused = true; options = value; },
  };
  const ctx = vm.createContext({ gameRecordPanel: panel, getComputedStyle: () => ({ overflowY: overflow }), target });
  vm.runInContext(helper, ctx);
  vm.runInContext('focusGameRecordPanel(target)', ctx);
  return { panel, content, focused, options };
}
test('return from a scrolled landscape review reveals the library heading before focusing', () => {
  const r = setup(); assert.equal(r.panel.scrollTop, 9); assert.equal(r.focused, true); assert.equal(r.options.preventScroll, true);
});
test('focus below the panel moves only its scroll offset', () => {
  const r = setup({ top: 390, bottom: 434 }); assert.equal(r.panel.scrollTop, 120); assert.equal(r.content.scrollTop, 300);
});
test('already visible target keeps the user scroll position', () => {
  const r = setup({ top: 250, bottom: 294 }); assert.equal(r.panel.scrollTop, 72); assert.equal(r.focused, true);
});
test('mobile review focus scrolls its content without moving the navigation panel', () => {
  const r = setup({ top: 260, bottom: 284, nested: true }); assert.equal(r.content.scrollTop, 266); assert.equal(r.panel.scrollTop, 72);
});
test('desktop content uses the existing outer scroll container', () => {
  const r = setup({ nested: true, overflow: 'visible' }); assert.equal(r.panel.scrollTop, 9); assert.equal(r.content.scrollTop, 300);
});
test('hidden, inert, aria-hidden or detached targets cannot receive focus', () => {
  for (const config of [{ hidden: true }, { attached: false }]) {
    const r = setup(config); assert.equal(r.focused, false); assert.equal(r.panel.scrollTop, 72);
  }
});
