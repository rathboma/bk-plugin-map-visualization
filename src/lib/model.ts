import type { Dataset } from "./dataset";
import { columnIndex, displayValue } from "./dataset";
import type { Aggregation, MapConfig } from "./config";
import type { PlotItem } from "./build";
import {
  categoryKey,
  formatNumber,
  isMostlyNumeric,
  makeCategoricalScale,
  makeNumericColorScale,
  makeSizeScale,
  numericValues,
  transform,
  type ColorLegend,
  type ColorScale,
} from "./scales";
import { categoricalPalette, defaultMarkColor, OTHER_COLOR } from "./color";
import { parseNumber } from "./geo/parse";
import { COUNTRIES, US_STATES } from "./geo/regions";

export interface RegionDatum {
  key: string;
  name: string;
  value: number;
  count: number;
  rows: number[];
  lat: number;
  lng: number;
  color: string;
}

export interface PathGroup {
  key: string;
  color: string;
  items: PlotItem[];
}

export interface Legend {
  size?: { title: string; entries: { value: number; radius: number }[]; color: string; kind: "circle" | "line" };
  color?: { title: string; legend: ColorLegend };
  heat?: { title: string; stops: string[] };
  note?: string;
}

export interface RenderModel {
  layer: MapConfig["style"]["layer"];
  items: PlotItem[];
  hiddenCount: number;
  dark: boolean;
  opacity: number;
  radius(item: PlotItem): number;
  color(item: PlotItem): string;
  label(item: PlotItem): string | null;
  /** Row numbers go inside the mark; text labels sit beside it */
  labelInside: boolean;
  tooltip(item: PlotItem): { title: string; detail?: string };
  lineWidth(item: PlotItem): number;
  heatWeight(item: PlotItem): number;
  regions: RegionDatum[];
  regionKind: "country" | "us-state" | null;
  groups: PathGroup[];
  legend: Legend;
  curved: boolean;
  showPathPoints: boolean;
  heatRadius: number;
  heatBlur: number;
}

const AGG_LABEL: Record<Aggregation, string> = {
  count: "Row count",
  sum: "Sum of",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
};

export function aggregationTitle(agg: Aggregation, column: string | null): string {
  if (agg === "count" || !column) return "Row count";
  return `${AGG_LABEL[agg]} ${column}`;
}

