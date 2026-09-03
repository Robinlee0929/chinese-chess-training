import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { readCoachModelProfilePreference as read, writeCoachModelProfilePreference as write,
  COACH_MODEL_PROFILE_STORAGE_KEY as KEY } from './coach-model-profile-preference.js';

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
    let reads = 0;
    const storage = { getItem(key) { assert.equal(key, KEY); reads++; return value; },
      setItem() { assert.fail('no invalid writes'); }, removeItem() { assert.fail('no removal'); } };
    assert.equal(read(() => storage), 'economy');
    assert.equal(reads, 1);
    assert.equal(write(() => storage, value), false);
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
