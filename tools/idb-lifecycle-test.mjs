import assert from 'node:assert/strict';
import {launch,deadline,sleep} from './idb-browser-harness.mjs';
const summary=[];
for(const bfcache of [true,false]){
 const h=await launch('adapter-lifecycle-'+bfcache,{persistentContexts:true,bfcache});
 async function pair(variant='',count=100){const a=await h.tab(undefined,h.origin+'/?tab=A'+(variant?'&variant='+variant:'')),b=await h.tab(undefined,h.origin+'/?tab=B');await h.evaluate(a,`poc.seed(${count})`,true);return{a,b};}
 const prepare=(tab,title='B fresh')=>h.evaluate(tab,`poc.prepare({type:'rename',id:'seed-0',title:${JSON.stringify(title)}})`,true);
 const read=async tab=>{const r=await h.evaluate(tab,'poc.read()',true);assert.equal(r.ok,true,JSON.stringify(r));return r.snapshot;};
 async function save(id,evidence){await h.save(id,evidence);summary.push({id,...evidence.summary});console.log(JSON.stringify(summary.at(-1)));}
 try{
  for(const method of ['link','cdp','close']){
   const id='pagehide-'+method+'-'+bfcache,p=await pair(),t=await prepare(p.a,'A intent'),history=await h.send('Page.getNavigationHistory',{},p.a.sessionId),entry=history.entries[history.currentIndex].id,start=h.events.length;
   if(method==='link'){await h.evaluate(p.a,`poc.arm(${JSON.stringify(t)})`);const point=await h.evaluate(p.a,"(()=>{const r=document.getElementById('leave').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()");await h.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1},p.a.sessionId);await h.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1},p.a.sessionId);}
   else{await h.start(p.a,t);if(method==='close')await h.send('Target.closeTarget',{targetId:p.a.targetId});else await h.send('Page.navigate',{url:h.origin+'/destination'},p.a.sessionId);}
   const departure=method==='close'?await h.until(e=>e.method==='Target.detachedFromTarget'&&e.params.sessionId===p.a.sessionId,2000,start):await h.until(e=>e.sessionId===p.a.sessionId&&e.method==='Page.frameNavigated',2000,start);assert.ok(departure.method);
   const time=performance.now(),pipeline=(async()=>{const before=await read(p.b),bt=await prepare(p.b),write=await h.write(p.b,bt);return{before,bt,write,status:write.result.status};})();
   const gate={result:await deadline(pipeline,2000),elapsed:performance.now()-time};assert.equal(gate.result.status,'COMMITTED');assert.ok(gate.elapsed<2000);
   // The contract ends at transaction.complete, not at subsequent verification.
   // A still remains away while the independent persistence checks run.
   const verificationStart=performance.now();gate.result.after=await read(p.b);gate.result.observation=await h.evaluate(p.b,`poc.verify(${JSON.stringify(t)})`,true);gate.verificationMs=performance.now()-verificationStart;
   let restored=null;if(method!=='close'){const from=h.events.length;await h.send('Page.navigateToHistoryEntry',{entryId:entry},p.a.sessionId);restored=await h.until(e=>e.sessionId===p.a.sessionId&&e.trace?.type==='pageshow',2000,from);await h.evaluate(p.a,'ready',true);await h.evaluate(p.a,'poc.resume()',true);}
   const final=await read(p.b);assert.deepEqual(final,gate.result.after);const observations=[...h.journals.map(x=>x.event),...h.events.filter(x=>x.trace).map(x=>x.trace)];const pagehide=observations.find(x=>x.type==='pagehide'&&x.phases?.[t.operationId]);assert.ok(pagehide?.isTrusted);const phase=pagehide.phases[t.operationId];const native=observations.find(x=>x.type==='native-terminal'&&x.operationId===t.operationId)?.terminal??'UNKNOWN';assert.ok(['COMMITTED','NOT_COMMITTED_OBSERVED'].includes(gate.result.observation.status));
   if(phase.phase==='read-pending')assert.equal(gate.result.observation.status,'NOT_COMMITTED_OBSERVED');
   await save(id,{t,pagehide,gate,final,restored,summary:{result:'PASS',phase:phase.phase,persisted:pagehide.persisted,native,persistence:gate.result.observation.status,bMs:gate.elapsed}});await h.dispose(p);
  }
  if(bfcache){
   for(const variant of ['skip-revision','premature','stale-replay']){
    const p=await pair(variant,1),t=await prepare(p.a,'obsolete');let result,expected;
    if(variant==='skip-revision'){const bt=await prepare(p.b);assert.equal((await h.write(p.b,bt)).result.status,'COMMITTED');result=await h.write(p.a,t);expected='REVISION_CONFLICT';assert.notEqual(result.result.status,expected);}
    if(variant==='premature'){await h.evaluate(p.a,"poc.faults({failWrites:'abort'})");result=await h.write(p.a,t);assert.equal(result.result.status,'COMMITTED');const final=await read(p.b);assert.equal(final.envelope.revision,0);assert.ok(!final.metadata.committedOperationIds.includes(t.operationId));expected='No success before transaction complete';}
    if(variant==='stale-replay'){await h.evaluate(p.a,"poc.adapter.suspend('freeze');poc.resume()",true);result=await h.write(p.a,t);assert.equal(result.result.status,'COMMITTED');expected='STALE_LIFECYCLE';}
    await save('negative-'+variant,{t,result,expected,final:await read(p.b),summary:{result:'DETECTED',actual:result.result.status,code:result.result.code}});await h.dispose(p);
   }
   {const p=await pair('',0),before=await read(p.a),a=await h.evaluate(p.a,"poc.prepare({type:'save',position:poc.position(1)})",true),b=await h.evaluate(p.b,"poc.prepare({type:'save',position:poc.position(2)})",true),sa=await h.evaluate(p.a,`poc.preview(${JSON.stringify(before)},${JSON.stringify(a)})`),sb=await h.evaluate(p.b,`poc.preview(${JSON.stringify(before)},${JSON.stringify(b)})`);const writes=await Promise.all([h.evaluate(p.a,`poc.foreignWrite(${JSON.stringify(sa)})`,true),h.evaluate(p.b,`poc.foreignWrite(${JSON.stringify(sb)})`,true)]);const final=await read(p.b);assert.ok(writes.every(w=>w.status==='COMMITTED'));assert.equal(final.envelope.revision,1);assert.equal(final.metadata.committedOperationIds.length,1);await save('negative-split-transactions',{a,b,writes,final,summary:{result:'DETECTED',successfulWrites:2,revision:1,witnesses:1}});await h.dispose(p);}
   // Commit/freeze race: command is injected on the actual observed commit call.
   {const p=await pair(),t=await prepare(p.a),start=h.events.length;await h.start(p.a,t);const commit=await h.until(e=>e.trace?.type==='commit-called'&&e.trace.operationId===t.operationId,2000,start);assert.ok(commit.trace);const frozen=await h.freeze(p.a);const time=performance.now();const pending=(async()=>{const bt=await prepare(p.b),write=await h.write(p.b,bt),observation=await h.evaluate(p.b,`poc.verify(${JSON.stringify(t)})`,true);return{write,observation,status:write.result.status};})();const gate={result:await deadline(pending,2000),elapsed:performance.now()-time};assert.equal(gate.result.status,'COMMITTED');assert.equal(gate.result.observation.status,'COMMITTED');assert.ok(gate.elapsed<2000);await h.resume(p.a);await h.evaluate(p.a,'poc.resume()',true);await save('commit-freeze-race',{t,commit,frozen,gate,summary:{result:'PASS',bMs:gate.elapsed,nativePhase:frozen.freezeEvent?.phases[t.operationId]?.phase}});await h.dispose(p);}
  }
  await h.save('summary',summary.filter(r=>r.id.endsWith('-'+bfcache)||bfcache&&!r.id.startsWith('pagehide')));
 }catch(error){await h.save('harness-failure',{message:error.message,stack:error.stack,summary});throw error;}
 finally{await h.save('console-errors',h.events.filter(e=>e.method==='Runtime.exceptionThrown'||['page-error','unhandled-rejection'].includes(e.trace?.type)));await h.close();}
}
