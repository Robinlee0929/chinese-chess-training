import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  deriveGameReviewTeaching,
  GAME_REVIEW_TEACHING_MAX_MESSAGES,
} from './game-review-teaching.js';

const source = readFileSync(new URL('./game-review-teaching.js', import.meta.url), 'utf8');
const FORBIDDEN = Object.freeze([
  '完美', '最佳', '最好', '比較好', '比較差', '你走錯了', '失誤', '大錯', '大漏著', '漏吃',
  '白送', '掉子', '懸子', '一定會被吃', '賺子', '賺更多', '子力優勢', '優勢', '勝率',
  '評分', '評估值', '分數', 'score', 'evaluation', 'PV', '妙手', '牽制', '串擊', '必勝', '必敗',
]);
const clone = (value) => structuredClone(value);

function coordinate(r, c) {
  return { r, c };
}

function piece(side, type) {
  const names = {
    red: { K: '帥', A: '仕', B: '相', N: '傌', R: '俥', C: '炮', P: '兵' },
    black: { K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' },
  };
  return { side, type, name: names[side][type] };
}

function outcome({
  from = coordinate(2, 3), to = coordinate(3, 3), notation = '俥六進一',
  capture = null, givesCheck = false, terminal = null, repetitionVerdict = null,
  replies = [], movedPiece = piece('red', 'R'),
} = {}) {
  return {
    evidenceType: 'CANONICAL_FACT',
    move: { from, to },
    movedPiece,
    notation,
    legal: true,
    capture,
    givesCheck,
    sideToMoveAfter: 'black',
    terminal,
    repetitionVerdict,
    materialAfter: { red: {}, black: {} },
    materialDeltaBySide: { red: {}, black: {} },
    legalReplyCount: terminal ? null : Math.max(2, replies.length),
    movedPieceCaptureReplies: terminal ? null : replies,
  };
}

function evidence({ played = {}, candidate = {}, match = false } = {}) {
  const playedOutcome = outcome({
    from: coordinate(2, 3), to: coordinate(3, 3), notation: '俥六進一', ...played,
  });
  const candidateOutcome = match ? clone(playedOutcome) : outcome({
    from: coordinate(2, 3), to: coordinate(2, 4), notation: '俥六平五', ...candidate,
  });
  return {
    kind: 'review-move-comparison',
    evidenceType: 'CANONICAL_FACT',
    source: {
      recordId: 'teaching-fixture',
      ply: 3,
      sideToMove: 'red',
      positionKey: 'position|red',
      r3aRevision: 7,
    },
    candidateProvenance: { evidenceType: 'ENGINE_SEARCH_EVIDENCE', preset: 'review-v1', completedDepth: 2 },
    materialBefore: { red: {}, black: {} },
    played: playedOutcome,
    candidate: candidateOutcome,
    comparison: { status: match ? 'MATCH' : 'DIFFERENT', sameMove: match },
  };
}

function reply(to = coordinate(2, 4)) {
  return { move: { from: coordinate(4, 4), to }, notation: '馬５退３' };
}

function terminal(reason, winner = 'red') {
  return { winner, terminationReason: reason };
}

function repetition(reason) {
  if (reason === 'perpetual-check') return {
    terminal: terminal(reason, 'black'),
    repetitionVerdict: { result: 'loss', loser: 'red', reason: '長將' },
  };
  return {
    terminal: terminal(reason, null),
    repetitionVerdict: {
      result: 'draw',
      reason: reason === 'threefold-repetition' ? '三次重複局面' : '雙方長將',
    },
  };
}

function onlyMessage(input, ruleId) {
  const messages = deriveGameReviewTeaching(input);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ruleId, ruleId);
  return messages[0];
}

function assertDeepFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function assertAllowedLanguage(text) {
  for (const term of FORBIDDEN) assert.doesNotMatch(text, new RegExp(term, 'i'));
}

