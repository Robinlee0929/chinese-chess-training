import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialBoard } from './game.js';
import { createCustomPositionStore, CUSTOM_POSITION_STORAGE_KEY } from './custom-position-store.js';
import { createCustomPositionCoordinator, CUSTOM_POSITION_LOCK } from './custom-position-coordinator.js';
import { createSavedPositionSession } from './saved-position-session.js';
import { createMutableCustomGamePosition } from './custom-position-play.js';

// Shared by independent store/coordinator instances. Callback execution is
// serialized, including a deliberately reentrant second-tab storage read.
class Locks {
  queue = []; held = false; requests = [];
  request(name, options, callback) {
    this.requests.push({ name, mode: options.mode });
    return new Promise((resolve, reject) => {
      const entry = { callback, resolve, reject, signal: options.signal };
      this.queue.push(entry); this.drain();
    });
  }
  drain() {
    if (this.held || !this.queue.length) return;
    const job = this.queue.shift();
    if (job.signal?.aborted) { job.reject(new DOMException('cancelled', 'AbortError')); this.drain(); return; }
    this.held = true;
    let result;
    try { result = job.callback(); } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(job.resolve, job.reject).finally(() => { this.held = false; this.drain(); });
  }
}
function memory() {
  const values = new Map(); let writes = 0;
  return { values, get writes() { return writes; }, getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { assert.equal(key, CUSTOM_POSITION_STORAGE_KEY); writes++; values.set(key, value); } };
}
function position(variant = 0, sideToMove = 'red') {
  const initial = initialBoard(); if (variant) initial[3][(variant - 1) * 2] = null;
  return { title: `局面 ${variant}`, initialBoard: initial, sideToMove,
    playPreferences: { humanSide: 'red', difficulty: 'medium' } };
}
function setup({ locks = new Locks(), storage = memory(), factory = createCustomPositionCoordinator } = {}) {
  let id = 0;
  const store = createCustomPositionStore({ storage, idFactory: () => `saved-${++id}` });
  const coordinator = factory({ store, locks });
  const context = { session: {}, editor: null, confirmed: null, appState: 'NORMAL_GAME', hasProgress: false };
  const host = { context: () => context, canOpen: () => true, pauses: 0, resumes: 0, starts: [], drafts: [],
    pause() { this.pauses++; }, resume() { this.resumes++; },
    start(root, mutable) { this.starts.push({ root, mutable }); context.session = {}; },
    loadEditor(draft) { this.drafts.push(draft); context.editor = draft; context.appState = 'PUZZLE_EDITOR'; } };
  const session = createSavedPositionSession({ coordinator, host });
  return { storage, locks, store, coordinator, host, context, session,
    async save(input = position()) { return coordinator.mutate('savePosition', [input], { expectedRevision: store.loadAll().revision }); } };
}
async function mutant(file, from, to) {
  const url = new URL(file, import.meta.url);
  const original = readFileSync(url, 'utf8'); assert.ok(original.includes(from));
  const source = original.replaceAll(from, to).replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('B T01/T02: saved 90 cells and side survive independent coordinator reload', async () => {
  const h = setup();
  for (const side of ['red', 'black']) {
    const saved = await h.save(position(0, side));
    const fresh = createCustomPositionCoordinator({ storage: h.storage, locks: h.locks });
    const restored = fresh.getPosition(saved.position.id, saved.revision);
    assert.deepEqual(restored.initialBoard, position().initialBoard); assert.equal(restored.sideToMove, side);
    assert.equal(restored.initialBoard.flat().length, 90);
  }
});
for (const side of ['red', 'black']) for (const humanSide of ['red', 'black']) for (const difficulty of ['easy', 'medium', 'hard']) {
  test(`B T03–T07: independent side/settings and saved root ${side}/${humanSide}/${difficulty}`, async () => {
    const h = setup(); const saved = await h.save(position(0, side));
    h.session.open(); h.session.select('challenge', saved.position.id); h.session.edit({ humanSide, difficulty });
    assert.equal(await h.session.submit(), true);
    assert.equal(h.host.starts.length, 1);
    const { root, mutable } = h.host.starts[0];
    assert.deepEqual(root.settings, { humanSide, difficulty }); assert.equal(mutable.sideToMove, side);
    assert.equal(root.savedPositionId, saved.position.id);
    assert.deepEqual(h.store.getPosition(saved.position.id).playPreferences, { humanSide, difficulty });
    mutable.board[0][0] = null; assert.ok(root.initialPosition.board[0][0]);
    assert.ok(Object.isFrozen(root.initialPosition.board[0][0]));
  });
}
test('B T08/T19: once-only settings, source deletion and later preference edits cannot alter the running root', async () => {
  const h = setup(); const saved = await h.save(); const before = h.storage.getItem(CUSTOM_POSITION_STORAGE_KEY);
  h.session.open(); h.session.select('challenge', saved.position.id); h.session.edit({ humanSide: 'black', difficulty: 'hard' });
  assert.equal(await h.session.submit({ once: true }), true); assert.equal(h.storage.getItem(CUSTOM_POSITION_STORAGE_KEY), before);
  const root = h.host.starts[0].root;
  await h.coordinator.mutate('deletePosition', [saved.position.id], { expectedRevision: saved.revision });
  const rematch = createMutableCustomGamePosition(root);
  assert.deepEqual(rematch.board, saved.position.initialBoard); assert.deepEqual(root.settings, { humanSide: 'black', difficulty: 'hard' });
});
test('B T09: editor draft edits and saving never overwrite the stored original', async () => {
  const h = setup(); const saved = await h.save();
  h.session.open(); h.session.select('load', saved.position.id); await h.session.submit();
  const draft = h.host.drafts[0]; draft.board[3][0] = null;
  assert.deepEqual(h.store.getPosition(saved.position.id).initialBoard, position().initialBoard);
  h.session.openSave({ initialBoard: draft.board, sideToMove: draft.sideToMove });
  h.session.edit({ title: '新草稿' }); assert.equal(await h.session.submit(), true);
  assert.equal(h.store.loadAll().positions.length, 2);
});
test('B T10: duplicate save displays existing title and keeps preferences', async () => {
  const h = setup(); const saved = await h.save(); const writes = h.storage.writes;
  h.session.openSave(position()); h.session.edit({ title: '不要覆寫', humanSide: 'black', difficulty: 'hard' });
  await h.session.submit(); assert.equal(h.storage.writes, writes);
  assert.match(h.session.state().notice, /已存在/); assert.match(h.session.state().notice, /局面 0/);
  assert.deepEqual(h.store.getPosition(saved.position.id), saved.position);
});
test('B T11: rename and explicit delete, cancel leaves the record intact', async () => {
  const h = setup(); const saved = await h.save(); h.session.open();
  h.session.select('rename', saved.position.id); h.session.edit({ title: '新名稱' }); await h.session.submit();
  assert.equal(h.store.getPosition(saved.position.id).title, '新名稱');
  h.session.select('delete', saved.position.id); h.session.back(); assert.ok(h.store.getPosition(saved.position.id));
  h.session.select('delete', saved.position.id); await h.session.submit(); assert.equal(h.store.getPosition(saved.position.id), null);
});

async function interleavedTabs(factory) {
  const storage = memory(), locks = new Locks(); let reads = 0, peerPromise, started = false;
  const tabA = createCustomPositionStore({ storage: {
    getItem(key) {
      const captured = storage.getItem(key);
      if (++reads === 2 && !started) { started = true; peerPromise = b.mutate('savePosition', [position(1)], { expectedRevision: 0 }); peerPromise.catch(() => {}); }
      return captured;
    }, setItem: storage.setItem.bind(storage),
  }, idFactory: () => 'tab-a' });
  const a = factory({ store: tabA, locks });
  const b = factory({ store: createCustomPositionStore({ storage, idFactory: () => 'tab-b' }), locks });
  const first = a.mutate('savePosition', [position()], { expectedRevision: 0 });
  const results = await Promise.allSettled([first, peerPromise]);
  const snapshot = a.loadAll();
  assert.equal(snapshot.positions.length, results.filter(r => r.status === 'fulfilled').length,
    'Every reported successful tab write must survive; an unlocked stale snapshot loses the peer write');
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'REVISION_CONFLICT');
  await b.mutate('savePosition', [position(1)], { expectedRevision: snapshot.revision });
  assert.equal(a.loadAll().positions.length, 2);
  assert.ok(locks.requests.every(r => r.name === CUSTOM_POSITION_LOCK && r.mode === 'exclusive'));
}
test('B T12: two tab read/commit interleaving retains every successful write and rejects a stale writer', () => interleavedTabs(createCustomPositionCoordinator));
test('B negative control 1: removing the whole-operation lock loses a successful peer write', async () => {
  const m = await mutant('./custom-position-coordinator.js', 'return await manager.request(', 'return await ((_name, _options, callback) => Promise.resolve(callback()))(');
  await assert.rejects(interleavedTabs(m.createCustomPositionCoordinator), { code: 'ERR_ASSERTION' });
});
test('B T13/T15: storage event refreshes list and invalidates forms without losing typed input', async () => {
  const h = setup(); const saved = await h.save(); h.session.open(); h.session.select('rename', saved.position.id);
  h.session.edit({ title: '保留輸入' }); await h.coordinator.mutate('deletePosition', [saved.position.id], { expectedRevision: saved.revision });
  h.session.storageChanged({ key: CUSTOM_POSITION_STORAGE_KEY });
  assert.equal(h.session.state().snapshot.positions.length, 0); assert.equal(h.session.state().form.title, '保留輸入');
  assert.equal(await h.session.submit(), false); h.session.reload(); assert.equal(h.session.state().form.stale, true);
  assert.equal(h.host.starts.length, 0); assert.equal(h.host.resumes, 0);
});
test('B T14: missing/throwing Web Locks forbids all writes and permits readonly challenge', async () => {
  const h = setup(); const saved = await h.save();
  for (const locks of [null, () => { throw Error('denied'); }]) {
    const c = createCustomPositionCoordinator({ storage: h.storage, locks }); assert.equal(c.loadAll().writable, false);
    for (const [op,args] of [['savePosition',[position()]],['renamePosition',[saved.position.id,'X']],['deletePosition',[saved.position.id]],['updatePlayPreferences',[saved.position.id,{humanSide:'black',difficulty:'easy'}]]]) {
      await assert.rejects(c.mutate(op,args,{expectedRevision:saved.revision}), {code:'LOCKS_UNAVAILABLE'});
    }
    const s = createSavedPositionSession({ coordinator: c, host: h.host }); s.open(); s.select('challenge',saved.position.id);
    s.edit({humanSide:'black'}); assert.equal(await s.submit(),false); assert.equal(s.state().active,true);
    assert.equal(await s.submit({once:true}),true);
  }
  assert.equal(h.storage.writes,1);
});
test('B T16/T17: corruption and read/write failures preserve bytes and form, never report success', async () => {
  for (const raw of ['{bad','',JSON.stringify({version:99,revision:0,positions:[]})]) {
    const h=setup(); h.storage.values.set(CUSTOM_POSITION_STORAGE_KEY,raw); h.session.openSave(position()); h.session.edit({title:'test'});
    assert.equal(await h.session.submit(),false); assert.equal(h.storage.writes,0); assert.equal(h.storage.getItem(CUSTOM_POSITION_STORAGE_KEY),raw);
    assert.ok(h.session.state().form.error);
  }
  const h=setup(); const saved=await h.save(); const original=h.storage.getItem(CUSTOM_POSITION_STORAGE_KEY);
  h.storage.setItem=()=>{throw Error('QuotaExceededError');}; h.session.open(); h.session.select('challenge',saved.position.id); h.session.edit({difficulty:'hard'});
  assert.equal(await h.session.submit(),false); assert.equal(h.host.starts.length,0); assert.equal(h.session.state().form.difficulty,'hard');
  assert.equal(h.storage.getItem(CUSTOM_POSITION_STORAGE_KEY),original); assert.equal(await h.session.submit({once:true}),true);
  for(const storage of [()=>{throw Error('getter');},{getItem(){throw Error('getItem');}}]) {
    const c=createCustomPositionCoordinator({storage,locks:new Locks()}); assert.equal(c.loadAll().writable,false);
    await assert.rejects(c.mutate('savePosition',[position()],{expectedRevision:0}),{code:'STORE_READ_FAILED'});
  }
});
test('B T18/T20: cancel while queued preserves game and prevents storage and late start', async () => {
  const h=setup(); const saved=await h.save(); let release;
  const held=h.locks.request(CUSTOM_POSITION_LOCK,{mode:'exclusive'},()=>new Promise(r=>release=r));
  h.session.open(); h.session.select('challenge',saved.position.id); h.session.edit({difficulty:'hard'});
  const pending=h.session.submit(); h.session.close(); release(); await held; await pending;
  assert.equal(h.host.starts.length,0); assert.equal(h.host.pauses,1); assert.equal(h.host.resumes,1);
  assert.equal(h.storage.writes,1); assert.equal(h.store.getPosition(saved.position.id).playPreferences.difficulty,'medium');
});
test('B: known stale writes and omitted revision are rejected without retry', async () => {
  const h=setup(); const saved=await h.save();
  await assert.rejects(h.coordinator.mutate('renamePosition',[saved.position.id,'stale'],{expectedRevision:0}),{code:'REVISION_CONFLICT'});
  await assert.rejects(h.coordinator.mutate('deletePosition',[saved.position.id]),{code:'INVALID_EXPECTED_REVISION'});
  assert.equal(h.storage.writes,1);
});
test('B negative control 2: rebasing a stale revision silently overwrites a peer name', async () => {
  const m=await mutant('./custom-position-coordinator.js', "const { snapshot } = latest(expectedRevision, id);", "expectedRevision = store.loadAll().revision; const { snapshot } = latest(expectedRevision, id);");
  const h=setup({factory:m.createCustomPositionCoordinator}); const saved=await h.save();
  const invariant=async()=>{await assert.rejects(h.coordinator.mutate('renamePosition',[saved.position.id,'stale'],{expectedRevision:0}),{code:'REVISION_CONFLICT'});};
  await assert.rejects(invariant(),{code:'ERR_ASSERTION'});
  assert.equal(h.store.getPosition(saved.position.id).title,'stale');
});
async function lateCompletionAssertion(factory) {
  const h=setup(); const saved=await h.save(); let release;
  const coordinator={...h.coordinator,async mutate(...args){const result=await h.coordinator.mutate(...args);await new Promise(r=>release=r);return result;}};
  const s=factory({coordinator,host:h.host}); s.open(); s.select('challenge',saved.position.id); s.edit({difficulty:'hard'});
  const pending=s.submit(); while(!release) await new Promise(r=>setImmediate(r));
  s.close(); release(); await pending; assert.equal(h.host.starts.length,0,'a cancelled form must never launch its late result');
}
test('B: cancel after persistence but before callback still prevents switching games',()=>lateCompletionAssertion(createSavedPositionSession));
test('B negative control 3: accepting a cancelled callback starts an unwanted session',async()=>{
  const m=await mutant('./saved-position-session.js','if (!current()) return false;','/* mutation: accept cancelled completion */');
  await assert.rejects(lateCompletionAssertion(m.createSavedPositionSession),{code:'ERR_ASSERTION'});
});
test('B: double submit creates one session and abandoned session identity cannot start another game',async()=>{
  const h=setup();const saved=await h.save();h.session.open();h.session.select('challenge',saved.position.id);h.session.edit({difficulty:'hard'});
  await Promise.all([h.session.submit(),h.session.submit()]);assert.equal(h.host.starts.length,1);
  h.session.open();h.session.select('challenge',saved.position.id);h.context.session={};assert.equal(await h.session.submit(),false);assert.equal(h.host.starts.length,1);
});
test('B: replacing an unfinished game or editor requires explicit acknowledgement',async()=>{
  const h=setup();const saved=await h.save();h.context.hasProgress=true;h.session.open();h.session.select('challenge',saved.position.id);
  assert.equal(await h.session.submit(),false);h.session.edit({acknowledged:true});assert.equal(await h.session.submit(),true);
  h.context.editor={};h.session.open();h.session.select('load',saved.position.id);assert.equal(await h.session.submit(),false);
  h.session.edit({acknowledged:true});assert.equal(await h.session.submit(),true);
});
test('B: denied Web Lock requests switch the coordinator to readonly without a write',async()=>{
  const h=setup({locks:{request(){throw new DOMException('denied','SecurityError');}}});
  await assert.rejects(h.save(),{code:'LOCKS_UNAVAILABLE'});
  assert.equal(h.coordinator.loadAll().writable,false);assert.equal(h.storage.writes,0);
});
test('B: late completion cannot replace a newly opened form or its input',async()=>{
  const h=setup();const saved=await h.save();let release;
  const c={...h.coordinator,async mutate(...args){const r=await h.coordinator.mutate(...args);await new Promise(resolve=>release=resolve);return r;}};
  const s=createSavedPositionSession({coordinator:c,host:h.host});s.open();s.select('rename',saved.position.id);s.edit({title:'first'});
  const pending=s.submit();while(!release)await new Promise(r=>setImmediate(r));s.close();s.open();s.select('rename',saved.position.id);s.edit({title:'second input'});
  release();await pending;assert.equal(s.state().form.title,'second input');assert.equal(s.state().view,'form');assert.equal(h.host.starts.length,0);
});
async function propagationAssertion(factory) {
  const locks=new Locks(), caches=[null,null];let durable=null, release;
  const stores=caches.map((_,i)=>createCustomPositionStore({idFactory:()=>`tab-${i}`,storage:{
    getItem:()=>caches[i],setItem(_key,value){durable=value;caches[i]=value;setTimeout(()=>{caches[1-i]=value;},0);},
  }}));
  const clients=stores.map(store=>factory({store,locks}));
  const held=locks.request(CUSTOM_POSITION_LOCK,{mode:'exclusive'},()=>new Promise(r=>release=r));
  const a=clients[0].mutate('savePosition',[position()],{expectedRevision:0});
  const b=clients[1].mutate('savePosition',[position(1)],{expectedRevision:0});b.catch(()=>{});
  release();await held;const outcomes=await Promise.allSettled([a,b]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1,'peer must observe the committed revision before its lock is granted');
  assert.equal(JSON.parse(durable).positions.length,1);
  assert.equal(outcomes[1].reason.code,'REVISION_CONFLICT');
}
test('B: lock covers post-commit task propagation between independently cached tabs',()=>propagationAssertion(createCustomPositionCoordinator));
test('B negative control 4: early lock release loses data in the delayed cross-tab storage model',async()=>{
  const m=await mutant('./custom-position-coordinator.js','await new Promise(resolve => setTimeout(resolve, 0));','/* mutation: release before storage propagation */');
  await assert.rejects(propagationAssertion(m.createCustomPositionCoordinator),{code:'ERR_ASSERTION'});
});
