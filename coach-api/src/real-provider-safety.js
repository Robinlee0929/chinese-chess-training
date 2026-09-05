import { snapshotExact } from './contract.js';

export const MAX_REAL_PROVIDER_CONCURRENCY = 1;
export const RATE_LIMITER_IS_GLOBAL_COST_ACCOUNTING = false;
export const PROVIDER_USAGE_IS_BUDGET_AUTHORITY = false;

const CONFIG_KEYS = Object.freeze([
  'enabledAuthority', 'rateLimitAuthority', 'budgetAuthority', 'concurrencyAuthority', 'provider',
]);
const DEFAULT_ENABLE = false;
const disabledAuthority = () => DEFAULT_ENABLE;

function failure() {
  return Object.freeze({ name: 'CoachProviderError', code: 'provider_unavailable', message: 'Provider unavailable' });
}

// This is a per-composition, no-queue guard. It is not a distributed or account-wide lock.
// A future staging composition may put a shared authority behind the same acquire/release contract.
export function createSingleFlightConcurrencyAuthority() {
  let inFlight = false;
  return async function acquire({ signal } = {}) {
    if (signal?.aborted || inFlight) return null;
    inFlight = true;
    let released = false;
    return Object.freeze({
      release() {
        if (released) return false;
        released = true;
        inFlight = false;
        return true;
      },
    });
  };
}

// Server composition owns every authority in this function; none is part of the browser contract.
// Rate authorization limits request frequency only. Budget authorization must come from a future
// durable/shared cost authority and must not be inferred from rate limits or provider usage data.
export async function executeRealCoachProvider(configuration, input, { signal } = {}) {
  try {
    const config = snapshotExact(configuration, CONFIG_KEYS);
    if (!config || typeof config.provider !== 'function') throw failure();

    const enabledAuthority = typeof config.enabledAuthority === 'function'
      ? config.enabledAuthority : disabledAuthority;
    if (await enabledAuthority({ signal }) !== true || signal?.aborted) throw failure();

    if (typeof config.rateLimitAuthority !== 'function') throw failure();
    if (await config.rateLimitAuthority({ signal }) !== 'allowed' || signal?.aborted) throw failure();

    let budgetAuthority = config.budgetAuthority;
    if (typeof budgetAuthority !== 'function') throw failure();
    const rawReservation = await budgetAuthority({ signal });
    const reservation = snapshotExact(rawReservation, ['finalize']);
    if (!reservation || typeof reservation.finalize !== 'function') throw failure();

    let lease = null;
    let attempted = false;
    let succeeded = false;
    let value;
    try {
      if (signal?.aborted || typeof config.concurrencyAuthority !== 'function') throw failure();
      const rawLease = await config.concurrencyAuthority({ signal });
      lease = snapshotExact(rawLease, ['release']);
      if (!lease || typeof lease.release !== 'function' || signal?.aborted) throw failure();
      attempted = true;
      value = await config.provider(input, { signal });
      if (signal?.aborted) throw failure();
      succeeded = true;
    } catch {
      succeeded = false;
    }

    let cleanupFailed = false;
    if (lease) {
      try {
        if (await lease.release() !== true) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    const outcome = attempted ? (succeeded ? 'succeeded' : 'failed') : 'not_attempted';
    try {
      // Provider output and usage are deliberately excluded from budget settlement.
      if (await reservation.finalize(Object.freeze({ attempted, outcome })) !== true) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
    if (!succeeded || cleanupFailed) throw failure();
    return value;
  } catch {
    throw failure();
  }
}
