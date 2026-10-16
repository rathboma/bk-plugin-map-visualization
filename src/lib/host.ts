export const TABLE_ROW_LIMIT = 10000;

type Dialect = "backtick" | "bracket" | "double";

function dialectFor(dbType: string | undefined): Dialect {
  switch (dbType) {
    case "mysql":
    case "mariadb":
    case "bigquery":
    case "clickhouse":
    case "tidb":
      return "backtick";
    case "sqlserver":
      return "bracket";
    default:
      return "double";
  }
}

export function quoteIdent(name: string, dbType?: string): string {
  switch (dialectFor(dbType)) {
    case "backtick":
      return "`" + name.replace(/`/g, "``") + "`";
    case "bracket":
      return "[" + name.replace(/]/g, "]]") + "]";
    default:
      return '"' + name.replace(/"/g, '""') + '"';
  }
}

/**
 * A starter SELECT for "View on Map" on a table in the sidebar, or the
 * Visualize menu of a table view. `where` is the SQL condition for the
 * table view's filters, as Beekeeper Studio sends it.
 */
export function buildTableQuery(
  entity: { name: string; schema?: string },
  dbType?: string,
  limit = TABLE_ROW_LIMIT,
  where = "",
): string {
  if (dbType === "mongodb" || dbType === "redis") return "";
  let table: string;
  if (dbType === "bigquery") {
    table = quoteIdent(entity.schema ? `${entity.schema}.${entity.name}` : entity.name, dbType);
  } else {
    table = entity.schema ? `${quoteIdent(entity.schema, dbType)}.${quoteIdent(entity.name, dbType)}` : quoteIdent(entity.name, dbType);
  }
  const filter = where.trim() ? ` WHERE ${where.trim()}` : "";
  switch (dbType) {
    case "sqlserver":
      return `SELECT TOP ${limit} * FROM ${table}${filter}`;
    case "oracle":
      return `SELECT * FROM ${table}${filter} FETCH FIRST ${limit} ROWS ONLY`;
    case "firebird":
      return `SELECT FIRST ${limit} * FROM ${table}${filter}`;
    default:
      return `SELECT * FROM ${table}${filter} LIMIT ${limit}`;
  }
}

/** Pick the query text passed from the editor context menu. */
export function queryFromEditorParams(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const p = params as { selectedText?: string; selectedQuery?: string; text?: string };
  return (p.selectedText?.trim() || p.selectedQuery?.trim() || p.text?.trim() || "").replace(/;\s*$/, "");
}

const READ_ONLY_START = /^\s*(select|with|values|table|show|explain)\b/i;
const WRITE_KEYWORDS = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|call|exec|execute|copy|into)\b/i;

/**
 * Whether a saved query is safe to re-run automatically when the tab is restored:
 * a single read-only statement with no data-modifying keywords.
 */
export function isSafeToAutoRun(query: string): boolean {
  const q = query.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim().replace(/;\s*$/, "");
  if (!q || q.includes(";")) return false;
  return READ_ONLY_START.test(q) && !WRITE_KEYWORDS.test(q);
}
