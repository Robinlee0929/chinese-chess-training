// The same behavioral oracles run in Node and real Chrome; no Node dependencies here.
export class OracleFailure extends Error { constructor(message) { super(message); this.name='OracleFailure'; } }
const check = (condition, message) => { if (!condition) throw new OracleFailure(message); };
const same = (a,b,label) => check(JSON.stringify(a) === JSON.stringify(b), label);
function rejects(fn, label) { let failed=false; try { fn(); } catch (e) { if(e instanceof OracleFailure) throw e; failed=true; } check(failed,label); }
const send = (s, op, rest={}) => JSON.parse(s.dispatch(JSON.stringify({op,...rest})));
const make = (m,f,id='browser-check') => m.createBrowserCoach(JSON.stringify({sessionId:id,source:f.source}));
function start(m,f,id) { const s=make(m,f,id); send(s,'observe');send(s,'addCandidate',{move:f.candidate});return s; }
const result = (s,t) => ({identity:t.identity,legalReplies:[...send(s,'coverage').explored,...send(s,'coverage').unexplored]});

export const securityOracles = {
  'fingerprint-parity'(m,fixtures) {
    for(const f of fixtures)same(m.fingerprintJSON(JSON.stringify(f.source)),f.sourceFingerprint,'SHA256 identity mismatch');
  },
  'reject-object-before-reflection'(m, fixtures) {
    const s=start(m,fixtures[0]), before=send(s,'snapshot'); let touches=0;
    const evil=new Proxy({}, {get(){touches++;s.destroy();return 'x';},ownKeys(){touches++;s.destroy();return [];},getPrototypeOf(){touches++;s.destroy();return null;}});
    const getter={get op(){touches++;s.destroy();return 'reset';},toJSON(){touches++;s.destroy();return {};}};
    const cyclic={};cyclic.self=cyclic;const revoked=Proxy.revocable({},{});revoked.revoke();
    for(const input of [evil,getter,cyclic,revoked.proxy,new String('{}'),[],null,1,()=>{}]) {
      rejects(()=>m.createBrowserCoach(input),'object creation accepted');
      rejects(()=>s.dispatch(input),'object command accepted');
      rejects(()=>m.fingerprintJSON(input),'object fingerprint accepted');
    }
    check(touches===0,'untrusted object callback ran');same(send(s,'snapshot'),before,'reentry mutated session');s.destroy();
  },
  'duplicate-key'(m) { rejects(()=>m.fingerprintJSON('{"a":1,"a":2}'),'duplicate JSON key accepted'); },
  'depth-limit'(m) { rejects(()=>m.fingerprintJSON('['.repeat(18)+'0'+']'.repeat(18)),'deep input accepted'); },
  'size-limit'(m) { rejects(()=>m.fingerprintJSON('"'+'x'.repeat(262145)+'"'),'large input accepted'); },
  'field-whitelist'(m,fixtures) {
    const input={sessionId:'schema',source:structuredClone(fixtures[0].source)};
    input.source.board.flat().find(Boolean).answer='not-a-piece-field';
    rejects(()=>m.createBrowserCoach(JSON.stringify(input)),'unknown piece field accepted');
  },
  'cross-session-ticket'(m,fixtures) {
    const a=start(m,fixtures[0],'same'),b=start(m,fixtures[0],'same');
    const ta=send(a,'beginVerification'),tb=send(b,'beginVerification');
    check(!send(b,'settleVerification',{ticket:ta.ticket,result:result(b,tb)}).accepted,'cross-session ticket accepted');
    check(send(b,'settleVerification',{ticket:tb.ticket,result:result(b,tb)}).accepted,'foreign ticket consumed own ticket');a.destroy();b.destroy();
  },
  'stale-result'(m,fixtures) {
    const s=start(m,fixtures[0]);const old=send(s,'beginVerification'),oldResult=result(s,old);
    send(s,'reset');send(s,'observe');send(s,'addCandidate',{move:fixtures[0].candidate});
    check(!send(s,'settleVerification',{ticket:old.ticket,result:oldResult}).accepted,'reset accepted old result');s.destroy();
  },
  'one-shot-ticket'(m,fixtures) {
    const s=start(m,fixtures[0]),t=send(s,'beginVerification'),r=result(s,t);
    check(send(s,'settleVerification',{ticket:t.ticket,result:r}).accepted,'valid result rejected');
    check(!send(s,'settleVerification',{ticket:t.ticket,result:r}).accepted,'duplicate result accepted');s.destroy();
  },
  'reply-completeness'(m,fixtures) {
    const s=start(m,fixtures[0]),t=send(s,'beginVerification'),r=result(s,t);r.legalReplies.pop();
    check(!send(s,'settleVerification',{ticket:t.ticket,result:r}).accepted,'incomplete reply set accepted');s.destroy();
  },
  'illegal-move'(m,fixtures) {
    const f=fixtures.find(f=>f.id==='C'),s=make(m,f);send(s,'observe');const before=send(s,'snapshot');
    check(f.illegal?.from && f.illegal?.to,'missing literal illegal fixture');
    let code;try{send(s,'addCandidate',{move:f.illegal});}catch(e){code=e.code;}
    check(code==='ILLEGAL_MOVE','literal illegal move was not rejected by legality');
    same(send(s,'snapshot'),before,'illegal changes state');s.destroy();
  },
  'teaching-projection'(m,fixtures) {
    const s=start(m,fixtures[0]);send(s,'addHypothesis',{text:'最佳著 answer 0,4 -> 9,4'});
    const t=JSON.parse(s.teaching());same(Object.keys(t),['stage','question','uncertainty'],'teaching leaks fields');
    check(!/answer|最佳著|0,4|9,4/.test(s.teaching()),'teaching leaks child answer');s.destroy();
  },
  'evidence-label'(m,fixtures) {
    const s=start(m,fixtures[1]),h=send(s,'addHypothesis',{text:'這枚棋子一定安全'});
    check(h.kind==='UNPROVEN_HYPOTHESIS'&&h.proved===false,'hypothesis promoted');
    const search=send(s,'searchEvidence');check(search.kind==='ENGINE_SEARCH_EVIDENCE'&&!search.available,'fake search');
    check(send(s,'nodeFacts').kind==='CANONICAL_FACT','facts misclassified');s.destroy();
  },
  'no-storage'(m,fixtures) {
    const s=start(m,fixtures[0]);send(s,'reset');s.destroy();
  },
};

