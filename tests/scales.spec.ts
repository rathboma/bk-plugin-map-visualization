import { describe, expect, it } from "vitest";
import {
  domainOf,
  formatNumber,
  isMostlyNumeric,
  makeCategoricalScale,
  makeNumericColorScale,
  makeSizeScale,
  transform,
} from "../src/lib/scales";
import { CATEGORICAL_LIGHT, OTHER_COLOR, hexToOklab, mixOklab, rampStops } from "../src/lib/color";

describe("transforms", () => {
  it("applies sqrt and log symmetrically", () => {
    expect(transform(100, "sqrt")).toBe(10);
    expect(transform(-100, "sqrt")).toBe(-10);
    expect(transform(99, "log")).toBeCloseTo(2);
    expect(transform(0, "log")).toBe(0);
  });

  it("clamps outliers at the 99th percentile", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    values.push(1_000_000);
    const d = domainOf(values, true)!;
    expect(d.max).toBe(1_000_000);
    expect(d.hi).toBeLessThan(200);
    expect(domainOf(values, false)!.hi).toBe(1_000_000);
  });
});

describe("size scale", () => {
  it("maps the domain onto the radius range", () => {
    const s = makeSizeScale([0, 50, 100], { scale: "linear", minRadius: 4, maxRadius: 24, clamp: false })!;
    expect(s.radius(0)).toBe(4);
    expect(s.radius(100)).toBe(24);
    expect(s.radius(50)).toBe(14);
    expect(s.radius("not a number")).toBe(4);
  });

  it("sqrt makes area proportional; log compresses large ranges", () => {
    const sqrt = makeSizeScale([0, 25, 100], { scale: "sqrt", minRadius: 0, maxRadius: 10, clamp: false })!;
    expect(sqrt.radius(25)).toBeCloseTo(5);
    const log = makeSizeScale([0, 9, 99999], { scale: "log", minRadius: 0, maxRadius: 10, clamp: false })!;
    expect(log.radius(9)).toBeCloseTo(2);
    expect(log.legend).toHaveLength(3);
  });

  it("handles a single distinct value", () => {
    const s = makeSizeScale([5, 5], { scale: "linear", minRadius: 4, maxRadius: 20, clamp: true })!;
    expect(s.radius(5)).toBe(12);
  });
});

describe("colour scales", () => {
  it("assigns categorical slots in first-seen order and folds the rest into Other", () => {
    const values = ["b", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const s = makeCategoricalScale(values, false);
    expect(s.color("b")).toBe(CATEGORICAL_LIGHT[0]);
    expect(s.color("a")).toBe(CATEGORICAL_LIGHT[1]);
    const legend = s.legend.type === "categories" ? s.legend.categories : [];
    expect(legend).toHaveLength(8);
    expect(legend[7]).toMatchObject({ value: "Other", other: true, count: 3 });
    expect(s.color("j")).toBe(OTHER_COLOR);
    expect(s.category!("j")).toBe("Other");
  });

  it("treats a handful of numbers as categories", () => {
    expect(isMostlyNumeric([1, 2, 3, 1, 2])).toBe(false);
    expect(isMostlyNumeric(Array.from({ length: 20 }, (_, i) => i * 1.5))).toBe(true);
    expect(isMostlyNumeric(["a", "b"])).toBe(false);
  });

  it("builds a monotone sequential ramp (light to dark on light themes)", () => {
    const stops = rampStops("blue", false, "mark");
    const L = stops.map((h) => hexToOklab(h)[0]);
    for (let i = 1; i < L.length; i++) expect(L[i]).toBeLessThan(L[i - 1]);
    const dark = rampStops("blue", true, "mark").map((h) => hexToOklab(h)[0]);
    for (let i = 1; i < dark.length; i++) expect(dark[i]).toBeGreaterThan(dark[i - 1]);
  });

  it("maps numbers to the ramp ends and produces quantile classes", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const lin = makeNumericColorScale(values, { scale: "linear", palette: "blue", dark: false, purpose: "mark", clamp: false })!;
    const stops = rampStops("blue", false, "mark");
    expect(lin.color(1)).toBe(stops[0]);
    expect(lin.color(10)).toBe(stops[stops.length - 1]);
    const q = makeNumericColorScale(values, { scale: "quantile", palette: "blue", dark: false, purpose: "fill", clamp: false })!;
    expect(q.legend.type).toBe("classes");
    if (q.legend.type === "classes") expect(q.legend.classes).toHaveLength(5);
  });

  it("centres diverging scales on zero", () => {
    const s = makeNumericColorScale([-10, 0, 100], { scale: "linear", palette: "diverging", dark: false, purpose: "mark", clamp: false })!;
    expect(s.color(0)).toBe("#f0efec");
  });

  it("mixes in OKLab", () => {
    expect(mixOklab("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixOklab("#000000", "#ffffff", 1)).toBe("#ffffff");
  });
});

describe("formatNumber", () => {
  it("is compact for big numbers", () => {
    expect(formatNumber(1234)).toBe("1,234");
    expect(formatNumber(12_500_000)).toMatch(/12\.5M/);
  });
});
