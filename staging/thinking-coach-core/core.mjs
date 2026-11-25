import { copyData, exact, freeze, identifier, requireCondition, stable } from './identity.mjs';
import { advance, canonicalMove, EVIDENCE_KIND, facts, prepareSource, sameMove } from './rules.mjs';

export { EVIDENCE_KIND } from './rules.mjs';

const QUESTIONS = freeze({
  observe: '輪到誰？自己的將帥安全嗎？',
  candidate: '你想試哪一步？你希望它做到什麼？',
  defense: '如果換你下對方，你會怎麼應對？',
  variation: '對方這樣走後，你原來的想法還成立嗎？',
  reflect: '哪個回應是你一開始沒想到的？你想修改哪個想法？',
});

// A closure owns the live generation. Frozen snapshots are data, never writable session handles.
export function createCoachSession({ sessionId, source }) {
  identifier(sessionId);
  const prepared = prepareSource(source);
  let active = true, revision = 0, stage = 'observe', sequence = 0;
  let branches = [], selectedId = null, pending = null;
  const root = prepared.position;
  function requireActive() { requireCondition(active, 'SESSION_INVALID'); }
  function changed(nextStage) { revision++; pending = null; stage = nextStage; }
  function branchFor(id = selectedId) {
    requireActive();
    const branch = branches.find(item => item.id === id);
    requireCondition(branch, 'UNKNOWN_BRANCH');
    return branch;
  }
  function nodeFor(branch) { return branch.nodes.find(node => node.id === branch.cursor); }
  function identity(branch = null, node = null) {
    return freeze({ sessionId, sourceId: prepared.source.sourceId,
      sourceSessionId: prepared.source.sourceSessionId, sourceFingerprint: prepared.sourceFingerprint,
      branchId: branch?.id ?? null, nodeId: node?.id ?? null, revision,
      positionFingerprint: (node?.position ?? root).positionFingerprint });
  }
  function snapshot() {
    return freeze(structuredClone({ sessionId, active, revision, stage, selectedId,
      source: prepared.source, sourceFingerprint: prepared.sourceFingerprint, branches }));
  }
  function addCandidate(inputMove) {
    requireActive();
    requireCondition(stage !== 'observe', 'OBSERVATION_REQUIRED');
    const move = canonicalMove(inputMove);
    requireCondition(!branches.some(b => sameMove(b.candidate, move)), 'DUPLICATE_CANDIDATE');
    requireCondition(branches.length < 8, 'BRANCH_LIMIT');
    const next = advance(root, move);
    const id = `branch-${++sequence}`;
    const node = { id: `node-${++sequence}`, parentId: null, move, position: next };
    const branch = { id, candidate: move, nodes: [node], cursor: node.id, hypotheses: [] };
    branches.push(branch); selectedId = id;
    changed(next.terminal ? 'reflect' : 'defense');
    return snapshot();
  }
  function play(inputMove) {
    const branch = branchFor(), parent = nodeFor(branch);
    const move = canonicalMove(inputMove);
    const next = advance(parent.position, move);
    let child = branch.nodes.find(node => node.parentId === parent.id && sameMove(node.move, move));
    if (!child) {
      requireCondition(branch.nodes.length < 128, 'NODE_LIMIT');
      child = { id: `node-${++sequence}`, parentId: parent.id, move, position: next };
      branch.nodes.push(child);
    }
    branch.cursor = child.id;
    changed(next.terminal ? 'reflect' : 'variation');
    return snapshot();
  }
  function coverage(id = selectedId) {
    const branch = branchFor(id), node = nodeFor(branch);
    const explored = branch.nodes.filter(item => item.parentId === node.id).map(item => item.move);
    const unexplored = node.position.legalMoves.filter(move => !explored.some(other => sameMove(move, other)));
    return freeze(copyData({ identity: identity(branch, node), completeEnumeration: true,
      total: node.position.legalMoves.length, explored, unexplored,
      scope: 'immediate-legal-replies-only', continuationProved: false }));
  }
  function nodeFacts(id = selectedId) {
    const branch = branchFor(id), node = nodeFor(branch);
    return facts(node.position, identity(branch, node));
  }
  function beginVerification() {
    const branch = branchFor(), node = nodeFor(branch);
    const ticket = freeze({ requestId: ++sequence, kind: 'legal-replies', identity: identity(branch, node) });
    pending = ticket;
    return ticket;
  }
  function settleVerification(ticket, inputResult) {
    if (!active || ticket !== pending || !pending) return freeze({ accepted: false, reason: 'STALE_RESULT' });
    const branch = branchFor(), node = nodeFor(branch);
    const generation = revision, requestGeneration = sequence;
    if (stable(ticket.identity) !== stable(identity(branch, node))) {
      return freeze({ accepted: false, reason: 'IDENTITY_MISMATCH' });
    }
    // One-shot even on malformed results. No received claim is promoted into evidence.
    pending = null;
    try {
      const result = copyData(inputResult);
      exact(result, ['identity', 'legalReplies']);
      requireCondition(stable(result.identity) === stable(ticket.identity), 'IDENTITY_MISMATCH');
      requireCondition(Array.isArray(result.legalReplies), 'INVALID_REPLIES');
      const received = result.legalReplies.map(canonicalMove).map(stable).sort();
      const expected = node.position.legalMoves.map(stable).sort();
      requireCondition(stable(received) === stable(expected), 'REPLIES_MISMATCH');
      requireCondition(active && revision === generation && sequence === requestGeneration
        && pending === null && selectedId === branch.id && nodeFor(branch).id === node.id,
      'STALE_RESULT');
      return freeze({ accepted: true, evidence: facts(node.position, identity(branch, node)) });
    } catch (error) { return freeze({ accepted: false, reason: error.code || 'INVALID_RESULT' }); }
  }
  return Object.freeze({
    snapshot,
    observe() { requireActive(); changed('candidate'); return snapshot(); },
    addCandidate, play, coverage, nodeFacts, beginVerification, settleVerification,
    selectBranch(id) {
      const branch = branchFor(id); selectedId = branch.id;
      const node = nodeFor(branch);
      changed(node.position.terminal ? 'reflect' : node.parentId === null ? 'defense' : 'variation');
      return snapshot();
    },
    undo() {
      const branch = branchFor(), node = nodeFor(branch);
      requireCondition(node.parentId !== null, 'AT_CANDIDATE_ROOT');
      branch.cursor = node.parentId;
      changed(nodeFor(branch).parentId === null ? 'defense' : 'variation');
      return snapshot();
    },
    resetBranch(id = selectedId) {
      const branch = branchFor(id);
      branch.nodes = [branch.nodes[0]]; branch.cursor = branch.nodes[0].id; branch.hypotheses = [];
      selectedId = id; changed(branch.nodes[0].position.terminal ? 'reflect' : 'defense');
      return snapshot();
    },
    reset() {
      requireActive(); branches = []; selectedId = null; changed('observe'); return snapshot();
    },
    invalidate() {
      if (active) { active = false; changed('observe'); }
      return snapshot();
    },
    reflect() { branchFor(); changed('reflect'); return snapshot(); },
    teaching() {
      requireActive();
      // Deliberate projection: no moves, coordinates, hypotheses, rankings or answer data.
      return freeze({ stage, question: QUESTIONS[stage],
        uncertainty: '沒有證據支持的想法，仍然尚未證明。' });
    },
    addHypothesis(text) {
      const branch = branchFor();
      requireCondition(typeof text === 'string' && text.trim().length > 0
        && text.length <= 300 && branch.hypotheses.length < 32, 'INVALID_HYPOTHESIS');
      changed(stage);
      const hypothesis = freeze({ id: `hypothesis-${++sequence}`, kind: EVIDENCE_KIND.HYPOTHESIS,
        text, proved: false, identity: identity(branch, nodeFor(branch)) });
      branch.hypotheses.push(hypothesis);
      return hypothesis;
    },
    checkNoImmediateRecapture() {
      const branch = branchFor(), node = nodeFor(branch), current = node.position;
      if (current.terminal) return freeze({ kind: EVIDENCE_KIND.FACT, identity: identity(branch, node),
        claim: 'moved-piece-cannot-be-captured-on-next-move', verdict: 'NOT_APPLICABLE_TERMINAL',
        scope: current.terminalScope, historyAdjudication: current.historyAdjudication,
        moveQuality: 'NOT_PROVEN' });
      const target = current.lastMove.to;
      const count = current.legalMoves.filter(move => move.to.r === target.r && move.to.c === target.c).length;
      return freeze({ kind: EVIDENCE_KIND.FACT, identity: identity(branch, node),
        claim: 'moved-piece-cannot-be-captured-on-next-move',
        verdict: count ? 'REFUTED' : 'SUPPORTED_FOR_NEXT_MOVE_ONLY', legalCaptureReplyCount: count,
        scope: 'immediate-legal-replies-only', moveQuality: 'NOT_PROVEN',
        historyAdjudication: current.historyAdjudication });
    },
    compare() {
      requireActive();
      return freeze(branches.map(branch => {
        const node = branch.nodes[0];
        return { branchId: branch.id, facts: facts(node.position, identity(branch, node)),
          coverage: { explored: branch.nodes.filter(n => n.parentId === node.id).length,
            total: node.position.legalMoves.length }, quality: 'NOT_PROVEN' };
      }));
    },
    searchEvidence() {
      requireActive();
      return freeze({ kind: EVIDENCE_KIND.SEARCH, available: false, reason: 'SEARCH_NOT_RUN' });
    },
  });
}
