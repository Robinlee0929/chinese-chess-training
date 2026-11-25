import { createHash } from 'node:crypto';
import { types } from 'node:util';

export function requireCondition(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

// Data-only boundary: never invoke getters, toJSON, or caller-provided methods.
export function copyData(input) {
  let remaining = 30000;
  const seen = new Set();
  function copy(value, depth) {
    requireCondition(--remaining >= 0 && depth <= 32, 'DATA_LIMIT');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      requireCondition(Number.isFinite(value), 'INVALID_NUMBER');
      return value;
    }
    requireCondition(value && typeof value === 'object' && !seen.has(value), 'INVALID_DATA');
    requireCondition(!types.isProxy(value), 'PROXY_NOT_ALLOWED');
    requireCondition(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null, 'INVALID_DATA');
    seen.add(value);
    const output = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireCondition(typeof key === 'string' && key !== '__proto__'
        && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'INVALID_DATA');
      Object.defineProperty(output, key, { value: copy(descriptor.value, depth + 1),
        enumerable: true, writable: true, configurable: true });
    }
    if (Array.isArray(value)) requireCondition(output.length === value.length
      && Object.keys(output).length === value.length, 'INVALID_ARRAY');
    seen.delete(value);
    return output;
  }
  return copy(input, 0);
}

export function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function fingerprint(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function exact(value, keys) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'INVALID_FIELDS');
}

export function identifier(value) {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,99}$/.test(value),
    'INVALID_ID');
  return value;
}
