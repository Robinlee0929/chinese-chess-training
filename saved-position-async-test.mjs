import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncSavedPositionSession } from './saved-position-async-session.js';
import { repositoryDouble, testPosition } from './tools/saved-position-session-double.mjs';
import { readFileSync } from 'node:fs';
function harness(options = {}) {
  const db = repositoryDouble(), context = { session: {}, mode: 'medium', modeRevision: 1, appState: 'NORMAL_GAME', editor: null, confirmed: null, hasProgress: false };
  const host = { context: () => context, canOpen: () => true, pauses: 0, resumes: 0, starts: [], drafts: [],
    pause() { this.pauses++; }, resume() { this.resumes++; }, start(root, position) { this.starts.push({ root, position }); context.session = {}; }, loadEditor(position) { this.drafts.push(position); } };
  const session = createAsyncSavedPositionSession({ repository: db.repository, host, ...options });
  return { ...db, db, context, host, session, async open() { assert.equal(session.open(),true); await session.whenReady(); } };
}
function latch() { let release, entered; const seen = new Promise(r=>entered=r), wait = new Promise(r=>release=r); return { seen, release, async block() { entered(); await wait; } }; }
test('initial check keeps empty list nonwritable until explicit initialization finishes', async()=>{
  const h=harness();h.controls.mode='UNINITIALIZED';const gate=latch();h.controls.before=type=>type==='initialize'&&gate.block();
  h.session.open();await gate.seen;assert.equal(h.session.state().writable,false);assert.equal(h.session.state().busy,true);gate.release();await h.session.whenReady();
  assert.equal(h.session.state().writable,true);assert.equal(h.session.state().canVerify,false);
});
for (const mode of ['MIGRATION_REQUIRED','STAGED','UNAVAILABLE']) test('mapped state remains fail-closed: '+mode,async()=>{
  const h=harness();h.controls.mode=mode;await h.open();assert.equal(h.session.state().writable,false);assert.equal(h.session.select('challenge','saved'),false);
  assert.equal(h.calls.some(c=>c.type==='confirmMigration'),false);h.session.close();assert.equal(h.host.resumes,1);
});
test('migration requires explicit confirmation and re-reads ACTIVE before enabling list',async()=>{
  const h=harness();h.controls.mode='STAGED';await h.open();assert.equal(await h.session.confirmMigration(false),false);
  assert.equal(await h.session.confirmMigration(true),true);assert.equal(h.session.state().writable,true);assert.equal(h.calls.at(-1).type,'loadAll');
});
for(const side of ['red','black'])for(const humanSide of ['red','black'])for(const difficulty of ['easy','medium','hard'])test(`last snapshot challenge ${side}/${humanSide}/${difficulty}`,async()=>{
  const h=harness();h.db.snapshot.envelope.positions[0].sideToMove=side;await h.open();h.session.select('challenge','saved');h.session.edit({humanSide,difficulty});
  assert.equal(await h.session.submit(),true);assert.equal(h.host.starts.length,1);assert.equal(h.host.resumes,0);
  const {root,position}=h.host.starts[0];assert.equal(position.sideToMove,side);assert.deepEqual(root.settings,{humanSide,difficulty});
  position.board[0][0]=null;assert.ok(root.initialPosition.board[0][0]);assert.equal(h.calls.at(-1).type,'getPosition');
});
test('save rename preferences delete and independent editor load',async()=>{
  const h=harness();await h.open();h.session.select('load','saved');assert.equal(await h.session.submit(),true);assert.equal(h.host.drafts.length,1);
  await h.open();h.session.select('rename','saved');h.session.edit({title:'新名稱'});assert.equal(await h.session.submit(),true);
  h.session.select('preferences','saved');h.session.edit({difficulty:'hard'});assert.equal(await h.session.submit(),true);assert.equal(h.host.starts.length,0);
  h.session.select('delete','saved');assert.equal(await h.session.submit(),true);assert.equal(h.db.snapshot.envelope.positions.length,0);
  h.session.close();h.session.openSave(testPosition());await h.session.whenReady();h.session.edit({title:'儲存新局面'});assert.equal(await h.session.submit(),true);
  assert.equal(h.db.snapshot.envelope.positions.length,1);
});
test('once-only settings do not persist and no-op uses advanced receipt revision',async()=>{
  const h=harness();await h.open();h.session.select('challenge','saved');h.session.edit({difficulty:'hard'});assert.equal(await h.session.submit({once:true}),true);assert.equal(h.db.snapshot.envelope.revision,1);
  await h.open();h.session.select('rename','saved');h.session.edit({title:'saved'});await h.session.submit();assert.equal(h.session.state().snapshot.envelope.revision,2);
});
test('conflict preserves input and explicit reload is required to adopt a revision',async()=>{
  const h=harness();await h.open();h.session.select('rename','saved');h.session.edit({title:'保留輸入'});h.db.snapshot.envelope.revision++;
  assert.equal(await h.session.submit(),false);assert.equal(h.session.state().form.title,'保留輸入');assert.equal(h.session.state().form.fence.expectedRevision,1);
  assert.equal(await h.session.submit(),false);await h.session.reload();assert.equal(h.session.state().form.fence.expectedRevision,2);assert.equal(await h.session.submit(),true);
});
test('busy is synchronous and double submit cannot create two games',async()=>{
  const h=harness();await h.open();h.session.select('challenge','saved');const p=h.session.submit();assert.equal(h.session.state().busy,true);
  assert.equal(await h.session.submit(),false);await p;assert.equal(h.host.starts.length,1);
});
for(const boundary of ['getPosition','updatePlayPreferences','savePosition','confirmMigration','verify'])test('cancel during '+boundary+' cannot act on old or replacement dialog',async()=>{
  const h=harness();if(boundary==='confirmMigration')h.controls.mode='STAGED';await h.open();const gate=latch();
  if(boundary==='savePosition'){h.session.close();h.session.openSave(testPosition());await h.session.whenReady();h.session.edit({title:'新局面'});}
  else if(!['confirmMigration','verify'].includes(boundary)){h.session.select('challenge','saved');h.session.edit({difficulty:'hard'});}
  if(boundary==='verify'){
    h.session.select('rename','saved');h.controls.result={status:'UNKNOWN',persistence:{status:'UNKNOWN'}};await h.session.submit();h.controls.result=null;
  }
  h.controls.before=type=>type===boundary&&gate.block();
  const p=boundary==='confirmMigration'?h.session.confirmMigration(true):boundary==='verify'?h.session.verifyPending():h.session.submit();
  await gate.seen;h.session.close();gate.release();await p;
  assert.equal(h.host.starts.length,0);assert.ok(h.host.resumes>=1);assert.equal(h.session.state().active,false);
});
test('late committed preference result does not retain consent to start',async()=>{
  const h=harness();await h.open();h.session.select('challenge','saved');h.session.edit({difficulty:'hard'});const gate=latch();h.controls.after=type=>type==='updatePlayPreferences'&&gate.block();
  const p=h.session.submit();await gate.seen;h.session.close();gate.release();await p;assert.equal(h.db.snapshot.envelope.positions[0].playPreferences.difficulty,'hard');assert.equal(h.host.starts.length,0);
  h.controls.after=null;await h.open();assert.equal(h.session.state().canVerify,true);await h.session.verifyPending();assert.match(h.session.state().notice,/已提交/);
});
test('origin game replacement rejects late callback',async()=>{
  const h=harness();await h.open();h.session.select('challenge','saved');const gate=latch();h.controls.after=type=>type==='getPosition'&&gate.block();
  const p=h.session.submit();await gate.seen;h.context.session={};gate.release();await p;assert.equal(h.host.starts.length,0);h.session.close();assert.equal(h.host.resumes,0);
});

