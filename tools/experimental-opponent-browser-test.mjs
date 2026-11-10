// Run in an isolated Chrome profile. Evidence must be outside the checkout.
// EXPERIMENTAL_B_EVIDENCE_DIR=... PLAYWRIGHT_MODULE=... node tools/experimental-opponent-browser-test.mjs [built-site]
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCustomPlayPosition } from '../custom-position-play.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const site=path.resolve(process.argv[2]||root), out=path.resolve(process.env.EXPERIMENTAL_B_EVIDENCE_DIR||'');
assert.ok(process.env.EXPERIMENTAL_B_EVIDENCE_DIR && out!==root && !out.startsWith(root+path.sep));
await mkdir(out,{recursive:false});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const baseline='33f24e85e2aa8873145210c7da97bbc704ad2765', prefix='/chinese-chess-training/';
const key='chinese-chess-training:game-records:v1', customKey='chinese-chess-training:custom-positions:v1';
let legacy=false;
const oldFiles=new Map(), mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'};
const server=createServer(async(req,res)=>{
  try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(!pathname.startsWith(prefix)){res.writeHead(404);res.end();return;}
    const rel=pathname.slice(prefix.length)||'index.html', target=path.resolve(site,rel);
    if(!target.startsWith(site+path.sep)){res.writeHead(403);res.end();return;}
    let body;
    if(legacy){if(!oldFiles.has(rel))oldFiles.set(rel,execFileSync('git',['show',baseline+':'+rel],{cwd:root}));body=oldFiles.get(rel);}
    else body=await readFile(target);
    res.writeHead(200,{'Content-Type':mime[path.extname(rel)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}${prefix}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const browserCDP=await browser.newBrowserCDPSession(), results=[],errors=[], samples=[],cpuStart=await browserCDP.send('SystemInfo.getProcessInfo');
let fatal=null,monitorBusy=false,owned=[],monitor,monitoring=true;
// External-to-renderer sampling; only processes belonging to this isolated Chrome.
async function sample(){if(monitorBusy||fatal||!monitoring)return;monitorBusy=true;try{
  const info=await browserCDP.send('SystemInfo.getProcessInfo');if(!monitoring)return;owned=info.processInfo.map(p=>p.id);
  if(process.platform==='win32'){
    // A renderer can exit between CDP enumeration and Get-Process. Keep the
    // surviving rows; do not confuse that ordinary race with monitor failure.
    const data=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-Process -Id ${owned.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64,WorkingSet64 | ConvertTo-Json -Compress; exit 0`],{encoding:'utf8',timeout:3000,windowsHide:true}));
    const rows=[data].flat().map(p=>({...p,type:info.processInfo.find(i=>i.id===p.Id)?.type}));
    samples.push({at:new Date().toISOString(),rows});
    if(rows.some(p=>p.type==='renderer'&&p.PrivateMemorySize64>512*1048576)){
      fatal='512 MiB renderer guard exceeded';
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Stop-Process -Id ${owned.join(',')} -ErrorAction SilentlyContinue`],{windowsHide:true,timeout:3000});
    }
  }
}catch(e){if(!fatal)fatal='Resource monitor failed: '+e.message;}finally{monitorBusy=false;}}
monitor=setInterval(()=>void sample(),1000);
const batchWatchdog=setTimeout(()=>{fatal='15 minute batch watchdog';void browser.close();},15*60*1000);
const board=Array.from({length:10},()=>Array(9).fill(null));
for(const [r,c,type,side]of [[9,4,'K','black'],[0,4,'K','red'],[2,3,'R','red'],[2,4,'P','black'],[9,3,'P','black'],[9,5,'P','black']])board[r][c]={type,side};
assert.equal(validateCustomPlayPosition({initialBoard:board,sideToMove:'red'}).ok,true,'legal synthetic mate fixture');
const check=async(name,fn)=>{if(fatal)throw Error(fatal);const start=Date.now();await fn();results.push({name,status:'PASS',ms:Date.now()-start});console.log('PASS '+name);};
const toolbar=async(p,id)=>{if(!await p.locator(id).isVisible())await p.locator('#btnMore').click();await p.locator(id).click();};
const ready=p=>p.waitForFunction(()=>window.__chess?.pieces.length===32&&!__chess.busy);
async function move(p,from,to){
  await p.waitForFunction(()=>!__chess.busy&&__chess.pieces.every(m=>Math.abs(m.position.y-.18)<.00001));
  await p.evaluate(()=>new Promise(resolve=>{let last='',stable=0,count=0;function tick(){const next=__chess.camera.position.toArray().map(n=>n.toFixed(4)).join(',');stable=next===last?stable+1:0;last=next;if(stable>=4||++count>=150)resolve();else requestAnimationFrame(tick);}requestAnimationFrame(tick);}));
  const occupied=await p.evaluate(to=>!!__chess.board[to.r][to.c],to);
  for(const [square,piece] of [[from,true],[to,occupied]]){
  const point=await p.evaluate(({square,piece})=>{const x=__chess,rect=x.renderer.domElement.getBoundingClientRect();const v=x.camera.position.clone().set(square.c-4,piece?.18:0,4.5-square.r).project(x.camera);return{x:rect.x+(v.x+1)*rect.width/2,y:rect.y+(1-v.y)*rect.height/2};},{square,piece});
  await p.mouse.click(point.x,point.y);
  if(square===from)assert.deepEqual(await p.evaluate(()=>__chess.selected),from,"Select intended piece through pointer");
}}
async function fresh(p,mode){await p.evaluate(()=>__chess.newGame());await p.locator('#modeSel').selectOption(mode);await p.waitForTimeout(1150);}
async function snapshot(p){return p.evaluate(async({key,customKey})=>{
  const names=await indexedDB.databases(), result={record:localStorage.getItem(key),legacyCustom:localStorage.getItem(customKey),idb:null};
  if(names.some(n=>n.name==='chinese-chess-training:custom-positions')){
    const db=await new Promise((r,j)=>{const q=indexedDB.open('chinese-chess-training:custom-positions');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
    result.idb={version:db.version,stores:{}};
    for(const store of [...db.objectStoreNames].sort())result.idb.stores[store]=await new Promise((r,j)=>{const tx=db.transaction(store),q=tx.objectStore(store).openCursor(),rows=[];q.onsuccess=()=>{const c=q.result;if(c){rows.push({key:c.key,value:c.value});c.continue();}};tx.oncomplete=()=>r(rows);tx.onabort=()=>j(tx.error);});db.close();
  }return result;
},{key,customKey});}
const instrumentation=()=>{
  globalThis.qa={writes:[],responses:[],posts:[],workers:[],rejections:[]};
  addEventListener('unhandledrejection',event=>qa.rejections.push(String(event.reason)));
  const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){qa.writes.push({kind:'localStorage',key:k,mode:window.__chess?.mode,b:typeof v==='string'&&v.includes('experimental-b')});return set.call(this,k,v);};
  for(const name of ['put','add']){const method=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){qa.writes.push({kind:'idb',key:this.name,mode:window.__chess?.mode,b:JSON.stringify(args).includes('experimental-b')});return method.apply(this,args);};}
  const NativeWorker=Worker;globalThis.Worker=class extends NativeWorker{constructor(...args){super(...args);this.qaIndex=qa.workers.length;qa.workers.push({url:String(args[0]),terminated:false});this.addEventListener('message',e=>qa.responses.push({data:e.data,at:performance.now()}));}postMessage(data,...rest){qa.posts.push({data,at:performance.now()});return super.postMessage(data,...rest);}terminate(){qa.workers[this.qaIndex].terminated=true;return super.terminate();}};
};
let context,page;
try{
  context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(instrumentation);page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url);await ready(page);assert.ok(await page.title());
  await check('desktop four modes: real moves, red/black, undo and new game',async()=>{
    for(const mode of ['easy','medium','hard','experimental-b']){await fresh(page,mode);await move(page,{r:3,c:4},{r:4,c:4});await page.waitForFunction(()=>__chess.history.length===2&&!__chess.busy&&!__chess.aiThinking);assert.equal(await page.evaluate(()=>__chess.mode),mode);}
    assert.equal(await page.locator('#btnSaveCurrentPosition').isDisabled(),false);
    await toolbar(page,'#btnUndo');await page.waitForFunction(()=>__chess.history.length===0);
    await page.locator('label[for="humanSideBlack"]').click();await page.waitForFunction(()=>__chess.history.length===1&&!__chess.busy&&!__chess.aiThinking);await page.waitForTimeout(1100);
    await move(page,{r:6,c:4},{r:5,c:4});await page.waitForFunction(()=>__chess.history.length===3&&!__chess.busy&&!__chess.aiThinking);
    await toolbar(page,'#btnUndo');await page.waitForFunction(()=>__chess.history.length===1);
    await page.screenshot({path:path.join(out,'desktop-b.png')});
  });
  let initial;
  await check('seed a genuine hard terminal record and a normal saved position',async()=>{
    legacy=true;await page.reload();await ready(page);
    await fresh(page,'hard');await page.evaluate(b=>__chess.resetTo(b,'red'),board);await page.waitForTimeout(1000);await move(page,{r:2,c:3},{r:2,c:4});await page.waitForFunction(()=>__chess.lastCompletedGameRecord?.mode==='hard');
    assert.ok(JSON.parse((await snapshot(page)).record).records.some(r=>r.mode==='hard'));
    await page.locator('#btnAgain').click();
    await page.evaluate(async({board,customKey})=>{const {createCustomPositionStore}=await import('./custom-position-store.js');createCustomPositionStore({storage:localStorage,idFactory:()=> 'uat-position'}).savePosition({title:'合法合成試玩局面',initialBoard:board,sideToMove:'red',playPreferences:{humanSide:'red',difficulty:'hard'}},{expectedRevision:0});},{board,customKey});
    await toolbar(page,'#btnSavedPositions');await page.locator('#savedPositionMigrationConfirm').check();await page.locator('#savedPositionMigrate').click();await page.waitForFunction(()=>document.querySelector('#savedPositionsDialog').dataset.storageState==='ACTIVE');
    initial=await snapshot(page);assert.ok(initial.idb);await writeFile(path.join(out,'storage-before.json'),JSON.stringify(initial,null,2));
    legacy=false;await page.reload();await ready(page);await toolbar(page,'#btnSavedPositions');
    await page.waitForFunction(()=>document.querySelector('#savedPositionsDialog').dataset.storageState==='ACTIVE');
  });
  await check('saved position B once-only, legal terminal, session review, no persistent writes',async()=>{
    await page.locator('[data-position-id="uat-position"] [data-action="challenge"]').click();await page.locator('#savedPositionDifficulty').selectOption('experimental-b');
    if(await page.locator('#savedPositionAcknowledge').isVisible())await page.locator('#savedPositionAcknowledge').check();
    assert.equal(await page.locator('#savedPositionSubmit').isDisabled(),true);await page.locator('#savedPositionOnce').click();await page.waitForFunction(()=>__chess.mode==='experimental-b'&&!document.querySelector('dialog[open]'));
    await page.waitForTimeout(1100);await move(page,{r:2,c:3},{r:2,c:4});await page.waitForFunction(()=>__chess.lastCompletedGameRecord?.mode==='experimental-b');
    await page.waitForFunction(()=>!document.querySelector('#overlay').classList.contains('hidden'));
    assert.deepEqual(await snapshot(page),initial);assert.equal(await page.locator('#btnShare').isVisible(),false);
    const savedRematchId=await page.evaluate(()=>__chess.lastCompletedGameRecord.id);
    await page.locator('#btnCustomRematchEnd').click();await page.waitForFunction(()=>__chess.history.length===0);
    assert.equal(await page.evaluate(()=>__chess.mode),'experimental-b');await page.waitForTimeout(1100);
    await move(page,{r:2,c:3},{r:2,c:4});
    await page.waitForFunction(id=>__chess.lastCompletedGameRecord?.id!==id&&__chess.lastCompletedGameRecord?.mode==='experimental-b',savedRematchId);
    await page.locator('#btnReviewGame').click();await page.locator('#btnGameReviewFirst').click();assert.match(await page.locator('#gameReviewMeta').innerText(),/挑戰級（試玩）/);
    assert.equal(await page.locator('#btnGameReviewCreatePuzzle').isDisabled(),true);await page.locator('#btnGameReviewLast').click();
    await page.screenshot({path:path.join(out,'session-review.png')});
    // Continue from a memory-only B record with the AI playing Red; it must
    // independently find the legal mate and retain B through rematch.
    const previousId=await page.evaluate(()=>__chess.lastCompletedGameRecord.id);
    await page.locator('#btnGameReviewFirst').click();await page.locator('#btnGameReviewContinue').click();
    assert.equal(await page.locator('#gameReviewContinuationDifficulty').inputValue(),'experimental-b');
    await page.locator('#gameReviewContinuationHumanSide').selectOption('black');
    await page.locator('#gameReviewContinuationDialog button[type="submit"]').click();
    await page.waitForFunction(id=>__chess.lastCompletedGameRecord?.id!==id&&__chess.lastCompletedGameRecord?.mode==='experimental-b',previousId);
    assert.equal(await page.evaluate(()=>__chess.lastCompletedGameRecord.result.winner),'red');
    assert.deepEqual(await snapshot(page),initial);
    const tracking=await page.evaluate(()=>qa);assert.equal(tracking.writes.filter(x=>x.b).length,0);assert.deepEqual(tracking.rejections,[]);assert.ok(tracking.responses.some(r=>r.data.metrics?.ttEntries>0),'Frozen B actually searched in the Worker');await writeFile(path.join(out,'tracking.json'),JSON.stringify(tracking,null,2));
    await page.reload();await ready(page);assert.equal(await page.evaluate(()=>__chess.lastCompletedGameRecord),null);assert.deepEqual(await snapshot(page),initial);
    await fresh(page,'experimental-b');await fresh(page,'hard');await page.waitForTimeout(750);assert.deepEqual(await snapshot(page),initial);
  });
  await check('rollback: old code reads, saves and deletes on the same origin/storage',async()=>{
    legacy=true;await page.reload();await ready(page);assert.equal(await page.locator('#modeSel option[value="experimental-b"]').count(),0);assert.deepEqual(await snapshot(page),initial);
    await page.evaluate(async()=>{const {createGameRecordStore}=await import('./game-record-store.js');const s=createGameRecordStore({storage:localStorage});const loaded=s.loadAll();if(loaded.issues.length)throw Error(JSON.stringify(loaded.issues));s.saveGameRecord({...loaded.records[0],id:'rollback-write-probe'});if(!s.deleteGameRecord('rollback-write-probe'))throw Error('delete failed');});
    assert.deepEqual(await snapshot(page),initial);
    await toolbar(page,'#btnSavedPositions');await page.waitForFunction(()=>document.querySelector('#savedPositionsDialog').dataset.storageState==='ACTIVE');assert.ok(await page.locator('[data-position-id="uat-position"]').count());await page.locator('#savedPositionsClose').click();
    await writeFile(path.join(out,'storage-after-rollback.json'),JSON.stringify(await snapshot(page),null,2));legacy=false;
  });
  await context.close();
  await check('real B worker cancellation on new game leaves no delayed move',async()=>{
    const c=await browser.newContext(),p=await c.newPage();p.setDefaultTimeout(15000);
    try{await p.goto(url);await ready(p);await fresh(p,'experimental-b');await move(p,{r:3,c:4},{r:4,c:4});await p.waitForFunction(()=>__chess.aiThinking);
      await p.locator('#btnNew').click();await p.waitForTimeout(5500);assert.equal(await p.evaluate(()=>__chess.history.length),0);assert.equal(await p.evaluate(()=>__chess.aiThinking),false);
    }finally{await c.close();}
  });
  for(const failure of ['constructor','network','throw','null','illegal','timeout','late-duplicate']){
    await check('worker safety: '+failure,async()=>{
      const c=await browser.newContext();const p=await c.newPage();p.setDefaultTimeout(15000);const localErrors=[];p.on('pageerror',e=>localErrors.push(e.message));
      if(failure==='constructor')await p.addInitScript(()=>{globalThis.Worker=class{constructor(){throw Error('test worker unavailable');}};});
      if(failure!=='constructor')await p.route('**/ai-worker.js*',async route=>{
        if(failure==='network')return route.abort();
        const code=failure==='throw'?'throw Error("injected worker error");':failure==='timeout'?'onmessage=()=>{};':failure==='null'?'onmessage=()=>postMessage(null);':failure==='illegal'?'onmessage=({data:d})=>postMessage({token:d.token,result:{from:{r:0,c:0},to:{r:9,c:8}}});':'onmessage=({data:d})=>{const reply={token:d.token,result:{from:{r:6,c:0},to:{r:5,c:0}}};setTimeout(()=>{postMessage(reply);postMessage(reply)},1200);};';
        await route.fulfill({contentType:'text/javascript',body:code});
      });
      try{await p.goto(url);await ready(p);await fresh(p,'experimental-b');await move(p,{r:3,c:4},{r:4,c:4});
        if(failure==='late-duplicate'){
          await p.waitForFunction(()=>__chess.history.length===2&&!__chess.busy);await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>__chess.history.length),2);
          await fresh(p,'experimental-b');await move(p,{r:3,c:4},{r:4,c:4});await p.waitForFunction(()=>__chess.aiThinking);await p.locator('#modeSel').selectOption('pvp');await p.waitForTimeout(1600);assert.equal(await p.evaluate(()=>__chess.history.length),0);
        }else{
          await p.waitForFunction(()=>!document.querySelector('#btnRetryExperimental').hidden);assert.equal(await p.evaluate(()=>__chess.history.length),1);assert.equal(await p.evaluate(()=>__chess.mode),'experimental-b');await p.waitForTimeout(300);assert.equal(await p.evaluate(()=>__chess.aiThinking),false);
          await p.screenshot({path:path.join(out,'worker-'+failure+'.png')});
          if(failure==='network'){await p.unroute('**/ai-worker.js*');await p.locator('#btnRetryExperimental').click();await p.waitForFunction(()=>__chess.history.length===2&&!__chess.aiThinking&&!__chess.busy);}
        }
        assert.deepEqual(localErrors,[]);
      }finally{await c.close();}
    });
  }
  await check('mobile size 390x844: B red, B black, real move, undo, no overflow',async()=>{
    const c=await browser.newContext({viewport:{width:390,height:844}}),p=await c.newPage();p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));
    try{await p.goto(url);await ready(p);await fresh(p,'experimental-b');assert.equal(await p.locator('#experimentalNotice').isVisible(),true);
      await move(p,{r:3,c:4},{r:4,c:4});await p.waitForFunction(()=>__chess.history.length===2&&!__chess.busy&&!__chess.aiThinking);
      await toolbar(p,'#btnUndo');await p.waitForFunction(()=>__chess.history.length===0);
      await p.locator('label[for="humanSideBlack"]').click();await p.waitForFunction(()=>__chess.history.length===1&&!__chess.busy&&!__chess.aiThinking);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await p.screenshot({path:path.join(out,'mobile-b.png')});
    }finally{await c.close();}
  });
  assert.deepEqual(errors,[]);if(fatal)throw Error(fatal);
  await writeFile(path.join(out,'result.json'),JSON.stringify({status:'PASS',url,version:browser.version(),results,errors,cpuStart,cpuEnd:await browserCDP.send('SystemInfo.getProcessInfo'),samples,realDevice:false,peakMemory:'UNVERIFIED'},null,2));
}catch(e){await writeFile(path.join(out,'failure.json'),JSON.stringify({error:String(e),stack:e.stack,results,errors,samples,fatal},null,2));if(page&&!page.isClosed())await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw e;}
finally{monitoring=false;clearInterval(monitor);clearTimeout(batchWatchdog);await browser.close();await new Promise(r=>server.close(r));}
