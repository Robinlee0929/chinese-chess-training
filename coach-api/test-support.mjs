// Test-only utilities. Never imported by src/ or the Worker entry point.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

// Compile an isolated ESM graph in memory. No temporary mutation of repository files.
export async function importVariant({ file, before, after, eol = '\n' } = {}) {
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
  const urls = new Map();
  const visiting = new Set();
  const compile = (name) => {
    if (urls.has(name)) return urls.get(name);
    assert.ok(sources.has(name), `production-only import: ${name}`);
    assert.ok(!visiting.has(name), 'acyclic production graph');
    visiting.add(name);
    const source = sources.get(name).replace(/from '(\.\/[^']+)'/gu, (_, specifier) => `from '${compile(specifier.slice(2))}'`);
    assert.doesNotMatch(source, /from ['"](?:node:|\.\.\/)/u);
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    urls.set(name, url);
    visiting.delete(name);
    return url;
  };
  const entry = await import(compile('index.js'));
  const contract = await import(compile('contract.js'));
  return { entry, contract, applied, importable: true };
}
