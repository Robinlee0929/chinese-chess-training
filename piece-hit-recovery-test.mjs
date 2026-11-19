import test from 'node:test';
import assert from 'node:assert/strict';
import { intersectInnerTop } from './piece-hit-recovery.js';

test('tiny negative seam coordinate inside the cap is recovered analytically', () => {
  const hit = intersectInnerTop([-3e-48, 1, 0.025], [0, -1, 0], 0.18000000715255737, 0.4);
  assert.equal(hit.x, -3e-48);
  assert.equal(hit.z, 0.025);
  assert.equal(hit.y, 0.18000000715255737);
  assert.ok(hit.t > 0);
});
test('bounded by half the top radius and an absolute 0.2 world-unit cap', () => {
  assert.ok(intersectInnerTop([0.2, 1, 0], [0, -1, 0], 0.18, 0.4));
  for (const x of [0.2000001, 0.3, 0.4, 0.5, 1]) {
    assert.equal(intersectInnerTop([x, 1, 0], [0, -1, 0], 0.18, 0.4), null);
    assert.equal(intersectInnerTop([x, 1, 0], [0, -1, 0], 0.18, 4), null);
  }
  assert.equal(intersectInnerTop([0.11, 1, 0], [0, -1, 0], 0.18, 0.2), null);
  assert.equal(intersectInnerTop([0.15, 1, 0.15], [0, -1, 0], 0.18, 0.4), null);
});
test('uses the actual ray intersection, not projected centre proximity', () => {
  assert.equal(intersectInnerTop([0, 1, 0], [1, -1, 0], 0.18, 0.4), null);
  const hit = intersectInnerTop([-0.82, 1, 0], [1, -1, 0], 0.18, 0.4);
  assert.ok(Math.abs(hit.x) < 1e-15);
});
test('parallel, grazing, backwards, upward and invalid rays fail closed', () => {
  for (const direction of [[1, 0, 0], [0, 1, 0], [1, -1e-10, 0], [NaN, -1, 0], [0, -Infinity, 0]]) {
    assert.equal(intersectInnerTop([0, 1, 0], direction, 0.18, 0.4), null);
  }
  assert.equal(intersectInnerTop([0, 0, 0], [0, -1, 0], 0.18, 0.4), null);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(intersectInnerTop([value, 1, 0], [0, -1, 0], 0.18, 0.4), null);
    assert.equal(intersectInnerTop([0, 1, 0], [0, -1, 0], value, 0.4), null);
  }
  assert.equal(intersectInnerTop([0, 1, 0], [0, -1, 0], 0.18, 0), null);
});
