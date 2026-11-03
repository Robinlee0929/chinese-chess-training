// Test-server-only profiling. No additional promises, tasks, timers or awaits.
// Measurements are buffered in the page and retrieved AFTER the native outcome.
export function performanceProfile(source) {
  const replace=(a,b)=>{if(!source.includes(a))throw Error('Missing profile anchor: '+a);source=source.replaceAll(a,b);};
  const wrap=(name,label,exported=false)=>{const declaration=(exported?'export ':'')+'function '+name+'(';
    replace(declaration,'function raw_'+name+'(');
    const wrapper=(exported?'export ':'')+`function ${name}(...args){return measured('${label}',raw_${name},args);}\n`;
    replace('function raw_'+name+'(',wrapper+'function raw_'+name+'(');};
  replace('import { validateCustomPositionEnvelope, applyCustomPositionOperation }','import { validateCustomPositionEnvelope as rawEnvelope, applyCustomPositionOperation as rawOperation }');
  source+=`\nconst measurements=globalThis.idbMeasurements=[];
function measured(phase,fn,args){const start=performance.now();try{return fn(...args)}finally{measurements.push({phase,start,end:performance.now()})}}
function tick(phase,operationId){measurements.push({phase,operationId,at:performance.now()})}
function validateCustomPositionEnvelope(...args){return measured('canonical-envelope',rawEnvelope,args)}
function applyCustomPositionOperation(...args){return measured('domain-operation',rawOperation,args)}\n`;
  wrap('validateCustomPositionIDBState','full-state-validation',true);
  wrap('validateReceipt','witness-validation');wrap('appendValidatedReceipt','append-validation');
  replace('const exact = value => JSON.stringify(data(value));',"const exact = value => measured('exact-comparison',v=>JSON.stringify(data(v)),[value]);");
  replace('validateCustomPositionEnvelope(data(rawEnvelope)), metadata = data(rawMetadata)',"validateCustomPositionEnvelope(measured('envelope-copy',data,[rawEnvelope])), metadata = measured('metadata-copy',data,[rawMetadata])");
  if(source.includes('import { validateMigrationState,')){
    replace('import { validateMigrationState,','import { validateMigrationState as rawMigrationState,');
    source+="\nfunction validateMigrationState(...args){return measured('migration-validation',rawMigrationState,args)}\n";
  }
  replace('function connect() {',"function connect() { tick(connection?'connection-reuse':'connection-open-request');");
  replace('const db = request.result;',"tick('connection-open-success'); const db = request.result;");
  replace("let tx; try { tx = db.transaction(","tick('transaction-request',token?.operationId); let tx; try { tx = db.transaction(");
  replace('active.add(entry);',"active.add(entry); tick('transaction-created',token?.operationId);");
  replace('tx.oncomplete = () => {',"tx.oncomplete = () => { tick('transaction-complete',token?.operationId);");
  replace('envelope = event.target.result; loaded();',"tick('envelope-read-event',token?.operationId); envelope = event.target.result; tick('envelope-read-delivered',token?.operationId); loaded();");
  replace('metadata = event.target.result; loaded();',"tick('metadata-read-event',token?.operationId); metadata = event.target.result; tick('metadata-read-delivered',token?.operationId); loaded();");
  replace('const id = applied.result.position?.id ?? token.command.id;',"tick('receipt-start',token.operationId); const id = applied.result.position?.id ?? token.command.id;");
  replace('entry.result = appendValidatedReceipt(state, envelope, receipt);',"tick('receipt-constructed',token.operationId); entry.result = appendValidatedReceipt(state, envelope, receipt);");
  replace("store.put(envelope, 'envelope'); store.put(metadata, 'metadata');", "tick('writes-start',token?.operationId); store.put(envelope, 'envelope'); store.put(metadata, 'metadata'); tick('writes-queued',token?.operationId);");
  replace('tx.commit(); entry.committing = true;',"tick('commit-start',token?.operationId); tx.commit(); entry.committing = true; tick('commit-called',token?.operationId);");
  return source;
}
