import { forensicSnapshot, storageValid } from './forensics.js';
// SQL is the authority for both the UTC usage buckets and the single occupied slot.
// Units are a usage circuit breaker, not measured token usage or dollar accounting.
export function createDurableBudget(storage) {
  const sql = storage.sql;
  // Read-only reconstruction; absent/invalid evidence never triggers provisioning.
  const initial = forensicSnapshot(storage);
  const ready = initial.schema.consistencyStatus === 'VALID' && initial.completeness.readComplete && !initial.completeness.truncated;
  let locallyOwned = null;
  const row = (id) => sql.exec('SELECT * FROM coach_reservations WHERE id = ?', id).toArray()[0];
  return Object.freeze({
    // Internal/local inspection only: not exported by the DO RPC or HTTP surface.
    // Arguments (including age, alarm or alleged proof) confer no authority.
    inspectRecovery() {
      const snapshot = forensicSnapshot(storage);
      return Object.freeze({ state: snapshot.derived.recoveryRequired
        ? (locallyOwned === snapshot.raw.slot.ownerGeneration && locallyOwned !== null && snapshot.raw.recovery.state === 'ACTIVE_PROVIDER' ? 'ACTIVE_PROVIDER' : 'RECOVERY_REQUIRED') : 'NORMAL',
        owner: snapshot.raw.slot.ownerGeneration });
    },
    reserve(day, units, limit) {
      if (!ready || !storageValid(storage)) return null;
      return storage.transactionSync(() => {
        sql.exec('INSERT OR IGNORE INTO coach_days (day, units) VALUES (?, 0)', day);
        const used = sql.exec('SELECT units FROM coach_days WHERE day = ?', day).toArray()[0].units;
        if (used + units > limit) return null;
        sql.exec('UPDATE coach_days SET units = units + ? WHERE day = ?', units, day);
        return sql.exec("INSERT INTO coach_reservations (day, units, state) VALUES (?, ?, 'reserved') RETURNING id", day, units).toArray()[0].id;
      });
    },
    acquire(id) {
      return storage.transactionSync(() => {
        if (this.inspectRecovery().state === 'RECOVERY_REQUIRED') return false;
        const acquired = sql.exec('UPDATE coach_slot SET owner = ? WHERE singleton = 1 AND owner IS NULL RETURNING owner', id).toArray().length === 1;
        if (acquired) sql.exec("UPDATE coach_recovery SET state = 'ACTIVE_PROVIDER', owner = ? WHERE singleton = 1", id);
        if (acquired) locallyOwned = id;
        return acquired;
      });
    },
    start(id) {
      return storage.transactionSync(() => {
        const owner = sql.exec('SELECT owner FROM coach_slot WHERE singleton = 1').toArray()[0].owner;
        if (owner !== id) return false;
        return sql.exec("UPDATE coach_reservations SET state = 'dispatching' WHERE id = ? AND state = 'reserved' AND finalized = 0 RETURNING id", id).toArray().length === 1;
      });
    },
    dispatched(id) {
      return sql.exec("UPDATE coach_reservations SET state = 'started' WHERE id = ? AND state = 'dispatching' RETURNING id", id).toArray().length === 1;
    },
    cancelBeforeDispatch(id) {
      // Only the dispatch closure may call this, while it knows fetch was never invoked.
      // A started operation can never take this transition.
      return sql.exec("UPDATE coach_reservations SET state = 'reserved' WHERE id = ? AND state = 'dispatching' RETURNING id", id).toArray().length === 1;
    },
    terminate(id) {
      // C1B calls release only after the registered fetch/body drain. Keep the slot
      // occupied until budget finalization commits too, including across restarts.
      return sql.exec('UPDATE coach_reservations SET terminated = 1 WHERE id = ? AND terminated = 0 AND finalized = 0 RETURNING id', id).toArray().length === 1;
    },
    finalize(id, details) {
      return storage.transactionSync(() => {
        const reservation = row(id);
        if (!reservation || reservation.finalized !== 0) return false;
        const started = reservation.state === 'started' || reservation.state === 'dispatching';
        if (started && (!details.attempted || reservation.terminated !== 1)) return false;
        if (!started) sql.exec('UPDATE coach_days SET units = units - ? WHERE day = ?', reservation.units, reservation.day);
        sql.exec("UPDATE coach_reservations SET finalized = finalized + 1, state = ? WHERE id = ?", started ? 'consumed' : 'released', id);
        sql.exec('UPDATE coach_slot SET owner = NULL WHERE singleton = 1 AND owner = ?', id);
        // The AUTOINCREMENT reservation id is also the server-owned operation
        // generation. A stale completion can only settle its own generation.
        sql.exec("UPDATE coach_recovery SET state = 'NORMAL', owner = NULL WHERE singleton = 1 AND owner = ?", id);
        return true;
      });
    },
  });
}
