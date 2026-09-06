// SQL is the authority for both the UTC usage buckets and the single occupied slot.
// Units are a usage circuit breaker, not measured token usage or dollar accounting.
export function createDurableBudget(storage) {
  const sql = storage.sql;
  storage.transactionSync(() => {
    sql.exec('CREATE TABLE IF NOT EXISTS coach_days (day TEXT PRIMARY KEY, units INTEGER NOT NULL CHECK(units >= 0))');
    sql.exec(`CREATE TABLE IF NOT EXISTS coach_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, units INTEGER NOT NULL,
      state TEXT NOT NULL, terminated INTEGER NOT NULL DEFAULT 0, finalized INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('CREATE TABLE IF NOT EXISTS coach_slot (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner INTEGER)');
    sql.exec('INSERT OR IGNORE INTO coach_slot (singleton, owner) VALUES (1, NULL)');
  });
  const row = (id) => sql.exec('SELECT * FROM coach_reservations WHERE id = ?', id).toArray()[0];
  return Object.freeze({
    reserve(day, units, limit) {
      return storage.transactionSync(() => {
        sql.exec('INSERT OR IGNORE INTO coach_days (day, units) VALUES (?, 0)', day);
        const used = sql.exec('SELECT units FROM coach_days WHERE day = ?', day).toArray()[0].units;
        if (used + units > limit) return null;
        sql.exec('UPDATE coach_days SET units = units + ? WHERE day = ?', units, day);
        return sql.exec("INSERT INTO coach_reservations (day, units, state) VALUES (?, ?, 'reserved') RETURNING id", day, units).toArray()[0].id;
      });
    },
    acquire(id) {
      return sql.exec('UPDATE coach_slot SET owner = ? WHERE singleton = 1 AND owner IS NULL RETURNING owner', id).toArray().length === 1;
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
        return true;
      });
    },
  });
}