for (const change of ['mode','modeRevision']) test(`late challenge rejects changed origin ${change} even if session object is retained`,async()=>{
  const h=harness();await h.open();h.session.select('challenge','saved');const gate=latch();
  h.controls.after=type=>type==='getPosition'&&gate.block();
  const before=JSON.stringify(h.db.snapshot),pending=h.session.submit({once:true});await gate.seen;
  h.context[change]=change==='mode'?'hard':2;gate.release();assert.equal(await pending,false);
  assert.equal(h.host.starts.length,0);assert.equal(JSON.stringify(h.db.snapshot),before);
});

test('committed preferences remain verifiable after origin mode revision changes, without retry',async()=>{
  const h=harness();await h.open();h.session.select('challenge','saved');h.session.edit({difficulty:'hard'});
  const gate=latch();h.controls.after=type=>type==='updatePlayPreferences'&&gate.block();
  const pending=h.session.submit();await gate.seen;h.context.modeRevision++;
  gate.release();assert.equal(await pending,false);assert.equal(h.host.starts.length,0);
  assert.equal(h.db.snapshot.envelope.positions[0].playPreferences.difficulty,'hard');
  h.session.close();h.controls.after=null;await h.open();assert.equal(h.session.state().canVerify,true);
  const writes=h.calls.filter(x=>x.type==='updatePlayPreferences').length;
  await h.session.verifyPending();assert.match(h.session.state().notice,/已提交/);
  assert.equal(h.calls.filter(x=>x.type==='updatePlayPreferences').length,writes);assert.equal(h.host.starts.length,0);
});
test('UNKNOWN verification never replays or starts a game',async()=>{
  const h=harness();await h.open();h.session.select('rename','saved');h.controls.result={status:'UNKNOWN',persistence:{status:'UNKNOWN'}};await h.session.submit();h.controls.result=null;
  const before=h.calls.length;await h.session.verifyPending();assert.equal(h.calls.length,before);assert.equal(h.session.state().canVerify,true);assert.equal(h.host.starts.length,0);
});

test('verification failure preserves the recovery handle instead of treating it as a terminal outcome',async()=>{
  const h=harness();await h.open();h.session.select('rename','saved');h.controls.result={status:'UNKNOWN',persistence:{status:'UNKNOWN'}};await h.session.submit();h.controls.result=null;
  h.controls.verify={status:'FAILED',code:'UNAVAILABLE'};await h.session.verifyPending();assert.equal(h.session.state().canVerify,true);assert.match(h.session.state().notice,/尚未確認完成/);
  h.controls.verify={status:'COMMITTED',nativeEvent:'UNKNOWN'};await h.session.verifyPending();assert.equal(h.session.state().canVerify,false);assert.equal(h.host.starts.length,0);
});
test('UI yields before expensive prepare, and cancellation in that gap never sends',async()=>{
  let defer=false;const gate=latch(),h=harness({yieldUI:()=>defer?gate.block():Promise.resolve()});await h.open();h.session.select('rename','saved');defer=true;
  const p=h.session.submit();await gate.seen;h.session.close();gate.release();await p;assert.equal(h.calls.some(c=>c.type==='renamePosition'),false);
});
test('formal entry graph has exactly one storage facade, legacy writer unreachable',()=>{
  const seen=new Set(),walk=file=>{if(seen.has(file))return;seen.add(file);const text=readFileSync(new URL(file,import.meta.url),'utf8');for(const m of text.matchAll(/from ['"]\.\/([\w-]+\.js)(?:\?[^'"]*)?['"]/g))walk(m[1]);};walk('main.js');
  assert.equal(seen.has('custom-position-repository.js'),true);assert.equal(seen.has('custom-position-coordinator.js'),false);assert.equal(seen.has('saved-position-session.js'),false);
});
