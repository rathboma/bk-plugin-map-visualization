<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";
import { cancelDownload, downloadWorldMap, offlineMap } from "../lib/offlineMap";
import { WORLD_PACK, formatBytes } from "../lib/pack";

defineEmits<{ close: [] }>();

const size = formatBytes(WORLD_PACK.bytes);
const busy = computed(() => offlineMap.status === "downloading" || offlineMap.status === "saving");
const received = computed(() => formatBytes(offlineMap.progress * WORLD_PACK.bytes));
</script>

<template>
  <div class="offline-prompt no-export" role="dialog" aria-label="Offline map">
    <Icon name="map" :size="20" />
    <div class="body">
      <strong>Offline map</strong>
      <template v-if="busy">
        <p>{{ offlineMap.status === "saving" ? "Saving…" : `Downloading… ${received} of ${size}` }}</p>
        <div class="progress" role="progressbar" :aria-valuenow="Math.round(offlineMap.progress * 100)" aria-valuemin="0" aria-valuemax="100">
          <div :style="{ width: `${offlineMap.progress * 100}%` }" />
        </div>
        <div class="actions">
          <button class="btn btn-flat" :disabled="offlineMap.status === 'saving'" @click="cancelDownload">Cancel</button>
        </div>
      </template>
      <template v-else>
        <p>
          Download a world map built from OpenStreetMap data ({{ size }}). It's stored on this computer, so maps draw
          without an internet connection or third-party tile servers.
        </p>
        <p v-if="offlineMap.error" class="error">{{ offlineMap.error }}</p>
        <div class="actions">
          <button class="btn btn-primary" @click="downloadWorldMap">{{ offlineMap.error ? "Retry" : "Download" }}</button>
          <button class="btn btn-flat" @click="$emit('close')">Not now</button>
        </div>
        <p class="small">Also available later under Settings → Basemap.</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.offline-prompt {
  position: absolute;
  right: 10px;
  bottom: 28px;
  z-index: 850;
  display: flex;
  gap: 10px;
  align-items: flex-start;
  width: 300px;
  padding: 12px 14px;
  background: var(--menu-bg);
  border-radius: 10px;
  box-shadow: var(--menu-shadow);
  color: var(--text);
}
.body {
  flex: 1;
  min-width: 0;
}
strong {
  color: var(--text-dark);
  font-size: 13px;
}
p {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.45;
}
p.small {
  color: var(--text-light);
  font-size: 11px;
}
p.error {
  color: var(--brand-danger);
  word-break: break-word;
}
.actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.actions .btn {
  height: 26px;
  font-size: 12px;
}
.progress {
  height: 4px;
  margin-top: 8px;
  border-radius: 2px;
  background: var(--border-color);
  overflow: hidden;
}
.progress div {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
</style>
