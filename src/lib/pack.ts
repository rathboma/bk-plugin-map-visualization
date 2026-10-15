import { PMTiles, TileType, type RangeResponse, type Source } from "pmtiles";

/** A basemap pack: a Protomaps-schema vector PMTiles archive kept on this computer. */
export interface PackInfo {
  id: string;
  name: string;
  bytes: number;
  maxZoom: number;
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  origin: "download" | "file";
  savedAt: string;
}

/**
 * The downloadable world map: OpenStreetMap data from a Protomaps build, zoom 0-6, without land use,
 * land cover or POIs (see scripts/build-basemap.mjs). The file name is versioned so a published URL
 * never changes content; ship a new name (and bytes) when regenerating.
 */
export const WORLD_PACK = {
  id: "world-v1",
  name: "World",
  url: "https://raw.githubusercontent.com/rathboma/bk-plugin-map-visualization/main/basemaps/world-v1.pmtiles",
  bytes: 19_957_955,
} as const;

export const PACK_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
  '<a href="https://www.naturalearthdata.com">Natural Earth</a> · <a href="https://protomaps.com">Protomaps</a>';

/** Reads tiles straight out of a Blob (IndexedDB hands back disk-backed Blobs, so nothing is loaded up front). */
export class BlobSource implements Source {
  constructor(
    private blob: Blob,
    private key: string,
  ) {}
  getKey() {
    return this.key;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Checks that a file is a vector PMTiles archive in the Protomaps basemap schema. */
export async function validatePack(blob: Blob): Promise<Pick<PackInfo, "maxZoom" | "bounds">> {
  const magic = new TextDecoder().decode(await blob.slice(0, 7).arrayBuffer());
  if (magic !== "PMTiles") throw new Error("Not a PMTiles file");
  const archive = new PMTiles(new BlobSource(blob, "validate"));
  const header = await archive.getHeader();
  if (header.specVersion !== 3) throw new Error(`PMTiles version ${header.specVersion} isn't supported (needs version 3)`);
  if (header.tileType !== TileType.Mvt) throw new Error("Contains raster tiles; a vector (MVT) basemap is needed");
  const metadata = (await archive.getMetadata()) as { vector_layers?: { id: string }[] };
  const layers = new Set((metadata?.vector_layers ?? []).map((l) => l.id));
  if (!layers.has("earth") || !layers.has("water")) {
    throw new Error("Not a Protomaps basemap (no earth / water layers). Other tile schemas can't be styled.");
  }
  return { maxZoom: header.maxZoom, bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat] };
}

/** The most detailed zoom available at a point: the detailed area's inside its bounds, else the world map's. */
export function maxZoomAt(world: PackInfo | null, detail: PackInfo | null, lat: number, lng: number): number | null {
  if (detail) {
    const [w, s, e, n] = detail.bounds;
    if (lng >= w && lng <= e && lat >= s && lat <= n) return detail.maxZoom;
  }
  return world?.maxZoom ?? detail?.maxZoom ?? null;
}

/** Streams a pack download, reporting progress as a 0..1 fraction. */
export async function downloadPack(
  url: string,
  expectedBytes: number,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const chunks: BlobPart[] = [];
  let received = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(Math.min(1, received / expectedBytes));
    }
  } else {
    const buf = await res.arrayBuffer();
    chunks.push(buf);
    received = buf.byteLength;
  }
  if (received !== expectedBytes) {
    throw new Error(`Download incomplete: got ${formatBytes(received)} of ${formatBytes(expectedBytes)}`);
  }
  onProgress(1);
  return new Blob(chunks, { type: "application/vnd.pmtiles" });
}
