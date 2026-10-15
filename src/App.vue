<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import {
  addNotificationListener,
  clipboard,
  expandTableResult,
  getAppInfo,
  getConnectionInfo,
  getViewContext,
  getViewState,
  log,
  noty,
  requestFileSave,
  runQuery,
  setTabTitle,
  setViewState,
  type AppTheme,
  type PluginViewContext,
} from "@beekeeperstudio/plugin";
import SettingsPanel from "./components/SettingsPanel.vue";
import MapLegend from "./components/MapLegend.vue";
import Icon from "./components/Icon.vue";
import OfflinePrompt from "./components/OfflinePrompt.vue";
import { defaultConfig, mergeConfig, type MapConfig } from "./lib/config";
import {
  datasetFromQueryResult,
  datasetFromRange,
  displayValue,
  emptyDataset,
  toJsonValue,
  toTableResult,
  type Dataset,
} from "./lib/dataset";
import { applySuggestion, profileColumns, suggestConfig, type ColumnProfile } from "./lib/detect";
import { buildItems, type BuildResult, type PlotItem } from "./lib/build";
import { aggregationTitle, buildRenderModel, describeValue, type RegionDatum, type RenderModel } from "./lib/model";
import { MapRenderer } from "./lib/renderer";
import { basemapIsDark, resolveBasemap } from "./lib/basemaps";
import { dismissOfflinePrompt, loadOfflineMap, offlineArchives, offlineMap } from "./lib/offlineMap";
import { maxZoomAt } from "./lib/pack";
import { buildTableQuery, isSafeToAutoRun, queryFromEditorParams } from "./lib/host";
import { elementToPng, itemsToGeoJson, regionsToGeoJson } from "./lib/export";

type SourceKind = "selection" | "query";

interface SavedState {
  v: 1;
  config: MapConfig;
  query: string;
  source: SourceKind;
  ran: boolean;
  panelOpen: boolean;
  view?: { center: { lat: number; lng: number }; zoom: number };
}

const LARGE_RESULT = 100_000;

// ---------------------------------------------------------------------------
// State

const config = ref<MapConfig>(defaultConfig());
const dataset = shallowRef<Dataset>(emptyDataset());
const profiles = shallowRef<ColumnProfile[]>([]);
const build = shallowRef<BuildResult | null>(null);
const source = ref<SourceKind>("query");
const query = ref("");
const ran = ref(false);
const running = ref(false);
const building = ref(false);
const error = ref<string | null>(null);
const errorTitle = ref("Error");
const reason = ref("");
const appDark = ref(false);
const panelOpen = ref(true);
const tileWarning = ref(false);
const exportOpen = ref(false);
const initialized = ref(false);
const selectionNote = ref("");
const view = ref({ center: { lat: 20, lng: 0 }, zoom: 2 });
const promptClosed = ref(false);

const mapWrap = ref<HTMLElement | null>(null);
const mapEl = ref<HTMLElement | null>(null);
const themeEl = document.getElementById("app-theme") as HTMLStyleElement | null;

let renderer: MapRenderer | null = null;
let resizeObserver: ResizeObserver | null = null;
let savedView: SavedState["view"] | undefined;
let pendingFit = false;
let renderFrame = 0;

const columns = computed(() => dataset.value.columns);
const numericColumns = computed(() =>
  profiles.value.filter((p) => p.nonNull > 0 && p.numeric / p.nonNull > 0.9).map((p) => p.name)
);
const offlineReady = computed(() => !!offlineMap.world || !!offlineMap.detail);
const marksDark = computed(() => basemapIsDark(config.value.basemap, appDark.value, offlineReady.value));
const activeBasemap = computed(() => resolveBasemap(config.value.basemap, appDark.value, offlineReady.value));

// First run: offer the offline map while "Match app theme" still relies on online tiles
const showOfflinePrompt = computed(() => {
  if (!initialized.value || promptClosed.value) return false;
  const s = offlineMap.status;
  if (s !== "missing" && s !== "downloading" && s !== "saving") return false;
  return config.value.basemap === "offline-osm" || (config.value.basemap === "auto" && !offlineMap.promptDismissed);
});

