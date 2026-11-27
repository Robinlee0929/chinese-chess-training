import { createBrowserCoach } from '../thinking-coach-browser/browser-coach.mjs';

// A view adapter, not another rules engine. Only the JSON-only core owns chess state.
// No diagnostic object or core handle is exposed to the renderer.
export function createSandbox(sourceText) {
  const core = createBrowserCoach(sourceText);
  const key = crypto.randomUUID();
  let version = 0, rootMode = true, closed = false, facts = null;
  const run = (op, fields = {}) => JSON.parse(core.dispatch(JSON.stringify({ op, ...fields })));
  const snapshot = () => run('snapshot');
  const token = () => ({ key, version });
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  function request(text, operations) {
    if (typeof text !== 'string' || text.length > 4096) fail('JSON_TEXT_REQUIRED');
    const command = JSON.parse(text);
    if (!command || typeof command !== 'object' || Array.isArray(command)) fail('INVALID_COMMAND');
    if (closed || command.token?.key !== key || command.token?.version !== version) fail('STALE_VIEW');
    if (!operations.includes(command.type)) fail('INVALID_COMMAND');
    const fields = ['type', 'token', ...(command.type === 'move' ? ['move'] : ['branch', 'node'].includes(command.type) ? ['id'] : [])];
    if (Object.keys(command).some(k => !fields.includes(k))) fail('INVALID_COMMAND');
    return command;
  }
  const selected = state => state.branches.find(b => b.id === state.selectedId);
  const current = branch => branch?.nodes.find(n => n.id === branch.cursor);
  function project() {
    if (closed) fail('SESSION_DESTROYED');
    const state = snapshot(), branch = selected(state), node = current(branch);
    const position = rootMode ? state.source : node.position;
    const teaching = JSON.parse(core.teaching());
    return {
      token: token(), board: position.board, side: position.sideToMove,
      rootMode, selectedId: rootMode ? null : state.selectedId,
      teaching: { stage: teaching.stage, question: teaching.question, uncertainty: teaching.uncertainty },
      // These are exclusively moves already entered by the child, never legalMoves/coverage.
      branches: state.branches.map(b => ({ id: b.id, move: b.candidate, count: b.nodes.length })),
      visited: rootMode ? [] : branch.nodes.map(n => ({ id: n.id, parentId: n.parentId, move: n.move, selected: n.id === branch.cursor })),
      canUndo: !rootMode, canCheck: !rootMode, facts,
    };
  }
  function act(text) {
    const c = request(text, ['observe', 'move', 'root', 'branch', 'node', 'undo', 'reflect', 'reset', 'clearFacts']);
    const state = snapshot(), branch = selected(state), node = current(branch);
    if (c.type === 'observe' || c.type === 'root') { run('observe'); rootMode = true; }
    else if (c.type === 'move') { run(rootMode ? 'addCandidate' : 'play', { move: c.move }); rootMode = false; }
    else if (c.type === 'branch') { run('selectBranch', { id: c.id }); rootMode = false; }
    else if (c.type === 'node') {
      if (rootMode || !branch.nodes.some(n => n.id === c.id)) fail('UNKNOWN_NODE');
      const route = []; let target = branch.nodes.find(n => n.id === c.id);
      while (target.parentId !== null) { route.unshift(target.move); target = branch.nodes.find(n => n.id === target.parentId); }
      // Undo/replay reuses the core's existing children. No resetBranch or pruning.
      let cursor = node;
      while (cursor.parentId !== null) { run('undo'); cursor = branch.nodes.find(n => n.id === cursor.parentId); }
      for (const move of route) run('play', { move });
      run('selectBranch', { id: branch.id });
    } else if (c.type === 'undo') {
      if (rootMode) fail('AT_SOURCE');
      if (node.parentId === null) { run('observe'); rootMode = true; } else run('undo');
    } else if (c.type === 'reflect') {
      if (rootMode) fail('CANDIDATE_REQUIRED');
      run('reflect');
    } else if (c.type === 'reset') { run('reset'); rootMode = true; }
    facts = null; version++;
    return JSON.stringify(project());
  }
  async function check(text) {
    request(text, ['check']);
    if (rootMode) fail('CANDIDATE_REQUIRED');
    const generation = version, pending = run('beginVerification'), coverage = run('coverage');
    // A real asynchronous boundary exercises the same lifecycle fence used by future work.
    // There is no Worker, network, AI search or result supplied by the renderer.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (closed || generation !== version) return JSON.stringify({ accepted: false, reason: 'STALE_VIEW' });
    const result = run('settleVerification', { ticket: pending.ticket, result: {
      identity: pending.identity, legalReplies: [...coverage.explored, ...coverage.unexplored],
    } });
    if (!result.accepted) return JSON.stringify({ accepted: false, reason: result.reason });
    const f = result.evidence, recapture = run('checkNoImmediateRecapture');
    // Explicit scalar allowlist. Even after consent no reply coordinates are rendered.
    facts = { kind: 'CANONICAL_FACT', checked: f.checked, capture: f.capture?.type ?? null,
      replyCount: f.legalReplyCount, explored: coverage.explored.length,
      terminal: f.terminal ? { reason: f.terminal.reason, winner: f.terminal.winner } : null,
      scope: f.terminalScope, history: f.historyAdjudication, recapture: recapture.verdict,
      comparisons: JSON.parse(core.teaching()).stage === 'reflect' ? run('compare').map(row => ({
        id: row.branchId, replies: row.coverage.total, explored: row.coverage.explored, quality: 'NOT_PROVEN',
      })) : [],
    };
    version++;
    return JSON.stringify({ accepted: true, view: project() });
  }
  return Object.freeze({ view: () => JSON.stringify(project()), act, check,
    destroy() { closed = true; version++; facts = null; core.destroy(); },
  });
}
