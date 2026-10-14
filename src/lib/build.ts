import type { Geometry, Position } from "geojson";
import type { Dataset } from "./dataset";
import { columnIndex } from "./dataset";
import type { LocationConfig } from "./config";
import {
  inferPairOrder,
  isMercatorRange,
  mapGeometry,
  forEachPosition,
  mercatorToLngLat,
  MERCATOR_SRIDS,
  WGS84_SRIDS,
  pairToLatLng,
  parseCoordinate,
  parseLocationValue,
  representativePoint,
  type RawPair,
} from "./geo/parse";
import { lookupCountry, lookupState } from "./geo/regions";
import { geocodeCity, loadCityIndex, loadZipIndex, normalizeZip } from "./geo/geocode";

export interface PlotItem {
  /** Index into dataset.rows */
  row: number;
  lat: number;
  lng: number;
  /** Lines / polygons from a geometry column (WGS84) */
  geometry?: Geometry;
  /** ISO alpha-2 or US postal code for region modes */
  regionKey?: string;
  dest?: { lat: number; lng: number };
}

export interface BuildResult {
  items: PlotItem[];
  skipped: number[];
  warnings: string[];
}

const inDegrees = (lat: number, lng: number) => Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Pick the lat/lng (or y/x) interpretation for two numeric columns. */
function resolveNumericPairs(
  raw: { row: number; a: number; b: number }[],
  crs: LocationConfig["crs"],
  warnings: string[]
): { row: number; lat: number; lng: number }[] {
  // a = "latitude" column, b = "longitude" column
  let mercator = crs === "mercator";
  if (crs === "auto") {
    const outOfRange = raw.filter((p) => !inDegrees(p.a, p.b)).length;
    const mercOk = raw.filter((p) => isMercatorRange(p.b, p.a)).length;
    if (outOfRange > raw.length * 0.5 && mercOk > raw.length * 0.9) {
      mercator = true;
      warnings.push("Coordinates look like Web Mercator meters (EPSG:3857) and were converted to degrees.");
    }
  }
  if (mercator) {
    return raw.map((p) => {
      const [lng, lat] = mercatorToLngLat(p.b, p.a);
      return { row: p.row, lat, lng };
    });
  }
  // Swapped columns: "latitude" values beyond ±90 while "longitude" values fit
  const latBad = raw.filter((p) => Math.abs(p.a) > 90 && Math.abs(p.a) <= 180).length;
  const lngBad = raw.filter((p) => Math.abs(p.b) > 90).length;
  if (latBad > raw.length * 0.2 && lngBad === 0) {
    warnings.push("Latitude and longitude looked swapped, so they were flipped. Change the columns under Location if this is wrong.");
    return raw.map((p) => ({ row: p.row, lat: p.b, lng: p.a }));
  }
  return raw.map((p) => ({ row: p.row, lat: p.a, lng: p.b }));
}

function geometryBounds(g: Geometry) {
  let maxAbsX = 0, maxAbsY = 0;
  forEachPosition(g, ([x, y]) => {
    maxAbsX = Math.max(maxAbsX, Math.abs(x));
    maxAbsY = Math.max(maxAbsY, Math.abs(y));
  });
  return { maxAbsX, maxAbsY };
}

