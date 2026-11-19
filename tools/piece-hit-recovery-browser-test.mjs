// Full Three.js; isolated Chrome; synthetic state only. Faults affect served
// responses/one browser context, never checkout files. Evidence stays outside.
// node tools/piece-hit-recovery-browser-test.mjs SITE OUT [--negative] [--baseline]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.argv[2]), out = path.resolve(process.argv[3]);
assert.ok(out !== root && !out.startsWith(root + path.sep));
await mkdir(out, { recursive: false });
const negative = process.argv.includes('--negative'), baseline = process.argv.includes('--baseline');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
let fault = '';
const server = createServer(async (req, res) => { try {
  const name = new URL(req.url, 'http://localhost').pathname;
  if (name === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.resolve(site, '.' + (name === '/' ? '/index.html' : name));
  assert.ok(file.startsWith(site + path.sep)); let body = await readFile(file);
  if (name === '/main.js') {
    let text = body.toString();
    if (fault === 'disabled') text = text.replace('if (recovered) return recovered;', 'if (false) return recovered;');
    text += '\nwindow.__hitQA = { pick, ray, scene, boardMesh, doMove, recovery: typeof recoverPieceTopHit === "function" ? recoverPieceTopHit : null };\n';
    body = Buffer.from(text);
  }
  if (name === '/piece-hit-recovery.js') {
    let text = body.toString();
    if (fault === 'wide') text = text.replace('INNER_RADIUS = 0.2', 'INNER_RADIUS = 0.8').replace('radiusTop / 2', 'radiusTop * 2');
    if (fault === 'empty') text = text.replace('!logical || !piece || logical.type !== piece.type || logical.side !== piece.side', '!piece');
    if (fault === 'identity') text = text.replace('logical.type !== piece.type || logical.side !== piece.side', 'false');
    if (fault === 'occlusion') text = text.replace('return occluded ? null : candidate.mesh;', 'return candidate.mesh;');
    body = Buffer.from(text);
  }
  res.writeHead(200, { 'Content-Type': ({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' }); res.end(body);
} catch { res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ channel:'chrome', headless:true });
const results = [], errors = [];
const idle = async p => { await p.waitForFunction(() => window.__chess && !__chess.busy && !__chess.aiThinking && __chess.pieces.every(m => Math.abs(m.position.y-.18)<1e-8)); await p.waitForTimeout(400); };
const state = p => p.evaluate(() => ({board:__chess.board,history:__chess.history,session:__chess.normalGameRecordSession,turn:__chess.turn,mode:__chess.mode,appState:__chess.appState}));
const selected = p => p.evaluate(() => __chess.selected);
const point = (p,r,c,y=.36) => p.evaluate(({r,c,y}) => { const x=__chess,b=x.renderer.domElement.getBoundingClientRect(),v=x.camera.position.clone().set(c-4,y,4.5-r).project(x.camera);return {x:b.x+(v.x+1)*b.width/2,y:b.y+(1-v.y)*b.height/2}; },{r,c,y});
const tap = (p,q) => p.touchscreen.tap(q.x,q.y);
async function play(p,from,to) {
  const before = await state(p); await tap(p,await point(p,from.r,from.c));
  assert.deepEqual(await selected(p),from,'PIECE_SELECTION');
  await tap(p,await point(p,to.r,to.c,0)); await idle(p);
  if (fault === 'double-history') await p.evaluate(() => __chess.history.push(structuredClone(__chess.history.at(-1))));
  const after=await state(p),board=structuredClone(before.board); board[to.r][to.c]=board[from.r][from.c];board[from.r][from.c]=null;
  assert.equal(after.history.length,before.history.length+1,'EXACTLY_ONE_MOVE');
  assert.equal(after.session.id,before.session.id);assert.equal(after.session.modeRevision,before.session.modeRevision);assert.deepEqual(after.board,board);
}
async function setOriginalCamera(p) {
  await p.evaluate(() => { const x=__chess;x.controls.target.set(0,-.1,.2);x.camera.position.set(2.4413839432541604e-47,8.388931257995484,12.32345025547708);x.camera.fov=90.29117068178844;x.camera.lookAt(x.controls.target);x.camera.updateProjectionMatrix();x.camera.updateMatrixWorld(true); });
}
async function diagnostics(p,x,y) { return p.evaluate(async({x,y}) => {
  const T=await import('three'),a=__chess,b=a.renderer.domElement.getBoundingClientRect(),ray=new T.Raycaster();ray.setFromCamera(new T.Vector2((x-b.x)/b.width*2-1,1-(y-b.y)/b.height*2),a.camera);
  const hits=ray.intersectObjects(a.pieces,false),board=ray.intersectObject(__hitQA.boardMesh,false),picked=__hitQA.pick({clientX:x,clientY:y});
  return {x,y,camera:a.camera.position.toArray(),target:a.controls.target.toArray(),matrix:a.camera.matrixWorld.elements.slice(),projection:a.camera.projectionMatrix.elements.slice(),ray:{origin:ray.ray.origin.toArray(),direction:ray.ray.direction.toArray()},meshHits:hits.map(h=>({r:h.object.userData.r,c:h.object.userData.c,distance:h.distance})),boardHits:board.map(h=>h.point.toArray()),picked:picked?.userData?{r:picked.userData.r,c:picked.userData.c}:{r:picked?.r,c:picked?.c}};
},{x,y}); }
async function check(name,size,fn,expectedMessage) {
  const context=await browser.newContext({viewport:{width:size[0],height:size[1]},hasTouch:true,isMobile:size[0]!==1440});const p=await context.newPage();p.setDefaultTimeout(20000);
  const r={name,size,fault: fault || null};let thrown;
  p.on('pageerror',e=>errors.push({name,error:e.message}));
  try { await p.goto(url);await idle(p);await p.locator('#modeSel').selectOption('pvp');await idle(p);await fn(p,context,r);r.status='PASS'; }
  catch(e){thrown=e;r.status='FAIL';r.error=e.stack;}
  if(expectedMessage){assert.ok(thrown,`Negative control ${name} must fail`);assert.match(thrown.message,expectedMessage);r.status='EXPECTED_FAIL_DETECTED';}
  await p.screenshot({path:path.join(out,`${results.length}-${name}.png`)});await context.close();results.push(r);await writeFile(path.join(out,'result.json'),JSON.stringify({chrome:browser.version(),modality:'CHROME_SIMULATED_TOUCH',baseline,negative,results,errors},null,2));console.log(JSON.stringify({name,size,status:r.status}));
  if(thrown&&!expectedMessage)throw thrown;
}
async function exact(p,c,r){
  await play(p,{r:3,c:4},{r:4,c:4});await setOriginalCamera(p);const before=await state(p);r.diagnostic=await diagnostics(p,195,436);
  assert.equal(r.diagnostic.meshHits.length,0,'F3 original complete mesh miss');await tap(p,{x:195,y:436});
  assert.deepEqual(await selected(p),{r:6,c:4},'F3_CENTER_RECOVERY');assert.deepEqual(await state(p),before);
  r.offsets=[];
  for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1],[-6,0],[6,0]]){
    await tap(p,await point(p,4,1,0));await tap(p,{x:195+dx,y:436+dy});assert.deepEqual(await selected(p),{r:6,c:4},'F3_ADJACENT_PIXEL');r.offsets.push(await diagnostics(p,195+dx,436+dy));assert.deepEqual(await state(p),before);
  }
  // Already selected black pawn: its real legal destination adds one ply only.
  await tap(p,await point(p,5,4,0));await idle(p);const after=await state(p);assert.equal(after.history.length,2);assert.equal(after.session.id,before.session.id);assert.equal(after.board[5][4].side,'black');
}
async function guard(p,c,r,kind) {
  r.result=await p.evaluate(async kind=>{
    const T=await import('three'),a=__chess,q=__hitQA,m=a.pieces.find(m=>m.userData.r===6&&m.userData.c===4),board=structuredClone(a.board);
    const ray=new T.Raycaster(new T.Vector3(0,4,-1.5),new T.Vector3(0,-1,0));let extra;
    if(kind==='bounded')ray.ray.origin.x=.5; // between the piece and an empty adjacent intersection
    if(kind==='empty')board[6][4]=null;
    if(kind==='identity')board[6][4]={side:'red',type:'R'};
    if(kind==='occlusion'){extra=new T.Mesh(new T.BoxGeometry(.3,.1,.3),new T.MeshBasicMaterial());extra.position.set(0,1,-1.5);q.scene.add(extra);}
    if(kind==='invisible')m.visible=false;
    if(kind==='material')m.material[1].visible=false;
    if(kind==='scaled')m.scale.setScalar(.5);
    if(kind==='tilted')m.rotation.x=.1;
    if(kind==='moving')m.position.y=.4;
    if(kind==='wrong-square')m.position.x=.1;
    if(kind==='duplicate'){extra=m.clone();q.scene.add(extra);a.pieces.push(extra);}
    if(kind==='unregistered')a.pieces.splice(a.pieces.indexOf(m),1);
    if(kind==='offscene')q.scene.remove(m);
    if(kind==='parallel')ray.ray.direction.set(1,0,0);
    if(kind==='backwards')ray.ray.direction.set(0,1,0);
    if(kind==='nan')ray.ray.origin.x=NaN;
    if(kind==='near')ray.near=4;
    if(kind==='far')ray.far=1;
    if(kind==='valid-y-rotation')m.rotation.y=.8;
    q.scene.updateMatrixWorld(true);const hit=q.recovery(ray,a.pieces,q.scene,board);
    return hit?{r:hit.userData.r,c:hit.userData.c}:null;
  },kind);
  if(kind==='valid-y-rotation')assert.deepEqual(r.result,{r:6,c:4});else assert.equal(r.result,null,`REJECT_${kind}`);
}
async function boardMatrix(p,c,r){
  r.samples=[];const before=await state(p);
  for(const [rr,cc]of [[0,0],[0,4],[0,8],[2,1],[2,7],[3,0],[3,4],[3,8]]){
    const q=await point(p,rr,cc);r.samples.push(await diagnostics(p,q.x,q.y));await tap(p,q);assert.deepEqual(await selected(p),{r:rr,c:cc},'normal centre selects');await tap(p,q);assert.equal(await selected(p),null);
  }
  for(const [rr,cc]of [[1,0],[1,4],[4,1],[4,4],[5,4],[5,8]]){await tap(p,await point(p,rr,cc,0));assert.equal(await selected(p),null,'empty square remains empty');}
  await tap(p,await point(p,3,0));await tap(p,await point(p,5,0,0));assert.deepEqual(await state(p),before,'illegal target does not move');
  await play(p,{r:3,c:0},{r:4,c:0});
  // Black view and return exercise real controls; no camera replacement.
  for(let i=0;i<5&&await p.evaluate(()=>__chess.viewIdx)!==4;i++){
    if(!await p.locator('#btnView').isVisible())await p.locator('#btnMore').click();await p.locator('#btnView').click();await idle(p);
  }
  if(await p.locator('#btnMore').getAttribute('aria-expanded')==='true')await p.locator('#btnMore').click();
  assert.equal(await p.evaluate(()=>__chess.viewIdx),4,'black preset selected');
  await p.waitForFunction(() => Math.abs(__chess.camera.position.x)<1e-6 && __chess.camera.position.z< -12);
  for(const [rr,cc]of [[9,0],[9,4],[9,8],[7,1],[6,0],[6,4],[6,8]]){const q=await point(p,rr,cc);await tap(p,q);assert.deepEqual(await selected(p),{r:rr,c:cc},'black-view centre selects');await tap(p,q);}
  await play(p,{r:6,c:0},{r:5,c:0});
  r.final=await state(p);assert.equal(r.final.history.length,2);assert.equal(r.final.session.id,before.session.id);
}
async function drag(p,c,r){const before=await state(p),q=await point(p,3,0);await p.mouse.move(q.x,q.y);await p.mouse.down();await p.mouse.move(q.x+12,q.y);await p.mouse.move(q.x,q.y);await p.mouse.up();await idle(p);
  if(fault==='drag-move'){await p.evaluate(()=>__hitQA.doMove({r:3,c:0},{r:4,c:0}));await idle(p);}
  assert.deepEqual(await state(p),before,'DRAG_MUST_NOT_MOVE');assert.equal(await selected(p),null);
}
async function occludedOriginal(p,c,r){
  await play(p,{r:3,c:4},{r:4,c:4});await setOriginalCamera(p);
  const before=await state(p);r.before=await diagnostics(p,195,436);
  assert.equal(r.before.meshHits.length,0);
  await p.evaluate(async()=>{const T=await import('three');__hitQA.pick({clientX:195,clientY:436});
    const ray=__hitQA.ray.ray, t=(.36-ray.origin.y)/ray.direction.y;
    const blocker=new T.Mesh(new T.BoxGeometry(.3,.3,.3),new T.MeshBasicMaterial({color:0xffffff}));
    blocker.position.copy(ray.at(t-1,new T.Vector3()));__hitQA.scene.add(blocker);__hitQA.scene.updateMatrixWorld(true);
  });
  r.after=await diagnostics(p,195,436);assert.equal(r.after.meshHits.length,0);
  assert.notDeepEqual(r.after.picked,{r:6,c:4},'foreground must block the recovery path');
  await tap(p,{x:195,y:436});assert.equal(await selected(p),null);assert.deepEqual(await state(p),before);
}
try {
  if(negative){
    for(const [name,fn,message]of [
      ['disabled',exact,/F3_CENTER_RECOVERY/],['wide',(p,c,r)=>guard(p,c,r,'bounded'),/REJECT_bounded/],
      ['empty',(p,c,r)=>guard(p,c,r,'empty'),/REJECT_empty/],['identity',(p,c,r)=>guard(p,c,r,'identity'),/REJECT_identity/],
      ['occlusion',(p,c,r)=>guard(p,c,r,'occlusion'),/REJECT_occlusion/],['drag-move',drag,/DRAG_MUST_NOT_MOVE/],
      ['double-history',p=>play(p,{r:3,c:0},{r:4,c:0}),/EXACTLY_ONE_MOVE/]]) { fault=name;await check(name,[390,844],fn,message); }
  }else{
    for(let i=0;i<2;i++)await check('exact-'+i,[390,844],exact,baseline?/F3_CENTER_RECOVERY/:null);
    if(!baseline){
      for(const size of [[320,568],[375,812],[390,844],[430,932],[844,390],[1440,1000]])await check('board-matrix',size,boardMatrix);
      for(const kind of ['bounded','empty','identity','occlusion','invisible','material','scaled','tilted','moving','wrong-square','duplicate','unregistered','offscene','parallel','backwards','nan','near','far','valid-y-rotation'])await check('guard-'+kind,[390,844],(p,c,r)=>guard(p,c,r,kind));
      await check('drag',[390,844],drag);
      await check('original-occluded',[390,844],occludedOriginal);
    }
  }
  assert.deepEqual(errors,[],'no page errors');
}catch(e){process.exitCode=1;console.error(e);}
finally{await browser.close();await new Promise(r=>server.close(r));}