// The world pack stops at zoom 6; a few levels of overzoom still look fine, past that it's mostly blank
const offlineTooCoarse = computed(() => {
  if (activeBasemap.value !== "offline-osm") return false;
  const { center } = view.value;
  const maxZoom = maxZoomAt(offlineMap.world, offlineMap.detail, center.lat, center.lng);
  return maxZoom !== null && view.value.zoom >= maxZoom + 4;
});

const model = computed<RenderModel | null>(() => {
  const b = build.value;
  if (!b) return null;
  return buildRenderModel(dataset.value, b.items, config.value, marksDark.value);
});

const hasData = computed(() => dataset.value.rows.length > 0);
const plotted = computed(() => model.value?.items.length ?? 0);
const skipped = computed(() => build.value?.skipped.length ?? 0);

const warnings = computed(() => {
  const out = [...(build.value?.warnings ?? [])];
  if (dataset.value.rows.length > LARGE_RESULT && ["points", "lines", "path"].includes(config.value.style.layer)) {
    out.push(`${dataset.value.rows.length.toLocaleString()} rows can be slow to draw individually. Heatmap or Clusters handle large results better.`);
  }
  return out;
});

const categoryToggleable = computed(
  () =>
    !!config.value.style.colorColumn &&
    ["points", "clusters", "lines"].includes(config.value.style.layer) &&
    model.value?.legend.color?.legend.type === "categories"
);

// ---------------------------------------------------------------------------
// Theme

function applyTheme(theme: AppTheme) {
  if (themeEl) themeEl.textContent = `:root { ${theme.cssString} }`;
  appDark.value = theme.type === "dark";
}

// ---------------------------------------------------------------------------
// Data

function locationColumnsExist(cfg: MapConfig, cols: string[]): boolean {
  const has = (c: string | null) => !!c && cols.includes(c);
  const l = cfg.location;
  return l.mode === "latlng" ? has(l.latColumn) && has(l.lngColumn) : has(l.column);
}

/** Drop references to columns that no longer exist. */
function sanitizeConfig(cfg: MapConfig, cols: string[]): MapConfig {
  const keep = (c: string | null) => (c && cols.includes(c) ? c : null);
  const s = cfg.style;
  const l = cfg.location;
  return {
    ...cfg,
    location: {
      ...l,
      destLatColumn: keep(l.destLatColumn),
      destLngColumn: keep(l.destLngColumn),
      countryColumn: keep(l.countryColumn),
      regionColumn: keep(l.regionColumn),
    },
    style: {
      ...s,
      sizeColumn: keep(s.sizeColumn),
      colorColumn: keep(s.colorColumn),
      labelColumn: keep(s.labelColumn),
      tooltipColumn: keep(s.tooltipColumn),
      groupColumn: keep(s.groupColumn),
      orderColumn: keep(s.orderColumn),
      valueColumn: keep(s.valueColumn),
    },
  };
}

async function setDataset(ds: Dataset, opts: { fit: boolean }) {
  dataset.value = ds;
  profiles.value = profileColumns(ds);
  const cfg = config.value;
  if (!locationColumnsExist(cfg, ds.columns)) {
    detect(cfg);
  } else {
    config.value = sanitizeConfig(cfg, ds.columns);
  }
  pendingFit = opts.fit;
  await rebuild();
}

function detect(base: MapConfig = config.value) {
  const s = suggestConfig(dataset.value, profiles.value);
  if (s) {
    config.value = sanitizeConfig(applySuggestion(base, s), dataset.value.columns);
    reason.value = s.reason;
  } else {
    config.value = sanitizeConfig(base, dataset.value.columns);
    reason.value = dataset.value.columns.length ? "No location columns detected. Pick them below." : "";
  }
}

let buildToken = 0;
async function rebuild() {
  const token = ++buildToken;
  if (!hasData.value) {
    build.value = null;
    return;
  }
  building.value = true;
  try {
    const result = await buildItems(dataset.value, config.value.location);
    if (token === buildToken) build.value = result;
  } catch (e) {
    log.error(e instanceof Error ? e : String(e));
    errorTitle.value = "Error";
    error.value = `Couldn't read locations: ${messageOf(e)}`;
  } finally {
    if (token === buildToken) building.value = false;
  }
}

