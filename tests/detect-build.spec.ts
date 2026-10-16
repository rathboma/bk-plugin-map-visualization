import { describe, expect, it } from "vitest";
import { datasetFromQueryResult, datasetFromRange, uniqueNames, type Dataset } from "../src/lib/dataset";
import { findLatLngPairs, profileColumns, suggestConfig, applySuggestion } from "../src/lib/detect";
import { buildItems } from "../src/lib/build";
import { defaultConfig, type LocationConfig } from "../src/lib/config";

function ds(columns: string[], rows: unknown[][]): Dataset {
  return { columns, rows, rowNumbers: rows.map((_, i) => i + 1) };
}

function loc(partial: Partial<LocationConfig>): LocationConfig {
  return { ...defaultConfig().location, ...partial };
}

const cities = ds(
  ["id", "name", "latitude", "longitude", "population"],
  [
    [1, "New York", 40.7128, -74.006, 8336817],
    [2, "London", 51.5074, -0.1278, 8982000],
    [3, "Tokyo", 35.6762, 139.6503, 13960000],
    [4, "Sydney", -33.8688, 151.2093, 5312000],
    [5, "Nowhere", null, null, 0],
  ]
);

describe("datasets", () => {
  it("dedupes column names", () => {
    expect(uniqueNames(["id", "id", "name"])).toEqual(["id", "id (2)", "name"]);
  });

  it("reads rows keyed by field id or name", () => {
    const d = datasetFromQueryResult({
      fields: [
        { id: "c0", name: "lat" },
        { id: "c1", name: "lng" },
      ],
      rows: [{ c0: 1, c1: 2 }],
    });
    expect(d.rows).toEqual([[1, 2]]);
    const byName = datasetFromQueryResult({
      fields: [
        { id: "lat", name: "lat" },
        { id: "lng", name: "lng" },
      ],
      rows: [{ lat: 3, lng: 4 }],
    });
    expect(byName.rows).toEqual([[3, 4]]);
  });

  it("reads a results-grid selection", () => {
    const d = datasetFromRange({ rows: [3, 4], columns: ["a", "b"], value: [[1, 2], [3, 4]] });
    expect(d.rowNumbers).toEqual([3, 4]);
    expect(d.rows).toEqual([[1, 2], [3, 4]]);
  });
});

