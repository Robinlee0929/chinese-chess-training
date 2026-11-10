// Real Chrome, isolated storage and controlled legacy resources. No production services.
// PLAYWRIGHT_MODULE=... EXPERIMENTAL_B_ACTIVATION_EVIDENCE_DIR=... node tools/experimental-opponent-activation-browser-test.mjs [built-site]
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const site=path.resolve(process.argv[2]||root),out=path.resolve(process.env.EXPERIMENTAL_B_ACTIVATION_EVIDENCE_DIR||'');
assert.ok(process.env.EXPERIMENTAL_B_ACTIVATION_EVIDENCE_DIR&&!out.startsWith(root+path.sep)&&out!==root);
await mkdir(out,{recursive:false});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const baseline='33f24e85e2aa8873145210c7da97bbc704ad2765',prefixed='8ccb4d935f2243ea9682b7cef15848d2dcd12bef';
const ids=['modeSel','customPlayDifficulty','gameReviewContinuationDifficulty','savedPositionDifficulty'];
const prefix='/chinese-chess-training/',cache=new Map();
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let scenario='new-new';
const old=(ref,file)=>{const key=ref+':'+file;if(!cache.has(key))cache.set(key,execFileSync('git',['show',key],{cwd:root}));return cache.get(key);};
const server=createServer(async(req,res)=>{
 try {
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(!pathname.startsWith(prefix)){res.writeHead(404);return res.end();}
  const rel=pathname.slice(prefix.length)||'index.html',target=path.resolve(site,rel);
  if(!target.startsWith(site+path.sep)){res.writeHead(403);return res.end();}
  let ref;
  if(scenario==='old-old'||(scenario==='old-new'&&rel==='index.html')||(scenario==='new-old'&&rel.endsWith('.js')))ref=baseline;
  if(scenario==='new-prefixed'&&rel.endsWith('.js'))ref=prefixed;
  if(scenario==='old-main-new-modules'&&rel==='main.js')ref=baseline;
  if(scenario==='new-old-worker'&&rel==='ai-worker.js')ref=baseline;
  let body=ref?old(ref,rel):await readFile(target);
  if(rel==='saved-position-async-session.js'&&scenario==='session-hold'){
   // Hold delivery AFTER a real IndexedDB operation completes, without faking
   // its persistence result or touching the on-disk product source.
   const marker='const result = await handle.completion;';assert.ok(body.toString().includes(marker));
   body=Buffer.from(body.toString().replace(marker,marker+'\nif (globalThis.sessionHoldRead && !write && --globalThis.sessionHoldRead === 0) { globalThis.sessionReadHeld = true; await new Promise(resolve => { globalThis.sessionReleaseRead = resolve; }); }'));
  }
  if(rel==='main.js'&&scenario==='session-corrupt'){
   const marker='experimentalOpponentReady = true;';assert.ok(body.toString().includes(marker));
   // Deliberately impossible through the guarded UI. Exercise the last storage
   // defense against a corrupt runtime; these hooks exist only in this response.
   body=Buffer.from(body.toString().replace(marker,'window.sessionFault = { setMode(value) { mode = value; modeSel.value = value; refreshHUD(); }, finalize() { return finalizeNormalGameRecord("將死"); } };\n'+marker));
  }
  if(rel==='main.js'&&scenario.startsWith('init-')){
   const text=body.toString(),marker='experimentalOpponentReady = true;';
   assert.ok(text.includes(marker));
   const injection=scenario==='init-delayed'?'await new Promise(resolve => { window.releaseBInitialization = resolve; });\n':'throw new Error("Injected initialization failure");\n';
   body=Buffer.from(text.replace(marker,injection+marker));
  }
  res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'})[path.extname(rel)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port+prefix;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const results=[],watchdog=setTimeout(()=>void browser.close(),12*60*1000);
const selectedCases=new Set((process.env.ACTIVATION_CASES||'').split(',').filter(Boolean));
const ready=p=>p.waitForFunction(()=>window.__chess?.pieces.length===32&&!__chess.busy);
const toolbar=async(p,id)=>{if(!await p.locator(id).isVisible())await p.locator('#btnMore').click();await p.locator(id).click();};
async function move(p,from={r:3,c:4},to={r:4,c:4}){
 await p.waitForFunction(()=>!__chess.busy&&__chess.pieces.every(m=>Math.abs(m.position.y-.18)<.00001));
 await p.waitForTimeout(1100);
 for(const s of [from,to]){
  const pt=await p.evaluate(s=>{const x=__chess,rect=x.renderer.domElement.getBoundingClientRect(),v=x.camera.position.clone().set(s.c-4,x.board[s.r][s.c]?.18:0,4.5-s.r).project(x.camera);return{x:rect.x+(v.x+1)*rect.width/2,y:rect.y+(1-v.y)*rect.height/2};},s);
  await p.mouse.click(pt.x,pt.y);if(s===from)assert.deepEqual(await p.evaluate(()=>__chess.selected),from);
 }
}
const states=p=>p.evaluate(ids=>Object.fromEntries(ids.map(id=>{const o=document.querySelector('#'+id+' option[value="experimental-b"]');return[id,o?{disabled:o.disabled,effectivelyDisabled:o.matches(':disabled')}:null];})),ids);
const noB=async p=>{for(const v of Object.values(await states(p)))if(v)assert.equal(v.effectivelyDisabled,true);};
const idle=p=>p.waitForFunction(()=>document.querySelector('#savedPositionsDialog').getAttribute('aria-busy')==='false');
const storage=p=>p.evaluate(async()=>{
 const result={record:localStorage.getItem('chinese-chess-training:game-records:v1'),legacy:localStorage.getItem('chinese-chess-training:custom-positions:v1'),idb:null};
 if((await indexedDB.databases()).some(x=>x.name==='chinese-chess-training:custom-positions')){
  const db=await new Promise((r,j)=>{const q=indexedDB.open('chinese-chess-training:custom-positions');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
  result.idb={};for(const name of [...db.objectStoreNames].sort())result.idb[name]=await new Promise((r,j)=>{const tx=db.transaction(name),q=tx.objectStore(name).openCursor(),rows=[];q.onsuccess=()=>{const c=q.result;if(c){rows.push([c.key,c.value]);c.continue();}};tx.oncomplete=()=>r(rows);tx.onabort=()=>j(tx.error);});db.close();
 }return result;
});
async function seed(p){
 await toolbar(p,'#btnEditor');await p.locator('#btnEditorStandard').click();await p.locator('#btnEditorConfirm').click();
 await p.locator('#btnSaveCustomPosition').click();await idle(p);await p.locator('#savedPositionTitle').fill('Synthetic activation fixture');
 await p.locator('#savedPositionSubmit').click();await idle(p);assert.equal(await p.locator('#savedPositionsList li').count(),1);
}
async function challenge(p){
 await p.locator('[data-action="challenge"]').click();await idle(p);
 if(await p.locator('#savedPositionAcknowledge').isVisible())await p.locator('#savedPositionAcknowledge').check();
}
const gameState=p=>p.evaluate(()=>({mode:__chess.mode,state:__chess.appState,session:__chess.normalGameRecordSession,
 board:__chess.board,history:__chess.history,select:document.getElementById('modeSel').value}));
const forceMode=(p,mode)=>p.locator('#modeSel').evaluate((s,value)=>{s.value=value;s.dispatchEvent(new Event('change',{bubbles:true}));},mode);
async function mateFixture(p,mode){
 await p.locator('#modeSel').selectOption(mode);
 const board=Array.from({length:10},()=>Array(9).fill(null));
 for(const [r,c,type,side]of [[9,4,'K','black'],[0,4,'K','red'],[2,3,'R','red'],[2,4,'P','black'],[9,3,'P','black'],[9,5,'P','black']])board[r][c]={type,side};
 await p.evaluate(board=>__chess.resetTo(board,'red'),board);
}
async function run(name,fn){
 if(selectedCases.size&&!selectedCases.has(name))return;
 const r={name,status:'RUNNING',errors:[],consoleErrors:[],mainThreadSearches:[],workerReplies:[]};results.push(r);
 const context=await browser.newContext({viewport:name.includes('mobile')?{width:390,height:844}:{width:1440,height:1000}});
 const p=await context.newPage();p.setDefaultTimeout(20000);
 await context.addInitScript(()=>{
  window.activationQA={posts:[],responses:[],unhandled:[]};
  addEventListener('unhandledrejection',e=>activationQA.unhandled.push(String(e.reason)));
  const W=Worker;window.Worker=class extends W{constructor(...a){super(...a);this.addEventListener('message',e=>activationQA.responses.push(e.data));}postMessage(d,...a){activationQA.posts.push(d);return super.postMessage(d,...a);}};
 });
 p.on('pageerror',e=>r.errors.push(e.message));p.on('console',m=>{if(m.type()==='error')r.consoleErrors.push(m.text());});
 // Main-target breakpoints observe sync B fallback without changing engine bytes.
 const cdp=await context.newCDPSession(p);await cdp.send('Debugger.enable');
 cdp.on('Debugger.paused',async event=>{try{r.mainThreadSearches.push(await cdp.send('Debugger.evaluateOnCallFrame',{callFrameId:event.callFrames[0].callFrameId,expression:'({level,mainThread:typeof document!=="undefined"})',returnByValue:true}));}finally{await cdp.send('Debugger.resume');}});
 for(const file of ['ai.js','ai-experimental-b.js']){
  const line=(await readFile(path.join(site,file),'utf8')).split('\n').findIndex(x=>x.includes('const cfg = LEVELS[level]'));
  await cdp.send('Debugger.setBreakpointByUrl',{urlRegex:'/'+file.replaceAll('.','\\.')+'(?:\\?|$)',lineNumber:line,
   condition:file==='ai.js'?'level === "experimental-b"':'true'});
 }
 try{
  await fn(p,r);
  assert.deepEqual(r.mainThreadSearches,[],'No main-thread B search');
  assert.deepEqual(await p.evaluate(()=>activationQA.unhandled),[]);
  assert.deepEqual(r.errors,name==='init-failed'?['Injected initialization failure']:[]);
  r.status='PASS';r.options=await states(p);
 }catch(e){r.status='FAIL';r.error=String(e);r.stack=e.stack;}
 finally{
  r.workerReplies=await p.evaluate(()=>window.activationQA?.responses).catch(()=>[]);
  await p.screenshot({path:path.join(out,name+'.png')}).catch(()=>{});
  await context.close();await writeFile(path.join(out,'result.json'),JSON.stringify({url,chrome:browser.version(),results},null,2));
  console.log(r.status+' '+name);if(r.status==='FAIL')throw Error(r.error);
 }
}
try{
 for(const value of ['old-old','old-new','new-old','new-prefixed','old-main-new-modules']){
  scenario=value;await run(value,async(p,r)=>{
   await p.goto(url);await ready(p);await noB(p);r.initialPieces=32;
   for(const mode of ['easy','medium','hard']){
    await p.locator('#modeSel').selectOption(mode);await move(p);await p.waitForFunction(()=>__chess.history.length===2&&!__chess.aiThinking&&!__chess.busy);
   }
   await toolbar(p,'#btnUndo');await p.waitForFunction(()=>__chess.history.length===0);
   await seed(p);const before=await storage(p);await challenge(p);await noB(p);
   r.challengeOptions=await states(p);await p.locator('#savedPositionBack').click();await p.locator('[data-action="preferences"]').click();await noB(p);
   assert.deepEqual(await storage(p),before);
   // Original P2: if Worker loading fails, user still cannot select B.
   await p.locator('#savedPositionsClose').click();await p.locator('#btnEditorExit').click();
   await p.route('**/ai-worker.js*',route=>route.abort());await noB(p);
   assert.equal((await p.evaluate(()=>activationQA.posts)).some(x=>x.level==='experimental-b'),false);
  });
 }
 for(const value of ['init-delayed','init-failed']){
  scenario=value;await run(value,async(p,r)=>{
   await p.goto(url,{waitUntil:'commit'});await ready(p);await noB(p);
   const before=await p.evaluate(()=>JSON.stringify(__chess.board));
   await p.locator('#modeSel').evaluate(s=>{s.value='experimental-b';s.dispatchEvent(new Event('change',{bubbles:true}));});
   assert.equal(await p.evaluate(()=>__chess.mode),'medium');assert.equal(await p.evaluate(()=>JSON.stringify(__chess.board)),before);
   await seed(p);const stored=await storage(p);await challenge(p);await noB(p);
   await p.locator('#savedPositionDifficulty').evaluate(s=>{s.value='experimental-b';s.dispatchEvent(new Event('change',{bubbles:true}));});
   assert.equal(await p.locator('#savedPositionOnce').isDisabled(),true);
   await p.locator('#savedPositionOnce').dispatchEvent('click');await p.waitForTimeout(150);
   assert.deepEqual(await storage(p),stored);assert.equal(await p.evaluate(()=>__chess.mode),'medium');
   assert.equal(await p.locator('#savedPositionsDialog').isVisible(),true);
   await p.locator('#savedPositionsClose').click();
   if(value==='init-delayed'){await p.evaluate(()=>releaseBInitialization());await p.waitForFunction(()=>!document.querySelector('#modeSel option[value="experimental-b"]').disabled);r.recovered=true;}
  });
 }
 for(const fault of ['new-old-worker','new-worker-blocked']){
  scenario=fault;await run(fault,async(p,r)=>{
   if(fault==='new-worker-blocked')await p.route('**/ai-worker.js*',route=>route.abort());
   await p.goto(url);await ready(p);const before=await storage(p);
   await p.locator('#modeSel').selectOption('experimental-b');await move(p);
   await p.locator('#btnRetryExperimental').waitFor({state:'visible'});
   assert.equal(await p.evaluate(()=>__chess.history.length),1);assert.equal(await p.evaluate(()=>__chess.mode),'experimental-b');
   assert.deepEqual(await storage(p),before);r.failedSafely=true;
   if(fault==='new-worker-blocked')await p.unroute('**/ai-worker.js*');
   scenario='new-new';await p.locator('#btnRetryExperimental').click();
   await p.waitForFunction(()=>__chess.history.length===2&&!__chess.aiThinking&&!__chess.busy);
   await p.waitForTimeout(1000);assert.equal(await p.evaluate(()=>__chess.history.length),2);assert.deepEqual(await storage(p),before);
   assert.ok((await p.evaluate(()=>activationQA.responses)).some(x=>x.metrics?.nodes>0));r.retry=true;
  });
 }
 for(const label of ['desktop','mobile']){
  scenario='new-new';await run('new-new-'+label,async(p,r)=>{
   await p.goto(url);await ready(p);
   for(const id of ids.slice(0,3))assert.equal((await states(p))[id].effectivelyDisabled,false);
   await p.locator('#modeSel').selectOption('experimental-b');await move(p);
   await p.waitForFunction(()=>__chess.history.length===2&&!__chess.aiThinking&&!__chess.busy);
   assert.match(await p.locator('#experimentalNotice').innerText(),/不保證比困難級強/);
   await toolbar(p,'#btnUndo');await p.waitForFunction(()=>__chess.history.length===0);await p.locator('#btnNew').click();
   await seed(p);const before=await storage(p);await challenge(p);
   await p.locator('#savedPositionDifficulty').selectOption('experimental-b');
   assert.equal(await p.locator('#savedPositionSubmit').isDisabled(),true);
   await p.locator('#savedPositionOnce').click();await p.waitForFunction(()=>!document.querySelector('dialog[open]')&&__chess.mode==='experimental-b');
   await move(p);await p.waitForFunction(()=>__chess.history.length===2&&!__chess.aiThinking&&!__chess.busy);assert.deepEqual(await storage(p),before);
   r.savedOnceOnly=true;r.searches=(await p.evaluate(()=>activationQA.responses)).filter(x=>x.metrics);
   assert.ok(r.searches.length>=2);await p.reload();await ready(p);assert.deepEqual(await storage(p),before);
  });
 }
 scenario='new-new';await run('session-modal-mode-rejected',async(p,r)=>{
  await p.goto(url);await ready(p);await mateFixture(p,'hard');await toolbar(p,'#btnSavedPositions');await idle(p);
  const before=await gameState(p);assert.equal(await p.locator('#modeSel').isDisabled(),true);
  await forceMode(p,'experimental-b');assert.deepEqual(await gameState(p),before);
  await p.locator('#savedPositionsClose').click();await move(p,{r:2,c:3},{r:2,c:4});
  await p.waitForFunction(()=>__chess.lastCompletedGameRecord?.mode==='hard');
  const terminal=await p.evaluate(()=>({mode:__chess.mode,session:__chess.normalGameRecordSession,record:__chess.lastCompletedGameRecord,error:__chess.normalGameRecordError}));
  assert.equal(terminal.mode,'hard');assert.equal(terminal.session.id,before.session.id);assert.equal(terminal.error,null);
  assert.ok(JSON.parse((await storage(p)).record).records.some(x=>x.id===terminal.record.id&&x.mode==='hard'));
  r.terminal=terminal;r.rejectedBeforeMutation=true;
 });
 for(const readNumber of [1,2])for(const transition of ['accepted','rejected']){
  scenario='session-hold';await run(`session-read-${readNumber}-${transition}-mode-change`,async(p,r)=>{
   await p.goto(url);await ready(p);await seed(p);await p.locator('#savedPositionsClose').click();await p.locator('#btnEditorExit').click();
   await toolbar(p,'#btnSavedPositions');await idle(p);await challenge(p);await p.locator('#savedPositionDifficulty').selectOption('experimental-b');
   const before=await storage(p),origin=await gameState(p);
   await p.evaluate(n=>{window.sessionHoldRead=n;},readNumber);await p.locator('#savedPositionOnce').click();await p.waitForFunction(()=>window.sessionReadHeld===true);
   let replacement;
   if(transition==='accepted'){
    await p.locator('#savedPositionsClose').click();await p.locator('#modeSel').selectOption('hard');replacement=await gameState(p);
    assert.notEqual(replacement.session.id,origin.session.id);assert.ok(replacement.session.modeRevision>origin.session.modeRevision);
    assert.equal(replacement.session.mode,'hard');
   }else{
    await forceMode(p,'hard');assert.deepEqual(await gameState(p),origin);
   }
   await p.evaluate(()=>sessionReleaseRead());
   if(transition==='accepted'){
    await p.waitForTimeout(1000);assert.deepEqual(await gameState(p),replacement);r.staleChallengeRejected=true;
   }else{
    await p.waitForFunction(()=>__chess.mode==='experimental-b'&&!document.querySelector('dialog[open]'));
    const state=await gameState(p);assert.equal(state.session.mode,'experimental-b');assert.notEqual(state.session.id,origin.session.id);r.validChallengePreserved=true;
   }
   assert.deepEqual(await storage(p),before);
   await move(p);await p.waitForFunction(()=>__chess.history.length===2&&!__chess.aiThinking&&!__chess.busy);
   await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>__chess.history.length),2);assert.deepEqual(await storage(p),before);
   r.storageUnchanged=true;
  });
 }
 for(const [sessionMode,runtimeMode]of [['hard','experimental-b'],['experimental-b','hard']]){
  scenario='session-corrupt';await run(`session-record-mismatch-${sessionMode}-${runtimeMode}`,async(p,r)=>{
   await p.goto(url);await ready(p);
   // Seed a real legacy terminal record; the fault must preserve its exact bytes.
   await mateFixture(p,'hard');await move(p,{r:2,c:3},{r:2,c:4});await p.waitForFunction(()=>__chess.lastCompletedGameRecord?.mode==='hard');
   await p.locator('#btnAgain').click();await mateFixture(p,sessionMode);const before=await storage(p);
   await p.evaluate(mode=>sessionFault.setMode(mode),runtimeMode);await move(p,{r:2,c:3},{r:2,c:4});
   await p.waitForFunction(()=>__chess.normalGameRecordError?.code==='GAME_RECORD_SESSION_MISMATCH');
   assert.equal(await p.evaluate(()=>__chess.lastCompletedGameRecord),null);assert.deepEqual(await storage(p),before);
   await p.waitForFunction(()=>!document.querySelector('#overlay').classList.contains('hidden'));
   assert.match(await p.locator('#ovReason').innerText(),/棋譜狀態不一致.*未保存/);
   r.recordError=await p.evaluate(()=>__chess.normalGameRecordError);
   await p.screenshot({path:path.join(out,`record-fail-closed-${sessionMode}-${runtimeMode}.png`)});
   await p.evaluate(mode=>{sessionFault.setMode(mode);sessionFault.finalize();},sessionMode);
   assert.equal(await p.evaluate(()=>__chess.lastCompletedGameRecord),null);assert.deepEqual(await storage(p),before);
   r.failureLatched=true;r.storageUnchanged=true;
   r.storageBeforeSHA256=fingerprint(before);r.storageAfterSHA256=fingerprint(await storage(p));
   assert.equal(r.storageAfterSHA256,r.storageBeforeSHA256);
   await p.locator('#btnAgain').click();assert.equal(await p.evaluate(()=>__chess.normalGameRecordError),null);
   await mateFixture(p,'hard');await move(p,{r:2,c:3},{r:2,c:4});await p.waitForFunction(()=>__chess.lastCompletedGameRecord?.mode==='hard');
   assert.notEqual((await storage(p)).record,before.record);r.nextValidGameSaved=true;
  });
 }
}finally{clearTimeout(watchdog);await browser.close();await new Promise(r=>server.close(r));}
