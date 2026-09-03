// Server-owned purposes contain no position, evaluation or chess assertion.
export const RULE_PURPOSES = Object.freeze({
  'immediate-mate': 'Invite the reader to revisit the existing teaching note.',
  'immediate-repetition-terminal': 'Gently introduce a rereading of the existing teaching note.',
  'immediate-stalemate': 'Offer neutral encouragement to reread the existing teaching note.',
  'check-difference': 'Invite a quiet pause before rereading the existing teaching note.',
  'capture-with-capture-reply': 'Introduce the existing teaching note without adding any facts.',
  'capture-difference': 'Encourage attention to the existing teaching note without judging.',
  'moved-piece-capturable-difference': 'Invite reflection on the existing teaching note without evaluating.',
});

export function purposeFor(ruleId) {
  return typeof ruleId === 'string' && Object.hasOwn(RULE_PURPOSES, ruleId)
    ? RULE_PURPOSES[ruleId] : null;
}
