import { describe, expect, it } from "vitest";
import { parseWkbHex, parseWkb } from "../src/lib/geo/wkb";
import { parseWkt } from "../src/lib/geo/wkt";
import { decodeGeohash, isGeohash } from "../src/lib/geo/geohash";
import {
  inferPairOrder,
  mercatorToLngLat,
  parseCoordinate,
  parseLocationValue,
  parseNumber,
  parsePairString,
  representativePoint,
} from "../src/lib/geo/parse";

/** Build little-endian WKB for tests. */
function wkb(type: number, coords: number[], opts: { srid?: number; count?: number; big?: boolean } = {}) {
  const hasSrid = opts.srid !== undefined;
  const size = 1 + 4 + (hasSrid ? 4 : 0) + (opts.count !== undefined ? 4 : 0) + coords.length * 8;
  const buf = new DataView(new ArrayBuffer(size));
  const le = !opts.big;
  let o = 0;
  buf.setUint8(o, le ? 1 : 0);
  o += 1;
  buf.setUint32(o, type | (hasSrid ? 0x20000000 : 0), le);
  o += 4;
  if (hasSrid) {
    buf.setUint32(o, opts.srid!, le);
    o += 4;
  }
  if (opts.count !== undefined) {
    buf.setUint32(o, opts.count, le);
    o += 4;
  }
  for (const c of coords) {
    buf.setFloat64(o, c, le);
    o += 8;
  }
  return Array.from(new Uint8Array(buf.buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("WKB", () => {
  it("parses the PostGIS docs example", () => {
    expect(parseWkbHex("0101000000000000000000F03F0000000000000040")?.geometry).toEqual({
      type: "Point",
      coordinates: [1, 2],
    });
  });

  it("parses EWKB with an SRID (what PostGIS returns for geometry columns)", () => {
    const parsed = parseWkbHex("0101000020E6100000000000000000F03F0000000000000040");
    expect(parsed).toEqual({ geometry: { type: "Point", coordinates: [1, 2] }, srid: 4326 });
  });

  it("parses big-endian and bytea-style hex", () => {
    const hex = wkb(1, [-74.006, 40.7128], { big: true });
    expect(parseWkbHex(hex)?.geometry).toEqual({ type: "Point", coordinates: [-74.006, 40.7128] });
    expect(parseWkbHex("\\x" + wkb(1, [3, 4]))?.geometry).toEqual({ type: "Point", coordinates: [3, 4] });
    expect(parseWkbHex("0x" + wkb(1, [3, 4]))?.geometry).toEqual({ type: "Point", coordinates: [3, 4] });
  });

  it("parses linestrings and drops Z values", () => {
    const line = wkb(2, [0, 0, 1, 1, 2, 2], { count: 3 });
    expect(parseWkbHex(line)?.geometry).toEqual({ type: "LineString", coordinates: [[0, 0], [1, 1], [2, 2]] });
    const pointZ = wkb(1001, [5, 6, 7]);
    expect(parseWkbHex(pointZ)?.geometry).toEqual({ type: "Point", coordinates: [5, 6] });
  });

  it("parses MySQL's SRID-prefixed format", () => {
    const inner = wkb(1, [10, 20]);
    const mysql = "e6100000" + inner;
    expect(parseWkbHex(mysql)).toEqual({ geometry: { type: "Point", coordinates: [10, 20] }, srid: 4326 });
  });

  it("parses node Buffer JSON", () => {
    const bytes = wkb(1, [7, 8]).match(/../g)!.map((h) => parseInt(h, 16));
    expect(parseLocationValue({ type: "Buffer", data: bytes })).toMatchObject({
      kind: "geometry",
      geometry: { type: "Point", coordinates: [7, 8] },
    });
    expect(parseWkb(Uint8Array.from(bytes))?.geometry.type).toBe("Point");
  });

  it("rejects random hex", () => {
    expect(parseWkbHex("deadbeefdeadbeefdeadbeef")).toBeNull();
    expect(parseWkbHex("0101")).toBeNull();
  });
});

describe("WKT", () => {
  it("parses points, EWKT and Z", () => {
    expect(parseWkt("POINT(-74.006 40.7128)")?.geometry).toEqual({ type: "Point", coordinates: [-74.006, 40.7128] });
    expect(parseWkt("SRID=4326;POINT(1 2)")).toEqual({ geometry: { type: "Point", coordinates: [1, 2] }, srid: 4326 });
    expect(parseWkt("point z (1 2 3)")?.geometry).toEqual({ type: "Point", coordinates: [1, 2] });
  });

  it("parses polygons and multi geometries", () => {
    expect(parseWkt("POLYGON((0 0, 1 0, 1 1, 0 0))")?.geometry).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
    });
    expect(parseWkt("MULTIPOINT((1 2), (3 4))")?.geometry).toEqual({ type: "MultiPoint", coordinates: [[1, 2], [3, 4]] });
    expect(parseWkt("MULTIPOINT(1 2, 3 4)")?.geometry).toEqual({ type: "MultiPoint", coordinates: [[1, 2], [3, 4]] });
    expect(parseWkt("MULTIPOLYGON(((0 0,1 0,1 1,0 0)),((5 5,6 5,6 6,5 5)))")?.geometry.type).toBe("MultiPolygon");
    expect(parseWkt("GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1))")?.geometry).toEqual({
      type: "GeometryCollection",
      geometries: [
        { type: "Point", coordinates: [1, 2] },
        { type: "LineString", coordinates: [[0, 0], [1, 1]] },
      ],
    });
  });

  it("returns null for EMPTY and junk", () => {
    expect(parseWkt("POINT EMPTY")).toBeNull();
    expect(parseWkt("POINT(1)")).toBeNull();
    expect(parseWkt("hello")).toBeNull();
  });
});

describe("geohash", () => {
  it("decodes to the cell centre", () => {
    const box = decodeGeohash("dr5regw3p")!;
    expect(box.lat).toBeCloseTo(40.7128, 3);
    expect(box.lng).toBeCloseTo(-74.006, 3);
    expect(isGeohash("u4pruydqqvj")).toBe(true);
    expect(isGeohash("hello")).toBe(false);
  });
});

describe("numbers and coordinates", () => {
  it("parses numbers and numeric strings", () => {
    expect(parseNumber(12.5)).toBe(12.5);
    expect(parseNumber(" -74.006 ")).toBe(-74.006);
    expect(parseNumber("40,7128")).toBe(40.7128);
    expect(parseNumber("1,234,567.5")).toBe(1234567.5);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber(NaN)).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });

  it("parses degrees / minutes / seconds", () => {
    expect(parseCoordinate(`40°42'46"N`)).toBeCloseTo(40.7128, 3);
    expect(parseCoordinate(`74°0'21.5"W`)).toBeCloseTo(-74.006, 3);
    expect(parseCoordinate("40 42 46 N")).toBeCloseTo(40.7128, 3);
    expect(parseCoordinate("S33.8688")).toBeCloseTo(-33.8688, 4);
    expect(parseCoordinate("151.2093E")).toBeCloseTo(151.2093, 4);
    expect(parseCoordinate("-74:00:21")).toBeCloseTo(-74.0058, 3);
    expect(parseCoordinate("40d42m46s")).toBeCloseTo(40.7128, 3);
    expect(parseCoordinate("40 42 46")).toBeNull(); // ambiguous without a marker
    expect(parseCoordinate("40°75'N")).toBeNull(); // minutes out of range
  });

  it("parses lat/lng pair strings", () => {
    expect(parsePairString("40.7128, -74.0060")).toEqual({ a: 40.7128, b: -74.006 });
    expect(parsePairString("(40.7128,-74.0060)")).toEqual({ a: 40.7128, b: -74.006 });
    expect(parsePairString("40.7128 -74.0060")).toEqual({ a: 40.7128, b: -74.006 });
    expect(parsePairString(`40°42'46"N 74°0'21"W`)).toMatchObject({ order: "latlng" });
    const p = parsePairString(`40°42'46"N 74°0'21"W`)!;
    expect(p.a).toBeCloseTo(40.7128, 3);
    expect(p.b).toBeCloseTo(-74.0058, 3);
    expect(parsePairString("W74.006 N40.7128")).toMatchObject({ order: "lnglat" });
    expect(parsePairString("hello world")).toBeNull();
  });

  it("infers pair order from values", () => {
    expect(inferPairOrder([{ a: 40, b: -120 }])).toBe("latlng");
    expect(inferPairOrder([{ a: -120, b: 40 }])).toBe("lnglat");
    expect(inferPairOrder([{ a: 10, b: 20 }])).toBe("latlng");
    expect(inferPairOrder([{ a: 10, b: 20, order: "lnglat" }])).toBe("lnglat");
  });

  it("converts Web Mercator", () => {
    const [lng, lat] = mercatorToLngLat(-8238310.24, 4970071.58);
    expect(lng).toBeCloseTo(-74.006, 3);
    expect(lat).toBeCloseTo(40.7128, 3);
  });
});

