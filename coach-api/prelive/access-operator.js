import { COORDINATOR_NAME } from './policy.js';
import { createOperatorDispatch } from './operator-dispatch.js';
import { boundedOperation, SYSTEM_CLOCK } from '../src/provider.js';

const denied = () => ({ status: 'denied' });
const bounded = value => typeof value === 'string' && /^[\x21-\x7e]{1,254}$/u.test(value);

async function emptyBody(request) {
  const reader = request.body.getReader();
  try {
    const result = await boundedOperation(async () => {
      const part = await reader.read();
      return part.done === true;
    }, { clock: SYSTEM_CLOCK, deadline: SYSTEM_CLOCK.now() + 1000 });
    return result.kind === 'success' && result.value === true;
  } finally {
    // Cancellation is observed but a hostile stream cannot hold the denial open.
    await boundedOperation(() => reader.cancel().catch(() => {}),
      { clock: SYSTEM_CLOCK, deadline: SYSTEM_CLOCK.now() + 100 });
  }
}

// Deployment-time policy, absent in committed configuration. Exact matching only.
export function operatorClaimAllowed(env, claim) {
  return bounded(env?.COACH_OPERATOR_ACCESS_AUD) && bounded(env?.COACH_OPERATOR_EMAIL)
    && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(env.COACH_OPERATOR_EMAIL)
    && claim?.aud === env.COACH_OPERATOR_ACCESS_AUD && claim?.email === env.COACH_OPERATOR_EMAIL;
}

// Internal binding boundary: claim is constructed ONLY from platform ctx.access
// by the owning Worker, never deserialized from HTTP. Do not expose this RPC to
// another Worker/service or forward arbitrary RPC arguments from a public route.
export async function executeAccessOperator(storage, env, execute, action, claim) {
  if (!['arm', 'dispatch'].includes(action) || !operatorClaimAllowed(env, claim)) return denied();
  const operator = createOperatorDispatch(storage, {
    authorize: requested => requested === action && operatorClaimAllowed(env, claim), execute,
  });
  return operator[action]();
}

export async function accessOperatorResponse(request, env, ctx) {
  const reply = (value = denied(), status = 403) => Response.json(value, { status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  try {
    const url = new URL(request.url);
    const action = url.pathname === '/__operator/one-shot/arm' ? 'arm'
      : url.pathname === '/__operator/one-shot/dispatch' ? 'dispatch' : null;
    if (!action || request.method !== 'POST' || url.search
      || (request.body !== null && !await emptyBody(request))) return reply();
    // First-live interaction is same-origin interactive Access only. No CORS or
    // missing-Origin command-line fallback. Origin is CSRF defense, NOT identity.
    const origin = env?.COACH_OPERATOR_ORIGIN;
    if (typeof origin !== 'string' || !origin.startsWith('https://')
      || new URL(origin).origin !== origin || url.origin !== origin
      || request.headers.get('Origin') !== origin) return reply();
    const access = ctx?.access;
    if (!access || typeof access.getIdentity !== 'function') return reply();
    const lookup = await boundedOperation(() => access.getIdentity(),
      { clock: SYSTEM_CLOCK, deadline: SYSTEM_CLOCK.now() + 1000 });
    if (lookup.kind !== 'success') return reply();
    const identity = lookup.value;
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return reply();
    const claim = { aud: access.aud, email: identity?.email };
    if (!operatorClaimAllowed(env, claim)) return reply();
    const stub = env.COACH_REAL_COORDINATOR.getByName(COORDINATOR_NAME);
    const encoded = await stub.accessOperator(action, claim);
    if (typeof encoded !== 'string' || encoded.length > 128) return reply();
    const result = JSON.parse(encoded);
    // Reconstruct bounded responses: never relay identity, provider data or errors.
    if (result?.status === 'armed' && action === 'arm') return reply({ status: 'armed' }, 200);
    if (result?.consumed === true && action === 'dispatch'
      && ['completed', 'failed'].includes(result.status)) {
      return reply({ status: result.status, consumed: true }, result.status === 'completed' ? 200 : 503);
    }
    return reply();
  } catch { return reply(); }
}
