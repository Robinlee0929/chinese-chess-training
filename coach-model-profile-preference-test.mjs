import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readCoachModelProfilePreference as read, writeCoachModelProfilePreference as write,
  COACH_MODEL_PROFILE_STORAGE_KEY as KEY } from './coach-model-profile-preference.js';

const WRITE_ALLOWLIST_GATE = 'BROKEN_R3C2_MODEL_PROFILE_WRITE_ALLOWLIST_REMOVED_WOULD_FAIL';

function observeProfileWrite(writePreference, value) {
  const observed = { storageAccessCount: 0, setItemCallCount: 0, writes: [], removals: [] };
  observed.result = writePreference(() => {
    observed.storageAccessCount++;
    return {
      setItem(key, raw) {
        observed.setItemCallCount++;
        observed.writes.push([key, raw]);
      },
      removeItem(key) { observed.removals.push(key); },
    };
  }, value);
  return observed;
}

function assertInvalidProfileWrite(observed) {
  // Check side effects first, outside the helper's intentional storage catch.
  assert.equal(observed.setItemCallCount, 0, WRITE_ALLOWLIST_GATE);
  assert.deepEqual(observed.writes, [], WRITE_ALLOWLIST_GATE);
  assert.deepEqual(observed.removals, [], 'invalid selection never removes preferences');
  assert.equal(observed.storageAccessCount, 0, 'invalid selection rejects before resolving storage');
  assert.equal(observed.result, false);
}

test('only three exact raw strings restore and persist under the exact key', () => {
  assert.equal(KEY, 'chinese-chess-training:coach-model-profile:v1');
  for (const value of ['economy', 'balanced', 'quality']) {
    const calls = [];
    const storage = { getItem(key) { calls.push(['get', key]); return value; },
      setItem(key, raw) { calls.push(['set', key, raw]); } };
    assert.equal(read(() => storage), value);
    assert.equal(write(() => storage, value), true);
    assert.deepEqual(calls, [['get', KEY], ['set', KEY, value]]);
  }
});

test('missing/invalid values fall back without rewrite, deletion, coercion or invalid writes', () => {
  for (const value of [null, undefined, '', 'unknown', 'gpt-anything', 'Economy', 'economy ',
    ' economy', 'BALANCED', '"quality"', '{"modelProfile":"quality"}', [], {}, new String('economy')]) {
    const calls = [];
    const storage = {
      getItem(key) { calls.push(['get', key]); return value; },
      setItem(key, raw) { calls.push(['set', key, raw]); },
      removeItem(key) { calls.push(['remove', key]); },
    };
    assert.equal(read(() => storage), 'economy');
    assert.deepEqual(calls, [['get', KEY]], 'invalid stored values are neither rewritten nor removed');
    assertInvalidProfileWrite(observeProfileWrite(write, value));
  }
});

test('unavailable storage, throwing property getters, reads and quota failure are isolated', () => {
  const denied = () => { throw new Error('SecurityError'); };
  for (const getStorage of [() => undefined, denied, () => ({ getItem: denied, setItem: denied }),
    () => ({ get getItem() { return denied(); }, get setItem() { return denied(); } })]) {
    assert.equal(read(getStorage), 'economy');
    assert.equal(write(getStorage, 'quality'), false);
  }
});

test('valid profiles reach storage and genuine setItem failures are safely caught', () => {
  for (const value of ['economy', 'balanced', 'quality']) {
    for (const failure of [new Error('storage write denied'),
      new DOMException('storage quota exceeded', 'QuotaExceededError')]) {
      let setItemCallCount = 0;
      const writes = [];
      const result = write(() => ({
        setItem(key, raw) {
          setItemCallCount++;
          writes.push([key, raw]);
          throw failure;
        },
      }), value);
      assert.equal(result, false);
      assert.equal(setItemCallCount, 1, 'valid input reaches the operational failure path');
      assert.deepEqual(writes, [[KEY, value]]);
    }
  }
});

test('invalid stored profile mutation fails the real read assertion on LF and CRLF', async () => {
  const original = readFileSync(new URL('./coach-model-profile-preference.js', import.meta.url), 'utf8');
  const target = "    return typeof value === 'string' && GAME_REVIEW_COACH_MODEL_PROFILES.includes(value)";
  assert.equal(original.split(target).length - 1, 1);
  for (const eol of ['\n', '\r\n']) {
    const candidate = original.replace(/\r\n?/g, '\n').replace(/\n/g, eol)
      .replace(target, '    return true')
      .replace(/'\.\/game-review-coach\.js(?:\?v=[a-f0-9]+)?'/,
        JSON.stringify(new URL('./game-review-coach.js', import.meta.url).href));
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(candidate).toString('base64')}`);
    const result = mutant.readCoachModelProfilePreference(() => ({ getItem: () => 'gpt-anything' }));
    assert.equal(result, 'gpt-anything', 'broken read path actually executed');
    assert.throws(() => assert.equal(result, 'economy'), error => error.code === 'ERR_ASSERTION',
      'BROKEN_R3C2_INVALID_STORED_MODEL_PROFILE_WOULD_FAIL');
  }
});

test('removed write allowlist fails the same side-effect assertion on LF and CRLF', async () => {
  const original = readFileSync(new URL('./coach-model-profile-preference.js', import.meta.url), 'utf8');
  const target = "  if (typeof value !== 'string' || !GAME_REVIEW_COACH_MODEL_PROFILES.includes(value)) return false;";
  for (const [label, eol] of [['LF', '\n'], ['CRLF', '\r\n']]) {
    const candidate = original.replace(/\r\n?/g, '\n').replace(/\n/g, eol);
    assert.equal(candidate.split(target).length - 1, 1, `${label}: exactly one write guard target`);
    const mutated = candidate.replace(target, '  // Negative control: write-value allowlist removed.');
    assert.notEqual(mutated, candidate, `${label}: mutation applied`);
    assert.equal(mutated.includes(target), false, `${label}: write guard removed`);
    const dependency = /'\.\/game-review-coach\.js(?:\?v=[a-f0-9]+)?'/g;
    assert.equal([...mutated.matchAll(dependency)].length, 1, `${label}: exactly one dependency rewrite`);
    const importable = mutated.replace(dependency,
      JSON.stringify(new URL('./game-review-coach.js', import.meta.url).href));
    // Import failure is a test failure, never evidence that the mutant was caught.
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(importable).toString('base64')}`);
    assertInvalidProfileWrite(observeProfileWrite(write, 'gpt-anything'));
    const observed = observeProfileWrite(mutant.writeCoachModelProfilePreference, 'gpt-anything');
    assert.equal(observed.result, true, `${label}: broken write path actually returned success`);
    assert.equal(observed.setItemCallCount, 1, `${label}: invalid value actually reached storage`);
    assert.deepEqual(observed.writes, [[KEY, 'gpt-anything']]);
    assert.throws(() => assertInvalidProfileWrite(observed),
      error => error.code === 'ERR_ASSERTION' && error.message.includes(WRITE_ALLOWLIST_GATE)
        && error.actual === 1 && error.expected === 0,
      `${label}: ${WRITE_ALLOWLIST_GATE} must fail at the forbidden setItem count`);
  }
});
