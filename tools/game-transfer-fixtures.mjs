import { initialBoard, legalMoves, applyMove, inCheck, hasAnyLegalMove, hashBoard } from '../game.js';

const empty = () => Array.from({ length: 10 }, () => Array(9).fill(null));
export function transfer(overrides = {}) {
  return { format: 'chinese-chess-training-game-transfer', schemaVersion: 1,
    exportedAt: '2026-11-10T05:00:00.000Z', initialPosition: { board: initialBoard(), sideToMove: 'red' },
    moves: [], mode: 'hard', playerSide: null, status: 'in-progress', result: null, ...overrides };
}
export function terminal(kind = 'checkmate') {
  const board = empty();
  let sideToMove = 'red', moves, result;
  const put = (r, c, type, side) => { board[r][c] = { type, side }; };
  if (kind === 'checkmate') {
    for (const args of [[0,4,'K','red'],[9,4,'K','black'],[2,3,'R','red'],[2,4,'P','black'],[9,3,'P','black'],[9,5,'P','black']]) put(...args);
    moves = [{ from: { r: 2, c: 3 }, to: { r: 2, c: 4 } }];
    result = { winner: 'red', terminationReason: kind };
  } else if (kind === 'stalemate') {
    for (const args of [[0,5,'K','red'],[9,5,'K','black'],[4,5,'P','red'],[7,5,'N','red'],[7,0,'R','red']]) put(...args);
    moves = [{ from: { r: 7, c: 0 }, to: { r: 8, c: 0 } }];
    result = { winner: 'red', terminationReason: kind };
  } else if (kind === 'mutual-perpetual-check') {
    for (const args of [[0,3,'R','red'],[1,4,'K','red'],[2,4,'C','red'],[3,4,'N','black'],[5,6,'N','black'],[5,8,'R','red'],[7,4,'C','black'],[8,3,'K','black']]) put(...args);
    sideToMove = 'black';
    const cycle = [[3,4,5,3],[2,4,2,3],[5,3,3,4],[2,3,2,4]];
    moves = [...cycle, ...cycle].map(([r,c,tr,tc]) => ({ from: {r,c}, to: {r:tr,c:tc} }));
    result = { winner: null, terminationReason: kind };
  } else {
    const perpetual = kind === 'perpetual-check';
    put(0,3,'K','red'); put(perpetual ? 7 : 9,4,'K','black'); put(perpetual ? 7 : 4,0,'R','red');
    sideToMove = 'black';
    const cycle = perpetual ? [[7,4,8,4],[7,0,8,0],[8,4,7,4],[8,0,7,0]] : [[9,4,9,5],[4,0,5,0],[9,5,9,4],[5,0,4,0]];
    moves = [...cycle, ...cycle].map(([r,c,tr,tc]) => ({ from: {r,c}, to: {r:tr,c:tc} }));
    result = { winner: perpetual ? 'black' : null, terminationReason: kind };
  }
  return transfer({ initialPosition: {board,sideToMove}, moves, status: 'completed', result });
}

// Deterministic, genuine legal play. Never repeats a board+turn key, captures,
// gives check, or crosses a terminal position. Generation is outside benchmarks.
export function longGame(plies = 1024, sideToMove = 'red', standard = false) {
  const initial = standard ? initialBoard() : empty();
  if (!standard) for (const [r,c,type,side] of [[0,4,'K','red'],[9,4,'K','black'],[4,4,'P','red'],
    [1,0,'R','red'],[1,8,'R','red'],[8,0,'R','black'],[8,8,'R','black'],[2,1,'N','red'],[7,7,'N','black']]) initial[r][c] = {type,side};
  let board = structuredClone(initial), turn = sideToMove, seed = 0x1731;
  const seen = new Set([hashBoard(board) + '|' + turn]), moves = [];
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  for (let ply = 0; ply < plies; ply++) {
    const candidates = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
      if (board[r][c]?.side !== turn || (!standard && !['R','N'].includes(board[r][c].type))) continue;
      for (const to of legalMoves(board,r,c)) if (board[to.r][to.c] === null) candidates.push({from:{r,c},to});
    }
    let accepted = false;
    while (candidates.length) {
      const index = Math.floor(random() * candidates.length), move = candidates.splice(index,1)[0];
      const next = structuredClone(board); applyMove(next,move.from,move.to);
      const nextTurn = turn === 'red' ? 'black' : 'red', key = hashBoard(next) + '|' + nextTurn;
      if (seen.has(key) || inCheck(next,nextTurn) || !hasAnyLegalMove(next,nextTurn)) continue;
      seen.add(key); moves.push(move); board = next; turn = nextTurn; accepted = true; break;
    }
    if (!accepted) throw Error(`Long legal fixture exhausted at ${ply}`);
  }
  return transfer({ initialPosition: { board: initial, sideToMove }, moves });
}

export function longCompletedGame() {
  const game=longGame(1016,'black'), board=structuredClone(game.initialPosition.board);
  const seen=new Set();let turn='black';
  seen.add(hashBoard(board)+'|'+turn);
  for(const move of game.moves){applyMove(board,move.from,move.to);turn=turn==='red'?'black':'red';seen.add(hashBoard(board)+'|'+turn);}
  const choices=(b,side)=>{
    const out=[];
    for(let r=0;r<10;r++)for(let c=0;c<9;c++)if(b[r][c]?.side===side&&['R','N'].includes(b[r][c].type))
      for(const to of legalMoves(b,r,c))if(!b[to.r][to.c])out.push({from:{r,c},to});
    return out;
  };
  for(const a of choices(board,turn)){
    const b1=structuredClone(board);applyMove(b1,a.from,a.to);
    const other=turn==='red'?'black':'red';
    if(inCheck(b1,other)||seen.has(hashBoard(b1)+'|'+other))continue;
    for(const b of choices(b1,other)){
      const cycle=[a,b,{from:a.to,to:a.from},{from:b.to,to:b.from}],probe=structuredClone(board);
      let side=turn,valid=true;
      for(let i=0;i<cycle.length;i++){
        const move=cycle[i];
        if(!legalMoves(probe,move.from.r,move.from.c).some(m=>m.r===move.to.r&&m.c===move.to.c)){valid=false;break;}
        applyMove(probe,move.from,move.to);side=side==='red'?'black':'red';
        if(inCheck(probe,side)||(i<3&&seen.has(hashBoard(probe)+'|'+side))){valid=false;break;}
      }
      if(valid&&hashBoard(probe)===hashBoard(board))return {...game,moves:[...game.moves,...cycle,...cycle],status:'completed',result:{winner:null,terminationReason:'threefold-repetition'}};
    }
  }
  throw Error('No legal final repetition cycle found');
}
