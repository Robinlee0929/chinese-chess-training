// Test-server mutations only. Not part of the application module graph.
export function migrationVariant(source, variant, file) {
  const change=(from,to)=>{if(!source.includes(from))throw Error('Missing migration mutation '+variant);source=source.replaceAll(from,to);};
  if(file==='custom-position-migration.js'){
    if(variant==='ignore-legacy')change('if (raw === null)', 'if (true)');
    if(variant==='early-active')change('guard(captured); const staged = await adapter.write(operation); guard(captured);',
      "guard(captured); void adapter.write(operation); return frozen({state:'ACTIVE',outcome:'COMMITTED',nativeEvent:'UNKNOWN'}); const staged = null;");
    if(variant==='overwrite-active'){
      change('if (!local || local.used || local.epoch !== captured)', 'if (!local)');
      change('if (current.snapshot) {', 'if (false && current.snapshot) {');
    }
    if(variant==='ignore-fingerprint')change("if (current.status !== 'VALID' || current.raw !== plan.sourceRaw || current.sourceFingerprint !== plan.sourceFingerprint)", 'if (false)');
  }
  if(file==='custom-position-migration-state.js'&&variant==='overwrite-active')change("if (token.expectedRevision !== null || state !== null)", 'if (token.expectedRevision !== null)');
  return source;
}
