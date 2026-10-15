import type { Dataset } from "./dataset";
import { parseCoordinate, parseLocationValue, parseNumber, isMercatorRange } from "./geo/parse";
import { lookupCountry, lookupState } from "./geo/regions";
import { isGeohash } from "./geo/geohash";
import { normalizeZip } from "./geo/geocode";
import { defaultConfig, type LocationConfig, type MapConfig, type StyleConfig } from "./config";

export interface ColumnProfile {
  name: string;
  index: number;
  sampled: number;
  nonNull: number;
  numeric: number;
  integer: number;
  min: number;
  max: number;
  /** Values that parse as a coordinate (number or DMS) within ±90 / ±180 */
  inLatRange: number;
  inLngRange: number;
  /** Values that parse as a single-cell location (WKT, WKB, GeoJSON, "lat,lng", objects) */
  location: number;
  country: number;
  usState: number;
  zip: number;
  geohash: number;
  distinct: number;
  textual: number;
}

const SAMPLE = 400;

function evenlySample<T>(rows: T[], n: number): T[] {
  if (rows.length <= n) return rows;
  const step = rows.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(rows[Math.floor(i * step)]);
  return out;
}

export function profileColumns(ds: Dataset): ColumnProfile[] {
  const sample = evenlySample(ds.rows, SAMPLE);
  return ds.columns.map((name, index) => {
    const p: ColumnProfile = {
      name,
      index,
      sampled: sample.length,
      nonNull: 0,
      numeric: 0,
      integer: 0,
      min: Infinity,
      max: -Infinity,
      inLatRange: 0,
      inLngRange: 0,
      location: 0,
      country: 0,
      usState: 0,
      zip: 0,
      geohash: 0,
      distinct: 0,
      textual: 0,
    };
    const distinct = new Set<string>();
    for (const row of sample) {
      const v = row[index];
      if (v === null || v === undefined || v === "") continue;
      p.nonNull++;
      if (distinct.size < 1000) distinct.add(typeof v === "object" ? JSON.stringify(v) : String(v));
      const n = parseNumber(v);
      if (n !== null) {
        p.numeric++;
        if (Number.isInteger(n)) p.integer++;
        if (n < p.min) p.min = n;
        if (n > p.max) p.max = n;
      }
      const c = n ?? parseCoordinate(v);
      if (c !== null) {
        if (Math.abs(c) <= 90) p.inLatRange++;
        if (Math.abs(c) <= 180) p.inLngRange++;
      }
      if (n === null) {
        if (typeof v === "string") p.textual++;
        if (parseLocationValue(v)) p.location++;
        if (typeof v === "string" && isGeohash(v) && v.length >= 4) p.geohash++;
      }
      if (lookupCountry(v)) p.country++;
      if (lookupState(v)) p.usState++;
      if (normalizeZip(v) && (typeof v === "string" ? /^\s*\d{5}(-\d{4})?\s*$/.test(v) : true)) p.zip++;
    }
    p.distinct = distinct.size;
    return p;
  });
}

// ---------------------------------------------------------------------------
// Name heuristics

const LAT_WORD = /^(lat|lati|latitude|y)$|(^|[_\s.-])(lat|latitude)$|^(lat|latitude)[_\s.-]/i;
const LNG_WORD = /^(lng|lon|long|longitude|x)$|(^|[_\s.-])(lng|lon|long|longitude)$|^(lng|lon|long|longitude)[_\s.-]/i;
// camelCase suffixes are case-sensitive so "flat" / "belong" don't match
const LAT_CAMEL = /[a-z0-9](Lat|Latitude)$/;
const LNG_CAMEL = /[a-z0-9](Lng|Lon|Long|Longitude)$/;
const LAT_NAME = { test: (s: string) => LAT_WORD.test(s) || LAT_CAMEL.test(s) };
const LNG_NAME = { test: (s: string) => LNG_WORD.test(s) || LNG_CAMEL.test(s) };
const LAT_TOKEN = /(latitude|lat|y)$/i;
const LNG_TOKEN = /(longitude|long|lng|lon|x)$/i;

const GEOM_NAME = /geom|geog|geography|location|^loc$|_loc$|coord|point|position|latlng|latlon|lnglat|lonlat|wkt|wkb|shape|geojson|place/i;
const COUNTRY_NAME = /country|nation|ctry|cntry|iso_?a?[23]$|^iso$/i;
const STATE_NAME = /state|province|^region$|_region$/i;
const CITY_NAME = /city|town|municipality|locality|^place$|place_name|metro/i;
const ZIP_NAME = /zip|postal|postcode|post_code/i;
const GEOHASH_NAME = /geohash|ghash|geo_hash/i;

