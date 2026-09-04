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
const coachModuleSource = readFileSync(new URL('./game-review-coach.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');

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

function mutationTransport(calls) {
  return {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        status: 200,
        json: async () => options.method === 'GET'
          ? {
            version: 1,
            profiles: [
              { id: 'economy', available: true },
              { id: 'balanced', available: true },
              { id: 'quality', available: true },
            ],
            defaultProfile: 'economy',
          }
          : { accepted: true },
      };
    },
  };
}

function sourceForms(source) {
  const lf = source.replace(/\r\n?|\n/gu, '\n');
  return [['LF', lf], ['CRLF', lf.replaceAll('\n', '\r\n')]];
}

function replaceUnique(candidate, target, replacement, label) {
  assert.equal(candidate.split(target).length - 1, 1,
    `${label}: mutation target occurs exactly once`);
  return candidate.replace(target, replacement);
}

function injectAfterUniqueLine(candidate, targetLine, injectedLines, label) {
  const eol = candidate.includes('\r\n') ? '\r\n' : '\n';
  const target = `${targetLine}${eol}`;
  const injection = `${targetLine}${eol}${injectedLines.join(eol)}${eol}`;
  return replaceUnique(candidate, target, injection, label);
}

async function importDataModule(source, cacheKey = '') {
  const fragment = cacheKey ? `#${encodeURIComponent(cacheKey)}` : '';
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}${fragment}`);
}

async function importStagingBootstrap(candidate) {
  const dependencyTarget = "} from '../review-coach-staging-bootstrap.js?v=88be8103f4';";
  const dependencyUrl = new URL(
    './review-coach-staging-bootstrap.js?v=88be8103f4', import.meta.url,
  ).href;
  const importable = replaceUnique(candidate, dependencyTarget,
    `} from '${dependencyUrl}';`, 'staging dependency rewrite');
  return importDataModule(importable);
}

async function importConnectivity(candidate) {
  const dependencyTarget = "} from './game-review-coach.js?v=88be8103f4';";
  const dependencyUrl = new URL('./game-review-coach.js?v=88be8103f4', import.meta.url).href;
  const importable = replaceUnique(candidate, dependencyTarget,
    `} from '${dependencyUrl}';`, 'connectivity dependency rewrite');
  return importDataModule(importable);
}

function productionCoachInitialization(candidate) {
  const match = candidate.match(
    /const gameReviewCoachStagingCapability = [^\r\n]+;[^]*?: createDisabledCoachState\(\);/u,
  );
  assert.ok(match, 'actual production coach initialization block exists');
  return match[0];
}

function productionImport(candidate, relativePath) {
  const escaped = relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = candidate.match(new RegExp(
    `^import \\{\\r?\\n(?:[^}\\r\\n]*\\r?\\n)+\\} from '${escaped}\\?v=[0-9a-f]+';`, 'mu'));
  assert.ok(match, `actual production import exists: ${relativePath}`);
  return match[0].replace(/from '([^']+)'/u, (_whole, specifier) =>
    `from '${new URL(specifier, new URL('./main.js', import.meta.url)).href}'`);
}

async function importProductionCoachInitialization(candidate, cacheKey = '') {
  const moduleSource = [
    productionImport(candidate, './game-review-coach.js'),
    productionImport(candidate, './coach-model-profile-preference.js'),
    productionImport(candidate, './review-coach-connectivity.js'),
    productionCoachInitialization(candidate),
    `export {
      gameReviewCoachStagingCapability,
      gameReviewCoachRequester,
      gameReviewCoachCapabilitiesLoader,
      gameReviewCoachState,
    };`,
  ].join('\n');
  return importDataModule(moduleSource, cacheKey);
}

async function withInterceptedFetch(action) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const calls = [];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (url, options) => {
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
  });
  try {
    return { calls, value: await action() };
  } finally {
    if (original) Object.defineProperty(globalThis, 'fetch', original);
    else delete globalThis.fetch;
  }
}

async function withGlobalData(name, value, action) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  try {
    return await action();
  } finally {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  }
}

function captureIntendedAssertion(label, assertion) {
  let failure = null;
  try {
    assertion();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${label}: intended behavior assertion must fail`);
  assert.equal(failure.code, 'ERR_ASSERTION',
    `${label}: only the intended behavior assertion may kill the mutant`);
  assert.equal(failure.name, 'AssertionError');
  return failure.message;
}

