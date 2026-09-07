// Storage-only dependencies. No env, provider, authority, initialization or client SQL.
const TABLES = Object.freeze(['coach_days', 'coach_reservations', 'coach_slot', 'coach_recovery', 'coach_one_shot']);
const COLUMNS = Object.freeze({
  coach_days: [['day', 'TEXT', 1, 0], ['units', 'INTEGER', 0, 1]],
  coach_reservations: [['id', 'INTEGER', 1, 0], ['day', 'TEXT', 0, 1], ['units', 'INTEGER', 0, 1], ['state', 'TEXT', 0, 1], ['terminated', 'INTEGER', 0, 1], ['finalized', 'INTEGER', 0, 1]],
  coach_slot: [['singleton', 'INTEGER', 1, 0], ['owner', 'INTEGER', 0, 0]],
  coach_recovery: [['singleton', 'INTEGER', 1, 0], ['state', 'TEXT', 0, 1], ['owner', 'INTEGER', 0, 0]],
  coach_one_shot: [['id', 'TEXT', 1, 0], ['state', 'TEXT', 0, 1]],
});
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 'INVALID';
const generation = value => value === null ? null : integer(value) !== 'INVALID' && value > 0 ? value : 'INVALID';
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : 'INVALID';
const enumeration = (value, values) => values.includes(value) ? value : 'INVALID';
const bit = value => enumeration(value, [0, 1]);

export function forensicSnapshot(storage, ...args) {
  if (args.length) throw new Error('Forensic arguments denied');
  const tablesPresent = Object.fromEntries(TABLES.map(name => [name, false]));
  const result = { version: 1, schema: { tablesPresent, consistencyStatus: 'INVALID' },
    raw: { oneShot: { rowPresent: false, state: 'NOT_AVAILABLE' },
      slot: { rowPresent: false, ownerGeneration: 'NOT_AVAILABLE' },
      recovery: { rowPresent: false, state: 'NOT_AVAILABLE', ownerGeneration: 'NOT_AVAILABLE' }, budgetRows: [], reservations: [] },
    derived: { recoveryRequired: true, recoveryReason: 'INVALID_STORAGE', accountingConsistency: 'UNKNOWN',
      attempted: 'UNKNOWN', providerFetchStarted: 'UNKNOWN', upstreamDelivery: 'UNKNOWN',
      transitionTimestamp: 'NOT_AVAILABLE', lastTransitionKind: 'NOT_AVAILABLE' },
    completeness: { truncated: false, budgetRows: 0, reservations: 0, readComplete: false } };
  try {
    const read = (query, ...values) => storage.sql.exec(query, ...values).toArray();
    for (const name of TABLES) tablesPresent[name] = read("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).length === 1;
    let valid = TABLES.every(name => tablesPresent[name]);
    for (const name of TABLES) if (tablesPresent[name]) {
      const columns = read('SELECT name, type, pk, "notnull" AS required FROM pragma_table_info(?) ORDER BY cid', name);
      valid &&= JSON.stringify(columns.map(c => [c.name, c.type, c.pk, c.required])) === JSON.stringify(COLUMNS[name]);
    }
    if (tablesPresent.coach_reservations) valid &&= /\bAUTOINCREMENT\b/iu.test(read("SELECT sql FROM sqlite_master WHERE name = 'coach_reservations'")[0]?.sql ?? '');
    // Unexpected triggers/views must not turn operational writes into hidden effects.
    if (read("SELECT name FROM sqlite_master WHERE type IN ('trigger', 'view') LIMIT 1").length) valid = false;
    if (tablesPresent.coach_one_shot) {
      const rows = read('SELECT id, state FROM coach_one_shot LIMIT 2');
      const row = rows.find(row => row.id === 'review-coach-first-live-economy-v1');
      if (row) result.raw.oneShot = { rowPresent: true, state: enumeration(row.state, ['DISARMED', 'ARMED', 'CONSUMED']) };
      valid &&= rows.length === 1 && !!row;
    }
    for (const [key, table] of [['slot', 'coach_slot'], ['recovery', 'coach_recovery']]) if (tablesPresent[table]) {
      const rows = read(`SELECT singleton, owner${key === 'recovery' ? ', state' : ''} FROM ${table} LIMIT 2`);
      const row = rows.find(row => row.singleton === 1);
      if (row) result.raw[key] = { rowPresent: true, ownerGeneration: generation(row.owner),
        ...(key === 'recovery' ? { state: enumeration(row.state, ['NORMAL', 'ACTIVE_PROVIDER', 'RECOVERY_REQUIRED']) } : {}) };
      valid &&= rows.length === 1 && !!row;
    }
    if (tablesPresent.coach_days) {
      const rows = read('SELECT day, units FROM coach_days ORDER BY day LIMIT 9');
      result.completeness.budgetRows = rows.length;
      result.completeness.truncated ||= rows.length > 8;
      result.raw.budgetRows = rows.slice(0, 8).map(row => ({ day: day(row.day), units: integer(row.units) }));
    }
    if (tablesPresent.coach_reservations) {
      const rows = read('SELECT id, day, units, state, terminated, finalized FROM coach_reservations ORDER BY id LIMIT 17');
      result.completeness.reservations = rows.length;
      result.completeness.truncated ||= rows.length > 16;
      result.raw.reservations = rows.slice(0, 16).map(row => ({ generation: generation(row.id), day: day(row.day), units: integer(row.units),
        state: enumeration(row.state, ['reserved', 'dispatching', 'started', 'consumed', 'released']), terminated: bit(row.terminated), finalized: bit(row.finalized) }));
    }
    valid &&= !JSON.stringify(result.raw).includes('"INVALID"');
    const structurallyValid = valid;
    const { slot, recovery, reservations, budgetRows } = result.raw;
    const owner = slot.ownerGeneration;
    valid &&= owner === recovery.ownerGeneration && (owner === null ? recovery.state === 'NORMAL' : recovery.state !== 'NORMAL');
    if (!result.completeness.truncated && valid) {
      valid &&= owner === null || reservations.some(row => row.generation === owner && row.finalized === 0);
      valid &&= reservations.every(row => row.units > 0 && budgetRows.some(bucket => bucket.day === row.day)
        && (['consumed', 'released'].includes(row.state) ? row.finalized === 1 : row.finalized === 0)
        && (row.state !== 'consumed' || row.terminated === 1));
      valid &&= budgetRows.every(bucket => bucket.units === reservations.filter(row => row.day === bucket.day && row.state !== 'released').reduce((sum, row) => sum + row.units, 0));
    }
    result.schema.consistencyStatus = structurallyValid ? 'VALID' : 'INVALID';
    result.completeness.readComplete = true;
    result.derived.accountingConsistency = !valid ? 'INVALID' : result.completeness.truncated ? 'UNKNOWN' : 'CONSISTENT';
    result.derived.recoveryRequired = !valid || result.completeness.truncated || owner !== null || recovery.state === 'RECOVERY_REQUIRED';
    result.derived.recoveryReason = !valid ? 'INVALID_STORAGE' : result.completeness.truncated ? 'INCOMPLETE_EVIDENCE' : owner !== null ? 'UNRESOLVED_OWNERSHIP' : 'NONE';
  } catch { /* No raw errors/content escape and no repair on read failure. */ }
  return result;
}

export function storageValid(storage) {
  const snapshot = forensicSnapshot(storage);
  return snapshot.schema.consistencyStatus === 'VALID' && snapshot.completeness.readComplete && !snapshot.completeness.truncated;
}