const MEASURE_NAME = /count|total|amount|revenue|sales|value|population|^pop$|_pop$|size|mag|magnitude|weight|qty|quantity|price|sum|score|volume|cost|spend|orders|visits|users|deaths|cases|depth|capacity|area|income/i;
const LABEL_NAME = /name|title|label|city|place|description|address|^site$|store|location_name/i;
const ID_NAME = /(^id$|_id$|Id$|^uuid$|_uuid$|^pk$|key$)/;

function stripToken(name: string, token: RegExp): string {
  return name.replace(token, "").replace(/[_\s.-]+$/, "").toLowerCase();
}

function frac(n: number, d: number) {
  return d === 0 ? 0 : n / d;
}

export interface LatLngPair {
  lat: string;
  lng: string;
  prefix: string;
}

/** Find lat/lng column pairs, matched by shared prefix ("pickup_lat" + "pickup_lng"). */
export function findLatLngPairs(profiles: ColumnProfile[]): LatLngPair[] {
  const coordOk = (p: ColumnProfile, axis: "lat" | "lng") =>
    p.nonNull > 0 && frac(axis === "lat" ? p.inLatRange : p.inLngRange, p.nonNull) >= 0.8;
  const lats = profiles.filter((p) => LAT_NAME.test(p.name) && coordOk(p, "lat"));
  const lngs = profiles.filter((p) => LNG_NAME.test(p.name) && coordOk(p, "lng"));
  const pairs: LatLngPair[] = [];
  const used = new Set<string>();
  for (const lat of lats) {
    const prefix = stripToken(lat.name, LAT_TOKEN);
    const lng =
      lngs.find((l) => !used.has(l.name) && stripToken(l.name, LNG_TOKEN) === prefix) ??
      (lats.length === 1 ? lngs.find((l) => !used.has(l.name)) : undefined);
    if (lng) {
      used.add(lng.name);
      pairs.push({ lat: lat.name, lng: lng.name, prefix });
    }
  }
  // Prefer real names over bare x/y
  return pairs.sort((a, b) => Number(/^(x|y)$/i.test(a.lat)) - Number(/^(x|y)$/i.test(b.lat)));
}

const DEST_PREFIX = /(^|_)(dest|destination|to|end|dropoff|drop|arrival|arr|target)$/i;

export interface Suggestion {
  location: Partial<LocationConfig>;
  style: Partial<StyleConfig>;
  /** Human-readable explanation of what was picked */
  reason: string;
}

/** Suggest a location + style configuration for a dataset. */
export function suggestConfig(ds: Dataset, profiles = profileColumns(ds)): Suggestion | null {
  const location = pickLocation(profiles);
  if (!location) return null;
  const style = pickStyle(profiles, location.location);
  return { location: location.location, style, reason: location.reason };
}