function messageOf(e: unknown): string {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

async function run() {
  const q = query.value.trim();
  if (!q || running.value) return;
  running.value = true;
  error.value = null;
  try {
    const res = await runQuery(q);
    if (res.error) throw res.error;
    const results = res.results ?? [];
    const result = [...results].reverse().find((r) => r.fields && r.fields.length > 0);
    if (!result) {
      errorTitle.value = "No results";
      error.value = "The query didn't return a result set to plot.";
      return;
    }
    ran.value = true;
    // Keep the saved viewport when a restored tab re-runs its query
    await setDataset(datasetFromQueryResult(result), { fit: !savedView });
    saveState();
  } catch (e) {
    errorTitle.value = "Query failed";
    error.value = messageOf(e);
  } finally {
    running.value = false;
  }
}

function onQueryKey(e: KeyboardEvent) {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
}

function switchToQuery() {
  source.value = "query";
  saveState();
}

// ---------------------------------------------------------------------------
// Rendering

function scheduleRender() {
  cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(async () => {
    if (!renderer) return;
    const m = model.value;
    if (!m) {
      renderer.clearData();
      return;
    }
    await renderer.render(m);
    if (pendingFit) {
      pendingFit = false;
      renderer.fitTo(m);
    } else if (savedView) {
      renderer.setView(savedView.center, savedView.zoom);
      savedView = undefined;
    }
  });
}

watch(model, scheduleRender);

watch(
  () => JSON.stringify(config.value.location),
  (now, before) => {
    if (!initialized.value || now === before) return;
    pendingFit = true;
    rebuild();
  }
);

// Only the tab that saved the pack announces it; other tabs pick it up silently
watch(
  () => offlineMap.status,
  (now, before) => {
    if (now === "ready" && before === "saving") noty.success("Offline map saved").catch(() => undefined);
  }
);

function applyBasemap() {
  return renderer?.setBasemap(config.value.basemap, appDark.value, config.value.customTileUrl, offlineArchives());
}

watch(
  [() => config.value.basemap, () => config.value.customTileUrl, appDark, () => offlineMap.world?.savedAt, () => offlineMap.detail?.savedAt],
  () => {
    tileWarning.value = false;
    applyBasemap();
  }
);

// Changing the colour column resets legend filters
watch(
  () => config.value.style.colorColumn,
  () => {
    if (config.value.hiddenCategories.length) config.value.hiddenCategories = [];
  }
);

function toggleCategory(value: string) {
  const hidden = new Set(config.value.hiddenCategories);
  if (hidden.has(value)) hidden.delete(value);
  else hidden.add(value);
  config.value.hiddenCategories = [...hidden];
}

function onlyCategory(value: string) {
  const legend = model.value?.legend.color?.legend;
  if (legend?.type !== "categories") return;
  const all = legend.categories.map((c) => c.value);
  const isolated = config.value.hiddenCategories.length === all.length - 1 && !config.value.hiddenCategories.includes(value);
  config.value.hiddenCategories = isolated ? [] : all.filter((v) => v !== value);
}

// ---------------------------------------------------------------------------
// Popups & table integration

function rowTable(row: number): HTMLTableElement {
  const table = document.createElement("table");
  dataset.value.columns.forEach((col, ci) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = col;
    const td = document.createElement("td");
    const v = dataset.value.rows[row][ci];
    const text = displayValue(v);
    td.textContent = text.length > 300 ? `${text.slice(0, 300)}…` : text;
    if (v === null || v === undefined) td.className = "null";
    tr.append(th, td);
    table.append(tr);
  });
  return table;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

async function showRowsInTable(rows: number[]) {
  if (rows.length === 0) return;
  try {
    const ds = dataset.value;
    await expandTableResult([toTableResult(ds, rows, { "row #": (i) => ds.rowNumbers[i] ?? i + 1 }) as never]);
  } catch (e) {
    noty.error(`Couldn't show rows: ${messageOf(e)}`).catch(() => undefined);
  }
}

function itemPopup(item: PlotItem): HTMLElement {
  const el = document.createElement("div");
  el.className = "popup";
  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = `Row ${dataset.value.rowNumbers[item.row] ?? item.row + 1}`;
  const coords = document.createElement("span");
  coords.className = "popup-coords";
  coords.textContent = `${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}`;
  title.append(coords);
  const scroll = document.createElement("div");
  scroll.className = "popup-scroll";
  scroll.append(rowTable(item.row));
  const actions = document.createElement("div");
  actions.className = "popup-actions";
  actions.append(
    button("Show in table", () => showRowsInTable([item.row])),
    button("Copy as JSON", async () => {
      const obj: Record<string, unknown> = {};
      dataset.value.columns.forEach((c, i) => (obj[c] = toJsonValue(dataset.value.rows[item.row][i])));
      await clipboard.writeText(JSON.stringify(obj, null, 2));
      noty.success("Row copied").catch(() => undefined);
    })
  );
  el.append(title, scroll, actions);
  return el;
}

function regionPopup(region: RegionDatum): HTMLElement {
  const el = document.createElement("div");
  el.className = "popup";
  const title = document.createElement("div");
  title.className = "popup-title";
  title.textContent = region.name;
  const value = document.createElement("div");
  value.className = "popup-value";
  const strong = document.createElement("strong");
  strong.textContent = describeValue(region.value);
  const label = document.createElement("span");
  const s = config.value.style;
  label.textContent = ` ${aggregationTitle(s.valueColumn ? s.aggregation : "count", s.valueColumn).toLowerCase()} · ${region.count.toLocaleString()} row${region.count === 1 ? "" : "s"}`;
  value.append(strong, label);
  const actions = document.createElement("div");
  actions.className = "popup-actions";
  actions.append(button(`Show ${region.count.toLocaleString()} row${region.count === 1 ? "" : "s"} in table`, () => showRowsInTable(region.rows)));
  el.append(title, value, actions);
  return el;
}

function showSkipped() {
  if (build.value) showRowsInTable(build.value.skipped);
}

function showInView() {
  if (!renderer || !model.value) return;
  const m = model.value;
  const rows =
    m.layer === "regions"
      ? m.regions.filter((r) => renderer!.map.getBounds().contains([r.lat, r.lng])).flatMap((r) => r.rows)
      : renderer.itemsInView(m.items).map((i) => i.row);
  if (rows.length === 0) {
    noty.info("No rows in the current view").catch(() => undefined);
    return;
  }
  showRowsInTable([...new Set(rows)].sort((a, b) => a - b));
}

function fit() {
  if (renderer && model.value) renderer.fitTo(model.value);
}

// ---------------------------------------------------------------------------
// Export

const fileStem = () => `map-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;

async function exportPng(copy: boolean) {
  exportOpen.value = false;
  if (!mapWrap.value) return;
  try {
    const dataUrl = await elementToPng(mapWrap.value);
    if (copy) {
      await clipboard.writeImage(dataUrl);
      noty.success("Map image copied").catch(() => undefined);
    } else {
      await requestFileSave({
        data: dataUrl.replace(/^data:image\/png;base64,/, ""),
        fileName: `${fileStem()}.png`,
        encoding: "base64",
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
    }
  } catch (e) {
    noty
      .error(`Image export failed: ${messageOf(e)}. Tile servers without CORS can't be exported; try another basemap.`)
      .catch(() => undefined);
  }
}

