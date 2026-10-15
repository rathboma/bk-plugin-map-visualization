#!/usr/bin/env node
// Regenerates the offline geocoding tables in src/data/ from public sources.
//
// Usage: node scripts/build-geodata.mjs <source-dir>
//
// <source-dir> must contain (unzipped):
//   - cities15000.txt, countryInfo.txt, admin1CodesASCII.txt
//       https://download.geonames.org/export/dump/ (CC BY 4.0)
//   - 2023_Gaz_zcta_national.txt
//       https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/ (public domain)
//
// Country and US state shapes come from the world-atlas and us-atlas packages
// (Natural Earth / US Census, public domain).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
const srcDir = process.argv[2];
if (!srcDir) {
  console.error("Usage: node scripts/build-geodata.mjs <source-dir>");
  process.exit(1);
}
const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src/data");
fs.mkdirSync(outDir, { recursive: true });

const read = (f) => fs.readFileSync(path.join(srcDir, f), "utf8");
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------------------
// Geometry helpers: centroid of the largest polygon ring, so countries with
// far-flung territories (France, USA, Norway) get a sensible label point.
function ringAreaCentroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  a /= 2;
  if (a === 0) return { area: 0, x: ring[0][0], y: ring[0][1] };
  return { area: Math.abs(a), x: cx / (6 * a), y: cy / (6 * a) };
}

// world-atlas rings are stitched across the antimeridian (Russia, Fiji), so make
// longitudes continuous before doing planar maths on them.
function unwrapRing(ring) {
  const out = [ring[0].slice()];
  let offset = 0;
  for (let i = 1; i < ring.length; i++) {
    const delta = ring[i][0] - ring[i - 1][0];
    if (delta > 180) offset -= 360;
    else if (delta < -180) offset += 360;
    out.push([ring[i][0] + offset, ring[i][1]]);
  }
  return out;
}

function largestPolygonCentroid(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  for (const poly of polys) {
    const c = ringAreaCentroid(unwrapRing(poly[0]));
    if (!best || c.area > best.area) best = c;
  }
  if (!best) return null;
  const lng = ((((best.x + 180) % 360) + 360) % 360) - 180;
  return { lat: round(best.y, 3), lng: round(lng, 3) };
}

// ---------------------------------------------------------------------------
// Cities (needed first so countries without a shape can fall back to their capital)
const cityRows = read("cities15000.txt")
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"))
  .map((c) => ({
    name: c[1],
    ascii: c[2],
    lat: Number(c[4]),
    lng: Number(c[5]),
    featureCode: c[7],
    cc: c[8],
    admin1: c[10],
    pop: Number(c[14]) || 0,
  }))
  .sort((a, b) => b.pop - a.pop);

// ---------------------------------------------------------------------------
// Countries
const world = require("world-atlas/countries-50m.json");
const worldFeatures = feature(world, world.objects.countries).features;
const shapeById = new Map(worldFeatures.filter((f) => f.id).map((f) => [String(f.id), f]));