function pathExists(root, path) {
  let value = root;
  for (const key of path.split('.')) {
    if (!value || !Object.prototype.hasOwnProperty.call(value, key)) return false;
    value = value[key];
  }
  return true;
}

function tokenizeDependencySyntax(candidate) {
  const tokens = [];
  let index = 0;
  const identifierStart = (character) => /[A-Za-z_$]/.test(character || '');
  const identifierPart = (character) => /[A-Za-z0-9_$]/.test(character || '');

  const readString = (quote) => {
    const start = ++index;
    while (index < candidate.length) {
      if (candidate[index] === '\\') {
        index += 2;
      } else if (candidate[index] === quote) {
        tokens.push({ type: 'string', value: candidate.slice(start, index) });
        index++;
        return;
      } else {
        index++;
      }
    }
    tokens.push({ type: 'string', value: candidate.slice(start) });
  };

  const readCode = (stopAtTemplateBrace = false) => {
    let braceDepth = 0;
    while (index < candidate.length) {
      const character = candidate[index];
      if (/\s/.test(character)) {
        index++;
        continue;
      }
      if (character === '/' && candidate[index + 1] === '/') {
        index += 2;
        while (index < candidate.length && !/[\r\n]/.test(candidate[index])) index++;
        continue;
      }
      if (character === '/' && candidate[index + 1] === '*') {
        index += 2;
        while (index < candidate.length
          && !(candidate[index] === '*' && candidate[index + 1] === '/')) index++;
        index = Math.min(candidate.length, index + 2);
        continue;
      }
      if (character === '"' || character === "'") {
        readString(character);
        continue;
      }
      if (character === '`') {
        index++;
        while (index < candidate.length) {
          if (candidate[index] === '\\') {
            index += 2;
          } else if (candidate[index] === '`') {
            index++;
            break;
          } else if (candidate[index] === '$' && candidate[index + 1] === '{') {
            index += 2;
            readCode(true);
          } else {
            index++;
          }
        }
        continue;
      }
      if (stopAtTemplateBrace && character === '}' && braceDepth === 0) {
        index++;
        return;
      }
      if (identifierStart(character)) {
        const start = index++;
        while (identifierPart(candidate[index])) index++;
        tokens.push({ type: 'identifier', value: candidate.slice(start, index) });
        continue;
      }
      if (character === '{') braceDepth++;
      if (character === '}' && braceDepth > 0) braceDepth--;
      tokens.push({ type: 'punctuator', value: character });
      index++;
    }
  };

  readCode();
  return tokens;
}

function productionDependencies(candidate) {
  const tokens = tokenizeDependencySyntax(candidate);
  const dependencies = [];
  const tokenIs = (token, type, value) => token?.type === type && token.value === value;
  const add = (kind, token) => dependencies.push({
    kind,
    specifier: token?.type === 'string' ? token.value : '<computed>',
  });

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    if (tokenIs(token, 'identifier', 'import')
      && !tokenIs(previous, 'punctuator', '.')) {
      if (tokenIs(next, 'punctuator', '.')) continue; // import.meta
      if (tokenIs(next, 'punctuator', '(')) {
        add('dynamic-import', tokens[index + 2]);
        continue;
      }
      if (next?.type === 'string') {
        add('static-import', next);
        continue;
      }
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        if (tokenIs(tokens[cursor], 'punctuator', ';')) break;
        if (tokenIs(tokens[cursor], 'identifier', 'from')
          && tokens[cursor + 1]?.type === 'string') {
          add('static-import', tokens[cursor + 1]);
          break;
        }
      }
      continue;
    }
    if (tokenIs(token, 'identifier', 'export')
      && (tokenIs(next, 'punctuator', '*') || tokenIs(next, 'punctuator', '{'))) {
      for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        if (tokenIs(tokens[cursor], 'punctuator', ';')) break;
        if (tokenIs(tokens[cursor], 'identifier', 'from')
          && tokens[cursor + 1]?.type === 'string') {
          add('export-from', tokens[cursor + 1]);
          break;
        }
      }
      continue;
    }
    if (tokenIs(token, 'identifier', 'require')
      && !tokenIs(previous, 'punctuator', '.')
      && tokenIs(next, 'punctuator', '(')) {
      add('commonjs-require', tokens[index + 2]);
    }
  }
  return dependencies;
}

