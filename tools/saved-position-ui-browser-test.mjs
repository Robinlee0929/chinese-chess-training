// localhost + isolated Chrome only. PLAYWRIGHT_MODULE may point to an existing
// installation; no dependencies, profiles or user data are added to the repo.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { capacityFixture } from './idb-capacity-fixture.mjs';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.env.UI_EVIDENCE_DIR || 'test-results/saved-position-ui');
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
  try{const body=await readFile(file);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'})[path.extname(file)]||'text/plain');res.end(body);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port+'/';
// Playwright normally disables background throttling/freezing; use Chrome's
// native lifecycle for this suite instead of overriding those browser policies.
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,ignoreDefaultArgs:true,args:['--headless=new','--remote-debugging-pipe','--no-first-run','--no-default-browser-check']});
const results=[],timings=[];
const selected=id=>!process.env.UI_CASE_FILTER||new RegExp(process.env.UI_CASE_FILTER).test(id);
await writeFile(path.join(output,'environment.json'),JSON.stringify({chrome:browser.version(),url,root,profile:'isolated Playwright browser contexts; synthetic data only',browserPath:'Browser plugin/browser skill unavailable; explicit Chrome/Playwright testing authorized'},null,2));
async function context(viewport={width:1440,height:1000}){
 const c=await browser.newContext({viewport});
 await c.addInitScript(()=>{
  window.__uiQA={calls:[],actions:[],native:[],longTasks:[],hold:null,release:[],suppressComplete:false,posts:[],holdAI:false,aiReplies:[]};
  const qa=window.__uiQA;
  document.addEventListener('mousemove',event=>window.uiInputTrace?.(JSON.stringify({type:'input',at:performance.now(),trusted:event.isTrusted})),true);
  qa.lifecycle=[];for(const[target,type]of[[document,'freeze'],[document,'resume'],[window,'pagehide'],[window,'pageshow']])target.addEventListener(type,e=>{const event={type,trusted:e.isTrusted,persisted:e.persisted??null,at:performance.now()};qa.lifecycle.push(event);window.uiLifeTrace?.(JSON.stringify(event));},true);
  const WorkerClass=window.Worker;
  window.Worker=class extends WorkerClass{constructor(...args){super(...args);let callback;Object.defineProperty(this,'onmessage',{get:()=>callback,set:fn=>{callback=fn;}});this.addEventListener('message',event=>{if(qa.holdAI)qa.aiReplies.push(()=>callback?.(event));else callback?.(event);});}postMessage(payload){if(payload.kind==='normal-game')qa.posts.push(structuredClone(payload));return super.postMessage(payload);}};
  new PerformanceObserver(list=>qa.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
  document.addEventListener('click',e=>{const b=e.target.closest('button');if(b&&b.id.startsWith('saved'))qa.actions.push({id:b.id,start:performance.now(),busyDOM:null,busyPaint:null,resultPaint:null});},true);
  new MutationObserver(()=>{const d=document.getElementById('savedPositionsDialog'),a=qa.actions.at(-1);if(!d||!a)return;
   if(d.getAttribute('aria-busy')==='true'&&a.busyDOM===null){a.busyDOM=performance.now();requestAnimationFrame(()=>{a.busyPaint=performance.now();});}
   if((d.getAttribute('aria-busy')==='false'||!d.open)&&a.busyDOM!==null&&a.resultPaint===null)requestAnimationFrame(()=>{a.resultPaint=performance.now();});
  }).observe(document,{subtree:true,attributes:true,attributeFilter:['aria-busy','open']});
  window.__wrapRepository=real=>({...real,createScope(options){const scope=real.createScope(options),map=new WeakMap();return new Proxy({...scope},{get(target,key){
   if(key==='canApply')return(h,r)=>scope.canApply(map.get(h)||h,r);
   if(!['loadAll','getPosition','savePosition','renamePosition','updatePlayPreferences','deletePosition','inspectMigration','initialize','confirmMigration'].includes(key))return target[key];
   return(...args)=>{const record={method:key,start:performance.now(),apiComplete:null};qa.calls.push(record);
    const handle=scope[key](...args);record.identity=handle.identity;
    const wrapped={...handle,verify:async()=>{const result=await handle.verify();if(qa.hold==='verify'){qa.held={method:'verify',result};await new Promise(resolve=>qa.release.push(resolve));}return result;},completion:handle.completion.then(async result=>{record.apiComplete=performance.now();record.status=result.status;record.native=result.nativeEvent;
     if(qa.hold===key){qa.held={method:key,result};await new Promise(resolve=>qa.release.push(resolve));}
     return result;})};map.set(wrapped,handle);return wrapped;
   };
  }});}});
  const transaction=IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args),store=tx.objectStore.bind(tx);let puts=0,callback=null;
   Object.defineProperty(tx,'oncomplete',{get:()=>callback,set:fn=>{callback=fn;}});
   tx.addEventListener('complete',e=>{qa.native.push({event:'COMPLETE',trusted:e.isTrusted,puts,at:performance.now()});if(!(qa.suppressComplete&&puts))callback?.call(tx,e);});
   tx.addEventListener('abort',e=>qa.native.push({event:'ABORT',trusted:e.isTrusted,puts,at:performance.now()}));
   tx.objectStore=name=>{const s=store(name),put=s.put.bind(s),get=s.get.bind(s);s.put=(...v)=>{puts++;return put(...v);};s.get=(...v)=>{const r=get(...v);r.addEventListener('success',()=>window.uiInputTrace?.(JSON.stringify({type:'read',at:performance.now()})),{once:true});return r;};return s;};return tx;};
 });
 // Test-only wrapper delays delivery AFTER the real repository API, never an IDB callback.
 await c.route(/custom-position-repository\.js(?:\?.*)?$/,async route=>{
  const r=await route.fetch(),body=await r.text();await route.fulfill({response:r,body:body.replace('export function createCustomPositionRepository','function originalRepository')+'\nexport function createCustomPositionRepository(options){const real=originalRepository(options);return globalThis.__wrapRepository?.(real)??real;}\n'});
 });
 return c;
}
async function page(c){const p=await c.newPage();p.setDefaultTimeout(20000);p.errors=[];p.on('pageerror',e=>p.errors.push(e.message));p.on('console',m=>{if(m.type()==='error')p.errors.push(m.text());});await p.goto(url);await p.waitForFunction(()=>window.__chess?.board?.length===10);assert.match(await p.title(),/中國象棋/);return p;}
async function open(p){if(!await p.locator('#btnSavedPositions').isVisible())await p.locator('#btnMore').click();await p.locator('#btnSavedPositions').click();await p.locator('#savedPositionsDialog').waitFor({state:'visible'});await idle(p);}
const idle=p=>p.waitForFunction(()=>{const d=document.getElementById('savedPositionsDialog');return !d.open||d.getAttribute('aria-busy')==='false';});
const storageState=p=>p.locator('#savedPositionsDialog').getAttribute('data-storage-state');
async function seed(p,{legacy=false,staged=false,side='red'}={}){
 return p.evaluate(async({legacy,staged,side})=>{
  const {initialBoard}=await import('./game.js');const position={id:'fixture',title:'測試局面',initialBoard:initialBoard(),sideToMove:side,createdAt:'2026-11-04T00:00:00.000Z',updatedAt:'2026-11-04T00:00:00.000Z',playPreferences:{humanSide:'red',difficulty:'easy'}};
  if(legacy||staged){const raw=JSON.stringify({version:1,revision:7,positions:[position]});localStorage.setItem('chinese-chess-training:custom-positions:v1',raw);
   if(staged){const {createCustomPositionMigration}=await import('./custom-position-migration.js');const m=createCustomPositionMigration(),v=await m.inspect();m.dispose();const{createCustomPositionIDB}=await import('./custom-position-idb.js');const a=createCustomPositionIDB({initializeEmpty:false});const t=a.prepareMigration(null,{type:'stage',migrationId:v.plan.migrationId,sourceFingerprint:v.plan.sourceFingerprint,envelope:v.plan.envelope},{storageInstanceId:v.plan.storageInstanceId});const r=await a.write(t);a.dispose();if(r.status!=='COMMITTED')throw Error(r.code);}
   return{raw,id:position.id};
  }
  const {createCustomPositionRepository}=await import('./custom-position-repository.js');const repo=createCustomPositionRepository(),s=repo.createScope();await s.initialize().completion;const loaded=await s.loadAll().completion;
  const {id,createdAt,updatedAt,...input}=position;const saved=await s.savePosition(input,{snapshot:loaded.snapshot,storageInstanceId:loaded.snapshot.metadata.storageInstanceId,expectedRevision:loaded.snapshot.envelope.revision}).completion;
  repo.dispose();if(saved.status!=='SUCCESS')throw Error(saved.code);return{id:saved.position.id};
 },{legacy,staged,side});
}
async function read(p){return p.evaluate(async()=>{const{createCustomPositionIDB}=await import('./custom-position-idb.js');const a=createCustomPositionIDB({initializeEmpty:false});try{return await a.read();}finally{a.dispose();}});}
async function action(p,id,kind){await p.locator(`[data-position-id="${id}"] [data-action="${kind}"]`).click();}
async function submit(p){await p.locator('#savedPositionSubmit').click();await idle(p);}
async function test(id,fn){if(!selected(id))return;const c=await context();let p;try{p=await page(c);await fn(p,c);assert.deepEqual(p.errors,[]);results.push({id,status:'PASS'});console.log(id+' PASS');}
 catch(e){results.push({id,status:'FAIL',error:e.message});if(p)await p.screenshot({path:path.join(output,id+'-FAIL.png'),fullPage:true});throw e;}
 finally{if(p){const qa=await p.evaluate(()=>__uiQA).catch(()=>null);await writeFile(path.join(output,id+'.json'),JSON.stringify({result:results.at(-1),qa,errors:p.errors},null,2));if(qa)timings.push({id,actions:qa.actions,calls:qa.calls,longTasks:qa.longTasks});}await c.close();await writeFile(path.join(output,'summary.json'),JSON.stringify(results,null,2));}}
