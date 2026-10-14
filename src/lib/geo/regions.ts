import type { Feature, Geometry, Position } from "geojson";
import countriesData from "../../data/countries.json";
import statesData from "../../data/us-states.json";

export interface Country {
  a2: string;
  a3: string;
  num: string;
  name: string;
  lat: number;
  lng: number;
  aliases: string[];
}

export interface UsState {
  abbr: string;
  fips: string;
  name: string;
  lat: number;
  lng: number;
}

export const COUNTRIES = countriesData as Country[];
export const US_STATES = statesData as UsState[];

/** Lowercase, strip accents and punctuation: "Côte d'Ivoire" -> "cote divoire". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

let countryIndex: Map<string, Country> | null = null;
let stateIndex: Map<string, UsState> | null = null;

function buildCountryIndex() {
  const idx = new Map<string, Country>();
  const add = (key: string, c: Country) => {
    const k = normalizeName(key);
    if (k && !idx.has(k)) idx.set(k, c);
  };
  // Codes first so "IN" (India) wins over any alias spelled "in"
  for (const c of COUNTRIES) {
    add(c.a2, c);
    add(c.a3, c);
  }
  for (const c of COUNTRIES) add(c.name, c);
  for (const c of COUNTRIES) c.aliases.forEach((a) => add(a, c));
  for (const c of COUNTRIES) {
    if (c.num !== "000") {
      idx.set(`#${Number(c.num)}`, c);
    }
  }
  return idx;
}

function buildStateIndex() {
  const idx = new Map<string, UsState>();
  for (const s of US_STATES) {
    idx.set(normalizeName(s.abbr), s);
    idx.set(normalizeName(s.name), s);
    idx.set(`#${Number(s.fips)}`, s);
  }
  idx.set("washington dc", US_STATES.find((s) => s.abbr === "DC")!);
  idx.set("dc", US_STATES.find((s) => s.abbr === "DC")!);
  idx.set("washington d c", US_STATES.find((s) => s.abbr === "DC")!);
  return idx;
}

function keyFor(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return `#${value}`;
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.length > 80) return null;
  if (/^\d{1,3}$/.test(s)) return `#${Number(s)}`;
  return normalizeName(s);
}

let compactCountryIndex: Map<string, Country> | null = null;

export function lookupCountry(value: unknown): Country | null {
  countryIndex ??= buildCountryIndex();
  const k = keyFor(value);
  if (!k) return null;
  const hit = countryIndex.get(k);
  if (hit) return hit;
  // "cote d ivoire" vs "cote divoire": compare without spaces as a fallback
  if (k.length > 3) {
    compactCountryIndex ??= new Map(
      [...countryIndex.entries()].filter(([key]) => key.length > 3).map(([key, c]) => [key.replace(/ /g, ""), c])
    );
    return compactCountryIndex.get(k.replace(/ /g, "")) ?? null;
  }
  return null;
}

export function lookupState(value: unknown): UsState | null {
  stateIndex ??= buildStateIndex();
  const k = keyFor(value);
  if (!k) return null;
  const direct = stateIndex.get(k);
  if (direct) return direct;
  // "Texas, USA" / "TX US"
  const stripped = k.replace(/\b(usa|us|united states)$/, "").trim();
  return stripped !== k ? stateIndex.get(stripped) ?? null : null;
}

// ---------------------------------------------------------------------------
// Shapes (lazy-loaded so the topojson is only parsed when filled regions are used)

export interface RegionShape {
  key: string;
  name: string;
  feature: Feature<Geometry>;
}

/**
 * world-atlas / us-atlas polygons are "stitched" across the antimeridian for
 * spherical projections. Leaflet draws in plain lng/lat, so make every ring's
 * longitudes continuous and close polar rings (Antarctica) through the pole.
 */
export function unwrapRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const out: Position[] = [[ring[0][0], ring[0][1]]];
  let offset = 0;
  for (let i = 1; i < ring.length; i++) {
    const delta = ring[i][0] - ring[i - 1][0];
    if (delta > 180) offset -= 360;
    else if (delta < -180) offset += 360;
    out.push([ring[i][0] + offset, ring[i][1]]);
  }
  const span = out[out.length - 1][0] - out[0][0];
  if (Math.abs(span) >= 359) {
    const poleLat = out.reduce((s, p) => s + p[1], 0) / out.length < 0 ? -90 : 90;
    const last = out[out.length - 1];
    out.push([last[0], poleLat], [out[0][0], poleLat], [out[0][0], out[0][1]]);
  }
  return out;
}

function unwrapGeometry(g: Geometry): Geometry {
  if (g.type === "Polygon") return { type: "Polygon", coordinates: g.coordinates.map(unwrapRing) };
  if (g.type === "MultiPolygon") {
    return { type: "MultiPolygon", coordinates: g.coordinates.map((p) => p.map(unwrapRing)) };
  }
  return g;
}

let countryShapes: Promise<Map<string, RegionShape>> | null = null;
let stateShapes: Promise<Map<string, RegionShape>> | null = null;
let worldOutline: Promise<Feature<Geometry>[]> | null = null;

/** Country polygons keyed by ISO alpha-2. */
export function loadCountryShapes(): Promise<Map<string, RegionShape>> {
  countryShapes ??= (async () => {
    const [{ feature }, topo] = await Promise.all([
      import("topojson-client"),
      import("world-atlas/countries-50m.json").then((m) => m.default),
    ]);
    const fc = feature(topo as never, (topo as never as { objects: { countries: never } }).objects.countries) as unknown as {
      features: Feature<Geometry, { name: string }>[];
    };
    const byNum = new Map(COUNTRIES.map((c) => [c.num, c]));
    const out = new Map<string, RegionShape>();
    for (const f of fc.features) {
      const country = (f.id && byNum.get(String(f.id))) || lookupCountry(f.properties?.name);
      if (!country || out.has(country.a2)) continue;
      out.set(country.a2, {
        key: country.a2,
        name: country.name,
        feature: { ...f, geometry: unwrapGeometry(f.geometry) },
      });
    }
    return out;
  })();
  return countryShapes;
}

/** US state polygons keyed by postal abbreviation. */
export function loadStateShapes(): Promise<Map<string, RegionShape>> {
  stateShapes ??= (async () => {
    const [{ feature }, topo] = await Promise.all([
      import("topojson-client"),
      import("us-atlas/states-10m.json").then((m) => m.default),
    ]);
    const fc = feature(topo as never, (topo as never as { objects: { states: never } }).objects.states) as unknown as {
      features: Feature<Geometry, { name: string }>[];
    };
    const byFips = new Map(US_STATES.map((s) => [s.fips, s]));
    const out = new Map<string, RegionShape>();
    for (const f of fc.features) {
      const st = byFips.get(String(f.id));
      if (!st) continue;
      out.set(st.abbr, { key: st.abbr, name: st.name, feature: { ...f, geometry: unwrapGeometry(f.geometry) } });
    }
    return out;
  })();
  return stateShapes;
}

/** Low-resolution country outlines used as the offline basemap. */
export function loadWorldOutline(): Promise<Feature<Geometry>[]> {
  worldOutline ??= (async () => {
    const [{ feature }, topo] = await Promise.all([
      import("topojson-client"),
      import("world-atlas/countries-110m.json").then((m) => m.default),
    ]);
    const fc = feature(topo as never, (topo as never as { objects: { countries: never } }).objects.countries) as unknown as {
      features: Feature<Geometry>[];
    };
    return fc.features.map((f) => ({ ...f, geometry: unwrapGeometry(f.geometry) }));
  })();
  return worldOutline;
}
