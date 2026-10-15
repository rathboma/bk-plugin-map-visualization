import type { ColorScaleType, ScaleType, SequentialPalette } from "./config";
import { categoricalPalette, OTHER_COLOR, rampStops, sampleStops, type RampPurpose } from "./color";
import { parseNumber } from "./geo/parse";

/** Value transform applied before mapping to a visual range. */
export function transform(v: number, type: ScaleType | ColorScaleType): number {
  if (type === "sqrt") return Math.sign(v) * Math.sqrt(Math.abs(v));
  if (type === "log") return Math.sign(v) * Math.log10(1 + Math.abs(v));
  return v;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function numericValues(values: unknown[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const n = parseNumber(v);
    if (n !== null) out.push(n);
  }
  return out;
}

export interface Domain {
  min: number;
  max: number;
  /** Upper bound used for the scale (p99 when clamping outliers) */
  hi: number;
  lo: number;
}

export function domainOf(values: number[], clamp: boolean): Domain | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const hi = clamp && sorted.length >= 20 ? quantile(sorted, 0.99) : max;
  const lo = clamp && sorted.length >= 20 ? quantile(sorted, 0.01) : min;
  return { min, max, lo, hi: hi > lo ? hi : max };
}

// ---------------------------------------------------------------------------
// Size

export interface SizeScale {
  radius(v: unknown): number;
  domain: Domain;
  legend: { value: number; radius: number }[];
}

export function makeSizeScale(
  values: unknown[],
  opts: { scale: ScaleType; minRadius: number; maxRadius: number; clamp: boolean }
): SizeScale | null {
  const nums = numericValues(values);
  const domain = domainOf(nums, opts.clamp);
  if (!domain) return null;
  const tLo = transform(domain.lo, opts.scale);
  const tHi = transform(domain.hi, opts.scale);
  const span = tHi - tLo;
  const { minRadius, maxRadius } = opts;
  const radiusOf = (n: number) => {
    if (span <= 0) return (minRadius + maxRadius) / 2;
    const t = (transform(n, opts.scale) - tLo) / span;
    return minRadius + Math.max(0, Math.min(1, t)) * (maxRadius - minRadius);
  };
  const legendValues = niceLegendValues(domain, opts.scale);
  return {
    domain,
    radius(v) {
      const n = parseNumber(v);
      return n === null ? minRadius : radiusOf(n);
    },
    legend: legendValues.map((value) => ({ value, radius: radiusOf(value) })),
  };
}

/** Three representative values (low / mid / high) spaced evenly in transformed space. */
function niceLegendValues(d: Domain, scale: ScaleType): number[] {
  if (d.hi === d.lo) return [d.hi];
  const inv = (t: number) => {
    if (scale === "sqrt") return Math.sign(t) * t * t;
    if (scale === "log") return Math.sign(t) * (10 ** Math.abs(t) - 1);
    return t;
  };
  const a = transform(d.lo, scale);
  const b = transform(d.hi, scale);
  return [a, (a + b) / 2, b].map((t) => niceRound(inv(t)));
}

export function niceRound(v: number): number {
  if (v === 0 || !Number.isFinite(v)) return v;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(v)) - 1);
  return Math.round(v / mag) * mag;
}

// ---------------------------------------------------------------------------
// Colour

export interface CategoryEntry {
  value: string;
  color: string;
  count: number;
  other?: boolean;
}

export type ColorLegend =
  | { type: "gradient"; stops: string[]; min: number; max: number; clamped: boolean; scale: ColorScaleType }
  | { type: "classes"; classes: { from: number; to: number; color: string }[] }
  | { type: "categories"; categories: CategoryEntry[] };

export interface ColorScale {
  color(v: unknown): string;
  /** Category key for filtering (categorical scales only) */
  category?(v: unknown): string;
  legend: ColorLegend;
}

export const MAX_CATEGORIES = 8;

export function categoryKey(v: unknown): string {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function isMostlyNumeric(values: unknown[]): boolean {
  let numeric = 0;
  let nonNull = 0;
  const distinct = new Set<string>();
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    nonNull++;
    if (parseNumber(v) !== null) numeric++;
    if (distinct.size <= MAX_CATEGORIES) distinct.add(String(v));
  }
  // A handful of distinct integers (e.g. 1/2/3 ratings) reads better as categories
  return nonNull > 0 && numeric / nonNull > 0.9 && distinct.size > MAX_CATEGORIES;
}

