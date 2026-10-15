<script setup lang="ts">
// An in-page colour picker. The native <input type="color"> opens Chromium's popup, which Electron
// positions against the screen rather than the plugin's iframe, so it ends up clipped or off to the side.
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { categoricalPalette, hexToHsv, hsvToHex, normalizeHex, type Hsv } from "../lib/color";

const color = defineModel<string>({ required: true });

const props = defineProps<{
  dark: boolean;
  label: string;
}>();

const WIDTH = 220;
const MARGIN = 8;

const open = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);
const popover = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });
// Kept separately from the hex value so the hue survives dragging to white, black or gray
const hsv = ref<Hsv>(hexToHsv(color.value));
const hexText = ref(color.value);

const swatches = computed(() => categoricalPalette(props.dark));
const hueColor = computed(() => hsvToHex({ h: hsv.value.h, s: 1, v: 1 }));

watch(color, (c) => {
  if (hsvToHex(hsv.value) !== c) hsv.value = hexToHsv(c);
  if (normalizeHex(hexText.value) !== c) hexText.value = c;
});

function setHsv(next: Hsv) {
  hsv.value = next;
  color.value = hsvToHex(next);
}

function pick(hex: string) {
  hsv.value = hexToHsv(hex);
  color.value = hex;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Tracks a drag inside `el`, reporting the pointer position as 0..1 fractions of its box. */
function drag(e: PointerEvent, apply: (x: number, y: number) => void) {
  if (e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  e.preventDefault();
  el.focus();
  const move = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect();
    apply(clamp01((ev.clientX - r.left) / r.width), clamp01((ev.clientY - r.top) / r.height));
  };
  const end = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
  };
  el.setPointerCapture(e.pointerId);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  move(e);
}

const onSvDown = (e: PointerEvent) => drag(e, (x, y) => setHsv({ ...hsv.value, s: x, v: 1 - y }));
const onHueDown = (e: PointerEvent) => drag(e, (x) => setHsv({ ...hsv.value, h: x * 360 }));

function arrow(e: KeyboardEvent): [number, number] | null {
  const step = e.shiftKey ? 10 : 1;
  const d: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, step],
    ArrowDown: [0, -step],
  };
  return d[e.key] ?? null;
}

function onSvKey(e: KeyboardEvent) {
  const d = arrow(e);
  if (!d) return;
  e.preventDefault();
  setHsv({ ...hsv.value, s: clamp01(hsv.value.s + d[0] / 100), v: clamp01(hsv.value.v + d[1] / 100) });
}

function onHueKey(e: KeyboardEvent) {
  const d = arrow(e);
  if (!d) return;
  e.preventDefault();
  setHsv({ ...hsv.value, h: Math.max(0, Math.min(360, hsv.value.h + d[0] + d[1])) });
}

function onHexInput(e: Event) {
  hexText.value = (e.target as HTMLInputElement).value;
  // Apply full six-digit values while typing; three-digit shorthand waits for Enter / blur
  if (/^#?[0-9a-f]{6}$/i.test(hexText.value.trim())) pick(normalizeHex(hexText.value)!);
}

function onHexCommit() {
  const hex = normalizeHex(hexText.value);
  if (hex) pick(hex);
  hexText.value = color.value;
}

function place() {
  const t = trigger.value?.getBoundingClientRect();
  const p = popover.value;
  if (!t || !p) return;
  const height = p.offsetHeight;
  const left = Math.max(MARGIN, Math.min(t.right - WIDTH, window.innerWidth - WIDTH - MARGIN));
  let top = t.bottom + 6;
  if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, t.top - 6 - height);
  pos.value = { left, top };
}

function onOutside(e: PointerEvent) {
  const target = e.target as Node;
  if (popover.value?.contains(target) || trigger.value?.contains(target)) return;
  close();
}

