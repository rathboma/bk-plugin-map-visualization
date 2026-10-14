import { lookupCountry, lookupState, normalizeName } from "./regions";

export interface CityRecord {
  name: string;
  cc: string;
  admin1: string;
  lat: number;
  lng: number;
}

export interface CityIndex {
  byName: Map<string, CityRecord[]>;
  /** "US.TX" -> "texas", plus reverse lookup by normalised admin-1 name */
  admin1ByName: Map<string, string[]>;
}

/** Common short forms that GeoNames spells out. */
const CITY_ALIASES: Record<string, string> = {
  "new york": "new york city",
  nyc: "new york city",
  "washington dc": "washington",
  "la": "los angeles",
  "sf": "san francisco",
  "st petersburg": "saint petersburg",
  "saint louis": "st louis",
  "ho chi minh": "ho chi minh city",
  "saigon": "ho chi minh city",
  "bombay": "mumbai",
  "calcutta": "kolkata",
  "madras": "chennai",
  "peking": "beijing",
  "kiev": "kyiv",
  "the hague": "den haag",
};

export function buildCityIndex(citiesTsv: string, admin1Tsv: string): CityIndex {
  const byName = new Map<string, CityRecord[]>();
  const push = (key: string, rec: CityRecord) => {
    const k = normalizeName(key);
    if (!k) return;
    const list = byName.get(k);
    if (list) {
      if (!list.includes(rec)) list.push(rec);
    } else byName.set(k, [rec]);
  };
  // Rows are sorted by population (descending) so the first candidate is the most likely
  for (const line of citiesTsv.split("\n")) {
    if (!line) continue;
    const [name, ascii, cc, admin1, lat, lng] = line.split("\t");
    const rec: CityRecord = { name, cc, admin1, lat: Number(lat), lng: Number(lng) };
    push(name, rec);
    if (ascii) push(ascii, rec);
    // "Saint Paul" <-> "St. Paul", "Fort Worth" <-> "Ft. Worth"
    const n = normalizeName(name);
    if (n.startsWith("saint ")) push("st " + n.slice(6), rec);
    if (n.startsWith("st ")) push("saint " + n.slice(3), rec);
    if (n.startsWith("fort ")) push("ft " + n.slice(5), rec);
    if (n.startsWith("mount ")) push("mt " + n.slice(6), rec);
  }
  const admin1ByName = new Map<string, string[]>();
  for (const line of admin1Tsv.split("\n")) {
    if (!line) continue;
    const [code, name] = line.split("\t");
    const k = normalizeName(name);
    const list = admin1ByName.get(k);
    if (list) list.push(code);
    else admin1ByName.set(k, [code]);
  }
  return { byName, admin1ByName };
}

let cityIndexPromise: Promise<CityIndex> | null = null;

export function loadCityIndex(): Promise<CityIndex> {
  cityIndexPromise ??= Promise.all([
    import("../../data/cities.tsv?raw").then((m) => m.default),
    import("../../data/admin1.tsv?raw").then((m) => m.default),
  ]).then(([cities, admin1]) => buildCityIndex(cities, admin1));
  return cityIndexPromise;
}

interface Qualifiers {
  cc?: string;
  /** Admin-1 codes in GeoNames form, e.g. "US.TX" */
  admin1?: string[];
}

function qualifierFrom(part: string, idx: CityIndex): Qualifiers | null {
  const trimmed = part.trim();
  if (!trimmed) return null;
  // US state abbreviations/names are the most common qualifier ("Austin, TX")
  const state = lookupState(trimmed);
  if (state && (trimmed.length === 2 || normalizeName(trimmed) === normalizeName(state.name))) {
    return { cc: "US", admin1: [`US.${state.abbr}`] };
  }
  const country = lookupCountry(trimmed);
  if (country) return { cc: country.a2 };
  const admin = idx.admin1ByName.get(normalizeName(trimmed));
  if (admin) return { admin1: admin };
  return null;
}