// Common alternate spellings that don't appear in GeoNames' canonical names.
const COUNTRY_ALIASES = {
  US: ["USA", "U.S.", "U.S.A.", "United States of America", "America", "United States"],
  GB: ["UK", "U.K.", "Great Britain", "Britain", "England", "Scotland", "Wales", "Northern Ireland", "United Kingdom of Great Britain and Northern Ireland"],
  RU: ["Russian Federation"],
  KR: ["South Korea", "Korea, South", "Republic of Korea", "Korea, Republic of", "Korea"],
  KP: ["North Korea", "Korea, North", "DPRK", "Democratic People's Republic of Korea"],
  IR: ["Iran, Islamic Republic of", "Islamic Republic of Iran"],
  VN: ["Viet Nam"],
  SY: ["Syrian Arab Republic"],
  LA: ["Lao PDR", "Lao People's Democratic Republic"],
  BO: ["Bolivia, Plurinational State of"],
  VE: ["Venezuela, Bolivarian Republic of"],
  TZ: ["Tanzania, United Republic of", "United Republic of Tanzania"],
  CZ: ["Czech Republic", "Czechia"],
  CI: ["Ivory Coast", "Côte d'Ivoire", "Cote d'Ivoire"],
  CD: ["DRC", "DR Congo", "Congo, Democratic Republic of the", "Democratic Republic of the Congo", "Dem. Rep. Congo", "Congo-Kinshasa"],
  CG: ["Republic of the Congo", "Congo, Republic of the", "Congo-Brazzaville", "Congo"],
  MK: ["Macedonia", "North Macedonia", "FYROM"],
  MM: ["Burma"],
  NL: ["Holland", "The Netherlands"],
  TW: ["Taiwan, Province of China", "Republic of China"],
  CN: ["PRC", "People's Republic of China"],
  PS: ["Palestine, State of", "Palestinian Territories", "West Bank", "Gaza"],
  MD: ["Moldova, Republic of"],
  BN: ["Brunei Darussalam"],
  CV: ["Cabo Verde"],
  SZ: ["Swaziland", "Eswatini"],
  TL: ["East Timor", "Timor Leste"],
  VA: ["Vatican", "Holy See", "Vatican City State"],
  FM: ["Micronesia, Federated States of"],
  BA: ["Bosnia", "Bosnia-Herzegovina", "Bosnia & Herzegovina"],
  TR: ["Türkiye", "Turkiye"],
  AE: ["UAE", "U.A.E."],
  DO: ["Dominican Rep."],
  CF: ["Central African Rep."],
  SS: ["S. Sudan"],
  GQ: ["Eq. Guinea"],
  SB: ["Solomon Is."],
  FK: ["Falkland Is.", "Falklands", "Falkland Islands (Malvinas)"],
  KY: ["Cayman Is."],
  VG: ["British Virgin Is."],
  VI: ["U.S. Virgin Is.", "US Virgin Islands"],
  MP: ["N. Mariana Is."],
  HK: ["Hong Kong SAR", "Hong Kong, China"],
  MO: ["Macau", "Macao SAR"],
  KN: ["St. Kitts and Nevis", "Saint Kitts & Nevis"],
  LC: ["St. Lucia"],
  VC: ["St. Vincent and the Grenadines", "St. Vin. and Gren."],
  PM: ["St. Pierre and Miquelon"],
  ST: ["Sao Tome and Principe", "São Tomé and Príncipe"],
  AG: ["Antigua & Barbuda"],
  TT: ["Trinidad & Tobago"],
  WF: ["Wallis and Futuna Is."],
  HM: ["Heard I. and McDonald Is."],
  PF: ["Fr. Polynesia"],
  TF: ["Fr. S. Antarctic Lands"],
  EH: ["W. Sahara"],
};

const countries = read("countryInfo.txt")
  .split("\n")
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split("\t"))
  .map((c) => {
    const a2 = c[0];
    const num = c[2].padStart(3, "0");
    const shape = shapeById.get(num);
    let centroid = shape ? largestPolygonCentroid(shape.geometry) : null;
    if (!centroid) {
      const capital = cityRows.find((city) => city.cc === a2 && (city.name === c[5] || city.featureCode === "PPLC"));
      const anyCity = capital || cityRows.find((city) => city.cc === a2);
      if (anyCity) centroid = { lat: round(anyCity.lat, 3), lng: round(anyCity.lng, 3) };
    }
    const aliases = new Set(COUNTRY_ALIASES[a2] || []);
    if (shape?.properties?.name && shape.properties.name !== c[4]) aliases.add(shape.properties.name);
    return {
      a2,
      a3: c[1],
      num,
      name: c[4],
      lat: centroid?.lat ?? null,
      lng: centroid?.lng ?? null,
      aliases: [...aliases],
    };
  })
  .filter((c) => c.lat !== null);

