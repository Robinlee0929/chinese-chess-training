import {
  bootstrapReviewCoachStaging,
} from '../review-coach-staging-bootstrap.js?v=88be8103f4';

export const STAGING_BROWSER_API_ORIGIN =
  'https://chinese-chess-coach-fake-staging.robinlee700929.workers.dev';
export const STAGING_SHELL_PATH = '../index.html';
export const STAGING_MAIN_META = 'review-coach-staging-main';
export const STAGING_BROWSER_CONFIG = Object.freeze({
  enabled: true,
  environment: 'staging',
  apiBaseUrl: STAGING_BROWSER_API_ORIGIN,
});

const MAIN_SCRIPT_PATTERN =
  /<script type="module" src="(\.\/main\.js\?v=[0-9a-f]{10})"><\/script>/gu;
const STAGING_SCRIPT =
  '<script type="module" src="./staging/review-coach-app.js"></script>';
const GENERIC_FAILURE = 'staging 驗證入口目前無法使用。';

export function buildReviewCoachStagingDocument(source) {
  if (typeof source !== 'string') throw new Error('staging_shell_invalid');
  const matches = [...source.matchAll(MAIN_SCRIPT_PATTERN)];
  if (matches.length !== 1 || !source.includes('<head>')) {
    throw new Error('staging_shell_invalid');
  }
  const mainSource = matches[0][1];
  const stagedHead = `<head>\n<base href="../">\n<meta name="${STAGING_MAIN_META}" content="${mainSource}">`;
  return source
    .replace('<head>', stagedHead)
    .replace(matches[0][0], STAGING_SCRIPT);
}

export async function loadReviewCoachStagingShell({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  documentRef = globalThis.document,
} = {}) {
  if (typeof fetchImpl !== 'function' || !documentRef) throw new Error('staging_shell_invalid');
  const response = await fetchImpl(STAGING_SHELL_PATH, Object.freeze({
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  }));
  if (!response || response.status !== 200) throw new Error('staging_shell_unavailable');
  const staged = buildReviewCoachStagingDocument(await response.text());
  documentRef.open();
  documentRef.write(staged);
  documentRef.close();
}

export async function startReviewCoachStagingApp({
  transportDependencies,
  target = globalThis,
  documentRef = globalThis.document,
  loadMain = (url) => import(url),
} = {}) {
  const mainSource = documentRef?.querySelector(
    `meta[name="${STAGING_MAIN_META}"]`,
  )?.getAttribute('content') ?? '';
  if (!/^\.\/main\.js\?v=[0-9a-f]{10}$/u.test(mainSource)) {
    throw new Error('staging_main_invalid');
  }
  const capability = bootstrapReviewCoachStaging(
    STAGING_BROWSER_CONFIG,
    transportDependencies,
    target,
  );
  if (!capability) throw new Error('staging_capability_unavailable');
  await loadMain(new URL(mainSource, documentRef.baseURI).href);
  return capability;
}

export async function runReviewCoachStagingEntrypoint(options = {}) {
  const documentRef = options.documentRef ?? globalThis.document;
  const appStage = !!documentRef?.querySelector(`meta[name="${STAGING_MAIN_META}"]`);
  return appStage
    ? startReviewCoachStagingApp({ ...options, documentRef })
    : loadReviewCoachStagingShell({ ...options, documentRef });
}

export function showReviewCoachStagingFailure(documentRef) {
  if (!documentRef?.body) return;
  documentRef.documentElement?.setAttribute('data-review-coach-staging', 'error');
  let status = documentRef.getElementById('stagingLoadStatus');
  if (!status) {
    status = documentRef.createElement('p');
    status.id = 'stagingLoadStatus';
    status.setAttribute('role', 'status');
    documentRef.body.prepend(status);
  }
  status.textContent = GENERIC_FAILURE;
}

if (typeof document !== 'undefined') {
  runReviewCoachStagingEntrypoint().catch(() => showReviewCoachStagingFailure(document));
}
