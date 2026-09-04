import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STAGING_BROWSER_API_ORIGIN,
  STAGING_BROWSER_CONFIG,
  STAGING_MAIN_META,
  STAGING_SHELL_PATH,
  buildReviewCoachStagingDocument,
  loadReviewCoachStagingShell,
  startReviewCoachStagingApp,
} from './staging/review-coach-bootstrap.js';
import {
  readInstalledReviewCoachStagingCapability,
  B2A_BROWSER_TIMEOUT_MS,
} from './review-coach-connectivity.js?v=88be8103f4';

const indexSource = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const entryHtml = readFileSync(new URL('./staging/review-coach.html', import.meta.url), 'utf8');
const bootstrapSource = readFileSync(
  new URL('./staging/review-coach-bootstrap.js', import.meta.url),
  'utf8',
);
const appSource = readFileSync(
  new URL('./staging/review-coach-app.js', import.meta.url),
  'utf8',
);
const connectivitySource = readFileSync(new URL('./review-coach-connectivity.js', import.meta.url), 'utf8');
const lifecycleSource = readFileSync(new URL('./game-review-lifecycle-test.mjs', import.meta.url), 'utf8');
const coachSource = readFileSync(new URL('./game-review-coach-test.mjs', import.meta.url), 'utf8');

const EXPECTED_ORIGIN =
  'https://chinese-chess-coach-fake-staging.robinlee700929.workers.dev';
const FORBIDDEN_ENDPOINT_INPUT =
  /location\.(?:search|hash)|URLSearchParams|localStorage|sessionStorage|document\.cookie|apiBaseUrl\s*=|prompt\s*\(/u;

function exactKeys(value, keys) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}

function fakeDocument(mainSource = './main.js?v=88be8103f4') {
  return {
    baseURI: 'https://robinlee0929.github.io/chinese-chess-training/',
    querySelector(selector) {
      return selector === `meta[name="${STAGING_MAIN_META}"]`
        ? { getAttribute: () => mainSource }
        : null;
    },
  };
}

function fakeTransport(calls) {
  return {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        json: async () => ({
          version: 1,
          profiles: [
            { id: 'economy', available: true },
            { id: 'balanced', available: true },
            { id: 'quality', available: true },
          ],
          defaultProfile: 'economy',
        }),
      };
    },
  };
}

