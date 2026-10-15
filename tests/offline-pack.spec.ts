// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlobSource, formatBytes, maxZoomAt, validatePack, type PackInfo } from "../src/lib/pack";
import { basemapIsDark, resolveBasemap } from "../src/lib/basemaps";

const packFile = readFileSync(new URL("../basemaps/world.pmtiles", import.meta.url));

describe("offline pack", () => {
  it("validates the bundled world map", async () => {
    const meta = await validatePack(new Blob([packFile]));
    expect(meta.maxZoom).toBe(6);
    expect(meta.bounds[0]).toBeCloseTo(-180);
    expect(meta.bounds[3]).toBeCloseTo(85.05, 1);
  });

  it("rejects files that aren't vector PMTiles", async () => {
    await expect(validatePack(new Blob(["just some text, not tiles"]))).rejects.toThrow("Not a PMTiles file");
    const raster = Buffer.from(packFile);
    raster[99] = 2; // tile type: png
    await expect(validatePack(new Blob([raster]))).rejects.toThrow(/raster/);
  });

  it("reads byte ranges from a Blob", async () => {
    const src = new BlobSource(new Blob([new Uint8Array([1, 2, 3, 4, 5])]), "k");
    const { data } = await src.getBytes(1, 3);
    expect([...new Uint8Array(data)]).toEqual([2, 3, 4]);
    expect(src.getKey()).toBe("k");
  });

  it("formats sizes", () => {
    expect(formatBytes(packFile.length)).toBe("20 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatBytes(2_048)).toBe("2 KB");
  });
});

describe("maxZoomAt", () => {
  const pack = (maxZoom: number, bounds: PackInfo["bounds"]): PackInfo => ({
    id: "x",
    name: "x",
    bytes: 1,
    maxZoom,
    bounds,
    origin: "file",
    savedAt: "",
  });
  const world = pack(6, [-180, -85, 180, 85]);
  const manhattan = pack(15, [-74.03, 40.69, -73.92, 40.82]);

  it("uses the detailed area inside its bounds and the world map elsewhere", () => {
    expect(maxZoomAt(world, manhattan, 40.758, -73.985)).toBe(15);
    expect(maxZoomAt(world, manhattan, 51.5, -0.12)).toBe(6);
    expect(maxZoomAt(null, manhattan, 51.5, -0.12)).toBe(15);
    expect(maxZoomAt(null, null, 0, 0)).toBeNull();
  });
});

describe("basemap resolution with an offline pack", () => {
  it("prefers the offline map for Match app theme", () => {
    expect(resolveBasemap("auto", false, true)).toBe("offline-osm");
    expect(resolveBasemap("auto", true, false)).toBe("esri-dark-gray");
    expect(resolveBasemap("auto", false, false)).toBe("esri-light-gray");
  });

  it("falls back to the built-in outlines when the offline map is missing", () => {
    expect(resolveBasemap("offline-osm", false, false)).toBe("offline");
    expect(resolveBasemap("offline-osm", false, true)).toBe("offline-osm");
    expect(resolveBasemap("esri-imagery", false, true)).toBe("esri-imagery");
  });

  it("follows the app theme for mark contrast", () => {
    expect(basemapIsDark("auto", true, true)).toBe(true);
    expect(basemapIsDark("auto", false, true)).toBe(false);
    expect(basemapIsDark("esri-imagery", false, true)).toBe(true);
  });
});
