import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { contracts } from './contract-checks.mjs';
import { createCoachSession } from './core.mjs';

// Only in-memory module copies are modified. No product/source files or browser storage are touched.
const mutants = [
  { name: 'omit-legal-defense', check: 'all-defenses', file: 'rules.mjs',
    from: 'return freeze(moves);', to: 'return freeze(moves.slice(1));' },
  { name: 'accept-illegal-candidate', check: 'illegal-candidate', file: 'rules.mjs',
    from: "requireCondition(current.legalMoves.some(candidate => sameMove(candidate, move)), 'ILLEGAL_MOVE');",
    to: "requireCondition(true, 'ILLEGAL_MOVE');" },
  { name: 'mutate-source-board', check: 'source-isolation', file: 'rules.mjs',
    from: 'const source = copyData(input);',
    to: "const source = copyData(input); input.board[4][4].type = 'N';" },
  { name: 'accept-other-session-ticket', check: 'branch-session-identity', file: 'core.mjs',
    from: '!active || ticket !== pending || !pending', to: '!active || !pending' },
  { name: 'accept-out-of-order-result', check: 'stale-result', file: 'core.mjs',
    from: 'pending = ticket;', to: 'pending ||= ticket;' },
  { name: 'promote-unproven-hypothesis', check: 'hypothesis-label', file: 'core.mjs',
    from: 'kind: EVIDENCE_KIND.HYPOTHESIS,\n        text, proved: false,',
    to: 'kind: EVIDENCE_KIND.FACT,\n        text, proved: true,' },
  { name: 'leak-default-answer', check: 'no-answer-leak', file: 'core.mjs',
    from: 'return freeze({ stage, question: QUESTIONS[stage],',
    to: 'return freeze({ answer: branches[0]?.candidate ?? null, stage, question: QUESTIONS[stage],' },
  { name: 'accidental-storage-write', check: 'no-storage', file: 'core.mjs',
    from: 'identifier(sessionId);',
    to: "identifier(sessionId); globalThis.localStorage.setItem('coach', 'unexpected');" },
  { name: 'promote-incomplete-history', check: 'history-evidence', file: 'rules.mjs',
    from: "historyAdjudication: completeness === 'complete' ? 'VERIFIED_FROM_DECLARED_ROOT' : 'NOT_PROVEN',",
    to: "historyAdjudication: 'VERIFIED_FROM_DECLARED_ROOT'," },
  { name: 'accept-incomplete-result-set', check: 'external-reply-completeness', file: 'core.mjs',
    from: "requireCondition(stable(received) === stable(expected), 'REPLIES_MISMATCH');",
    to: "requireCondition(true, 'REPLIES_MISMATCH');" },
  { name: 'allow-reentrant-proxy', check: 'reentrant-input', file: 'identity.mjs',
    from: "requireCondition(!types.isProxy(value), 'PROXY_NOT_ALLOWED');",
    to: "requireCondition(true, 'PROXY_NOT_ALLOWED');" },
];

async function mutantFactory(mutation) {
  const cache = new Map(); let replacements = 0;
  function moduleURL(file) {
    if (cache.has(file)) return cache.get(file);
    const url = new URL(file, import.meta.url);
    let text = readFileSync(url, 'utf8');
    if (file === mutation.file) {
      assert.equal(text.split(mutation.from).length - 1, 1, 'Mutation must hit one exact site');
      text = text.replace(mutation.from, mutation.to); replacements++;
    }
    text = text.replace(/from '([^']+)'/g, (match, specifier) => {
      const target = specifier.startsWith('./') ? moduleURL(specifier.slice(2))
        : specifier.startsWith('../') ? new URL(specifier, url).href : specifier;
      return `from '${target}'`;
    });
    const result = `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
    cache.set(file, result); return result;
  }
  const url = moduleURL('core.mjs');
  assert.equal(replacements, 1);
  // Import errors are outside the assertion catch and cannot count as detected behavioral faults.
  return (await import(url)).createCoachSession;
}

for (const mutation of mutants) test(`negative control: ${mutation.name}`, async () => {
  contracts[mutation.check](createCoachSession);
  const factory = await mutantFactory(mutation);
  assert.throws(() => contracts[mutation.check](factory), error =>
    error instanceof assert.AssertionError || (mutation.name === 'accidental-storage-write'
      && error.message === 'FORBIDDEN_SIDE_EFFECT'), 'Mutant must be detected by its behavioral oracle');
});