export function runChecks(m, fixtures, expected) {
  const rows=[];
  const run=(name,fn)=>{fn();rows.push({name,status:'PASS'});};
  run('only safe entrypoints exported',()=>same(Object.keys(m).sort(),['createBrowserCoach','fingerprintJSON'],'unsafe export'));
  for(const f of fixtures) run('fixture '+f.id+' / Node fingerprint and state parity',()=>{
    const s=make(m,f);same(send(s,'snapshot'),expected[f.id].initial,'Node initial mismatch');
    same(m.fingerprintJSON(JSON.stringify(f.source)),f.sourceFingerprint,'source fingerprint mismatch');
    send(s,'observe');send(s,'addCandidate',{move:f.candidate});
    same(send(s,'snapshot'),expected[f.id].candidate,'Node candidate mismatch');same(send(s,'nodeFacts'),expected[f.id].facts,'Node facts mismatch');
    same(send(s,'coverage'),expected[f.id].coverage,'Node full defenses mismatch');s.destroy();
  });
  for(const [name,fn]of Object.entries(securityOracles))run(name,()=>fn(m,fixtures));
  run('strict JSON syntax, keys, nodes and UTF8 bounds',()=>{
    for(const text of ['{"__proto__":{}}','{"constructor":1}','{"x":1,}','[1,]','01','1e999','{}{}','{"a":1,"\\u0061":2}','"raw\nline"','[','undefined','"'+'棋'.repeat(90000)+'"','['+Array(30001).fill('0').join(',')+']'])rejects(()=>m.fingerprintJSON(text),'bad JSON accepted');
    for(const text of ['null','-0','true','[1,2]','"\\uD800"','{"a":"x\\\"y"}'])check(typeof m.fingerprintJSON(text)==='string','valid JSON rejected');
  });
  run('C illegal move atomic; two candidates and alternate sacrifice legal',()=>{
    const c=fixtures.find(f=>f.id==='C'),s=make(m,c);send(s,'observe');const before=send(s,'snapshot');
    rejects(()=>send(s,'addCandidate',{move:c.illegal}),'illegal accepted');same(send(s,'snapshot'),before,'illegal changes state');s.destroy();
    const b=fixtures.find(f=>f.id==='B'),t=start(m,b);send(t,'play',{move:b.expected.recapture});
    send(t,'addCandidate',{move:b.expected.alternative});check(send(t,'compare').length===2,'alternative lost');t.destroy();
  });
  run('A exploration, undo, comparison, branch reset and navigation',()=>{
    const f=fixtures[0],s=start(m,f),root=send(s,'snapshot').selectedId;
    for(const reply of f.expected.replies){send(s,'play',{move:reply});send(s,'undo');}
    check(send(s,'coverage').unexplored.length===0,'defense coverage incomplete');
    send(s,'resetBranch',{id:root});check(send(s,'coverage').unexplored.length===3,'branch reset failed');
    send(s,'selectBranch',{id:root});send(s,'reflect');check(JSON.parse(s.teaching()).stage==='reflect','reflect failed');s.destroy();
  });
  run('same board different source session/history and immutable source',()=>{
    const f=fixtures[0],before=JSON.stringify(f),a=make(m,f),changed=structuredClone(f);
    changed.source.sourceSessionId+=':other';const b=make(m,changed);
    changed.source=structuredClone(f.source);changed.source.history={kind:'partial',root:{board:structuredClone(f.source.board),sideToMove:f.source.sideToMove},moves:[]};const c=make(m,changed);
    const ids=[a,b,c].map(x=>send(x,'snapshot').sourceFingerprint);check(new Set(ids).size===3,'source identity collapsed');
    const snap=send(a,'snapshot');snap.source.board[0][4]=null;check(send(a,'snapshot').source.board[0][4]!==null,'output mutates source');
    same(JSON.stringify(f),before,'input mutated');for(const s of[a,b,c])s.destroy();
  });
  run('out-of-order and malformed one-shot results; branch revision isolation',()=>{
    const f=fixtures.find(f=>f.id==='B'),s=start(m,f);const old=send(s,'beginVerification'),newer=send(s,'beginVerification');
    check(!send(s,'settleVerification',{ticket:old.ticket,result:result(s,old)}).accepted,'old order accepted');
    check(!send(s,'settleVerification',{ticket:newer.ticket,result:{}}).accepted,'malformed accepted');
    check(!send(s,'settleVerification',{ticket:newer.ticket,result:result(s,newer)}).accepted,'malformed did not consume');
    const t=send(s,'beginVerification'),r=result(s,t);send(s,'addCandidate',{move:f.expected.alternative});
    check(!send(s,'settleVerification',{ticket:t.ticket,result:r}).accepted,'cross-branch accepted');s.destroy();
  });
  run('partial/complete replay and evidence scopes match original Node core',()=>{
    for(const c of expected.historyCases){const s=m.createBrowserCoach(JSON.stringify({sessionId:'history-replay',source:c.source}));
      same(send(s,'snapshot'),c.initial,'replayed root mismatch');send(s,'observe');send(s,'addCandidate',{move:fixtures[0].expected.replies[0]});
      same(send(s,'snapshot'),c.candidate,'replayed candidate mismatch');same(send(s,'nodeFacts'),c.facts,'history evidence mismatch');s.destroy();}
  });
  run('malformed envelope rejected before core; malformed result consumes matching ticket',()=>{
    const s=start(m,fixtures[0]),t=send(s,'beginVerification'),r=result(s,t),before=send(s,'snapshot');
    rejects(()=>s.dispatch('{"op":"settleVerification",'),'malformed envelope accepted');
    rejects(()=>send(s,'reset',{extra:true}),'unknown command field accepted');same(send(s,'snapshot'),before,'bad envelope changed state');
    check(send(s,'settleVerification',{ticket:t.ticket,result:r}).accepted,'rejected envelope consumed ticket');
    const t2=send(s,'beginVerification');check(!send(s,'settleVerification',{ticket:t2.ticket,result:{identity:t2.identity,legalReplies:[],proved:true}}).accepted,'untrusted evidence field accepted');
    check(!send(s,'settleVerification',{ticket:t2.ticket,result:result(s,t2)}).accepted,'bad result ticket reusable');s.destroy();
  });
  run('invalidate and repeated create/reset/destroy bounded lifecycle',()=>{
    for(let i=0;i<60;i++){const s=start(m,fixtures[0],'cycle-'+i);send(s,'reset');send(s,'invalidate');rejects(()=>send(s,'observe'),'invalid revived');s.destroy();s.destroy();rejects(()=>s.teaching(),'destroy revived');rejects(()=>send(s,'snapshot'),'destroy exposes retained state');}
  });
  return rows;
}
