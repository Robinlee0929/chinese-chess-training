// Local fake-only stand-ins, NOT distributed rate limiting or an atomic budget.
// Gates receive cancellation only, not request IDs, IPs, headers or bodies.
export function localFakeAdmission(enabled = false) {
  return Object.freeze({
    enabled: () => enabled === true,
    rateLimit: () => 'allowed',
    costBreaker: () => 'enabled',
  });
}

export async function admissionStatus(gates, signal) {
  if (!gates || typeof gates.enabled !== 'function' || typeof gates.rateLimit !== 'function'
    || typeof gates.costBreaker !== 'function') return 503;
  if (await gates.enabled({ signal }) !== true || signal.aborted) return 503;
  const rate = await gates.rateLimit({ signal });
  if (signal.aborted) return 503;
  if (rate === 'denied') return 429;
  if (rate !== 'allowed') return 503;
  if (await gates.costBreaker({ signal }) !== 'enabled' || signal.aborted) return 503;
  return 200;
}
