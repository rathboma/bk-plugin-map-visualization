import { PMTiles, TileType, type RangeResponse, type Source } from "pmtiles";

/** A basemap pack: a vector PMTiles archive in the Protomaps basemap schema. */
export interface PackInfo {
  id: string;
  name: string;
  bytes: number;
  maxZoom: number;
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  origin: "bundled" | "file";
  savedAt: string;
}

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
