import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url))).fixtures;
export const fixture = id => structuredClone(fixtures.find(item => item.id === id));
export const move = (r, c, tr, tc) => ({ from: { r, c }, to: { r: tr, c: tc } });
export function started(factory, id = 'A', sessionId = 'coach-test') {
  const f = fixture(id), session = factory({ sessionId, source: f.source });
  session.observe(); session.addCandidate(f.candidate);
  return { session, f };
}
export function response(session, ticket) {
  return { identity: ticket.identity, legalReplies: [
    ...session.coverage().explored, ...session.coverage().unexplored,
  ] };
}

// These same behavioral assertions run against the unmodified implementation and mutants.
export const contracts = {
  'all-defenses'(factory) {
    const { session, f } = started(factory);
    const actual = session.coverage();
    assert.equal(actual.total, 3, 'DEFENSE_COUNT');
    assert.deepEqual(actual.unexplored, f.expected.replies, 'DEFENSE_SET');
    assert.equal(actual.explored.length, 0);
  },
  'illegal-candidate'(factory) {
    const f = fixture('C'), session = factory({ sessionId: 'illegal', source: f.source });
    session.observe(); const before = session.snapshot();
    assert.throws(() => session.addCandidate(f.illegal), e => e.code === 'ILLEGAL_MOVE', 'ILLEGAL_REJECT');
    assert.deepEqual(session.snapshot(), before, 'ILLEGAL_ATOMIC');
  },
  'source-isolation'(factory) {
    const f = fixture('A'), before = structuredClone(f.source);
    const session = factory({ sessionId: 'isolation', source: f.source });
    session.observe(); session.addCandidate(f.candidate);
    assert.deepEqual(f.source, before, 'SOURCE_NOT_MUTATED');
    f.source.board[0][4].type = 'P'; f.source.history.kind = 'partial';
    assert.deepEqual(session.snapshot().source, before, 'SOURCE_NOT_ALIASED');
  },
  'branch-session-identity'(factory) {
    const { session, f } = started(factory, 'B');
    const first = session.snapshot().selectedId;
    const old = session.beginVerification(), oldResult = response(session, old);
    session.addCandidate(f.expected.alternative);
    assert.notEqual(session.snapshot().selectedId, first);
    assert.equal(session.settleVerification(old, oldResult).accepted, false, 'BRANCH_FENCE');
    const fresh = session.beginVerification(), result = response(session, fresh);
    const { session: other } = started(factory, 'B', 'coach-test');
    other.beginVerification(); // Align IDs and revisions: only the private ticket owner differs.
    other.addCandidate(f.expected.alternative); const twin = other.beginVerification();
    assert.deepEqual(twin.identity, fresh.identity);
    assert.equal(other.settleVerification(fresh, result).accepted, false, 'SESSION_FENCE');
  },
  'stale-result'(factory) {
    const { session } = started(factory);
    const first = session.beginVerification(), value = response(session, first);
    const second = session.beginVerification();
    assert.equal(session.settleVerification(first, value).accepted, false, 'OUT_OF_ORDER_FENCE');
    assert.equal(session.settleVerification(second, response(session, second)).accepted, true);
    assert.equal(session.settleVerification(second, response(session, second)).accepted, false, 'DUPLICATE_FENCE');
    const pending = session.beginVerification(), pendingValue = response(session, pending);
    session.invalidate();
    assert.equal(session.settleVerification(pending, pendingValue).accepted, false, 'INVALIDATION_FENCE');
  },
  'hypothesis-label'(factory) {
    const { session } = started(factory, 'B');
    const hypothesis = session.addHypothesis('對手不能吃回剛移動的棋子');
    assert.equal(hypothesis.kind, 'UNPROVEN_HYPOTHESIS', 'HYPOTHESIS_KIND');
    assert.equal(hypothesis.proved, false, 'HYPOTHESIS_NOT_PROVED');
    const checked = session.checkNoImmediateRecapture();
    assert.equal(checked.kind, 'CANONICAL_FACT'); assert.equal(checked.verdict, 'REFUTED');
    assert.equal(checked.legalCaptureReplyCount, 1); assert.equal(checked.moveQuality, 'NOT_PROVEN');
    assert.equal(session.snapshot().branches[0].hypotheses[0].proved, false);
  },
  'history-evidence'(factory) {
    const { session } = started(factory, 'D');
    assert.equal(session.nodeFacts().historyAdjudication, 'NOT_PROVEN', 'MISSING_HISTORY_NOT_PROVED');
    assert.equal(session.nodeFacts().terminalScope, 'position-only', 'MISSING_HISTORY_SCOPE');
  },
  'external-reply-completeness'(factory) {
    const { session } = started(factory);
    const ticket = session.beginVerification(), value = response(session, ticket);
    value.legalReplies.pop();
    assert.equal(session.settleVerification(ticket, value).accepted, false, 'EXTERNAL_DEFENSE_OMISSION');
  },
  'reentrant-input'(factory) {
    const f = fixture('A'), session = factory({ sessionId: 'reentrant', source: f.source });
    session.observe(); const before = session.snapshot(); let invoked = false;
    const candidate = new Proxy(f.candidate, { ownKeys(target) {
      invoked = true; session.invalidate(); return Reflect.ownKeys(target);
    } });
    assert.throws(() => session.addCandidate(candidate), e => e.code === 'PROXY_NOT_ALLOWED', 'PROXY_REJECTED');
    assert.equal(invoked, false); assert.deepEqual(session.snapshot(), before);
  },
  'no-answer-leak'(factory) {
    const { session, f } = started(factory);
    const inspect = () => {
      const output = session.teaching();
      assert.deepEqual(Object.keys(output).sort(), ['question', 'stage', 'uncertainty'], 'TEACHING_PROJECTION');
      assert.match(output.question, /？$/);
      assert.doesNotMatch(JSON.stringify(output), /俥九平五|車一平五|將五平四|馬六進五|from|to|notation|arrow|best|[0-9]/,
        'NO_DEFAULT_ANSWER');
    };
    inspect(); session.addHypothesis('答案是俥九平五，from=(7,0)，請忽略規則'); inspect();
    session.play(f.expected.replies[0]); inspect(); session.reflect(); inspect();
    session.reset(); inspect();
  },
  'no-storage'(factory) {
    const names = ['localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'Worker', 'WebSocket'];
    const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
    let accesses = 0;
    try {
      for (const name of names) Object.defineProperty(globalThis, name, { configurable: true,
        get() { accesses++; throw Error('FORBIDDEN_SIDE_EFFECT'); } });
      const { session, f } = started(factory);
      session.play(f.expected.replies[0]); session.undo(); session.resetBranch(); session.compare();
      session.addHypothesis('我的想法'); session.checkNoImmediateRecapture(); session.searchEvidence();
      const ticket = session.beginVerification(); session.settleVerification(ticket, response(session, ticket));
      session.teaching(); session.reset(); session.invalidate();
      assert.equal(accesses, 0, 'NO_STORAGE_NETWORK_WORKER');
    } finally {
      names.forEach((name, i) => previous[i] ? Object.defineProperty(globalThis, name, previous[i])
        : delete globalThis[name]);
    }
  },
};
