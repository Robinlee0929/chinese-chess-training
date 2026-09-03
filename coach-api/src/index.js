import { validateRequest, parseRequestJSON, validateFraming, successEnvelope } from './contract.js';
import { DEFAULT_PROFILE_POLICY, validateProfilePolicy, capabilities } from './profile-policy.js';
import { purposeFor } from './rule-policy.js';
import { fakeProvider } from './fake-provider.js';
import { boundedOperation, SYSTEM_CLOCK, R3C2_B_PROVIDER_TIMEOUT_MS, TOTAL_TIMEOUT_MS } from './provider.js';
import { admissionStatus, localFakeAdmission } from './admission.js';
import { allowedOrigin, reply, preflight, bodyHeaderStatus, readBody } from './http.js';

export function createCoachHandler({ provider = fakeProvider, getProfilePolicy = () => DEFAULT_PROFILE_POLICY,
  admission = localFakeAdmission(), clock = SYSTEM_CLOCK } = {}) {
  return async function handle(request) {
    let origin = null;
    try {
      const deadline = clock.now() + TOTAL_TIMEOUT_MS;
      origin = request.headers.get('Origin');
      if (!allowedOrigin(origin)) return reply(403, origin);
      if (request.headers.has('Cookie') || request.headers.has('Authorization')) return reply(403, origin);
      const url = new URL(request.url);
      const method = url.pathname === '/api/review-coach' ? 'POST'
        : url.pathname === '/api/review-coach/capabilities' ? 'GET' : null;
      if (!method) return reply(404, origin);
      if (url.href.includes('?')) return reply(400, origin);
      if (request.method === 'OPTIONS') return preflight(request, origin, method);
      if (request.method !== method) return reply(405, origin, null, { Allow: `${method}, OPTIONS` });

      let validated;
      if (method === 'POST') {
        const headerStatus = bodyHeaderStatus(request.headers);
        if (headerStatus !== 200) return reply(headerStatus, origin);
        const body = await boundedOperation((signal) => readBody(request, signal),
          { clock, deadline, parentSignal: request.signal });
        if (body.kind !== 'success') return reply(400, origin);
        if (body.value.status !== 200) return reply(body.value.status, origin);
        validated = validateRequest(parseRequestJSON(body.value.text));
        if (!validated) return reply(400, origin);
      }

      const admitted = await boundedOperation((signal) => admissionStatus(admission, signal),
        { clock, deadline: Math.min(deadline, clock.now() + 500), parentSignal: request.signal });
      if (admitted.kind !== 'success') return reply(503, origin);
      if (admitted.value !== 200) return reply(admitted.value, origin);
      // Fresh policy snapshot for each POST, independent of any capabilities GET.
      const policy = validateProfilePolicy(getProfilePolicy());
      if (!policy) return reply(503, origin);
      if (method === 'GET') return reply(200, origin, capabilities(policy));
      if (!policy[validated.modelProfile]) return reply(409, origin, { version: 2, error: { code: 'profile_unavailable' } });

      const input = Object.freeze({ sourceRuleId: validated.sourceRuleId, locale: validated.locale,
        style: validated.style, modelProfile: validated.modelProfile, purpose: purposeFor(validated.sourceRuleId) });
      const result = await boundedOperation((signal) => provider(input, { signal }),
        { clock, deadline: Math.min(deadline, clock.now() + R3C2_B_PROVIDER_TIMEOUT_MS), parentSignal: request.signal });
      if (result.kind === 'timeout' || result.kind === 'aborted') return reply(504, origin);
      if (result.kind !== 'success') return reply(502, origin);
      const framing = validateFraming(result.value);
      if (!framing) return reply(502, origin);
      return reply(200, origin, successEnvelope(validated, framing));
    } catch {
      return reply(500, origin);
    }
  };
}

export default {
  fetch(request, env) {
    // Only a nonsecret boolean-like local enable flag is inspected, never passed on.
    return createCoachHandler({ admission: localFakeAdmission(env?.COACH_FAKE_ENABLED === 'true') })(request);
  },
};