export async function buildItems(ds: Dataset, loc: LocationConfig): Promise<BuildResult> {
  const warnings: string[] = [];
  const skipped: number[] = [];
  const items: PlotItem[] = [];

  switch (loc.mode) {
    case "latlng": {
      const li = columnIndex(ds, loc.latColumn);
      const gi = columnIndex(ds, loc.lngColumn);
      if (li < 0 || gi < 0) return { items, skipped: ds.rows.map((_, i) => i), warnings: ["Choose latitude and longitude columns."] };
      const raw: { row: number; a: number; b: number }[] = [];
      ds.rows.forEach((r, row) => {
        const a = parseCoordinate(r[li]);
        const b = parseCoordinate(r[gi]);
        if (a === null || b === null) skipped.push(row);
        else raw.push({ row, a, b });
      });
      const resolved = resolveNumericPairs(raw, loc.crs, warnings);
      const di = columnIndex(ds, loc.destLatColumn);
      const dgi = columnIndex(ds, loc.destLngColumn);
      for (const p of resolved) {
        if (!inDegrees(p.lat, p.lng)) {
          skipped.push(p.row);
          continue;
        }
        const item: PlotItem = { row: p.row, lat: p.lat, lng: p.lng };
        if (di >= 0 && dgi >= 0) {
          const r = ds.rows[p.row];
          const dlat = parseCoordinate(r[di]);
          const dlng = parseCoordinate(r[dgi]);
          if (dlat !== null && dlng !== null && inDegrees(dlat, dlng)) item.dest = { lat: dlat, lng: dlng };
        }
        items.push(item);
      }
      break;
    }

    case "geometry": {
      const ci = columnIndex(ds, loc.column);
      if (ci < 0) return { items, skipped: ds.rows.map((_, i) => i), warnings: ["Choose a location column."] };
      const pairs: { row: number; pair: RawPair }[] = [];
      const geoms: { row: number; geometry: Geometry; srid?: number }[] = [];
      ds.rows.forEach((r, row) => {
        const v = parseLocationValue(r[ci], { geohash: loc.geohash });
        if (!v) skipped.push(row);
        else if (v.kind === "pair") pairs.push({ row, pair: v.pair });
        else geoms.push({ row, geometry: v.geometry, srid: v.srid });
      });

      const order = loc.pairOrder === "auto" ? inferPairOrder(pairs.map((p) => p.pair)) : loc.pairOrder;
      for (const { row, pair } of pairs) {
        let { lat, lng } = pairToLatLng(pair, order);
        if (loc.crs === "mercator" || (loc.crs === "auto" && !inDegrees(lat, lng) && isMercatorRange(pair.a, pair.b))) {
          const [x, y] = pair.order === "latlng" ? [pair.b, pair.a] : [pair.a, pair.b];
          [lng, lat] = mercatorToLngLat(x, y);
        }
        if (inDegrees(lat, lng)) items.push({ row, lat, lng });
        else skipped.push(row);
      }

      const unsupported = new Set<number>();
      let flippedAxes = false;
      // MySQL 8 returns SRID 4326 points in lat/lng order; detect from values
      const allPointsYOut = geoms.length > 0 && geoms.every((g) => {
        const b = geometryBounds(g.geometry);
        return b.maxAbsX <= 90;
      }) && geoms.some((g) => geometryBounds(g.geometry).maxAbsY > 90);
      for (const g of geoms) {
        let geometry = g.geometry;
        const b = geometryBounds(geometry);
        const mercator =
          loc.crs === "mercator" ||
          (g.srid !== undefined && MERCATOR_SRIDS.has(g.srid)) ||
          (loc.crs === "auto" && g.srid === undefined && (b.maxAbsX > 180 || b.maxAbsY > 90) && isMercatorRange(b.maxAbsX, b.maxAbsY));
        if (mercator) {
          geometry = mapGeometry(geometry, ([x, y]) => mercatorToLngLat(x, y));
        } else if (g.srid !== undefined && !WGS84_SRIDS.has(g.srid) && (b.maxAbsX > 180 || b.maxAbsY > 90)) {
          unsupported.add(g.srid);
          skipped.push(g.row);
          continue;
        } else if (loc.pairOrder === "latlng" || (loc.pairOrder === "auto" && allPointsYOut)) {
          geometry = mapGeometry(geometry, ([x, y]): Position => [y, x]);
          flippedAxes = true;
        }
        const p = representativePoint(geometry);
        const nb = geometryBounds(geometry);
        if (!p || nb.maxAbsY > 90 || nb.maxAbsX > 540) {
          skipped.push(g.row);
          continue;
        }
        items.push({ row: g.row, lat: p.lat, lng: p.lng, geometry: geometry.type === "Point" ? undefined : geometry });
      }
      if (unsupported.size > 0) {
        warnings.push(
          `Projected coordinates (SRID ${[...unsupported].join(", ")}) can't be drawn directly. Convert them in SQL, e.g. ST_Transform(geom, 4326).`
        );
      }
      if (flippedAxes && loc.pairOrder === "auto") warnings.push("Geometry axes looked swapped (lat, lng), so they were flipped.");
      break;
    }

    case "country":
    case "us-state": {
      const ci = columnIndex(ds, loc.column);
      if (ci < 0) return { items, skipped: ds.rows.map((_, i) => i), warnings: ["Choose a region column."] };
      ds.rows.forEach((r, row) => {
        if (loc.mode === "country") {
          const c = lookupCountry(r[ci]);
          if (c) items.push({ row, lat: c.lat, lng: c.lng, regionKey: c.a2 });
          else skipped.push(row);
        } else {
          const s = lookupState(r[ci]);
          if (s) items.push({ row, lat: s.lat, lng: s.lng, regionKey: s.abbr });
          else skipped.push(row);
        }
      });
      break;
    }

    case "city": {
      const ci = columnIndex(ds, loc.column);
      if (ci < 0) return { items, skipped: ds.rows.map((_, i) => i), warnings: ["Choose a city column."] };
      const cc = columnIndex(ds, loc.countryColumn);
      const rc = columnIndex(ds, loc.regionColumn);
      const index = await loadCityIndex();
      const cache = new Map<string, { lat: number; lng: number } | null>();
      ds.rows.forEach((r, row) => {
        const value = r[ci];
        const country = cc >= 0 ? r[cc] : undefined;
        const region = rc >= 0 ? r[rc] : undefined;
        const key = `${String(value)}\u0000${String(country ?? "")}\u0000${String(region ?? "")}`;
        let hit = cache.get(key);
        if (hit === undefined) {
          const rec = geocodeCity(value, index, { country, region, defaultCountry: loc.defaultCountry });
          hit = rec ? { lat: rec.lat, lng: rec.lng } : null;
          cache.set(key, hit);
        }
        if (hit) items.push({ row, lat: hit.lat, lng: hit.lng });
        else skipped.push(row);
      });
      break;
    }

    case "zip": {
      const ci = columnIndex(ds, loc.column);
      if (ci < 0) return { items, skipped: ds.rows.map((_, i) => i), warnings: ["Choose a ZIP code column."] };
      const index = await loadZipIndex();
      let approximate = 0;
      ds.rows.forEach((r, row) => {
        const zip = normalizeZip(r[ci]);
        let hit = zip ? index.get(zip) : undefined;
        if (!hit && zip) {
          hit = index.area(zip);
          if (hit) approximate++;
        }
        if (hit) items.push({ row, lat: hit[0], lng: hit[1] });
        else skipped.push(row);
      });
      if (approximate > 0) {
        warnings.push(
          `${approximate.toLocaleString()} ZIP code${approximate === 1 ? " has" : "s have"} no exact centroid (PO boxes, retired codes) and ${approximate === 1 ? "is" : "are"} placed at the center of the 3-digit ZIP area.`
        );
      }
      break;
    }
  }

  skipped.sort((a, b) => a - b);
  return { items, skipped, warnings };
}
