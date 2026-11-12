// Artifact-only, isolated Chrome contexts. Downloads and evidence stay outside the checkout.
// PLAYWRIGHT_MODULE=... node tools/game-export-browser-test.mjs SITE NEW_EVIDENCE_DIR [OLD_SOURCE]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseGameTransfer, serializeGameTransferTXT } from '../game-transfer/game-transfer.js';
import { terminal, longGame } from './game-transfer-fixtures.mjs';
import { checkArtifact } from './check-pages-artifact.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const site=path.resolve(process.argv[2]), out=path.resolve(process.argv[3]), old=process.argv[4] && path.resolve(process.argv[4]);
assert.ok(out!==root && !out.startsWith(root+path.sep));await mkdir(out,{recursive:false});
await checkArtifact(site);
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const prefix='/chinese-chess-training/', recordKey='chinese-chess-training:game-records:v1';
const served=[],results=[],errors=[];let mixed=null,currentPage,downloadIndex=0;
const server=createServer(async(req,res)=>{
  try {
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(!pathname.startsWith(prefix))throw Error('outside prefix');
    const rel=pathname.slice(prefix.length)||'index.html';
    const from=old && ((mixed==='old-html'&&rel==='index.html')||(mixed==='old-js'&&rel.endsWith('.js'))) ? old : site;
    const file=path.resolve(from,rel);if(!file.startsWith(from+path.sep))throw Error('outside site');
    const bytes=await readFile(file);served.push({rel,url:req.url,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mixed});
    res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(rel)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}${prefix}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {channel:'chrome'})});
