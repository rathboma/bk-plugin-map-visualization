<script setup lang="ts">
import { computed, ref } from "vue";
import type { Legend } from "../lib/model";
import type { LayerType } from "../lib/config";
import { legendFormatter } from "../lib/scales";

const props = defineProps<{
  legend: Legend;
  layer: LayerType;
  hidden: string[];
  /** Whether clicking a category hides it */
  toggleable: boolean;
}>();

const emit = defineEmits<{ toggle: [value: string]; only: [value: string] }>();

const collapsed = ref(false);

const hiddenSet = computed(() => new Set(props.hidden));
const swatchShape = computed(() => (props.layer === "regions" ? "square" : props.layer === "path" || props.layer === "lines" ? "line" : "dot"));

const gradientCss = (stops: string[]) => `linear-gradient(to right, ${stops.join(", ")})`;

const sizeMax = computed(() => Math.max(...(props.legend.size?.entries.map((e) => e.radius) ?? [0])));

const colorFmt = computed(() => {
  const l = props.legend.color?.legend;
  if (!l || l.type === "categories") return legendFormatter([]);
  return legendFormatter(l.type === "gradient" ? [l.min, l.max] : l.classes.flatMap((c) => [c.from, c.to]));
});
const sizeFmt = computed(() => legendFormatter(props.legend.size?.entries.map((e) => e.value) ?? []));

const empty = computed(() => !props.legend.size && !props.legend.color && !props.legend.heat);

function onCategoryClick(e: MouseEvent, value: string) {
  if (!props.toggleable) return;
  // Alt/Option-click isolates one category
  if (e.altKey) emit("only", value);
  else emit("toggle", value);
}
</script>

<template>
  <button v-if="!empty && collapsed" class="legend legend-pill" title="Show legend" @click="collapsed = false" @dblclick.stop>
    Legend
  </button>
  <div v-else-if="!empty" class="legend" @wheel.stop @dblclick.stop @mousedown.stop>
    <button class="collapse no-export" title="Hide legend" @click="collapsed = true">
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M19 13H5v-2h14v2z" /></svg>
    </button>
    <section v-if="legend.color">
      <h4 :title="legend.color.title">{{ legend.color.title }}</h4>

      <template v-if="legend.color.legend.type === 'categories'">
        <ul class="categories">
          <li
            v-for="c in legend.color.legend.categories"
            :key="c.value"
            :class="{ off: hiddenSet.has(c.value), clickable: toggleable }"
            :title="toggleable ? 'Click to hide or show · Alt-click to show only this' : c.value"
            @click="onCategoryClick($event, c.value)"
          >
            <span class="swatch" :class="swatchShape" :style="{ background: c.color }" />
            <span class="cat-label">{{ c.value }}</span>
            <span class="count">{{ c.count.toLocaleString() }}</span>
          </li>
        </ul>
      </template>

      <template v-else-if="legend.color.legend.type === 'gradient'">
        <div class="ramp" :style="{ background: gradientCss(legend.color.legend.stops) }" />
        <div class="ramp-labels">
          <span>{{ colorFmt(legend.color.legend.min) }}</span>
          <span>{{ legend.color.legend.clamped ? "≥ " : "" }}{{ colorFmt(legend.color.legend.max) }}</span>
        </div>
      </template>

      <template v-else>
        <ul class="classes">
          <li v-for="(c, i) in legend.color.legend.classes" :key="i">
            <span class="swatch square" :style="{ background: c.color }" />
            <span>{{ colorFmt(c.from) }} – {{ colorFmt(c.to) }}</span>
          </li>
        </ul>
      </template>
    </section>

    <section v-if="legend.size">
      <h4 :title="legend.size.title">{{ legend.size.title }}</h4>
      <div v-if="legend.size.kind === 'circle'" class="sizes">
        <div v-for="(e, i) in legend.size.entries" :key="i" class="size-entry">
          <svg :width="sizeMax * 2 + 2" :height="sizeMax * 2 + 2">
            <circle
              :cx="sizeMax + 1"
              :cy="sizeMax * 2 + 1 - e.radius"
              :r="e.radius"
              :fill="legend.size.color"
              fill-opacity="0.35"
              :stroke="legend.size.color"
              stroke-width="1"
            />
          </svg>
          <span>{{ sizeFmt(e.value) }}</span>
        </div>
      </div>
      <div v-else class="widths">
        <div v-for="(e, i) in legend.size.entries" :key="i" class="width-entry">
          <span class="width-line" :style="{ height: `${e.radius}px`, background: legend.size.color }" />
          <span>{{ sizeFmt(e.value) }}</span>
        </div>
      </div>
    </section>

    <section v-if="legend.heat">
      <h4>{{ legend.heat.title }}</h4>
      <div class="ramp" :style="{ background: gradientCss(legend.heat.stops) }" />
      <div class="ramp-labels"><span>Low</span><span>High</span></div>
    </section>

    <p v-if="legend.note" class="note">{{ legend.note }}</p>
  </div>
</template>

<style scoped>
.legend {
  position: absolute;
  left: 10px;
  bottom: 22px;
  z-index: 800;
  max-width: 260px;
  max-height: calc(100% - 100px);
  overflow: auto;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--menu-bg) 94%, transparent);
  border-radius: 8px;
  box-shadow: var(--menu-shadow);
  font-size: 11px;
  color: var(--text);
  cursor: default;
}
.legend-pill {
  padding: 5px 10px;
  border: none;
  cursor: pointer;
  font-weight: 600;
  color: var(--text-dark);
}
.collapse {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-light);
  cursor: pointer;
}
.collapse:hover {
  background: var(--hover);
}
section:first-of-type h4 {
  padding-right: 18px;
}
section + section {
  margin-top: 10px;
}
h4 {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dark);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  margin: 0 -4px;
  border-radius: 4px;
}
li.clickable {
  cursor: pointer;
}
li.clickable:hover {
  background: var(--hover);
}
li.off {
  opacity: 0.45;
}
li.off .cat-label {
  text-decoration: line-through;
}
.cat-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dark);
}
.count {
  color: var(--text-light);
  font-variant-numeric: tabular-nums;
}
.swatch {
  flex: none;
  display: inline-block;
}
.swatch.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.swatch.square {
  width: 12px;
  height: 10px;
  border-radius: 2px;
}
.swatch.line {
  width: 14px;
  height: 3px;
  border-radius: 2px;
}
.ramp {
  height: 10px;
  border-radius: 3px;
  min-width: 160px;
}
.ramp-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-variant-numeric: tabular-nums;
}
.sizes {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.size-entry {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-variant-numeric: tabular-nums;
}
.widths {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.width-entry {
  display: flex;
  align-items: center;
  gap: 8px;
}
.width-line {
  width: 28px;
  border-radius: 2px;
  min-height: 1px;
}
.note {
  margin: 8px 0 0;
  color: var(--text-light);
  font-style: italic;
}
</style>
