import type { ActiveRange, QueryResult } from "@beekeeperstudio/plugin";

export interface Dataset {
  columns: string[];
  rows: unknown[][];
  /** 1-based row numbers as shown in the source grid. */
  rowNumbers: number[];
}

export function emptyDataset(): Dataset {
  return { columns: [], rows: [], rowNumbers: [] };
}

/** Make column names unique ("id", "id (2)") so they can be used as keys. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    const name = raw || "column";
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} (${count})`;
  });
}

/** Data passed in from a results-grid context menu (the selected cells). */
export function datasetFromRange(range: ActiveRange): Dataset {
  const columns = uniqueNames(range.columns ?? []);
  const rows = (range.value ?? []).map((r) => (Array.isArray(r) ? r : [r]));
  const rowNumbers = rows.map((_, i) => {
    const n = range.rows?.[i];
    return typeof n === "number" && n > 0 ? n : i + 1;
  });
  return { columns, rows, rowNumbers };
}

/**
 * Data from `runQuery`. Rows are keyed by field id (e.g. `c0`) for most drivers
 * and by field name for others, so check both.
 */
export function datasetFromQueryResult(result: Pick<QueryResult, "fields" | "rows">): Dataset {
  const fields = result.fields ?? [];
  const columns = uniqueNames(fields.map((f) => f.name));
  const rows = (result.rows ?? []).map((row: Record<string, unknown>) =>
    fields.map((f) => (f.id in row ? row[f.id] : row[f.name]))
  );
  return { columns, rows, rowNumbers: rows.map((_, i) => i + 1) };
}

export function columnIndex(ds: Dataset, name: string | null | undefined): number {
  return name ? ds.columns.indexOf(name) : -1;
}

/** Turn a subset of rows back into the shape `expandTableResult` expects. */
export function toTableResult(ds: Dataset, rowIndexes: number[], extraColumns: Record<string, (i: number) => unknown> = {}) {
  const extraNames = Object.keys(extraColumns);
  const names = [...extraNames, ...ds.columns];
  const fields = names.map((name, i) => ({ id: `c${i}`, name }));
  const rows = rowIndexes.map((ri) => {
    const out: Record<string, unknown> = {};
    extraNames.forEach((n, i) => {
      out[`c${i}`] = extraColumns[n](ri);
    });
    ds.columns.forEach((_, ci) => {
      out[`c${ci + extraNames.length}`] = toJsonValue(ds.rows[ri][ci]);
    });
    return out;
  });
  return { fields, rows };
}

export function toJsonValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "bigint") return Number(v);
  return v;
}

export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
