// TEST ONLY. No production import. This deliberately supports the repository's
// SELECT/WITH-read + toArray() surface, not arbitrary SQLite administration.
// Native rowsWritten complements (but cannot replace) attempt classification:
// no-row DML, IF NOT EXISTS DDL and writable PRAGMAs can report zero rows.
const READ_ONLY_PRAGMA_RELATIONS = new Set(['PRAGMA_TABLE_INFO']);
const MUTATION_TOKENS = new Set(['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
  'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT',
  'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'LOAD_EXTENSION', 'WRITEFILE', 'EVAL']);
const UNSAFE_FUNCTIONS = new Set(['LOAD_EXTENSION', 'WRITEFILE', 'EVAL']);

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
      let closed = false; let value = ''; i++;
      while (i < query.length) {
        const current = query[i++];
        if (current !== endQuote) { value += current; continue; }
        if (c !== '[' && query[i] === endQuote) { value += endQuote; i++; continue; }
        closed = true; break;
      }
      if (!closed) return null;
      programs.at(-1).push({ quoted: c, value: value.toUpperCase() }); continue;
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
    const text = token => typeof token === 'string' ? token : token?.value;
    let inFrom = false; let expectsRelation = false;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]; const value = text(token);
      if (typeof token === 'string') {
        if (MUTATION_TOKENS.has(value) || (value === 'REPLACE' && text(tokens[index + 1]) !== '(')
          || (value.startsWith('PRAGMA_') && !READ_ONLY_PRAGMA_RELATIONS.has(value))) return false;
        if (value === 'FROM' || value === 'JOIN') { inFrom = true; expectsRelation = true; continue; }
        if (['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW'].includes(value)) {
          inFrom = false; expectsRelation = false; continue;
        }
        if (value === ',' && inFrom) { expectsRelation = true; continue; }
      }
      if (typeof token !== 'string') {
        const pragmaRelation = value.startsWith('PRAGMA_') && !READ_ONLY_PRAGMA_RELATIONS.has(value);
        if ((expectsRelation && pragmaRelation)
          || (UNSAFE_FUNCTIONS.has(value) && text(tokens[index + 1]) === '(')) return false;
      }
      if (expectsRelation && value !== '(' && value !== '.' && text(tokens[index + 1]) !== '.') {
        expectsRelation = false;
      }
    }
    return true;
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