function assertPureMapperSource(candidate) {
  assert.deepEqual(productionDependencies(candidate), [],
    'game-review-teaching.js must have zero production dependencies');
  const forbidden = [
    /\b(?:legalMoves|applyMove|replay|inCheck|findBestMove|Worker)\b/,
    /\b(?:board|snapshot)\b/,
    /\b(?:localStorage|fetch|XMLHttpRequest|WebSocket)\b/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(candidate, pattern);
}

function nonterminalTeachingCases() {
  const noUseful = evidence();
  noUseful.played.movedPieceCaptureReplies = [reply(coordinate(3, 3))];
  noUseful.candidate.movedPieceCaptureReplies = [reply(coordinate(2, 4))];
  return [
    ['check-difference', evidence({ candidate: { givesCheck: true } })],
    ['capture-difference', evidence({ candidate: { capture: piece('black', 'R') } })],
    ['capture-with-capture-reply', evidence({ candidate: {
      capture: piece('black', 'P'), replies: [reply()],
    } })],
    ['moved-piece-capturable-difference', evidence({ candidate: { replies: [reply()] } })],
    ['no-useful-rule', noUseful],
  ];
}

function withLegalReplyCounts(input, playedCount, candidateCount) {
  const mutated = clone(input);
  assert.ok(playedCount >= mutated.played.movedPieceCaptureReplies.length);
  assert.ok(candidateCount >= mutated.candidate.movedPieceCaptureReplies.length);
  mutated.played.legalReplyCount = playedCount;
  mutated.candidate.legalReplyCount = candidateCount;
  return mutated;
}

function withMaterialDeltas(input, playedDelta, candidateDelta) {
  const mutated = clone(input);
  mutated.played.materialDeltaBySide = clone(playedDelta);
  mutated.candidate.materialDeltaBySide = clone(candidateDelta);
  return mutated;
}

function assertLegalReplyCountInvariance(derive = deriveGameReviewTeaching) {
  for (const [label, input] of nonterminalTeachingCases()) {
    const baseline = derive(input);
    const variants = [
      withLegalReplyCounts(input,
        Math.max(7, input.played.movedPieceCaptureReplies.length),
        Math.max(1, input.candidate.movedPieceCaptureReplies.length)),
      withLegalReplyCounts(input,
        Math.max(30, input.played.movedPieceCaptureReplies.length),
        Math.max(0, input.candidate.movedPieceCaptureReplies.length)),
    ];
    for (const variant of variants) {
      assert.deepEqual(derive(variant), baseline,
        `${label} must ignore legalReplyCount`);
    }
  }
}

function assertMaterialDeltaInvariance(derive = deriveGameReviewTeaching) {
  for (const [label, input] of nonterminalTeachingCases()) {
    const baseline = derive(input);
    const variants = [
      withMaterialDeltas(input, { red: { P: -1 }, black: {} },
        { red: {}, black: { R: -1 } }),
      withMaterialDeltas(input, { red: { R: 2 }, black: { C: -3 } },
        { red: { N: -4 }, black: { P: 5 } }),
    ];
    for (const variant of variants) {
      assert.deepEqual(derive(variant), baseline,
        `${label} must ignore materialDeltaBySide`);
    }
  }
}

function sourceWithLineEnding(candidate, eol) {
  return candidate.replace(/\r\n|\r|\n/g, '\n').replaceAll('\n', eol);
}

function injectAfterUniqueLine(candidate, targetLine, injectedLine, label) {
  const matches = [];
  for (const eol of ['\r\n', '\n']) {
    const target = `${targetLine}${eol}`;
    let index = candidate.indexOf(target);
    while (index !== -1) {
      matches.push({ index, target, eol });
      index = candidate.indexOf(target, index + target.length);
    }
  }
  assert.equal(matches.length, 1, `${label} mutation target occurs exactly once`);
  const [{ index, target, eol }] = matches;
  const insertAt = index + target.length;
  return `${candidate.slice(0, insertAt)}${injectedLine}${eol}${candidate.slice(insertAt)}`;
}

async function importMutatedMapper(candidate, targetLine, injectedLine, label) {
  const mutated = injectAfterUniqueLine(candidate, targetLine, injectedLine, label);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`;
  return import(dataUrl);
}

test('MATCH is a non-emitting suppressor', () => {
  assert.deepEqual(deriveGameReviewTeaching(evidence({ match: true })), []);
});

test('candidate-only, played-only and both immediate mate variants', () => {
  const candidate = onlyMessage(evidence({ candidate: {
    terminal: terminal('checkmate'), givesCheck: true, capture: piece('black', 'P'),
  } }), 'immediate-mate');
  assert.equal(candidate.title, '先找一步將死');
  assert.match(candidate.body, /AI 候選/);

  const played = onlyMessage(evidence({ played: {
    terminal: terminal('checkmate'), givesCheck: true,
  } }), 'immediate-mate');
  assert.equal(played.title, '實戰的一步將死');

  const both = onlyMessage(evidence({
    played: { terminal: terminal('checkmate'), givesCheck: true },
    candidate: { terminal: terminal('checkmate'), givesCheck: true },
  }), 'immediate-mate');
  assert.equal(both.body, '兩手都會直接將死。');
});

test('candidate-only and played-only check variants', () => {
  assert.equal(onlyMessage(evidence({ candidate: { givesCheck: true } }), 'check-difference').title,
    '先看看將軍手');
  assert.equal(onlyMessage(evidence({ played: { givesCheck: true } }), 'check-difference').title,
    '實戰形成將軍');
});

test('candidate-only, played-only and different-piece capture variants', () => {
  const candidate = onlyMessage(evidence({ candidate: { capture: piece('black', 'R') } }),
    'capture-difference');
  assert.match(candidate.body, /黑車/);
  const played = onlyMessage(evidence({ played: { capture: piece('black', 'P') } }),
    'capture-difference');
  assert.match(played.body, /黑卒/);
  const both = onlyMessage(evidence({
    played: { capture: piece('black', 'P') },
    candidate: { capture: piece('black', 'R') },
  }), 'capture-difference');
  assert.match(both.body, /黑卒/);
  assert.match(both.body, /黑車/);
});

test('candidate and played capture-with-reply variants suppress plain capture and exposure', () => {
  for (const key of ['candidate', 'played']) {
    const input = evidence({ [key]: {
      capture: piece('black', 'P'), replies: [reply(key === 'candidate' ? coordinate(2, 4) : coordinate(3, 3))],
    } });
    const message = onlyMessage(input, 'capture-with-capture-reply');
    assert.equal(message.priority, 650);
    assert.match(message.body, /至少有一個合法回應/);
  }
});

test('candidate-only and played-only moved-piece capturable variants', () => {
  for (const key of ['candidate', 'played']) {
    const input = evidence({ [key]: {
      replies: [reply(key === 'candidate' ? coordinate(2, 4) : coordinate(3, 3))],
    } });
    const message = onlyMessage(input, 'moved-piece-capturable-difference');
    assert.match(message.body, /不代表對方會這樣走/);
  }
});

test('candidate and played threefold repetition variants', () => {
  for (const key of ['candidate', 'played']) {
    const message = onlyMessage(evidence({ [key]: repetition('threefold-repetition') }),
      'immediate-repetition-terminal');
    assert.match(message.body, /三次重複局面並判和/);
  }
});

test('perpetual-check and mutual-perpetual terminal variants', () => {
  const perpetual = onlyMessage(evidence({ candidate: repetition('perpetual-check') }),
    'immediate-repetition-terminal');
  assert.match(perpetual.body, /紅方判負/);
  const mutual = onlyMessage(evidence({ candidate: repetition('mutual-perpetual-check') }),
    'immediate-repetition-terminal');
  assert.match(mutual.body, /雙方長將判和/);
});

test('candidate and played stalemate variants', () => {
  for (const key of ['candidate', 'played']) {
    const message = onlyMessage(evidence({ [key]: { terminal: terminal('stalemate') } }),
      'immediate-stalemate');
    assert.match(message.body, /困斃/);
    assert.match(message.body, /紅方獲勝/);
  }
});

test('same-family terminal facts from both branches remain one bounded message', () => {
  const repeated = onlyMessage(evidence({
    played: repetition('threefold-repetition'),
    candidate: repetition('mutual-perpetual-check'),
  }), 'immediate-repetition-terminal');
  assert.match(repeated.body, /三次重複局面/);
  assert.match(repeated.body, /雙方長將/);
  assert.ok(Array.from(repeated.body).length <= 72);

  const stalemate = onlyMessage(evidence({
    played: { terminal: terminal('stalemate') },
    candidate: { terminal: terminal('stalemate') },
  }), 'immediate-stalemate');
  assert.match(stalemate.body, /你的實戰著/);
  assert.match(stalemate.body, /AI 候選/);
  assert.ok(Array.from(stalemate.body).length <= 72);
});

test('valid evidence with no approved difference emits nothing', () => {
  const input = evidence();
  input.played.movedPieceCaptureReplies = [reply(coordinate(3, 3))];
  input.candidate.movedPieceCaptureReplies = [reply(coordinate(2, 4))];
  assert.deepEqual(deriveGameReviewTeaching(input), []);
});

test('legal reply counts never select, suppress or alter nonterminal teaching', () => {
  assertLegalReplyCountInvariance();
});

test('material deltas never select, suppress or alter nonterminal teaching', () => {
  assertMaterialDeltaInvariance();
});

test('legal reply counts and material deltas remain jointly irrelevant', () => {
  const input = evidence({ candidate: { givesCheck: true } });
  const baseline = deriveGameReviewTeaching(input);
  const combined = withMaterialDeltas(
    withLegalReplyCounts(input, 30, 1),
    { red: { P: -7, R: 3 }, black: { C: -2 } },
    { red: { N: 9 }, black: { P: -8, R: 4 } },
  );
  assert.deepEqual(deriveGameReviewTeaching(combined), baseline);
  assert.deepEqual(deriveGameReviewTeaching(combined)[0], baseline[0],
    'ruleId, priority, title, body, evidenceRefs, source and message count are unchanged');
});

test('unused-field invariance rejects mutants under LF, CRLF and checkout EOLs', async () => {
  const checkStart = 'function checkDifference(evidence) {';
  const legalReplyMutation = '  if (evidence.candidate.legalReplyCount'
    + ' < evidence.played.legalReplyCount) return null;';
  const materialMutation = '  if (Object.keys('
    + 'evidence.candidate.materialDeltaBySide.black).length > 0) return null;';
  const lfSource = sourceWithLineEnding(source, '\n');
  const sourceForms = [
    ['LF', lfSource],
    ['CRLF', sourceWithLineEnding(source, '\r\n')],
    ['actual checkout', source],
  ];

  assert.throws(
    () => injectAfterUniqueLine('', checkStart, legalReplyMutation, 'missing'),
    /mutation target occurs exactly once/,
  );
  assert.throws(
    () => injectAfterUniqueLine(`${lfSource}\n${lfSource}`, checkStart, legalReplyMutation, 'duplicate'),
    /mutation target occurs exactly once/,
  );

  for (const [eolLabel, candidate] of sourceForms) {
    const legalReplyMutant = await importMutatedMapper(
      candidate, checkStart, legalReplyMutation, `${eolLabel} legalReplyCount`,
    );
    assert.throws(
      () => assertLegalReplyCountInvariance(legalReplyMutant.deriveGameReviewTeaching),
      (error) => error?.code === 'ERR_ASSERTION'
        && /must ignore legalReplyCount/.test(error.message),
      `${eolLabel} BROKEN_R3C1_USES_LEGAL_REPLY_COUNT_WOULD_FAIL`,
    );

    const materialMutant = await importMutatedMapper(
      candidate, checkStart, materialMutation, `${eolLabel} materialDeltaBySide`,
    );
    assert.throws(
      () => assertMaterialDeltaInvariance(materialMutant.deriveGameReviewTeaching),
      (error) => error?.code === 'ERR_ASSERTION'
        && /must ignore materialDeltaBySide/.test(error.message),
      `${eolLabel} BROKEN_R3C1_USES_MATERIAL_DELTA_WOULD_FAIL`,
    );
  }
});

test('malformed and unsupported evidence fail closed', () => {
  for (const input of [null, undefined, [], {}, evidence()]) {
    const broken = input === null || input === undefined || Array.isArray(input) || !input.kind
      ? input
      : { ...input, kind: 'unsupported' };
    assert.deepEqual(deriveGameReviewTeaching(broken), []);
  }
  const statusConflict = evidence({ match: true });
  statusConflict.comparison.status = 'DIFFERENT';
  assert.deepEqual(deriveGameReviewTeaching(statusConflict), []);
  const sourceConflict = evidence({ candidate: { givesCheck: true } });
  sourceConflict.source.r3aRevision = 0;
  assert.deepEqual(deriveGameReviewTeaching(sourceConflict), []);
  const pieceConflict = evidence({ candidate: { capture: piece('black', 'R') } });
  pieceConflict.candidate.capture.name = '卒';
  assert.deepEqual(deriveGameReviewTeaching(pieceConflict), []);
  const wrongReplyTarget = evidence({ candidate: { replies: [reply(coordinate(2, 4))] } });
  wrongReplyTarget.candidate.movedPieceCaptureReplies[0].move.to = coordinate(2, 5);
  assert.deepEqual(deriveGameReviewTeaching(wrongReplyTarget), []);
});

test('terminal continuation, missing repetition verdict and terminal-family conflicts fail closed', () => {
  const continuation = evidence({ candidate: { terminal: terminal('checkmate'), givesCheck: true } });
  continuation.candidate.legalReplyCount = 1;
  continuation.candidate.movedPieceCaptureReplies = [];
  assert.deepEqual(deriveGameReviewTeaching(continuation), []);

  const missingVerdict = evidence({ candidate: repetition('threefold-repetition') });
  missingVerdict.candidate.repetitionVerdict = null;
  assert.deepEqual(deriveGameReviewTeaching(missingVerdict), []);

  const conflict = evidence({
    played: { terminal: terminal('stalemate') },
    candidate: { terminal: terminal('checkmate'), givesCheck: true },
  });
  assert.deepEqual(deriveGameReviewTeaching(conflict), []);
});

test('terminal and check priority suppress all lower facts', () => {
  const mate = evidence({ candidate: {
    terminal: terminal('checkmate'), givesCheck: true, capture: piece('black', 'P'),
  } });
  assert.equal(onlyMessage(mate, 'immediate-mate').priority, 900,
    'BROKEN_R3C1_OVERRIDES_MATE_PRIORITY_WOULD_FAIL');

  const repeated = evidence({ candidate: {
    ...repetition('threefold-repetition'), givesCheck: true, capture: piece('black', 'P'),
  } });
  assert.equal(onlyMessage(repeated, 'immediate-repetition-terminal').priority, 850);

  const stalemate = evidence({ candidate: {
    terminal: terminal('stalemate'), capture: piece('black', 'P'),
  } });
  assert.equal(onlyMessage(stalemate, 'immediate-stalemate').priority, 800);

  const check = evidence({ candidate: {
    givesCheck: true, capture: piece('black', 'P'), replies: [reply()],
  } });
  assert.equal(onlyMessage(check, 'check-difference').priority, 700);
});

test('plain capture suppresses standalone exposure', () => {
  const input = evidence({
    played: { replies: [reply(coordinate(3, 3))] },
    candidate: { capture: piece('black', 'R') },
  });
  assert.equal(onlyMessage(input, 'capture-difference').priority, 600);
});

test('derivation is deterministic, immutable, stateless and preserves input', () => {
  const input = evidence({ candidate: { givesCheck: true } });
  const before = clone(input);
  const first = deriveGameReviewTeaching(input);
  const second = deriveGameReviewTeaching(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assertDeepFrozen(first);
  assert.throws(() => { first[0].source.ply = 9; }, TypeError);
});

test('every output is bounded to one short message with exact traceable evidence refs', () => {
  assert.equal(GAME_REVIEW_TEACHING_MAX_MESSAGES, 1);
  const inputs = [
    evidence({ candidate: { terminal: terminal('checkmate'), givesCheck: true } }),
    evidence({ played: repetition('threefold-repetition') }),
    evidence({ candidate: { terminal: terminal('stalemate') } }),
    evidence({ candidate: { givesCheck: true } }),
    evidence({ candidate: { capture: piece('black', 'P'), replies: [reply()] } }),
    evidence({ candidate: { capture: piece('black', 'R') } }),
    evidence({ candidate: { replies: [reply()] } }),
  ];
  for (const input of inputs) {
    const messages = deriveGameReviewTeaching(input);
    assert.ok(messages.length <= 1);
    for (const message of messages) {
      assert.ok(Array.from(message.title).length <= 12);
      assert.ok(Array.from(message.body).length <= 72);
      assert.equal(new Set(message.evidenceRefs).size, message.evidenceRefs.length);
      assert.ok(message.evidenceRefs.every((path) => pathExists(input, path)),
        `${message.ruleId} evidenceRefs all exist`);
      assert.deepEqual(message.source, {
        recordId: input.source.recordId,
        ply: input.source.ply,
        positionKey: input.source.positionKey,
        r3aRevision: input.source.r3aRevision,
      });
      assertAllowedLanguage(`${message.title}${message.body}`);
    }
  }
});

test('same captured identity and equal exposure do not fabricate a reason', () => {
  assert.deepEqual(deriveGameReviewTeaching(evidence({
    played: { capture: piece('black', 'P') },
    candidate: { capture: piece('black', 'P') },
  })), []);
  const noDifference = deriveGameReviewTeaching(evidence());
  assert.deepEqual(noDifference, [], 'BROKEN_R3C1_INVENTS_MESSAGE_WITH_NO_EVIDENCE_WOULD_FAIL');
});

test('source guard excludes raw-position, chess-rule, AI, stateful and external APIs', () => {
  assertPureMapperSource(source);
  for (const [mutation, label] of [
    ['\nlegalMoves(evidence.board, 0, 0);', 'BROKEN_R3C1_TEACHES_FROM_RAW_BOARD_WOULD_FAIL'],
    ['\nfindBestMove(evidence.board);', 'BROKEN_R3C1_CALLS_AI_SEARCH_WOULD_FAIL'],
    ["\nlocalStorage.setItem('teaching', '1');", 'BROKEN_R3C1_STORAGE_WRITE_WOULD_FAIL'],
  ]) {
    let detected = null;
    try {
      assertPureMapperSource(`${source}${mutation}`);
    } catch (error) {
      detected = error;
    }
    assert.equal(detected?.code, 'ERR_ASSERTION', label);
  }
});

test('production mapper has zero dependencies and import mutants are rejected', () => {
  assert.equal(productionDependencies(source).length, 0,
    'R3C1_PRODUCTION_IMPORT_COUNT=0');
  const dependencyMutants = [
    ["import './game-review-ai.js?v=123';\n", 'BROKEN_R3C1_IMPORTS_GAME_REVIEW_AI_QUERY_WOULD_FAIL'],
    ["import './game.js';\n", 'side-effect production import'],
    ["import './game.js#test';\n", 'side-effect import'],
    ["import { findBestMove } from './ai.js?v=abc';\n", 'static import declaration'],
    ["import {\n  findBestMove,\n} from './ai.js?v=multiline';\n", 'multiline static import'],
    ["import/**/rules from './game.js?v=comment-static';\n", 'comment-separated static import'],
    ["import\n/* comment */\nrules from './game.js?v=multiline-comment';\n", 'multiline comment static import'],
    ["export { createGameReviewAiState } from './game-review-ai.js#x';\n", 'export-from dependency'],
    ["export { legalMoves }/**/from './game.js';\n", 'comment-separated named export-from'],
    ["export * /**/ from './game.js';\n", 'comment-separated star export-from'],
    ["const mod = await import('./game-review-ai.js?v=123');\n", 'dynamic import'],
    ["const mod = await import /* comment */ ('./game.js');\n", 'spaced comment dynamic import'],
    ["const mod = await import/**/('./game.js?v=comment-bypass');\n", 'BROKEN_R3C1_COMMENT_SEPARATED_IMPORT_WOULD_FAIL'],
    ["const mod = await import\n/* comment */\n('./game.js');\n", 'multiline comment dynamic import'],
    ["const specifier = './game.js'; const computed = await import(specifier);\n", 'computed dynamic import'],
    ["const rules = require('./game.js');\n", 'CommonJS require'],
    ["const rules = require/**/('./game.js');\n", 'comment-separated CommonJS require'],
    ["function hiddenProductionDependency() { return import/**/(\"./game.js?v=comment-bypass\"); }\n",
      'exact previous comment-separated bypass'],
  ];
  for (const [prefix, label] of dependencyMutants) {
    assert.throws(
      () => assertPureMapperSource(`${prefix}${source}`),
      (error) => error?.code === 'ERR_ASSERTION'
        && /zero production dependencies/.test(error.message),
      label,
    );
  }
  assert.throws(
    () => assertPureMapperSource(
      `import * as reviewAiDomain from './game-review-ai.js?v=raw-board';\n${source}\nvoid reviewAiDomain;`,
    ),
    (error) => error?.code === 'ERR_ASSERTION'
      && /zero production dependencies/.test(error.message),
    'BROKEN_R3C1_TEACHES_FROM_RAW_BOARD_WOULD_FAIL',
  );
});

test('dependency scanner ignores comments and literal text but scans template expressions', () => {
  const harmless = [
    '// import("./fake.js")',
    '/* require("./fake.js") */',
    'const text = "import(\'./fake.js\')";',
    "const other = 'require(\"./fake.js\")';",
    'const word = "important";',
    "const template = `import('./fake.js')`;",
    'const metadata = import.meta;',
    'const objectCall = object.require("./not-commonjs.js");',
  ].join('\n');
  assert.deepEqual(productionDependencies(harmless), [],
    'comments, strings, plain template text, import.meta and member calls are not dependencies');

  const templateExpression = "const value = `${import('./game.js?v=template-expression')}`;";
  assert.deepEqual(productionDependencies(templateExpression), [{
    kind: 'dynamic-import', specifier: './game.js?v=template-expression',
  }], 'executable template expressions remain tokenized');
});

test('forbidden-language guard detects capturable-loss and best-move mutations', () => {
  for (const [text, label] of [
    ['這步白送一車', 'BROKEN_R3C1_CALLS_CAPTURABLE_LOST_WOULD_FAIL'],
    ['這是 AI 最佳著，比較好', 'BROKEN_R3C1_ADDS_BEST_MOVE_WORDING_WOULD_FAIL'],
  ]) {
    let detected = null;
    try {
      assertAllowedLanguage(text);
    } catch (error) {
      detected = error;
    }
    assert.equal(detected?.code, 'ERR_ASSERTION', label);
  }
});
