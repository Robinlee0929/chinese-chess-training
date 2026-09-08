const FORENSIC_PATH = '/__operator/forensics';
const FORENSIC_ORIGIN = 'https://chinese-chess-coach-forensic-staging.robinlee700929.workers.dev';
const EXPECTED_OPERATOR_EMAIL = 'robinlee700929@gmail.com';
const IDENTITY_TIMEOUT_MS = 1000;
const SNAPSHOT_TIMEOUT_MS = 3000;
const MAX_SNAPSHOT_LENGTH = 8192;
const FORENSIC_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Forensic snapshot</title>
</head>
<body>
<form method="post" action="/__operator/forensics">
<button type="submit">Request forensic snapshot</button>
</form>
</body>
</html>`;

const SYSTEM_CLOCK = Object.freeze({
  now: () => performance.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: timer => clearTimeout(timer),
});
const boundedPolicy = value => typeof value === 'string' && /^[\x21-\x7e]{1,254}$/u.test(value);
const failure = (status = 403) => Response.json({ status: 'failed' }, { status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const forensicPage = () => new Response(FORENSIC_PAGE, { status: 200, headers: {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} });

function singleAttempt(operation, clock, timeout) {
  return new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = (kind, value) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      resolve({ kind, value });
    };
    timer = clock.setTimeout(() => finish('timeout'), timeout);
    try {
      Promise.resolve(operation()).then(value => finish('success', value), () => finish('error'));
    } catch { finish('error'); }
  });
}

async function emptyBody(request, clock) {
  if (request.body === null) return true;
  const reader = request.body.getReader();
  const result = await singleAttempt(() => reader.read(), clock, IDENTITY_TIMEOUT_MS);
  reader.cancel().catch(() => {});
  return result.kind === 'success' && result.value?.done === true;
}

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}
const enumeration = (value, allowed) => allowed.includes(value);
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const generation = value => value === null || value === 'NOT_AVAILABLE' || value === 'INVALID'
  || (Number.isSafeInteger(value) && value > 0);
const day = value => value === 'INVALID' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const units = value => value === 'INVALID' || count(value, Number.MAX_SAFE_INTEGER);
const bit = value => value === 'INVALID' || value === 0 || value === 1;

function validSnapshot(value) {
  if (!exact(value, ['version', 'schema', 'raw', 'derived', 'completeness']) || value.version !== 1) return false;
  if (!exact(value.schema, ['tablesPresent', 'consistencyStatus'])
    || !exact(value.schema.tablesPresent, ['coach_days', 'coach_reservations', 'coach_slot', 'coach_recovery', 'coach_one_shot'])
    || !Object.values(value.schema.tablesPresent).every(item => typeof item === 'boolean')
    || !enumeration(value.schema.consistencyStatus, ['VALID', 'INVALID'])) return false;
  const raw = value.raw;
  if (!exact(raw, ['oneShot', 'slot', 'recovery', 'budgetRows', 'reservations'])
    || !exact(raw.oneShot, ['rowPresent', 'state']) || typeof raw.oneShot.rowPresent !== 'boolean'
    || !enumeration(raw.oneShot.state, ['NOT_AVAILABLE', 'DISARMED', 'ARMED', 'CONSUMED', 'INVALID'])
    || !exact(raw.slot, ['rowPresent', 'ownerGeneration']) || typeof raw.slot.rowPresent !== 'boolean'
    || !generation(raw.slot.ownerGeneration)
    || !exact(raw.recovery, ['rowPresent', 'state', 'ownerGeneration']) || typeof raw.recovery.rowPresent !== 'boolean'
    || !enumeration(raw.recovery.state, ['NOT_AVAILABLE', 'NORMAL', 'ACTIVE_PROVIDER', 'RECOVERY_REQUIRED', 'INVALID'])
    || !generation(raw.recovery.ownerGeneration)
    || !Array.isArray(raw.budgetRows) || raw.budgetRows.length > 8
    || !raw.budgetRows.every(row => exact(row, ['day', 'units']) && day(row.day) && units(row.units))
    || !Array.isArray(raw.reservations) || raw.reservations.length > 16
    || !raw.reservations.every(row => exact(row, ['generation', 'day', 'units', 'state', 'terminated', 'finalized'])
      && generation(row.generation) && day(row.day) && units(row.units)
      && enumeration(row.state, ['reserved', 'dispatching', 'started', 'consumed', 'released', 'INVALID'])
      && bit(row.terminated) && bit(row.finalized))) return false;
  const derived = value.derived;
  if (!exact(derived, ['recoveryRequired', 'recoveryReason', 'accountingConsistency', 'attempted',
    'providerFetchStarted', 'upstreamDelivery', 'transitionTimestamp', 'lastTransitionKind'])
    || typeof derived.recoveryRequired !== 'boolean'
    || !enumeration(derived.recoveryReason, ['INVALID_STORAGE', 'INCOMPLETE_EVIDENCE', 'UNRESOLVED_OWNERSHIP', 'NONE'])
    || !enumeration(derived.accountingConsistency, ['INVALID', 'UNKNOWN', 'CONSISTENT'])
    || derived.attempted !== 'UNKNOWN' || derived.providerFetchStarted !== 'UNKNOWN'
    || derived.upstreamDelivery !== 'UNKNOWN' || derived.transitionTimestamp !== 'NOT_AVAILABLE'
    || derived.lastTransitionKind !== 'NOT_AVAILABLE') return false;
  const completeness = value.completeness;
  if (!exact(completeness, ['truncated', 'budgetRows', 'reservations', 'readComplete'])
    || typeof completeness.truncated !== 'boolean' || typeof completeness.readComplete !== 'boolean'
    || !count(completeness.budgetRows, 9) || !count(completeness.reservations, 17)
    || raw.budgetRows.length !== Math.min(completeness.budgetRows, 8)
    || raw.reservations.length !== Math.min(completeness.reservations, 16)
    || completeness.truncated !== (completeness.budgetRows > 8 || completeness.reservations > 16)
    || ((!completeness.readComplete || completeness.truncated) && derived.accountingConsistency === 'CONSISTENT')) return false;
  return true;
}

function decodeSnapshot(encoded) {
  if (typeof encoded !== 'string' || encoded.length > MAX_SNAPSHOT_LENGTH) return null;
  try {
    const value = JSON.parse(encoded);
    if (JSON.stringify(value) !== encoded || !validSnapshot(value)) return null;
    return value;
  } catch { return null; }
}

export function createForensicCaller({ clock = SYSTEM_CLOCK } = {}) {
  return async function forensicCaller(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.origin === FORENSIC_ORIGIN && request.method === 'GET' && url.pathname === '/' && !url.search) {
        return forensicPage();
      }
      if (url.pathname !== FORENSIC_PATH || request.method !== 'POST' || url.search
        || !await emptyBody(request, clock)) return failure();
      if (url.origin !== FORENSIC_ORIGIN || request.headers.get('Origin') !== FORENSIC_ORIGIN) return failure();
      const access = ctx?.access;
      if (!access || typeof access.getIdentity !== 'function') return failure();
      const identityResult = await singleAttempt(() => access.getIdentity(), clock, IDENTITY_TIMEOUT_MS);
      if (identityResult.kind !== 'success') return failure();
      const identity = identityResult.value;
      if (!identity || typeof identity !== 'object' || Array.isArray(identity)
        || !boundedPolicy(env?.COACH_FORENSIC_ACCESS_AUD)
        || access.aud !== env.COACH_FORENSIC_ACCESS_AUD
        || identity.email !== EXPECTED_OPERATOR_EMAIL) return failure();
      const service = env?.COACH_REAL_FORENSICS;
      if (!service || typeof service.forensicSnapshot !== 'function') return failure(503);
      const outcome = await singleAttempt(() => service.forensicSnapshot(), clock, SNAPSHOT_TIMEOUT_MS);
      if (outcome.kind !== 'success') return failure(503);
      const snapshot = decodeSnapshot(outcome.value);
      if (!snapshot) return failure(503);
      return Response.json(snapshot, { status: 200,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return failure(503); }
  };
}

export default { fetch: (request, env, ctx) => createForensicCaller()(request, env, ctx) };