function aggregate(values: number[], agg: Aggregation, count: number): number {
  if (agg === "count") return count;
  if (values.length === 0) return NaN;
  switch (agg) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

function compareValues(a: unknown, b: unknown): number {
  const na = parseNumber(a);
  const nb = parseNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = typeof a === "string" ? Date.parse(a) : NaN;
  const db = typeof b === "string" ? Date.parse(b) : NaN;
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

const scaleSuffix = (s: string) => (s === "linear" ? "" : ` (${s === "sqrt" ? "square root" : s})`);

export function buildRenderModel(ds: Dataset, allItems: PlotItem[], config: MapConfig, dark: boolean): RenderModel {
  // Copy every setting up front: the closures below read some of them only while drawing, which a
  // reactive caller (App's computed model) wouldn't track, so e.g. the size slider wouldn't redraw
  const style = { ...config.style };
  const { location } = config;
  const layer = style.layer;
  const legend: Legend = {};
  const cell = (item: PlotItem, ci: number) => (ci >= 0 ? ds.rows[item.row][ci] : undefined);

  // ---- colour
  const colorIdx = columnIndex(ds, style.colorColumn);
  const baseColor = style.color || defaultMarkColor(dark);
  let colorScale: ColorScale | null = null;
  let categorical = false;
  // Heatmaps, clusters and regions have their own colour encoding
  if (colorIdx >= 0 && (layer === "points" || layer === "lines")) {
    const values = allItems.map((it) => cell(it, colorIdx));
    if (isMostlyNumeric(values)) {
      colorScale = makeNumericColorScale(values, {
        scale: style.colorScale,
        palette: style.palette,
        dark,
        purpose: "mark",
        clamp: style.clampOutliers,
      });
    } else {
      colorScale = makeCategoricalScale(values, dark);
      categorical = true;
    }
    if (colorScale) {
      legend.color = {
        title: style.colorColumn! + (categorical ? "" : scaleSuffix(style.colorScale === "quantile" ? "linear" : style.colorScale)),
        legend: colorScale.legend,
      };
    }
  }

  // Hidden categories filter the plotted items (legend toggles)
  const hidden = new Set(categorical ? config.hiddenCategories : []);
  const items = hidden.size
    ? allItems.filter((it) => !hidden.has(colorScale!.category!(cell(it, colorIdx))))
    : allItems;

  const color = (item: PlotItem) => (colorScale ? colorScale.color(cell(item, colorIdx)) : baseColor);

  // ---- size
  const sizeIdx = columnIndex(ds, style.sizeColumn);
  const sizeScale =
    sizeIdx >= 0 && ["points", "lines", "clusters"].includes(layer)
      ? makeSizeScale(
          allItems.map((it) => cell(it, sizeIdx)),
          { scale: style.sizeScale, minRadius: style.minRadius, maxRadius: style.maxRadius, clamp: style.clampOutliers }
        )
      : null;
  if (sizeScale && layer === "points") {
    legend.size = {
      title: style.sizeColumn! + scaleSuffix(style.sizeScale),
      entries: sizeScale.legend,
      // Colour already encodes something else, so the size key stays neutral
      color: colorScale ? OTHER_COLOR : baseColor,
      kind: "circle",
    };
  }
  const radius = (item: PlotItem) => (sizeScale ? sizeScale.radius(cell(item, sizeIdx)) : style.radius);
  // Lines map the radius range onto a 1..6px stroke; wider flows swamp each other
  const widthFromRadius = (r: number) => 1 + ((r - style.minRadius) / Math.max(1, style.maxRadius - style.minRadius)) * 5;
  const lineWidth = (item: PlotItem) =>
    sizeScale ? widthFromRadius(sizeScale.radius(cell(item, sizeIdx))) : style.lineWidth;
  if (sizeScale && layer === "lines") {
    legend.size = {
      title: `Line width: ${style.sizeColumn}${scaleSuffix(style.sizeScale)}`,
      entries: sizeScale.legend.map((e) => ({ value: e.value, radius: widthFromRadius(e.radius) })),
      color: baseColor,
      kind: "line",
    };
  }

  // ---- labels
  const labelIdx = columnIndex(ds, style.labelColumn);
  const label = (item: PlotItem): string | null => {
    if (style.labelMode === "row") return String(ds.rowNumbers[item.row] ?? item.row + 1);
    if (style.labelMode === "column" && labelIdx >= 0) {
      const v = cell(item, labelIdx);
      return v === null || v === undefined ? null : displayValue(v).slice(0, 24);
    }
    return null;
  };

  // ---- tooltip
  const tipIdx = columnIndex(ds, style.tooltipColumn);
  const tooltip = (item: PlotItem) => {
    const rowLabel = `Row ${ds.rowNumbers[item.row] ?? item.row + 1}`;
    const title = tipIdx >= 0 ? displayValue(cell(item, tipIdx)) : rowLabel;
    const parts: string[] = [];
    if (tipIdx >= 0) parts.push(rowLabel);
    if (sizeIdx >= 0) parts.push(`${style.sizeColumn}: ${formatCell(cell(item, sizeIdx))}`);
    if (colorIdx >= 0 && style.colorColumn !== style.sizeColumn) parts.push(`${style.colorColumn}: ${formatCell(cell(item, colorIdx))}`);
    return { title, detail: parts.join(" · ") || undefined };
  };

  // ---- heatmap
  const weightIdx = layer === "heatmap" ? sizeIdx : -1;
  let heatWeight = (_: PlotItem) => 1;
  if (weightIdx >= 0) {
    const nums = numericValues(items.map((it) => cell(it, weightIdx)));
    const tmax = Math.max(...nums.map((n) => transform(Math.max(0, n), style.sizeScale)), 0);
    heatWeight = (item) => {
      const n = parseNumber(cell(item, weightIdx));
      if (n === null || tmax <= 0) return 0;
      return Math.max(0.02, transform(Math.max(0, n), style.sizeScale) / tmax);
    };
  }
  if (layer === "heatmap") {
    legend.heat = {
      title: weightIdx >= 0 ? `Density weighted by ${style.sizeColumn}` : "Density of rows",
      stops: heatStops(dark),
    };
  }

  // ---- regions (choropleth)
  let regions: RegionDatum[] = [];
  const regionKind = location.mode === "country" || location.mode === "us-state" ? location.mode : null;
  if (layer === "regions" && regionKind) {
    const valueIdx = columnIndex(ds, style.valueColumn);
    const groups = new Map<string, { rows: number[]; values: number[] }>();
    for (const it of items) {
      if (!it.regionKey) continue;
      let g = groups.get(it.regionKey);
      if (!g) groups.set(it.regionKey, (g = { rows: [], values: [] }));
      g.rows.push(it.row);
      if (valueIdx >= 0) {
        const n = parseNumber(cell(it, valueIdx));
        if (n !== null) g.values.push(n);
      }
    }
    const agg = valueIdx >= 0 ? style.aggregation : "count";
    const lookup = regionKind === "country" ? new Map(COUNTRIES.map((c) => [c.a2, c])) : new Map(US_STATES.map((s) => [s.abbr, s]));
    regions = [...groups.entries()].map(([key, g]) => {
      const meta = lookup.get(key)!;
      return {
        key,
        name: meta.name,
        value: aggregate(g.values, agg, g.rows.length),
        count: g.rows.length,
        rows: g.rows,
        lat: meta.lat,
        lng: meta.lng,
        color: OTHER_COLOR,
      };
    });
    const scale = makeNumericColorScale(
      regions.map((r) => r.value).filter((v) => Number.isFinite(v)),
      { scale: style.colorScale, palette: style.palette, dark, purpose: "fill", clamp: false }
    );
    if (scale) {
      regions.forEach((r) => (r.color = Number.isFinite(r.value) ? scale.color(r.value) : OTHER_COLOR));
      legend.color = { title: aggregationTitle(agg, style.valueColumn), legend: scale.legend };
    }
  }

  // ---- path groups
  let groups: PathGroup[] = [];
  if (layer === "path") {
    const groupIdx = columnIndex(ds, style.groupColumn);
    const orderIdx = columnIndex(ds, style.orderColumn);
    const byKey = new Map<string, PlotItem[]>();
    for (const it of items) {
      const k = groupIdx >= 0 ? categoryKey(cell(it, groupIdx)) : "";
      let list = byKey.get(k);
      if (!list) byKey.set(k, (list = []));
      list.push(it);
    }
    const palette = categoricalPalette(dark);
    const keys = [...byKey.keys()];
    groups = keys.map((key, i) => {
      const list = byKey.get(key)!;
      if (orderIdx >= 0) list.sort((a, b) => compareValues(cell(a, orderIdx), cell(b, orderIdx)) || a.row - b.row);
      const c = groupIdx < 0 ? baseColor : i < palette.length ? palette[i] : OTHER_COLOR;
      return { key, color: c, items: list };
    });
    if (groupIdx >= 0 && !legend.color) {
      const shown = groups.slice(0, palette.length).map((g) => ({ value: g.key, color: g.color, count: g.items.length }));
      if (groups.length > palette.length) {
        shown.push({
          value: `${groups.length - palette.length} more`,
          color: OTHER_COLOR,
          count: groups.slice(palette.length).reduce((s, g) => s + g.items.length, 0),
        });
      }
      legend.color = { title: style.groupColumn!, legend: { type: "categories", categories: shown } };
    }
  }

  if (hidden.size) legend.note = `${allItems.length - items.length} rows hidden by legend filter`;

  return {
    layer,
    items,
    hiddenCount: allItems.length - items.length,
    dark,
    opacity: style.opacity,
    radius,
    color: layer === "path" && groups.length > 1 ? pathColor(groups, color) : color,
    label,
    labelInside: style.labelMode === "row",
    tooltip,
    lineWidth,
    heatWeight,
    regions,
    regionKind,
    groups,
    legend,
    curved: style.curvedLines,
    showPathPoints: style.showPathPoints,
    heatRadius: style.heatRadius,
    heatBlur: style.heatBlur,
  };
}

/** In path mode, points take their group's colour. */
function pathColor(groups: PathGroup[], fallback: (i: PlotItem) => string) {
  const byRow = new Map<number, string>();
  for (const g of groups) for (const it of g.items) byRow.set(it.row, g.color);
  return (item: PlotItem) => byRow.get(item.row) ?? fallback(item);
}

/** Heatmap gradient: one hue, low density recedes into the basemap. */
export function heatStops(dark: boolean): string[] {
  return dark
    ? ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#b7d3f6"]
    : ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#0d366b"];
}

/** Measures in tooltips get thousands separators; text stays as-is. */
export function formatCell(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return displayValue(v);
}

export function describeValue(n: number): string {
  return Number.isFinite(n) ? formatNumber(n) : "–";
}
