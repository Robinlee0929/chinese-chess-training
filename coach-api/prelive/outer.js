import { createCoachHandler } from '../src/index.js';
import { accessOperatorResponse } from './access-operator.js';
import { parseRequestJSON, validateFraming } from '../src/contract.js';
import { enabled, publicEnabled, providerSecret, rateLimit, COORDINATOR_NAME, unavailable } from './policy.js';

export function createRealStagingHandler(env, options = {}) {
  const handler = createCoachHandler({ ...options,
    admission: {
      enabled: () => publicEnabled(env) && enabled(env) && providerSecret(env) !== null,
      rateLimit: (state) => rateLimit(env, state),
      // Readiness only. Persistent budget approval occurs inside the coordinator.
      costBreaker: () => typeof env?.COACH_REAL_COORDINATOR?.getByName === 'function' ? 'enabled' : 'disabled',
    },
    provider: async (input, { signal }) => {
      if (signal.aborted || !publicEnabled(env)) throw unavailable();
      const stub = env.COACH_REAL_COORDINATOR.getByName(COORDINATOR_NAME);
      try {
        const payload = await stub.execute(input);
        if (typeof payload !== 'string' || payload.length > 1024) throw unavailable();
        const framing = validateFraming(parseRequestJSON(payload));
        if (!framing) throw unavailable();
        return framing;
      } catch { throw unavailable(); }
    },
  });
  return handler;
}

export default { fetch: (request, env, ctx) => new URL(request.url).pathname.startsWith('/__operator/')
  ? accessOperatorResponse(request, env, ctx) : createRealStagingHandler(env)(request) };
