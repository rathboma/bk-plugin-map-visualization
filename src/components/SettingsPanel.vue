<script setup lang="ts">
import { computed, ref } from "vue";
import {
  LAYER_LABELS,
  LOCATION_LABELS,
  layersFor,
  type LayerType,
  type LocationMode,
  type MapConfig,
} from "../lib/config";
import { BASEMAP_OPTIONS, isValidTileUrl } from "../lib/basemaps";
import { defaultMarkColor } from "../lib/color";
import { importPackFile, offlineMap, removeDetail } from "../lib/offlineMap";
import { formatBytes } from "../lib/pack";

const config = defineModel<MapConfig>({ required: true });

const props = defineProps<{
  columns: string[];
  numericColumns: string[];
  reason: string;
  dark: boolean;
}>();

const emit = defineEmits<{ detect: [] }>();

const loc = computed(() => config.value.location);
const style = computed(() => config.value.style);

const MODES = Object.keys(LOCATION_LABELS) as LocationMode[];
const availableLayers = computed(() => layersFor(loc.value.mode));

const layer = computed<LayerType>({
  get: () => style.value.layer,
  set: (v) => (style.value.layer = v),
});

const usesSize = computed(() => ["points", "lines", "heatmap"].includes(layer.value));
const usesColor = computed(() => ["points", "lines", "clusters"].includes(layer.value));
const usesLabels = computed(() => ["points", "path"].includes(layer.value));
const usesTooltip = computed(() => layer.value !== "heatmap" && layer.value !== "regions");
const colorIsColumn = computed(() => !!style.value.colorColumn && layer.value !== "clusters");
const colorIsNumeric = computed(() => colorIsColumn.value && props.numericColumns.includes(style.value.colorColumn!));

const sizeLabel = computed(() => (layer.value === "heatmap" ? "Weight by" : layer.value === "lines" ? "Line width by" : "Size by"));

const singleColor = computed({
  get: () => style.value.color || defaultMarkColor(props.dark),
  set: (v: string) => (style.value.color = v),
});

function setMode(mode: LocationMode) {
  loc.value.mode = mode;
  if (!layersFor(mode).includes(style.value.layer)) {
    style.value.layer = layersFor(mode)[0];
  }
}

const showOffline = computed(() => ["auto", "offline-osm"].includes(config.value.basemap));
const fileInput = ref<HTMLInputElement | null>(null);

async function onPackFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await importPackFile(file);
}

const customUrlInvalid = computed(
  () => config.value.basemap === "custom" && !!config.value.customTileUrl && !isValidTileUrl(config.value.customTileUrl)
);
</script>