function pickLocation(profiles: ColumnProfile[]): { location: Partial<LocationConfig>; reason: string } | null {
  const pairs = findLatLngPairs(profiles);
  if (pairs.length > 0) {
    // Origin/destination: pick the non-destination pair as the origin
    const origin = pairs.find((p) => !DEST_PREFIX.test(p.prefix)) ?? pairs[0];
    const dest = pairs.find((p) => p !== origin && DEST_PREFIX.test(p.prefix)) ?? pairs.find((p) => p !== origin);
    return {
      location: {
        mode: "latlng",
        latColumn: origin.lat,
        lngColumn: origin.lng,
        destLatColumn: dest?.lat ?? null,
        destLngColumn: dest?.lng ?? null,
      },
      reason: `Detected latitude "${origin.lat}" and longitude "${origin.lng}"${dest ? `, destination "${dest.lat}" / "${dest.lng}"` : ""}`,
    };
  }

  const strong = (p: ColumnProfile, count: number, threshold = 0.6) => p.nonNull > 0 && frac(count, p.nonNull) >= threshold;

  const geoms = profiles.filter((p) => strong(p, p.location, 0.6));
  if (geoms.length > 0) {
    const named = geoms.find((p) => GEOM_NAME.test(p.name)) ?? geoms[0];
    return { location: { mode: "geometry", column: named.name }, reason: `Detected locations in "${named.name}"` };
  }

  const geohash = profiles.find((p) => GEOHASH_NAME.test(p.name) && strong(p, p.geohash, 0.8));
  if (geohash) {
    return {
      location: { mode: "geometry", column: geohash.name, geohash: true },
      reason: `Detected geohashes in "${geohash.name}"`,
    };
  }

  const zip = profiles.find((p) => ZIP_NAME.test(p.name) && strong(p, p.zip, 0.6));
  if (zip) return { location: { mode: "zip", column: zip.name }, reason: `Detected US ZIP codes in "${zip.name}"` };

  // A named city column is more precise than any country/state column next to it
  const city = profiles.find((p) => CITY_NAME.test(p.name) && p.textual > 0 && frac(p.country, p.nonNull) < 0.5);
  if (city) {
    const country = profiles.find((p) => p !== city && COUNTRY_NAME.test(p.name));
    const region = profiles.find((p) => p !== city && STATE_NAME.test(p.name));
    return {
      location: { mode: "city", column: city.name, countryColumn: country?.name ?? null, regionColumn: region?.name ?? null },
      reason: `Detected city names in "${city.name}"`,
    };
  }

  // Regions: prefer a named column, then whichever matches more values
  const regionCandidates = profiles
    .map((p) => {
      const stateScore = frac(p.usState, p.nonNull) + (STATE_NAME.test(p.name) ? 0.3 : 0) - (COUNTRY_NAME.test(p.name) ? 0.5 : 0);
      const countryScore = frac(p.country, p.nonNull) + (COUNTRY_NAME.test(p.name) ? 0.3 : 0) - (STATE_NAME.test(p.name) ? 0.5 : 0);
      return { p, stateScore, countryScore };
    })
    .filter(({ p }) => p.nonNull > 0 && p.numeric < p.nonNull * 0.5);
  const bestState = [...regionCandidates].sort((a, b) => b.stateScore - a.stateScore)[0];
  const bestCountry = [...regionCandidates].sort((a, b) => b.countryScore - a.countryScore)[0];
  const stateOk = bestState && frac(bestState.p.usState, bestState.p.nonNull) >= 0.7 && bestState.stateScore >= 0.8;
  const countryOk = bestCountry && frac(bestCountry.p.country, bestCountry.p.nonNull) >= 0.6 && bestCountry.countryScore >= 0.7;
  if (stateOk && (!countryOk || bestState.stateScore >= bestCountry.countryScore)) {
    return { location: { mode: "us-state", column: bestState.p.name }, reason: `Detected US states in "${bestState.p.name}"` };
  }
  if (countryOk) {
    return { location: { mode: "country", column: bestCountry.p.name }, reason: `Detected countries in "${bestCountry.p.name}"` };
  }


  // Unnamed numeric pair in Web Mercator range (x/y metres)
  const xs = profiles.find((p) => /^(x|easting)$/i.test(p.name) && p.numeric > 0);
  const ys = profiles.find((p) => /^(y|northing)$/i.test(p.name) && p.numeric > 0);
  if (xs && ys && isMercatorRange(xs.max, ys.max)) {
    return {
      location: { mode: "latlng", latColumn: ys.name, lngColumn: xs.name, crs: "mercator" },
      reason: `Detected Web Mercator coordinates in "${xs.name}" / "${ys.name}"`,
    };
  }
  return null;
}

function pickStyle(profiles: ColumnProfile[], loc: Partial<LocationConfig>): Partial<StyleConfig> {
  const locationColumns = new Set(
    [loc.latColumn, loc.lngColumn, loc.column, loc.destLatColumn, loc.destLngColumn, loc.countryColumn, loc.regionColumn].filter(Boolean)
  );
  const others = profiles.filter((p) => !locationColumns.has(p.name));

  const measure = others.find(
    (p) => MEASURE_NAME.test(p.name) && !ID_NAME.test(p.name) && p.nonNull > 0 && frac(p.numeric, p.nonNull) > 0.9 && p.max > p.min
  );
  const label =
    others.find((p) => LABEL_NAME.test(p.name) && p.textual > 0) ??
    others.find((p) => p.textual > 0 && p.distinct > 1 && !ID_NAME.test(p.name));

  const style: Partial<StyleConfig> = {
    tooltipColumn: label?.name ?? null,
  };
  if (loc.mode === "country" || loc.mode === "us-state") {
    style.layer = "regions";
    style.valueColumn = measure?.name ?? null;
    style.aggregation = measure ? "sum" : "count";
  } else if (loc.destLatColumn && loc.destLngColumn) {
    style.layer = "lines";
  }
  return style;
}

/** Apply a suggestion on top of an existing config, keeping user style choices. */
export function applySuggestion(config: MapConfig, s: Suggestion): MapConfig {
  const base = defaultConfig();
  return {
    ...config,
    location: { ...base.location, ...s.location },
    style: { ...config.style, ...s.style },
    hiddenCategories: [],
  };
}
