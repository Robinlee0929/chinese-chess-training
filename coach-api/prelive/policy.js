import { snapshotExact } from '../src/contract.js';
import { purposeFor } from '../src/rule-policy.js';

export const COORDINATOR_NAME = 'review-coach-real-provider-global-v1';
export const PROFILE_UNITS = Object.freeze({ economy: 1, balanced: 2, quality: 4 });
export const RATE_LIMITER_IS_GLOBAL_BUDGET_AUTHORITY = false;
export const RATE_LIMITER_IS_GLOBAL_CONCURRENCY_AUTHORITY = false;
const DEFAULT_ENABLED = false;

// Independent future-phase authority. Never derived from a request or one-shot state.
export function publicEnabled(env) {
  return env?.COACH_REAL_PROVIDER_PUBLIC_ENABLED === 'true';
}

export function enabled(env) {
  return env?.COACH_REAL_PROVIDER_ENABLED === 'true'
    || (env?.COACH_REAL_PROVIDER_ENABLED === undefined && DEFAULT_ENABLED);
}

export function providerSecret(env) {
  const key = env?.OPENAI_API_KEY;
  return typeof key === 'string' && /^[\x21-\x7e]{1,512}$/u.test(key) ? key : null;
}

export function dailyLimit(env) {
  const raw = env?.COACH_REAL_DAILY_UNITS;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,8})$/u.test(raw)) return null;
  const limit = Number(raw);
  if (limit === 0) return null;
  return limit;
}

export function providerInput(value) {
  const input = snapshotExact(value, ['sourceRuleId', 'locale', 'style', 'modelProfile', 'purpose']);
  if (!input || input.locale !== 'zh-Hant' || input.style !== 'child-neutral-teacher-v1'
    || !Object.hasOwn(PROFILE_UNITS, input.modelProfile)
    || purposeFor(input.sourceRuleId) === null || input.purpose !== purposeFor(input.sourceRuleId)) return null;
  return input;
}

// Fixed application key: frequency protection, never accounting or an exact global lock.
export async function rateLimit(env, { signal } = {}) {
  try {
    if (signal?.aborted) return 'unavailable';
    if (typeof env?.COACH_REAL_RATE_LIMITER?.limit !== 'function') return 'unavailable';
    const result = await env.COACH_REAL_RATE_LIMITER.limit({ key: COORDINATOR_NAME });
    if (signal?.aborted) return 'unavailable';
    return result?.success === true ? 'allowed' : result?.success === false ? 'denied' : 'unavailable';
  } catch { return 'unavailable'; }
}

export function unavailable() {
  return Object.freeze({ name: 'CoachProviderError', code: 'provider_unavailable', message: 'Provider unavailable' });
}
