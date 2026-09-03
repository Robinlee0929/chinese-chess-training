export const R3C2_B_PROVIDER_TIMEOUT_MS = 3000;
export const TOTAL_TIMEOUT_MS = 3500;
export const SYSTEM_CLOCK = Object.freeze({
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
});

// One attempt, explicit abort, and a single settlement gate for success/error/timeout.
// A non-cooperative promise can finish later but cannot publish or trigger a retry.
export function boundedOperation(operation, { clock, deadline, parentSignal }) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const finish = (kind, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
      if (kind !== 'success') controller.abort();
      resolve({ kind, value });
    };
    const onAbort = () => finish('aborted');
    if (parentSignal?.aborted) { finish('aborted'); return; }
    if (clock.now() >= deadline) { finish('timeout'); return; }
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    timer = clock.setTimeout(() => finish('timeout'), deadline - clock.now());
    try {
      Promise.resolve(operation(controller.signal)).then(
        (value) => clock.now() >= deadline ? finish('timeout') : finish('success', value),
        () => finish('error'),
      );
    } catch {
      finish('error');
    }
  });
}
