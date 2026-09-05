import { purposeFor } from './rule-policy.js';
import { safeFramingSegment } from './framing-policy.js';

export const REQUEST_KEYS = Object.freeze([
  'version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile',
]);
export const PROFILES = Object.freeze(['economy', 'balanced', 'quality']);
export const SAFE_FRAMING = Object.freeze({
  leadIn: '可以一起看看這個地方。',
  encouragement: '下次也可以先停一下想想。',
});

// Copy only descriptors; never read getters, coerce, or freeze caller objects.
export function snapshotExact(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Reflect.ownKeys(descriptors);
    if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return null;
    const copy = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) return null;
      Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
    }
    return copy;
  } catch {
    return null;
  }
}

export function validateRequest(value) {
  const request = snapshotExact(value, REQUEST_KEYS);
  if (!request) return null;
  if (request.version !== 2 || request.locale !== 'zh-Hant' || request.style !== 'child-neutral-teacher-v1') return null;
  if (typeof request.requestId !== 'string' || Array.from(request.requestId).length < 1
    || Array.from(request.requestId).length > 64 || /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(request.requestId)) return null;
  if (purposeFor(request.sourceRuleId) === null) return null;
  if (!PROFILES.includes(request.modelProfile)) return null;
  return Object.freeze(request);
}

export function validateFraming(value) {
  const framing = snapshotExact(value, ['leadIn', 'encouragement']);
  if (!framing) return null;
  if (typeof framing.leadIn !== 'string' || typeof framing.encouragement !== 'string') return null;
  const lengths = [Array.from(framing.leadIn).length, Array.from(framing.encouragement).length];
  if (lengths.some((length) => length < 1 || length > 24) || lengths[0] + lengths[1] > 48) return null;
  if (!safeFramingSegment(framing.leadIn) || !safeFramingSegment(framing.encouragement)) return null;
  return Object.freeze(framing);
}

export function successEnvelope(request, framing) {
  return { version: 2, requestId: request.requestId, sourceRuleId: request.sourceRuleId,
    style: request.style, modelProfile: request.modelProfile, framing };
}

// Deliberately flat JSON grammar: this contract has no arrays/nested values.
// Decoded member names are checked before building the object, including escaped duplicates.
export function parseRequestJSON(text) {
  if (typeof text !== 'string') return null;
  let index = 0;
  const whitespace = () => { while (/[ \t\r\n]/u.test(text[index] ?? '\0')) index++; };
  const string = () => {
    const start = index;
    if (text[index++] !== '"') throw new Error('json');
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') { index++; continue; }
      if (char === '"') return JSON.parse(text.slice(start, index));
    }
    throw new Error('json');
  };
  try {
    whitespace();
    if (text[index++] !== '{') return null;
    whitespace();
    const result = {};
    const seen = new Set();
    if (text[index] !== '}') {
      while (index < text.length) {
        const key = string();
        if (seen.has(key)) return null;
        seen.add(key);
        whitespace();
        if (text[index++] !== ':') return null;
        whitespace();
        let value;
        if (text[index] === '"') value = string();
        else {
          const token = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(text.slice(index));
          if (!token) return null;
          index += token[0].length;
          value = JSON.parse(token[0]);
        }
        Object.defineProperty(result, key, { value, enumerable: true });
        whitespace();
        if (text[index] === '}') break;
        if (text[index++] !== ',') return null;
        whitespace();
      }
    }
    if (text[index++] !== '}') return null;
    whitespace();
    return index === text.length ? result : null;
  } catch {
    return null;
  }
}
