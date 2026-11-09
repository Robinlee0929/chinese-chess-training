import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { initialBoard } from './game.js';
import { createAsyncSavedPositionSession } from './saved-position-async-session.js';
import { repositoryDouble } from './tools/saved-position-session-double.mjs';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, name); return match[0];
};

// Exercise the actual terminal functions AND the manager's actual host callbacks.
// The clock controls due tasks; no wall-clock sleep is used to infer correctness.
function harness() {
  let now = 0, sequence = 0, modal = false, host;
  const timers = new Map(), callbacks = [], displays = [];
  const recordBytes = JSON.stringify({ id: 'completed', sourceRecordId: 'source', moves: ['mate'] });
  const records = new Map([['completed', recordBytes], ['source', 'original source record']]);
  const position = { id: 'saved', title: 'saved', initialBoard: initialBoard(), sideToMove: 'red',
    playPreferences: { humanSide: 'red', difficulty: 'medium' } };
  const { repository } = repositoryDouble([position]);
  const ctx = vm.createContext({
    normalGameRecordSession: Object.freeze({ id: 'completed', sourceRecordId: 'source' }), mode: 'medium', normalGameModeRevision: 1,
    normalGameTerminalPresentation: null, gameOverTimer: null, aiToken: 10,
    over: true, busy: false, appState: 'NORMAL_GAME', editorState: null, confirmedPosition: null,
    APP_STATE: { NORMAL_GAME: 'NORMAL_GAME' }, overlayVisible: false,
    normalGameActive: () => ctx.appState === 'NORMAL_GAME' && !modal,
    authoringActive: () => false, puzzleFlowActive: () => false,
    invalidateNormalAI() { ctx.aiToken++; }, invalidateTeachingModeFeedback() {}, closeHudMenu() {},
    refreshHUD() {}, maybeAIMove() {}, experimentalOpponentAvailable: () => false,
    showGameOver(reason) { ctx.overlayVisible = true; displays.push({ reason, session: ctx.normalGameRecordSession }); },
    startConfiguredNormalGame() {
      ctx.normalGameRecordSession = Object.freeze({ id: 'new' });
      ctx.normalGameTerminalPresentation = null; ctx.over = false; ctx.overlayVisible = false;
    },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); callbacks.push(callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    document: { querySelector: () => modal ? {} : null }, window: {}, navigator: {},
    createCustomPositionRepository: () => repository,
    createSavedPositionUI(options) { host = options.host; },
  });
  for (const name of ['scheduleNormalGameTerminal', 'presentNormalGameTerminal']) vm.runInContext(functionSource(name), ctx);
  const integration = source.match(/^const savedPositionsUI = createSavedPositionUI\(\{[^]*?^\}\);/m);
  assert.ok(integration); vm.runInContext(integration[0], ctx);
  const session = createAsyncSavedPositionSession({ repository, host, onChange: state => { modal = state.active; } });
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.callback(); }
  }
  return { ctx, session, advance, displays, callbacks, timers, records,
    assertRecords() { assert.equal(records.get('completed'), recordBytes); assert.equal(records.get('source'), 'original source record'); } };
}

for (const [reason, delay] of [['將死', 900], ['困斃', 300]]) {
  for (const closeTiming of ['before-due', 'after-due']) {
    test(`P2-01/02/03: cancel manager ${closeTiming}, ${delay}ms terminal delay`, () => {
      const h = harness(); h.ctx.scheduleNormalGameTerminal(reason); h.advance(1);
      assert.equal(h.session.open(), true);
      if (closeTiming === 'after-due') h.advance(delay);
      assert.equal(h.displays.length, 0);
      h.session.close(); h.advance(delay);
      assert.equal(h.ctx.overlayVisible, true); assert.equal(h.displays.length, 1);
      assert.equal(h.displays[0].reason, reason); h.assertRecords();
    });
  }
  test(`P2-04/06/07: shown ${delay}ms result survives repeated manager cancels exactly once`, () => {
    const h = harness(); h.ctx.scheduleNormalGameTerminal(reason); h.advance(delay);
    const recordSession = h.ctx.normalGameRecordSession;
    for (let i = 0; i < 5; i++) { h.session.open(); h.session.close(); h.callbacks.forEach(callback => callback()); }
    assert.equal(h.ctx.overlayVisible, true); assert.equal(h.displays.length, 1);
    assert.equal(h.ctx.normalGameRecordSession, recordSession); h.assertRecords();
  });
  test(`P2-05: manager challenge replaces pending ${delay}ms terminal presentation`, async () => {
    const h = harness(); h.ctx.scheduleNormalGameTerminal(reason);
    const stale = h.callbacks[0]; h.session.open(); await h.session.whenReady(); h.session.select('challenge', 'saved');
    assert.equal(await h.session.submit(), true);
    stale(); h.advance(delay); h.ctx.presentNormalGameTerminal();
    assert.equal(h.ctx.normalGameRecordSession.id, 'new'); assert.equal(h.displays.length, 0);
    assert.equal(h.ctx.overlayVisible, false); h.assertRecords();
  });
}

test('P2-05: a challenge replaces an already displayed result without redisplaying it', async () => {
  const h = harness(); h.ctx.scheduleNormalGameTerminal('將死'); h.advance(900);
  h.session.open(); await h.session.whenReady(); h.session.select('challenge', 'saved'); await h.session.submit();
  h.callbacks[0](); h.ctx.presentNormalGameTerminal();
  assert.equal(h.ctx.overlayVisible, false); assert.equal(h.displays.length, 1); h.assertRecords();
});

test('P2-09: stale callback checks session identity even when an ID is reused', () => {
  const h = harness(); h.ctx.scheduleNormalGameTerminal('將死');
  h.ctx.normalGameRecordSession = Object.freeze({ id: 'completed' }); h.advance(900);
  assert.equal(h.displays.length, 0);
});

test('P2-09: replaced terminal state rejects an old callback from the same session', () => {
  const h = harness(); h.ctx.scheduleNormalGameTerminal('將死'); const stale = h.callbacks[0];
  h.ctx.scheduleNormalGameTerminal('困斃'); stale();
  assert.equal(h.displays.length, 0); h.advance(300);
  assert.equal(h.displays.length, 1); assert.equal(h.displays[0].reason, '困斃');
});

test('P2-09: no terminal presentation after the session is no longer terminal', () => {
  const h = harness(); h.ctx.scheduleNormalGameTerminal('將死'); h.ctx.over = false; h.advance(900);
  h.ctx.presentNormalGameTerminal(); assert.equal(h.displays.length, 0);
});

test('P2 N2: restoring the old AI-token-only callback fails the cancel invariant', () => {
  const h = harness();
  vm.runInContext(`function scheduleNormalGameTerminal(reason) {
    const token = aiToken;
    gameOverTimer = setTimeout(() => {
      if (token === aiToken && normalGameActive() && over) showGameOver(reason);
    }, reason === '將死' ? 900 : 300);
  }`, h.ctx);
  h.ctx.scheduleNormalGameTerminal('將死'); h.session.open(); h.advance(900); h.session.close();
  assert.throws(() => assert.equal(h.ctx.overlayVisible, true, 'cancel must restore the terminal result'), { code: 'ERR_ASSERTION' });
  assert.equal(h.displays.length, 0);
});