function listen(on: boolean) {
  const method = on ? "addEventListener" : "removeEventListener";
  window[method]("pointerdown", onOutside as EventListener, true);
  window[method]("resize", place);
  // The settings panel scrolls; keep the popover attached to its button
  window[method]("scroll", place, true);
  window[method]("blur", onWindowBlur);
}

// Focus moved to the app outside the plugin
const onWindowBlur = () => close();

async function toggle() {
  if (open.value) {
    close();
    return;
  }
  hsv.value = hexToHsv(color.value);
  hexText.value = color.value;
  open.value = true;
  await nextTick();
  place();
  listen(true);
}

function close(refocus = false) {
  if (!open.value) return;
  open.value = false;
  listen(false);
  if (refocus) trigger.value?.focus();
}

onBeforeUnmount(() => listen(false));
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="trigger"
    :class="{ open }"
    :title="label"
    :aria-label="label"
    aria-haspopup="dialog"
    :aria-expanded="open"
    @click="toggle"
  >
    <span :style="{ background: color }" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="popover"
      class="color-popover"
      role="dialog"
      :aria-label="label"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${WIDTH}px` }"
      @keydown.esc.stop.prevent="close(true)"
    >
      <div
        class="sv"
        :style="{ backgroundColor: hueColor }"
        tabindex="0"
        role="slider"
        aria-label="Saturation and brightness"
        :aria-valuetext="`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`"
        @pointerdown="onSvDown"
        @keydown="onSvKey"
      >
        <span class="handle" :style="{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: color }" />
      </div>
      <div
        class="hue"
        tabindex="0"
        role="slider"
        aria-label="Hue"
        aria-valuemin="0"
        aria-valuemax="360"
        :aria-valuenow="Math.round(hsv.h)"
        @pointerdown="onHueDown"
        @keydown="onHueKey"
      >
        <span class="handle" :style="{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }" />
      </div>
      <div class="swatches">
        <button
          v-for="s in swatches"
          :key="s"
          type="button"
          :class="{ active: s === color }"
          :style="{ background: s }"
          :title="s"
          :aria-label="s"
          @click="pick(s)"
        />
      </div>
      <label class="hex">
        <span class="preview" :style="{ background: color }" />
        <input
          :value="hexText"
          type="text"
          spellcheck="false"
          maxlength="7"
          aria-label="Hex color"
          @input="onHexInput"
          @change="onHexCommit"
          @keydown.enter="onHexCommit"
        />
      </label>
    </div>
  </Teleport>
</template>

<style scoped>
.trigger {
  width: 28px;
  height: 28px;
  padding: 3px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
}
.trigger.open,
.trigger:focus-visible {
  outline: none;
  border-color: var(--input-highlight);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent);
}
.trigger span {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.color-popover {
  position: fixed;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  background: var(--menu-bg);
  border-radius: 8px;
  box-shadow: var(--menu-shadow);
}
.sv {
  position: relative;
  height: 130px;
  border-radius: 4px;
  background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent);
  cursor: crosshair;
  touch-action: none;
}
.hue {
  position: relative;
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(to right, #f00 0%, #ff0 16.67%, #0f0 33.33%, #0ff 50%, #00f 66.67%, #f0f 83.33%, #f00 100%);
  cursor: pointer;
  touch-action: none;
}
.sv:focus-visible,
.hue:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 70%, transparent);
  outline-offset: 2px;
}
.handle {
  position: absolute;
  width: 14px;
  height: 14px;
  border: 2px solid #fff;
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.35);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.hue .handle {
  top: 50%;
}
.swatches {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 6px;
}
.swatches button {
  aspect-ratio: 1;
  padding: 0;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.swatches button:hover,
.swatches button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--menu-bg), 0 0 0 3px var(--input-highlight);
}
.swatches button.active {
  box-shadow: 0 0 0 2px var(--menu-bg), 0 0 0 3px var(--text-dark);
}
.hex {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--radius);
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.hex input {
  font-family: var(--font-family-mono);
  text-transform: lowercase;
}
</style>
