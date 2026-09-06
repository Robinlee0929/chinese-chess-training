import { createOpenAIProvider } from '../src/openai-provider.js';
import { executeRealCoachProvider } from '../src/real-provider-safety.js';
import { SYSTEM_CLOCK, boundedOperation, R3C2_B_PROVIDER_TIMEOUT_MS } from '../src/provider.js';
import { createDurableBudget } from './budget.js';
import { enabled, providerSecret, dailyLimit, providerInput, PROFILE_UNITS, rateLimit, unavailable } from './policy.js';

// The wrapper supplies platform storage and fetch; tests supply real SQLite and injected I/O.
// No dependency comes from an HTTP request or RPC argument.
export function createCoordinator(storage, env, { fetch: fetchImpl, clock = SYSTEM_CLOCK, utcNow = Date.now } = {}) {
  const budget = createDurableBudget(storage);
  return Object.freeze({
    async execute(value) {
      try {
        const result = await boundedOperation(async (signal) => {
          const input = providerInput(value);
          if (!input || !enabled(env) || providerSecret(env) === null) throw unavailable();
          const limit = dailyLimit(env);
          if (limit === null) throw unavailable();
          let reservation = null;
          const provider = createOpenAIProvider({ apiKey: providerSecret(env), clock,
            fetch: async (url, options) => {
              if (options.signal.aborted || !enabled(env)) throw unavailable();
              if (!budget.start(reservation)) throw unavailable();
              // Persist dispatch intent before network I/O. A lost continuation
              // retains this fence; known pre-dispatch failures can release it.
              try {
                await storage.sync();
                if (options.signal.aborted || !enabled(env)) throw unavailable();
              } catch (error) {
                budget.cancelBeforeDispatch(reservation);
                throw error;
              }
              if (!budget.dispatched(reservation)) throw unavailable();
              return fetchImpl(url, options);
            } });
          return await executeRealCoachProvider({
            enabledAuthority: () => enabled(env) && providerSecret(env) !== null,
            rateLimitAuthority: (options) => rateLimit(env, options),
            budgetAuthority: async () => {
              const day = new Date(utcNow()).toISOString().slice(0, 10);
              reservation = budget.reserve(day, PROFILE_UNITS[input.modelProfile], limit);
              if (reservation === null) return null;
              return { finalize: async (details) => {
                const finalized = budget.finalize(reservation, details);
                await storage.sync();
                return finalized;
              } };
            },
            concurrencyAuthority: () => {
              if (!budget.acquire(reservation)) return null;
              return { release: () => budget.terminate(reservation) };
            },
            provider,
          }, input, { signal });
        }, { clock, deadline: clock.now() + R3C2_B_PROVIDER_TIMEOUT_MS });
        if (result.kind !== 'success') throw unavailable();
        return result.value;
      } catch { throw unavailable(); }
    },
  });
}
