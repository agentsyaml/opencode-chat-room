// SQLite -> PostgreSQL translation for the chat-room state SQL. The app's SQL
// uses ? placeholders, SQLite DDL, a few pragmas and a handful of scalar
// functions; everything else is deliberately passed through unchanged.
//
// This is intentionally not a general SQLite translator. Keep the dialect
// narrow and add a test when the state layer starts using a new construct.

const PRAGMA_TABLE_INFO = /PRAGMA\s+table_info\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi;

function pragmaTableInfo(table) {
  const tableName = table.replace(/'/g, "''");
  return `SELECT c.column_name AS name,c.data_type AS type,` +
    `CASE WHEN c.is_nullable='NO' THEN 1 ELSE 0 END AS "notnull",` +
    `c.column_default AS dflt_value,` +
    `CASE WHEN EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) ` +
    `WHERE i.indrelid=(quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass AND i.indisprimary AND a.attname=c.column_name) ` +
    `THEN 1 ELSE 0 END AS pk ` +
    `FROM information_schema.columns c WHERE c.table_schema=current_schema() AND c.table_name='${tableName}' ORDER BY c.ordinal_position`;
}

const isIdentStart = (ch) => !!ch && /[A-Za-z_]/.test(ch);
const isIdentChar = (ch) => !!ch && /[A-Za-z0-9_$]/.test(ch);

function skipQuoted(sql, index) {
  const quote = sql[index];
  let i = index + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return i;
}

function skipComment(sql, index) {
  if (sql[index + 1] === "-") {
    const end = sql.indexOf("\n", index + 2);
    return end < 0 ? sql.length : end;
  }
  const end = sql.indexOf("*/", index + 2);
  return end < 0 ? sql.length : end + 2;
}

function hasTopLevelComma(sql, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') { i = skipQuoted(sql, i) - 1; continue; }
    if (ch === "-" && sql[i + 1] === "-") { i = skipComment(sql, i) - 1; continue; }
    if (ch === "/" && sql[i + 1] === "*") { i = skipComment(sql, i) - 1; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return false; }
    else if (ch === "," && depth === 1) return true;
  }
  return false;
}

function wordBefore(sql, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(sql[i])) i--;
  const end = i + 1;
  while (i >= 0 && isIdentChar(sql[i])) i--;
  return sql.slice(i + 1, end).toLowerCase();
}

function wordAfter(sql, index) {
  let i = index + 1;
  while (i < sql.length && /\s/.test(sql[i])) i++;
  const start = i;
  while (i < sql.length && isIdentChar(sql[i])) i++;
  return sql.slice(start, i).toLowerCase();
}

function scan(sql) {
  let out = "";
  let index = 0;
  let parameter = 0;
  while (index < sql.length) {
    const ch = sql[index];
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (ch === "-" && sql[index + 1] === "-") {
      const end = skipComment(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (ch === "/" && sql[index + 1] === "*") {
      const end = skipComment(sql, index);
      out += sql.slice(index, end);
      index = end;
      continue;
    }
    if (ch === "?") {
      // CASE WHEN ? needs a boolean; a bare `? IS NULL` has no type to infer.
      const nextWord = wordAfter(sql, index);
      const cast = (wordBefore(sql, index) === "when" && nextWord === "then") || nextWord === "is";
      out += `$${++parameter}${cast ? (nextWord === "is" ? "::text" : "::boolean") : ""}`;
      index++;
      continue;
    }
    if (isIdentStart(ch)) {
      let end = index + 1;
      while (isIdentChar(sql[end])) end++;
      const word = sql.slice(index, end);
      const lower = word.toLowerCase();
      // SQLite's scalar max(a,b)/min(a,b); the one-argument aggregate forms stay.
      if (lower === "max" || lower === "min") {
        let next = end;
        while (next < sql.length && /\s/.test(sql[next])) next++;
        if (sql[next] === "(" && hasTopLevelComma(sql, next)) {
          out += lower === "max" ? "GREATEST" : "LEAST";
          index = end;
          continue;
        }
      }
      // Preserve camelCase result aliases: PostgreSQL folds unquoted identifiers.
      if (lower === "as") {
        const previous = wordBefore(sql, index);
        let next = end;
        while (next < sql.length && /\s/.test(sql[next])) next++;
        if (isIdentStart(sql[next])) {
          let aliasEnd = next + 1;
          while (isIdentChar(sql[aliasEnd])) aliasEnd++;
          const alias = sql.slice(next, aliasEnd);
          if (/[A-Z]/.test(alias) && previous !== "default" && alias.toLowerCase() !== "identity") {
            out += `AS "${alias}"`;
            index = aliasEnd;
            continue;
          }
        }
      }
      out += word;
      index = end;
      continue;
    }
    out += ch;
    index++;
  }
  return out;
}

function appendOnConflictDoNothing(sql) {
  return `${sql.replace(/[\s;]+$/, "")} ON CONFLICT DO NOTHING`;
}

export function translate(sql) {
  let text = String(sql);
  // Connection tuning pragmas have no PostgreSQL equivalent; foreign keys are
  // always enforced and concurrency is handled by advisory locks.
  text = text.replace(/PRAGMA\s+(?:busy_timeout|journal_mode|foreign_keys)\s*(?:=\s*[^;]+)?\s*;?/gi, "");
  text = text.replace(PRAGMA_TABLE_INFO, (_, table) => pragmaTableInfo(table));
  // SQLite INTEGER is 64-bit; PostgreSQL INTEGER is 32-bit and epoch
  // milliseconds overflow it.
  text = text.replace(/\bINTEGER\b/gi, "BIGINT");
  text = text.replace(/\bBIGINT\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");
  // Manual `BEGIN IMMEDIATE` appears inside receiver-state's schema script.
  text = text.replace(/\bBEGIN\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE)\b/gi, "BEGIN");
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(text)) {
    text = text.replace(/\bINSERT\s+OR\s+IGNORE\b/gi, "INSERT");
    if (!/\bON\s+CONFLICT\b/i.test(text)) text = appendOnConflictDoNothing(text);
  }
  // SQLite treats 1/0 as booleans; PostgreSQL needs an explicit cast.
  return scan(text).trim();
}

export function hasSql(text) {
  return text.replace(/[;\s]/g, "").length > 0;
}