<template>
  <div class="settings">
    <!-- LOCATION -->
    <section>
      <header>
        <h3>Location</h3>
        <button class="btn btn-flat link" title="Re-run column detection" @click="emit('detect')">Auto-detect</button>
      </header>
      <p v-if="reason" class="hint">{{ reason }}</p>

      <label class="field">
        <span>Locations come from</span>
        <select :value="loc.mode" @change="setMode(($event.target as HTMLSelectElement).value as LocationMode)">
          <option v-for="m in MODES" :key="m" :value="m">{{ LOCATION_LABELS[m] }}</option>
        </select>
      </label>

      <template v-if="loc.mode === 'latlng'">
        <div class="row">
          <label class="field">
            <span>Latitude</span>
            <select v-model="loc.latColumn">
              <option :value="null">—</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label class="field">
            <span>Longitude</span>
            <select v-model="loc.lngColumn">
              <option :value="null">—</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>Coordinate system</span>
          <select v-model="loc.crs">
            <option value="auto">Auto-detect</option>
            <option value="wgs84">Degrees (WGS84)</option>
            <option value="mercator">Web Mercator meters (EPSG:3857)</option>
          </select>
        </label>
      </template>

      <template v-else-if="loc.mode === 'geometry'">
        <label class="field">
          <span>Column</span>
          <select v-model="loc.column">
            <option :value="null">—</option>
            <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <p class="hint">WKT, WKB / EWKB hex (PostGIS), GeoJSON, "lat, lng" text, or {lat, lng} / {x, y} objects.</p>
        <div class="row">
          <label class="field">
            <span>Axis order</span>
            <select v-model="loc.pairOrder">
              <option value="auto">Auto</option>
              <option value="latlng">lat, lng</option>
              <option value="lnglat">lng, lat</option>
            </select>
          </label>
          <label class="field">
            <span>Coordinates</span>
            <select v-model="loc.crs">
              <option value="auto">Auto</option>
              <option value="wgs84">Degrees</option>
              <option value="mercator">Web Mercator</option>
            </select>
          </label>
        </div>
        <label class="check">
          <input v-model="loc.geohash" type="checkbox" />
          <span>Values are geohashes</span>
        </label>
      </template>

      <template v-else-if="loc.mode === 'city'">
        <label class="field">
          <span>City column</span>
          <select v-model="loc.column">
            <option :value="null">—</option>
            <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <div class="row">
          <label class="field">
            <span>Country column</span>
            <select v-model="loc.countryColumn">
              <option :value="null">None</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label class="field">
            <span>State / region column</span>
            <select v-model="loc.regionColumn">
              <option :value="null">None</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span>Default country</span>
          <input v-model.trim="loc.defaultCountry" type="text" placeholder="e.g. US or Germany" />
        </label>
        <p class="hint">Matches ~34k cities (population over 15k). "Paris, TX" and "London, Ontario" style values work; ambiguous names resolve to the largest city.</p>
      </template>

      <template v-else>
        <label class="field">
          <span>Column</span>
          <select v-model="loc.column">
            <option :value="null">—</option>
            <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <p v-if="loc.mode === 'country'" class="hint">Country names, ISO 2/3-letter or numeric codes.</p>
        <p v-else-if="loc.mode === 'us-state'" class="hint">State names, postal abbreviations or FIPS codes.</p>
        <p v-else class="hint">5-digit or ZIP+4 codes, placed at the ZIP code's center.</p>
      </template>
    </section>

    <!-- DRAW AS -->
    <section>
      <header><h3>Draw as</h3></header>
      <div class="segmented">
        <button
          v-for="l in availableLayers"
          :key="l"
          :class="{ active: layer === l }"
          :title="LAYER_LABELS[l]"
          @click="layer = l"
        >
          {{ LAYER_LABELS[l].replace(/ \(.*\)/, "") }}
        </button>
      </div>
      <p class="hint">{{ LAYER_LABELS[layer] }}</p>

      <!-- Lines need a destination -->
      <template v-if="layer === 'lines'">
        <div class="row">
          <label class="field">
            <span>Destination latitude</span>
            <select v-model="loc.destLatColumn">
              <option :value="null">—</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label class="field">
            <span>Destination longitude</span>
            <select v-model="loc.destLngColumn">
              <option :value="null">—</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>
        <label class="check"><input v-model="style.curvedLines" type="checkbox" /><span>Curved lines</span></label>
        <label class="check"><input v-model="style.showPathPoints" type="checkbox" /><span>Show endpoints</span></label>
      </template>

      <template v-if="layer === 'path'">
        <div class="row">
          <label class="field">
            <span>One path per</span>
            <select v-model="style.groupColumn">
              <option :value="null">(single path)</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label class="field">
            <span>Order by</span>
            <select v-model="style.orderColumn">
              <option :value="null">Row order</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>
        <label class="check"><input v-model="style.showPathPoints" type="checkbox" /><span>Show points</span></label>
      </template>

      <template v-if="layer === 'regions'">
        <div class="row">
          <label class="field">
            <span>Value</span>
            <select v-model="style.valueColumn">
              <option :value="null">Count rows</option>
              <option v-for="c in numericColumns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label v-if="style.valueColumn" class="field">
            <span>Aggregate</span>
            <select v-model="style.aggregation">
              <option value="sum">Sum</option>
              <option value="avg">Average</option>
              <option value="min">Minimum</option>
              <option value="max">Maximum</option>
              <option value="count">Count rows</option>
            </select>
          </label>
        </div>
        <div class="row">
          <label class="field">
            <span>Scale</span>
            <select v-model="style.colorScale">
              <option value="linear">Linear</option>
              <option value="log">Logarithmic</option>
              <option value="quantile">Quantiles (5 classes)</option>
            </select>
          </label>
          <label class="field">
            <span>Palette</span>
            <select v-model="style.palette">
              <option value="blue">Sequential</option>
              <option value="diverging">Diverging</option>
            </select>
          </label>
        </div>
      </template>

      <template v-if="layer === 'heatmap'">
        <label class="field">
          <span>Radius <em>{{ style.heatRadius }}px</em></span>
          <input v-model.number="style.heatRadius" type="range" min="5" max="60" />
        </label>
        <label class="field">
          <span>Blur <em>{{ style.heatBlur }}px</em></span>
          <input v-model.number="style.heatBlur" type="range" min="1" max="40" />
        </label>
      </template>
    </section>

    <!-- STYLE -->
    <section v-if="usesSize || usesColor || usesLabels || layer === 'regions' || layer === 'path'">
      <header><h3>Style</h3></header>

      <template v-if="usesSize">
        <label class="field">
          <span>{{ sizeLabel }}</span>
          <select v-model="style.sizeColumn">
            <option :value="null">{{ layer === "heatmap" ? "Nothing (count rows)" : "Fixed size" }}</option>
            <option v-for="c in numericColumns" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <template v-if="style.sizeColumn">
          <div class="field">
            <span>Scale</span>
            <div class="segmented small">
              <button :class="{ active: style.sizeScale === 'linear' }" @click="style.sizeScale = 'linear'">Linear</button>
              <button :class="{ active: style.sizeScale === 'sqrt' }" title="Area proportional to value" @click="style.sizeScale = 'sqrt'">Square root</button>
              <button :class="{ active: style.sizeScale === 'log' }" title="Compresses large ranges" @click="style.sizeScale = 'log'">Log</button>
            </div>
          </div>
          <div v-if="layer === 'points'" class="row">
            <label class="field">
              <span>Min <em>{{ style.minRadius }}px</em></span>
              <input v-model.number="style.minRadius" type="range" min="1" max="20" />
            </label>
            <label class="field">
              <span>Max <em>{{ style.maxRadius }}px</em></span>
              <input v-model.number="style.maxRadius" type="range" min="6" max="60" />
            </label>
          </div>
          <label v-if="layer !== 'heatmap'" class="check" title="Values above the 99th percentile get the largest size">
            <input v-model="style.clampOutliers" type="checkbox" /><span>Cap outliers at the 99th percentile</span>
          </label>
        </template>
        <label v-else-if="layer === 'points'" class="field">
          <span>Size <em>{{ style.radius }}px</em></span>
          <input v-model.number="style.radius" type="range" min="2" max="24" />
        </label>
        <label v-else-if="layer === 'lines'" class="field">
          <span>Width <em>{{ style.lineWidth }}px</em></span>
          <input v-model.number="style.lineWidth" type="range" min="1" max="10" />
        </label>
      </template>

      <template v-if="usesColor || layer === 'path'">
        <div class="row align-end">
          <label v-if="layer !== 'clusters' && layer !== 'path'" class="field">
            <span>Color by</span>
            <select v-model="style.colorColumn">
              <option :value="null">Single color</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label v-if="!colorIsColumn && !(layer === 'path' && style.groupColumn)" class="field narrow">
            <span>Color</span>
            <input v-model="singleColor" type="color" />
          </label>
        </div>
        <div v-if="colorIsNumeric" class="row">
          <label class="field">
            <span>Color scale</span>
            <select v-model="style.colorScale">
              <option value="linear">Linear</option>
              <option value="log">Logarithmic</option>
              <option value="quantile">Quantiles (5 classes)</option>
            </select>
          </label>
          <label class="field">
            <span>Palette</span>
            <select v-model="style.palette">
              <option value="blue">Sequential</option>
              <option value="diverging">Diverging</option>
            </select>
          </label>
        </div>
      </template>

      <template v-if="usesLabels">
        <div class="row align-end">
          <label class="field">
            <span>Labels</span>
            <select v-model="style.labelMode">
              <option value="none">None</option>
              <option value="row">Row number</option>
              <option value="column">Column value</option>
            </select>
          </label>
          <label v-if="style.labelMode === 'column'" class="field">
            <span>Label column</span>
            <select v-model="style.labelColumn">
              <option :value="null">—</option>
              <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>
      </template>

      <label v-if="layer !== 'heatmap'" class="field">
        <span>Opacity <em>{{ Math.round(style.opacity * 100) }}%</em></span>
        <input v-model.number="style.opacity" type="range" min="0.1" max="1" step="0.05" />
      </label>
    </section>

    <section v-if="usesTooltip">
      <header><h3>Hover</h3></header>
      <label class="field">
        <span>Tooltip title</span>
        <select v-model="style.tooltipColumn">
          <option :value="null">Row number</option>
          <option v-for="c in columns" :key="c" :value="c">{{ c }}</option>
        </select>
      </label>
      <p class="hint">Click any mark to see the full row.</p>
    </section>

    <!-- BASEMAP -->
    <section>
      <header><h3>Basemap</h3></header>
      <label class="field">
        <select v-model="config.basemap">
          <option v-for="b in BASEMAP_OPTIONS" :key="b.id" :value="b.id">{{ b.label }}</option>
        </select>
      </label>
      <template v-if="config.basemap === 'custom'">
        <label class="field">
          <span>Tile URL template</span>
          <input v-model.trim="config.customTileUrl" type="text" placeholder="https://tiles.example.com/{z}/{x}/{y}.png" />
        </label>
        <p v-if="customUrlInvalid" class="hint warn">Needs an http(s) URL containing {z}, {x} and {y}.</p>
      </template>
      <p v-if="config.basemap === 'offline'" class="hint">Works without network access.</p>

      <div v-if="showOffline" class="offline">
        <span class="offline-title">
          Offline map
          <em v-if="offlineMap.world">{{ offlineMap.world.name }} · {{ formatBytes(offlineMap.world.bytes) }}</em>
        </span>
        <p v-if="offlineMap.world" class="hint">Built into the plugin. Countries, regions, cities and major roads.</p>
        <p v-else class="hint warn">The built-in map didn't load ({{ offlineMap.worldError || "unknown error" }}); online tiles are used instead.</p>

        <span class="offline-title detail-title">
          Detailed area
          <em v-if="offlineMap.detail">{{ offlineMap.detail.name }} · {{ formatBytes(offlineMap.detail.bytes) }}</em>
        </span>
        <p v-if="offlineMap.detailSaving" class="hint">Saving…</p>
        <p v-else-if="offlineMap.detail" class="hint">Drawn over the world map, with detail up to zoom {{ offlineMap.detail.maxZoom }}.</p>
        <p v-else class="hint">A Protomaps .pmtiles file, such as one city at street level, drawn over the world map.</p>
        <div class="row actions">
          <button class="btn" :disabled="offlineMap.detailSaving" @click="fileInput?.click()">Load file…</button>
          <button v-if="offlineMap.detail" class="btn btn-flat" :disabled="offlineMap.detailSaving" @click="removeDetail">Remove</button>
        </div>
        <p v-if="offlineMap.error" class="hint warn">{{ offlineMap.error }}</p>
        <input ref="fileInput" type="file" accept=".pmtiles" hidden @change="onPackFile" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  padding: 4px 12px 16px;
}
section {
  padding: 10px 0 12px;
  border-bottom: 1px solid var(--border-color);
}
section:last-child {
  border-bottom: none;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
h3 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-light);
}
.link {
  height: 22px;
  padding: 0 6px;
  color: var(--accent);
  font-size: 11px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 8px;
  min-width: 0;
  flex: 1;
}
.field > span {
  font-size: 11px;
  color: var(--text);
  display: flex;
  justify-content: space-between;
}
.field em {
  font-style: normal;
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}
.field.narrow {
  flex: none;
}
.row {
  display: flex;
  gap: 8px;
}
.row.align-end {
  align-items: flex-end;
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-light);
  line-height: 1.4;
}
.hint.warn {
  color: var(--brand-warning);
}
.offline {
  margin-top: 12px;
}
.offline-title {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--text);
}
.detail-title {
  margin-top: 12px;
}
.offline-title em {
  font-style: normal;
  color: var(--text-light);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  margin-top: 8px;
}
.actions .btn {
  height: 26px;
  font-size: 12px;
}

.segmented {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.segmented button {
  flex: 1 1 auto;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.segmented button:hover {
  background: var(--hover);
}
.segmented button.active {
  background: color-mix(in srgb, var(--accent) 16%, var(--surface));
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  color: var(--text-dark);
  font-weight: 600;
}
.segmented.small button {
  height: 24px;
  font-size: 11px;
}
</style>
