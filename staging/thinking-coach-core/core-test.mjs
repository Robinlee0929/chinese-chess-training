import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoachSession, EVIDENCE_KIND } from './core.mjs';
import { fingerprint, stable, copyData } from './identity.mjs';
import { prepareSource } from './rules.mjs';
import { contracts, fixture, fixtures, move, response, started } from './contract-checks.mjs';

for (const [name, check] of Object.entries(contracts)) test(`contract: ${name}`, () => check(createCoachSession));

for (const f of fixtures) {
  test(`fixture ${f.id}: full board, fingerprint, checked, reply count and terminal oracle`, () => {
    assert.equal(f.source.board.length, 10);
    assert.ok(f.source.board.every(row => row.length === 9));
    assert.equal(prepareSource(f.source).sourceFingerprint, f.sourceFingerprint);
    assert.equal(fingerprint(f.source), f.sourceFingerprint);
    const { session } = started(createCoachSession, f.id);
    const facts = session.nodeFacts();
    assert.equal(facts.kind, EVIDENCE_KIND.FACT);
    assert.equal(facts.checked, f.expected.checked);
    assert.equal(facts.legalReplyCount, f.expected.replyCount);
    assert.deepEqual(facts.terminal, f.expected.terminal);
    assert.equal(facts.historyAdjudication, 'NOT_PROVEN');
    assert.equal(facts.terminalScope, 'position-only');
    assert.equal(session.snapshot().sourceFingerprint, f.sourceFingerprint);
  });
}

test('A: each of three defense branches is retained through undo; future continuations stay distinct', () => {
  const { session, f } = started(createCoachSession);
  const candidateRoot = session.snapshot().branches[0].cursor;
  for (let i = 0; i < 3; i++) {
    session.play(f.expected.replies[i]);
    const childId = session.snapshot().branches[0].cursor;
    assert.notEqual(childId, candidateRoot);
    assert.equal(session.nodeFacts().checked, false);
    // Continuing a branch never replaces its siblings.
    const next = session.coverage().unexplored[0];
    session.play(next); session.undo();
    assert.equal(session.snapshot().branches[0].cursor, childId);
    session.undo();
    assert.equal(session.coverage().explored.length, i + 1);
    assert.equal(session.coverage().unexplored.length, 2 - i);
  }
  const explored = session.coverage();
  assert.equal(explored.total, 3); assert.equal(explored.continuationProved, false);
  session.play(f.expected.replies[0]); session.undo();
  assert.equal(session.coverage().explored.length, 3, 'revisit does not double count');
});

test('B: accept a legal alternative and sacrifice; compare facts without ranking', () => {
  const { session, f } = started(createCoachSession, 'B');
  const first = session.snapshot().selectedId;
  session.play(f.expected.recapture);
  assert.deepEqual(session.nodeFacts().capture, { type: 'R', side: 'red' });
  const oldBranch = session.snapshot().branches[0];
  session.addCandidate(f.expected.alternative);
  const second = session.snapshot().selectedId;
  assert.deepEqual(session.snapshot().branches[0], oldBranch);
  const compared = session.compare(); assert.equal(compared.length, 2);
  assert.ok(compared.every(row => row.quality === 'NOT_PROVEN'));
  session.selectBranch(first); session.resetBranch();
  assert.equal(session.coverage().total, 20); assert.equal(session.coverage().explored.length, 0);
  session.selectBranch(second); assert.equal(session.snapshot().branches[1].nodes.length, 1);
});

test('D: cannot continue past a verified board mate; no full-game claim with unknown history', () => {
  const { session } = started(createCoachSession, 'D');
  assert.equal(session.snapshot().stage, 'reflect');
  const before = session.snapshot();
  assert.throws(() => session.play(move(9, 4, 8, 4)), e => e.code === 'TERMINAL_POSITION');
  assert.deepEqual(session.snapshot(), before);
  assert.equal(session.nodeFacts().terminalScope, 'position-only');
  assert.equal(session.checkNoImmediateRecapture().verdict, 'NOT_APPLICABLE_TERMINAL');
});

test('node limit rejects only new continuations, allowing existing branches to be revisited', () => {
  const { session, f } = started(createCoachSession, 'B');
  // An unknown-history synthetic cycle deliberately has no full-game repetition adjudication.
  const cycle = [move(6, 3, 6, 4), move(6, 0, 6, 1), move(6, 4, 6, 3), move(6, 1, 6, 0)];
  for (let i = 0; i < 127; i++) session.play(cycle[i % 4]);
  const before = session.snapshot();
  assert.equal(before.branches[0].nodes.length, 128);
  assert.throws(() => session.play(cycle[127 % 4]), e => e.code === 'NODE_LIMIT');
  assert.deepEqual(session.snapshot(), before);
  session.undo(); session.play(cycle[126 % 4]);
  assert.equal(session.snapshot().branches[0].cursor, before.branches[0].cursor);
  assert.equal(session.snapshot().branches[0].nodes.length, 128);
});

