// Test-only classification. An injection miss is a coverage gap, not a safety verdict.
export const MAX_INJECTION_ATTEMPTS = 12;
export function classifyReadPending(event, operationId) {
  const matches = Object.entries(event?.phases ?? {}).filter(([, t]) => t.operationId === operationId);
  const [transactionId, phase] = matches[0] ?? [];
  const hit = event?.isTrusted === true && matches.length === 1
    && phase.phase === 'read-pending' && phase.commitPerf === null
    && phase.readCallbacks === 0
    && JSON.stringify(phase.readKeys) === '["envelope","metadata"]'
    && JSON.stringify(phase.requests) === '["pending","pending"]';
  return { result: hit ? 'CAPTURED' : 'INCOMPLETE', hit, transactionId: transactionId ?? null,
    phase: phase ?? null, eventPerf: event?.perf ?? null };
}
export function classifyFreeze(frozen, operationId) {
  const result = classifyReadPending(frozen.freezeEvent, operationId);
  if (!frozen.commandAcknowledged || frozen.probeDuringFreeze !== null) {
    return { ...result, hit: false, result: 'INCOMPLETE' };
  }
  return result;
}
export async function boundedInjection(attempt, record, onHit, previousAttempts = 0) {
  if (!Number.isInteger(previousAttempts) || previousAttempts < 0 || previousAttempts > MAX_INJECTION_ATTEMPTS) throw Error('Invalid attempt count');
  for (let number = previousAttempts + 1; number <= MAX_INJECTION_ATTEMPTS; number++) {
    const evidence = await attempt(number);
    // All misses and the valid precondition are persisted before any destructive action.
    await record(number, evidence);
    if (evidence.capture.hit) {
      await onHit(number, evidence);
      return { result: 'PASS', attempts: number };
    }
  }
  return { result: 'INCOMPLETE', attempts: MAX_INJECTION_ATTEMPTS };
}
