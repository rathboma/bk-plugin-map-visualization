import { describe, expect, it } from "vitest";
import { buildRenderModel, formatCell } from "../src/lib/model";
import { buildItems } from "../src/lib/build";
import { defaultConfig, mergeConfig, type MapConfig } from "../src/lib/config";
import type { Dataset } from "../src/lib/dataset";
import { CATEGORICAL_LIGHT } from "../src/lib/color";

function ds(columns: string[], rows: unknown[][]): Dataset {
  return { columns, rows, rowNumbers: rows.map((_, i) => i + 1) };
}

function config(patch: { location?: Partial<MapConfig["location"]>; style?: Partial<MapConfig["style"]>; hiddenCategories?: string[] }): MapConfig {
  const base = defaultConfig();
  return {
    ...base,
    location: { ...base.location, ...patch.location },
    style: { ...base.style, ...patch.style },
    hiddenCategories: patch.hiddenCategories ?? [],
  };
}

describe("buildRenderModel", () => {
  it("aggregates rows per region for filled regions", async () => {
    const data = ds(["state", "amount"], [["TX", 10], ["Texas", 5], ["CA", 1], ["CA", 2], ["Nowhere", 9]]);
    const cfg = config({ location: { mode: "us-state", column: "state" }, style: { layer: "regions", valueColumn: "amount", aggregation: "sum" } });
    const built = await buildItems(data, cfg.location);
    const m = buildRenderModel(data, built.items, cfg, false);
    const tx = m.regions.find((r) => r.key === "TX")!;
    expect(tx).toMatchObject({ value: 15, count: 2, rows: [0, 1] });
    expect(m.regions.find((r) => r.key === "CA")!.value).toBe(3);
    expect(m.legend.color?.title).toBe("Sum of amount");
    expect(built.skipped).toEqual([4]);

    const avg = buildRenderModel(data, built.items, { ...cfg, style: { ...cfg.style, aggregation: "avg" } }, false);
    expect(avg.regions.find((r) => r.key === "TX")!.value).toBe(7.5);
    const count = buildRenderModel(data, built.items, { ...cfg, style: { ...cfg.style, valueColumn: null } }, false);
    expect(count.regions.find((r) => r.key === "TX")!.value).toBe(2);
  });

  it("orders path points by the order column within each group", async () => {
    const data = ds(
      ["vehicle", "ts", "lat", "lng"],
      [
        ["a", "2024-01-01T10:02:00Z", 1, 1],
        ["b", "2024-01-01T10:00:00Z", 5, 5],
        ["a", "2024-01-01T10:00:00Z", 0, 0],
        ["a", "2024-01-01T10:01:00Z", 0.5, 0.5],
      ]
    );
    const cfg = config({
      location: { latColumn: "lat", lngColumn: "lng" },
      style: { layer: "path", groupColumn: "vehicle", orderColumn: "ts" },
    });
    const built = await buildItems(data, cfg.location);
    const m = buildRenderModel(data, built.items, cfg, false);
    expect(m.groups.map((g) => g.key)).toEqual(["a", "b"]);
    expect(m.groups[0].items.map((i) => i.row)).toEqual([2, 3, 0]);
    expect(m.groups[0].color).toBe(CATEGORICAL_LIGHT[0]);
    expect(m.legend.color?.legend.type).toBe("categories");
  });

  it("filters hidden legend categories and reports the count", async () => {
    const data = ds(["lat", "lng", "kind"], [[1, 1, "x"], [2, 2, "y"], [3, 3, "x"]]);
    const cfg = config({ location: { latColumn: "lat", lngColumn: "lng" }, style: { colorColumn: "kind" }, hiddenCategories: ["x"] });
    const built = await buildItems(data, cfg.location);
    const m = buildRenderModel(data, built.items, cfg, false);
    expect(m.items.map((i) => i.row)).toEqual([1]);
    expect(m.hiddenCount).toBe(2);
    expect(m.legend.note).toMatch(/2 rows hidden/);
  });

  it("labels rows by their grid row number and sizes by column", async () => {
    const data: Dataset = { columns: ["lat", "lng", "n"], rows: [[1, 1, 0], [2, 2, 100]], rowNumbers: [7, 9] };
    const cfg = config({
      location: { latColumn: "lat", lngColumn: "lng" },
      style: { labelMode: "row", sizeColumn: "n", sizeScale: "linear", minRadius: 4, maxRadius: 20, clampOutliers: false },
    });
    const built = await buildItems(data, cfg.location);
    const m = buildRenderModel(data, built.items, cfg, false);
    expect(m.items.map((i) => m.label(i))).toEqual(["7", "9"]);
    expect(m.labelInside).toBe(true);
    expect(m.items.map((i) => m.radius(i))).toEqual([4, 20]);
    expect(m.legend.size?.entries[0]).toMatchObject({ value: 0, radius: 4 });
    expect(m.tooltip(m.items[1])).toEqual({ title: "Row 9", detail: "n: 100" });
  });

  it("ignores colour columns for clusters", async () => {
    const data = ds(["lat", "lng", "kind"], [[1, 1, "x"], [2, 2, "y"]]);
    const cfg = config({ location: { latColumn: "lat", lngColumn: "lng" }, style: { layer: "clusters", colorColumn: "kind" } });
    const built = await buildItems(data, cfg.location);
    const m = buildRenderModel(data, built.items, cfg, false);
    expect(m.legend.color).toBeUndefined();
    expect(new Set(m.items.map((i) => m.color(i))).size).toBe(1);
  });

  it("normalises heat weights to 0..1", async () => {
    const data = ds(["lat", "lng", "w"], [[1, 1, 0], [2, 2, 50], [3, 3, 100]]);
    const cfg = config({ location: { latColumn: "lat", lngColumn: "lng" }, style: { layer: "heatmap", sizeColumn: "w", sizeScale: "linear" } });
    const built = await buildItems(data, cfg.location);
    const m = buildRenderModel(data, built.items, cfg, false);
    expect(m.items.map((i) => m.heatWeight(i))).toEqual([0.02, 0.5, 1]);
  });
});

describe("config + formatting", () => {
  it("merges partial saved configs and drops unknown basemaps", () => {
    const merged = mergeConfig({ style: { radius: 11 }, basemap: "carto-light" });
    expect(merged.style.radius).toBe(11);
    expect(merged.style.layer).toBe("points");
    expect(merged.basemap).toBe("auto");
    expect(mergeConfig(null)).toEqual(defaultConfig());
  });

  it("formats numeric cells with separators", () => {
    expect(formatCell(2711840)).toBe((2711840).toLocaleString());
    expect(formatCell("abc")).toBe("abc");
    expect(formatCell(null)).toBe("NULL");
  });
});