describe("detection", () => {
  it("finds lat/lng columns by name and validates ranges", () => {
    const s = suggestConfig(cities)!;
    expect(s.location).toMatchObject({ mode: "latlng", latColumn: "latitude", lngColumn: "longitude" });
    expect(s.style.tooltipColumn).toBe("name");
  });

  it("pairs prefixed columns and picks origin/destination", () => {
    const trips = ds(
      ["trip_id", "dropoff_lat", "dropoff_lng", "pickup_lat", "pickup_lng"],
      [[1, 40.7, -74.0, 40.8, -73.9], [2, 40.6, -73.8, 40.75, -73.98]]
    );
    const pairs = findLatLngPairs(profileColumns(trips));
    expect(pairs).toHaveLength(2);
    const s = suggestConfig(trips)!;
    expect(s.location).toMatchObject({
      latColumn: "pickup_lat",
      lngColumn: "pickup_lng",
      destLatColumn: "dropoff_lat",
      destLngColumn: "dropoff_lng",
    });
    expect(s.style.layer).toBe("lines");
  });

  it("matches camelCase names but not words that end in lat/long", () => {
    const d = ds(["storeLat", "storeLng", "flat", "belong"], [[40, -74, 1, 2]]);
    const pairs = findLatLngPairs(profileColumns(d));
    expect(pairs).toEqual([{ lat: "storeLat", lng: "storeLng", prefix: "store" }]);
  });

  it("rejects columns named lat/lng whose values are out of range", () => {
    const d = ds(["lat", "lng"], [[400, 500], [300, 200]]);
    expect(findLatLngPairs(profileColumns(d))).toEqual([]);
  });

  it("detects geometry columns", () => {
    const d = ds(["id", "geom"], [[1, "0101000020E6100000000000000000F03F0000000000000040"], [2, "POINT(3 4)"]]);
    expect(suggestConfig(d)!.location).toMatchObject({ mode: "geometry", column: "geom" });
  });

  it("detects countries and US states", () => {
    const c = ds(["country", "revenue"], [["United States", 10], ["Germany", 5], ["FR", 3], ["Japan", 1]]);
    expect(suggestConfig(c)).toMatchObject({
      location: { mode: "country", column: "country" },
      style: { layer: "regions", valueColumn: "revenue", aggregation: "sum" },
    });
    const s = ds(["state", "orders"], [["CA", 10], ["TX", 5], ["NY", 3], ["GA", 2], ["PA", 1]]);
    expect(suggestConfig(s)!.location).toMatchObject({ mode: "us-state", column: "state" });
  });

  it("detects ZIP and city columns", () => {
    const z = ds(["zip", "n"], [["02134", 1], ["10001", 2], ["94103", 3]]);
    expect(suggestConfig(z)!.location).toMatchObject({ mode: "zip", column: "zip" });
    const c = ds(["city", "country"], [["Paris", "France"], ["Berlin", "Germany"]]);
    expect(suggestConfig(c)!.location).toMatchObject({ mode: "city", column: "city", countryColumn: "country" });
    // Five-digit postcodes outside the US aren't ZIP codes
    const intl = ds(["city", "country", "zip"], [["Paris", "France", "75001"], ["Berlin", "Germany", "10115"], ["Austin", "US", "78701"]]);
    expect(suggestConfig(intl)!.location).toMatchObject({ mode: "city", column: "city" });
    const us = ds(["city", "country", "zip"], [["Boston", "US", "02134"], ["Austin", "USA", "78701"]]);
    expect(suggestConfig(us)!.location).toMatchObject({ mode: "zip", column: "zip" });
  });

  it("returns null when nothing looks like a location", () => {
    expect(suggestConfig(ds(["a", "b"], [["x", 1], ["y", 2]]))).toBeNull();
  });

  it("applySuggestion resets location but keeps style", () => {
    const base = defaultConfig();
    base.style.radius = 12;
    const s = suggestConfig(cities)!;
    const merged = applySuggestion(base, s);
    expect(merged.style.radius).toBe(12);
    expect(merged.location.latColumn).toBe("latitude");
  });

  it("applySuggestion swaps out a layer the new locations can't draw", () => {
    const regions = defaultConfig();
    regions.style.layer = "regions";
    expect(applySuggestion(regions, suggestConfig(cities)!).style.layer).toBe("points");
    const zips = ds(["zip"], [["02134"], ["10001"]]);
    expect(applySuggestion(regions, suggestConfig(zips)!).style.layer).toBe("points");

    const lines = defaultConfig();
    lines.style.layer = "lines";
    expect(applySuggestion(lines, suggestConfig(cities)!).style.layer).toBe("points");

    const heat = defaultConfig();
    heat.style.layer = "heatmap";
    expect(applySuggestion(heat, suggestConfig(cities)!).style.layer).toBe("heatmap");
  });
});

describe("buildItems", () => {
  it("plots lat/lng rows and reports skipped ones", async () => {
    const r = await buildItems(cities, loc({ mode: "latlng", latColumn: "latitude", lngColumn: "longitude" }));
    expect(r.items).toHaveLength(4);
    expect(r.skipped).toEqual([4]);
    expect(r.items[2]).toMatchObject({ row: 2, lat: 35.6762, lng: 139.6503 });
  });

  it("flips swapped lat/lng columns", async () => {
    const d = ds(["lat", "lng"], [[-74.006, 40.7128], [-118.24, 34.05]]);
    const r = await buildItems(d, loc({ latColumn: "lat", lngColumn: "lng" }));
    expect(r.items[0]).toMatchObject({ lat: 40.7128, lng: -74.006 });
    expect(r.warnings.join(" ")).toMatch(/swapped/);
  });

  it("converts Web Mercator columns", async () => {
    const d = ds(["y", "x"], [[4970071.58, -8238310.24], [4970000, -8238000]]);
    const r = await buildItems(d, loc({ latColumn: "y", lngColumn: "x" }));
    expect(r.items[0].lat).toBeCloseTo(40.7128, 3);
    expect(r.warnings.join(" ")).toMatch(/Mercator/);
  });

  it("parses mixed geometry values", async () => {
    const d = ds(
      ["g"],
      [
        ["POINT(-74.006 40.7128)"],
        ["40.7128, -74.006"],
        ['{"type":"LineString","coordinates":[[0,0],[2,2]]}'],
        ["SRID=3857;POINT(-8238310.24 4970071.58)"],
        ["SRID=2263;POINT(987654 203040)"],
        ["junk"],
      ]
    );
    const r = await buildItems(d, loc({ mode: "geometry", column: "g" }));
    expect(r.items).toHaveLength(4);
    expect(r.items[0]).toMatchObject({ lat: 40.7128, lng: -74.006 });
    expect(r.items[1]).toMatchObject({ lat: 40.7128, lng: -74.006 });
    expect(r.items[2].geometry?.type).toBe("LineString");
    expect(r.items.find((i) => i.row === 3)!.lat).toBeCloseTo(40.7128, 3);
    expect(r.skipped).toEqual([4, 5]);
    expect(r.warnings.join(" ")).toMatch(/SRID 2263/);
  });

  it("geocodes regions, cities and zips", async () => {
    const countries = await buildItems(ds(["c"], [["Germany"], ["Mordor"]]), loc({ mode: "country", column: "c" }));
    expect(countries.items[0].regionKey).toBe("DE");
    expect(countries.skipped).toEqual([1]);

    const cityRows = await buildItems(
      ds(["city", "st"], [["Portland", "OR"], ["Portland", "ME"]]),
      loc({ mode: "city", column: "city", regionColumn: "st" })
    );
    expect(cityRows.items[0].lng).toBeLessThan(-120);
    expect(cityRows.items[1].lng).toBeGreaterThan(-71);

    const zips = await buildItems(ds(["zip"], [[10001], ["94103"], ["00000"], ["30301"], ["99999"]]), loc({ mode: "zip", column: "zip" }));
    expect(zips.items).toHaveLength(3);
    expect(zips.skipped).toEqual([2, 4]);
    expect(zips.warnings.join(" ")).toMatch(/3-digit ZIP area/);
  });

  it("attaches destinations for origin/destination lines", async () => {
    const d = ds(["a_lat", "a_lng", "b_lat", "b_lng"], [[1, 2, 3, 4]]);
    const r = await buildItems(d, loc({ latColumn: "a_lat", lngColumn: "a_lng", destLatColumn: "b_lat", destLngColumn: "b_lng" }));
    expect(r.items[0].dest).toEqual({ lat: 3, lng: 4 });
  });
});