export function makeCategoricalScale(values: unknown[], dark: boolean): ColorScale {
  const counts = new Map<string, number>();
  for (const v of values) {
    const k = categoryKey(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const palette = categoricalPalette(dark);
  // Keep first-seen order for stable colours when counts tie; rank by frequency
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const overflow = ranked.length > MAX_CATEGORIES;
  const keep = overflow ? ranked.slice(0, MAX_CATEGORIES - 1) : ranked;
  // Colour follows the entity: assign slots alphabetically-stable by first appearance
  const order = new Map<string, number>();
  for (const v of values) {
    const k = categoryKey(v);
    if (!order.has(k)) order.set(k, order.size);
  }
  const kept = keep.map(([k]) => k).sort((a, b) => order.get(a)! - order.get(b)!);
  const colorFor = new Map(kept.map((k, i) => [k, palette[i]]));
  const categories: CategoryEntry[] = kept.map((k) => ({ value: k, color: colorFor.get(k)!, count: counts.get(k)! }));
  if (overflow) {
    const otherCount = ranked.slice(MAX_CATEGORIES - 1).reduce((s, [, c]) => s + c, 0);
    categories.push({ value: "Other", color: OTHER_COLOR, count: otherCount, other: true });
  }
  return {
    color: (v) => colorFor.get(categoryKey(v)) ?? OTHER_COLOR,
    category: (v) => {
      const k = categoryKey(v);
      return colorFor.has(k) ? k : "Other";
    },
    legend: { type: "categories", categories },
  };
}

export function makeNumericColorScale(
  values: unknown[],
  opts: { scale: ColorScaleType; palette: SequentialPalette; dark: boolean; purpose: RampPurpose; clamp: boolean }
): ColorScale | null {
  const nums = numericValues(values);
  const domain = domainOf(nums, opts.clamp && opts.scale === "linear");
  if (!domain) return null;
  const stops = rampStops(opts.palette, opts.dark, opts.purpose);

  if (opts.scale === "quantile") {
    const sorted = [...nums].sort((a, b) => a - b);
    const k = Math.min(5, new Set(sorted).size);
    const breaks: number[] = [];
    for (let i = 1; i < k; i++) breaks.push(quantile(sorted, i / k));
    const colors = Array.from({ length: k }, (_, i) => sampleStops(stops, k === 1 ? 1 : i / (k - 1)));
    const classOf = (n: number) => {
      let i = 0;
      while (i < breaks.length && n > breaks[i]) i++;
      return i;
    };
    const bounds = [domain.min, ...breaks, domain.max];
    return {
      color: (v) => {
        const n = parseNumber(v);
        return n === null ? OTHER_COLOR : colors[classOf(n)];
      },
      legend: {
        type: "classes",
        classes: colors.map((color, i) => ({ from: bounds[i], to: bounds[i + 1], color })),
      },
    };
  }

  const tLo = transform(domain.lo, opts.scale);
  const tHi = transform(domain.hi, opts.scale);
  // Diverging scales centre on zero when the data straddles it
  let center: number | null = null;
  if (opts.palette === "diverging" && domain.lo < 0 && domain.hi > 0) center = transform(0, opts.scale);
  const tOf = (n: number) => {
    const t = transform(n, opts.scale);
    if (center !== null) {
      return t < center ? 0.5 * (t - tLo) / (center - tLo) : 0.5 + 0.5 * (t - center) / (tHi - center);
    }
    return tHi === tLo ? 1 : (t - tLo) / (tHi - tLo);
  };
  return {
    color: (v) => {
      const n = parseNumber(v);
      return n === null ? OTHER_COLOR : sampleStops(stops, tOf(n));
    },
    legend: {
      type: "gradient",
      stops: Array.from({ length: 9 }, (_, i) => sampleStops(stops, i / 8)),
      min: domain.lo,
      max: domain.hi,
      clamped: domain.hi < domain.max || domain.lo > domain.min,
      scale: opts.scale,
    },
  };
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const precise = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 10000 ? compact.format(n) : precise.format(n);
}

/** One notation for every number in a legend, picked from the largest value. */
export function legendFormatter(values: number[]): (n: number) => string {
  const max = Math.max(0, ...values.filter(Number.isFinite).map(Math.abs));
  return (n) => (!Number.isFinite(n) ? String(n) : max >= 10000 ? compact.format(n) : precise.format(n));
}
