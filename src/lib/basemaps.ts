import type { BasemapId } from "./config";

export interface TileBasemap {
  id: BasemapId;
  label: string;
  url: string;
  /** Optional label layer drawn above the data */
  labels?: string;
  attribution: string;
  subdomains?: string;
  maxZoom: number;
  maxNativeZoom?: number;
  dark?: boolean;
}

const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
const ESRI_CANVAS = "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community";

export const TILE_BASEMAPS: TileBasemap[] = [
  {
    id: "esri-light-gray",
    label: "Light gray (Esri)",
    url: `${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    attribution: ESRI_CANVAS,
    maxZoom: 19,
    maxNativeZoom: 16,
  },
  {
    id: "esri-dark-gray",
    label: "Dark gray (Esri)",
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    attribution: ESRI_CANVAS,
    maxZoom: 19,
    maxNativeZoom: 16,
    dark: true,
  },
  {
    id: "esri-streets",
    label: "Streets (Esri)",
    url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, &copy; OpenStreetMap contributors, and the GIS user community",
    maxZoom: 19,
  },
  {
    id: "esri-topo",
    label: "Topographic (Esri)",
    url: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`,
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, GEBCO, &copy; OpenStreetMap contributors, and the GIS user community",
    maxZoom: 19,
  },
  {
    id: "esri-imagery",
    label: "Satellite (Esri)",
    url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxZoom: 19,
    dark: true,
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: OSM,
    maxZoom: 19,
  },
  {
    id: "opentopo",
    label: "OpenTopoMap",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: `${OSM}, <a href="http://viewfinderpanoramas.org">SRTM</a> | &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    subdomains: "abc",
    maxZoom: 17,
  },
];

export const BASEMAP_OPTIONS: { id: BasemapId; label: string }[] = [
  { id: "auto", label: "Match app theme" },
  { id: "offline-osm", label: "Offline map (OpenStreetMap)" },
  ...TILE_BASEMAPS.map(({ id, label }) => ({ id, label })),
  { id: "offline", label: "Country outlines (built in)" },
  { id: "custom", label: "Custom tile URL…" },
];

/**
 * Resolve "auto" against the app theme: the downloaded offline map when there is one, otherwise
 * Esri's gray canvases. The offline map falls back to the built-in outlines until it's downloaded.
 */
export function resolveBasemap(id: BasemapId, dark: boolean, offlineReady = false): BasemapId {
  if (id === "auto") return offlineReady ? "offline-osm" : dark ? "esri-dark-gray" : "esri-light-gray";
  if (id === "offline-osm" && !offlineReady) return "offline";
  return id;
}

export function tileBasemap(id: BasemapId): TileBasemap | undefined {
  return TILE_BASEMAPS.find((b) => b.id === id);
}

/** Whether marks sit on a dark background (affects ramps and outlines). */
export function basemapIsDark(id: BasemapId, appDark: boolean, offlineReady = false): boolean {
  const resolved = resolveBasemap(id, appDark, offlineReady);
  if (resolved === "offline" || resolved === "offline-osm" || resolved === "custom") return appDark;
  return !!tileBasemap(resolved)?.dark;
}

/** Only allow http(s) XYZ templates for custom tiles. */
export function isValidTileUrl(url: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(url) && url.includes("{z}") && url.includes("{x}") && url.includes("{y}");
}