const watchdog=setTimeout(()=>void browser.close(),600000);
const check=async(name,fn)=>{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);};
const idle=p=>p.waitForFunction(()=>window.__chess && !__chess.busy && !__chess.aiThinking);
const toolbar=async(p,id)=>{if(!await p.locator(id).isVisible())await p.locator('#btnMore').click();await p.locator(id).click();};
const closeExport=async p=>{if(await p.locator('#gameExportDialog').evaluate(d=>d.open))await p.locator('#gameExportClose').click();};
async function openExport(p,id='#btnGameExport'){await toolbar(p,id);await p.locator('#gameExportDialog').waitFor({state:'visible'});}
async function chooseMode(p,mode){
  await p.locator('#modeSel').selectOption(mode);
  if(await p.locator('#newGameConfirmDialog').evaluate(d=>d.open))await p.locator('#btnNewGameConfirm').click();
}
async function download(p,format){
  const started=performance.now();const event=p.waitForEvent('download');await p.locator(`[data-export-format="${format}"]`).click();
  const d=await event;const target=path.join(out,`${++downloadIndex}-${d.suggestedFilename()}`);await d.saveAs(target);assert.equal(await d.failure(),null);
  const bytes=await readFile(target);results.push({name:'actual '+format+' download',filename:path.basename(target),bytes:bytes.length,ms:performance.now()-started,status:'PASS'});
  return {text:bytes.toString('utf8'),bytes};
}
async function pair(p){
  const json=await download(p,'json'),parsed=parseGameTransfer(json.bytes),txt=await download(p,'txt');
  assert.equal(txt.text,serializeGameTransferTXT(parsed.document));assert.equal(json.text.endsWith('\n'),true);
  assert.doesNotMatch(json.text,/sessionId|modeRevision|photo|private-session/);return parsed.document;
}
async function pieceClick(p,r,c){
  const pt=await p.evaluate(({r,c})=>{const x=__chess,rect=x.renderer.domElement.getBoundingClientRect(),v=x.camera.position.clone().set(c-4,.18,4.5-r).project(x.camera);return {x:rect.x+(v.x+1)*rect.width/2,y:rect.y+(1-v.y)*rect.height/2};},{r,c});
  await p.mouse.click(pt.x,pt.y);
}
try {
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const label=viewport.width===1440?'desktop':'mobile-emulation',context=await browser.newContext({viewport,acceptDownloads:true});
    await context.addInitScript(()=>{
      window.exportQA={downloads:0,writes:[],held:[],fault:null,failAI:false,blockRecordStore:false,posts:[]};
      const set=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){exportQA.writes.push(key);if(exportQA.blockRecordStore && key==='chinese-chess-training:game-records:v1')throw Error('synthetic storage failure');return set.call(this,key,value);};
      const Native=Worker;
      window.Worker=class {
        constructor(url,options){
          const transfer=String(url).includes('game-transfer/validation-worker.js'),fault=transfer?exportQA.fault:null;
          if(!fault){const worker=new Native(url,options);const post=worker.postMessage.bind(worker);worker.postMessage=(data,...args)=>{exportQA.posts.push({url:String(url),level:data.level});if(!transfer&&exportQA.failAI)throw Error('synthetic AI Worker failure');return post(data,...args);};return worker;}
          if(fault==='startup')throw Error('synthetic validator startup failure');
          this.inner=fault==='timeout'?null:new Native(url,options);
          if(this.inner){this.inner.onerror=e=>this.onerror?.(e);this.inner.onmessageerror=e=>this.onmessageerror?.(e);
            this.inner.onmessage=e=>{const handler=this.onmessage;if(fault==='hold')exportQA.held.push(()=>handler?.(e));else if(fault==='duplicate'){handler?.(e);handler?.(e);}else if(fault==='malformed')handler?.({data:{...e.data,value:{document:{},replay:{}}}});else if(fault==='error')this.onerror?.({preventDefault(){}});};}
        }
        postMessage(data){this.inner?.postMessage(data);}
        terminate(){this.inner?.terminate();}
      };
    });
    const p=currentPage=await context.newPage();p.setDefaultTimeout(25000);p.on('download',()=>void p.evaluate(()=>exportQA.downloads++).catch(()=>{}));
    p.on('pageerror',e=>errors.push({label,text:e.message}));p.on('console',m=>{if(m.type()==='error')errors.push({label,text:m.text()});});
    await p.goto(url);await idle(p);await p.waitForFunction(()=>!document.querySelector('#btnGameExport').hidden);
    assert.match(await p.title(),/中國象棋/);assert.equal(await p.locator('#stage canvas').count(),1);
    for(const mode of ['easy','medium','hard','experimental-b','pvp'])await check(`${label}: ${mode} zero-ply JSON/TXT`,async()=>{
      await chooseMode(p,mode);await idle(p);await openExport(p);
      assert.match(await p.locator('#gameExportSummary').textContent(),/0 著・未完成/);
      const data=await pair(p);assert.equal(data.mode,mode);assert.equal(data.playerSide,mode==='pvp'?null:'red');assert.equal(data.moves.length,0);
      if(mode==='experimental-b')await p.screenshot({path:path.join(out,label+'-export.png')});
      await closeExport(p);
    });
    await check(`${label}: confirmed plies, animation block and undo`,async()=>{
      await p.evaluate(()=>{__chess.newGame();__chess.doMove({r:3,c:4},{r:4,c:4});});
      assert.equal(await p.locator('#btnGameExport').isDisabled(),true);await idle(p);
      await p.evaluate(()=>__chess.doMove({r:6,c:4},{r:5,c:4}));await idle(p);
      await p.locator('#btnUndo').click();await idle(p);await openExport(p);const d=await pair(p);assert.equal(d.moves.length,1);assert.deepEqual(d.moves[0],{from:{r:3,c:4},to:{r:4,c:4}});await closeExport(p);
    });
    await check(`${label}: real editor nonstandard challenge start, AI move and Session-only export`,async()=>{
      await toolbar(p,'#btnEditor');await p.locator('#btnEditorStandard').click();await p.locator('#btnEditorErase').click();await pieceClick(p,3,0);
      await p.locator('#btnEditorConfirm').click();await p.locator('#btnCustomPlay').click();await p.locator('#customPlayDifficulty').selectOption('experimental-b');await p.locator('#customPlayForm button[type="submit"]').click();await idle(p);
      await p.evaluate(()=>__chess.doMove({r:3,c:4},{r:4,c:4}));
      await p.waitForFunction(()=>__chess.aiThinking);assert.equal(await p.locator('#btnGameExport').isDisabled(),true);await idle(p);
      const before=await p.evaluate(key=>({session:__chess.normalGameRecordSession,mode:__chess.mode,stored:localStorage.getItem(key),writes:exportQA.writes.filter(k=>k===key).length}),recordKey);
      await openExport(p);const d=await pair(p);assert.equal(d.initialPosition.board[3][0],null);assert.equal(d.moves.length,2);assert.equal(d.mode,'experimental-b');await closeExport(p);
      assert.deepEqual(await p.evaluate(key=>({session:__chess.normalGameRecordSession,mode:__chess.mode,stored:localStorage.getItem(key),writes:exportQA.writes.filter(k=>k===key).length}),recordKey),before);
    });
    await check(`${label}: black-first nonstandard game and known player ownership`,async()=>{
      const data=longGame(1,'black');await p.evaluate(d=>{__chess.newGame();__chess.setMode('hard');__chess.resetTo(d.initialPosition.board,'black');__chess.doMove(d.moves[0].from,d.moves[0].to);},data);await idle(p);
      await openExport(p);const d=await pair(p);assert.equal(d.initialPosition.sideToMove,'black');assert.equal(d.playerSide,'red');await closeExport(p);
    });
    await check(`${label}: stable B AI Worker failure still permits confirmed timeline export`,async()=>{
      await chooseMode(p,'experimental-b');await p.evaluate(()=>{exportQA.failAI=true;__chess.doMove({r:3,c:4},{r:4,c:4});});
      await p.waitForFunction(()=>!document.querySelector('#btnRetryExperimental').hidden);await idle(p);await openExport(p);
      const d=await pair(p);assert.equal(d.mode,'experimental-b');assert.equal(d.status,'in-progress');assert.equal(d.moves.length,1);await closeExport(p);await p.evaluate(()=>exportQA.failAI=false);
    });
    for(const mode of ['hard','experimental-b'])await check(`${label}: completed ${mode}, storage failure retains memory export`,async()=>{
      await p.evaluate(({d,mode})=>{__chess.newGame();__chess.setMode(mode);__chess.resetTo(d.initialPosition.board,d.initialPosition.sideToMove);exportQA.blockRecordStore=true;__chess.doMove(d.moves[0].from,d.moves[0].to);},{d:terminal(),mode});await idle(p);
      await p.locator('#overlay').waitFor({state:'visible'});await openExport(p,'#btnGameExportEnd');const d=await pair(p);assert.equal(d.status,'completed');assert.deepEqual(d.result,terminal().result);assert.equal(d.mode,mode);await closeExport(p);
      await p.locator('#btnReviewGame').click();await p.locator('#btnGameReviewFirst').click();await openExport(p,'#btnGameReviewExport');const review=await pair(p);assert.equal(review.moves.length,1);assert.equal(review.playerSide,'red');await closeExport(p);
      await p.evaluate(()=>{__chess.exitGameRecordFlow();exportQA.blockRecordStore=false;__chess.newGame();});await idle(p);
    });
    await check(`${label}: old stored record exports whole game with null playerSide at earlier ply`,async()=>{
      const d=terminal('threefold-repetition');await p.evaluate(async d=>{const {createGameRecordStore}=await import('./game-record-store.js');createGameRecordStore({storage:localStorage}).saveGameRecord({schemaVersion:1,id:'synthetic-old-record',createdAt:d.exportedAt,completedAt:d.exportedAt,initialPosition:d.initialPosition,moves:d.moves,mode:'hard',result:d.result});__chess.enterGameRecordLibrary();__chess.openStoredGameReview('synthetic-old-record');},d);
      await p.locator('#btnGameReviewFirst').click();await openExport(p,'#btnGameReviewExport');const exported=await pair(p);assert.equal(exported.moves.length,8);assert.equal(exported.playerSide,null);await closeExport(p);
      await p.evaluate(()=>{__chess.exitGameRecordFlow();__chess.newGame();__chess.setMode('pvp');});await idle(p);
    });
    await check(`${label}: cancel, new-session invalidation and retained late callbacks`,async()=>{
      for(const action of ['cancel','new-game']){
        await p.evaluate(()=>exportQA.fault='hold');await openExport(p);const count=await p.evaluate(()=>exportQA.downloads);
        await p.locator('[data-export-format="json"]').click();await p.waitForFunction(()=>exportQA.held.length>0);
        if(action==='cancel')await closeExport(p);else await p.evaluate(()=>__chess.newGame());
        await p.evaluate(()=>{for(const fn of exportQA.held.splice(0))fn();exportQA.fault=null;});await p.waitForTimeout(200);
        assert.equal(await p.evaluate(()=>exportQA.downloads),count);assert.equal(await p.locator('#gameExportDialog').evaluate(d=>d.open),false);
      }
      await openExport(p);await download(p,'json');await closeExport(p);
    });
    await check(`${label}: duplicate callback downloads once`,async()=>{
      await p.evaluate(()=>exportQA.fault='duplicate');const before=await p.evaluate(()=>exportQA.downloads);await openExport(p);await download(p,'json');await p.waitForTimeout(150);
      assert.equal(await p.evaluate(()=>exportQA.downloads),before+1);assert.equal(await p.locator('[data-export-format="json"]').isDisabled(),true);
      await p.locator('[data-export-format="json"]').dispatchEvent('click');await p.waitForTimeout(100);
      assert.equal(await p.evaluate(()=>exportQA.downloads),before+1);await closeExport(p);await p.evaluate(()=>exportQA.fault=null);
    });
    for(const [fault,message] of [['startup','無法啟動'],['malformed','回應'],['error','無法啟動'],['timeout','10 秒']])await check(`${label}: ${fault} shows Chinese failure, no download`,async()=>{
      await p.evaluate(f=>exportQA.fault=f,fault);const before=await p.evaluate(()=>exportQA.downloads);await openExport(p);await p.locator('[data-export-format="json"]').click();
      await p.waitForFunction(text=>document.querySelector('#gameExportStatus').textContent.includes(text),message);assert.equal(await p.evaluate(()=>exportQA.downloads),before);
      assert.equal(await p.locator('[data-export-format="json"]').isDisabled(),false);await closeExport(p);await p.evaluate(()=>exportQA.fault=null);
    });
    await check(`${label}: pagehide cancels retained Worker result`,async()=>{
      await p.evaluate(()=>exportQA.fault='hold');await openExport(p);const count=await p.evaluate(()=>exportQA.downloads);
      await p.locator('[data-export-format="json"]').click();await p.waitForFunction(()=>exportQA.held.length>0);
      await p.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));for(const fn of exportQA.held.splice(0))fn();exportQA.fault=null;dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
      await p.waitForFunction(()=>!document.querySelector('#btnGameExport').hidden);assert.equal(await p.evaluate(()=>exportQA.downloads),count);
      await openExport(p);await download(p,'json');await closeExport(p);
    });
    await check(`${label}: live board inconsistency and completed fail-closed never download`,async()=>{
      await p.evaluate(()=>{__chess.newGame();__chess.board[3][0]=null;});await openExport(p);const count=await p.evaluate(()=>exportQA.downloads);
      await p.locator('[data-export-format="json"]').click();await p.waitForFunction(()=>document.querySelector('#gameExportStatus').textContent.includes('棋盤與棋譜不一致'));
      assert.equal(await p.evaluate(()=>exportQA.downloads),count);await closeExport(p);
      await p.evaluate(()=>{__chess.newGame();__chess.doMove({r:3,c:4},{r:4,c:4});});await idle(p);
      await p.evaluate(()=>__chess.history[0].to={r:5,c:4});await openExport(p);await p.locator('[data-export-format="json"]').click();
      await p.waitForFunction(()=>document.querySelector('#gameExportStatus').textContent.includes('第 1 著無法通過驗證'));
      assert.equal(await p.evaluate(()=>exportQA.downloads),count);await closeExport(p);
      await p.evaluate(d=>{__chess.resetTo(d.initialPosition.board,d.initialPosition.sideToMove);__chess.doMove(d.moves[0].from,d.moves[0].to);__chess.history[0].from={r:0,c:0};},terminal());
      await idle(p);assert.ok(await p.evaluate(()=>__chess.normalGameRecordError));assert.equal(await p.locator('#btnGameExportEnd').isDisabled(),true);
      assert.equal(await p.locator('#btnGameExport').isDisabled(),true);assert.equal(await p.evaluate(()=>exportQA.downloads),count);
      await p.evaluate(()=>__chess.newGame());await idle(p);
    });
    await p.screenshot({path:path.join(out,label+'-board.png')});await context.close();
  }
  if(old)for(const kind of ['old-html','old-js'])await check(`mixed ${kind}: export unavailable, normal game remains usable`,async()=>{
    mixed=kind;const context=await browser.newContext({viewport:{width:1440,height:1000}}),p=currentPage=await context.newPage();await p.goto(url);await idle(p);
    const controls=p.locator('[data-game-export]');for(const b of await controls.all()){assert.equal(await b.isVisible(),false);assert.equal(await b.isDisabled(),true);}
    await p.locator('#modeSel').selectOption('pvp');await p.evaluate(()=>__chess.doMove({r:3,c:4},{r:4,c:4}));await idle(p);assert.equal(await p.evaluate(()=>__chess.history.length),1);await context.close();mixed=null;
  });
  assert.deepEqual(errors,[]);
  const transfers=served.filter(x=>x.rel.startsWith('game-transfer/')&&x.rel.endsWith('.js')&&!x.mixed);
  assert.ok(transfers.some(x=>x.rel==='game-transfer/validation-worker.js'));
  const version=(await readFile(path.join(site,'index.html'),'utf8')).match(/main\.js\?v=([a-f0-9]+)/)[1];
  for(const item of transfers)assert.ok(item.url.endsWith('?v='+version),'unversioned transfer runtime: '+item.url);
}catch(error){results.push({status:'FAIL',error:error.stack});console.error(error);process.exitCode=1;if(currentPage&&!currentPage.isClosed())await currentPage.screenshot({path:path.join(out,'failure.png')});}
finally{clearTimeout(watchdog);await writeFile(path.join(out,'result.json'),JSON.stringify({url,chrome:browser.version(),results,errors,served},null,2));await browser.close();await new Promise(r=>server.close(r));}