function reportMutationReasons(gate, label, reasons) {
  assert.equal(reasons.length, 2, `${label}: LF and CRLF both executed`);
  console.log(`MUTATION_GATE_FAILURE_REASON_${gate}=${JSON.stringify({
    LF: reasons[0],
    CRLF: reasons[1],
  })}`);
  console.log(`${label}=YES MUTATION_APPLIED=YES MUTANT_SYNTAX_VALID=YES MUTANT_IMPORTABLE=YES INTENDED_PATH_EXECUTED=YES BROKEN_BEHAVIOR_OBSERVED=YES INTENDED_ASSERTION_FAILED=YES FAILURE_CLASS=INTENDED_BEHAVIOR_ASSERTION`);
}

function validCoachRequest(requestId = 'b2b2-mutant') {
  return Object.freeze({
    version: 2,
    requestId,
    locale: 'zh-Hant',
    sourceRuleId: 'check-difference',
    style: 'child-neutral-teacher-v1',
    modelProfile: 'economy',
  });
}

function teachingMessage() {
  return {
    kind: 'review-teaching-message',
    version: 1,
    ruleId: 'check-difference',
    priority: 700,
    title: '先看看將軍手',
    body: '可以先檢查看看有沒有將軍手。',
    evidenceRefs: ['source.recordId', 'source.ply', 'candidate.givesCheck'],
    source: {
      recordId: 'b2b2-mutant',
      ply: 8,
      positionKey: 'position|red|b2b2-mutant',
      r3aRevision: 3,
    },
    tone: 'child-neutral-zh-Hant',
    confidence: 'canonical',
  };
}

function coachResponseFor(request, framing = {}) {
  return {
    version: 2,
    requestId: request.requestId,
    sourceRuleId: request.sourceRuleId,
    style: request.style,
    modelProfile: request.modelProfile,
    framing: {
      leadIn: '先停一下，慢慢想一想。',
      encouragement: '你可以照自己的步調思考。',
      ...framing,
    },
  };
}

function mainWithStagingFactory(candidate, mutantLine, label) {
  const eol = candidate.includes('\r\n') ? '\r\n' : '\n';
  const importTarget = [
    'import {',
    '  readInstalledReviewCoachStagingCapability,',
  ].join(eol);
  const importReplacement = [
    'import {',
    '  createReviewCoachStagingCapability,',
    '  readInstalledReviewCoachStagingCapability,',
  ].join(eol);
  const withFactory = replaceUnique(
    candidate, importTarget, importReplacement, `${label}: real staging factory import`,
  );
  return replaceUnique(
    withFactory,
    'const gameReviewCoachStagingCapability = readInstalledReviewCoachStagingCapability();',
    mutantLine,
    `${label}: production initialization`,
  );
}

