// One input lifetime shared by board taps and destructive-dialog activation.
// Observe only: OrbitControls retains ownership of capture, rotation and zoom.
export function createPointerSafety({ document, window = document.defaultView,
  surface, readContext = () => [] }) {
  let sequence = 0, latest = null, keyboard = null;
  const active = new Map(), ended = new Map(), keys = new WeakMap(), listeners = [];
  const contains = (parent, child) => parent === child || !!parent?.contains?.(child);
  const contextMatches = before => {
    const now = readContext();
    return before.length === now.length && before.every((value, i) => value === now[i]);
  };
  function listen(target, type, handler, options = true) {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  }
  function move(record, event) {
    for (const p of [...(event.getCoalescedEvents?.() ?? []), event]) {
      record.distance = Math.max(record.distance, Math.hypot(p.clientX - record.x, p.clientY - record.y));
    }
    if (!Number.isFinite(record.distance) || record.distance > 8) record.invalid = true;
  }
  function invalidate() {
    for (const record of [...active.values(), ...ended.values()]) record.invalid = true;
    active.clear();
    keyboard = null;
  }
  listen(document, 'pointerdown', event => {
    const multiple = active.size > 0;
    if (multiple) for (const record of active.values()) record.invalid = true;
    ended.delete(event.pointerId);
    keyboard = null;
    active.set(event.pointerId, { sequence: ++sequence, target: event.target,
      type: event.pointerType, x: event.clientX, y: event.clientY, distance: 0,
      context: readContext(), invalid: multiple || event.isPrimary === false || event.button !== 0 });
  });
  listen(document, 'pointermove', event => {
    const record = active.get(event.pointerId);
    if (record) move(record, event);
  });
  function finish(event) {
    const record = active.get(event.pointerId);
    if (!record) return;
    move(record, event);
    record.invalid ||= event.type === 'pointercancel';
    record.endTarget = event.target;
    active.delete(event.pointerId);
    ended.delete(event.pointerId);
    ended.set(event.pointerId, record);
    latest = record;
    // A missing/evicted lifetime fails closed; retain no unbounded touch IDs.
    while (ended.size > 32) ended.delete(ended.keys().next().value);
  }
  listen(document, 'pointerup', finish);
  listen(document, 'pointercancel', finish);
  listen(document, 'keydown', event => {
    keyboard = ['Enter', ' '].includes(event.key)
      ? { sequence: ++sequence, target: event.target, invalid: event.repeat } : null;
  });
  listen(document, 'click', event => {
    if (!pointerClick(event)) { keys.set(event, keyboard); keyboard = null; }
  });
  function pointerClick(event) {
    return !!event.pointerType || event.pointerId >= 0 || event.detail > 0
      || event.sourceCapabilities?.firesTouchEvents === true;
  }
  // Captured element blur also reaches Window (e.g. a button loses focus
  // between pointerup and click). Only actual window deactivation cancels input.
  listen(window, 'blur', event => { if (event.target === window) invalidate(); });
  listen(window, 'pagehide', invalidate);
  listen(document, 'visibilitychange', () => { if (document.hidden) invalidate(); });
  if (surface) listen(surface, 'wheel', invalidate, { capture: true, passive: true });

  function allowClick(event, target, { after = -1, virtual = false } = {}) {
    if (!pointerClick(event)) {
      const key = keys.get(event);
      keys.delete(event);
      if (key) return !key.invalid && key.sequence > after && contains(target, key.target);
      // Accessibility activation has no pointer lifetime. Do not confuse a
      // still-active physical gesture with such an activation. No timer or
      // isTrusted/detail-only exception can authorize a physical click.
      return virtual && event.detail === 0 && active.size === 0;
    }
    const record = event.pointerId >= 0 ? ended.get(event.pointerId) : latest;
    if (!record || record.consumed) return false;
    record.consumed = true;
    return !record.invalid && record.sequence > after && active.size === 0
      && (!event.pointerType || record.type === event.pointerType)
      && contains(target, record.target) && contains(target, record.endTarget)
      && contextMatches(record.context);
  }
  return Object.freeze({ checkpoint: () => sequence, allowClick, invalidate,
    dispose() { for (const remove of listeners.splice(0)) remove(); invalidate(); ended.clear(); latest = null; } });
}
