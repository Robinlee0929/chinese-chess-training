// S3-D: fixed 48-sample, diagnostic UI baseline. No product source is changed.
// localhost, synthetic fixtures and isolated Chrome contexts only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { capacityFixture } from './idb-capacity-fixture.mjs';
import { validateCustomPositionIDBState } from '../custom-position-idb.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.env.UI_BASELINE_DIR||'test-results/s3d-ui-baseline');
await mkdir(output,{recursive:false}); // Never overwrite an earlier batch.
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const server=createServer(async(req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
 const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 try{const body=await readFile(file);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');res.end(body);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/';
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
function fixture(count){
 const f=capacityFixture(count);
 if(count===1){f.envelope=structuredClone(f.metadata.baseEnvelope);f.envelope.revision=0;f.metadata.baseEnvelope=structuredClone(f.envelope);f.metadata.commits=[];f.metadata.committedOperationIds=[];f.metadata.lastCommit=null;}
 const candidateJSON=JSON.stringify(f.metadata.baseEnvelope),fingerprint=createHash('sha256').update(candidateJSON).digest('hex');
 f.metadata.migration={version:1,state:'ACTIVE',migrationId:'legacy-v1:'+fingerprint,sourceFingerprint:fingerprint,sourceRevision:f.metadata.baseEnvelope.revision,initialRevision:f.metadata.baseEnvelope.revision,stagedOperationId:'33333333-3333-4333-8333-333333333333',activatedOperationId:'44444444-4444-4444-8444-444444444444',stagedAt:'2026-11-02T00:00:00.000Z',activatedAt:'2026-11-02T00:00:00.000Z',candidateJSON};
 validateCustomPositionIDBState(f.envelope,f.metadata);return f;
}
const fixtures={small:fixture(1),full:fixture(100)};
const groups=[['desktop','small'],['mobile','full'],['desktop','full'],['mobile','small']];
const plan=Array.from({length:12},(_,round)=>groups.map((_,i)=>{const [viewport,size]=groups[(i+round)%4];return{id:`${viewport}-${size}-${String(round+1).padStart(2,'0')}`,round,viewport,size};})).flat();
await writeFile(path.join(output,'plan.json'),JSON.stringify({version:'S3D-UI-48-v1',plan,seed:'deterministic-rotation-0',durability:'default',operation:'rename seed-0',freshContextPerSample:true,fixtures:Object.fromEntries(Object.entries(fixtures).map(([k,f])=>[k,{positions:f.envelope.positions.length,witness:f.metadata.commits.length,envelopeBytes:Buffer.byteLength(JSON.stringify(f.envelope)),sha256:createHash('sha256').update(JSON.stringify(f)).digest('hex')}])),timing:{T0:'trusted click event.timeStamp',T1:'aria-busy true setAttribute returns',T2:'first rAF opportunity after T1',T3:'original Repository completion observer',T4:'mutation observer confirms completed notice and idle DOM',T5:'rAF opportunity after T4',cpu:'Performance threadTicks metrics delta; external window brackets click through T5, not an exact UI-only CPU attribution',input:'native F8 handlerStart - event.timeStamp; Event Timing processingStart - startTime separately',trace:'same queried low-volume categories if available, otherwise CPU metrics/spans only; no CPU sampling or transaction await/timer'},formalSLO:'NOT_CERTIFIED'},null,2));
const samples=[];
function instrumentAdapter(source){
 const start='export function validateCustomPositionIDBState(rawEnvelope, rawMetadata) {';
 assert.ok(source.includes(start));source=source.replace(start,start+'\n const __auditStart=performance.now();globalThis.__s3d?.validationBegin(__auditStart);try {');
 const end='validatedStates.add(state); return state;\n}';assert.ok(source.replace(/\r\n/g,'\n').includes(end));source=source.replace(/validatedStates\.add\(state\); return state;\r?\n\}/,'validatedStates.add(state); return state;\n } finally {globalThis.__s3d?.span("validateState",__auditStart,performance.now());}\n}');
 const loop='for (let i = 0; i < metadata.commits.length; i++) {';
 assert.ok(source.includes(loop));source=source.replace(loop,'const __replayStart=performance.now();'+loop).replace('if (exact(replay) !== exact(envelope)) fail(\'WITNESS_DATA_MISMATCH\');','globalThis.__s3d?.span("witnessReplay",__replayStart,performance.now());\n  if (exact(replay) !== exact(envelope)) fail(\'WITNESS_DATA_MISMATCH\');');
 return source;
}
const metrics=response=>Object.fromEntries(response.metrics.map(x=>[x.name,x.value]));
try{
 const cdpBrowser=await browser.newBrowserCDPSession();const available=(await cdpBrowser.send('Tracing.getCategories')).categories;
 const categories=['toplevel','devtools.timeline','blink.user_timing','v8'].filter(x=>available.includes(x));const traceAvailable=categories.includes('devtools.timeline')&&categories.includes('blink.user_timing');
 await writeFile(path.join(output,'environment.json'),JSON.stringify({chrome:browser.version(),url,sourceRoot:root,profile:'isolated temporary Chrome + a fresh off-the-record context per sample',browserPlugin:'Browser skill unavailable; explicit Chrome/Playwright authorization',availableCategories:available,categories,traceAvailable},null,2));
 for(const item of plan){
  const context=await browser.newContext({viewport:item.viewport==='desktop'?{width:1440,height:1000}:{width:390,height:844}}),p=await context.newPage(),cdp=await context.newCDPSession(p),errors=[];
  p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  let sample={...item,status:'PENDING'},traceActive=false,traceEvents=[],traceComplete,buffer=[];
  const onTrace=e=>traceEvents.push(...e.value),onBuffer=e=>buffer.push(e);
  try{
   await context.addInitScript(()=>{
    const q=window.__s3d={active:false,times:{},spans:[],longTasks:[],eventTiming:[],inputs:[],native:[],result:null,probeSent:false,unhandled:[],supported:PerformanceObserver.supportedEntryTypes};
    q.span=(name,start,end)=>{if(q.active)q.spans.push({name,start,end,duration:end-start});};
    q.validationBegin=at=>{if(q.active&&!q.probeSent){q.probeSent=true;q.probeAt=at;window.s3dTrace?.(JSON.stringify({type:'probe',at}));}};
    const mark=(key,at=performance.now())=>{if(q.times[key]!==undefined)return;q.times[key]=at;performance.mark('S3D:'+key);if(key==='T5'){q.active=false;window.s3dTrace?.(JSON.stringify({type:'finished',at}));}};
    document.addEventListener('click',e=>{if(e.target.closest('#savedPositionSubmit')&&q.armed){q.armed=false;q.active=true;q.clickTrusted=e.isTrusted;q.handlerStart=performance.now();mark('T0',e.timeStamp);}},true);
    document.addEventListener('keydown',e=>{if(e.code==='F8'){q.inputs.push({eventTimestamp:e.timeStamp,handlerStart:performance.now(),delay:performance.now()-e.timeStamp,trusted:e.isTrusted});e.preventDefault();}},true);
    window.addEventListener('unhandledrejection',e=>q.unhandled.push(String(e.reason)));
    const set=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){const result=set.call(this,name,value);if(q.active&&this.id==='savedPositionsDialog'&&name==='aria-busy'&&value==='true'){mark('T1');requestAnimationFrame(()=>mark('T2'));}return result;};
    new MutationObserver(()=>{if(q.active&&q.times.T1!==undefined&&document.getElementById('savedPositionsDialog')?.getAttribute('aria-busy')==='false'&&document.getElementById('savedPositionsNotice')?.textContent==='已完成更新。'){mark('T4');requestAnimationFrame(()=>mark('T5'));}}).observe(document,{subtree:true,attributes:true,childList:true,characterData:true});
    if(q.supported.includes('longtask'))new PerformanceObserver(list=>q.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
    if(q.supported.includes('event'))new PerformanceObserver(list=>q.eventTiming.push(...list.getEntries().map(e=>({name:e.name,start:e.startTime,processingStart:e.processingStart,processingEnd:e.processingEnd,duration:e.duration,interactionId:e.interactionId,inputDelay:e.processingStart-e.startTime})))).observe({type:'event',durationThreshold:16});
    const transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args),record={start:performance.now(),mode:args[1],puts:0,terminal:null},store=tx.objectStore.bind(tx);if(q.active)q.native.push(record);tx.objectStore=name=>{const s=store(name),put=s.put.bind(s);s.put=(...args)=>{record.puts++;return put(...args);};return s;};tx.addEventListener('complete',e=>{record.terminal='COMPLETE';record.complete=performance.now();record.trusted=e.isTrusted;});tx.addEventListener('abort',()=>record.terminal='ABORT');return tx;};
    window.__s3dRepository=real=>({...real,createScope(options){const s=real.createScope(options);return{...s,renamePosition(...args){const start=performance.now(),handle=s.renamePosition(...args);q.span('synchronousPrepare',start,performance.now());q.apiStart=start;handle.completion.then(r=>{if(q.active){q.result={status:r.status,nativeEvent:r.nativeEvent,revision:r.revision,operationId:r.identity.operationId,instance:r.identity.storageInstanceId};mark('T3');}});return handle;}};}});
   });
   await context.route(/custom-position-repository\.js(?:\?.*)?$/,async route=>{const response=await route.fetch(),source=await response.text();await route.fulfill({response,body:source.replace('export function createCustomPositionRepository','function originalRepository')+'\nexport function createCustomPositionRepository(options){return globalThis.__s3dRepository(originalRepository(options));}'});});
   await context.route(/custom-position-idb\.js(?:\?.*)?$/,async route=>{const response=await route.fetch();await route.fulfill({response,body:instrumentAdapter(await response.text())});});
   await p.goto(url);await p.waitForFunction(()=>!!window.__chess);assert.match(await p.title(),/中國象棋/);
   const f=fixtures[item.size];await p.evaluate(async f=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('chinese-chess-training:custom-positions',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put(f.envelope,'envelope');tx.objectStore('state').put(f.metadata,'metadata');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.commit();});db.close();},f);
   if(!await p.locator('#btnSavedPositions').isVisible())await p.locator('#btnMore').click();await p.locator('#btnSavedPositions').click();await p.waitForFunction(()=>document.getElementById('savedPositionsDialog').getAttribute('aria-busy')==='false');
   await p.locator('[data-position-id="seed-0"] [data-action="rename"]').click();const title='基準 '+item.id;await p.locator('#savedPositionTitle').fill(title);
   await cdp.send('Runtime.enable');await cdp.send('Runtime.addBinding',{name:'s3dTrace'});await cdp.send('Performance.enable',{timeDomain:'threadTicks'});
   let finish;const finished=new Promise(resolve=>finish=resolve);let probe;
   cdp.on('Runtime.bindingCalled',e=>{if(e.name!=='s3dTrace')return;const event=JSON.parse(e.payload);if(event.type==='finished')finish(event);if(event.type==='probe'){const sent=performance.now();probe={externalSent:sent,pageProbeAt:event.at};void cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'F8',code:'F8',windowsVirtualKeyCode:119}).then(()=>{probe.externalAcknowledged=performance.now();return cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'F8',code:'F8',windowsVirtualKeyCode:119});});}});
   cdpBrowser.on('Tracing.dataCollected',onTrace);cdpBrowser.on('Tracing.bufferUsage',onBuffer);const tracingDone=new Promise(resolve=>cdpBrowser.once('Tracing.tracingComplete',resolve));
   if(traceAvailable){await cdpBrowser.send('Tracing.start',{categories:categories.join(','),options:'record-until-full',transferMode:'ReportEvents',bufferUsageReportingInterval:250});traceActive=true;}
   await p.evaluate(()=>{__s3d.armed=true;});const cpuStart=performance.now(),before=metrics(await cdp.send('Performance.getMetrics')),externalStart=performance.now();
   await p.locator('#savedPositionSubmit').click();
   let deadline;await Promise.race([finished,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('INCOMPLETE: no completed UI state within 20s; transaction outcome is not inferred')),20000))]).finally(()=>clearTimeout(deadline));
   const externalFinish=performance.now(),after=metrics(await cdp.send('Performance.getMetrics')),cpuEnd=performance.now();
   if(traceAvailable){await cdpBrowser.send('Tracing.end');traceComplete=await tracingDone;traceActive=false;assert.equal(traceComplete.dataLossOccurred,false);}else{traceComplete={status:'UNAVAILABLE',reason:'Chrome returned no required trace categories; no trace attribution claimed'};}
   // One rendering turn drains observation delivery, outside the measured T5.
   await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>r())));
   const q=await p.evaluate(()=>__s3d);assert.ok(q.clickTrusted);for(const k of ['T0','T1','T2','T3','T4','T5'])assert.ok(Number.isFinite(q.times[k]),k);assert.equal(q.result.status,'SUCCESS');assert.equal(q.result.nativeEvent,'COMPLETE');assert.equal(q.result.revision,f.envelope.revision+1);assert.equal(q.native.filter(x=>x.puts>0).length,1);assert.ok(q.native.every(x=>x.terminal==='COMPLETE'));assert.equal(q.inputs.length,1);assert.ok(q.inputs[0].trusted);assert.deepEqual(q.unhandled,[]);assert.deepEqual(errors,[]);
   const final=await p.evaluate(async()=>{const{createCustomPositionIDB}=await import('./custom-position-idb.js');const a=createCustomPositionIDB({initializeEmpty:false});try{return await a.read();}finally{a.dispose();}});
   assert.ok(final.ok);assert.equal(final.snapshot.envelope.positions.length,f.envelope.positions.length);assert.equal(final.snapshot.envelope.positions[0].title,title);assert.equal(final.snapshot.envelope.revision,f.envelope.revision+1);assert.equal(final.snapshot.metadata.storageInstanceId,f.metadata.storageInstanceId);assert.equal(final.snapshot.metadata.committedOperationIds.filter(id=>id===q.result.operationId).length,1);assert.equal(final.snapshot.metadata.commits.length,Math.min(128,f.metadata.commits.length+1));assert.deepEqual(final.snapshot.envelope.positions.slice(1),f.envelope.positions.slice(1));
   const t=q.times;sample={...sample,status:'PASS',chrome:browser.version(),envelopeBytes:Buffer.byteLength(JSON.stringify(f.envelope)),beforeRevision:f.envelope.revision,times:t,uiWallMs:t.T5-t.T0,busyDOMMs:t.T1-t.T0,busyRafMs:t.T2-t.T0,apiMs:t.T3-q.apiStart,resultDOMMs:t.T4-t.T0,resultRafMs:t.T5-t.T0,externalMs:externalFinish-externalStart,cpuObservation:{externalWallMs:cpuEnd-cpuStart,metricsBefore:before,metricsAfter:after,delta:Object.fromEntries(Object.keys(after).filter(k=>/Duration|ThreadTime|ProcessTime/.test(k)&&before[k]!==undefined).map(k=>[k,after[k]-before[k]]))},longTasks:q.longTasks.filter(x=>x.start<t.T5&&x.start+x.duration>t.T0),eventTiming:q.eventTiming.filter(x=>x.start>=t.T0&&x.start<=t.T5),inputs:q.inputs,probe,spans:q.spans,native:q.native,result:q.result,traceIntegrity:traceComplete,traceBuffer:buffer,errors,unhandled:q.unhandled};
   await writeFile(path.join(output,item.id+'-state.json'),JSON.stringify(final.snapshot));
   if(item.round===0)await p.screenshot({path:path.join(output,item.viewport+'-'+item.size+'.png'),fullPage:true});
  }catch(e){sample={...sample,status:'FAIL',error:e.stack,errors};throw e;}
  finally{
   if(traceActive)await cdpBrowser.send('Tracing.end').catch(()=>{});
   cdpBrowser.removeAllListeners('Tracing.tracingComplete');cdpBrowser.off('Tracing.dataCollected',onTrace);cdpBrowser.off('Tracing.bufferUsage',onBuffer);
   await writeFile(path.join(output,item.id+'-trace.json'),JSON.stringify({traceEvents,traceComplete,buffer}));
   await writeFile(path.join(output,item.id+'.json'),JSON.stringify(sample,null,2));samples.push(sample);await writeFile(path.join(output,'samples.json'),JSON.stringify(samples,null,2));await context.close();console.log(JSON.stringify({id:item.id,status:sample.status,uiWallMs:sample.uiWallMs,longestTask:sample.longTasks?.reduce((v,x)=>Math.max(v,x.duration),0),inputDelay:sample.inputs?.[0].delay}));
  }
 }
 assert.equal(samples.length,48);
 const quantile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1];
 const stats=a=>({N:a.length,P50:quantile(a,.5),P95:quantile(a,.95),exploratoryP99:quantile(a,.99),max:Math.max(...a)});
 const summary=Object.fromEntries(groups.map(([v,s])=>{const a=samples.filter(x=>x.viewport===v&&x.size===s);assert.equal(a.length,12);return[v+'-'+s,{UI:stats(a.map(x=>x.uiWallMs)),API:stats(a.map(x=>x.apiMs)),inputDelay:stats(a.map(x=>x.inputs[0].delay)),longTask:stats(a.map(x=>Math.max(0,...x.longTasks.map(t=>t.duration))))}];}));
 await writeFile(path.join(output,'summary.json'),JSON.stringify({result:'BASELINE_COMPLETED',samples:48,summary,formalSLO:'NOT_CERTIFIED',percentile:'nearest-rank; N=12/group cannot certify P99'},null,2));
 const columns=['id','viewport','size','status','envelopeBytes','beforeRevision','busyDOMMs','busyRafMs','apiMs','resultDOMMs','resultRafMs','uiWallMs','externalMs'];await writeFile(path.join(output,'samples.csv'),columns.join(',')+'\n'+samples.map(x=>columns.map(k=>x[k]).join(',')).join('\n')+'\n');
}finally{await browser.close();server.close();}