function assertEntrypointContract({
  index = indexSource,
  html = entryHtml,
  bootstrap = bootstrapSource,
  app = appSource,
  connectivity = connectivitySource,
  lifecycle = lifecycleSource,
} = {}) {
  assert.doesNotMatch(index, /staging\/review-coach|review-coach-bootstrap/u);
  assert.match(html, /src="\.\/review-coach-bootstrap\.js"/u);
  assert.doesNotMatch(`${html}\n${bootstrap}\n${app}`, FORBIDDEN_ENDPOINT_INPUT);
  assert.match(bootstrap, new RegExp(EXPECTED_ORIGIN.replaceAll('.', '\\.')));
  assert.equal((bootstrap.match(/https:\/\/chinese-chess-coach-fake-staging\.robinlee700929\.workers\.dev/gu) || []).length, 1);
  const installAt = bootstrap.indexOf('bootstrapReviewCoachStaging(');
  const mainAt = bootstrap.indexOf('await loadMain(');
  assert.ok(installAt >= 0 && mainAt > installAt);
  assert.doesNotMatch(bootstrap, /\.requestCoach\s*\(|requestGameReviewCoach\s*\(/u);
  assert.match(app, /startReviewCoachStagingApp\(\)/u);
  assert.doesNotMatch(app, /\.requestCoach\s*\(|requestGameReviewCoach\s*\(/u);
  const keys = connectivity.match(/const EXACT_REQUEST_KEYS = Object\.freeze\(\[([^]*?)\]\);/u)?.[1] ?? '';
  for (const key of ['version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile']) {
    assert.match(keys, new RegExp(`['"]${key}['"]`));
  }
  assert.doesNotMatch(keys, /board|GameRecord|score|PV|prompt|provider|modelId|apiKey/u);
  assert.doesNotMatch(bootstrap, /settleCoachResponse|framing|gameReviewTeaching/u);
  for (const marker of [
    'BROKEN_R3C2_A2_STALE_PLY_RESPONSE_WOULD_FAIL',
    'BROKEN_R3C2_A2_STALE_RECORD_RESPONSE_WOULD_FAIL',
    'BROKEN_R3C2_A2_R2_RESURRECTION_WOULD_FAIL',
    'BROKEN_B2A_R4_RESURRECTION_WOULD_FAIL',
  ]) assert.match(lifecycle, new RegExp(marker));
}

test('normal index does not load or reference the staging entrypoint', () => {
  assertEntrypointContract();
});

test('dedicated staging entrypoint is minimal and does not duplicate the application shell', () => {
  assert.match(entryHtml, /id="stagingLoadStatus"/u);
  assert.doesNotMatch(entryHtml, /id="app"|id="stage"|src="\.\.\/main\.js/u);
});

test('staging public configuration is exact, source-owned and deeply immutable at the root', () => {
  assert.equal(STAGING_BROWSER_API_ORIGIN, EXPECTED_ORIGIN);
  exactKeys(STAGING_BROWSER_CONFIG, ['enabled', 'environment', 'apiBaseUrl']);
  assert.deepEqual(STAGING_BROWSER_CONFIG, {
    enabled: true,
    environment: 'staging',
    apiBaseUrl: EXPECTED_ORIGIN,
  });
  assert.equal(Object.isFrozen(STAGING_BROWSER_CONFIG), true);
});

test('staging shell loader uses only the fixed normal index path and bounded same-origin options', async () => {
  const calls = [];
  const writes = [];
  const documentRef = {
    open: () => writes.push('open'),
    write: (value) => writes.push(value),
    close: () => writes.push('close'),
  };
  await loadReviewCoachStagingShell({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, text: async () => indexSource };
    },
    documentRef,
  });
  assert.equal(STAGING_SHELL_PATH, '../index.html');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    url: '../index.html',
    options: { credentials: 'same-origin', cache: 'no-store', redirect: 'error' },
  });
  assert.equal(writes[0], 'open');
  assert.equal(writes.at(-1), 'close');
});

test('rewritten staging document preserves one shell and replaces normal main with a distinct app stage', () => {
  const staged = buildReviewCoachStagingDocument(indexSource);
  assert.equal((staged.match(/<base href="\.\.\/">/gu) || []).length, 1);
  assert.equal((staged.match(new RegExp(`name="${STAGING_MAIN_META}"`, 'gu')) || []).length, 1);
  assert.equal((staged.match(/src="\.\/staging\/review-coach-app\.js"/gu) || []).length, 1);
  assert.doesNotMatch(staged, /<script type="module" src="\.\/main\.js/u);
  assert.equal((staged.match(/id="app"/gu) || []).length, 1);
});

test('staging capability is branded and installed before main initialization', async () => {
  const target = {};
  const calls = [];
  let installedAtMain = null;
  let mainUrl = null;
  const capability = await startReviewCoachStagingApp({
    transportDependencies: fakeTransport(calls),
    target,
    documentRef: fakeDocument(),
    loadMain: async (url) => {
      mainUrl = url;
      installedAtMain = readInstalledReviewCoachStagingCapability(target);
    },
  });
  assert.equal(installedAtMain, capability);
  assert.equal(readInstalledReviewCoachStagingCapability(target), capability);
  assert.equal(mainUrl, 'https://robinlee0929.github.io/chinese-chess-training/main.js?v=88be8103f4');
  assert.equal(calls.length, 0, 'bootstrap and main initialization do not fetch Worker capabilities');
});

test('branded capability performs exact capabilities GET and completion causes zero POST', async () => {
  const target = {};
  const calls = [];
  const capability = await startReviewCoachStagingApp({
    transportDependencies: fakeTransport(calls),
    target,
    documentRef: fakeDocument(),
    loadMain: async () => {},
  });
  const snapshot = await capability.loadCapabilities();
  assert.deepEqual(snapshot.profiles.map(({ id, available }) => [id, available]), [
    ['economy', true], ['balanced', true], ['quality', true],
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${EXPECTED_ORIGIN}/api/review-coach/capabilities`);
  assert.deepEqual({ ...calls[0].options, signal: undefined }, {
    method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: undefined,
  });
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 0);
});

test('browser timeout remains exactly 4000 ms', () => {
  assert.equal(B2A_BROWSER_TIMEOUT_MS, 4000);
});

test('B2B2 relies on existing explicit-action, A1 and stale lifecycle gates', () => {
  assertEntrypointContract();
  assert.match(lifecycleSource, /capability completion is not user action/u);
  assert.match(lifecycleSource, /profile selection does not POST/u);
  assert.match(lifecycleSource, /BROKEN_R3C2_A2_DUPLICATE_REQUEST_WOULD_FAIL/u);
  assert.match(coachSource, /BROKEN_B2A_BYPASSES_A1_VALIDATOR_WOULD_FAIL/u);
});

for (const [name, mutate] of [
  ['BROKEN_B2B2_NORMAL_PAGE_LOADS_STAGING_WOULD_FAIL', (v) => ({
    ...v, index: `${v.index}\n<script src="./staging/review-coach-bootstrap.js"></script>`,
  })],
  ['BROKEN_B2B2_QUERY_SWITCH_ENABLES_STAGING_WOULD_FAIL', (v) => ({
    ...v, bootstrap: `${v.bootstrap}\nlocation.search;`,
  })],
  ['BROKEN_B2B2_LOCALSTORAGE_ENDPOINT_WOULD_FAIL', (v) => ({
    ...v, bootstrap: `${v.bootstrap}\nlocalStorage.getItem('apiBaseUrl');`,
  })],
  ['BROKEN_B2B2_STAGING_BOOT_AFTER_MAIN_WOULD_FAIL', (v) => ({
    ...v,
    bootstrap: v.bootstrap.replace(
      'const capability = bootstrapReviewCoachStaging(',
      'await loadMain("./main.js");\n  const capability = bootstrapReviewCoachStaging(',
    ),
  })],
  ['BROKEN_B2B2_WRONG_WORKER_URL_WOULD_FAIL', (v) => ({
    ...v, bootstrap: v.bootstrap.replace(EXPECTED_ORIGIN, 'https://wrong.invalid'),
  })],
  ['BROKEN_B2B2_AUTO_POST_WOULD_FAIL', (v) => ({
    ...v, bootstrap: `${v.bootstrap}\ncapability.requestCoach({});`,
  })],
  ['BROKEN_B2B2_POST_EXTRA_FIELD_WOULD_FAIL', (v) => ({
    ...v,
    connectivity: v.connectivity.replace("'style', 'modelProfile',", "'style', 'modelProfile', 'board',"),
  })],
  ['BROKEN_B2B2_A1_BYPASS_WOULD_FAIL', (v) => ({
    ...v, bootstrap: `${v.bootstrap}\nsettleCoachResponse({});`,
  })],
  ['BROKEN_B2B2_STALE_RESPONSE_WOULD_FAIL', (v) => ({
    ...v,
    lifecycle: v.lifecycle.replaceAll('BROKEN_R3C2_A2_STALE_PLY_RESPONSE_WOULD_FAIL', 'REMOVED_STALE_GATE'),
  })],
]) {
  test(`${name} mutation is rejected by the B2B2 entrypoint contract`, () => {
    const original = {
      index: indexSource,
      html: entryHtml,
      bootstrap: bootstrapSource,
      app: appSource,
      connectivity: connectivitySource,
      lifecycle: lifecycleSource,
    };
    assert.throws(() => assertEntrypointContract(mutate(original)), { name: 'AssertionError' });
  });
}
