// Test-only utilities. Never imported by src/ or the Worker entry point.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { createCoachHandler } from './src/index.js';
import { localFakeAdmission } from './src/admission.js';
import { fakeProvider } from './src/fake-provider.js';

export const ORIGIN = 'https://robinlee0929.github.io';
export const SENTINEL = 'SYNTHETIC_SECRET_DO_NOT_PUBLISH_9182';
export const payload = (overrides = {}) => ({ version: 2, requestId: 'b1-request', locale: 'zh-Hant',
  sourceRuleId: 'check-difference', style: 'child-neutral-teacher-v1', modelProfile: 'economy', ...overrides });

export function request({ data = payload(), body, path = '/api/review-coach', method = 'POST',
  origin = ORIGIN, headers = {}, signal } = {}) {
  const actualHeaders = new Headers(headers);
  if (origin !== null) actualHeaders.set('Origin', origin);
  if (!actualHeaders.has('Content-Type')) actualHeaders.set('Content-Type', 'application/json');
  const init = { method, headers: actualHeaders, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = body === undefined ? JSON.stringify(data) : body;
    if (init.body instanceof ReadableStream) init.duplex = 'half';
  }
  return new Request(`https://local.invalid${path}`, init);
}

export function harness(options = {}, factory = createCoachHandler) {
  const calls = [];
  const provided = options.provider ?? fakeProvider;
  const handle = factory({ admission: localFakeAdmission(true), ...options,
    provider: (input, providerOptions) => { calls.push({ input, options: providerOptions }); return provided(input, providerOptions); } });
  return { handle, calls };
}

export function assertHeaders(response, origin = ORIGIN) {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('ETag'), null);
  assert.ok(response.headers.get('Vary').split(/,\s*/u).includes('Origin'));
}

export async function assertResponse(response, status, origin = ORIGIN) {
  assert.equal(response.status, status);
  assertHeaders(response, origin);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  assert.ok(bytes.byteLength <= 1024);
  if (status >= 400 && status !== 409) assert.equal(bytes.byteLength, 0);
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

export class FakeClock {
  time = 0;
  next = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.next;
    this.timers.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

export function chunked(bytes, chunkSize = 17, onCancel = () => {}) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset += chunkSize));
    },
    cancel: onCancel,
  });
}

// Record observations, never assert inside code that production catches.
export async function observeSideEffects(operation) {
  const observations = { logs: [], network: [], storage: [] };
  const restorers = [];
  const replace = (object, key, value) => {
    const old = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    restorers.push(() => old ? Object.defineProperty(object, key, old) : delete object[key]);
  };
  for (const key of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']) {
    replace(console, key, (...args) => { observations.logs.push(args); });
  }
  replace(globalThis, 'fetch', (...args) => { observations.network.push(args); return Promise.reject(new Error(SENTINEL)); });
  replace(globalThis, 'WebSocket', class { constructor(...args) { observations.network.push(args); throw new Error(SENTINEL); } });
  replace(globalThis, 'caches', { open: (...args) => { observations.storage.push(args); return Promise.reject(new Error(SENTINEL)); },
    default: { put: (...args) => { observations.storage.push(args); } } });
  replace(globalThis, 'localStorage', { setItem: (...args) => { observations.storage.push(args); } });
  replace(globalThis, 'sessionStorage', { setItem: (...args) => { observations.storage.push(args); } });
  replace(globalThis, 'indexedDB', { open: (...args) => { observations.storage.push(args); } });
  try { return { value: await operation(), observations }; }
  finally { for (const restore of restorers.reverse()) restore(); }
}

export function productionSources() {
  const directory = new URL('./src/', import.meta.url);
  return new Map(readdirSync(directory).filter((file) => file.endsWith('.js'))
    .map((file) => [file, readFileSync(new URL(file, directory), 'utf8')]));
}

export const NODE_AMBIENT_GLOBALS = Object.freeze(['process', 'Buffer']);

export function isNodeBuiltinSpecifier(specifier) {
  return typeof specifier === 'string' && isBuiltin(specifier);
}

function decodeEscape(source, index) {
  const escaped = source[index];
  const simple = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };
  if (Object.hasOwn(simple, escaped)) return { value: simple[escaped], next: index + 1 };
  if (escaped === '\n') return { value: '', next: index + 1 };
  if (escaped === '\r') return { value: '', next: source[index + 1] === '\n' ? index + 2 : index + 1 };
  if (escaped === 'x' && /^[\da-f]{2}$/iu.test(source.slice(index + 1, index + 3))) {
    return { value: String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 3), 16)), next: index + 3 };
  }
  if (escaped === 'u') {
    const braced = source.slice(index + 1).match(/^\{([\da-f]{1,6})\}/iu);
    if (braced) return { value: String.fromCodePoint(Number.parseInt(braced[1], 16)), next: index + 1 + braced[0].length };
    if (/^[\da-f]{4}$/iu.test(source.slice(index + 1, index + 5))) {
      return { value: String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16)), next: index + 5 };
    }
  }
  return { value: escaped, next: index + 1 };
}