// Shapes in world-atlas that have no ISO numeric id (Kosovo, N. Cyprus, Somaliland)
// are matched by name at runtime, so nothing else is needed here.
fs.writeFileSync(path.join(outDir, "countries.json"), JSON.stringify(countries));
console.log(`countries.json: ${countries.length} countries`);

// ---------------------------------------------------------------------------
// US states (FIPS ids match us-atlas)
const STATES = [
  ["AL", "01"], ["AK", "02"], ["AZ", "04"], ["AR", "05"], ["CA", "06"], ["CO", "08"], ["CT", "09"],
  ["DE", "10"], ["DC", "11"], ["FL", "12"], ["GA", "13"], ["HI", "15"], ["ID", "16"], ["IL", "17"],
  ["IN", "18"], ["IA", "19"], ["KS", "20"], ["KY", "21"], ["LA", "22"], ["ME", "23"], ["MD", "24"],
  ["MA", "25"], ["MI", "26"], ["MN", "27"], ["MS", "28"], ["MO", "29"], ["MT", "30"], ["NE", "31"],
  ["NV", "32"], ["NH", "33"], ["NJ", "34"], ["NM", "35"], ["NY", "36"], ["NC", "37"], ["ND", "38"],
  ["OH", "39"], ["OK", "40"], ["OR", "41"], ["PA", "42"], ["RI", "44"], ["SC", "45"], ["SD", "46"],
  ["TN", "47"], ["TX", "48"], ["UT", "49"], ["VT", "50"], ["VA", "51"], ["WA", "53"], ["WV", "54"],
  ["WI", "55"], ["WY", "56"], ["AS", "60"], ["GU", "66"], ["MP", "69"], ["PR", "72"], ["VI", "78"],
];
const us = require("us-atlas/states-10m.json");
const stateShapes = new Map(feature(us, us.objects.states).features.map((f) => [String(f.id), f]));
const states = STATES.map(([abbr, fips]) => {
  const shape = stateShapes.get(fips);
  if (!shape) return null;
  const c = largestPolygonCentroid(shape.geometry);
  return { abbr, fips, name: shape.properties.name, lat: c.lat, lng: c.lng };
}).filter(Boolean);
fs.writeFileSync(path.join(outDir, "us-states.json"), JSON.stringify(states));
console.log(`us-states.json: ${states.length} states/territories`);

// ---------------------------------------------------------------------------
// Admin-1 names (states/provinces) so "Springfield, Illinois" or "London, Ontario" resolve.
const admin1 = read("admin1CodesASCII.txt")
  .split("\n")
  .filter(Boolean)
  .map((l) => l.split("\t"))
  .map(([code, name, ascii]) => `${code}\t${ascii || name}`);
fs.writeFileSync(path.join(outDir, "admin1.tsv"), admin1.join("\n"));
console.log(`admin1.tsv: ${admin1.length} regions`);

// Cities sorted by population (descending), so the first match is the most likely one.
// Format: name \t asciiName(if different) \t countryCode \t admin1Code \t lat \t lng
const cities = cityRows.map((c) =>
  [c.name, c.ascii !== c.name ? c.ascii : "", c.cc, c.admin1, round(c.lat, 3), round(c.lng, 3)].join("\t")
);
fs.writeFileSync(path.join(outDir, "cities.tsv"), cities.join("\n"));
console.log(`cities.tsv: ${cities.length} cities`);

// US ZIP code (ZCTA) centroids. Format: zip \t lat \t lng
const zips = read("2023_Gaz_zcta_national.txt")
  .split("\n")
  .slice(1)
  .map((l) => l.trim().split(/\t/))
  .filter((c) => c.length >= 7)
  .map((c) => `${c[0]}\t${round(Number(c[5]), 3)}\t${round(Number(c[6]), 3)}`);
fs.writeFileSync(path.join(outDir, "us-zips.tsv"), zips.join("\n"));
console.log(`us-zips.tsv: ${zips.length} ZIP codes`);
