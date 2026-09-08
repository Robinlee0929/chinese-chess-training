export const FORENSIC_COORDINATOR_NAME = 'review-coach-real-provider-global-v1';

// This adapter is hosted by the real Worker and exported only through a named
// WorkerEntrypoint. The caller receives this one method, never the DO namespace.
export function createForensicReader(env) {
  return Object.freeze({
    async forensicSnapshot(...args) {
      if (args.length) throw new Error('Forensic arguments denied');
      const namespace = env?.COACH_REAL_COORDINATOR;
      if (!namespace || typeof namespace.getByName !== 'function') throw new Error('Unavailable');
      const stub = namespace.getByName(FORENSIC_COORDINATOR_NAME);
      if (!stub || typeof stub.forensicSnapshot !== 'function') throw new Error('Unavailable');
      return stub.forensicSnapshot();
    },
  });
}