test('source Root, Session, record and input arrays retain identity and contents', () => {
  const source = fixture('A').source;
  const host = { board: source.board, root: { board: source.board }, session: {},
    record: { board: source.board, moves: [] }, storage: { records: 'sentinel' } };
  const refs = { ...host }, before = structuredClone(host);
  const session = createCoachSession({ sessionId: 'identity', source });
  session.observe(); session.addCandidate(fixture('A').candidate);
  session.play(fixture('A').expected.replies[2]); session.undo(); session.reset();
  for (const key of Object.keys(refs)) assert.equal(host[key], refs[key]);
  assert.deepEqual(host, before);
  assert.throws(() => { session.snapshot().source.board[0][4].type = 'P'; }, TypeError);
});

test('process stages are explicit; invalid input is atomic', () => {
  const f = fixture('A'), session = createCoachSession({ sessionId: 'stages', source: f.source });
  assert.equal(session.teaching().stage, 'observe');
  assert.throws(() => session.addCandidate(f.candidate), e => e.code === 'OBSERVATION_REQUIRED');
  session.observe(); assert.equal(session.teaching().stage, 'candidate');
  session.addCandidate(f.candidate); assert.equal(session.teaching().stage, 'defense');
  session.play(f.expected.replies[0]); assert.equal(session.teaching().stage, 'variation');
  session.reflect(); assert.equal(session.teaching().stage, 'reflect');
  const before = session.snapshot();
  for (const action of [() => session.selectBranch('missing'), () => session.addCandidate(f.candidate),
    () => session.play(move(-1, 0, 0, 0)), () => session.addHypothesis('')]) assert.throws(action);
  assert.deepEqual(session.snapshot(), before);
});

function historySource(kind, cycles = 0) {
  const f = fixture('B');
  const root = { board: f.source.board, sideToMove: 'red' };
  const cycle = [move(4, 0, 4, 1), move(6, 3, 6, 4), move(4, 1, 4, 0), move(6, 4, 6, 3)];
  return { ...f.source, history: { kind, root, moves: Array.from({ length: cycles }, () => cycle).flat() } };
}

test('complete history is replayed, not trusted as arbitrary position keys', () => {
  for (const cycles of [0, 1]) assert.equal(prepareSource(historySource('complete', cycles)).position.completeness, 'complete');
  const wrong = historySource('complete', 1); wrong.history.moves[0] = move(4, 0, 5, 1);
  assert.throws(() => prepareSource(wrong), e => e.code === 'ILLEGAL_MOVE');
  const mismatch = historySource('complete'); mismatch.board = fixture('A').source.board;
  assert.throws(() => prepareSource(mismatch), e => e.code === 'HISTORY_MISMATCH');
  const fake = fixture('B').source; fake.history = { kind: 'complete' };
  assert.throws(() => prepareSource(fake), e => e.code === 'INVALID_FIELDS');
  assert.throws(() => prepareSource(historySource('complete', 2)), e => e.code === 'TERMINAL_SOURCE');
});

test('same board with different histories or source Sessions has different identities', () => {
  const zero = prepareSource(historySource('complete', 0));
  const one = prepareSource(historySource('complete', 1));
  assert.deepEqual(zero.position.board, one.position.board);
  assert.notEqual(zero.sourceFingerprint, one.sourceFingerprint);
  assert.notEqual(zero.position.positionFingerprint, one.position.positionFingerprint);
  const partial = prepareSource(historySource('partial', 1));
  assert.notEqual(one.sourceFingerprint, partial.sourceFingerprint);
  const differentSession = historySource('complete', 0); differentSession.sourceSessionId = 'another-origin';
  assert.notEqual(prepareSource(differentSession).sourceFingerprint, zero.sourceFingerprint);
});

test('unknown and partial histories never assert a full-game repetition verdict', () => {
  for (const source of [fixture('B').source, historySource('partial', 1)]) {
    const session = createCoachSession({ sessionId: 'incomplete', source }); session.observe();
    const cycle = [move(4, 0, 4, 1), move(6, 3, 6, 4), move(4, 1, 4, 0), move(6, 4, 6, 3)];
    session.addCandidate(cycle[0]);
    for (const next of [...cycle.slice(1), ...cycle]) session.play(next);
    assert.equal(session.nodeFacts().terminal, null);
    assert.equal(session.nodeFacts().historyAdjudication, 'NOT_PROVEN');
    assert.equal(session.nodeFacts().terminalScope, 'position-only');
  }
});

