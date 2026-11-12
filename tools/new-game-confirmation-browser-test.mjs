// Real Three.js artifact, isolated Chrome profiles, synthetic data only.
// PLAYWRIGHT_MODULE=... node tools/new-game-confirmation-browser-test.mjs SITE NEW_EVIDENCE_DIR [--compat-only BASELINE_SOURCE]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkArtifact, sourceRoot } from './check-pages-artifact.mjs';
import { terminal } from './game-transfer-fixtures.mjs';
import { parseGameTransfer } from '../game-transfer/game-transfer.js';
const site=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);
assert.ok(out!==sourceRoot&&!out.startsWith(sourceRoot+path.sep));await checkArtifact(site);await mkdir(out,{recursive:false});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const prefix='/chinese-chess-training/',results=[],errors=[],warnings=[],httpErrors=[];
const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}assert.ok(pathname.startsWith(prefix));
 const file=path.resolve(site,pathname.slice(prefix.length)||'index.html');assert.ok(file.startsWith(site+path.sep));
 const bytes=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'})[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
}catch{res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}${prefix}`,browser=await chromium.launch({headless:true,channel:'chrome'});
const watchdog=setTimeout(()=>void browser.close(),480000);let currentPage;
const idle=async p=>{await p.waitForFunction(()=>window.__chess&&!__chess.busy&&!__chess.aiThinking);await p.waitForTimeout(800);};
const state=p=>p.evaluate(()=>({session:__chess.normalGameRecordSession,mode:__chess.mode,side:__chess.humanSide,
 board:__chess.board,turn:__chess.turn,history:__chess.history,completed:__chess.lastCompletedGameRecord,
 error:__chess.normalGameRecordError}));
const dialog=p=>p.locator('#newGameConfirmDialog');
const cancel=p=>p.locator('#btnNewGameCancel').click();
const accept=p=>p.locator('#btnNewGameConfirm').click();
const menu=async(p,id)=>{if(!await p.locator(id).isVisible())await p.locator('#btnMore').click();await p.locator(id).click();};
const reset=async(p,mode='pvp')=>{await p.evaluate(mode=>{u0.hold=false;u0.held=[];__chess.newGame();__chess.setMode(mode);},mode);await idle(p);};
const oneMove=async p=>{await p.evaluate(()=>__chess.doMove({r:3,c:0},{r:4,c:0}));await idle(p);};
const check=async(name,fn)=>{await fn();results.push({name,status:'PASS'});console.log('PASS '+name);};
const singleSession=(before,after)=>{assert.notEqual(after.session.id,before.session.id);assert.equal(after.session.modeRevision,before.session.modeRevision+1);};
async function mate(p,mode){await reset(p,mode);await p.evaluate(t=>{__chess.resetTo(t.initialPosition.board,t.initialPosition.sideToMove);__chess.doMove(t.moves[0].from,t.moves[0].to);},terminal());await p.locator('#overlay').waitFor({state:'visible'});}
async function clickCell(p,r,c){const pt=await p.evaluate(({r,c})=>{const x=__chess,b=x.renderer.domElement.getBoundingClientRect(),v=x.camera.position.clone().set(c-4,.18,4.5-r).project(x.camera);return{x:b.x+(v.x+1)*b.width/2,y:b.y+(1-v.y)*b.height/2};},{r,c});await p.mouse.click(pt.x,pt.y);}
try{
 for(const viewport of (process.argv[4]==='--compat-only'?[]:[{width:1440,height:1000},{width:390,height:844},{width:320,height:568}])){
  const label=String(viewport.width),ctx=await browser.newContext({viewport,acceptDownloads:true});
  await ctx.addInitScript(()=>{window.u0={hold:false,held:[],stops:0};const Native=Worker;
   window.Worker=class{constructor(url,options){if(!String(url).includes('ai-worker.js'))return new Native(url,options);
    this.inner=new Native(url,options);this.inner.onmessage=e=>{const callback=this.onmessage,data=e.data;if(u0.hold)u0.held.push(()=>callback?.({data}));else callback?.({data});};
    this.inner.onerror=e=>this.onerror?.(e);this.inner.onmessageerror=e=>this.onmessageerror?.(e);}
    postMessage(...args){this.inner.postMessage(...args);}terminate(){u0.stops++;this.inner.terminate();}};
  });
  const p=currentPage=await ctx.newPage();p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push({label,error:e.message}));p.on('console',m=>{if(['warning','error'].includes(m.type()))warnings.push({label,type:m.type(),text:m.text()});});p.on('response',r=>{if(r.status()>=400)httpErrors.push({label,url:r.url(),status:r.status()});});
  await p.goto(url);await idle(p);await p.waitForFunction(()=>!document.querySelector('#btnGameExport').hidden);
  await check(label+' page identity and actual WebGL board',async()=>{assert.equal(await p.title(),'中國象棋殺局訓練 · Xiangqi Mate Puzzle');assert.ok(await p.locator('#stage canvas').isVisible());assert.equal(await p.evaluate(()=>__chess.pieces.length),32);});
  await check(label+' standard zero-ply mode/side/new game bypass confirmation',async()=>{
   await p.locator('#modeSel').selectOption('easy');assert.equal(await dialog(p).evaluate(d=>d.open),false);
   await p.locator('label[for="humanSideBlack"]').click();assert.equal(await dialog(p).evaluate(d=>d.open),false);await idle(p);
   assert.equal((await state(p)).side,'black');await reset(p);const before=await state(p);await p.locator('#btnNew').click();singleSession(before,await state(p));assert.equal(await dialog(p).evaluate(d=>d.open),false);
  });
  await check(label+' pvp one ply: mode cancel preserves state, duplicate confirm creates one session',async()=>{
   await idle(p);
   await clickCell(p,3,0);await clickCell(p,4,0);await idle(p);assert.equal((await state(p)).history.length,1);const before=await state(p);
   await p.locator('#modeSel').selectOption('easy');assert.equal(await dialog(p).evaluate(d=>d.open),true);assert.deepEqual(await state(p),before);assert.equal(await p.locator('#modeSel').inputValue(),'pvp');
   assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNewGameCancel');await p.screenshot({path:path.join(out,label+'-confirmation.png')});
   const box=await dialog(p).boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height);
   await cancel(p);assert.deepEqual(await state(p),before);assert.equal(await p.evaluate(()=>document.activeElement.id),'modeSel');
   await p.locator('#modeSel').selectOption('easy');await p.evaluate(()=>{const form=document.querySelector('#newGameConfirmForm');form.requestSubmit();form.requestSubmit();});const after=await state(p);singleSession(before,after);assert.equal(after.mode,'easy');assert.equal(after.history.length,0);
  });
  await check(label+' AI progress side-change cancel and confirm',async()=>{
   await oneMove(p);const before=await state(p);assert.equal(before.history.length,2);await p.locator('label[for="humanSideBlack"]').click();
   assert.deepEqual(await state(p),before);assert.equal(await p.locator('#humanSideRed').isChecked(),true);await cancel(p);assert.deepEqual(await state(p),before);
   await p.locator('label[for="humanSideBlack"]').click();await accept(p);singleSession(before,await state(p));assert.equal((await state(p)).side,'black');await idle(p);assert.equal((await state(p)).history.length,1);
  });
  await check(label+' new-game cancel/confirm and Escape keyboard focus',async()=>{
   await reset(p);await oneMove(p);const before=await state(p);await p.locator('#btnNew').click();await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNewGameConfirm');
   const focusRing=await p.evaluate(()=>{const s=getComputedStyle(document.activeElement);return{style:s.outlineStyle,width:parseFloat(s.outlineWidth)};});assert.notEqual(focusRing.style,'none');assert.ok(focusRing.width>0);await p.screenshot({path:path.join(out,label+'-keyboard-focus.png')});
   await p.keyboard.press('Shift+Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNewGameCancel');
   await p.keyboard.press('Escape');assert.equal(await dialog(p).evaluate(d=>d.open),false);assert.deepEqual(await state(p),before);assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNew');
   await p.locator('#btnNew').click();await p.evaluate(()=>{document.querySelector('#newGameConfirmDialog').dispatchEvent(new Event('cancel',{cancelable:true}));document.querySelector('#btnNew').click();});
   await p.waitForTimeout(100);assert.equal(await dialog(p).evaluate(d=>d.open),true);assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNewGameCancel');assert.deepEqual(await state(p),before);await p.keyboard.press('Tab');await p.keyboard.press('Enter');singleSession(before,await state(p));
  });
  await check(label+' terminal Again retains completed record on cancel',async()=>{
   await mate(p,'pvp');const before=await state(p);await p.locator('#btnAgain').click();await cancel(p);assert.deepEqual(await state(p),before);assert.equal(await p.evaluate(()=>document.activeElement.id),'btnAgain');await p.locator('#btnAgain').click();await accept(p);singleSession(before,await state(p));assert.equal((await state(p)).history.length,0);
  });
  await check(label+' custom root and nonstandard starting position protected at zero ply',async()=>{
   // Even a standard-looking board started through the custom workflow owns a root.
   // This avoids depending on tiny editor hit targets in the 320px U0 test.
   await reset(p,'easy');await menu(p,'#btnEditor');await p.locator('#btnEditorStandard').click();
   await p.locator('#btnEditorConfirm').click();await p.locator('#btnCustomPlay').click();await p.locator('#customPlayDifficulty').selectOption('easy');await p.locator('#customPlayHumanSide').selectOption('red');await p.locator('#customPlayForm button[type="submit"]').click();
   const before=await state(p);assert.equal(before.history.length,0);await p.locator('#btnNew').click();assert.equal(await dialog(p).evaluate(d=>d.open),true);await cancel(p);assert.deepEqual(await state(p),before);
   await p.locator('#btnNew').click();await accept(p);singleSession(before,await state(p));assert.equal(await p.evaluate(()=>__chess.pieces.length),32);
   await p.evaluate(t=>__chess.resetTo(t.initialPosition.board,t.initialPosition.sideToMove),terminal());
   const nonstandard=await state(p);assert.equal(nonstandard.history.length,0);await p.locator('#btnNew').click();
   assert.equal(await dialog(p).evaluate(d=>d.open),true);await cancel(p);assert.deepEqual(await state(p),nonstandard);
  });
  await check(label+' challenge terminal record survives cancel and still exports JSON/TXT',async()=>{
   const key='chinese-chess-training:game-records:v1',stored=await p.evaluate(k=>localStorage.getItem(k),key);await mate(p,'experimental-b');const before=await state(p);assert.equal(before.completed.mode,'experimental-b');
   await p.locator('#btnAgain').click();await p.keyboard.press('Escape');assert.deepEqual(await state(p),before);assert.equal(await p.evaluate(k=>localStorage.getItem(k),key),stored);
   await p.locator('#btnGameExportEnd').click();for(const format of ['json','txt']){const event=p.waitForEvent('download');await p.locator(`[data-export-format="${format}"]`).click();const d=await event,file=path.join(out,label+'-challenge.'+format);await d.saveAs(file);assert.equal(await d.failure(),null);if(format==='json')assert.equal(parseGameTransfer(await readFile(file)).document.mode,'experimental-b');}
   await p.locator('#gameExportClose').click();await p.locator('#btnAgain').click();await accept(p);singleSession(before,await state(p));assert.equal((await state(p)).mode,'experimental-b');
  });
  await check(label+' cancel never terminates original AI; reply invalidates open confirmation',async()=>{
   await reset(p,'easy');await p.evaluate(()=>{u0.hold=true;__chess.doMove({r:3,c:0},{r:4,c:0});});await p.waitForFunction(()=>u0.held.length===1);const before=await state(p),stops=await p.evaluate(()=>u0.stops);
   await p.locator('#btnNew').click();await cancel(p);assert.deepEqual(await state(p),before);assert.equal(await p.evaluate(()=>u0.stops),stops);assert.equal(await p.evaluate(()=>__chess.aiThinking),true);
   await p.locator('#btnNew').click();await p.evaluate(()=>{u0.hold=false;for(const fn of u0.held.splice(0))fn();});await idle(p);assert.equal((await state(p)).session.id,before.session.id);assert.equal((await state(p)).history.length,2);assert.equal(await dialog(p).evaluate(d=>d.open),false);
   const updated=await state(p);await p.locator('#newGameConfirmForm').dispatchEvent('submit');assert.deepEqual(await state(p),updated);
  });
  await check(label+' confirm while AI pending rejects late reply from discarded session',async()=>{
   await reset(p,'easy');await p.evaluate(()=>{u0.hold=true;__chess.doMove({r:3,c:0},{r:4,c:0});});await p.waitForFunction(()=>u0.held.length===1);const before=await state(p);await p.locator('#btnNew').click();await accept(p);const fresh=await state(p);singleSession(before,fresh);
   await p.evaluate(()=>{u0.hold=false;for(const fn of u0.held.splice(0)){fn();fn();}});await p.waitForTimeout(650);assert.deepEqual(await state(p),fresh);
  });
  await check(label+' animation cancellation preserves progress; confirmation clears old animation',async()=>{
   await reset(p);const observed=await p.evaluate(()=>{__chess.doMove({r:3,c:0},{r:4,c:0});const session=__chess.normalGameRecordSession.id,board=JSON.stringify(__chess.board);document.querySelector('#btnNew').click();const opened=document.querySelector('#newGameConfirmDialog').open;document.querySelector('#btnNewGameCancel').click();return{opened,preserved:session===__chess.normalGameRecordSession.id&&board===JSON.stringify(__chess.board),busy:__chess.busy};});assert.deepEqual(observed,{opened:true,preserved:true,busy:true});await idle(p);
   await reset(p);const before=await state(p);await p.evaluate(()=>{__chess.doMove({r:3,c:0},{r:4,c:0});document.querySelector('#btnNew').click();document.querySelector('#newGameConfirmForm').requestSubmit();});await p.waitForTimeout(800);singleSession(before,await state(p));assert.equal((await state(p)).history.length,0);
  });
  await check(label+' stale session and in-place history mutations cannot authorize new game',async()=>{
   await reset(p);await oneMove(p);await p.locator('#btnNew').click();await p.evaluate(()=>__chess.newGame());const fresh=await state(p);await p.locator('#newGameConfirmForm').dispatchEvent('submit');assert.deepEqual(await state(p),fresh);
   await oneMove(p);await p.locator('#btnNew').click();await p.evaluate(()=>__chess.history[0].nota='synthetic changed history');const changed=await state(p);await p.locator('#newGameConfirmForm').dispatchEvent('submit');assert.deepEqual(await state(p),changed);assert.equal(await dialog(p).evaluate(d=>d.open),false);await reset(p);
  });
  await check(label+' saved position and import/review/continuation dialogs retain independent semantics',async()=>{
   await reset(p,'easy');await oneMove(p);await menu(p,'#btnSaveCurrentPosition');await p.locator('#savedPositionTitle').fill('U0 synthetic position');await p.locator('#savedPositionSubmit').click();await p.waitForFunction(()=>document.querySelector('#savedPositionsNotice').textContent.includes('已'));await p.locator('#savedPositionsClose').click();
   await menu(p,'#btnGameRecords');await p.locator('#btnGameImport').click();const before=await state(p);await p.locator('#gameImportFile').setInputFiles(path.join(out,label+'-challenge.json'));await p.waitForFunction(()=>!document.querySelector('#gameImportConfirm').disabled);await p.keyboard.press('Escape');assert.deepEqual(await state(p),before);
   await p.locator('#btnGameImport').click();await p.locator('#gameImportFile').setInputFiles(path.join(out,label+'-challenge.json'));await p.waitForFunction(()=>!document.querySelector('#gameImportConfirm').disabled);await p.locator('#gameImportConfirm').click();await p.locator('#btnGameReviewNext').click();await p.locator('#btnGameReviewPrevious').click();await p.locator('#btnGameReviewContinue').click();await p.keyboard.press('Escape');assert.equal(await p.evaluate(()=>__chess.appState),'GAME_REVIEW');
   await p.locator('#btnGameReviewContinue').click();await p.locator('#gameReviewContinuationDifficulty').selectOption('easy');await p.locator('#gameReviewContinuationHumanSide').selectOption('red');await p.locator('#gameReviewContinuationForm button[type="submit"]').click();assert.equal(await dialog(p).evaluate(d=>d.open),false);assert.equal((await state(p)).history.length,0);assert.deepEqual((await state(p)).session.initialPosition,terminal().initialPosition);
  });
  await ctx.close();
 }
 if(process.argv[4]==='--compat-only'){
  const oldRoot=path.resolve(process.argv[5]);
  for(const variant of ['old-html','old-js'])await check('cache '+variant,async()=>{
   const ctx=await browser.newContext({viewport:{width:390,height:844}}),p=currentPage=await ctx.newPage();
   p.on('pageerror',e=>errors.push({variant,error:e.message}));
   if(variant==='old-html')await p.route('**/chinese-chess-training/',r=>r.fulfill({contentType:'text/html',path:path.join(oldRoot,'index.html')}));
   else await p.route('**/main.js?*',r=>r.fulfill({contentType:'text/javascript',path:path.join(oldRoot,'main.js')}));
   await p.goto(url);await idle(p);assert.equal(await p.evaluate(()=>__chess.pieces.length),32);await oneMove(p);const before=await state(p);
   await p.locator('#modeSel').selectOption('pvp');
   if(variant==='old-html'){assert.deepEqual(await state(p),before);assert.equal(await p.locator('#modeSel').inputValue(),before.mode);assert.match(await p.locator('#toast').innerText(),/目前棋局已保留/);}
   else {assert.equal((await state(p)).history.length,0);results.push({name:'old JS retains baseline behavior; reload current assets for U0 protection',status:'LEGACY_NOT_PROTECTED'});}
   await ctx.close();
  });
 }
 assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);
}catch(e){results.push({name:'failure',status:'FAIL',error:e.stack});process.exitCode=1;console.error(e);if(currentPage&&!currentPage.isClosed())await currentPage.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{clearTimeout(watchdog);await writeFile(path.join(out,'result.json'),JSON.stringify({url,chrome:browser.version(),results,errors,warnings,httpErrors},null,2));await browser.close();await new Promise(r=>server.close(r));}
