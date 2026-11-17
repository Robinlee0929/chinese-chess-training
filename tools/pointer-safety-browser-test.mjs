// Full Three.js, separate Chrome contexts, synthetic games. All evidence outside checkout.
// node tools/pointer-safety-browser-test.mjs SITE OUT [--baseline]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), baseline = process.argv.includes('--baseline');
assert.ok(out !== root && !out.startsWith(root + path.sep)); await mkdir(out, { recursive: false });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const server = createServer(async (req, res) => { try {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.resolve(site, '.' + (name === '/' ? '/index.html' : name));
  assert.ok(file.startsWith(site + path.sep)); const bytes = await readFile(file);
  res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' })[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(bytes);
} catch { res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`, browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [], errors = [], allSizes = [[320,568],[375,812],[390,844],[430,932],[844,390],[1440,1000]];
const sizes = process.argv.includes('--targeted') ? allSizes.slice(0,1)
  : process.argv.includes('--remaining') ? allSizes.slice(1) : allSizes;
const state = p => p.evaluate(() => ({ board: __chess.board, history: __chess.history, turn: __chess.turn,
  mode: __chess.mode, side: __chess.humanSide, session: __chess.normalGameRecordSession, appState: __chess.appState }));
const camera = p => p.evaluate(() => __chess.camera.position.toArray());
const idle = async p => { await p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking
  && __chess.pieces.every(m => Math.abs(m.position.y - .18) < .0001)); await p.waitForTimeout(350); };
const point = (p, r, c, y = .36) => p.evaluate(({r,c,y}) => { const x = __chess, b = x.renderer.domElement.getBoundingClientRect(), v = x.camera.position.clone().set(c-4,y,4.5-r).project(x.camera);
  return { x: b.x+(v.x+1)*b.width/2, y: b.y+(1-v.y)*b.height/2 }; }, {r,c,y});
const tap = (p, a) => p.touchscreen.tap(a.x, a.y);
const play = async (p, from, to) => {
  const before = await state(p), expected = structuredClone(before.board);
  expected[to.r][to.c] = expected[from.r][from.c]; expected[from.r][from.c] = null;
  await tap(p, await point(p,from.r,from.c));
  assert.deepEqual(await p.evaluate(() => __chess.selected),from,'normal tap selects intended piece');
  await tap(p, await point(p,to.r,to.c,0)); await idle(p);
  const after = await state(p); assert.equal(after.history.length,before.history.length+1,'legal tap adds exactly one move');
  assert.deepEqual(after.board,expected); assert.equal(after.session.id,before.session.id);
  assert.equal(after.session.modeRevision,before.session.modeRevision);
};
const oneMove = async p => { await play(p,{r:3,c:0},{r:4,c:0}); assert.equal((await state(p)).history.length,1); };
const single = (a,b) => { assert.notEqual(a.session.id,b.session.id); assert.equal(b.session.modeRevision,a.session.modeRevision+1); assert.equal(b.history.length,0); assert.equal(b.board.flat().filter(Boolean).length,32); };
const storage = p => p.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k !== 'xiangqi.viewPrefs.v1')));
async function check(name, size, fn, expectedFailure) {
  const ctx = await browser.newContext({ viewport: { width:size[0],height:size[1] }, hasTouch:true, isMobile:size[0]!==1440 });
  const p = await ctx.newPage(), record = { name, size, modality:'CHROME_EMULATED_TOUCH_AND_REAL_KEYBOARD_OR_MOUSE', status:'RUNNING' };
  p.setDefaultTimeout(20000); p.on('pageerror', e => errors.push({ name, error:e.message }));
  p.on('console', m => { if (m.type()==='error') errors.push({name,error:m.text()}); });
  try {
    await p.goto(url); await idle(p); assert.equal(await p.title(),'中國象棋殺局訓練 · Xiangqi Mate Puzzle');
    assert.equal(await p.evaluate(() => __chess.renderer.getContext() instanceof WebGL2RenderingContext),true);
    await p.locator('#modeSel').selectOption('pvp'); await idle(p);
    await p.evaluate(() => { window.pointerTrace=[]; for(const type of ['pointerdown','pointermove','pointerup','pointercancel','click','keydown','submit']) document.addEventListener(type,e => pointerTrace.push({type,t:performance.now(),target:e.target.id||e.target.tagName,pointerId:e.pointerId,pointerType:e.pointerType,key:e.key,x:e.clientX,y:e.clientY,focus:document.activeElement.id,history:__chess.history.length,session:__chess.normalGameRecordSession.id,camera:__chess.camera.position.toArray()}),true); });
    await fn(p,ctx,record);
    assert.ok(!(baseline && expectedFailure), 'Baseline negative control unexpectedly passed'); record.status='PASS';
  } catch(e) {
    if (baseline && expectedFailure && e.code==='ERR_ASSERTION' && e.message.includes(expectedFailure)) { record.status='EXPECTED_FAIL_DETECTED'; record.assertion=e.message; }
    else { record.status='FAIL'; record.error=e.stack; process.exitCode=1; }
  } finally {
    record.trace=await p.evaluate(() => window.pointerTrace || []).catch(() => []);
    await p.screenshot({path:path.join(out,`${size[0]}-${name.replace(/[^a-z0-9-]/gi,'_')}.png`)}).catch(()=>{});
    await ctx.close(); results.push(record); await writeFile(path.join(out,'result.json'),JSON.stringify({url,chrome:browser.version(),baseline,results,errors},null,2));
    console.log(`${record.status} ${size.join('x')} ${name}`);
  }
  if (record.status==='FAIL') throw new Error(record.error);
}
async function touch(ctx,p,a,offsets,{cancel=false,pinch=false}={}) {
  const cd=await ctx.newCDPSession(p);
  if(pinch){await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:a.x-30,y:a.y,id:1},{x:a.x+30,y:a.y,id:2}]});
    for(const d of [35,40,45]) await cd.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x-d,y:a.y,id:1},{x:a.x+d,y:a.y,id:2}]});
  }else{await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});
    for(const dx of offsets){await cd.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+dx,y:a.y,id:1}]});await p.waitForTimeout(30);}}
  await cd.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});await cd.detach();
}
try {
  for(const size of sizes) {
    for(let repeat=0;repeat<([320,390].includes(size[0])?2:1);repeat++) await check('F1-old-touch-'+repeat,size,async(p,ctx,r)=>{
      await oneMove(p); await p.locator('#btnNew').click(); const box=await p.locator('#btnNewGameConfirm').boundingBox(); await p.locator('#btnNewGameCancel').click();
      const a={x:box.x+box.width/2,y:box.y+box.height/2},cd=await ctx.newCDPSession(p);r.point=a;r.before=await state(p);r.storage=await storage(p);
      assert.equal(await p.evaluate(a=>document.elementFromPoint(a.x,a.y)===__chess.renderer.domElement,a),true);
      await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});
      await cd.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:a.x+12,y:a.y,id:1}]});
      assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNew');await p.keyboard.press('Enter');await p.locator('#newGameConfirmDialog').waitFor({state:'visible'});
      await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cd.detach();await idle(p);r.after=await state(p);
      assert.deepEqual(r.after,r.before,'SAFETY_F1 old pointer must not discard progress');assert.deepEqual(await storage(p),r.storage);
      assert.equal(await p.locator('#newGameConfirmDialog').evaluate(e=>e.open),true);
      await p.locator('#btnNewGameConfirm').tap();single(r.before,await state(p));const fresh=await state(p);
      await p.evaluate(()=>{const f=document.querySelector('#newGameConfirmForm');f.requestSubmit();f.requestSubmit();});assert.deepEqual(await state(p),fresh);
    },'SAFETY_F1');
    for(const name of ['touch12','mouse-loop60']) await check('F2-'+name,size,async(p,ctx,r)=>{
      await tap(p,await point(p,3,4));assert.deepEqual(await p.evaluate(()=>__chess.selected),{r:3,c:4});r.before=await state(p);r.cameraBefore=await camera(p);const a=r.point=await point(p,4,4,0);
      if(name==='touch12')await touch(ctx,p,a,[6,12]);else{await p.mouse.move(a.x,a.y);await p.mouse.down();await p.mouse.move(a.x+60,a.y,{steps:6});await p.mouse.move(a.x,a.y,{steps:6});await p.mouse.up();}
      await idle(p);r.after=await state(p);r.cameraAfter=await camera(p);
      assert.ok((await p.evaluate(()=>pointerTrace)).some(e=>e.type==='pointermove'&&Math.abs(e.x-a.x)>=11));
      assert.deepEqual(r.after,r.before,'SAFETY_F2 drag must not add a move');
      await tap(p,await point(p,4,4,0));await idle(p);assert.equal((await state(p)).history.length,1);assert.equal((await state(p)).session.id,r.before.session.id);
    },'SAFETY_F2');
    if(baseline)continue;
    for(const input of ['space','enter','mouse','touch']) await check('R1-confirm-then-play-'+input,size,async(p,ctx,r)=>{
      await oneMove(p);r.before=await state(p);await p.locator('#btnNew').click();
      if(input==='mouse')await p.locator('#btnNewGameConfirm').click();
      else if(input==='touch')await p.locator('#btnNewGameConfirm').tap();
      else{await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNewGameConfirm');await p.keyboard.press(input==='space'?' ':'Enter');}
      r.newGame=await state(p);single(r.before,r.newGame);await idle(p);
      await oneMove(p);await play(p,{r:6,c:8},{r:5,c:8});r.after=await state(p);
      assert.equal(r.after.history.length,2);assert.equal(r.after.session.id,r.newGame.session.id);
    });
    await check('R1-cancel-then-play',size,async(p,ctx,r)=>{
      await oneMove(p);r.before=await state(p);await p.locator('#btnNew').click();await p.locator('#btnNewGameCancel').tap();assert.deepEqual(await state(p),r.before);
      await play(p,{r:6,c:8},{r:5,c:8});await play(p,{r:3,c:2},{r:4,c:2});r.after=await state(p);assert.equal(r.after.history.length,3);
    });
    await check('R1-native-window-blur',size,async(p,ctx,r)=>{
      r.modality='NATIVE_CHROME_WINDOW_BLUR_BY_TAB_SWITCH_WITH_FOCUS_EMULATION_DISABLED';
      await p.evaluate(()=>{window.windowFocusEvents=[];for(const type of ['blur','focus'])window.addEventListener(type,e=>{if(e.target===window)windowFocusEvents.push({type,trusted:e.isTrusted,target:'WINDOW',eventPhase:e.eventPhase});},true);});
      await tap(p,await point(p,3,0));r.before=await state(p);const a=await point(p,4,0,0),cd=await ctx.newCDPSession(p);
      await cd.send('Emulation.setFocusEmulationEnabled',{enabled:false});
      await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});
      const other=await ctx.newPage();await other.goto('about:blank');await other.bringToFront();
      await p.waitForFunction(()=>!document.hasFocus());await p.bringToFront();await p.waitForFunction(()=>document.hasFocus());
      await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await idle(p);assert.deepEqual(await state(p),r.before);
      r.focusEvents=await p.evaluate(()=>windowFocusEvents);assert.ok(r.focusEvents.some(e=>e.type==='blur'&&e.trusted));assert.ok(r.focusEvents.some(e=>e.type==='focus'&&e.trusted));
      await tap(p,await point(p,4,0,0));await idle(p);r.after=await state(p);assert.equal(r.after.history.length,1);assert.equal(r.after.session.id,r.before.session.id);
      await cd.send('Emulation.setFocusEmulationEnabled',{enabled:true});await cd.detach();await other.close();
    });
    await check('R1-element-blur',size,async(p,ctx,r)=>{
      await p.evaluate(()=>{window.elementBlurEvents=[];window.addEventListener('blur',e=>elementBlurEvents.push({target:e.target===window?'WINDOW':e.target.id,eventPhase:e.eventPhase,trusted:e.isTrusted}),true);});
      await p.locator('#btnNew').click();await idle(p);r.before=await state(p);assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNew');
      await oneMove(p);r.events=await p.evaluate(()=>elementBlurEvents);assert.ok(r.events.some(e=>e.target==='btnNew'&&e.eventPhase===1&&e.trusted));r.after=await state(p);
    });
    for(const name of ['pinch','cancel','touch-loop60','blur','pagehide']) await check('gesture-'+name,size,async(p,ctx,r)=>{
      await tap(p,await point(p,3,4));r.before=await state(p);r.cameraBefore=await camera(p);const a=r.point=await point(p,4,4,0);
      if(name==='blur'||name==='pagehide'){
        r.modality='SIMULATED_LIFECYCLE_WITH_CHROME_TOUCH';const cd=await ctx.newCDPSession(p);
        await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});await p.evaluate(name=>window.dispatchEvent(new Event(name)),name);
        await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cd.detach();
      }else await touch(ctx,p,a,name==='touch-loop60'?[30,60,30,0]:[6,12],{pinch:name==='pinch',cancel:name==='cancel'});
      await idle(p);r.after=await state(p);r.cameraAfter=await camera(p);assert.deepEqual(r.after,r.before);
      await tap(p,await point(p,4,4,0));await idle(p);assert.equal((await state(p)).history.length,1);assert.equal((await state(p)).session.id,r.before.session.id);
    });
    await check('keyboard-mouse-and-unarmed-submit',size,async(p,ctx,r)=>{
      await oneMove(p);r.before=await state(p);await p.locator('#btnNew').click();
      await p.evaluate(()=>document.querySelector('#newGameConfirmForm').requestSubmit());assert.deepEqual(await state(p),r.before);
      await p.keyboard.press('Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNewGameConfirm');
      await p.keyboard.press('Shift+Tab');assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNewGameCancel');
      await p.keyboard.press('Escape');assert.deepEqual(await state(p),r.before);
      await p.locator('#btnNew').click();await p.keyboard.press('Tab');await p.keyboard.press(' ');single(r.before,await state(p));
      await idle(p);await oneMove(p);const beforeEnter=await state(p);await p.locator('#btnNew').click();await p.keyboard.press('Tab');await p.keyboard.press('Enter');single(beforeEnter,await state(p));
      await idle(p);await oneMove(p);const beforeMouse=await state(p);await p.locator('#btnNew').click();await p.locator('#btnNewGameConfirm').click();single(beforeMouse,await state(p));
    });
    await check('Esc-reopen-old-pointer',size,async(p,ctx,r)=>{
      await oneMove(p);r.before=await state(p);await p.locator('#btnNew').click();const box=await p.locator('#btnNewGameConfirm').boundingBox(),a={x:box.x+box.width/2,y:box.y+box.height/2},cd=await ctx.newCDPSession(p);
      await cd.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...a,id:1}]});await p.keyboard.press('Escape');await p.keyboard.press('Enter');
      await p.locator('#newGameConfirmDialog').waitFor({state:'visible'});await cd.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cd.detach();await idle(p);
      assert.deepEqual(await state(p),r.before);assert.equal(await p.locator('#newGameConfirmDialog').evaluate(e=>e.open),true);
      await p.locator('#btnNewGameCancel').tap();assert.deepEqual(await state(p),r.before);assert.equal(await p.evaluate(()=>document.activeElement.id),'btnNew');
    });
  }
  assert.deepEqual(errors,[]);
}catch(e){process.exitCode=1;console.error(e);}
finally{await writeFile(path.join(out,'result.json'),JSON.stringify({url,chrome:browser.version(),baseline,results,errors},null,2));await browser.close();await new Promise(r=>server.close(r));}
