import assert from 'node:assert/strict';
import test from 'node:test';
import './openai-provider-test.mjs';
import { beginCoachRequest, createIdleCoachState, settleCoachResponse, validateCoachRequestPayload } from '../game-review-coach.js';
import { harness, request } from './test-support.mjs';

// Independent literal rule/profile oracle, not derived from the server policy.
const rules = [['immediate-mate', 900], ['immediate-repetition-terminal', 850],
  ['immediate-stalemate', 800], ['check-difference', 700], ['capture-with-capture-reply', 650],
  ['capture-difference', 600], ['moved-piece-capturable-difference', 500]];
for (const modelProfile of ['economy', 'balanced', 'quality']) {
  for (const [ruleId, priority] of rules) {
    test(`A1 accepts B1: ${modelProfile} / ${ruleId}`, async () => {
      const teachingMessage = { kind: 'review-teaching-message', version: 1, ruleId, priority,
        title: '先看教學提示', body: '可以先看看原有的教學提示。', evidenceRefs: ['source.recordId'],
        source: { recordId: 'b1-parity', ply: 2, positionKey: 'parity', r3aRevision: 1 },
        tone: 'child-neutral-zh-Hant', confidence: 'canonical' };
      const begun = beginCoachRequest({ state: createIdleCoachState(0, modelProfile),
        teachingMessage, requestId: `parity-${ruleId}`, modelProfile });
      assert.equal(begun.accepted, true);
      assert.equal(validateCoachRequestPayload(begun.request), true);
      const server = harness();
      const response = await server.handle(request({ data: begun.request }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['version', 'requestId', 'sourceRuleId', 'style', 'modelProfile', 'framing'].sort());
      const settled = settleCoachResponse({ state: begun.state, currentTeachingMessage: teachingMessage,
        currentModelProfile: modelProfile, response: body });
      assert.equal(settled.accepted, true);
      assert.equal(settled.state.status, 'success');
      assert.equal(server.calls.length, 1);
    });
  }
}