function javascriptTokens(source) {
  const tokens = [];
  let index = 0;
  const isIdentifierStart = (character) => /[A-Z_$]/iu.test(character ?? '');
  const isIdentifierPart = (character) => /[\w$]/u.test(character ?? '');
  const regexPrefixes = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '?', '&&', '||', '??', '=>',
    'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await']);
  const canStartRegex = () => tokens.length === 0 || regexPrefixes.has(tokens.at(-1).value);

  const scanQuoted = (quote) => {
    let value = '';
    index++;
    while (index < source.length) {
      if (source[index] === quote) { index++; break; }
      if (source[index] === '\\') {
        const decoded = decodeEscape(source, index + 1);
        value += decoded.value;
        index = decoded.next;
      } else value += source[index++];
    }
    tokens.push({ kind: 'string', value });
  };

  const scanRegex = () => {
    index++;
    let inClass = false;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '[') inClass = true;
      else if (source[index] === ']') inClass = false;
      else if (source[index] === '/' && !inClass) { index++; break; }
      index++;
    }
    while (/[A-Z]/iu.test(source[index] ?? '')) index++;
    tokens.push({ kind: 'regex', value: '/' });
  };

  const scanCode = (templateExpression = false) => {
    let braces = 0;
    while (index < source.length) {
      const character = source[index];
      if (/\s/u.test(character)) { index++; continue; }
      if (character === '/' && source[index + 1] === '/') {
        index += 2; while (index < source.length && !/[\r\n]/u.test(source[index])) index++; continue;
      }
      if (character === '/' && source[index + 1] === '*') {
        index += 2; while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index++;
        index = Math.min(index + 2, source.length); continue;
      }
      if (character === '/' && canStartRegex()) { scanRegex(); continue; }
      if (character === "'" || character === '"') { scanQuoted(character); continue; }
      if (character === '`') {
        index++;
        while (index < source.length) {
          if (source[index] === '\\') { index += 2; continue; }
          if (source[index] === '`') { index++; break; }
          if (source[index] === '$' && source[index + 1] === '{') { index += 2; scanCode(true); continue; }
          index++;
        }
        tokens.push({ kind: 'template', value: '`' });
        continue;
      }
      if (templateExpression && character === '}' && braces === 0) { index++; return; }
      if (isIdentifierStart(character) || (character === '\\' && source[index + 1] === 'u')) {
        let value = '';
        while (isIdentifierPart(source[index]) || (source[index] === '\\' && source[index + 1] === 'u')) {
          if (source[index] === '\\') {
            const decoded = decodeEscape(source, index + 1);
            value += decoded.value;
            index = decoded.next;
          } else value += source[index++];
        }
        tokens.push({ kind: 'identifier', value });
        continue;
      }
      if (/\d/u.test(character)) {
        const start = index++;
        while (/[\w.]/u.test(source[index] ?? '')) index++;
        tokens.push({ kind: 'number', value: source.slice(start, index) });
        continue;
      }
      if (character === '{') braces++;
      if (character === '}') braces--;
      const pair = source.slice(index, index + 2);
      if (['?.', '=>', '&&', '||', '??', '==', '!=', '<=', '>=', '++', '--', '**'].includes(pair)) {
        tokens.push({ kind: 'punctuator', value: pair }); index += 2;
      } else {
        tokens.push({ kind: 'punctuator', value: character }); index++;
      }
    }
  };
  scanCode();
  return tokens;
}