async function exportGeoJson() {
  exportOpen.value = false;
  const m = model.value;
  if (!m) return;
  try {
    const s = config.value.style;
    const fc =
      m.layer === "regions" && m.regionKind
        ? await regionsToGeoJson(m.regions, m.regionKind, s.valueColumn ? `${s.aggregation}_${s.valueColumn}` : "count")
        : itemsToGeoJson(dataset.value, m.items, m.layer === "lines");
    await requestFileSave({
      data: JSON.stringify(fc),
      fileName: `${fileStem()}.geojson`,
      filters: [{ name: "GeoJSON", extensions: ["geojson", "json"] }],
    });
  } catch (e) {
    noty.error(`GeoJSON export failed: ${messageOf(e)}`).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Persistence

let saveTimer = 0;
let lastView: SavedState["view"];

function saveState() {
  if (!initialized.value) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const state: SavedState = {
      v: 1,
      config: JSON.parse(JSON.stringify(config.value)),
      query: query.value,
      source: source.value,
      ran: ran.value,
      panelOpen: panelOpen.value,
      view: lastView,
    };
    setViewState(state).catch(() => undefined);
    // The host re-saves the whole tab (including any plotted selection) on each call
  }, 1000);
}

watch([config, query, panelOpen], saveState, { deep: true });

watch(panelOpen, async () => {
  await nextTick();
  renderer?.invalidateSize();
});

// ---------------------------------------------------------------------------
// Startup