describe("parseLocationValue", () => {
  it("handles GeoJSON strings and objects", () => {
    expect(parseLocationValue('{"type":"Point","coordinates":[-74.006,40.7128]}')).toEqual({
      kind: "geometry",
      geometry: { type: "Point", coordinates: [-74.006, 40.7128] },
    });
    expect(parseLocationValue({ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] } })).toMatchObject({
      kind: "geometry",
    });
  });

  it("handles objects from drivers (pg point, MySQL, Mongo)", () => {
    expect(parseLocationValue({ x: -74, y: 40 })).toEqual({ kind: "pair", pair: { a: -74, b: 40, order: "lnglat" } });
    expect(parseLocationValue({ lat: 40, lng: -74 })).toEqual({ kind: "pair", pair: { a: 40, b: -74, order: "latlng" } });
    expect(parseLocationValue({ latitude: "40", longitude: "-74" })).toMatchObject({ kind: "pair" });
    expect(parseLocationValue([-74, 40])).toEqual({ kind: "pair", pair: { a: -74, b: 40, order: "lnglat" } });
  });

  it("handles WKT, WKB and pairs", () => {
    expect(parseLocationValue("POINT(1 2)")).toMatchObject({ kind: "geometry" });
    expect(parseLocationValue("0101000020E6100000000000000000F03F0000000000000040")).toMatchObject({ kind: "geometry", srid: 4326 });
    expect(parseLocationValue("51.5074, -0.1278")).toEqual({ kind: "pair", pair: { a: 51.5074, b: -0.1278 } });
  });

  it("only decodes geohashes when asked", () => {
    expect(parseLocationValue("dr5regw3p")).toBeNull();
    expect(parseLocationValue("dr5regw3p", { geohash: true })).toMatchObject({ kind: "pair" });
  });

  it("ignores plain text and numbers", () => {
    expect(parseLocationValue("hello")).toBeNull();
    expect(parseLocationValue(42)).toBeNull();
    expect(parseLocationValue(null)).toBeNull();
  });

  it("finds a representative point for shapes", () => {
    expect(
      representativePoint({ type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] })
    ).toEqual({ lat: 5, lng: 5 });
  });
});
