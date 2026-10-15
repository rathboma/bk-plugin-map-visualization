// Offline basemap packs: the world map bundled with the plugin, plus an optional detailed file (e.g. one
// city at street level) drawn on top of it. The detailed file lives in this plugin's IndexedDB, which
// persists across app restarts, and other map tabs hear about changes over a BroadcastChannel.
import { reactive } from "vue";
import { PMTiles } from "pmtiles";
import worldUrl from "../../basemaps/world.pmtiles?url";
import { BlobSource, validatePack, type PackInfo } from "./pack";

export interface OfflineLayer {
  pmtiles: PMTiles;
  key: string;
  info: PackInfo;
}

/** What the renderer draws: the world map, the detailed area over it, or both. */
export interface OfflineArchives {
  world: OfflineLayer | null;
  detail: OfflineLayer | null;
  key: string;
}

interface PackRecord {
  info: PackInfo;
  blob: Blob;
}

const DB_NAME = "offline-map";
const STORE = "packs";
const DETAIL_KEY = "detail";

export const offlineMap = reactive({
  world: null as PackInfo | null,
  detail: null as PackInfo | null,
  detailSaving: false,
  /** Why the bundled world map couldn't be read */
  worldError: "",
  /** Detailed-area problems (bad file, storage unavailable) */
  error: "",
});

const layers: { world: OfflineLayer | null; detail: OfflineLayer | null } = { world: null, detail: null };
let worldLoad: Promise<void> | null = null;
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("offline-map") : null;
channel?.addEventListener("message", () => loadDetail());

// fetch() rejects plugin:// URLs (the scheme isn't registered for the Fetch API), but XHR works
function readFile(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "blob";
    xhr.onload = () => (xhr.status === 200 ? resolve(xhr.response) : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error(`Couldn't read ${url}`));
    xhr.send();
  });
}

// plugin:// can't serve byte ranges, so the archive is read once and tiles are sliced out of the Blob
function loadWorld(): Promise<void> {
  worldLoad ??= (async () => {
    try {
      const blob = await readFile(worldUrl);
      const key = `world@${blob.size}`;
      const pmtiles = new PMTiles(new BlobSource(blob, key));
      const header = await pmtiles.getHeader();
      const info: PackInfo = {
        id: "world",
        name: "World",
        bytes: blob.size,
        maxZoom: header.maxZoom,
        bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat],
        origin: "bundled",
        savedAt: "",
      };
      layers.world = { pmtiles, key, info };
      offlineMap.world = info;
    } catch (e) {
      // Falls back to online tiles
      offlineMap.worldError = e instanceof Error ? e.message : String(e);
    }
  })();
  return worldLoad;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Storage transaction aborted"));
    });
  } finally {
    db.close();
  }
}

async function loadDetail(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const record = await withStore<PackRecord | undefined>("readonly", (s) => s.get(DETAIL_KEY));
    if (record?.blob && record.info) {
      const key = `detail:${record.info.savedAt}`;
      if (layers.detail?.key !== key) {
        layers.detail = { pmtiles: new PMTiles(new BlobSource(record.blob, key)), key, info: record.info };
      }
    } else {
      layers.detail = null;
    }
    offlineMap.detail = layers.detail?.info ?? null;
  } catch (e) {
    layers.detail = null;
    offlineMap.detail = null;
    offlineMap.error = `Offline storage isn't available: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Loads the bundled world map and any detailed area. Call before the first basemap is drawn. */
export async function loadOfflineMap(): Promise<void> {
  await Promise.all([loadWorld(), loadDetail()]);
}

/** The packs to draw, or null when there are none. */
export function offlineArchives(): OfflineArchives | null {
  const { world, detail } = layers;
  if (!world && !detail) return null;
  return { world, detail, key: `${world?.key ?? ""}|${detail?.key ?? ""}` };
}

/** Uses a local .pmtiles file (e.g. a street-level extract of one city) as the detailed area. */
export async function importPackFile(file: File): Promise<boolean> {
  offlineMap.error = "";
  offlineMap.detailSaving = true;
  try {
    const meta = await validatePack(file);
    const info: PackInfo = {
      id: "file",
      name: file.name.replace(/\.pmtiles$/i, ""),
      bytes: file.size,
      ...meta,
      origin: "file",
      savedAt: new Date().toISOString(),
    };
    await withStore("readwrite", (s) => s.put({ info, blob: file } satisfies PackRecord, DETAIL_KEY));
    navigator.storage?.persist?.().catch(() => undefined);
    // Re-read so tiles come from the stored copy rather than the picked file
    await loadDetail();
    channel?.postMessage("changed");
    return true;
  } catch (e) {
    offlineMap.error = e instanceof Error ? e.message : String(e);
    return false;
  } finally {
    offlineMap.detailSaving = false;
  }
}

export async function removeDetail() {
  offlineMap.error = "";
  await withStore("readwrite", (s) => s.delete(DETAIL_KEY));
  await loadDetail();
  channel?.postMessage("changed");
}
