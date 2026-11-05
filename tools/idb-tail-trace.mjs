import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export const requestedCategories=['toplevel','devtools.timeline','blink.user_timing','v8','v8.execute','disabled-by-default-v8.gc','IndexedDB','renderer.scheduler','sequence_manager','config.scheduler.record_task_post_time'];
export const traceConfig={recordMode:'recordUntilFull',traceBufferSizeInKb:32768,includedCategories:requestedCategories};
export async function endTrace(h,startIndex,filename){
  await h.send('Tracing.end');
  const complete=await h.until(e=>e.method==='Tracing.tracingComplete',10000,startIndex);
  assert.ok(complete.params?.stream,'Trace must expose its completed stream');
  const chunks=[];let eof=false;
  for(let i=0;i<1024&&!eof;i++){
    const r=await h.send('IO.read',{handle:complete.params.stream,size:1024*1024});
    chunks.push(Buffer.from(r.data,r.base64Encoded?'base64':'utf8'));eof=!!r.eof;
  }
  await h.send('IO.close',{handle:complete.params.stream});assert.ok(eof,'Bounded stream extraction reached EOF');
  const bytes=Buffer.concat(chunks);await writeFile(path.join(h.evidence,filename+'.trace.json'),bytes);
  const parsed=JSON.parse(bytes.toString('utf8'));
  const integrity={complete:complete.params,streamEOF:eof,parsed:true,eventCount:parsed.traceEvents.length,bytes:bytes.length,
    bufferReports:h.events.slice(startIndex).filter(e=>e.method==='Tracing.bufferUsage').map(e=>e.params)};
  await h.save(filename+'-trace-integrity',integrity);return {parsed,integrity};
}
export async function tracingCapabilities(h,b){
  let result=await h.send('Tracing.getCategories',{},b.sessionId);await h.save('categories-initial',result);
  if(!result.categories.length){
    // This Chrome lazily registers categories. Empty warm-up, no measurement.
    const start=h.events.length;
    await h.send('Tracing.start',{transferMode:'ReturnAsStream',traceConfig:{recordMode:'recordUntilFull',includedCategories:['__metadata'],traceBufferSizeInKb:1024}});
    await endTrace(h,start,'capability-warmup');result=await h.send('Tracing.getCategories',{},b.sessionId);
  }
  await h.save('categories',result);
  const missing=requestedCategories.filter(c=>!result.categories.includes(c));assert.deepEqual(missing,[],'Only actually advertised categories are enabled');
  return result;
}
export async function clockProbes(h,b){
  const probes=[];
  for(let i=0;i<3;i++){const sent=performance.now(),page=await h.evaluate(b,'performance.now()'),received=performance.now();probes.push({sent,page,received,nodeMinusPageMin:sent-page,nodeMinusPageMax:received-page});}
  return probes;
}
export function integrityValid(integrity){
  return integrity?.parsed===true&&integrity.streamEOF===true&&integrity.complete?.dataLossOccurred===false
    &&(integrity.bufferReports??[]).every(b=>(b.percentFull??b.value??0)<1);
}
export function unionMs(intervals,low=-Infinity,high=Infinity){
  const sorted=intervals.map(([a,b])=>[Math.max(a,low),Math.min(b,high)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
  let total=0,end=-Infinity;for(const [a,b] of sorted){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total/1000;
}
export function alignMarkers(trace,metrics){
  const pairs=metrics.map(m=>{const e=trace.traceEvents.find(e=>e.name===m.name);return e?{...m,traceTs:e.ts,pid:e.pid,tid:e.tid,offsetUs:e.ts-m.at*1000}:null;}).filter(Boolean);
  if(!pairs.length||pairs.length!==metrics.length)return {valid:false,reason:'MISSING_MARKERS',pairs};
  const offsets=pairs.map(p=>p.offsetUs),spreadUs=Math.max(...offsets)-Math.min(...offsets);
  // performance.now is quantized; reject an inconsistent bridge, never use UTC.
  return {valid:spreadUs<=250&&new Set(pairs.map(p=>p.pid+':'+p.tid)).size===1,spreadUs,
    offsetUs:offsets.reduce((a,b)=>a+b,0)/offsets.length,pid:pairs[0].pid,tid:pairs[0].tid,pairs};
}
export function summarizeTrace(trace,integrity,metrics,native){
  const alignment=alignMarkers(trace,metrics);
  if(!integrityValid(integrity)||!alignment.valid)return {usable:false,alignment,reason:'INCOMPLETE_TRACE_OR_CLOCK_BRIDGE'};
  const low=metrics.find(m=>m.phase==='T0-page').at*1000+alignment.offsetUs,high=native.trace.perf*1000+alignment.offsetUs;
  const thread=trace.traceEvents.filter(e=>e.pid===alignment.pid&&e.tid===alignment.tid);
  // Chrome complete slices (X) have durations. Other phases remain raw evidence.
  const slices=thread.filter(e=>e.ph==='X'&&Number.isFinite(e.dur)&&e.ts<high&&e.ts+e.dur>low);
  const spans=filter=>slices.filter(filter).map(e=>[e.ts,e.ts+e.dur]);
  const tasks=slices.filter(e=>e.name==='ThreadControllerImpl::RunTask');
  const fullTasks=tasks.filter(e=>e.ts>=low&&e.ts+e.dur<=high);
  const gc=e=>e.cat?.includes('v8')&&(/GC|Scavenge|MarkCompact/.test(e.name));
  const names={};for(const e of slices){const x=names[e.name]??={count:0,sumMs:0,maxMs:0,threadCpuMs:0,threadCpuPresent:0};x.count++;x.sumMs+=e.dur/1000;x.maxMs=Math.max(x.maxMs,e.dur/1000);if(e.tdur!==undefined){x.threadCpuMs+=e.tdur/1000;x.threadCpuPresent++;}}
  const idb=trace.traceEvents.filter(e=>e.cat?.split(',').includes('IndexedDB')&&e.ts>=low&&e.ts<=high);
  return {usable:true,alignment,window:{low,high,ms:(high-low)/1000},rendererMainTaskWallMs:unionMs(spans(e=>e.name==='ThreadControllerImpl::RunTask'),low,high),
    fullyContainedTaskCount:fullTasks.length,fullyContainedTaskCpuMs:fullTasks.filter(e=>Number.isFinite(e.tdur)).reduce((n,e)=>n+e.tdur/1000,0),
    tasksWithCpu:fullTasks.filter(e=>Number.isFinite(e.tdur)).length,mainThreadGCUnionMs:unionMs(spans(gc),low,high),
    javascriptSliceUnionMs:unionMs(spans(e=>['FunctionCall','EvaluateScript','V8.Execute'].includes(e.name)),low,high),
    largestTasks:tasks.sort((a,b)=>b.dur-a.dur).slice(0,8),eventNames:names,idbEvents:idb,
    schedulerEvidence:thread.filter(e=>e.ts>=low&&e.ts<=high&&(/scheduler|sequence_manager/.test(e.cat)||/Task/.test(e.name))),
    caveat:'Wall slices can include preemption; nested categories overlap. tdur covers only reported fully contained tasks. Without matching ready/post timestamps, runnable delay remains UNKNOWN.'};
}
