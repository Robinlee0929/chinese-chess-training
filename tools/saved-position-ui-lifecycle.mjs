// Raw CDP avoids Playwright's page-visibility emulation. Runs the real UI,
// repository and native IDB; the server/origin is supplied by the UI suite.
import assert from 'node:assert/strict';
import { launch, deadline, sleep } from './idb-browser-harness.mjs';
export async function testNativeUILifecycle(url) {
  const h=await launch('saved-position-native-ui-lifecycle');
  const evaluate=(tab,fn,arg)=>h.evaluate(tab,`(${fn.toString()})(${JSON.stringify(arg)??'undefined'})`,true);
  async function condition(tab,expression){for(let i=0;i<100;i++){if(await h.evaluate(tab,expression))return;await sleep(20);}await h.save('condition-miss',{expression,dom:await h.evaluate(tab,"({visibility:document.visibilityState,dialog:document.getElementById('savedPositionsDialog').outerHTML,button:document.getElementById('btnSavedPositions').outerHTML,appState:__chess.appState})")});assert.fail('INCOMPLETE: condition '+expression);}
  async function open(tab){await h.evaluate(tab,"document.getElementById('btnSavedPositions').click()");await condition(tab,"document.getElementById('savedPositionsDialog').open && document.getElementById('savedPositionsDialog').getAttribute('aria-busy')==='false'");}
  try {
    const {browserContextId}=await h.send('Target.createBrowserContext');
    const a=await h.tab(browserContextId,url),b=await h.tab(browserContextId,url);
    await condition(a,'!!window.__chess');await condition(b,'!!window.__chess');
    await h.evaluate(a,`window.poc={inspect:()=>({open:document.getElementById('savedPositionsDialog').open,session:__chess.normalGameRecordSession.id}),probe:id=>setTimeout(()=>trace(JSON.stringify({type:'probe',id})),0)};for(const[target,type]of[[document,'freeze'],[document,'resume'],[window,'pagehide'],[window,'pageshow']])target.addEventListener(type,e=>{const event={type,trusted:e.isTrusted,persisted:e.persisted??null};trace(JSON.stringify(event));navigator.sendBeacon(${JSON.stringify(h.origin+'/journal')},JSON.stringify(event));},true);`);
    await open(a);await h.evaluate(a,"document.getElementById('savedPositionsClose').click()");
    const id=await evaluate(b,async()=>{const{createCustomPositionRepository}=await import('./custom-position-repository.js'),{initialBoard}=await import('./game.js');const r=createCustomPositionRepository(),s=r.createScope(),v=await s.loadAll().completion;const w=await s.savePosition({title:'生命週期局面',initialBoard:initialBoard(),sideToMove:'red',playPreferences:{humanSide:'red',difficulty:'easy'}},{snapshot:v.snapshot,storageInstanceId:v.snapshot.metadata.storageInstanceId,expectedRevision:v.snapshot.envelope.revision}).completion;r.dispose();if(w.status!=='SUCCESS')throw Error(w.code);return w.position.id;});
    await open(a);const before=await h.evaluate(a,'poc.inspect()'),frozen=await h.freeze(a);
    assert.equal(frozen.freezeEvent?.trusted,true,'INCOMPLETE: native freeze');assert.equal(frozen.probeDuringFreeze,null);assert.equal(frozen.inspect.open,false);
    const start=performance.now(),write=await deadline(evaluate(b,async id=>{const{createCustomPositionRepository}=await import('./custom-position-repository.js');const r=createCustomPositionRepository(),s=r.createScope(),v=await s.loadAll().completion,w=await s.renamePosition(id,'凍結後更新',{snapshot:v.snapshot,storageInstanceId:v.snapshot.metadata.storageInstanceId,expectedRevision:v.snapshot.envelope.revision}).completion;r.dispose();return w;},id),5000),elapsedMs=performance.now()-start;
    assert.equal(write.status,'SUCCESS');assert.equal(write.nativeEvent,'COMPLETE');assert.ok(elapsedMs<=5000);
    await h.save('freeze',{before,frozen,write,elapsedMs,over2000:elapsedMs>2000,over3000:elapsedMs>3000,over5000:elapsedMs>5000});
    await h.resume(a);
    // Headless CDP keeps the explicitly hidden WebContents hidden after active.
    // Emulate the user returning only AFTER B's native completion and frozen
    // evidence. Never use visibility emulation during the freeze gate.
    await h.send('Emulation.setFocusEmulationEnabled',{enabled:true},a.sessionId);
    assert.equal((await h.evaluate(a,'poc.inspect()')).session,before.session);await open(a);
    assert.match(await h.evaluate(a,"document.getElementById('savedPositionsList').textContent"),/凍結後更新/);
    await h.send('Emulation.setFocusEmulationEnabled',{enabled:false},a.sessionId);
    const history=await h.send('Page.getNavigationHistory',{},a.sessionId),entry=history.entries[history.currentIndex].id,from=h.events.length;
    await h.evaluate(a,`(()=>{const link=document.createElement('a');link.href=${JSON.stringify(url+'?away')};document.body.append(link);link.click();})()`);
    const departure=await h.waitJournal(e=>e.event.type==='pagehide',2000);assert.equal(departure.event?.trusted,true);
    await condition(a,'!!window.__chess');
    const returning=h.events.length;await h.send('Page.navigateToHistoryEntry',{entryId:entry},a.sessionId);
    const restored=await h.until(e=>e.sessionId===a.sessionId&&e.trace?.type==='pageshow',2000,returning);
    assert.equal(restored.trace?.persisted,true,'INCOMPLETE: real BFCache restoration required');
    assert.equal(await h.evaluate(a,"document.getElementById('savedPositionsDialog').open"),false);assert.equal((await h.evaluate(a,'poc.inspect()')).session,before.session);
    await h.send('Emulation.setFocusEmulationEnabled',{enabled:true},a.sessionId);
    await open(a);assert.match(await h.evaluate(a,"document.getElementById('savedPositionsList').textContent"),/凍結後更新/);
    const errors=h.events.filter(e=>e.method==='Runtime.exceptionThrown'||e.method==='Runtime.consoleAPICalled'&&e.params.type==='error');assert.deepEqual(errors,[]);
    await h.save('pagehide-BFCache',{departure,restored,final:await h.evaluate(a,'poc.inspect()'),errors});
    return {status:'PASS',elapsedMs,persisted:restored.trace.persisted,chrome:h.version.product};
  } finally {await h.close();}
}
