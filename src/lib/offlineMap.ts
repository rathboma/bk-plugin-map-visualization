// Offline basemap packs, shared by every map tab: stored in this plugin's IndexedDB (which persists
// across app restarts), announced to other tabs over a BroadcastChannel.
//
// Two slots: the downloaded world map, and an optional detailed file (e.g. one city at street level)
// that's drawn on top of it.
import { reactive } from "vue";
import { PMTiles } from "pmtiles";
import { BlobSource, WORLD_PACK, downloadPack, validatePack, type PackInfo } from "./pack";

export type WorldStatus = "checking" | "missing" | "ready" | "downloading" | "saving" | "unavailable";
export type Slot = "world" | "detail";

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
const PROMPT_KEY = "offline-map-prompt";

export const offlineMap = reactive({
  /** The downloadable world map */
  status: "checking" as WorldStatus,
  world: null as PackInfo | null,
  detail: null as PackInfo | null,
  detailSaving: false,
  progress: 0,
  error: "",
  promptDismissed: readPromptDismissed(),
});

const layers: Record<Slot, OfflineLayer | null> = { world: null, detail: null };
let controller: AbortController | null = null;
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("offline-map") : null;
channel?.addEventListener("message", () => {
  if (offlineMap.status !== "downloading" && offlineMap.status !== "saving") loadOfflineMap();
});

function readPromptDismissed(): boolean {
  try {
    return localStorage.getItem(PROMPT_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export function dismissOfflinePrompt() {
  offlineMap.promptDismissed = true;
  try {
    localStorage.setItem(PROMPT_KEY, "dismissed");
  } catch {
    // storage blocked: the prompt comes back next time, which is harmless
  }
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

function layerFor(slot: Slot, record: PackRecord | undefined): OfflineLayer | null {
  if (!record?.blob || !record.info) return null;
  const key = `${slot}:${record.info.id}@${record.info.savedAt}`;
  if (layers[slot]?.key === key) return layers[slot];
  return { pmtiles: new PMTiles(new BlobSource(record.blob, key)), key, info: record.info };
}

/** Reads the stored packs. Call before the first basemap is drawn so "Match app theme" picks the right one. */
export async function loadOfflineMap(): Promise<void> {
  if (typeof indexedDB === "undefined") {
    offlineMap.status = "unavailable";
    return;
  }
  try {
    for (const slot of ["world", "detail"] as const) {
      layers[slot] = layerFor(slot, await withStore<PackRecord | undefined>("readonly", (s) => s.get(slot)));
    }
    offlineMap.world = layers.world?.info ?? null;
    offlineMap.detail = layers.detail?.info ?? null;
    offlineMap.status = layers.world ? "ready" : "missing";
  } catch (e) {
    layers.world = layers.detail = null;
    offlineMap.world = offlineMap.detail = null;
    offlineMap.status = "unavailable";
    offlineMap.error = `Offline storage isn't available: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The packs to draw, or null when there are none. */
export function offlineArchives(): OfflineArchives | null {
  const { world, detail } = layers;
  if (!world && !detail) return null;
  return { world, detail, key: `${world?.key ?? ""}|${detail?.key ?? ""}` };
}

async function save(slot: Slot, blob: Blob, info: PackInfo) {
  await withStore("readwrite", (s) => s.put({ info, blob } satisfies PackRecord, slot));
  navigator.storage?.persist?.().catch(() => undefined);
  // Re-read so tiles come from the disk-backed copy instead of the downloaded chunks in memory
  await loadOfflineMap();
  channel?.postMessage("changed");
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function downloadWorldMap(): Promise<boolean> {
  if (offlineMap.status === "downloading" || offlineMap.status === "saving") return false;
  controller = new AbortController();
  offlineMap.status = "downloading";
  offlineMap.progress = 0;
  offlineMap.error = "";
  try {
    const blob = await downloadPack(WORLD_PACK.url, WORLD_PACK.bytes, (f) => (offlineMap.progress = f), controller.signal);
    const meta = await validatePack(blob);
    offlineMap.status = "saving";
    await save("world", blob, {
      id: WORLD_PACK.id,
      name: WORLD_PACK.name,
      bytes: blob.size,
      ...meta,
      origin: "download",
      savedAt: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    if (!controller?.signal.aborted) offlineMap.error = messageOf(e);
    offlineMap.status = layers.world ? "ready" : "missing";
    return false;
  } finally {
    controller = null;
  }
}

export function cancelDownload() {
  controller?.abort();
}

/** Uses a local .pmtiles file (e.g. a street-level extract of one city) as the detailed area. */
export async function importPackFile(file: File): Promise<boolean> {
  offlineMap.error = "";
  offlineMap.detailSaving = true;
  try {
    const meta = await validatePack(file);
    await save("detail", file, {
      id: "file",
      name: file.name.replace(/\.pmtiles$/i, ""),
      bytes: file.size,
      ...meta,
      origin: "file",
      savedAt: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    offlineMap.error = messageOf(e);
    return false;
  } finally {
    offlineMap.detailSaving = false;
  }
}

export async function removeOfflinePack(slot: Slot) {
  offlineMap.error = "";
  await withStore("readwrite", (s) => s.delete(slot));
  await loadOfflineMap();
  channel?.postMessage("changed");
}
