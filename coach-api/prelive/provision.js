// Internal bootstrap capability, never an HTTP/RPC argument or an env flag.
// A future server-owned provisioning composition must import this explicitly.
export const INITIAL_PROVISIONING = Symbol('initial coordinator provisioning');
export function provisionCoordinator(storage, authority) {
  if (authority !== INITIAL_PROVISIONING) throw new Error('Provisioning denied');
  storage.transactionSync(() => {
    if (storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").toArray().length) {
      throw new Error('Existing storage must not be provisioned');
    }
    const sql = storage.sql;
    sql.exec('CREATE TABLE coach_days (day TEXT PRIMARY KEY, units INTEGER NOT NULL CHECK(units >= 0))');
    sql.exec(`CREATE TABLE coach_reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL,
      units INTEGER NOT NULL, state TEXT NOT NULL, terminated INTEGER NOT NULL DEFAULT 0, finalized INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('CREATE TABLE coach_slot (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner INTEGER)');
    sql.exec('INSERT INTO coach_slot (singleton, owner) VALUES (1, NULL)');
    sql.exec('CREATE TABLE coach_recovery (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), state TEXT NOT NULL, owner INTEGER)');
    sql.exec("INSERT INTO coach_recovery (singleton, state, owner) VALUES (1, 'NORMAL', NULL)");
    sql.exec('CREATE TABLE coach_one_shot (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    sql.exec("INSERT INTO coach_one_shot (id, state) VALUES ('review-coach-first-live-economy-v1', 'DISARMED')");
  });
}