import { buildTableQuery, isSafeToAutoRun, queryFromEditorParams } from "../src/lib/host";

describe("host helpers", () => {
  it("only auto-runs single read-only statements", () => {
    expect(isSafeToAutoRun("select * from places")).toBe(true);
    expect(isSafeToAutoRun("  WITH x AS (select 1) select * from x;")).toBe(true);
    expect(isSafeToAutoRun("-- comment\nselect lat, lng from t")).toBe(true);
    expect(isSafeToAutoRun("delete from places")).toBe(false);
    expect(isSafeToAutoRun("select * from a; drop table a")).toBe(false);
    expect(isSafeToAutoRun("with d as (delete from t returning *) select * from d")).toBe(false);
    expect(isSafeToAutoRun("select * into backup from t")).toBe(false);
    expect(isSafeToAutoRun("")).toBe(false);
  });

  it("builds a dialect-appropriate table query", () => {
    expect(buildTableQuery({ name: "places", schema: "public" }, "postgresql")).toBe('SELECT * FROM "public"."places" LIMIT 10000');
    expect(buildTableQuery({ name: "places" }, "mysql")).toBe("SELECT * FROM `places` LIMIT 10000");
    expect(buildTableQuery({ name: "places", schema: "dbo" }, "sqlserver")).toBe("SELECT TOP 10000 * FROM [dbo].[places]");
    expect(buildTableQuery({ name: "PLACES" }, "oracle")).toBe('SELECT * FROM "PLACES" FETCH FIRST 10000 ROWS ONLY');
    expect(buildTableQuery({ name: 'we"ird' }, "sqlite")).toBe('SELECT * FROM "we""ird" LIMIT 10000');
    expect(buildTableQuery({ name: "coll" }, "mongodb")).toBe("");
  });

  it("applies the table view's filters", () => {
    const where = `"country" = 'NZ'`;
    expect(buildTableQuery({ name: "places" }, "postgresql", 10000, where)).toBe(
      `SELECT * FROM "places" WHERE "country" = 'NZ' LIMIT 10000`,
    );
    expect(buildTableQuery({ name: "places" }, "sqlserver", 50, "[country] = 'NZ'")).toBe(
      "SELECT TOP 50 * FROM [places] WHERE [country] = 'NZ'",
    );
    expect(buildTableQuery({ name: "PLACES" }, "oracle", 10, where)).toBe(
      `SELECT * FROM "PLACES" WHERE "country" = 'NZ' FETCH FIRST 10 ROWS ONLY`,
    );
    expect(buildTableQuery({ name: "places" }, "postgresql", 10, "  ")).toBe('SELECT * FROM "places" LIMIT 10');
  });

  it("prefers the selected text from the editor", () => {
    expect(queryFromEditorParams({ text: "a; b", selectedQuery: "select 1;", selectedText: "" })).toBe("select 1");
    expect(queryFromEditorParams({ text: "select 2", selectedText: "select 3" })).toBe("select 3");
    expect(queryFromEditorParams(null)).toBe("");
  });
});
