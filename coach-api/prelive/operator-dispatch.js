import { purposeFor } from '../src/rule-policy.js';

const DISPATCH_ID = 'review-coach-first-live-economy-v1';
const INPUT = Object.freeze({ sourceRuleId: 'check-difference', locale: 'zh-Hant',
  style: 'child-neutral-teacher-v1', modelProfile: 'economy', purpose: purposeFor('check-difference') });
const denied = () => Object.freeze({ status: 'denied' });

// INTERNAL composition only, inside the existing global coordinator. Neither this
// factory nor its methods are wired to HTTP or DO RPC. Dependencies are trusted
// server composition, never request fields. A live identity verifier/transport is
// deliberately absent; deterministic approving authorities exist ONLY in tests.
export function createOperatorDispatch(storage, { authorize, execute } = {}) {
  const sql = storage.sql;
  storage.transactionSync(() => {
    const exists = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coach_one_shot'").toArray().length === 1;
    sql.exec('CREATE TABLE IF NOT EXISTS coach_one_shot (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    // Initialize only the new schema: a missing row in an existing schema denies.
    if (!exists) sql.exec("INSERT INTO coach_one_shot (id, state) VALUES (?, 'DISARMED')", DISPATCH_ID);
  });
  const permitted = async (action, args) => {
    try {
      return args.length === 0 && typeof authorize === 'function' && await authorize(action) === true;
    } catch { return false; }
  };
  const consume = () => sql.exec("UPDATE coach_one_shot SET state = 'CONSUMED' WHERE id = ? AND state = 'ARMED' RETURNING id", DISPATCH_ID).toArray().length === 1;
  return Object.freeze({
    async arm(...args) {
      try {
        if (!await permitted('arm', args)) return denied();
        const armed = sql.exec("UPDATE coach_one_shot SET state = 'ARMED' WHERE id = ? AND state = 'DISARMED' RETURNING id", DISPATCH_ID).toArray().length === 1;
        if (!armed) return denied();
        await storage.sync();
        return Object.freeze({ status: 'armed' });
      } catch { return denied(); }
    },
    async dispatch(...args) {
      let consumed = false;
      try {
        if (!await permitted('dispatch', args) || typeof execute !== 'function') return denied();
        if (!await consume()) return denied();
        consumed = true;
        // Explicit durability barrier before any coordinator/provider execution.
        // Subsequent prerequisite denial, storage failure, timeout, lost continuation
        // or success NEVER writes this row again. There is no reset/rearm API.
        await storage.sync();
        await execute(INPUT);
        return Object.freeze({ status: 'completed', consumed: true });
      } catch {
        return consumed ? Object.freeze({ status: 'failed', consumed: true }) : denied();
      }
    },
  });
}