try{
 await test('first-initialization',async p=>{assert.equal((await read(p)).snapshot,null);await open(p);assert.equal(await storageState(p),'ACTIVE');assert.equal((await read(p)).snapshot.envelope.positions.length,0);assert.equal(await p.locator('#savedPositionsEmpty').isVisible(),true);await p.keyboard.press('Escape');assert.equal(await p.locator('#savedPositionsDialog').isVisible(),false);});
 for(const staged of [false,true])await test(staged?'staged-recovery':'legacy-confirmation',async p=>{
  const f=await seed(p,{legacy:true,staged});await open(p);assert.equal(await storageState(p),staged?'STAGED':'MIGRATION_REQUIRED');assert.equal(await p.locator('#savedPositionMigrate').isDisabled(),true);
  await p.keyboard.press('Escape');assert.equal((await read(p)).snapshot?.metadata.migration.state??null,staged?'STAGED':null);
  await open(p);await p.locator('#savedPositionMigrationConfirm').check();await p.locator('#savedPositionMigrate').click();await idle(p);assert.equal(await storageState(p),'ACTIVE');
  const state=(await read(p)).snapshot;assert.equal(state.metadata.migration.state,'ACTIVE');assert.equal(state.envelope.positions[0].id,f.id);assert.equal(await p.evaluate(()=>localStorage.getItem('chinese-chess-training:custom-positions:v1')),f.raw);
 });
 await test('active-legacy-conflict',async p=>{await seed(p);await p.evaluate(()=>localStorage.setItem('chinese-chess-training:custom-positions:v1','broken'));await open(p);assert.equal(await storageState(p),'CONFLICT');assert.equal(await p.locator('#savedPositionsList li').count(),1);assert.equal(await p.locator('#savedPositionsList button:enabled').count(),0);assert.equal((await read(p)).snapshot.envelope.revision,1);await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>__chess.appState),'NORMAL_GAME');});
 for(const [label,raw]of [['corrupt','{bad'],['unsupported','{"version":99,"revision":0,"positions":[]}']])await test(label,async p=>{await p.evaluate(raw=>localStorage.setItem('chinese-chess-training:custom-positions:v1',raw),raw);await open(p);assert.equal(await storageState(p),label==='corrupt'?'CORRUPT':'UNSUPPORTED');assert.equal((await read(p)).snapshot,null);assert.equal(await p.evaluate(()=>localStorage.getItem('chinese-chess-training:custom-positions:v1')),raw);});
 await test('unavailable',async p=>{await p.evaluate(()=>Object.defineProperty(window,'indexedDB',{get(){throw new DOMException('denied','SecurityError');},configurable:true}));await open(p);assert.equal(await storageState(p),'UNAVAILABLE');assert.equal(await p.locator('#savedPositionsEmpty').isVisible(),false);await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>__chess.appState),'NORMAL_GAME');});
 await test('CRUD-conflict-noop-IME',async(p,c)=>{
  const f=await seed(p);await open(p);await action(p,f.id,'rename');
  const title=p.locator('#savedPositionTitle');await title.fill('');await title.focus();const ime=await c.newCDPSession(p);await ime.send('Input.imeSetComposition',{text:'保留中文輸入',selectionStart:6,selectionEnd:6});await p.locator('#savedPositionForm').dispatchEvent('submit');assert.equal((await read(p)).snapshot.envelope.revision,1);await ime.send('Input.insertText',{text:'保留中文輸入'});await ime.detach();assert.equal(await title.inputValue(),'保留中文輸入');
  const peer=await page(c);await peer.evaluate(async id=>{const{createCustomPositionRepository}=await import('./custom-position-repository.js');const r=createCustomPositionRepository(),s=r.createScope(),v=await s.loadAll().completion;await s.renamePosition(id,'另一分頁',{snapshot:v.snapshot,storageInstanceId:v.snapshot.metadata.storageInstanceId,expectedRevision:v.snapshot.envelope.revision}).completion;r.dispose();},f.id);
  await submit(p);assert.match(await p.locator('#savedPositionError').innerText(),/其他分頁/);assert.equal(await title.inputValue(),'保留中文輸入');await p.locator('#savedPositionsReload').click();await idle(p);await submit(p);
  assert.equal((await read(p)).snapshot.envelope.positions[0].title,'保留中文輸入');
  await action(p,f.id,'preferences');await p.locator('#savedPositionDifficulty').selectOption('hard');const session=await p.evaluate(()=>__chess.normalGameRecordSession?.id);await submit(p);assert.equal(await p.evaluate(()=>__chess.normalGameRecordSession?.id),session);
  const before=(await read(p)).snapshot.envelope.revision;await action(p,f.id,'rename');await submit(p);assert.equal((await read(p)).snapshot.envelope.revision,before+1);
  await action(p,f.id,'load');await submit(p);await p.locator('#savedPositionsDialog').waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>__chess.appState),'PUZZLE_EDITOR');
  await p.locator('#btnEditorConfirm').click();await p.locator('#btnSaveCustomPosition').click();await idle(p);await p.locator('#savedPositionTitle').fill('不覆寫');await submit(p);assert.match(await p.locator('#savedPositionsNotice').innerText(),/已存在/);
  await action(p,f.id,'delete');await submit(p);assert.equal((await read(p)).snapshot.envelope.positions.length,0);
  await p.keyboard.press('Escape');await p.locator('#btnSaveCustomPosition').click();await idle(p);await p.locator('#savedPositionTitle').fill('新儲存');await submit(p);assert.equal((await read(p)).snapshot.envelope.positions.length,1);
 });
 await test('cancel-late-preferences-no-game',async p=>{const f=await seed(p);await open(p);await action(p,f.id,'challenge');await p.locator('#savedPositionDifficulty').selectOption('hard');if(await p.locator('#savedPositionAcknowledgement').isVisible())await p.locator('#savedPositionAcknowledge').check();const before=await p.evaluate(()=>__chess.normalGameRecordSession?.id);
  await p.evaluate(()=>__uiQA.hold='updatePlayPreferences');await p.locator('#savedPositionSubmit').click();await p.waitForFunction(()=>__uiQA.held?.method==='updatePlayPreferences');await p.screenshot({path:path.join(output,'busy-awaiting-UI-delivery.png'),fullPage:true});await p.keyboard.press('Escape');await p.evaluate(()=>{__uiQA.hold=null;__uiQA.release.splice(0).forEach(r=>r());});
  assert.equal(await p.evaluate(()=>__chess.normalGameRecordSession?.id),before);assert.equal((await read(p)).snapshot.envelope.positions[0].playPreferences.difficulty,'hard');await open(p);assert.equal(await p.locator('#savedPositionVerify').isVisible(),true);await p.locator('#savedPositionVerify').click();await idle(p);assert.match(await p.locator('#savedPositionsNotice').innerText(),/已提交/);
 });
 await test('unknown-native-complete-independent-verification',async p=>{const f=await seed(p);await open(p);await action(p,f.id,'rename');await p.locator('#savedPositionTitle').fill('提交待查');await p.evaluate(()=>{__uiQA.native=[];__uiQA.suppressComplete=true;});await p.locator('#savedPositionSubmit').click();await p.waitForFunction(()=>__uiQA.native.some(e=>e.puts>0&&e.event==='COMPLETE'));
  await p.keyboard.press('Escape');await p.evaluate(()=>{__uiQA.suppressComplete=false;});await open(p);assert.equal(await p.locator('#savedPositionVerify').isVisible(),true);await p.locator('#savedPositionVerify').click();await idle(p);assert.match(await p.locator('#savedPositionsNotice').innerText(),/已提交/);assert.equal((await read(p)).snapshot.envelope.positions[0].title,'提交待查');
 });
 await test('cancel-UNKNOWN-verification-late-result',async p=>{const f=await seed(p);await open(p);await action(p,f.id,'rename');await p.locator('#savedPositionTitle').fill('查證取消');await p.evaluate(()=>{__uiQA.native=[];__uiQA.suppressComplete=true;});await p.locator('#savedPositionSubmit').click();await p.waitForFunction(()=>__uiQA.native.some(e=>e.puts>0&&e.event==='COMPLETE'));
  await p.keyboard.press('Escape');await p.evaluate(()=>{__uiQA.suppressComplete=false;});await open(p);await p.evaluate(()=>__uiQA.hold='verify');await p.locator('#savedPositionVerify').click();await p.waitForFunction(()=>__uiQA.held?.method==='verify');await p.keyboard.press('Escape');
  await open(p);await action(p,f.id,'rename');await p.locator('#savedPositionTitle').fill('新的對話框輸入');await p.evaluate(()=>{__uiQA.hold=null;__uiQA.release.splice(0).forEach(r=>r());});assert.equal(await p.locator('#savedPositionTitle').inputValue(),'新的對話框輸入');assert.doesNotMatch(await p.locator('#savedPositionsNotice').innerText(),/已查證/);
 });
 for(const boundary of ['getPosition','savePosition','confirmMigration'])await test('cancel-await-'+boundary,async p=>{
  const f=await seed(p,{legacy:boundary==='confirmMigration'});await open(p);
  if(boundary==='confirmMigration')await p.locator('#savedPositionMigrationConfirm').check();
  else if(boundary==='getPosition'){await action(p,f.id,'challenge');if(await p.locator('#savedPositionAcknowledgement').isVisible())await p.locator('#savedPositionAcknowledge').check();}
  else{await action(p,f.id,'load');await submit(p);await p.locator('#btnEditorConfirm').click();await p.locator('#btnSaveCustomPosition').click();await idle(p);await p.locator('#savedPositionTitle').fill('取消儲存');}
  const before=await p.evaluate(()=>__chess.normalGameRecordSession?.id);await p.evaluate(method=>__uiQA.hold=method,boundary);
  await p.locator(boundary==='confirmMigration'?'#savedPositionMigrate':'#savedPositionSubmit').click();await p.waitForFunction(()=>!!__uiQA.held);await p.keyboard.press('Escape');
  await p.evaluate(()=>{__uiQA.hold=null;__uiQA.release.splice(0).forEach(r=>r());});assert.equal(await p.evaluate(()=>__chess.normalGameRecordSession?.id),before);assert.equal(await p.locator('#savedPositionsDialog').isVisible(),false);
 });
 for(const side of ['red','black'])for(const human of ['red','black'])for(const difficulty of ['easy','medium','hard'])await test(`challenge-${side}-${human}-${difficulty}`,async p=>{
  const f=await seed(p,{side});await open(p);await action(p,f.id,'challenge');await p.locator('#savedPositionHumanSide').selectOption(human);await p.locator('#savedPositionDifficulty').selectOption(difficulty);if(await p.locator('#savedPositionAcknowledgement').isVisible())await p.locator('#savedPositionAcknowledge').check();
  const original=(await read(p)).snapshot.envelope.positions[0].initialBoard;await p.evaluate(()=>{__uiQA.posts=[];__uiQA.holdAI=true;});await p.locator('#savedPositionOnce').click();await p.locator('#savedPositionsDialog').waitFor({state:'hidden'});
  const state=await p.evaluate(()=>({turn:__chess.turn,human:__chess.humanSide,mode:__chess.mode,history:__chess.history,session:__chess.normalGameRecordSession,board:__chess.board,posts:__uiQA.posts.length}));
  assert.equal(state.turn,side);assert.equal(state.human,human);assert.equal(state.mode,difficulty);assert.equal(state.history.length,0);assert.equal(state.posts,side===human?0:1);assert.deepEqual(state.board,original);
  await p.evaluate(()=>__chess.newGame());assert.equal(await p.locator('#btnCustomRematch').isVisible(),false);
 });
 await test('native-double-click-one-challenge',async p=>{
  const f=await seed(p);await open(p);await action(p,f.id,'challenge');if(await p.locator('#savedPositionAcknowledgement').isVisible())await p.locator('#savedPositionAcknowledge').check();
  const before=await p.evaluate(()=>__chess.normalGameRecordSession.id);await p.evaluate(()=>{__uiQA.calls=[];__uiQA.posts=[];});
  await p.locator('#savedPositionOnce').dblclick();await p.locator('#savedPositionsDialog').waitFor({state:'hidden'});
  assert.notEqual(await p.evaluate(()=>__chess.normalGameRecordSession.id),before);assert.equal(await p.evaluate(()=>__uiQA.calls.filter(c=>c.method==='getPosition').length),2);
  assert.equal(await p.evaluate(()=>__uiQA.posts.length),0);assert.equal((await read(p)).snapshot.envelope.revision,1);
 });
 await test('full-capacity-UI-latency',async p=>{
  await open(p);await p.keyboard.press('Escape');const fixture=capacityFixture(100),candidateJSON=JSON.stringify(fixture.metadata.baseEnvelope),sourceFingerprint=createHash('sha256').update(candidateJSON).digest('hex');
  fixture.metadata.migration={version:1,state:'ACTIVE',migrationId:'legacy-v1:'+sourceFingerprint,sourceFingerprint,sourceRevision:2,initialRevision:2,stagedOperationId:'33333333-3333-4333-8333-333333333333',activatedOperationId:'44444444-4444-4444-8444-444444444444',stagedAt:'2026-11-02T00:00:00.000Z',activatedAt:'2026-11-02T00:00:00.000Z',candidateJSON};
  await p.evaluate(async state=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('chinese-chess-training:custom-positions',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('state','readwrite');tx.objectStore('state').put(state.envelope,'envelope');tx.objectStore('state').put(state.metadata,'metadata');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.commit();});db.close();},fixture);
  await open(p);assert.equal(await p.locator('#savedPositionsList li').count(),100);
  const inputProbe=await p.context().newCDPSession(p),inputSamples=[];let pendingInput=null,armed=false;
  await inputProbe.send('Runtime.enable');await inputProbe.send('Runtime.addBinding',{name:'uiInputTrace'});
  inputProbe.on('Runtime.bindingCalled',e=>{if(e.name!=='uiInputTrace')return;const event=JSON.parse(e.payload);
   if(event.type==='read'&&armed){armed=false;pendingInput={readAt:event.at,externalSent:performance.now()};void inputProbe.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:10+inputSamples.length,y:10});}
   if(event.type==='input'&&pendingInput){inputSamples.push({...pendingInput,inputAt:event.at,latencyMs:event.at-pendingInput.readAt,trusted:event.trusted});pendingInput=null;}
  });
  for(let i=0;i<3;i++){await action(p,'seed-0','rename');await p.locator('#savedPositionTitle').fill('UI 計時 '+i);armed=true;await p.locator('#savedPositionSubmit').click();if(i===0)await p.screenshot({path:path.join(output,'full-capacity-result.png'),fullPage:true});await idle(p);}
  const final=(await read(p)).snapshot;assert.equal(final.envelope.revision,133);assert.equal(final.metadata.commits.length,128);assert.equal(final.envelope.positions.length,100);
  const measured=await p.evaluate(()=>__uiQA.actions.filter(a=>a.id==='savedPositionSubmit'));assert.equal(measured.length,3);assert.ok(measured.every(a=>a.busyPaint!==null&&a.resultPaint!==null));
  assert.equal(inputSamples.length,3);assert.ok(inputSamples.every(s=>s.trusted));await inputProbe.detach();
  await writeFile(path.join(output,'capacity-ui-timing.json'),JSON.stringify({envelopeBytes:Buffer.byteLength(JSON.stringify(fixture.envelope)),measured,inputSamples,paintClock:'rAF frame opportunity; not compositor presentation timestamp',formalSLO:'NOT_CERTIFIED'},null,2));
 });
 if(selected('UI-freeze-resume-and-BFCache')){
  const {testNativeUILifecycle}=await import('./saved-position-ui-lifecycle.mjs');
  const result=await testNativeUILifecycle(url);results.push({id:'UI-freeze-resume-and-BFCache',...result});console.log('native UI lifecycle PASS');
 }
 for(const width of [320,390,768,1440]){
  if(!selected('responsive-keyboard-'+width))continue;
  const c=await context({width,height:width===1440?1000:844}),p=await page(c);try{const f=await seed(p,{legacy:true});await open(p);await p.locator('#savedPositionMigrationConfirm').focus();await p.keyboard.press('Space');await p.locator('#savedPositionMigrate').focus();await p.keyboard.press('Enter');await idle(p);assert.equal(await storageState(p),'ACTIVE');
   await action(p,f.id,'rename');await p.locator('#savedPositionTitle').fill('手機中文局面');await submit(p);await action(p,f.id,'challenge');await p.locator('#savedPositionHumanSide').selectOption('black');await p.locator('#savedPositionDifficulty').selectOption('easy');
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);for(let i=0;i<12;i++){await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.getElementById('savedPositionsDialog').contains(document.activeElement)),true);}
   await p.screenshot({path:path.join(output,'ui-'+width+'.png'),fullPage:true});await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>document.activeElement.id),await p.locator('#btnSavedPositions').isVisible()?'btnSavedPositions':'btnMore');assert.deepEqual(p.errors,[]);results.push({id:'responsive-keyboard-'+width,status:'PASS'});console.log('responsive '+width+' PASS');
  }finally{await c.close();}
 }
 if(selected('uninstrumented-production-UI-smoke')){const c=await browser.newContext({viewport:{width:1440,height:1000}}),p=await page(c);try{
   const f=await seed(p);await open(p);await action(p,f.id,'rename');await p.locator('#savedPositionTitle').fill('未插樁正式入口');await submit(p);assert.equal((await read(p)).snapshot.envelope.positions[0].title,'未插樁正式入口');assert.deepEqual(p.errors,[]);results.push({id:'uninstrumented-production-UI-smoke',status:'PASS'});
  }finally{await c.close();}}
 await writeFile(path.join(output,'summary.json'),JSON.stringify(results,null,2));
}finally{await writeFile(path.join(output,'timings.json'),JSON.stringify(timings,null,2));await browser.close();server.close();}
