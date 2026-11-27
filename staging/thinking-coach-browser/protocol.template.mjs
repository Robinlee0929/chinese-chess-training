// Build input, not an object API. All functions remain private in browser-coach.mjs.
function parseInput(text) {
  // This check precedes length, JSON.parse, reflection and all coercion.
  requireCondition(typeof text === 'string', 'JSON_TEXT_REQUIRED');
  requireCondition(text.length <= 262144 && new TextEncoder().encode(text).length <= 262144, 'JSON_SIZE');
  let at = 0, remaining = 30000;
  const whitespace = () => { while (at < text.length && /[\x20\t\n\r]/.test(text[at])) at++; };
  function string() {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') return JSON.parse(text.slice(start, at)); // No reviver; primitive substring only.
    }
    throw Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON' });
  }
  function value(depth) {
    requireCondition(depth <= 16 && --remaining >= 0, 'JSON_LIMIT');
    whitespace(); const c = text[at];
    if (c === '"') return string();
    if (c === '{' || c === '[') {
      const object = c === '{', end = object ? '}' : ']', output = object ? {} : [], keys = new Set();
      at++; whitespace();
      if (text[at] === end) { at++; return output; }
      while (true) {
        whitespace();
        let key;
        if (object) {
          requireCondition(text[at] === '"', 'INVALID_JSON'); key = string();
          requireCondition(!keys.has(key), 'DUPLICATE_KEY');
          requireCondition(!['__proto__', 'prototype', 'constructor'].includes(key), 'FORBIDDEN_KEY');
          keys.add(key); whitespace(); requireCondition(text[at++] === ':', 'INVALID_JSON');
        }
        const child = value(depth + 1);
        if (object) output[key] = child; else output.push(child);
        whitespace(); const separator = text[at++];
        if (separator === end) return output;
        requireCondition(separator === ',', 'INVALID_JSON');
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
    requireCondition(token, 'INVALID_JSON'); at += token[0].length;
    const parsed = JSON.parse(token[0]);
    requireCondition(typeof parsed !== 'number' || Number.isFinite(parsed), 'INVALID_NUMBER');
    return parsed;
  }
  const parsed = value(0); whitespace(); requireCondition(at === text.length, 'INVALID_JSON');
  return parsed;
}

function boardFields(board) {
  requireCondition(Array.isArray(board) && board.length === 10, 'INVALID_BOARD');
  for (const row of board) {
    requireCondition(Array.isArray(row) && row.length === 9, 'INVALID_BOARD');
    for (const piece of row) if (piece !== null) {
      exact(piece, ['type', 'side']);
      requireCondition(['K','A','B','N','R','C','P'].includes(piece.type)
        && ['red','black'].includes(piece.side), 'INVALID_PIECE');
    }
  }
}
function sourceFields(source) {
  exact(source, ['sourceId','sourceSessionId','board','sideToMove','history']);
  boardFields(source.board);
  const history = source.history;
  requireCondition(history && typeof history === 'object', 'INVALID_HISTORY');
  if (history.kind === 'unknown') exact(history, ['kind']);
  else {
    requireCondition(['partial','complete'].includes(history.kind), 'INVALID_HISTORY');
    exact(history, ['kind','root','moves']); exact(history.root, ['board','sideToMove']);
    boardFields(history.root.board);
    requireCondition(Array.isArray(history.moves) && history.moves.length <= 1024, 'HISTORY_LIMIT');
    for (const move of history.moves) canonicalMove(move);
  }
}

// Only these two functions are exported by the generated browser entrypoint.
export function fingerprintJSON(text) { return fingerprint(parseInput(text)); }

export function createBrowserCoach(text) {
  const input = parseInput(text);
  exact(input, ['sessionId','source']); sourceFields(input.source);
  let session = createCoachSession(input), pending = null;
  const uuid = () => globalThis.crypto.randomUUID();
  const encode = value => JSON.stringify(value); // Private data only, never caller objects.
  function dispatch(text) {
    const command = parseInput(text);
    requireCondition(session !== null, 'SESSION_DESTROYED');
    requireCondition(command && typeof command === 'object' && !Array.isArray(command), 'INVALID_COMMAND');
    const op = command.op;
    const noArgs = ['snapshot','observe','coverage','nodeFacts','undo','reset','invalidate','reflect',
      'teaching','compare','checkNoImmediateRecapture','searchEvidence'];
    if (noArgs.includes(op)) {
      exact(command, ['op']); return encode(session[op]());
    }
    if (op === 'addCandidate' || op === 'play') {
      exact(command, ['op','move']); return encode(session[op](command.move));
    }
    if (op === 'selectBranch' || op === 'resetBranch') {
      exact(command, ['op','id']); identifier(command.id); return encode(session[op](command.id));
    }
    if (op === 'addHypothesis') {
      exact(command, ['op','text']); return encode(session.addHypothesis(command.text));
    }
    if (op === 'beginVerification') {
      exact(command, ['op']);
      // Generate before mutating the core so unavailable randomness fails atomically.
      const handle = uuid(), ticket = session.beginVerification();
      pending = { handle, ticket };
      return encode({ ticket: handle, identity: ticket.identity });
    }
    if (op === 'settleVerification') {
      exact(command, ['op','ticket','result']);
      requireCondition(typeof command.ticket === 'string', 'INVALID_TICKET');
      if (!pending || command.ticket !== pending.handle) return encode({ accepted:false, reason:'STALE_RESULT' });
      const ticket = pending.ticket; pending = null;
      return encode(session.settleVerification(ticket, command.result));
    }
    throw Object.assign(new Error('UNKNOWN_COMMAND'), { code:'UNKNOWN_COMMAND' });
  }
  return Object.freeze({ dispatch,
    teaching() { requireCondition(session !== null, 'SESSION_DESTROYED'); return encode(session.teaching()); },
    destroy() { if (session) session.invalidate(); session = null; pending = null; },
  });
}
