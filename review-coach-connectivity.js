import {
  GAME_REVIEW_COACH_MODEL_PROFILES,
  validateCoachRequestPayload,
} from './game-review-coach.js?v=88be8103f4';

export const B2A_BROWSER_TIMEOUT_MS = 4000;

const CAPABILITY_SLOT = '__CHINESE_CHESS_REVIEW_COACH_STAGING_CAPABILITY__';
const CAPABILITIES_PATH = '/api/review-coach/capabilities';
const COACH_PATH = '/api/review-coach';
const EXACT_CAPABILITIES_KEYS = Object.freeze(['defaultProfile', 'profiles', 'version']);
const EXACT_PROFILE_KEYS = Object.freeze(['available', 'id']);
const EXACT_REQUEST_KEYS = Object.freeze([
  'version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile',
]);
const capabilityBrands = new WeakSet();

export class ReviewCoachTransportError extends Error {
  constructor(code) {
    super('AI 教練目前無法使用');
    this.name = 'ReviewCoachTransportError';
    this.code = code;
  }
}

function exactDataObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let descriptors;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const names = Object.keys(descriptors).sort();
  if (names.length !== keys.length || names.some((name, index) => name !== keys[index])) return null;
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
  }
  return descriptors;
}

export function validateReviewCoachCapabilities(value) {
  const root = exactDataObject(value, EXACT_CAPABILITIES_KEYS);
  if (!root || root.version.value !== 1 || root.defaultProfile.value !== 'economy'
    || !Array.isArray(root.profiles.value)
    || root.profiles.value.length !== GAME_REVIEW_COACH_MODEL_PROFILES.length) return null;
  const availability = Object.create(null);
  for (const [index, entry] of root.profiles.value.entries()) {
    const profile = exactDataObject(entry, EXACT_PROFILE_KEYS);
    if (!profile || typeof profile.id.value !== 'string'
      || profile.id.value !== GAME_REVIEW_COACH_MODEL_PROFILES[index]
      || typeof profile.available.value !== 'boolean'
      || Object.prototype.hasOwnProperty.call(availability, profile.id.value)) return null;
    availability[profile.id.value] = profile.available.value;
  }
  if (GAME_REVIEW_COACH_MODEL_PROFILES.some((id) => !Object.prototype.hasOwnProperty.call(availability, id))) {
    return null;
  }
  return Object.freeze({
    version: 1,
    profiles: Object.freeze(GAME_REVIEW_COACH_MODEL_PROFILES.map((id) => Object.freeze({
      id,
      available: availability[id],
    }))),
    defaultProfile: 'economy',
  });
}

function exactStagingOrigin(value) {
  if (typeof value !== 'string') return null;
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || parsed.pathname !== '/') return null;
  return parsed.origin;
}

function transportError(code) {
  return new ReviewCoachTransportError(code);
}

