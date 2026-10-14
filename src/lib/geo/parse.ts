import type { Geometry, Position } from "geojson";
import { parseWkb, parseWkbHex, type ParsedGeometry } from "./wkb";
import { looksLikeWkt, parseWkt } from "./wkt";
import { decodeGeohash } from "./geohash";

export type { ParsedGeometry };

const EARTH_RADIUS = 6378137;
const MERCATOR_MAX = 20037508.342789244;

/** Web Mercator (EPSG:3857) metres to WGS84 degrees. */
export function mercatorToLngLat(x: number, y: number): Position {
  const lng = (x / EARTH_RADIUS) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) * (180 / Math.PI);
  return [lng, lat];
}

export function isMercatorRange(x: number, y: number): boolean {
  return Math.abs(x) <= MERCATOR_MAX * 1.0001 && Math.abs(y) <= MERCATOR_MAX * 1.5;
}

export const MERCATOR_SRIDS = new Set([3857, 900913, 3785, 102100, 102113]);
export const WGS84_SRIDS = new Set([4326, 4269, 4258, 4283, 4167, 0]);

const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Parse plain numbers and numeric strings. Accepts a decimal comma ("40,7128"). */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "string") return null;
  let s = value.trim();
  if (!s) return null;
  if (!NUMBER_RE.test(s)) {
    // Thousands separators: 1,234,567.89
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
    // Decimal comma: exactly one comma and no dot ("40,7128")
    else if (/^[-+]?\d+,\d+$/.test(s)) s = s.replace(",", ".");
    else return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type Axis = "lat" | "lng";

interface Coordinate {
  value: number;
  axis?: Axis;
}

const HEMI_RE = /[NSEW]/i;

/**
 * Parse a single coordinate: decimal degrees or degrees/minutes/seconds such as
 * `40°42'46"N`, `40 42 46.1 N`, `N40.7128`, `-74:00:21`, `40d42m46s`.
 */
export function parseCoordinateDetailed(value: unknown): Coordinate | null {
  const n = parseNumber(value);
  if (n !== null) return { value: n };
  if (typeof value !== "string") return null;
  let s = value.trim().toUpperCase();
  if (!s || s.length > 40) return null;
  // "40d42m46s": a trailing S after degree/minute letters is seconds, not South
  s = s.replace(/(D\s*\d+(?:\.\d+)?\s*M\s*\d+(?:\.\d+)?)\s*S(?=\s*[NSEW]?\s*$)/, '$1"');

  let axis: Axis | undefined;
  let sign = 1;
  const hemis = s.match(/[NSEW]/g);
  if (hemis) {
    if (hemis.length > 1) return null;
    const h = hemis[0];
    // Hemisphere letter must be at the start or the end
    if (!(s.startsWith(h) || s.endsWith(h))) return null;
    axis = h === "N" || h === "S" ? "lat" : "lng";
    if (h === "S" || h === "W") sign = -1;
    s = s.replace(HEMI_RE, "").trim();
  }
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  // Normalise unit markers to spaces
  const parts = s
    .replace(/[°º˚d:'′’m"″”s]/gi, " ")
    .replace(/,(?=\d)/g, ".")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  const nums = parts.map((p) => (NUMBER_RE.test(p) ? Number(p) : NaN));
  if (nums.some((x) => !Number.isFinite(x) || x < 0)) return null;
  const [deg, min = 0, sec = 0] = nums;
  if (parts.length > 1 && (min >= 60 || sec >= 60)) return null;
  // Only accept unit-less multi-part values when hemisphere or markers make intent clear
  if (parts.length > 1 && !axis && !/[°º˚'′"″:dms]/i.test(value as string)) return null;
  return { value: sign * (deg + min / 60 + sec / 3600), axis };
}

export function parseCoordinate(value: unknown): number | null {
  return parseCoordinateDetailed(value)?.value ?? null;
}

/** A raw two-number reading where the axis order is not yet known. */
export interface RawPair {
  a: number;
  b: number;
  /** Order implied by the source format, if any. */
  order?: "latlng" | "lnglat";
  srid?: number;
}

function pairFromCoordinates(c1: Coordinate, c2: Coordinate): RawPair | null {
  if (c1.axis && c2.axis && c1.axis === c2.axis) return null;
  if (c1.axis === "lng" || c2.axis === "lat") return { a: c1.value, b: c2.value, order: "lnglat" };
  if (c1.axis === "lat" || c2.axis === "lng") return { a: c1.value, b: c2.value, order: "latlng" };
  return { a: c1.value, b: c2.value };
}

/**
 * Parse a "lat, lng" style string: `40.7128, -74.0060`, `(40.7, -74.0)`,
 * `40.7128 -74.0060`, `40.7;-74.0`, `40°42'46"N 74°00'21"W`.
 */
export function parsePairString(input: string): RawPair | null {
  let s = input.trim();
  if (s.length < 3 || s.length > 80) return null;
  s = s.replace(/^[([{]\s*/, "").replace(/\s*[)\]}]$/, "");

  const attempt = (p1: string, p2: string): RawPair | null => {
    const c1 = parseCoordinateDetailed(p1);
    const c2 = parseCoordinateDetailed(p2);
    return c1 && c2 ? pairFromCoordinates(c1, c2) : null;
  };

  // 1. Explicit separators
  for (const sep of [";", ",", "|", "/"]) {
    const parts = s.split(sep);
    if (parts.length === 2) {
      const r = attempt(parts[0], parts[1]);
      if (r) return r;
    }
  }
  // 2. Split after a N/S hemisphere suffix, or before a E/W prefix
  const afterHemi = /^(.*?[NS])\s+(.*)$/i.exec(s);
  if (afterHemi) {
    const r = attempt(afterHemi[1], afterHemi[2]);
    if (r) return r;
  }
  const beforeHemi = /^(.*?)\s+([EW].*)$/i.exec(s);
  if (beforeHemi) {
    const r = attempt(beforeHemi[1], beforeHemi[2]);
    if (r) return r;
  }
  // 3. Two whitespace-separated numbers
  const ws = s.split(/\s+/);
  if (ws.length === 2) return attempt(ws[0], ws[1]);
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const LAT_KEYS = ["lat", "latitude", "Lat", "Latitude", "LAT", "LATITUDE"];
const LNG_KEYS = ["lng", "lon", "long", "longitude", "Lng", "Lon", "Long", "Longitude", "LNG", "LON", "LONGITUDE"];

function pickKey(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    if (k in o) {
      const n = parseNumber(o[k]);
      if (n !== null) return n;
    }
  }
  return null;
}

const GEOJSON_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

function isPosition(v: unknown): v is Position {
  return Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number";
}

function geoJsonFromObject(o: Record<string, unknown>): Geometry | null {
  if (o.type === "Feature" && isObject(o.geometry)) return geoJsonFromObject(o.geometry);
  if (typeof o.type === "string" && GEOJSON_TYPES.has(o.type)) {
    if (o.type === "GeometryCollection") {
      return Array.isArray(o.geometries) ? (o as unknown as Geometry) : null;
    }
    if (!Array.isArray(o.coordinates)) return null;
    if (o.type === "Point" && !isPosition(o.coordinates)) return null;
    return o as unknown as Geometry;
  }
  return null;
}

/** Everything a single "location" cell can hold, normalised. */
export type LocationValue =
  | { kind: "pair"; pair: RawPair }
  | { kind: "geometry"; geometry: Geometry; srid?: number };

/** Parse a value that might be a JS object / array (Mongo docs, MySQL points, pg points). */
function parseStructured(value: unknown): LocationValue | null {
  if (Array.isArray(value)) {
    // Legacy coordinate pairs, GeoJSON order
    if (value.length === 2) {
      const a = parseNumber(value[0]);
      const b = parseNumber(value[1]);
      if (a !== null && b !== null) return { kind: "pair", pair: { a, b, order: "lnglat" } };
    }
    return null;
  }
  if (!isObject(value)) return null;

  // Node Buffer serialised to JSON
  if (value.type === "Buffer" && Array.isArray(value.data)) {
    const parsed = parseWkb(Uint8Array.from(value.data as number[]));
    return parsed ? { kind: "geometry", ...parsed } : null;
  }

  const gj = geoJsonFromObject(value);
  if (gj) return { kind: "geometry", geometry: gj };

  // MongoDB { location: { type: 'Point', ... } } wrappers are handled by the column picker;
  // here we accept {lat, lng}, {latitude, longitude}, {x, y}
  const lat = pickKey(value, LAT_KEYS);
  const lng = pickKey(value, LNG_KEYS);
  if (lat !== null && lng !== null) return { kind: "pair", pair: { a: lat, b: lng, order: "latlng" } };

  if ("x" in value && "y" in value) {
    const x = parseNumber(value.x);
    const y = parseNumber(value.y);
    if (x !== null && y !== null) return { kind: "pair", pair: { a: x, b: y, order: "lnglat" } };
  }
  return null;
}

export interface ParseLocationOptions {
  /** Treat short alphanumeric strings as geohashes. */
  geohash?: boolean;
}

/** Parse anything that might describe a location in a single cell. */
export function parseLocationValue(value: unknown, opts: ParseLocationOptions = {}): LocationValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return parseStructured(value);

  const s = value.trim();
  if (!s) return null;

  if (looksLikeWkt(s)) {
    const parsed = parseWkt(s);
    return parsed ? { kind: "geometry", ...parsed } : null;
  }

  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const obj = JSON.parse(s);
      const r = parseStructured(obj);
      if (r) return r;
    } catch {
      // not JSON, maybe "[40.7, -74.0]" style is still parseable as a pair below
    }
  }

  // Postgres native point type renders as "(x,y)"
  const pgPoint = /^\(\s*([-+.\deE]+)\s*,\s*([-+.\deE]+)\s*\)$/.exec(s);
  if (pgPoint) {
    const a = Number(pgPoint[1]);
    const b = Number(pgPoint[2]);
    if (Number.isFinite(a) && Number.isFinite(b)) return { kind: "pair", pair: { a, b } };
  }

  if (/^(\\x|0x)?[0-9a-fA-F]+$/.test(s) && s.length >= 18) {
    const parsed = parseWkbHex(s);
    if (parsed) return { kind: "geometry", ...parsed };
  }

  if (opts.geohash) {
    const box = decodeGeohash(s);
    if (box) {
      return { kind: "pair", pair: { a: box.lat, b: box.lng, order: "latlng" } };
    }
  }

  const pair = parsePairString(s);
  if (pair) return { kind: "pair", pair };
  return null;
}

/** Decide the order of a set of raw pairs from the values themselves. */
export function inferPairOrder(pairs: RawPair[], fallback: "latlng" | "lnglat" = "latlng"): "latlng" | "lnglat" {
  let aIsLng = 0;
  let bIsLng = 0;
  for (const p of pairs) {
    if (p.order) {
      if (p.order === "lnglat") aIsLng += 2;
      else bIsLng += 2;
      continue;
    }
    if (Math.abs(p.a) > 90 && Math.abs(p.a) <= 180) aIsLng++;
    if (Math.abs(p.b) > 90 && Math.abs(p.b) <= 180) bIsLng++;
  }
  if (aIsLng > bIsLng) return "lnglat";
  if (bIsLng > aIsLng) return "latlng";
  return fallback;
}

export function pairToLatLng(p: RawPair, order: "latlng" | "lnglat"): { lat: number; lng: number } {
  return order === "latlng" ? { lat: p.a, lng: p.b } : { lat: p.b, lng: p.a };
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 540;
}

/** Map every position of a geometry. */
export function mapGeometry(g: Geometry, fn: (p: Position) => Position): Geometry {
  switch (g.type) {
    case "Point":
      return { type: "Point", coordinates: fn(g.coordinates) };
    case "MultiPoint":
    case "LineString":
      return { type: g.type, coordinates: g.coordinates.map(fn) } as Geometry;
    case "MultiLineString":
    case "Polygon":
      return { type: g.type, coordinates: g.coordinates.map((r) => r.map(fn)) } as Geometry;
    case "MultiPolygon":
      return { type: "MultiPolygon", coordinates: g.coordinates.map((p) => p.map((r) => r.map(fn))) };
    case "GeometryCollection":
      return { type: "GeometryCollection", geometries: g.geometries.map((c) => mapGeometry(c, fn)) };
  }
}

export function forEachPosition(g: Geometry, fn: (p: Position) => void): void {
  mapGeometry(g, (p) => {
    fn(p);
    return p;
  });
}

/** A representative point for a geometry (bbox centre for shapes, the point itself for points). */
export function representativePoint(g: Geometry): { lat: number; lng: number } | null {
  if (g.type === "Point") return { lng: g.coordinates[0], lat: g.coordinates[1] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  forEachPosition(g, ([x, y]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  });
  if (!Number.isFinite(minX)) return null;
  return { lng: (minX + maxX) / 2, lat: (minY + maxY) / 2 };
}