function assertB2B2SharedPath() {
  assert.match(bootstrapSource, /await loadMain\(/u);
  assert.match(mainSource, /from '\.\/game-review-coach\.js\?v=[0-9a-f]+';/u);
  assert.match(mainSource, /from '\.\/review-coach-connectivity\.js\?v=[0-9a-f]+';/u);
  assert.match(mainSource, /settleCoachResponse\(/u);
  assert.match(mainSource, /invalidateCoachState\(/u);
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

test('BROKEN_B2B2_NORMAL_PAGE_LOADS_STAGING_WOULD_FAIL executes real production initialization',
  async () => {
    assert.match(indexSource, /<script type="module" src="\.\/main\.js\?v=88be8103f4"><\/script>/u);
    const reasons = [];
    for (const [eol, candidate] of sourceForms(mainSource)) {
      const mutant = mainWithStagingFactory(candidate,
        "const gameReviewCoachStagingCapability = readInstalledReviewCoachStagingCapability() ?? createReviewCoachStagingCapability({ enabled: true, environment: 'staging', apiBaseUrl: 'https://mutant.invalid' });",
        `${eol} normal production staging`);
      const execution = await withInterceptedFetch(async () => {
        const imported = await importProductionCoachInitialization(mutant);
        assert.equal(imported.gameReviewCoachStagingCapability.environment, 'staging');
        await imported.gameReviewCoachCapabilitiesLoader();
        return imported;
      });
      const gets = execution.calls.filter(({ options }) => options.method === 'GET').length;
      assert.equal(gets, 1, `${eol}: mutated normal production path reached capabilities GET`);
      reasons.push(captureIntendedAssertion(`${eol} normal production staging`, () =>
        assert.equal(gets, 0, 'normal page must have zero staging capability GETs')));
    }
    reportMutationReasons(1, 'BROKEN_B2B2_NORMAL_PAGE_LOADS_STAGING_WOULD_FAIL', reasons);
  });

test('BROKEN_B2B2_QUERY_SWITCH_ENABLES_STAGING_WOULD_FAIL executes query-controlled production activation',
  async () => {
    const reasons = [];
    for (const [eol, candidate] of sourceForms(mainSource)) {
      const mutant = mainWithStagingFactory(candidate,
        "const gameReviewCoachStagingCapability = new URL(globalThis.location.href).searchParams.get('staging') === '1' ? createReviewCoachStagingCapability({ enabled: true, environment: 'staging', apiBaseUrl: 'https://mutant.invalid' }) : readInstalledReviewCoachStagingCapability();",
        `${eol} query activation`);
      const normal = await withGlobalData('location',
        { href: 'https://example.test/' },
        () => withInterceptedFetch(async () => {
          const imported = await importProductionCoachInitialization(mutant, `${eol}-no-query`);
          assert.equal(imported.gameReviewCoachStagingCapability, null);
          assert.equal(imported.gameReviewCoachCapabilitiesLoader, null);
          return imported;
        }));
      assert.equal(normal.calls.length, 0, `${eol}: mutant remains inert without query input`);
      const execution = await withGlobalData('location',
        { href: 'https://example.test/?staging=1' },
        () => withInterceptedFetch(async () => {
          const imported = await importProductionCoachInitialization(mutant, `${eol}-with-query`);
          assert.equal(imported.gameReviewCoachStagingCapability.environment, 'staging');
          await imported.gameReviewCoachCapabilitiesLoader();
          return imported;
        }));
      const gets = execution.calls.filter(({ options }) => options.method === 'GET').length;
      assert.equal(gets, 1, `${eol}: ?staging=1 reached the real capabilities loader`);
      reasons.push(captureIntendedAssertion(`${eol} query activation`, () =>
        assert.equal(gets, 0, 'query input must not enable staging authority')));
    }
    reportMutationReasons(2, 'BROKEN_B2B2_QUERY_SWITCH_ENABLES_STAGING_WOULD_FAIL', reasons);
  });

test('BROKEN_B2B2_LOCALSTORAGE_ENDPOINT_WOULD_FAIL executes storage-controlled endpoint selection',
  async () => {
    const reasons = [];
    for (const [eol, candidate] of sourceForms(mainSource)) {
      const mutant = mainWithStagingFactory(candidate,
        "const gameReviewCoachStagingCapability = createReviewCoachStagingCapability({ enabled: true, environment: 'staging', apiBaseUrl: globalThis.localStorage.getItem('apiBaseUrl') });",
        `${eol} localStorage endpoint`);
      const execution = await withGlobalData('localStorage',
        { getItem: (key) => key === 'apiBaseUrl' ? 'https://storage-mutant.invalid' : null },
        () => withInterceptedFetch(async () => {
          const imported = await importProductionCoachInitialization(mutant);
          await imported.gameReviewCoachCapabilitiesLoader();
          return imported;
        }));
      assert.equal(execution.calls.length, 1, `${eol}: storage endpoint mutant fetched`);
      assert.equal(execution.calls[0].url,
        'https://storage-mutant.invalid/api/review-coach/capabilities');
      reasons.push(captureIntendedAssertion(`${eol} localStorage endpoint`, () =>
        assert.equal(execution.calls[0].url, `${EXPECTED_ORIGIN}/api/review-coach/capabilities`,
          'endpoint must remain source-owned')));
    }
    reportMutationReasons(3, 'BROKEN_B2B2_LOCALSTORAGE_ENDPOINT_WOULD_FAIL', reasons);
  });

test('BROKEN_B2B2_STAGING_BOOT_AFTER_MAIN_WOULD_FAIL executes main before capability installation',
  async () => {
    const reasons = [];
    for (const [eol, candidate] of sourceForms(bootstrapSource)) {
      const mutantSource = replaceUnique(candidate,
        '  const capability = bootstrapReviewCoachStaging(',
        [
          '  await loadMain(new URL(mainSource, documentRef.baseURI).href);',
          '  const capability = bootstrapReviewCoachStaging(',
        ].join(eol === 'CRLF' ? '\r\n' : '\n'),
        `${eol} main-before-capability`);
      const mutant = await importStagingBootstrap(mutantSource);
      const target = {};
      const observed = [];
      const capability = await mutant.startReviewCoachStagingApp({
        transportDependencies: mutationTransport([]),
        target,
        documentRef: fakeDocument(),
        loadMain: async () => observed.push(readInstalledReviewCoachStagingCapability(target)),
      });
      assert.equal(observed.length, 2, `${eol}: broken ordering executed main twice`);
      assert.equal(observed[0], null, `${eol}: first main initialization lacked capability`);
      assert.equal(observed[1], capability, `${eol}: later main initialization saw capability`);
      reasons.push(captureIntendedAssertion(`${eol} main-before-capability`, () =>
        assert.equal(observed[0], capability, 'capability must exist before main initialization')));
    }
    reportMutationReasons(4, 'BROKEN_B2B2_STAGING_BOOT_AFTER_MAIN_WOULD_FAIL', reasons);
  });

test('BROKEN_B2B2_WRONG_WORKER_URL_WOULD_FAIL executes a GET against the mutated origin', async () => {
  const reasons = [];
  for (const [eol, candidate] of sourceForms(bootstrapSource)) {
    const mutantSource = replaceUnique(candidate, EXPECTED_ORIGIN,
      'https://wrong-worker.invalid', `${eol} wrong Worker origin`);
    const mutant = await importStagingBootstrap(mutantSource);
    const calls = [];
    const capability = await mutant.startReviewCoachStagingApp({
      transportDependencies: mutationTransport(calls),
      target: {},
      documentRef: fakeDocument(),
      loadMain: async () => {},
    });
    await capability.loadCapabilities();
    assert.equal(calls.length, 1, `${eol}: wrong-origin GET executed`);
    assert.equal(calls[0].url, 'https://wrong-worker.invalid/api/review-coach/capabilities');
    reasons.push(captureIntendedAssertion(`${eol} wrong Worker origin`, () =>
      assert.equal(calls[0].url, `${EXPECTED_ORIGIN}/api/review-coach/capabilities`,
        'capability GET must use the exact staging Worker origin')));
  }
  reportMutationReasons(5, 'BROKEN_B2B2_WRONG_WORKER_URL_WOULD_FAIL', reasons);
});

test('BROKEN_B2B2_AUTO_POST_WOULD_FAIL executes an in-scope POST after capability completion',
  async () => {
    const reasons = [];
    for (const [eol, candidate] of sourceForms(bootstrapSource)) {
      const mutantSource = injectAfterUniqueLine(candidate,
        "  if (!capability) throw new Error('staging_capability_unavailable');",
        [
          '  await capability.loadCapabilities();',
          `  await capability.requestCoach(${JSON.stringify(validCoachRequest('auto-post-mutant'))});`,
        ],
        `${eol} automatic POST`);
      const mutant = await importStagingBootstrap(mutantSource);
      const calls = [];
      await mutant.startReviewCoachStagingApp({
        transportDependencies: mutationTransport(calls),
        target: {},
        documentRef: fakeDocument(),
        loadMain: async () => {},
      });
      const gets = calls.filter(({ options }) => options.method === 'GET').length;
      const posts = calls.filter(({ options }) => options.method === 'POST').length;
      assert.deepEqual([gets, posts], [1, 1],
        `${eol}: capability completion triggered one real requestCoach POST`);
      reasons.push(captureIntendedAssertion(`${eol} automatic POST`, () =>
        assert.equal(posts, 0, 'capability completion is not explicit user action')));
    }
    reportMutationReasons(6, 'BROKEN_B2B2_AUTO_POST_WOULD_FAIL', reasons);
  });

test('BROKEN_B2B2_POST_EXTRA_FIELD_WOULD_FAIL executes a seven-field outbound payload', async () => {
  assertB2B2SharedPath();
  const reasons = [];
  for (const [eol, candidate] of sourceForms(connectivitySource)) {
    const mutantSource = injectAfterUniqueLine(candidate,
      '    for (const key of EXACT_REQUEST_KEYS) body[key] = requestDescriptors[key].value;',
      ["    body.board = 'mutant-extra-field';"],
      `${eol} outbound extra field`);
    const mutant = await importConnectivity(mutantSource);
    const calls = [];
    const capability = mutant.createReviewCoachStagingCapability({
      enabled: true,
      environment: 'staging',
      apiBaseUrl: EXPECTED_ORIGIN,
    }, mutationTransport(calls));
    await capability.requestCoach(validCoachRequest(`extra-field-${eol}`));
    const sent = JSON.parse(calls[0].options.body);
    assert.equal(Object.keys(sent).length, 7, `${eol}: mutated transport emitted seven fields`);
    assert.equal(sent.board, 'mutant-extra-field');
    reasons.push(captureIntendedAssertion(`${eol} outbound extra field`, () =>
      assert.deepEqual(Object.keys(sent).sort(),
        ['version', 'requestId', 'locale', 'sourceRuleId', 'style', 'modelProfile'].sort(),
        'outbound payload must contain exactly six approved fields')));
  }
  reportMutationReasons(7, 'BROKEN_B2B2_POST_EXTRA_FIELD_WOULD_FAIL', reasons);
});

test('BROKEN_B2B2_A1_BYPASS_WOULD_FAIL executes unsafe response settlement', async () => {
  assertB2B2SharedPath();
  const reasons = [];
  for (const [eol, candidate] of sourceForms(coachModuleSource)) {
    const mutantSource = replaceUnique(candidate,
      '    const response = snapshotCoachResponse(input.response, state.request);',
      '    const response = input.response;',
      `${eol} A1 response bypass`);
    const mutant = await importDataModule(mutantSource);
    const teaching = teachingMessage();
    const started = mutant.beginCoachRequest({
      state: mutant.createIdleCoachState(),
      teachingMessage: teaching,
      requestId: `a1-bypass-${eol}`,
      modelProfile: 'economy',
    });
    assert.equal(started.accepted, true);
    const settled = mutant.settleCoachResponse({
      state: started.state,
      currentTeachingMessage: teaching,
      currentModelProfile: 'economy',
      response: coachResponseFor(started.request, {
        leadIn: '<b>這步會將軍</b>',
        encouragement: '請前往 https://unsafe.invalid',
      }),
    });
    assert.equal(settled.accepted, true, `${eol}: unsafe response reached success state`);
    assert.equal(settled.state.framing.leadIn, '<b>這步會將軍</b>',
      `${eol}: unsafe framing reached the render-facing state`);
    reasons.push(captureIntendedAssertion(`${eol} A1 response bypass`, () =>
      assert.equal(settled.accepted, false, 'unsafe response must be rejected before rendering')));
  }
  reportMutationReasons(8, 'BROKEN_B2B2_A1_BYPASS_WOULD_FAIL', reasons);
});

test('BROKEN_B2B2_STALE_RESPONSE_WOULD_FAIL executes late-response resurrection', async () => {
  assertB2B2SharedPath();
  const reasons = [];
  for (const [eol, candidate] of sourceForms(coachModuleSource)) {
    const mutantSource = injectAfterUniqueLine(candidate,
      'export function invalidateCoachState(state) {',
      ['  return state;'],
      `${eol} stale invalidation`);
    const mutant = await importDataModule(mutantSource);
    const teaching = teachingMessage();
    const started = mutant.beginCoachRequest({
      state: mutant.createIdleCoachState(),
      teachingMessage: teaching,
      requestId: `stale-${eol}`,
      modelProfile: 'economy',
    });
    const invalidated = mutant.invalidateCoachState(started.state);
    assert.equal(invalidated, started.state, `${eol}: currentness guard was actually removed`);
    const late = mutant.settleCoachResponse({
      state: invalidated,
      currentTeachingMessage: teaching,
      currentModelProfile: 'economy',
      response: coachResponseFor(started.request),
    });
    assert.equal(late.accepted, true, `${eol}: late response resurrected success state`);
    assert.equal(late.state.status, 'success');
    reasons.push(captureIntendedAssertion(`${eol} stale response`, () =>
      assert.equal(late.accepted, false, 'invalidated request must reject a late response')));
  }
  reportMutationReasons(9, 'BROKEN_B2B2_STALE_RESPONSE_WOULD_FAIL', reasons);
});
