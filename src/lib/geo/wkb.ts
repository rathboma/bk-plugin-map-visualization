import type { Geometry, Position } from "geojson";

export interface ParsedGeometry {
  geometry: Geometry;
  srid?: number;
}

const HEX_RE = /^[0-9a-fA-F]+$/;

/** Accepts "0101...", "\x0101..." (Postgres bytea) and "0x0101..." (MySQL / SQL Server display). */
export function hexToBytes(input: string): Uint8Array | null {
  let hex = input.trim();
  if (hex.startsWith("\\x") || hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2);
  if (hex.length < 10 || hex.length % 2 !== 0 || !HEX_RE.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

class Reader {
  private view: DataView;
  offset: number;
  little = true;

  constructor(bytes: Uint8Array, offset = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get remaining() {
    return this.view.byteLength - this.offset;
  }

  u8() {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  u32() {
    const v = this.view.getUint32(this.offset, this.little);
    this.offset += 4;
    return v;
  }

  f64() {
    const v = this.view.getFloat64(this.offset, this.little);
    this.offset += 8;
    return v;
  }
}

interface Header {
  type: number;
  dims: number;
  srid?: number;
}

function readHeader(r: Reader): Header {
  const order = r.u8();
  if (order !== 0 && order !== 1) throw new Error("bad byte order");
  r.little = order === 1;
  const raw = r.u32();
  // EWKB flags (PostGIS)
  const hasZ = (raw & 0x80000000) !== 0;
  const hasM = (raw & 0x40000000) !== 0;
  const hasSrid = (raw & 0x20000000) !== 0;
  let type = raw & 0x0fffffff;
  let dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  // ISO WKB: 1001 = Point Z, 2001 = Point M, 3001 = Point ZM
  if (type > 1000) {
    const iso = Math.floor(type / 1000);
    type = type % 1000;
    dims = iso === 3 ? 4 : 3;
  }
  const srid = hasSrid ? r.u32() : undefined;
  if (type < 1 || type > 7) throw new Error(`unsupported WKB type ${type}`);
  return { type, dims, srid };
}

function readPoint(r: Reader, dims: number): Position {
  const x = r.f64();
  const y = r.f64();
  for (let i = 2; i < dims; i++) r.f64();
  return [x, y];
}

function readPoints(r: Reader, dims: number): Position[] {
  const n = r.u32();
  if (n * dims * 8 > r.remaining) throw new Error("truncated WKB");
  const out: Position[] = [];
  for (let i = 0; i < n; i++) out.push(readPoint(r, dims));
  return out;
}

function readRings(r: Reader, dims: number): Position[][] {
  const n = r.u32();
  const out: Position[][] = [];
  for (let i = 0; i < n; i++) out.push(readPoints(r, dims));
  return out;
}

function readGeometry(r: Reader): ParsedGeometry {
  const { type, dims, srid } = readHeader(r);
  switch (type) {
    case 1: {
      const p = readPoint(r, dims);
      // POINT EMPTY is encoded as NaN coordinates
      if (Number.isNaN(p[0]) || Number.isNaN(p[1])) throw new Error("empty point");
      return { geometry: { type: "Point", coordinates: p }, srid };
    }
    case 2:
      return { geometry: { type: "LineString", coordinates: readPoints(r, dims) }, srid };
    case 3:
      return { geometry: { type: "Polygon", coordinates: readRings(r, dims) }, srid };
    case 4:
    case 5:
    case 6:
    case 7: {
      const n = r.u32();
      const parts: Geometry[] = [];
      for (let i = 0; i < n; i++) parts.push(readGeometry(r).geometry);
      if (type === 4) {
        return {
          geometry: { type: "MultiPoint", coordinates: parts.map((p) => (p as GeoJSON.Point).coordinates) },
          srid,
        };
      }
      if (type === 5) {
        return {
          geometry: {
            type: "MultiLineString",
            coordinates: parts.map((p) => (p as GeoJSON.LineString).coordinates),
          },
          srid,
        };
      }
      if (type === 6) {
        return {
          geometry: { type: "MultiPolygon", coordinates: parts.map((p) => (p as GeoJSON.Polygon).coordinates) },
          srid,
        };
      }
      return { geometry: { type: "GeometryCollection", geometries: parts }, srid };
    }
  }
  throw new Error("unreachable");
}

function tryRead(bytes: Uint8Array, offset: number): ParsedGeometry | null {
  try {
    const r = new Reader(bytes, offset);
    const g = readGeometry(r);
    // A valid parse should consume (nearly) everything; this filters random hex strings.
    if (r.remaining !== 0) return null;
    return g;
  } catch {
    return null;
  }
}

/**
 * Parse WKB / EWKB (PostGIS), MySQL's internal format (4-byte SRID + WKB) and
 * GeoPackage blobs ("GP" header + WKB).
 */
export function parseWkb(bytes: Uint8Array): ParsedGeometry | null {
  if (bytes.length < 9) return null;

  // GeoPackage binary header
  if (bytes[0] === 0x47 && bytes[1] === 0x50) {
    const flags = bytes[3];
    const little = (flags & 0x01) === 1;
    const envelope = (flags >> 1) & 0x07;
    const envelopeBytes = [0, 32, 48, 48, 64][envelope] ?? 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const srid = view.getInt32(4, little);
    const g = tryRead(bytes, 8 + envelopeBytes);
    return g ? { geometry: g.geometry, srid: g.srid ?? srid } : null;
  }

  if (bytes[0] === 0 || bytes[0] === 1) {
    const g = tryRead(bytes, 0);
    if (g) return g;
  }

  // MySQL: little-endian SRID followed by WKB
  if (bytes.length > 13 && (bytes[4] === 0 || bytes[4] === 1)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const srid = view.getUint32(0, true);
    const g = tryRead(bytes, 4);
    if (g) return { geometry: g.geometry, srid: g.srid ?? (srid || undefined) };
  }
  return null;
}

export function parseWkbHex(input: string): ParsedGeometry | null {
  const bytes = hexToBytes(input);
  return bytes ? parseWkb(bytes) : null;
}
