// TEST ONLY. No production import. This deliberately supports the repository's
// SELECT/WITH-read + toArray() surface, not arbitrary SQLite administration.
// Native rowsWritten complements (but cannot replace) attempt classification:
// no-row DML, IF NOT EXISTS DDL and writable PRAGMAs can report zero rows.
function statements(query) {
  if (typeof query !== 'string' || query.includes('\0')) return null;
  const programs = [[]];
  for (let i = 0; i < query.length;) {
    const c = query[i];
    if (/\s/u.test(c)) { i++; continue; }
    if (query.startsWith('--', i)) {
      const end = query.indexOf('\n', i + 2); i = end < 0 ? query.length : end + 1; continue;
    }
    if (query.startsWith('/*', i)) {
      const end = query.indexOf('*/', i + 2); i = end < 0 ? query.length : end + 2; continue;
    }
    if (['\'', '"', '`', '['].includes(c)) {
      const endQuote = c === '[' ? ']' : c;
      let closed = false; i++;
      while (i < query.length) {
        if (query[i++] !== endQuote) continue;
        if (c !== '[' && query[i] === endQuote) { i++; continue; }
        closed = true; break;
      }
      if (!closed) return null;
      programs.at(-1).push('#QUOTED'); continue;
    }
    if (c === ';') { programs.push([]); i++; continue; }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/u.exec(query.slice(i));
    if (word) { programs.at(-1).push(word[0].toUpperCase()); i += word[0].length; }
    else { programs.at(-1).push(c); i++; }
  }
  return programs.filter(tokens => tokens.length);
}

export function isReadOnlySQL(query) {
  const programs = statements(query);
  if (!programs?.length) return false;
  return programs.every(tokens => {
    if (!['SELECT', 'WITH'].includes(tokens[0])) return false;
    // Inspect ALL unquoted tokens, including WITH's eventual main statement.
    // Unknown statement families (PRAGMA, EXPLAIN, transactions, etc.) fail
    // closed. SQLite does not permit write statements in SELECT subqueries.
    const mutators = new Set(['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
      'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT',
      'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'LOAD_EXTENSION', 'WRITEFILE', 'EVAL']);
    return tokens.every((token, index) => !mutators.has(token)
      && !(token === 'REPLACE' && tokens[index + 1] !== '(')
      && (!token.startsWith('PRAGMA_') || token === 'PRAGMA_TABLE_INFO'));
  });
}

export function createSQLWriteDetector(execute, counts) {
  const deny = () => { counts.writes++; throw new Error('WRITE ATTEMPT'); };
  return (query, ...args) => {
    if (!isReadOnlySQL(query)) return deny();
    // Consume the native cursor before accepting its execution-grounded count.
    // Only toArray() is used by the scoped constructor, snapshot and dump code.
    const cursor = execute(query, ...args);
    const rows = cursor.toArray();
    if (cursor.rowsWritten !== 0) return deny();
    return { toArray: () => rows };
  };
}
