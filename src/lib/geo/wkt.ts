import type { Geometry, Position } from "geojson";
import type { ParsedGeometry } from "./wkb";

const TYPES = [
  "GEOMETRYCOLLECTION",
  "MULTIPOLYGON",
  "MULTILINESTRING",
  "MULTIPOINT",
  "POLYGON",
  "LINESTRING",
  "POINT",
] as const;
type WktType = (typeof TYPES)[number];

const QUICK_RE = /^\s*(SRID=\d+;\s*)?(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i;

export function looksLikeWkt(s: string): boolean {
  return QUICK_RE.test(s);
}

class Tokens {
  pos = 0;
  constructor(private s: string) {}

  skipWs() {
    while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++;
  }

  peek(): string {
    this.skipWs();
    return this.s[this.pos] ?? "";
  }

  expect(ch: string) {
    if (this.peek() !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos++;
  }

  word(): string {
    this.skipWs();
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.pos));
    if (!m) return "";
    this.pos += m[0].length;
    return m[0].toUpperCase();
  }

  number(): number {
    this.skipWs();
    const m = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(this.s.slice(this.pos));
    if (!m) throw new Error(`expected number at ${this.pos}`);
    this.pos += m[0].length;
    return Number(m[0]);
  }

  get done() {
    this.skipWs();
    return this.pos >= this.s.length;
  }
}

function readPosition(t: Tokens): Position {
  const x = t.number();
  const y = t.number();
  // Drop Z / M values
  while (/[-+.\d]/.test(t.peek())) t.number();
  return [x, y];
}

function readPositionList(t: Tokens): Position[] {
  t.expect("(");
  const out: Position[] = [];
  do {
    // MULTIPOINT allows both "(1 2, 3 4)" and "((1 2), (3 4))"
    if (t.peek() === "(") {
      t.expect("(");
      out.push(readPosition(t));
      t.expect(")");
    } else {
      out.push(readPosition(t));
    }
  } while (t.peek() === "," && (t.expect(","), true));
  t.expect(")");
  return out;
}

function readNested<T>(t: Tokens, inner: (t: Tokens) => T): T[] {
  t.expect("(");
  const out: T[] = [];
  do {
    out.push(inner(t));
  } while (t.peek() === "," && (t.expect(","), true));
  t.expect(")");
  return out;
}

function readTagged(t: Tokens): Geometry | null {
  const type = t.word() as WktType;
  if (!TYPES.includes(type)) throw new Error(`unknown WKT type ${type}`);
  // Optional dimension tag: Z, M, ZM
  const save = t.pos;
  const dim = t.word();
  if (dim && !["Z", "M", "ZM"].includes(dim)) t.pos = save;
  if (t.peek() !== "(") {
    if (t.word() === "EMPTY") return null;
    throw new Error("expected (");
  }
  switch (type) {
    case "POINT": {
      t.expect("(");
      const p = readPosition(t);
      t.expect(")");
      return { type: "Point", coordinates: p };
    }
    case "LINESTRING":
      return { type: "LineString", coordinates: readPositionList(t) };
    case "POLYGON":
      return { type: "Polygon", coordinates: readNested(t, readPositionList) };
    case "MULTIPOINT":
      return { type: "MultiPoint", coordinates: readPositionList(t) };
    case "MULTILINESTRING":
      return { type: "MultiLineString", coordinates: readNested(t, readPositionList) };
    case "MULTIPOLYGON":
      return {
        type: "MultiPolygon",
        coordinates: readNested(t, (tt) => readNested(tt, readPositionList)),
      };
    case "GEOMETRYCOLLECTION": {
      const geometries = readNested(t, readTagged).filter((g): g is Geometry => g !== null);
      return { type: "GeometryCollection", geometries };
    }
  }
}

/** Parse WKT or PostGIS EWKT ("SRID=4326;POINT(...)"). Coordinates are x/y (lng/lat). */
export function parseWkt(input: string): ParsedGeometry | null {
  if (!looksLikeWkt(input)) return null;
  let s = input.trim();
  let srid: number | undefined;
  const sridMatch = /^SRID=(\d+);/i.exec(s);
  if (sridMatch) {
    srid = Number(sridMatch[1]);
    s = s.slice(sridMatch[0].length);
  }
  try {
    const t = new Tokens(s);
    const geometry = readTagged(t);
    if (!geometry || !t.done) return null;
    return { geometry, srid };
  } catch {
    return null;
  }
}
