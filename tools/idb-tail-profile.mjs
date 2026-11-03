// Diagnostic HTTP transform only. No additional task, promise or transaction.
export function tailProfile(source) {
  const replace=(a,b)=>{if(!source.includes(a))throw Error('Missing tail anchor: '+a);source=source.replaceAll(a,b);};
  const wrap=(name,label,exported=false)=>{
    replace((exported?'export ':'')+'function '+name+'(',
      (exported?'export ':'')+`function ${name}(...args){return tailMeasured('${label}',raw_${name},args);}\nfunction raw_${name}(`);
  };
  replace('import { validateCustomPositionEnvelope, applyCustomPositionOperation }',
    'import { validateCustomPositionEnvelope, applyCustomPositionOperation as rawOperation }');
  source+=`\nconst tailEvents=globalThis.idbTailEvents=[];
function tailTick(phase,operationId){if(!globalThis.idbTailCase)return;const at=performance.now(),name='tail|'+globalThis.idbTailCase+'|'+tailEvents.length+'|'+phase;tailEvents.push({phase,operationId,at,name});performance.mark(name,{startTime:at});}
globalThis.idbTailTick=tailTick;
function tailMeasured(phase,fn,args){tailTick(phase+'-start');try{return fn(...args)}finally{tailTick(phase+'-end')}}
function applyCustomPositionOperation(...args){return tailMeasured('T6-domain-operation',rawOperation,args)}\n`;
  wrap('validateCustomPositionIDBState','T5-full-validation',true);
  wrap('appendValidatedReceipt','T6-append-receipt');
  replace('function connect() {',"function connect() { tailTick(connection?'T1-connection-reuse':'T1-open-request');");
  replace('const db = request.result;',"tailTick('T1-open-success'); const db = request.result;");
  replace('let tx; try { tx = db.transaction(',"tailTick('T2-transaction-request',token?.operationId); let tx; try { tx = db.transaction(");
  replace('active.add(entry);',"active.add(entry); tailTick('T2-transaction-created',token?.operationId);");
  replace('tx.oncomplete = () => {',"tx.oncomplete = () => { tailTick('T9-adapter-complete',token?.operationId);");
  replace('envelope = event.target.result; loaded();',"tailTick('T4-envelope-callback',token?.operationId); envelope = event.target.result; tailTick('T4-envelope-decoded',token?.operationId); loaded();");
  // The T3 marker is after both get() calls, never after an asynchronous read.
  replace("store.get('metadata').onsuccess = event => { metadata = event.target.result; loaded(); };",
    "store.get('metadata').onsuccess = event => { tailTick('T4-metadata-callback',token?.operationId); metadata = event.target.result; tailTick('T4-metadata-decoded',token?.operationId); loaded(); }; tailTick('T3-reads-queued',token?.operationId);");
  replace("store.put(envelope, 'envelope'); store.put(metadata, 'metadata');", "tailTick('T7-writes-start',token?.operationId); store.put(envelope, 'envelope'); store.put(metadata, 'metadata'); tailTick('T7-writes-queued',token?.operationId);");
  replace('tx.commit(); entry.committing = true;',"tailTick('T8-commit-start',token?.operationId); tx.commit(); entry.committing = true; tailTick('T8-commit-returned',token?.operationId);");
  return source;
}
