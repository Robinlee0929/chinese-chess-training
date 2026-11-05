// Presentation-only focus boundary. Native dialogs (for example My Positions)
// own focus while open; this module never starts, resumes or finalizes a game.
export function attachTerminalOverlayFocus({ document, overlay, background, returnTarget }) {
  const heading = overlay.querySelector('[tabindex="-1"]');
  const priorInert = new Map();
  let visible = false;
  const showing = () => !overlay.classList.contains('hidden');
  const ownsFocus = () => showing() && !document.querySelector('dialog[open]');
  const controls = () => [...overlay.querySelectorAll('button')]
    .filter(button => !button.disabled && button.getClientRects().length);
  function focusHeading() { heading.focus({ preventScroll: true }); }
  function sync() {
    const next = showing();
    if (next === visible) return;
    visible = next;
    if (visible) {
      for (const node of background) { priorInert.set(node, node.inert); node.inert = true; }
      if (ownsFocus() && !overlay.contains(document.activeElement)) focusHeading();
    } else {
      for (const [node, inert] of priorInert) node.inert = inert;
      priorInert.clear();
      if (!document.querySelector('dialog[open]')
        && (overlay.contains(document.activeElement) || document.activeElement === document.body)) {
        // The destination may have attempted focus while its background was
        // still inert. Resolve it after restoring that background.
        const target = typeof returnTarget === 'function' ? returnTarget() : returnTarget;
        target.focus({ preventScroll: true });
      }
    }
  }
  function containFocus(event) {
    if (ownsFocus() && !overlay.contains(event.target)) focusHeading();
  }
  function onKey(event) {
    if (!ownsFocus()) return;
    if (event.key === 'Escape') {
      // Leaving the result requires an explicit game/review action, as before.
      event.preventDefault(); event.stopPropagation();
    } else if (event.key === 'Tab') {
      const buttons = controls(), index = buttons.indexOf(document.activeElement);
      const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1)
        : (index + 1) % buttons.length;
      event.preventDefault();
      if (buttons.length) buttons[next].focus({ preventScroll: true }); else focusHeading();
    }
  }
  const observer = new document.defaultView.MutationObserver(sync);
  observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('focusin', containFocus);
  overlay.addEventListener('keydown', onKey);
  sync();
  return () => {
    observer.disconnect(); document.removeEventListener('focusin', containFocus);
    overlay.removeEventListener('keydown', onKey);
    for (const [node, inert] of priorInert) node.inert = inert;
    priorInert.clear();
  };
}
