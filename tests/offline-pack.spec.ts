// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobSource, WORLD_PACK, downloadPack, formatBytes, maxZoomAt, validatePack, type PackInfo } from "../src/lib/pack";
import { basemapIsDark, resolveBasemap } from "../src/lib/basemaps";

const packFile = readFileSync(new URL("../basemaps/world-v1.pmtiles", import.meta.url));

describe("offline pack", () => {
  it("ships the world pack at the size the download expects", () => {
    expect(packFile.length).toBe(WORLD_PACK.bytes);
    expect(WORLD_PACK.url).toContain(`/basemaps/${WORLD_PACK.id}.pmtiles`);
  });

  it("validates the bundled world pack", async () => {
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
    expect(formatBytes(WORLD_PACK.bytes)).toBe("20 MB");
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

describe("downloadPack", () => {
  afterEach(() => vi.unstubAllGlobals());

  const streamOf = (chunks: number[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of chunks) c.enqueue(new Uint8Array(n).fill(1));
        c.close();
      },
    });

  it("streams with progress and returns the whole file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamOf([400, 400, 200]))));
    const progress: number[] = [];
    const blob = await downloadPack("https://example.test/pack.pmtiles", 1000, (f) => progress.push(f));
    expect(blob.size).toBe(1000);
    expect(progress).toEqual([0.4, 0.8, 1, 1]);
  });

  it("fails on truncated downloads and HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamOf([400]))));
    await expect(downloadPack("https://example.test/a", 1000, () => undefined)).rejects.toThrow(/incomplete/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404 })));
    await expect(downloadPack("https://example.test/b", 1000, () => undefined)).rejects.toThrow("HTTP 404");
  });
});

describe("basemap resolution with an offline pack", () => {
  it("prefers the downloaded map for Match app theme", () => {
    expect(resolveBasemap("auto", false, true)).toBe("offline-osm");
    expect(resolveBasemap("auto", true, false)).toBe("esri-dark-gray");
    expect(resolveBasemap("auto", false, false)).toBe("esri-light-gray");
  });

  it("falls back to the built-in outlines until the pack exists", () => {
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