async function boundedFetch(fetchImpl, url, options, parentSignal, runtime) {
  const controller = new runtime.AbortController();
  let expired = false;
  let parentAborted = !!parentSignal?.aborted;
  let rejectBoundary;
  const boundary = new Promise((_, reject) => { rejectBoundary = reject; });
  const abortFromParent = () => {
    parentAborted = true;
    controller.abort();
    rejectBoundary(transportError('aborted'));
  };
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = runtime.setTimeout(() => {
    expired = true;
    controller.abort();
    rejectBoundary(transportError('timeout'));
  }, B2A_BROWSER_TIMEOUT_MS);
  try {
    if (parentAborted) throw transportError('aborted');
    const fetchResult = Promise.resolve().then(() => fetchImpl(
      url,
      Object.freeze({ ...options, signal: controller.signal }),
    ));
    fetchResult.catch(() => {});
    const response = await Promise.race([fetchResult, boundary]);
    if (expired) throw transportError('timeout');
    if (parentAborted) throw transportError('aborted');
    return response;
  } catch (error) {
    if (expired) throw transportError('timeout');
    if (parentAborted) throw transportError('aborted');
    if (error instanceof ReviewCoachTransportError) throw error;
    throw transportError('network');
  } finally {
    runtime.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

async function readJson(response, statusCode) {
  if (!response || typeof response !== 'object' || response.status !== statusCode) return null;
  try { return await response.json(); } catch { return null; }
}

function mapPostStatus(status) {
  if (status === 409) return 'profile_unavailable';
  if (status === 429) return 'rate_limited';
  if ([502, 503, 504].includes(status)) return 'backend_unavailable';
  return 'http_failure';
}

export function createReviewCoachStagingCapability(config, dependencies = {}) {
  let descriptors = null;
  try {
    descriptors = config && typeof config === 'object' && !Array.isArray(config)
      ? Object.getOwnPropertyDescriptors(config) : null;
  } catch { return null; }
  const enabled = descriptors?.enabled?.value;
  const environment = descriptors?.environment?.value;
  const origin = exactStagingOrigin(descriptors?.apiBaseUrl?.value);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch?.bind(globalThis);
  const runtime = Object.freeze({
    AbortController: dependencies.AbortController ?? globalThis.AbortController,
    setTimeout: dependencies.setTimeout ?? globalThis.setTimeout?.bind(globalThis),
    clearTimeout: dependencies.clearTimeout ?? globalThis.clearTimeout?.bind(globalThis),
  });
  if (enabled !== true || environment !== 'staging' || !origin || typeof fetchImpl !== 'function'
    || typeof runtime.AbortController !== 'function' || typeof runtime.setTimeout !== 'function'
    || typeof runtime.clearTimeout !== 'function') return null;

  const loadCapabilities = async ({ signal } = {}) => {
    const response = await boundedFetch(fetchImpl, `${origin}${CAPABILITIES_PATH}`, Object.freeze({
      method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
    }), signal, runtime);
    if (response.status !== 200) throw transportError('capabilities_unavailable');
    const parsed = validateReviewCoachCapabilities(await readJson(response, 200));
    if (!parsed) throw transportError('invalid_capabilities');
    return parsed;
  };

  const requestCoach = async (request, { signal } = {}) => {
    if (!validateCoachRequestPayload(request)) throw transportError('invalid_request');
    const requestDescriptors = Object.getOwnPropertyDescriptors(request);
    const body = Object.create(null);
    for (const key of EXACT_REQUEST_KEYS) body[key] = requestDescriptors[key].value;
    const response = await boundedFetch(fetchImpl, `${origin}${COACH_PATH}`, Object.freeze({
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: Object.freeze({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }), signal, runtime);
    if (response.status !== 200) throw transportError(mapPostStatus(response.status));
    const parsed = await readJson(response, 200);
    if (!parsed) throw transportError('invalid_response');
    return parsed;
  };

  const capability = Object.freeze({ environment: 'staging', loadCapabilities, requestCoach });
  capabilityBrands.add(capability);
  return capability;
}

export function installReviewCoachStagingCapability(capability, target = globalThis) {
  if (!capabilityBrands.has(capability) || !target || typeof target !== 'object') return false;
  const existing = Object.getOwnPropertyDescriptor(target, CAPABILITY_SLOT);
  if (existing) return existing.value === capability;
  Object.defineProperty(target, CAPABILITY_SLOT, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: capability,
  });
  return true;
}

export function readInstalledReviewCoachStagingCapability(target = globalThis) {
  const descriptor = target && (typeof target === 'object' || typeof target === 'function')
    ? Object.getOwnPropertyDescriptor(target, CAPABILITY_SLOT) : null;
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && capabilityBrands.has(descriptor.value) ? descriptor.value : null;
}

export function isReviewCoachProfileAvailable(capabilities, modelProfile) {
  const valid = validateReviewCoachCapabilities(capabilities);
  if (!valid || !GAME_REVIEW_COACH_MODEL_PROFILES.includes(modelProfile)) return false;
  return valid.profiles.find((entry) => entry.id === modelProfile).available;
}