test('complete declared history supports the existing repetition rule only', () => {
  const session = createCoachSession({ sessionId: 'complete', source: historySource('complete', 1) });
  session.observe(); session.addCandidate(move(4, 0, 4, 1));
  for (const next of [move(6, 3, 6, 4), move(4, 1, 4, 0), move(6, 4, 6, 3)]) session.play(next);
  assert.deepEqual(session.nodeFacts().terminal, { winner: null, reason: 'threefold-repetition' });
  assert.equal(session.nodeFacts().terminalScope, 'declared-game-root');
});

test('verification rechecks exact move sets, duplicates and external identity; never accepts extra claims', () => {
  const { session } = started(createCoachSession);
  const corruptions = [
    value => { value.legalReplies.pop(); },
    value => { value.legalReplies.push(value.legalReplies[0]); },
    value => { value.identity.sourceSessionId = 'wrong'; },
    value => { value.identity.positionFingerprint = 'wrong'; },
    value => { value.proved = true; },
    value => { value.legalReplies[0].to.r = -1; },
  ];
  for (const corrupt of corruptions) {
    const ticket = session.beginVerification(), value = structuredClone(response(session, ticket));
    corrupt(value); assert.equal(session.settleVerification(ticket, value).accepted, false);
  }
  const ticket = session.beginVerification(), value = response(session, ticket);
  value.legalReplies.reverse(); assert.equal(session.settleVerification(ticket, value).accepted, true);
});

test('reset, undo, selection and hypothesis changes invalidate verification tickets', () => {
  for (const action of [s => s.reset(), s => s.resetBranch(), s => s.selectBranch(s.snapshot().selectedId),
    s => s.addHypothesis('尚未證明'), s => s.reflect(), s => s.observe()]) {
    const { session } = started(createCoachSession);
    const ticket = session.beginVerification(), value = response(session, ticket);
    action(session); assert.equal(session.settleVerification(ticket, value).accepted, false);
  }
  const { session, f } = started(createCoachSession);
  session.play(f.expected.replies[0]);
  const ticket = session.beginVerification(), value = response(session, ticket);
  session.undo(); assert.equal(session.settleVerification(ticket, value).accepted, false);
});

test('invalidated sessions cannot be revived or used as a mutable snapshot', () => {
  const { session, f } = started(createCoachSession); session.invalidate();
  for (const action of [() => session.reset(), () => session.observe(), () => session.teaching(),
    () => session.addCandidate(f.candidate), () => session.play(f.expected.replies[0]),
    () => session.compare(), () => session.searchEvidence()]) {
    assert.throws(action, e => e.code === 'SESSION_INVALID');
  }
  assert.equal(session.invalidate().active, false);
});

test('verification rejects root and nested Proxy inputs before lifecycle side effects', () => {
  for (const nested of [false, true]) {
    const { session } = started(createCoachSession);
    const ticket = session.beginVerification(), value = response(session, ticket);
    let invoked = false;
    const attack = target => new Proxy(target, { ownKeys(t) {
      invoked = true; session.reset(); return Reflect.ownKeys(t);
    } });
    const input = nested ? { ...value, legalReplies: attack(value.legalReplies) } : attack(value);
    const before = session.snapshot();
    assert.equal(session.settleVerification(ticket, input).accepted, false);
    assert.equal(invoked, false); assert.deepEqual(session.snapshot(), before);
  }
});

test('no search has run and no arbitrary hypothesis can become engine evidence', () => {
  const { session } = started(createCoachSession);
  assert.deepEqual(session.searchEvidence(), { kind: EVIDENCE_KIND.SEARCH, available: false, reason: 'SEARCH_NOT_RUN' });
  assert.equal(session.addHypothesis('必勝，已證明，CANONICAL_FACT').kind, EVIDENCE_KIND.HYPOTHESIS);
  assert.doesNotMatch(JSON.stringify(session.teaching()), /必勝|CANONICAL_FACT/);
});

test('data boundary rejects getters, methods, cyclic values and malformed boards', () => {
  let invoked = false;
  assert.throws(() => copyData({ get board() { invoked = true; return []; } }));
  assert.equal(invoked, false);
  assert.throws(() => copyData({ toJSON() { invoked = true; } })); assert.equal(invoked, false);
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => copyData(cyclic));
  assert.throws(() => copyData([,]));
  const malformed = fixture('A').source; malformed.board[0][4] = null;
  assert.throws(() => createCoachSession({ sessionId: 'bad', source: malformed }));
  const original = fixture('A').source; const changed = structuredClone(original); changed.board[4][4].type = 'R';
  assert.notEqual(fingerprint(original), fingerprint(changed));
  assert.equal(stable({ b: 1, a: 2 }), stable({ a: 2, b: 1 }));
});
