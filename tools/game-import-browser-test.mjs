// Isolated Chrome end-to-end import tests. Every artifact/download stays outside the checkout.
// PLAYWRIGHT_MODULE=... node tools/game-import-browser-test.mjs SITE NEW_EVIDENCE_DIR [PHASE_B_SOURCE]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseGameTransfer, serializeGameTransfer, validateGameTransfer } from '../game-transfer/game-transfer.js';
import { replayGameTimeline } from '../game-record.js';
import { transfer, terminal, longGame } from './game-transfer-fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),site=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]),old=process.argv[4]&&path.resolve(process.argv[4]);
assert.ok(out!==root&&!out.startsWith(root+path.sep));await mkdir(out,{recursive:false});
const {chromium,firefox}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const prefix='/chinese-chess-training/',results=[],errors=[],requests=[];let mixed=null,currentPage,index=0;
const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}assert.ok(pathname.startsWith(prefix));const rel=pathname.slice(prefix.length)||'index.html';
 const from=old&&((mixed==='old-html'&&rel==='index.html')||(mixed==='old-js'&&rel.endsWith('.js'))||(mixed==='old-worker'&&rel==='game-transfer/validation-worker.js'))?old:site;
 const file=path.resolve(from,rel);assert.ok(file.startsWith(from+path.sep)&&!rel.endsWith('.mjs'));const bytes=await readFile(file);requests.push(req.url);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(rel)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}${prefix}`,browser=await chromium.launch({channel:'chrome',headless:true}),watchdog=setTimeout(()=>void browser.close(),600000);
const check=async(name,fn)=>{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);};
const idle=p=>p.waitForFunction(()=>window.__chess&&!__chess.busy&&!__chess.aiThinking);
const toolbar=async(p,id)=>{if(!await p.locator(id).isVisible())await p.locator('#btnMore').click();await p.locator(id).click();};
const live=p=>p.evaluate(()=>({session:__chess.normalGameRecordSession,board:__chess.board,turn:__chess.turn,history:__chess.history,mode:__chess.mode}));
async function page(context){const p=currentPage=await context.newPage();p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await idle(p);await p.waitForFunction(()=>!document.querySelector('#btnGameImport')?.hidden);return p;}
async function library(p){if(await p.evaluate(()=>__chess.appState==='GAME_REVIEW'))await p.locator('#btnGameReviewBack').click();else if(await p.evaluate(()=>__chess.appState!=='GAME_RECORD_LIBRARY'))await toolbar(p,'#btnGameRecords');}
async function openImport(p){await library(p);await p.locator('#btnGameImport').click();await p.locator('#gameImportDialog').waitFor({state:'visible'});}
const payload=(text,name='game.json',mimeType='application/json')=>({name,mimeType,buffer:Buffer.isBuffer(text)?text:Buffer.from(text)});
async function preview(p,input){await openImport(p);await p.locator('#gameImportFile').setInputFiles(input);await p.waitForFunction(()=>!document.querySelector('#gameImportConfirm').disabled);}
async function accept(p){await p.locator('#gameImportConfirm').click();await p.waitForFunction(()=>__chess.gameReview?.sourceKind==='imported'&&!document.querySelector('#gameImportDialog').open);}
async function exportJSON(p){const entry=await p.locator('#btnGameExportEnd').isVisible()?'#btnGameExportEnd':'#btnGameExport';await toolbar(p,entry);const event=p.waitForEvent('download');await p.locator('[data-export-format="json"]').click();const download=await event;const file=path.join(out,`${++index}-${download.suggestedFilename()}`);await download.saveAs(file);assert.equal(await download.failure(),null);await p.locator('#gameExportClose').click();return {file,bytes:await readFile(file)};}
async function compareReview(p,document){
 const source=await p.evaluate(()=>({id:__chess.gameReview.source.id,document:__chess.gameReview.document}));assert.deepEqual(source.document,document);
 for(let ply=0;ply<=document.moves.length;ply++){
  if(ply===0)await p.locator('#btnGameReviewFirst').click({force:true});else await p.locator(`[data-review-ply="${ply}"]`).click();
  const actual=await p.evaluate(()=>({snapshot:__chess.gameReview.snapshot,source:__chess.gameReview.source.id,sourceKind:__chess.gameReview.sourceKind,hasRecord:'record' in __chess.gameReview}));
  const expected=replayGameTimeline({id:'browser-oracle',createdAt:document.exportedAt,initialPosition:document.initialPosition,moves:document.moves,mode:document.mode},ply);
  assert.deepEqual(actual.snapshot,expected);assert.equal(actual.source,source.id);assert.equal(actual.sourceKind,'imported');assert.equal(actual.hasRecord,false);
 }
}
async function challenge(p,ply,mode,humanSide){
 await p.evaluate(ply=>__chess.navigateGameReview(ply),ply);const before=await p.evaluate(()=>({source:__chess.gameReview.document,snapshot:__chess.gameReview.snapshot,oldSession:__chess.normalGameRecordSession.id}));
 await p.locator('#btnGameReviewContinue').click();assert.match(await p.locator('#gameReviewContinuationWarning').textContent(),/需要保留的話，請先匯出/);
 await p.locator('#gameReviewContinuationDifficulty').selectOption(mode);await p.locator('#gameReviewContinuationHumanSide').selectOption(humanSide);
 await p.locator('#gameReviewContinuationForm button[type="submit"]').click();
 const immediate=await live(p);assert.notEqual(immediate.session.id,before.oldSession);assert.equal(immediate.session.sourceRecordId??null,null);assert.equal(immediate.mode,mode);assert.deepEqual(immediate.session.initialPosition,{board:before.snapshot.board,sideToMove:before.snapshot.sideToMove});
 // A moving AI may already have submitted its first move; inspect the untouched root and at most one reply.
 assert.ok(immediate.history.length<=1);await idle(p);assert.ok((await live(p)).history.length<=1);return before;
}
const storage=p=>p.evaluate(async()=>{
 const normalize=async value=>{if(value instanceof Blob){const bytes=await value.arrayBuffer();return {type:value.type,size:value.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('')};}if(Array.isArray(value))return Promise.all(value.map(normalize));if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=await normalize(value[key]);return out;}return value;};
 const local=Object.fromEntries(Object.keys(localStorage).sort().map(k=>[k,localStorage.getItem(k)])),dbs={};
 for(const info of (await indexedDB.databases()).sort((a,b)=>a.name.localeCompare(b.name))){const db=await new Promise((yes,no)=>{const r=indexedDB.open(info.name);r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});try{const stores={};for(const name of [...db.objectStoreNames]){const s=db.transaction(name,'readonly').objectStore(name),get=r=>new Promise((yes,no)=>{r.onsuccess=()=>yes(r.result);r.onerror=()=>no(r.error);});stores[name]=await normalize(await Promise.all([get(s.getAllKeys()),get(s.getAll())]));}dbs[info.name]={version:info.version,stores};}finally{db.close();}}
 return {local,dbs};
});
let standardFile;
try{
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const label=String(viewport.width),producer=await browser.newContext({viewport,acceptDownloads:true}),consumer=await browser.newContext({viewport,acceptDownloads:true});
  await consumer.addInitScript(()=>{
   window.importQA={fault:null,held:[],workers:[],aiPosts:[],downloads:0,writes:[],idbWrites:[],blockRecords:false};
   const Native=Worker;
   window.Worker=class{
    constructor(url,options){if(!String(url).includes('game-transfer/validation-worker.js')){const w=new Native(url,options),post=w.postMessage.bind(w);w.postMessage=(data,...rest)=>{importQA.aiPosts.push(data);return post(data,...rest);};return w;}
     this.fault=importQA.fault;if(this.fault==='startup')throw Error('synthetic startup failure');this.stops=0;importQA.workers.push(this);this.native=this.fault==='timeout'?null:new Native(url,options);
     if(this.native){this.native.onerror=e=>this.onerror?.(e);this.native.onmessageerror=e=>this.onmessageerror?.(e);this.native.onmessage=e=>{const fn=this.onmessage;let data=e.data;if(this.fault==='hold'){importQA.held.push(()=>fn?.({data}));return;}if(this.fault==='incomplete')data={...data,value:{document:{},replay:{}}};if(this.fault==='cycle')data.value.loop=data.value;if(this.fault==='messageerror'){this.onmessageerror?.({});return;}if(this.fault==='error'){this.onerror?.({preventDefault(){}});return;}fn?.({data});if(this.fault==='duplicate')fn?.({data});};}}
    postMessage(data){this.native?.postMessage(data);}terminate(){this.stops++;this.native?.terminate();}
   };
   const get=Storage.prototype.getItem;Storage.prototype.getItem=function(k){if(importQA.blockRecords&&k==='chinese-chess-training:game-records:v1')throw Error('synthetic read failure');return get.call(this,k);};
   for(const method of ['setItem','removeItem','clear']){const original=Storage.prototype[method];Storage.prototype[method]=function(...args){importQA.writes.push({method,key:args[0]});return original.apply(this,args);};}
   for(const method of ['add','put','delete','clear']){const original=IDBObjectStore.prototype[method];IDBObjectStore.prototype[method]=function(...args){importQA.idbWrites.push({method,store:this.name});return original.apply(this,args);};}
  });
  const a=await page(producer),b=await page(consumer);b.on('download',()=>void b.evaluate(()=>importQA.downloads++));
  await check(label+' A: standard completed game export -> separate context import -> every ply -> new challenge',async()=>{
   await a.locator('#modeSel').selectOption('pvp');const cycle=[[0,1,2,2],[9,1,7,2],[2,2,0,1],[7,2,9,1]];
   for(const [r,c,tr,tc]of [...cycle,...cycle]){await a.evaluate(({r,c,tr,tc})=>__chess.doMove({r,c},{r:tr,c:tc}),{r,c,tr,tc});await idle(a);}
   await a.locator('#btnGameExportEnd').waitFor({state:'visible'});const output=await exportJSON(a);standardFile=output.file;const document=parseGameTransfer(output.bytes).document;assert.equal(document.status,'completed');
   const original=await live(b);await preview(b,output.file);assert.match(await b.locator('#gameImportMeta').textContent(),/雙人對弈/);assert.match(await b.locator('#gameImportMeta').textContent(),/未記錄/);assert.equal(await b.locator('#gameImportBoard td').count(),90);
   await accept(b);await compareReview(b,document);assert.deepEqual(await live(b),original);await challenge(b,4,'easy','red');assert.equal((await live(b)).history.length,0);
  });
  await check(label+' C: in-progress exported timeline imports without a result; last-ply continuation starts fresh',async()=>{
   await a.evaluate(()=>__chess.newGame());for(const move of [{from:{r:3,c:4},to:{r:4,c:4}},{from:{r:6,c:4},to:{r:5,c:4}}]){await a.evaluate(m=>__chess.doMove(m.from,m.to),move);await idle(a);}
   const output=await exportJSON(a),document=parseGameTransfer(output.bytes).document;assert.equal(document.result,null);assert.equal(document.status,'in-progress');await preview(b,output.file);
   await b.locator('#gameImportConfirm').focus();await b.keyboard.press('Enter');await b.waitForFunction(()=>__chess.gameReview?.sourceKind==='imported');await compareReview(b,document);
   assert.equal(await b.locator('#btnGameReviewLast span').textContent(),'最後一著');assert.match(await b.locator('#gameReviewStatus').textContent(),/尚未完成/);assert.equal(await b.locator('#btnGameReviewContinue').isDisabled(),false);
   await challenge(b,document.moves.length,'medium','red');assert.equal((await live(b)).history.length,0);
  });
  await check(label+' B: authored mate position -> B AI play -> export -> separate import -> B continuation',async()=>{
   await a.evaluate(()=>__chess.newGame());await toolbar(a,'#btnEditor');await a.locator('#btnEditorClear').click();const start=terminal().initialPosition;
   for(let r=0;r<10;r++)for(let c=0;c<9;c++){const piece=start.board[r][c];if(!piece)continue;await a.locator(`[data-editor-side="${piece.side}"][data-editor-type="${piece.type}"]`).click();
    const pt=await a.evaluate(({r,c})=>{const x=__chess,rect=x.renderer.domElement.getBoundingClientRect(),v=x.camera.position.clone().set(c-4,0,4.5-r).project(x.camera);return {x:rect.x+(v.x+1)*rect.width/2,y:rect.y+(1-v.y)*rect.height/2};},{r,c});await a.mouse.click(pt.x,pt.y);}
   assert.deepEqual(await a.evaluate(()=>__chess.editorDraft.initialBoard),start.board);await a.locator('#btnEditorConfirm').click();await a.locator('#btnCustomPlay').click();await a.locator('#customPlayDifficulty').selectOption('experimental-b');await a.locator('#customPlayHumanSide').selectOption('black');
   const stored=await a.evaluate(()=>localStorage.getItem('chinese-chess-training:game-records:v1'));await a.locator('#customPlayForm button[type="submit"]').click();await a.waitForFunction(()=>__chess.history.length>0&&!__chess.busy&&!__chess.aiThinking);
   const output=await exportJSON(a),document=parseGameTransfer(output.bytes).document;assert.equal(document.mode,'experimental-b');assert.deepEqual(document.initialPosition,start);assert.doesNotMatch(output.bytes.toString(),/solution|practice|attempt|Session|sessionId/);assert.equal(await a.evaluate(()=>localStorage.getItem('chinese-chess-training:game-records:v1')),stored);
   await preview(b,output.file);await accept(b);await compareReview(b,document);await challenge(b,0,'experimental-b','red');assert.equal((await live(b)).history.length,0);
  });
  await check(label+' black-first and pvp imports choose any AI; selected-ply stale confirmation is rejected',async()=>{
   const document={...longGame(4,'black'),mode:'pvp',playerSide:null};await preview(b,payload(serializeGameTransfer(document)));await accept(b);await compareReview(b,validateGameTransfer(document).document);
   await b.evaluate(()=>__chess.navigateGameReview(1));await b.locator('#btnGameReviewContinue').click();const before=await live(b);await b.evaluate(()=>__chess.navigateGameReview(2));assert.equal(await b.locator('#gameReviewContinuationDialog').evaluate(d=>d.open),false);
   await b.locator('#gameReviewContinuationForm').dispatchEvent('submit');assert.deepEqual(await live(b),before);
   const posts=await b.evaluate(()=>importQA.aiPosts.length);await challenge(b,0,'hard','red');assert.equal((await live(b)).history.length,1);assert.equal(await b.evaluate(()=>importQA.aiPosts.length),posts+1);
  });
  await check(label+' imported continuation preserves source, resets history and honors player perspective and lock',async()=>{
   const document=longGame(0,'black');await preview(b,payload(serializeGameTransfer(document)));await accept(b);
   await b.evaluate(()=>window.importedSourceBefore=__chess.gameReview);await challenge(b,0,'easy','black');await b.waitForTimeout(800);
   assert.equal(await b.evaluate(()=>__chess.viewerSide),'black');assert.equal((await live(b)).history.length,0);
   assert.equal(await b.evaluate(()=>Object.isFrozen(importedSourceBefore)&&Object.isFrozen(importedSourceBefore.document)),true);
   assert.deepEqual(await b.evaluate(()=>importedSourceBefore.document),validateGameTransfer(document).document);
   const fresh=await live(b);await b.locator('#gameReviewContinuationForm').dispatchEvent('submit');assert.deepEqual(await live(b),fresh);
   await toolbar(b,'#btnLock');const locked=await b.evaluate(()=>__chess.camera.position.toArray());
   await preview(b,payload(serializeGameTransfer(transfer())));await accept(b);await challenge(b,0,'medium','red');await b.waitForTimeout(800);
   assert.equal(await b.locator('#btnLock').getAttribute('aria-pressed'),'true');assert.deepEqual(await b.evaluate(()=>__chess.camera.position.toArray()),locked);assert.equal((await live(b)).history.length,0);
   await toolbar(b,'#btnLock');
  });
  await check(label+' storage isolation, repeated preview/cancel/navigation, keyboard and runtime permissions',async()=>{
   await b.evaluate(async()=>{__chess.setMode('easy');__chess.newGame();__chess.doMove({r:3,c:4},{r:4,c:4});
    const {createPracticeAnalyticsStore}=await import('./puzzle-analytics.js');createPracticeAnalyticsStore({storage:localStorage}).recordAttempt({puzzleId:'synthetic-phase-c',startedAt:'2026-11-10T00:00:00.000Z',endedAt:'2026-11-10T00:01:00.000Z',outcome:'completed',mistakes:0,hintRequests:0,maxHintLevel:0});
   });await idle(b);await b.waitForTimeout(1100);
   await b.evaluate(async d=>{const {createPuzzleStore}=await import('./puzzle-store.js');createPuzzleStore({storage:localStorage}).savePuzzle({id:'synthetic-phase-c',title:'合成殺局',initialBoard:d.initialPosition.board,sideToMove:d.initialPosition.sideToMove,solution:d.moves.map(m=>({...m,side:'red'})),tags:[],notes:'合成資料'});},terminal());
   await toolbar(b,'#btnSaveCurrentPosition');await b.locator('#savedPositionTitle').fill('Synthetic Phase C position');await b.locator('#savedPositionSubmit').click();await b.waitForFunction(()=>document.querySelector('#savedPositionsNotice').textContent.includes('已'));await b.locator('#savedPositionsClose').click();
   await toolbar(b,'#btnBoardAppearance');const photo=await b.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=20;const x=c.getContext('2d');x.fillStyle='#987132';x.fillRect(0,0,20,20);return c.toDataURL('image/png').split(',')[1];});await b.locator('#boardAppearanceFile').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(photo,'base64')});await b.locator('#boardAppearanceRemember').check();await b.waitForTimeout(800);await b.locator('#boardAppearanceClose').click();
   await library(b);const before=await storage(b),game=await live(b);await b.evaluate(()=>{importQA.writes=[];importQA.idbWrites=[];});
   await preview(b,standardFile);await b.locator('#gameImportConfirm').focus();await b.keyboard.press('Tab');assert.equal(await b.evaluate(()=>document.activeElement.id),'gameImportCancel');await b.keyboard.press('Shift+Tab');assert.equal(await b.evaluate(()=>document.activeElement.id),'gameImportConfirm');
   await b.keyboard.press('Escape');assert.equal(await b.evaluate(()=>document.activeElement.id),'btnGameImport');assert.deepEqual(await live(b),game);assert.deepEqual(await storage(b),before);
   await preview(b,standardFile);await accept(b);await b.evaluate(()=>__chess.navigateGameReview(4));
   for(const id of ['btnGameReviewAnalyze','btnGameReviewAiAnalyze','btnGameReviewCreatePuzzle','btnGameReviewDelete','btnGameReviewExport'])assert.equal(await b.locator('#'+id).isVisible(),false);
   assert.deepEqual(await b.evaluate(()=>[__chess.enterGameAnalysis(),__chess.createPuzzleFromGameReview(),__chess.requestGameReviewCoach(),__chess.openGameTeachingReviewHandoff()]),[false,false,false,false]);
   for(const id of ['btnGameReviewAnalyze','btnGameReviewAiAnalyze','btnGameReviewCreatePuzzle','btnGameReviewDelete'])await b.locator('#'+id).dispatchEvent('click');
   await b.locator('#btnGameReviewContinue').click();const current=await b.evaluate(()=>__chess.gameReview.selectedPly);await b.locator('#btnGameReviewContinuationCancel').focus();for(const key of ['ArrowLeft','ArrowRight','Home','End']){await b.keyboard.press(key);assert.equal(await b.evaluate(()=>__chess.gameReview.selectedPly),current);}await b.keyboard.press('Escape');
   await library(b);await preview(b,payload(serializeGameTransfer(transfer())));await b.screenshot({path:path.join(out,label+'-import-preview.png')});await accept(b);assert.deepEqual(await live(b),game);assert.deepEqual(await storage(b),before);assert.deepEqual(await b.evaluate(()=>({ls:importQA.writes,idb:importQA.idbWrites})),{ls:[],idb:[]});
  });
  await check(label+' unreadable GameRecord store does not block independent JSON import',async()=>{
   await library(b);await b.evaluate(()=>importQA.blockRecords=true);await b.locator('#btnGameRecordLibraryExit').click();await library(b);assert.match(await b.locator('#gameRecordLibraryIssues').textContent(),/無法讀取/);
   await preview(b,standardFile);await accept(b);assert.equal(await b.evaluate(()=>__chess.gameReview.sourceKind),'imported');await b.evaluate(()=>importQA.blockRecords=false);
  });
  const bad=transfer();bad.moves=[{from:{r:3,c:0},to:{r:7,c:0}}];
  const invalids=[['illegal',JSON.stringify(bad)],['result',JSON.stringify({...transfer(),status:'completed',result:{winner:'red',terminationReason:'checkmate'}})],['version',JSON.stringify({...transfer(),schemaVersion:2})],['duplicate',serializeGameTransfer(transfer()).replace('"schemaVersion": 1','"schemaVersion": 1, "schemaVersion": 1')],['oversize',' '.repeat(1048577)],['broken','{'],['utf8',Buffer.from([0xff,0xfe,0xff])],['txt','中國象棋棋譜','text/plain']];
  for(const [name,text,type]of invalids)await check(`${label} D: reject ${name} without partial import or storage changes`,async()=>{
   await library(b);const before=await storage(b),game=await live(b);await openImport(b);await b.locator('#gameImportFile').setInputFiles(payload(text,name+'.'+(name==='txt'?'txt':'json'),type||'application/json'));await b.waitForFunction(()=>document.querySelector('#gameImportStatus').textContent.includes('尚未載入'));
   assert.equal(await b.locator('#gameImportConfirm').isDisabled(),true);assert.equal(await b.locator('#gameImportPreview').isVisible(),false);assert.equal(await b.evaluate(()=>__chess.appState),'GAME_RECORD_LIBRARY');assert.deepEqual(await storage(b),before);assert.deepEqual(await live(b),game);await b.keyboard.press('Escape');
  });
  for(const fault of ['startup','incomplete','cycle','error','messageerror','timeout'])await check(`${label}: ${fault} is fail-closed and a later import recovers`,async()=>{
   await b.evaluate(f=>importQA.fault=f,fault);await openImport(b);await b.locator('#gameImportFile').setInputFiles(standardFile);await b.waitForFunction(()=>document.querySelector('#gameImportStatus').textContent.includes('尚未載入'));assert.equal(await b.locator('#gameImportConfirm').isDisabled(),true);await b.keyboard.press('Escape');await b.evaluate(()=>importQA.fault=null);await preview(b,standardFile);await b.keyboard.press('Escape');
  });
  await check(label+' A/B reverse Worker replies, duplicate changes/submits, cancel and leave cannot resurrect old import',async()=>{
   await b.evaluate(()=>importQA.fault='hold');await openImport(b);await b.locator('#gameImportFile').setInputFiles(standardFile);await b.waitForFunction(()=>importQA.held.length===1);
   await b.locator('#gameImportFile').setInputFiles(payload(serializeGameTransfer(transfer())));await b.waitForFunction(()=>importQA.held.length===2);const workers=await b.evaluate(()=>importQA.workers.length);await b.locator('#gameImportFile').dispatchEvent('change');assert.equal(await b.evaluate(()=>importQA.workers.length),workers);
   await b.evaluate(()=>importQA.held[1]());await b.waitForFunction(()=>!document.querySelector('#gameImportConfirm').disabled);await b.evaluate(()=>{importQA.held[0]();importQA.held=[];});assert.match(await b.locator('#gameImportMeta').textContent(),/未完成/);
   await b.locator('#gameImportConfirm').click();const identity=await b.evaluate(()=>__chess.gameReview.source.id);await b.locator('#gameImportForm').dispatchEvent('submit');assert.equal(await b.evaluate(()=>__chess.gameReview.source.id),identity);
   for(const action of ['cancel','leave']){await openImport(b);await b.locator('#gameImportFile').setInputFiles(standardFile);await b.waitForFunction(()=>importQA.held.length===1);if(action==='cancel')await b.keyboard.press('Escape');else await b.evaluate(()=>__chess.exitGameRecordFlow());const state=await live(b),screen=await b.evaluate(()=>__chess.appState);await b.evaluate(()=>{for(const fn of importQA.held.splice(0)){fn();fn();}});await b.waitForTimeout(100);assert.equal(await b.locator('#gameImportDialog').evaluate(d=>d.open),false);assert.equal(await b.evaluate(()=>__chess.appState),screen);assert.deepEqual(await live(b),state);}
   await openImport(b);await b.locator('#gameImportFile').setInputFiles(standardFile);await b.waitForFunction(()=>importQA.held.length===1);
   await b.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide')));await b.evaluate(()=>{for(const fn of importQA.held.splice(0))fn();});
   assert.equal(await b.locator('#gameImportDialog').evaluate(d=>d.open),false);assert.equal(await b.evaluate(()=>__chess.appState),'GAME_RECORD_LIBRARY');
   await b.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await b.waitForFunction(()=>!document.querySelector('#btnGameImport').hidden);
   await b.evaluate(()=>importQA.fault='duplicate');await preview(b,standardFile);await accept(b);await b.evaluate(()=>importQA.fault=null);assert.equal(await b.evaluate(()=>importQA.downloads),0);
   assert.ok(await b.evaluate(()=>importQA.workers.every(w=>w.stops===1&&w.onmessage===null&&w.onerror===null&&w.onmessageerror===null)));
  });
  await producer.close();await consumer.close();
 }
 if(old)for(const variant of ['old-html','old-js','old-worker'])await check('mixed '+variant+' remains compatible or unavailable',async()=>{
  mixed=variant;const ctx=await browser.newContext(),p=currentPage=await ctx.newPage();await p.goto(url);await idle(p);
  if(variant==='old-worker'){await p.waitForFunction(()=>!document.querySelector('#btnGameImport').hidden);await preview(p,standardFile);await accept(p);assert.equal(await p.evaluate(()=>__chess.gameReview.sourceKind),'imported');}
  else assert.equal(await p.locator('#btnGameImport').isVisible(),false);await ctx.close();mixed=null;
 });
 let other;
 try{other=await firefox.launch({headless:true});}catch(error){results.push({name:'Firefox cross-engine',status:'NOT_AVAILABLE',error:String(error)});}
 if(other)try{await check('Firefox imports the exact Chrome download and navigates every ply',async()=>{const ctx=await other.newContext({viewport:{width:1440,height:1000}}),p=await page(ctx);await preview(p,standardFile);await accept(p);const doc=parseGameTransfer(await readFile(standardFile)).document;await compareReview(p,doc);await ctx.close();});}finally{await other.close();}
 assert.deepEqual(errors,[]);
}catch(error){results.push({status:'FAIL',error:error.stack});console.error(error);process.exitCode=1;if(currentPage&&!currentPage.isClosed())await currentPage.screenshot({path:path.join(out,'failure.png')});}
finally{clearTimeout(watchdog);await writeFile(path.join(out,'result.json'),JSON.stringify({url,chrome:browser.version(),results,errors,requests,downloads:index},null,2));await browser.close();await new Promise(r=>server.close(r));}