async function initialize() {
  try {
    applyTheme((await getAppInfo()).theme);
  } catch {
    // keep fallback theme
  }
  addNotificationListener("themeChanged", applyTheme);

  let ctx: PluginViewContext = { command: "new-map" };
  let state: SavedState | null = null;
  try {
    ctx = (await getViewContext()) ?? ctx;
  } catch {
    // older app versions
  }
  try {
    state = (await getViewState<SavedState>()) ?? null;
  } catch {
    state = null;
  }

  if (state?.config) {
    config.value = mergeConfig(state.config);
    panelOpen.value = state.panelOpen ?? true;
    savedView = state.view;
    lastView = state.view;
  }
  await loadOfflineMap();
  await applyBasemap();

  const params = (ctx.params ?? {}) as Record<string, unknown>;
  const command = ctx.command;

  if (command === "plot-selection" && state?.source !== "query") {
    source.value = "selection";
    const range = (params as { activeRange?: Parameters<typeof datasetFromRange>[0] }).activeRange;
    if (range && range.columns?.length) {
      const ds = datasetFromRange(range);
      selectionNote.value = `${ds.rows.length.toLocaleString()} row${ds.rows.length === 1 ? "" : "s"} × ${ds.columns.length} column${ds.columns.length === 1 ? "" : "s"} from the results grid`;
      initialized.value = true;
      await setDataset(ds, { fit: !savedView });
      if (ds.columns.length === 1 && !build.value?.items.length) {
        reason.value = "Only one column was selected. Select the latitude and longitude columns, or right-click the top-left corner of the grid to plot every column.";
      }
    } else {
      initialized.value = true;
      errorTitle.value = "Nothing selected";
      error.value = "Select cells in the results grid, then choose Plot on Map.";
    }
    return;
  }

  source.value = "query";
  query.value = state?.query ?? "";
  ran.value = state?.ran ?? false;
  let autoRun = false;

  if (!state) {
    if (command === "plot-query") {
      query.value = queryFromEditorParams(params);
      autoRun = !!query.value;
    } else if (command === "plot-table") {
      const entity = (params as { entity?: { name: string; schema?: string } }).entity;
      if (entity?.name) {
        let dbType: string | undefined;
        try {
          dbType = (await getConnectionInfo()).databaseType;
        } catch {
          dbType = undefined;
        }
        query.value = buildTableQuery(entity, dbType);
        autoRun = !!query.value;
        setTabTitle(`Map: ${entity.name}`).catch(() => undefined);
      }
    }
  }
  // A restored tab re-runs its query only if it ran before and is plainly read-only
  if (state && ran.value && isSafeToAutoRun(query.value)) autoRun = true;
  initialized.value = true;
  if (autoRun) await run();
}

onMounted(async () => {
  if (!mapEl.value || !mapWrap.value) return;
  renderer = new MapRenderer(mapEl.value, {
    itemPopup,
    regionPopup,
    onViewChange(center, z) {
      lastView = { center, zoom: z };
      view.value = { center, zoom: z };
      saveState();
    },
    onTileError() {
      tileWarning.value = true;
    },
  });
  resizeObserver = new ResizeObserver(() => renderer?.invalidateSize());
  resizeObserver.observe(mapWrap.value);
  window.addEventListener("click", closeExport);
  await initialize();
});

function closeExport(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest?.(".export-menu")) exportOpen.value = false;
}

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  window.removeEventListener("click", closeExport);
  renderer?.destroy();
});

function useOffline() {
  config.value.basemap = offlineReady.value ? "offline-osm" : "offline";
}

function useOnlineBasemap() {
  config.value.basemap = appDark.value ? "esri-dark-gray" : "esri-light-gray";
}

function closeOfflinePrompt() {
  promptClosed.value = true;
  if (config.value.basemap === "auto") dismissOfflinePrompt();
}

function rerunNotice() {
  return source.value === "query" && !ran.value && query.value.trim() && !hasData.value;
}
</script>

