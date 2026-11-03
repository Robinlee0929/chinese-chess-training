import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {launch,deadline,sleep} from './idb-browser-harness.mjs';
import {capacityFixture} from './idb-capacity-fixture.mjs';
import {MAX_INJECTION_ATTEMPTS,classifyReadPending,classifyFreeze,boundedInjection} from './idb-migration-injection.mjs';

const legacy=JSON.stringify(capacityFixture(10).envelope), allResults=[];
for(const bfcache of [true,false]){
 const priorDir=process.env.IDB_LIFECYCLE_RESUME?path.join(process.env.IDB_LIFECYCLE_RESUME,'migration-lifecycle-'+bfcache):null;
 let priorFiles=[],priorResults=[];
 if(priorDir){try{priorFiles=await readdir(priorDir);priorResults=JSON.parse(await readFile(path.join(priorDir,'summary.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
 const attempted=id=>Math.max(priorResults.find(r=>r.id===id)?.attempts??0,...priorFiles.filter(f=>f.startsWith(id+'-attempt-')).map(f=>Number(f.match(/attempt-(\d+)\.json$/)?.[1]??0)));
 const recheck=process.env.IDB_LIFECYCLE_RECHECK;
 if(recheck)assert.ok(['freeze','crash','discard'].includes(recheck),'Only a named injection may be rechecked within its remaining budget');
 const h=await launch('migration-lifecycle-'+bfcache,{persistentContexts:true,bfcache,fixture:'idb-migration-fixture.js'}),results=[];
 const ev=(t,s)=>h.evaluate(t,s,true),raw=t=>ev(t,'poc.raw()');
 const traces=()=>[...h.journals.map(e=>e.event),...h.events.filter(e=>e.trace).map(e=>e.trace)];
 const native=p=>traces().find(e=>e.type==='native-terminal'&&e.operationId===p.t.operationId)?.terminal??'UNKNOWN';
 await h.save('injection-plan',{maxAttemptsPerScenario:MAX_INJECTION_ATTEMPTS,targetHits:1,bfcache,
  scenarios:[...(bfcache?['freeze','crash','discard']:[]),'pagehide-precommit'],
  method:'Concurrent external stage/freeze commands; native link navigation. No transaction delay.',
  missedInjection:'INCOMPLETE, not data safety FAIL',peerDeadlineMs:5000,priorDir,priorFiles,priorResults,recheck});
 async function pair(){
  const a=await h.tab(undefined,h.origin+'/?tab=A');await ev(a,'poc.reset()');
  await ev(a,`poc.legacy(${JSON.stringify(legacy)})`);await ev(a,'poc.plan()');
  const t=await ev(a,'poc.stageToken()'),b=await h.tab(undefined,h.origin+'/?tab=B');return{a,b,t};
 }
 async function peer(p){
  const start=performance.now(),from=h.events.length;
  const result=await deadline((async()=>{const plan=await ev(p.b,'poc.plan()');
   assert.ok(['MIGRATION_REQUIRED','STAGED'].includes(plan.state));return ev(p.b,'poc.confirm()')})(),5000);
  const elapsedMs=performance.now()-start;
  const complete=h.events.slice(from).find(e=>e.sessionId===p.b.sessionId&&e.trace?.type==='native-terminal'&&e.trace.action==='ACTIVE'&&e.trace.terminal==='COMPLETE');
  const evidence={result,elapsedMs,complete,thresholdMs:5000};
  await h.save('peer-'+p.t.operationId,evidence); // A deadline is observation, not transaction cancellation.
  assert.equal(result.state,'ACTIVE');assert.equal(result.nativeEvent,'COMPLETE');
  assert.equal(complete?.trace.trusted,true);assert.ok(elapsedMs<=5000);return evidence;
 }
 async function verify(p){
  const after=await raw(p.b);assert.deepEqual(after.envelope,JSON.parse(legacy));
  assert.equal(after.metadata.migration.state,'ACTIVE');assert.equal(await ev(p.b,'poc.legacyRaw()'),legacy);
  const witness=await ev(p.b,`poc.manager.verifyMigrationOutcome(${JSON.stringify(p.t)})`);
  assert.ok(['UNKNOWN','COMMITTED'].includes(witness.status));assert.equal(witness.nativeEvent,'UNKNOWN');
  assert.deepEqual(await raw(p.b),after); // UNKNOWN verification must not submit anything.
  return{after,witness,native:native(p),legacyPreserved:true};
 }
 async function restored(p,before){
  await ev(p.a,'ready');await ev(p.a,'poc.manager.resume()');
  const stale=await ev(p.a,"typeof plan!=='undefined'?poc.confirm():({code:'OLD_CONTEXT_DESTROYED'})");
  assert.ok(['STALE_MIGRATION_PLAN','OLD_CONTEXT_DESTROYED'].includes(stale.code));
  assert.deepEqual(await raw(p.b),before);assert.equal(await ev(p.a,'poc.legacyRaw()'),legacy);
  return{stale,inspect:await ev(p.a,'poc.inspect()')};
 }
 async function publish(id,result){results.push({id,...result});await h.save('summary',results);console.log(JSON.stringify(results.at(-1)));}
 async function control(){
  const ctl=await h.tab(undefined,'chrome://chrome-urls/');
  if((await ev(ctl,"document.querySelector('chrome-urls-app').shadowRoot.querySelector('cr-button').textContent")).includes('Enable'))
   await ev(ctl,"document.querySelector('chrome-urls-app').shadowRoot.querySelector('cr-button').click();void 0");
  const from=h.events.length;await h.send('Page.navigate',{url:'chrome://discards/'},ctl.sessionId);
  assert.ok((await h.until(e=>e.sessionId===ctl.sessionId&&e.method==='Page.loadEventFired',2000,from)).method);return ctl;
 }
 async function discard(p,ctl){
  const row=`(()=>{function rows(root){let all=[...root.querySelectorAll('tr')];for(const e of root.querySelectorAll('*'))if(e.shadowRoot)all.push(...rows(e.shadowRoot));return all;}return rows(document).find(r=>r.querySelector('.tab-url-cell')?.textContent.trim()===${JSON.stringify(h.origin+'/?tab=A')});})()`;
  const{windowId}=await h.send('Browser.getWindowForTarget',{targetId:p.a.targetId});
  await h.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
  await h.send('Target.activateTarget',{targetId:ctl.targetId});await h.send('Target.detachFromTarget',{sessionId:p.a.sessionId});
  let ready=false;
  for(const end=performance.now()+3500;performance.now()<end;){
   ready=await ev(ctl,`(()=>{const r=${row};return !!r&&[...r.querySelectorAll('.actions-cell [is="action-link"]')].some(e=>e.textContent.includes('Urgent Discard')&&!e.hasAttribute('disabled'));})()`);
   if(ready)break;await sleep(50); // External control page only, never inside a transaction.
  }
  assert.ok(ready,'Native discard available');const evidence={before:await ev(ctl,`${row}.innerText`),targetId:p.a.targetId,windowId};
  await ev(ctl,`[...${row}.querySelectorAll('.actions-cell [is="action-link"]')].find(e=>e.textContent.includes('Urgent Discard')).click();void 0`);
  for(const end=performance.now()+3500;performance.now()<end;){
   evidence.after=await ev(ctl,`${row}?.innerText`);if(evidence.after?.includes('discarded'))break;await sleep(50);
  }
  assert.ok(evidence.after?.includes('discarded'));return evidence;
 }
 async function restoreDiscard(p,action){
  // Headless Chrome's discarded tab has a replacement target but no loaded renderer.
  // Use native Load on the existing tab; activation alone need not load its document.
  const row=`(()=>{function rows(root){let all=[...root.querySelectorAll('tr')];for(const e of root.querySelectorAll('*'))if(e.shadowRoot)all.push(...rows(e.shadowRoot));return all;}return rows(document).find(r=>r.querySelector('.tab-url-cell')?.textContent.trim()===${JSON.stringify(h.origin+'/?tab=A')});})()`;
  action.load=await ev(p.ctl,`(()=>{const row=${row};const load=[...row.querySelectorAll('.actions-cell [is="action-link"]')].find(e=>e.textContent.includes('Load'));const before=row.innerText;load.click();return{before,clicked:load.textContent};})()`);
  await h.send('Browser.setWindowBounds',{windowId:action.windowId,bounds:{windowState:'normal'}});
  const targets=(await h.send('Target.getTargets')).targetInfos;
  const replacements=targets.filter(t=>t.type==='page'&&t.url===h.origin+'/?tab=A');
  assert.equal(replacements.length,1,'Find the existing discarded tab, without creating a new tab');
  action.restorationTargets=targets;action.oldTargetId=p.a.targetId;
  p.a.targetId=replacements[0].targetId;action.restoredTargetId=p.a.targetId;
  await h.send('Target.activateTarget',{targetId:p.a.targetId});
  const{sessionId}=await h.send('Target.attachToTarget',{targetId:p.a.targetId,flatten:true});p.a.sessionId=sessionId;
  for(const method of ['Page.enable','Runtime.enable']){
   const enabled=await deadline(h.send(method,{},sessionId),4000);
   assert.notEqual(enabled.status,'DEADLINE_EXCEEDED','Bounded discarded-document restoration: '+method);
  }
  await h.send('Runtime.addBinding',{name:'trace'},sessionId);
  let ready=false;
  for(const end=performance.now()+4000;performance.now()<end;){
   try{ready=await ev(p.a,'typeof poc!=="undefined"&&document.readyState==="complete"');}catch{}
   if(ready)break;await sleep(20);
  }
  assert.ok(ready,'Discarded page restored');const wasDiscarded=await ev(p.a,'document.wasDiscarded');
  assert.equal(wasDiscarded,true);return{wasDiscarded};
 }
 async function frozenScenario(action){
  const completed=priorResults.find(r=>r.id===action&&r.result==='PASS');
  if(completed&&recheck!==action){await publish(action,{...completed,reusedEvidence:priorDir});return;}
  let current;
  try{
   const result=await boundedInjection(async number=>{
    const p=await pair();current=p;if(action==='discard')p.ctl=await control();
    const from=h.events.length,startedPerf=performance.now();
    // Sending together avoids an extra CDP round trip. Signals prove the point without holding it open.
    const pending=h.evaluate(p.a,'poc.stage()'),frozen=await h.freeze(p.a);await pending;
    const capture=classifyFreeze(frozen,p.t.operationId);
    const evidence={attemptId:`${action}-${number}`,operation:p.t,startedPerf,frozen,capture,
     phaseSignal:h.events.slice(from).find(e=>e.trace?.type==='stage-reads-queued'&&e.trace.operationId===p.t.operationId),
     actionPerformed:false,native:native(p),persistentOutcome:'UNKNOWN'};
    if(!capture.hit){
     await h.resume(p.a);
     const outcome=await h.until(e=>e.trace?.type==='stage-outcome'&&e.trace.operationId===p.t.operationId,2000,from);
     Object.assign(evidence,{outcome,final:await raw(p.b),native:native(p),
      persistentOutcome:await ev(p.b,`poc.manager.verifyMigrationOutcome(${JSON.stringify(p.t)})`)});
     await h.dispose(p);if(p.ctl)await h.send('Target.closeTarget',{targetId:p.ctl.targetId});current=null;
    }
    return evidence;
   },(n,e)=>h.save(`${action}-attempt-${n}`,e),async(number,evidence)=>{
    const p=current;
    try{
     if(action==='crash'){
      const from=h.events.length;void h.send('Page.crash',{},p.a.sessionId).catch(()=>{});
      evidence.action=await h.until(e=>e.sessionId===p.a.sessionId&&e.method==='Inspector.targetCrashed',2000,from);
      assert.ok(evidence.action.method,'Page.crash actually executed');evidence.actionPerformed=true;
     }else if(action==='discard'){evidence.action=await discard(p,p.ctl);evidence.actionPerformed=true;}
     evidence.afterDeparture=await raw(p.b); // Independent connection reopened by the surviving tab.
     assert.ok(evidence.afterDeparture.metadata===null||evidence.afterDeparture.metadata.migration.state==='STAGED');
     evidence.peer=await peer(p);Object.assign(evidence,await verify(p));evidence.persistentOutcome=evidence.witness;
     assert.equal(h.events.filter(e=>e.sessionId===p.a.sessionId&&e.trace?.type==='resume').length,0,'B completes before A resumes');
     if(action==='freeze'){await h.resume(p.a);evidence.restored=await restored(p,evidence.after);}
     if(action==='discard'){evidence.discardRestored=await restoreDiscard(p,evidence.action);evidence.restored=await restored(p,evidence.after);}
     evidence.native=native(p);evidence.result='PASS';
    }catch(error){evidence.result='FAIL';evidence.error={message:error.message,stack:error.stack};throw error;}
    finally{await h.save(`${action}-attempt-${number}`,evidence);}
    await h.dispose(p);if(p.ctl)await h.send('Target.closeTarget',{targetId:p.ctl.targetId});current=null;
   },attempted(action));
   await publish(action,result);
  }finally{if(current){await h.dispose(current);if(current.ctl)await h.send('Target.closeTarget',{targetId:current.ctl.targetId}).catch(()=>{});}}
 }
 async function pagehideScenario(precommit){
  const id=precommit?'pagehide-precommit':'pagehide-postcommit';let hit=false;
  const completed=priorResults.find(r=>r.id===id&&r.result==='PASS');
  if(completed){await publish(id,{...completed,reusedEvidence:priorDir});return;}
  for(let number=attempted(id)+1;number<=(precommit?MAX_INJECTION_ATTEMPTS:1);number++){
   const p=await pair(),history=await h.send('Page.getNavigationHistory',{},p.a.sessionId);
   const entryId=history.entries[history.currentIndex].id,from=h.events.length;
   const evidence={attemptId:`${id}-${number}`,operation:p.t,actionPerformed:false};
   try{
    if(precommit){
     await ev(p.a,'poc.arm()');const point=await ev(p.a,"(()=>{const r=document.getElementById('leave').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()");
     await h.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1},p.a.sessionId);
     await h.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1},p.a.sessionId);
    }else{
     await ev(p.a,'poc.stage()');
     const complete=await h.until(e=>e.trace?.type==='stage-outcome'&&e.trace.operationId===p.t.operationId,2000,from);
     assert.equal(complete.trace?.status,'COMMITTED');await h.send('Page.navigate',{url:h.origin+'/destination'},p.a.sessionId);
    }
    const departure=await h.until(e=>e.sessionId===p.a.sessionId&&e.method==='Page.frameNavigated',2000,from);
    assert.ok(departure.method);evidence.actionPerformed=true;
    await h.waitJournal(e=>e.event.type==='pagehide'&&Object.values(e.event.phases??{}).some(t=>t.operationId===p.t.operationId),2000);
    evidence.pagehide=traces().find(e=>e.type==='pagehide'&&Object.values(e.phases??{}).some(t=>t.operationId===p.t.operationId))??null;
    evidence.capture=classifyReadPending(evidence.pagehide,p.t.operationId);evidence.native=native(p);
    evidence.afterDeparture=await raw(p.b);
    hit=precommit?evidence.capture.hit:evidence.pagehide?.isTrusted===true&&evidence.capture.phase?.phase==='COMPLETE';
    evidence.result=hit?'PASS':'INCOMPLETE'; // A post-commit departure never counts as pre-commit.
    evidence.peer=await peer(p);Object.assign(evidence,await verify(p));
    const backFrom=h.events.length;await h.send('Page.navigateToHistoryEntry',{entryId},p.a.sessionId);
    evidence.pageshow=await h.until(e=>e.sessionId===p.a.sessionId&&e.trace?.type==='pageshow',2000,backFrom);
    evidence.restored=await restored(p,evidence.after);evidence.native=native(p);
   }catch(error){evidence.result='FAIL';evidence.error={message:error.message,stack:error.stack};throw error;}
   finally{await h.save(`${id}-attempt-${number}`,evidence);await h.dispose(p);}
   if(hit){await publish(id,{result:'PASS',attempts:number,persisted:evidence.pagehide.persisted});break;}
  }
  if(!hit)await publish(id,{result:'INCOMPLETE',attempts:precommit?MAX_INJECTION_ATTEMPTS:1});
 }
 try{
  if(bfcache)for(const action of ['freeze','crash','discard'])await frozenScenario(action);
  await pagehideScenario(true);await pagehideScenario(false);
  if(bfcache){
   const p=await pair();await ev(p.b,'poc.plan()');
   const outcomes=await Promise.all([ev(p.a,'poc.confirm()'),ev(p.b,'poc.confirm()')]);
   assert.equal(outcomes.filter(r=>r.state==='ACTIVE').length,1);assert.equal(outcomes.filter(r=>r.state==='BLOCKED').length,1);
   const after=await raw(p.b);assert.deepEqual(after.envelope,JSON.parse(legacy));
   assert.equal((await ev(p.a,'poc.confirm()')).code,'STALE_MIGRATION_PLAN');assert.deepEqual(await raw(p.b),after);
   assert.equal(await ev(p.b,'poc.legacyRaw()'),legacy);
   await h.save('concurrent-migration',{outcomes,after});await publish('concurrent-migration',{result:'PASS'});await h.dispose(p);
  }
 }catch(error){await h.save('failure',{message:error.message,stack:error.stack,results});throw error;}
 finally{
  await h.save('summary',results);
  const errors=h.events.filter(e=>e.method==='Runtime.exceptionThrown'||['page-error','unhandled-rejection'].includes(e.trace?.type));
  await h.save('console-errors',errors);allResults.push({bfcache,results,consoleErrors:errors.length});
  await h.save('coverage',{
   'MIG-L01':results.find(r=>r.id==='freeze')?.result??(bfcache?'NOT_RUN':'NOT_APPLICABLE'),
   'MIG-L02':results.find(r=>r.id==='crash')?.result??(bfcache?'NOT_RUN':'NOT_APPLICABLE'),
   'MIG-L03':results.find(r=>r.id==='crash')?.result??(bfcache?'NOT_RUN':'NOT_APPLICABLE'),
   'MIG-L04':results.find(r=>r.id==='discard')?.result??(bfcache?'NOT_RUN':'NOT_APPLICABLE'),
   'MIG-L05':['pagehide-precommit','pagehide-postcommit'].every(id=>results.some(r=>r.id===id&&r.result==='PASS'))?'PASS':'INCOMPLETE',
   'MIG-L06':results.filter(r=>['freeze','discard','pagehide-precommit','pagehide-postcommit'].includes(r.id)).map(r=>({scenario:r.id,result:r.result})),
   'MIG-L07':results.filter(r=>r.id!=='concurrent-migration').map(r=>({scenario:r.id,result:r.result})),
   'MIG-L08':results.filter(r=>r.id!=='concurrent-migration').map(r=>({scenario:r.id,result:r.result})),
   'MIG-L09':results.find(r=>r.id==='concurrent-migration')?.result??(bfcache?'NOT_RUN':'NOT_APPLICABLE'),
   'MIG-L10':'Pure classification/bounded-injection tests and all retained browser misses'});
  await h.close();
 }
}
if(allResults.some(g=>g.consoleErrors||g.results.some(r=>r.result!=='PASS')))process.exitCode=2;
