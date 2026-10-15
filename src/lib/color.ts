// Palette + perceptual colour helpers. Palette values come from the validated
// reference instance (fixed categorical order, single-hue sequential ramp,
// blue <-> red diverging with a neutral gray midpoint).

export const CATEGORICAL_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const CATEGORICAL_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const OTHER_COLOR = "#898781";

/** Blue sequential ramp, steps 100 -> 700. */
export const BLUE_RAMP = [
  "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5",
  "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b",
];
const STEP = (step: number) => BLUE_RAMP[(step - 100) / 50];

const NEUTRAL_LIGHT = "#f0efec";
const NEUTRAL_DARK = "#383835";
const RED = "#e34948";

// ---------------------------------------------------------------------------
// OKLab maths

type Vec3 = [number, number, number];

export function hexToRgb(hex: string): Vec3 {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Vec3): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function hexToOklab(hex: string): Vec3 {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Vec3;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToHex([L, a, b]: Vec3): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return rgbToHex([
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]);
}

export function mixOklab(a: string, b: string, t: number): string {
  const A = hexToOklab(a);
  const B = hexToOklab(b);
  return oklabToHex([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

/** Same hue/chroma as `hex`, lightness taken from `like`. */
function withLightnessOf(hex: string, like: string): string {
  const [, a, b] = hexToOklab(hex);
  const [L] = hexToOklab(like);
  const [L0] = hexToOklab(hex);
  // Scale chroma down with lightness so the darker step stays in gamut
  const k = Math.min(1, L / L0);
  return oklabToHex([L, a * k, b * k]);
}

/** Sample a list of stops (evenly spaced) at t in [0, 1]. */
export function sampleStops(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mixOklab(stops[i], stops[i + 1], x - i);
}

export type RampPurpose = "mark" | "fill";

/**
 * Stops for a sequential/diverging scale. Marks on a basemap keep their light end
 * visible (no lighter than step 250 on light, no darker than 600 on dark); fills
 * (choropleth) use the whole ramp. Dark mode flips the anchor so low values recede.
 */
export function rampStops(palette: "blue" | "diverging", dark: boolean, purpose: RampPurpose): string[] {
  if (palette === "diverging") {
    const neutral = dark ? NEUTRAL_DARK : NEUTRAL_LIGHT;
    const blueEnd = dark ? STEP(300) : STEP(600);
    const redEnd = dark ? mixOklab(RED, "#ffffff", 0.2) : withLightnessOf(RED, STEP(600));
    const blueMid = STEP(450);
    return [blueEnd, blueMid, neutral, RED, redEnd];
  }
  if (purpose === "fill") {
    return dark ? [...BLUE_RAMP].reverse().slice(0, 12) : BLUE_RAMP;
  }
  const from = dark ? 600 : 250;
  const to = dark ? 100 : 700;
  const stops: string[] = [];
  const dir = from < to ? 50 : -50;
  for (let s = from; dir > 0 ? s <= to : s >= to; s += dir) stops.push(STEP(s));
  return stops;
}

export function categoricalPalette(dark: boolean): string[] {
  return dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
}

export function defaultMarkColor(dark: boolean): string {
  return categoricalPalette(dark)[0];
}

// ---------------------------------------------------------------------------
// Colour picker helpers

export interface Hsv {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
}

export function hexToHsv(hex: string): Hsv {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return rgbToHex([f(5), f(3), f(1)]);
}

/** "#abc", "abc" or "#aabbcc" as a lowercase "#aabbcc", or null if it isn't a hex colour. */
export function normalizeHex(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  return m ? rgbToHex(hexToRgb(m[1])) : null;
}

/** Black or white text, whichever reads better on `bg`. */
export function textOn(bg: string): string {
  const [L] = hexToOklab(bg);
  return L > 0.65 ? "#0b0b0b" : "#ffffff";
}
