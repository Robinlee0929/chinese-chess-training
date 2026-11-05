// Native completion and the entire B operation are both required. A deadline
// never cancels a transaction; record the eventual outcome even after failure.
export function performanceGate(observed) {
  return Number.isFinite(observed.totalMs) && observed.totalMs>=0 && observed.totalMs<2000
    && observed.native?.trace?.terminal==='COMPLETE' && observed.native.trace.trusted===true
    && observed.outcome?.status==='COMMITTED';
}
export function performanceDistribution(samples) {
  const values=samples.map(s=>s.totalMs),sorted=[...values].sort((a,b)=>a-b);
  return {count:samples.length,values,min:sorted[0]??null,median:sorted.length?(sorted[Math.floor((sorted.length-1)/2)]+sorted[Math.floor(sorted.length/2)])/2:null,
    maximum:sorted.at(-1)??null,failures:samples.filter(s=>!s.pass).map(s=>s.id)};
}