export function productionIsolationIssues(source, policy = {}) {
  const ambientGlobals = new Set(policy.ambientGlobals ?? NODE_AMBIENT_GLOBALS);
  const forbidBareBuiltins = policy.forbidBareBuiltins ?? true;
  const forbidNodePrefixedBuiltins = policy.forbidNodePrefixedBuiltins ?? true;
  const forbidNonliteralDynamicImport = policy.forbidNonliteralDynamicImport ?? true;
  const tokens = javascriptTokens(source);
  const issues = new Set();
  const nonReferenceAmbients = new Set();
  const prefixKeywords = new Set(['await', 'case', 'delete', 'in', 'instanceof', 'new', 'of', 'return', 'throw',
    'typeof', 'void', 'yield']);
  const isCallLike = (token) => token && ((token.kind === 'identifier' && !prefixKeywords.has(token.value))
    || token.kind === 'number' || token.kind === 'string' || token.value === ')' || token.value === ']');
  const globalThisRootBefore = (memberOperatorPosition) => {
    let cursor = memberOperatorPosition - 1;
    if (tokens[cursor]?.value === 'globalThis') return true;
    if (tokens[cursor]?.value !== ')') return false;
    let depth = 1;
    cursor--;
    const end = cursor;
    while (cursor >= 0 && depth > 0) {
      if (tokens[cursor].value === ')') depth++;
      else if (tokens[cursor].value === '(') depth--;
      cursor--;
    }
    const open = cursor + 1;
    return depth === 0 && !isCallLike(tokens[open - 1])
      && tokens.slice(open + 1, end + 1).filter((item) => item.value !== '(' && item.value !== ')').length === 1
      && tokens.slice(open + 1, end + 1).find((item) => item.value !== '(' && item.value !== ')')?.value === 'globalThis';
  };
  const globalThisEnd = (position) => {
    let left = position;
    let right = position;
    while (tokens[left - 1]?.value === '(' && tokens[right + 1]?.value === ')' && !isCallLike(tokens[left - 2])) {
      left--; right++;
    }
    return right;
  };
  const checkSpecifier = (specifier) => {
    if (!isNodeBuiltinSpecifier(specifier)) return;
    if (specifier.startsWith('node:') ? forbidNodePrefixedBuiltins : forbidBareBuiltins) {
      issues.add(`node-builtin:${specifier}`);
    }
  };
  for (let position = 0; position < tokens.length; position++) {
    const token = tokens[position];
    const previous = tokens[position - 1];
    const next = tokens[position + 1];
    if (token.kind === 'identifier' && token.value === 'import' && previous?.value !== '.' && previous?.value !== '?.') {
      if (next?.value === '(') {
        if (tokens[position + 2]?.kind === 'string') checkSpecifier(tokens[position + 2].value);
        else if (forbidNonliteralDynamicImport) issues.add('dynamic-import:nonliteral');
        continue;
      }
      if (next?.kind === 'string') checkSpecifier(next.value);
      for (let cursor = position + 1; cursor < tokens.length && tokens[cursor].value !== ';'; cursor++) {
        if (tokens[cursor].kind === 'identifier') nonReferenceAmbients.add(cursor);
        if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.kind === 'string') {
          checkSpecifier(tokens[cursor + 1].value); break;
        }
      }
    }
    if (token.kind === 'identifier' && token.value === 'export' && previous?.value !== '.' && previous?.value !== '?.') {
      for (let cursor = position + 1; cursor < tokens.length && tokens[cursor].value !== ';'; cursor++) {
        if ((next?.value === '{' || next?.value === '*') && tokens[cursor].kind === 'identifier') nonReferenceAmbients.add(cursor);
        if (tokens[cursor].value === 'from' && tokens[cursor + 1]?.kind === 'string') {
          checkSpecifier(tokens[cursor + 1].value); break;
        }
      }
    }
    if (token.kind === 'identifier' && ambientGlobals.has(token.value) && !nonReferenceAmbients.has(position)) {
      const memberAccess = previous?.value === '.' || previous?.value === '?.';
      const objectKey = next?.value === ':';
      const methodKey = next?.value === '(' && ['{', ',', ';'].includes(previous?.value);
      if (!memberAccess && !objectKey && !methodKey) issues.add(`node-ambient:${token.value}`);
      if (memberAccess && globalThisRootBefore(position - 1)) issues.add(`node-ambient:globalThis.${token.value}`);
    }
    if (token.kind === 'identifier' && token.value === 'globalThis') {
      const end = globalThisEnd(position);
      const bracket = tokens[end + 1]?.value === '[' ? end + 1
        : tokens[end + 1]?.value === '?.' && tokens[end + 2]?.value === '[' ? end + 2 : -1;
      if (bracket !== -1 && tokens[bracket + 1]?.kind === 'string' && tokens[bracket + 2]?.value === ']'
        && ambientGlobals.has(tokens[bracket + 1].value)) {
        issues.add(`node-ambient:globalThis.${tokens[bracket + 1].value}`);
      }
    }
  }
  return [...issues].sort();
}

export function assertProductionIsolation(sources, policy) {
  for (const [name, source] of sources) {
    const issues = productionIsolationIssues(source, policy);
    assert.deepEqual(issues, [], `${name}: prohibited production authority: ${issues.join(', ')}`);
  }
}

// Compile an isolated ESM graph in memory. No temporary mutation of repository files.
export async function importVariant({ file, before, after, eol = '\n', isolationPolicy } = {}) {
  const sources = productionSources();
  for (const [name, source] of sources) sources.set(name, source.replace(/\r\n?/gu, '\n').replace(/\n/gu, eol));
  let applied = 0;
  if (file) {
    const needle = before.replace(/\r\n?/gu, '\n').replace(/\n/gu, eol);
    const replacement = after.replace(/\r\n?/gu, '\n').replace(/\n/gu, eol);
    const source = sources.get(file);
    assert.equal(source.split(needle).length - 1, 1, `exact replacement count: ${file}`);
    sources.set(file, source.replace(needle, replacement));
    applied = 1;
  }
  assertProductionIsolation(sources, isolationPolicy);
  const urls = new Map();
  const visiting = new Set();
  const compile = (name) => {
    if (urls.has(name)) return urls.get(name);
    assert.ok(sources.has(name), `production-only import: ${name}`);
    assert.ok(!visiting.has(name), 'acyclic production graph');
    visiting.add(name);
    const source = sources.get(name).replace(/from '(\.\/[^']+)'/gu, (_, specifier) => `from '${compile(specifier.slice(2))}'`);
    assert.doesNotMatch(source, /from ['"]\.\.\//u);
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    urls.set(name, url);
    visiting.delete(name);
    return url;
  };
  const entry = await import(compile('index.js'));
  const contract = await import(compile('contract.js'));
  return { entry, contract, applied, importable: true };
}
