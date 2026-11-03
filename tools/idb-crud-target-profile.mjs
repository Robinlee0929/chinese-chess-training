// HTTP test transform only. All product calls and transaction boundaries remain.
// At most five trace marks per measured read/prepare/write operation. Other
// phase times are buffered numbers; no per-receipt or per-domain-call wrappers.
export function crudTargetProfile(source) {
  source=source.replace(/\r\n/g,'\n'); // HTTP copy only; anchors accept Windows files.
  const replace=(a,b)=>{if(!source.includes(a))throw Error('Missing CRUD diagnostic anchor: '+a);source=source.replaceAll(a,b);};
  source+=`\nconst crudMetrics=globalThis.idbCrudMetrics=[];
function crudTick(phase,operationId){if(!globalThis.idbCrudCase)return;const at=performance.now();const item={phase,operationId,at};
if(phase==='T0-page'||phase==='T1-transaction-created'||phase==='T9-adapter-complete'){item.name='crud|'+globalThis.idbCrudCase+'|'+crudMetrics.length+'|'+phase;performance.mark(item.name,{startTime:at});}crudMetrics.push(item);}
globalThis.idbCrudTick=crudTick;\n`;
  replace('export function validateCustomPositionIDBState(rawEnvelope, rawMetadata) {',
    "export function validateCustomPositionIDBState(rawEnvelope, rawMetadata) { crudTick('V0-full-validation-start');");
  replace('const base = validateCustomPositionEnvelope(metadata.baseEnvelope);',
    "const base = validateCustomPositionEnvelope(metadata.baseEnvelope); crudTick('V1-envelope-and-base-validated');");
  replace('for (let i = 0; i < metadata.commits.length; i++) {',
    "crudTick('T5-witness-replay-start'); for (let i = 0; i < metadata.commits.length; i++) {");
  replace("if (exact(replay) !== exact(envelope)) fail('WITNESS_DATA_MISMATCH');\n  const last = metadata.commits.at(-1);",
    "crudTick('T5-witness-replay-end'); if (exact(replay) !== exact(envelope)) fail('WITNESS_DATA_MISMATCH');\n  const last = metadata.commits.at(-1);");
  replace('  validatedStates.add(state); return state;',
    "  validatedStates.add(state); crudTick('T4-full-validation-end'); return state;");
  replace('function connect() {',"function connect() { crudTick(connection?'connection-reuse':'connection-open-request');");
  replace('let tx; try { tx = db.transaction(',"crudTick('T1-transaction-request',token?.operationId); let tx; try { tx = db.transaction(");
  replace('active.add(entry);',"active.add(entry); crudTick('T1-transaction-created',token?.operationId);");
  replace('tx.oncomplete = () => {',"tx.oncomplete = () => { crudTick('T9-adapter-complete',token?.operationId);");
  replace('envelope = event.target.result; loaded();',"crudTick('T3-envelope-callback',token?.operationId); envelope = event.target.result; crudTick('T3-envelope-decoded',token?.operationId); loaded();");
  replace("store.get('metadata').onsuccess = event => { metadata = event.target.result; loaded(); };",
    "store.get('metadata').onsuccess = event => { crudTick('T3-metadata-callback',token?.operationId); metadata = event.target.result; crudTick('T3-metadata-decoded',token?.operationId); loaded(); }; crudTick('T2-reads-queued',token?.operationId);");
  replace('const applied = applyCustomPositionOperation(state.envelope, token.command,',
    "crudTick('T6-mutation-start',token.operationId); const applied = applyCustomPositionOperation(state.envelope, token.command,");
  replace('entry.result = appendValidatedReceipt(state, envelope, receipt);',
    "entry.result = appendValidatedReceipt(state, envelope, receipt); crudTick('T6-mutation-end',token.operationId);");
  replace("store.put(envelope, 'envelope'); store.put(metadata, 'metadata');",
    "crudTick('T7-put-start',token?.operationId); store.put(envelope, 'envelope'); store.put(metadata, 'metadata'); crudTick('T7-put-queued',token?.operationId);");
  replace('tx.commit(); entry.committing = true;',
    "crudTick('T8-commit-call',token?.operationId); tx.commit(); entry.committing = true; crudTick('T8-commit-returned',token?.operationId);");
  return source;
}
