import assert from 'node:assert/strict';
import { launch, deadline } from './idb-browser-harness.mjs';
import { capacityFixture } from './idb-capacity-fixture.mjs';
import { createHash } from 'node:crypto';
const h=await launch('repository-browser',{persistentContexts:true,fixture:'custom-position-repository-fixture.js'}),summary=[];
const ev=(t,s)=>h.evaluate(t,s,true);
async function test(id,fn){try{const evidence=await fn();await h.save(id,evidence);summary.push({id,status:'PASS'});console.log(id+' PASS');}catch(e){await h.save(id+'-FAIL',{message:e.message,stack:e.stack});summary.push({id,status:'FAIL'});throw e;}}
const a=await h.tab(),b=await h.tab();
const read=async t=>{const r=await ev(t,'poc.read()');assert.equal(r.ok,true);return r.snapshot;};
const start=(t,type,args,s)=>ev(t,`poc.start(${JSON.stringify(type)},${JSON.stringify(args)},${JSON.stringify({snapshot:s,storageInstanceId:s.metadata.storageInstanceId,expectedRevision:s.envelope.revision})})`);
const outcome=(t,o)=>ev(t,`poc.wait(${JSON.stringify(o.requestId)})`);
async function fresh(){await ev(a,'poc.reset()');await ev(b,'poc.newScope()');assert.equal((await ev(a,'poc.initialize()')).status,'ACTIVE');return read(a);}
try{
 await test('ordinary-read-does-not-initialize',async()=>{await ev(a,'poc.reset()');const r=await ev(a,'poc.list()');assert.equal(r.status,'MIGRATION_REQUIRED');assert.equal(await read(b),null);return r;});
 await test('CRUD-noop-and-isolation',async()=>{let s=await fresh();const input=await ev(a,'poc.position()');const o=await start(a,'savePosition',[input],s),r=await outcome(a,o);assert.equal(r.status,'SUCCESS');assert.equal(r.persistence.status,'COMMITTED');assert.equal(r.nativeEvent,'COMPLETE');assert.equal(r.position.initialBoard.flat().length,90);s=await read(b);assert.equal(s.envelope.revision,1);assert.equal(s.metadata.commits[0].operation.operationId,o.operationId);const rename=await outcome(a,await start(a,'renamePosition',[r.position.id,r.position.title],s));assert.equal(rename.revision,2);assert.deepEqual(rename.receipt.delta.before,rename.receipt.delta.after);s=await read(b);const pref=await outcome(a,await start(a,'updatePlayPreferences',[r.position.id,{humanSide:'red',difficulty:'hard'}],s));assert.equal(pref.revision,3);s=await read(b);const removed=await outcome(a,await start(a,'deletePosition',[r.position.id],s));assert.equal(removed.revision,4);assert.equal((await read(b)).envelope.positions.length,0);return{o,r,rename,pref,removed,final:await read(b)};});
 await test('cross-tab-race-original-revision',async()=>{const s=await fresh(),p=await ev(a,'poc.position()'),p2={...p,sideToMove:'black'};const ops=await Promise.all([start(a,'savePosition',[p],s),start(b,'savePosition',[p2],s)]),rs=await Promise.all(ops.map((o,i)=>outcome(i?b:a,o)));assert.deepEqual(rs.map(r=>r.status).sort(),['REVISION_CONFLICT','SUCCESS']);const final=await read(b);assert.equal(final.envelope.revision,1);assert.equal(final.metadata.commits.length,1);assert.deepEqual(final,await read(a));const loser=rs.findIndex(r=>r.status==='REVISION_CONFLICT'),retry=await outcome(loser?b:a,await start(loser?b:a,'savePosition',[loser?p2:p],final));assert.equal(retry.status,'SUCCESS');assert.equal((await read(b)).envelope.revision,2);return{ops,rs,retry,final:await read(b)};});
 for(const fault of ['precommit','after-commit','quota','abort-after-success'])await test('native-'+fault,async()=>{const s=await fresh(),p=await ev(a,'poc.position()');await ev(a,`poc.fault(${JSON.stringify(fault)})`);const o=await start(a,'savePosition',[p],s),r=await outcome(a,o),final=await read(b);if(fault==='after-commit'){assert.equal(r.status,'CANCELLED_UI_INTENT');assert.equal(r.persistence.status,'COMMITTED');assert.equal(r.nativeEvent,'COMPLETE');assert.equal(final.envelope.revision,1);}else{assert.notEqual(r.status,'SUCCESS');assert.equal(r.persistence.nativeEvent,'ABORT');assert.deepEqual(final,s);}assert.equal(await ev(a,`poc.apply(${JSON.stringify(o.requestId)})`),false);const events=(await ev(a,'poc.inspect()')).nativeEvents.filter(x=>x.operationId===o.operationId&&x.n===2);assert.equal(events.length,1);assert.equal(events[0].trusted,true);return{o,r,final,events};});
 await test('unknown-after-lost-complete-and-independent-witness',async()=>{const s=await fresh();await ev(a,"poc.fault('suppress-complete')");const o=await start(a,'savePosition',[await ev(a,'poc.position()')],s);const native=await h.until(e=>e.sessionId===a.sessionId&&e.trace?.type==='native-terminal'&&e.trace.operationId===o.operationId&&e.trace.n===2&&e.trace.terminal==='COMPLETE',5000);assert.ok(native.trace?.trusted);await ev(a,'poc.close()');const r=await outcome(a,o);assert.equal(r.persistence.status,'UNKNOWN');assert.equal(r.nativeEvent,'UNKNOWN');const observation=await ev(b,`poc.verify(${JSON.stringify(r.token)})`);assert.equal(observation.status,'COMMITTED');assert.equal(observation.nativeEvent,'UNKNOWN');assert.equal((await read(b)).envelope.revision,1);return{o,r,native,observation,final:await read(b)};});
 await test('old-scope-late-completion-cannot-apply',async()=>{const s=await fresh(),o=await start(a,'savePosition',[await ev(a,'poc.position()')],s);await ev(a,'poc.stale();poc.newScope()');const r=await outcome(a,o);assert.equal(await ev(a,`poc.apply(${JSON.stringify(o.requestId)})`),false);return{o,r,final:await read(b)};});
 await test('instance-replacement-rejects-old-snapshot',async()=>{const old=await fresh();assert.equal((await ev(a,'(async()=>{await poc.reset();return poc.initialize();})()')).status,'ACTIVE');await ev(b,'poc.newScope()');const o=await start(b,'savePosition',[await ev(b,'poc.position()')],old),r=await outcome(b,o);assert.equal(r.status,'UNKNOWN');assert.equal(r.code,'STORAGE_INSTANCE_CHANGED');assert.equal((await read(a)).envelope.revision,0);return{r};});
 await test('legacy-staged-active-source-protection',async()=>{await ev(a,'poc.reset()');const p=await ev(a,'poc.position()'),time='2026-11-04T00:00:00.000Z',legacy=JSON.stringify({version:1,revision:7,positions:[{...p,id:'legacy',createdAt:time,updatedAt:time}]});await ev(a,`poc.legacy(${JSON.stringify(legacy)})`);assert.equal((await ev(a,'poc.list()')).status,'MIGRATION_REQUIRED');assert.equal((await ev(a,'poc.stage()')).status,'COMMITTED');const staged=await ev(a,'poc.migration()');assert.equal(staged.status,'STAGED');const write=await outcome(a,await start(a,'renamePosition',['legacy','unsafe'],staged.snapshot));assert.notEqual(write.status,'SUCCESS');const activated=await ev(a,'poc.confirm()');assert.equal(activated.status,'ACTIVE');assert.equal(await ev(a,'poc.legacyRaw()'),legacy);const once=await ev(a,'poc.confirm()');assert.notEqual(once.status,'ACTIVE');const before=await read(b);await ev(a,`poc.legacy(${JSON.stringify(legacy.replace('Repository test','source changed'))})`);const blocked=await ev(a,'poc.list()');assert.equal(blocked.status,'UNAVAILABLE');assert.equal(blocked.code,'LEGACY_SOURCE_DIFFERS_OR_UNREADABLE');assert.deepEqual(await read(b),before);return{staged,write,activated,once,blocked};});
 await test('duplicate-operation-id-collision-and-event-attribution',async()=>{const s=await fresh(),nonce='00000000-0000-4000-8000-000000000999',p=await ev(a,'poc.position()');const f={snapshot:s,storageInstanceId:s.metadata.storageInstanceId,expectedRevision:0,nonce};const o=await ev(a,`poc.start('savePosition',[${JSON.stringify(p)}],${JSON.stringify(f)})`),r=await outcome(a,o);const second=await ev(b,`poc.start('savePosition',[${JSON.stringify({...p,title:'collision'})}],${JSON.stringify(f)})`),collision=await outcome(b,second);assert.equal(collision.persistence.code,'OPERATION_ID_COLLISION');assert.equal(r.nativeEvent,'COMPLETE');assert.notEqual(r.identity.requestId,collision.identity.requestId);assert.equal((await read(b)).envelope.revision,1);assert.equal((await ev(b,`poc.verify(${JSON.stringify(r.token)})`)).status,'COMMITTED');return{r,collision};});
 await test('freeze-precommit-scope-and-peer-liveness',async()=>{
  const fixture=capacityFixture(100),candidateJSON=JSON.stringify(fixture.metadata.baseEnvelope),sourceFingerprint=createHash('sha256').update(candidateJSON).digest('hex');
  fixture.metadata.migration={version:1,state:'ACTIVE',migrationId:'legacy-v1:'+sourceFingerprint,sourceFingerprint,sourceRevision:2,initialRevision:2,
   stagedOperationId:'33333333-3333-4333-8333-333333333333',activatedOperationId:'44444444-4444-4444-8444-444444444444',
   stagedAt:'2026-11-02T00:00:00.000Z',activatedAt:'2026-11-02T00:00:00.000Z',candidateJSON};
  const attempts=[];
  for(let attempt=1;attempt<=8;attempt++){
   await fresh();await ev(a,`poc.direct(${JSON.stringify(fixture)})`);await ev(a,'poc.newScope()');await ev(b,'poc.newScope()');
   // Observe the actual write transaction, rather than freezing while prepare()
   // or the preceding cold inspection is still opening its connection. Binding
   // observation adds no wait/task to the native transaction callback.
   const eventStart=h.events.length;
   const pending=start(a,'renamePosition',['seed-0','obsolete A'],fixture);
   const queued=await h.until(e=>e.sessionId===a.sessionId&&e.trace?.type==='reads-queued'&&e.trace.n===2,5000,eventStart);
   assert.ok(queued.trace,'write read requests must actually be queued');
   const frozen=await h.freeze(a),op=await pending;
   const phase=frozen.freezeEvent?.phases?.find(x=>x.operationId===op.operationId&&x.phase==='read-pending'&&x.requests.includes('pending'));
   const valid=!!phase&&frozen.freezeEvent.trusted===true&&frozen.probeDuringFreeze===null;
   attempts.push({attempt,op,queued,frozen,valid});await h.save('repository-freeze-attempt-'+attempt,attempts.at(-1));
   if(!valid){await h.resume(a);await ev(a,'poc.newScope()');continue;}
   const t0=performance.now(),peer=start(b,'renamePosition',['seed-1','B safe'],fixture);
   const pipeline=(async()=>{const bo=await peer,r=await outcome(b,bo);const native=await h.until(e=>e.sessionId===b.sessionId&&e.trace?.type==='native-terminal'&&e.trace.n===2&&e.trace.operationId===bo.operationId,5000);return{bo,r,native,elapsedMs:native.externalPerf-t0};})();
   const gate=await deadline(pipeline,5000);
   await h.save('repository-freeze-gate',{attempt,gate});
   assert.notEqual(gate.status,'DEADLINE_EXCEEDED');assert.equal(gate.r.status,'SUCCESS');assert.equal(gate.native.trace.terminal,'COMPLETE');assert.ok(gate.elapsedMs<=5000);
   const after=await read(b);assert.equal(after.envelope.revision,131);assert.equal(after.metadata.commits.length,128);assert.equal(after.envelope.positions[1].title,'B safe');
   await h.resume(a);const ar=await outcome(a,op);assert.equal(ar.status,'CANCELLED_UI_INTENT');assert.equal(await ev(a,`poc.apply(${JSON.stringify(op.requestId)})`),false);
   assert.deepEqual(await read(a),after);const witness=await ev(b,`poc.verify(${JSON.stringify(ar.token)})`);assert.equal(witness.status,'NOT_COMMITTED_OBSERVED');
   return{attempts,gate,after,ar,witness};
  }
  assert.fail('INCOMPLETE: no valid read-pending freeze within 8 attempts');
 });
 await test('freeze-independent-witness-verifier',async()=>{
  const attempts=[];
  // Reuse the validated ACTIVE state from the preceding full-capacity case.
  const fixture=await read(b),token=fixture.metadata.commits.at(-1).operation;
  for(let attempt=1;attempt<=8;attempt++){
   await ev(a,'poc.newScope()');await ev(b,'poc.newScope()');const from=h.events.length;
   const pending=ev(a,`poc.verify(${JSON.stringify(token)})`);
   const queued=await h.until(e=>e.sessionId===a.sessionId&&e.trace?.type==='reads-queued',5000,from);assert.ok(queued.trace);
   const frozen=await h.freeze(a),phase=frozen.freezeEvent?.phases.find(p=>p.id===queued.trace.id);
   const valid=phase?.phase==='read-pending'&&phase.requests.includes('pending')&&frozen.freezeEvent?.trusted===true&&frozen.probeDuringFreeze===null;
   attempts.push({attempt,queued,frozen,valid});await h.save('verifier-freeze-attempt-'+attempt,attempts.at(-1));
   if(!valid){await h.resume(a);await pending;continue;}
   const t0=performance.now(),pipeline=(async()=>{const o=await start(b,'renamePosition',['seed-1','Verifier peer safe'],fixture),r=await outcome(b,o);const native=await h.until(e=>e.sessionId===b.sessionId&&e.trace?.type==='native-terminal'&&e.trace.operationId===o.operationId&&e.trace.n===2,5000);return{o,r,native,elapsedMs:native.externalPerf-t0};})();
   const gate=await deadline(pipeline,5000);await h.save('verifier-freeze-gate',gate);assert.notEqual(gate.status,'DEADLINE_EXCEEDED');assert.equal(gate.r.status,'SUCCESS');assert.equal(gate.native.trace.terminal,'COMPLETE');assert.ok(gate.elapsedMs<=5000);
   await h.resume(a);const observed=await pending;assert.equal(observed.status,'UNKNOWN');assert.equal((await read(b)).envelope.revision,fixture.envelope.revision+1);
   return{attempts,gate,observed,final:await read(b)};
  }
  assert.fail('INCOMPLETE: no independent verifier read-pending capture in 8 attempts');
 });
 const consoleErrors=h.events.filter(e=>e.method==='Runtime.exceptionThrown'||['page-error','unhandled-rejection'].includes(e.trace?.type));
 assert.deepEqual(consoleErrors,[],'no console exception or unhandled rejection');
 await h.save('summary',summary);
}finally{await h.save('summary',summary);await h.save('console-errors',h.events.filter(e=>e.method==='Runtime.exceptionThrown'||['page-error','unhandled-rejection'].includes(e.trace?.type)));await h.close();}
