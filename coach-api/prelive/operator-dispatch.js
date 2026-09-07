import { purposeFor } from '../src/rule-policy.js';
import { storageValid } from './forensics.js';

const DISPATCH_ID = 'review-coach-first-live-economy-v1';
const INPUT = Object.freeze({ sourceRuleId: 'check-difference', locale: 'zh-Hant',
  style: 'child-neutral-teacher-v1', modelProfile: 'economy', purpose: purposeFor('check-difference') });
const denied = () => Object.freeze({ status: 'denied' });

// INTERNAL composition only, inside the existing global coordinator. C1F wraps
// this factory with platform Access verification; dependencies remain trusted
// server composition, never request fields. No direct arm/dispatch RPC is exposed.
export function createOperatorDispatch(storage, { authorize, execute } = {}) {
  const sql = storage.sql;
  const permitted = async (action, args) => {
    try {
      return args.length === 0 && typeof authorize === 'function' && await authorize(action) === true && storageValid(storage);
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