<template>
  <div class="app" :class="{ 'panel-closed': !panelOpen }">
    <!-- Source bar -->
    <div class="source-bar">
      <template v-if="source === 'query'">
        <textarea
          v-model="query"
          class="query"
          spellcheck="false"
          :rows="Math.min(6, Math.max(1, query.split('\n').length))"
          placeholder="SELECT name, latitude, longitude FROM places   (Ctrl+Enter to run)"
          @keydown="onQueryKey"
        />
        <button class="btn btn-primary" :disabled="running || !query.trim()" title="Run query (Ctrl+Enter)" @click="run">
          <Icon :name="running ? 'refresh' : 'play'" :class="{ spin: running }" />
          {{ running ? "Running" : "Run" }}
        </button>
      </template>
      <template v-else>
        <div class="selection-note">
          <Icon name="table" />
          <span>{{ selectionNote || "Selection from the results grid" }}</span>
        </div>
        <button class="btn btn-flat" title="Plot the results of a query instead" @click="switchToQuery">
          <Icon name="code" /> Use a query
        </button>
      </template>
      <button
        class="btn btn-icon btn-flat"
        :class="{ active: panelOpen }"
        :title="panelOpen ? 'Hide settings' : 'Show settings'"
        @click="panelOpen = !panelOpen"
      >
        <Icon name="tune" />
      </button>
    </div>

    <div class="main">
      <div ref="mapWrap" class="map-wrap">
        <div ref="mapEl" class="map" />

        <MapLegend
          v-if="model"
          :legend="model.legend"
          :layer="model.layer"
          :hidden="config.hiddenCategories"
          :toggleable="categoryToggleable"
          @toggle="toggleCategory"
          @only="onlyCategory"
        />

        <div class="toolbar no-export">
          <button class="btn btn-icon" title="Zoom to data" :disabled="!plotted" @click="fit"><Icon name="fit" /></button>
          <button class="btn btn-icon" title="Show rows in the current view in the table below" :disabled="!plotted" @click="showInView">
            <Icon name="table" />
          </button>
          <div class="export-menu">
            <button class="btn btn-icon" title="Export" :disabled="!plotted" @click.stop="exportOpen = !exportOpen">
              <Icon name="download" />
            </button>
            <div v-if="exportOpen" class="menu">
              <button @click="exportPng(false)"><Icon name="image" /> Save as PNG…</button>
              <button @click="exportPng(true)"><Icon name="copy" /> Copy image</button>
              <button @click="exportGeoJson"><Icon name="map" /> Save as GeoJSON…</button>
            </div>
          </div>
        </div>

        <OfflinePrompt v-if="showOfflinePrompt" @close="closeOfflinePrompt" />

        <!-- Empty / error states -->
        <div v-if="error" class="overlay no-export">
          <div class="card error">
            <Icon name="warning" :size="20" />
            <div>
              <strong>{{ errorTitle }}</strong>
              <p>{{ error }}</p>
            </div>
            <button class="btn btn-icon btn-flat" title="Dismiss" @click="error = null"><Icon name="close" /></button>
          </div>
        </div>
        <div v-else-if="initialized && !hasData && !running" class="overlay no-export">
          <div class="card intro">
            <Icon name="map" :size="22" />
            <div>
              <strong>{{ rerunNotice() ? "Run the query to load the map" : "Plot query results on a map" }}</strong>
              <p v-if="rerunNotice()">The query is saved but isn't run automatically. Press Run when ready.</p>
              <template v-else>
                <p>Write a query above that returns locations, or right-click the corner of any results grid and choose <em>Plot on Map</em>.</p>
                <p class="small">
                  Works with latitude/longitude columns, PostGIS geometry, WKT, GeoJSON, "lat, lng" text, geohashes,
                  country and US state names, city names and US ZIP codes.
                </p>
              </template>
            </div>
          </div>
        </div>
        <div v-else-if="hasData && build && !build.items.length && !building" class="overlay no-export">
          <div class="card intro">
            <Icon name="info" :size="20" />
            <div>
              <strong>No locations found</strong>
              <p>{{ reason || "None of the rows could be placed on the map." }} Choose where locations come from in the settings panel.</p>
            </div>
          </div>
        </div>
      </div>

      <aside v-show="panelOpen" class="panel">
        <SettingsPanel
          v-model="config"
          :columns="columns"
          :numeric-columns="numericColumns"
          :reason="reason"
          :dark="marksDark"
          @detect="detect()"
        />
      </aside>
    </div>

    <!-- Status bar -->
    <div class="status-bar">
      <span v-if="building" class="muted">Locating rows…</span>
      <template v-else-if="hasData">
        <span>
          <strong>{{ plotted.toLocaleString() }}</strong> of {{ dataset.rows.length.toLocaleString() }} row{{ dataset.rows.length === 1 ? "" : "s" }} plotted
        </span>
        <button v-if="skipped" class="link" title="Show rows without a usable location in the table below" @click="showSkipped">
          {{ skipped.toLocaleString() }} without a location
        </button>
        <span v-if="model?.hiddenCount" class="muted">{{ model.hiddenCount.toLocaleString() }} hidden by legend</span>
      </template>
      <span v-for="w in warnings" :key="w" class="warning" :title="w"><Icon name="warning" :size="13" /> {{ w }}</span>
      <span v-if="tileWarning" class="warning">
        <Icon name="warning" :size="13" /> Map tiles aren't loading.
        <button class="link" @click="useOffline">Use the offline {{ offlineReady ? "map" : "outlines" }}</button>
      </span>
      <span v-if="offlineTooCoarse" class="muted">
        The offline map has little detail at this zoom.
        <button class="link" @click="useOnlineBasemap">Use an online basemap</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100%;
}
.source-bar {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-color);
  background: var(--panel-bg);
}
.query {
  flex: 1;
  height: auto;
  min-height: 28px;
  padding: 5px 8px;
  resize: vertical;
  font-family: var(--font-family-mono);
  font-size: 12px;
  line-height: 16px;
  background: var(--query-editor-bg);
}
.selection-note {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  color: var(--text);
  font-size: 12px;
}
.btn-flat.active {
  background: var(--active);
}
.main {
  display: flex;
  min-height: 0;
}
.map-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}
.map {
  position: absolute;
  inset: 0;
}
.panel {
  width: 290px;
  flex: none;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
  background: var(--panel-bg);
}
.toolbar {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 800;
  display: flex;
  gap: 4px;
}
.toolbar .btn {
  background: var(--menu-bg);
  border: none;
  box-shadow: var(--menu-shadow);
}
.export-menu {
  position: relative;
}
.menu {
  position: absolute;
  right: 0;
  top: 32px;
  min-width: 180px;
  padding: 4px;
  background: var(--menu-bg);
  border-radius: 8px;
  box-shadow: var(--menu-shadow);
}
.menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 12px;
}
.menu button:hover {
  background: var(--hover);
}
.overlay {
  position: absolute;
  inset: 0;
  z-index: 900;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  padding: 24px;
}
.card {
  pointer-events: auto;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  max-width: 460px;
  padding: 14px 16px;
  background: var(--menu-bg);
  border-radius: 10px;
  box-shadow: var(--menu-shadow);
  color: var(--text);
}
.card strong {
  color: var(--text-dark);
  font-size: 13px;
}
.card p {
  margin: 4px 0 0;
  line-height: 1.45;
  font-size: 12px;
}
.card p.small {
  color: var(--text-light);
  font-size: 11px;
}
.card.error {
  color: var(--brand-danger);
}
.card.error p {
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.status-bar {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 26px;
  padding: 3px 10px;
  border-top: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  white-space: nowrap;
}
.status-bar strong {
  color: var(--text-dark);
  font-variant-numeric: tabular-nums;
}
.status-bar .muted {
  color: var(--text-light);
}
.status-bar .warning {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--brand-warning);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent);
  cursor: pointer;
  font-size: 11px;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<style>
/* Popup content is created outside Vue, so these styles are global */
.popup {
  min-width: 220px;
}
.popup-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-dark);
  margin-bottom: 6px;
  padding-right: 14px;
}
.popup-coords {
  font-weight: 400;
  font-size: 11px;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}
.popup-value {
  margin-bottom: 8px;
  color: var(--text);
}
.popup-value strong {
  font-size: 16px;
  color: var(--text-dark);
}
.popup-scroll {
  max-height: 220px;
  overflow: auto;
  margin: 0 -4px;
}
.popup table {
  border-collapse: collapse;
  width: 100%;
}
.popup th,
.popup td {
  text-align: left;
  vertical-align: top;
  padding: 3px 4px;
  border-bottom: 1px solid var(--border-color);
}
.popup th {
  font-weight: 500;
  color: var(--text-light);
  white-space: nowrap;
  width: 1%;
}
.popup td {
  color: var(--text-dark);
  word-break: break-word;
  font-variant-numeric: tabular-nums;
}
.popup td.null {
  color: var(--text-hint);
  font-style: italic;
}
.popup-actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.popup-actions .btn {
  height: 24px;
  font-size: 11px;
}
</style>
