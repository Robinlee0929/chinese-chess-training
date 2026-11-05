import assert from 'node:assert/strict';
import {launch,deadline,sleep} from './idb-browser-harness.mjs';
const h=await launch('adapter-abrupt',{persistentContexts:true}),summary=[];
async function pair(strict=false){const a=await h.tab(undefined,h.origin+'/?tab=A'+(strict?'&durability=strict':'')),b=await h.tab(undefined,h.origin+'/?tab=B');await h.evaluate(a,'poc.seed(100)',true);return{a,b};}
const prepare=tab=>h.evaluate(tab,"poc.prepare({type:'rename',id:'seed-0',title:'fresh'})",true);
async function peer(p,t){const start=performance.now(),promise=(async()=>{const bt=await prepare(p.b),write=await h.write(p.b,bt);return{write,status:write.result.status};})();const gate={result:await deadline(promise,2000),elapsed:performance.now()-start};assert.equal(gate.result.status,'COMMITTED');assert.ok(gate.elapsed<2000);const verificationStart=performance.now();gate.result.observation=await h.evaluate(p.b,`poc.verify(${JSON.stringify(t)})`,true);gate.verificationMs=performance.now()-verificationStart;return gate;}
try{
 for(const action of ['crash','discard']){
  const p=await pair();let ctl,discardEvidence;
  const row=`(()=>{function rows(root){let all=[...root.querySelectorAll('tr')];for(const e of root.querySelectorAll('*'))if(e.shadowRoot)all.push(...rows(e.shadowRoot));return all;}return rows(document).find(r=>r.querySelector('.tab-url-cell')?.textContent.trim()===${JSON.stringify(h.origin+'/?tab=A')});})()`;
  if(action==='discard'){
   ctl=await h.tab(undefined,'chrome://chrome-urls/');const text=await h.evaluate(ctl,"document.querySelector('chrome-urls-app').shadowRoot.querySelector('cr-button').textContent");if(text.includes('Enable'))await h.evaluate(ctl,"document.querySelector('chrome-urls-app').shadowRoot.querySelector('cr-button').click();void 0");const from=h.events.length;await h.send('Page.navigate',{url:'chrome://discards/'},ctl.sessionId);await h.until(e=>e.sessionId===ctl.sessionId&&e.method==='Page.loadEventFired',2000,from);
  }
  const t=await prepare(p.a),started=h.start(p.a,t),frozen=await h.freeze(p.a);await started;assert.equal(frozen.freezeEvent?.phases[t.operationId]?.phase,'read-pending');
  let actionEvent;
  if(action==='crash'){const from=h.events.length;void h.send('Page.crash',{},p.a.sessionId).catch(()=>{});actionEvent=await h.until(e=>e.sessionId===p.a.sessionId&&e.method==='Inspector.targetCrashed',2000,from);assert.ok(actionEvent.method,'Native renderer crash must be observed');}
  else{
   const {windowId}=await h.send('Browser.getWindowForTarget',{targetId:p.a.targetId});await h.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});await h.send('Target.activateTarget',{targetId:ctl.targetId});await h.send('Target.detachFromTarget',{sessionId:p.a.sessionId});
   let ready=false;const end=performance.now()+3500;while(performance.now()<end){ready=await h.evaluate(ctl,`(()=>{const r=${row};return !!r&&[...r.querySelectorAll('.actions-cell [is="action-link"]')].some(e=>e.textContent.includes('Urgent Discard')&&!e.hasAttribute('disabled'));})()`);if(ready)break;await sleep(50);}assert.ok(ready,'Native discard control must become available');
   discardEvidence={before:await h.evaluate(ctl,`${row}.innerText`)};await h.evaluate(ctl,`[...${row}.querySelectorAll('.actions-cell [is="action-link"]')].find(e=>e.textContent.includes('Urgent Discard')).click();void 0`);
   const end2=performance.now()+3500;while(performance.now()<end2){discardEvidence.after=await h.evaluate(ctl,`${row}?.innerText`);if(discardEvidence.after?.includes('discarded'))break;await sleep(50);}assert.ok(discardEvidence.after.includes('discarded'));
  }
  const gate=await peer(p,t);assert.equal(gate.result.observation.status,'NOT_COMMITTED_OBSERVED');const replacement=await h.tab(undefined,h.origin+'/?replacement='+action),fresh=await h.evaluate(replacement,`poc.verify(${JSON.stringify(t)})`,true);assert.equal(fresh.status,'NOT_COMMITTED_OBSERVED');assert.equal(fresh.nativeEvent,'UNKNOWN');
  await h.save(action,{t,frozen,actionEvent,discardEvidence,gate,fresh});summary.push({id:action,result:'PASS',bMs:gate.elapsed,persistence:fresh.status,native:fresh.nativeEvent});console.log(JSON.stringify(summary.at(-1)));await h.dispose(p);await h.send('Target.closeTarget',{targetId:replacement.targetId});if(ctl)await h.send('Target.closeTarget',{targetId:ctl.targetId});
 }
 const attempts=[];
 for(let i=0;i<3;i++){
  const p=await pair(true),t=await prepare(p.a),from=h.events.length;await h.start(p.a,t);const commit=await h.until(e=>e.trace?.type==='commit-called'&&e.trace.operationId===t.operationId,2000,from);assert.ok(commit.trace);const frozen=await h.freeze(p.a),gate=await peer(p,t);assert.equal(gate.result.observation.status,'COMMITTED');await h.resume(p.a);await h.evaluate(p.a,'poc.resume()',true);const attempt={t,commit,frozen,gate};attempts.push(attempt);await h.save('strict-commit-freeze-'+i,attempt);console.log(JSON.stringify({id:'strict-commit-freeze-'+i,phase:frozen.freezeEvent?.phases[t.operationId]?.phase,bMs:gate.elapsed}));await h.dispose(p);
 }
 summary.push({id:'strict-commit-freeze',result:'PASS',attempts:attempts.length,phases:attempts.map(x=>x.frozen.freezeEvent?.phases[x.t.operationId]?.phase)});
 // A native versionchange closes the adapter's connection and stops new work.
 {const p=await pair(),token=await prepare(p.a);const result=await h.evaluate(p.b,"new Promise((resolve,reject)=>{const r=indexedDB.open('chinese-chess-training:custom-positions',2);r.onsuccess=()=>{r.result.close();resolve('UPGRADED');};r.onerror=()=>reject(r.error);})",true);assert.equal(result,'UPGRADED');const stopped=await h.write(p.a,token);assert.equal(stopped.result.code,'STALE_LIFECYCLE');const read=await h.evaluate(p.a,'poc.read()',true);assert.equal(read.code,'SUSPENDED');await h.save('versionchange',{result,stopped,read});summary.push({id:'versionchange',result:'PASS'});await h.dispose(p);}
 await h.save('summary',summary);
}catch(error){await h.save('harness-failure',{message:error.message,stack:error.stack,summary});throw error;}
finally{await h.save('console-errors',h.events.filter(e=>e.method==='Runtime.exceptionThrown'||['page-error','unhandled-rejection'].includes(e.trace?.type)));await h.close();}