function matches(rec: CityRecord, q: Qualifiers): boolean {
  if (q.cc && rec.cc !== q.cc) return false;
  if (q.admin1 && !q.admin1.includes(`${rec.cc}.${rec.admin1}`)) return false;
  return true;
}

export interface GeocodeHints {
  country?: unknown;
  region?: unknown;
  defaultCountry?: string;
}

/**
 * Resolve "Paris", "Paris, France", "Austin, TX", "Springfield, Illinois, USA"
 * to the most populous matching city. Optional hint columns narrow the search.
 */
export function geocodeCity(value: unknown, idx: CityIndex, hints: GeocodeHints = {}): CityRecord | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const cityName = normalizeName(parts[0]);
  if (!cityName) return null;

  const quals: Qualifiers[] = [];
  for (const p of parts.slice(1)) {
    const q = qualifierFrom(p, idx);
    if (q) quals.push(q);
  }
  if (typeof hints.region === "string" && hints.region.trim()) {
    const q = qualifierFrom(hints.region, idx);
    if (q) quals.push(q);
  }
  const countryHint = typeof hints.country === "string" && hints.country.trim() ? hints.country : hints.defaultCountry;
  if (countryHint) {
    const c = lookupCountry(countryHint);
    if (c) quals.push({ cc: c.a2 });
  }

  const candidates =
    idx.byName.get(cityName) ??
    (CITY_ALIASES[cityName] ? idx.byName.get(CITY_ALIASES[cityName]) : undefined) ??
    idx.byName.get(cityName.replace(/ city$/, ""));
  if (!candidates || candidates.length === 0) return null;

  const filtered = candidates.filter((rec) => quals.every((q) => matches(rec, q)));
  if (filtered.length > 0) return filtered[0];
  // Qualifiers that only matched by accident (e.g. "CA" as Canada) shouldn't
  // block an obvious answer when there's just one way to read the first part.
  return quals.length === 0 ? candidates[0] : null;
}

// ---------------------------------------------------------------------------
// US ZIP codes

export interface ZipIndex {
  get(zip: string): [number, number] | undefined;
  /** Centre of all ZIPs sharing the first three digits (PO boxes, retired ZIPs) */
  area(zip: string): [number, number] | undefined;
}

let zipPromise: Promise<ZipIndex> | null = null;

export function parseZipIndex(tsv: string): ZipIndex {
  const exact = new Map<string, [number, number]>();
  const sums = new Map<string, [number, number, number]>();
  for (const line of tsv.split("\n")) {
    if (!line) continue;
    const [zip, lat, lng] = line.split("\t");
    const p: [number, number] = [Number(lat), Number(lng)];
    exact.set(zip, p);
    const s = sums.get(zip.slice(0, 3));
    if (s) {
      s[0] += p[0];
      s[1] += p[1];
      s[2]++;
    } else sums.set(zip.slice(0, 3), [p[0], p[1], 1]);
  }
  const areas = new Map([...sums].map(([k, [la, ln, n]]) => [k, [la / n, ln / n] as [number, number]]));
  return {
    get: (zip) => exact.get(zip),
    // Repeated digits (00000, 99999) are placeholders, not real ZIPs
    area: (zip) => (/^(\d)\1{4}$/.test(zip) ? undefined : areas.get(zip.slice(0, 3))),
  };
}

export function loadZipIndex(): Promise<ZipIndex> {
  zipPromise ??= import("../../data/us-zips.tsv?raw").then((m) => parseZipIndex(m.default));
  return zipPromise;
}

/** "02134", "02134-1234", 2134 (leading zero lost in a numeric column) -> "02134" */
export function normalizeZip(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 100000) {
    return String(value).padStart(5, "0");
  }
  if (typeof value !== "string") return null;
  const m = /^\s*(\d{3,5})(?:[-\s]\d{4})?\s*$/.exec(value);
  return m ? m[1].padStart(5, "0") : null;
}
