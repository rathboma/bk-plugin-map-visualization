export type LocationMode = "latlng" | "geometry" | "country" | "us-state" | "city" | "zip";
export type PairOrder = "auto" | "latlng" | "lnglat";
export type Crs = "auto" | "wgs84" | "mercator";

export type LayerType = "points" | "heatmap" | "clusters" | "path" | "lines" | "regions";
export type ScaleType = "linear" | "sqrt" | "log";
export type ColorScaleType = "linear" | "log" | "quantile";
export type SequentialPalette = "blue" | "diverging";
export type LabelMode = "none" | "row" | "column";
export type Aggregation = "count" | "sum" | "avg" | "min" | "max";

export const BASEMAP_IDS = [
  "auto",
  "esri-light-gray",
  "esri-dark-gray",
  "esri-streets",
  "esri-topo",
  "esri-imagery",
  "osm",
  "opentopo",
  "offline",
  "custom",
] as const;
export type BasemapId = (typeof BASEMAP_IDS)[number];

export interface LocationConfig {
  mode: LocationMode;
  latColumn: string | null;
  lngColumn: string | null;
  /** Single column holding WKT / WKB / GeoJSON / "lat,lng" / geohash / city / zip / region */
  column: string | null;
  pairOrder: PairOrder;
  crs: Crs;
  geohash: boolean;
  /** Optional qualifiers for city geocoding */
  countryColumn: string | null;
  regionColumn: string | null;
  defaultCountry: string;
  /** Destination for origin → destination lines */
  destLatColumn: string | null;
  destLngColumn: string | null;
}

export interface StyleConfig {
  layer: LayerType;
  // Size
  sizeColumn: string | null;
  sizeScale: ScaleType;
  radius: number;
  minRadius: number;
  maxRadius: number;
  clampOutliers: boolean;
  // Color
  colorColumn: string | null;
  colorScale: ColorScaleType;
  palette: SequentialPalette;
  color: string | null;
  opacity: number;
  // Labels & tooltip
  labelMode: LabelMode;
  labelColumn: string | null;
  tooltipColumn: string | null;
  // Heatmap
  heatRadius: number;
  heatBlur: number;
  // Path / lines
  groupColumn: string | null;
  orderColumn: string | null;
  showPathPoints: boolean;
  curvedLines: boolean;
  lineWidth: number;
  // Regions
  valueColumn: string | null;
  aggregation: Aggregation;
}

export interface MapConfig {
  location: LocationConfig;
  style: StyleConfig;
  basemap: BasemapId;
  customTileUrl: string;
  /** Categories hidden from the legend */
  hiddenCategories: string[];
}

export function defaultConfig(): MapConfig {
  return {
    location: {
      mode: "latlng",
      latColumn: null,
      lngColumn: null,
      column: null,
      pairOrder: "auto",
      crs: "auto",
      geohash: false,
      countryColumn: null,
      regionColumn: null,
      defaultCountry: "",
      destLatColumn: null,
      destLngColumn: null,
    },
    style: {
      layer: "points",
      sizeColumn: null,
      sizeScale: "sqrt",
      radius: 6,
      minRadius: 4,
      maxRadius: 28,
      clampOutliers: true,
      colorColumn: null,
      colorScale: "linear",
      palette: "blue",
      color: null,
      opacity: 0.8,
      labelMode: "none",
      labelColumn: null,
      tooltipColumn: null,
      heatRadius: 25,
      heatBlur: 15,
      groupColumn: null,
      orderColumn: null,
      showPathPoints: true,
      curvedLines: true,
      lineWidth: 2,
      valueColumn: null,
      aggregation: "count",
    },
    basemap: "auto",
    customTileUrl: "",
    hiddenCategories: [],
  };
}

/** Merge a (possibly older / partial) saved config onto the defaults. */
export function mergeConfig(saved: unknown): MapConfig {
  const base = defaultConfig();
  if (!saved || typeof saved !== "object") return base;
  const s = saved as Partial<MapConfig>;
  return {
    ...base,
    ...s,
    location: { ...base.location, ...(s.location ?? {}) },
    style: { ...base.style, ...(s.style ?? {}) },
    basemap: BASEMAP_IDS.includes(s.basemap as BasemapId) ? (s.basemap as BasemapId) : "auto",
    hiddenCategories: Array.isArray(s.hiddenCategories) ? s.hiddenCategories : [],
  };
}

/** Which layer types make sense for a location mode. */
export function layersFor(mode: LocationMode): LayerType[] {
  if (mode === "country" || mode === "us-state") return ["regions", "points", "heatmap", "clusters"];
  if (mode === "latlng") return ["points", "clusters", "heatmap", "path", "lines"];
  return ["points", "clusters", "heatmap", "path"];
}

export const LAYER_LABELS: Record<LayerType, string> = {
  points: "Points",
  clusters: "Clusters",
  heatmap: "Heatmap",
  path: "Path (connect rows in order)",
  lines: "Lines (origin → destination)",
  regions: "Filled regions",
};

export const LOCATION_LABELS: Record<LocationMode, string> = {
  latlng: "Latitude & longitude columns",
  geometry: "Geometry / point column",
  country: "Country names or codes",
  "us-state": "US state names or codes",
  city: "City names",
  zip: "US ZIP codes",
};
