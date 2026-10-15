import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.heat";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import type { Feature, Geometry } from "geojson";
import type { BasemapId } from "./config";
import type { PlotItem } from "./build";
import type { RegionDatum, RenderModel } from "./model";
import { heatStops } from "./model";
import { isValidTileUrl, resolveBasemap, tileBasemap } from "./basemaps";
import type { OfflineArchives, OfflineLayer } from "./offlineMap";
import { PACK_ATTRIBUTION } from "./pack";
import { loadCountryShapes, loadStateShapes, loadWorldOutline } from "./geo/regions";
import { textOn } from "./color";

declare module "leaflet" {
  // leaflet.heat has no types
  function heatLayer(
    latlngs: [number, number, number][],
    options?: { radius?: number; blur?: number; max?: number; maxZoom?: number; minOpacity?: number; gradient?: Record<number, string> }
  ): L.Layer;
}

type ItemLayer = L.Layer & { options: L.PathOptions & { item?: PlotItem; region?: RegionDatum } };

export interface RendererCallbacks {
  itemPopup(item: PlotItem): HTMLElement;
  regionPopup(region: RegionDatum): HTMLElement;
  onViewChange(center: { lat: number; lng: number }, zoom: number): void;
  onTileError(): void;
}

interface LabeledOptions extends L.CircleMarkerOptions {
  label?: string | null;
  /** "inside" for short labels (row numbers), "right" for text beside the mark */
  labelPosition?: "inside" | "right";
  labelColor?: string;
  labelHalo?: string;
  item?: PlotItem;
}

const LABEL_FONT = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 6.5;
  measureCtx.font = LABEL_FONT;
  return measureCtx.measureText(text).width;
}

type LabeledInternals = L.CircleMarker & {
  _renderer: any;
  _point: L.Point;
  _pxBounds: L.Bounds;
  _empty(): boolean;
  options: LabeledOptions;
};

/** A canvas circle marker that draws a label inside it (row numbers) or beside it. */
const LabeledCircleMarker = L.CircleMarker.extend({
  _updateBounds(this: LabeledInternals) {
    (L.CircleMarker.prototype as any)._updateBounds.call(this);
    // Text beside the mark must be inside the redraw bounds or partial canvas redraws clip it
    const { label, labelPosition } = this.options;
    if (label && labelPosition === "right" && this._pxBounds) {
      const extra = textWidth(label) + 10;
      this._pxBounds = L.bounds(this._pxBounds.min!, this._pxBounds.max!.add([extra, 0]));
    }
  },
  _updatePath(this: LabeledInternals) {
    (L.CircleMarker.prototype as any)._updatePath.call(this);
    const { label, labelPosition } = this.options;
    const r = this._renderer;
    if (!label || !r?._ctx || !r._drawing || this._empty()) return;
    const ctx: CanvasRenderingContext2D = r._ctx;
    const p = this._point;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.font = LABEL_FONT;
    ctx.textBaseline = "middle";
    if (labelPosition === "right") {
      const x = p.x + (this as any)._radius + 4;
      ctx.textAlign = "left";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.options.labelHalo ?? "rgba(255,255,255,0.9)";
      ctx.strokeText(label, x, p.y);
      ctx.fillStyle = this.options.labelColor ?? "#0b0b0b";
      ctx.fillText(label, x, p.y);
    } else {
      ctx.textAlign = "center";
      ctx.fillStyle = this.options.labelColor ?? "#fff";
      ctx.fillText(label, p.x, p.y + 0.5);
    }
    ctx.restore();
  },
}) as unknown as new (latlng: L.LatLngExpression, options: LabeledOptions) => L.CircleMarker;

/** Radius that keeps a centred label inside the circle (so canvas redraws don't clip it). */
export function radiusForLabel(label: string | null, radius: number): number {
  if (!label) return radius;
  return Math.max(radius, textWidth(label) / 2 + 4, 9);
}

function curvePoints(a: L.LatLng, b: L.LatLng, curved: boolean): L.LatLng[] {
  if (!curved) return [a, b];
  const dx = b.lng - a.lng;
  const dy = b.lat - a.lat;
  // control point offset perpendicular to the chord, 20% of its length
  const cx = (a.lng + b.lng) / 2 - dy * 0.2;
  const cy = (a.lat + b.lat) / 2 + dx * 0.2;
  const pts: L.LatLng[] = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push(L.latLng(u * u * a.lat + 2 * u * t * cy + t * t * b.lat, u * u * a.lng + 2 * u * t * cx + t * t * b.lng));
  }
  return pts;
}

export class MapRenderer {
  readonly map: L.Map;
  private canvas: L.Canvas;
  private baseLayer: L.Layer | null = null;
  private baseKey = "";
  private dataLayer: L.Layer | null = null;
  private hoverTip: L.Tooltip;
  private renderToken = 0;
  private tileErrors = 0;
  private tileLoads = 0;
  private dark = false;
  private hovered: L.Path | null = null;
  private hoveredStyle: L.PathOptions = {};
  private heatRescale: (() => void) | null = null;

  constructor(private el: HTMLElement, private cb: RendererCallbacks) {
    this.map = L.map(el, {
      worldCopyJump: true,
      minZoom: 1,
      attributionControl: true,
      preferCanvas: true,
    }).setView([20, 0], 2);
    this.map.attributionControl.setPrefix(false);
    // A generous hit tolerance: small dots are hard to hover precisely
    this.canvas = L.canvas({ padding: 0.5, tolerance: 6 });
    this.map.createPane("basemapPane");
    this.map.getPane("basemapPane")!.style.zIndex = "150";
    // Place names sit just below the data (overlayPane is 400) so they never hide marks
    const labels = this.map.createPane("labelsPane");
    labels.style.zIndex = "350";
    labels.style.pointerEvents = "none";
    this.hoverTip = L.tooltip({ direction: "top", offset: [0, -8], opacity: 1, className: "map-tip" });
    this.map.on("moveend", () => {
      const c = this.map.getCenter();
      this.cb.onViewChange({ lat: c.lat, lng: c.lng }, this.map.getZoom());
    });
  }

  invalidateSize() {
    this.map.invalidateSize();
  }

  // ---------------------------------------------------------------------------
  // Basemap

  async setBasemap(id: BasemapId, appDark: boolean, customUrl: string, offline: OfflineArchives | null = null) {
    const resolved = resolveBasemap(id, appDark, !!offline);
    const local = resolved === "offline" || resolved === "offline-osm";
    const key = [resolved, resolved === "custom" ? customUrl : "", local ? appDark : "", resolved === "offline-osm" ? offline?.key : ""].join("|");
    if (key === this.baseKey) return;
    this.baseKey = key;
    if (this.baseLayer) this.map.removeLayer(this.baseLayer);
    this.baseLayer = null;
    this.tileErrors = 0;
    this.tileLoads = 0;
    this.el.classList.toggle("offline-basemap", resolved === "offline");
    // Water colour of the white / black flavors, so edges and unloaded tiles blend in
    this.el.style.backgroundColor = resolved === "offline-osm" ? (appDark ? "#333333" : "#dcdcdc") : "";

    if (resolved === "offline-osm" && offline) {
      // Loaded on demand: only maps that use the offline basemap pay for the vector renderer
      const { leafletLayer } = await import("protomaps-leaflet");
      if (this.baseKey !== key) return;
      const vector = (pack: OfflineLayer, overlay: boolean) => {
        const [w, s, e, n] = pack.info.bounds;
        const layer = leafletLayer({
          url: pack.pmtiles,
          flavor: appDark ? "black" : "white",
          lang: navigator.language?.split("-")[0] || "en",
          maxDataZoom: pack.info.maxZoom,
          maxZoom: 19,
          bounds: overlay ? [[s, w], [n, e]] : undefined,
          pane: "basemapPane",
          attribution: PACK_ATTRIBUTION,
        });
        // The detailed area skips the background fill so the world map shows around it
        if (overlay) layer.backgroundColor = undefined;
        return layer as unknown as L.Layer;
      };
      const layers: L.Layer[] = [];
      if (offline.world) layers.push(vector(offline.world, false));
      if (offline.detail) layers.push(vector(offline.detail, true));
      this.baseLayer = L.layerGroup(layers).addTo(this.map);
      return;
    }

    if (resolved === "offline") {
      const features = await loadWorldOutline();
      if (this.baseKey !== key) return;
      const layer = L.geoJSON(features as unknown as GeoJSON.FeatureCollection, {
        pane: "basemapPane",
        interactive: false,
        style: () => ({
          color: appDark ? "#4a4f57" : "#c3c2b7",
          weight: 0.7,
          fillColor: appDark ? "#2a2e35" : "#ffffff",
          fillOpacity: 1,
        }),
      });
      layer.getAttribution = () => "Made with Natural Earth";
      this.baseLayer = layer.addTo(this.map);
      return;
    }

    const def = tileBasemap(resolved);
    const url = resolved === "custom" ? (isValidTileUrl(customUrl) ? customUrl : "") : def?.url;
    if (!url) return;
    const common: L.TileLayerOptions = {
      subdomains: def?.subdomains ?? "abc",
      maxZoom: def?.maxZoom ?? 19,
      maxNativeZoom: def?.maxNativeZoom,
      // Built-in providers send CORS headers, which PNG export needs
      crossOrigin: def ? "anonymous" : undefined,
    };
    const tiles = L.tileLayer(url, { ...common, attribution: def?.attribution ?? "" });
    tiles.on("tileload", () => this.tileLoads++);
    tiles.on("tileerror", () => {
      this.tileErrors++;
      if (this.tileErrors === 4 && this.tileLoads === 0) this.cb.onTileError();
    });
    const layers: L.Layer[] = [tiles];
    if (def?.labels) layers.push(L.tileLayer(def.labels, { ...common, pane: "labelsPane" }));
    this.baseLayer = L.layerGroup(layers).addTo(this.map);
  }

  // ---------------------------------------------------------------------------
  // Data

  async render(model: RenderModel) {
    const token = ++this.renderToken;
    this.dark = model.dark;
    let layer: L.Layer;
    switch (model.layer) {
      case "heatmap":
        layer = this.heatLayer(model);
        break;
      case "clusters":
        layer = this.clusterLayer(model);
        break;
      case "path":
        layer = this.pathLayer(model);
        break;
      case "lines":
        layer = this.linesLayer(model);
        break;
      case "regions": {
        const shapes = model.regionKind === "us-state" ? await loadStateShapes() : await loadCountryShapes();
        if (token !== this.renderToken) return;
        layer = this.regionLayer(model, shapes);
        break;
      }
      default:
        layer = this.pointLayer(model);
    }
    if (token !== this.renderToken) return;
    this.clearData();
    this.dataLayer = layer.addTo(this.map);
  }

  clearData() {
    if (this.heatRescale) this.map.off("zoomend", this.heatRescale);
    this.heatRescale = null;
    this.hoverTip.close();
    this.map.closePopup();
    if (this.dataLayer) this.map.removeLayer(this.dataLayer);
    this.dataLayer = null;
    this.hovered = null;
  }

  private restoreHover() {
    if (this.hovered) this.hovered.setStyle(this.hoveredStyle);
    this.hovered = null;
  }

  private surface() {
    return this.dark ? "#1a1a19" : "#ffffff";
  }

  private marker(
    item: PlotItem,
    model: RenderModel,
    opts: { radius?: number; label?: string | null; inside?: boolean; ring?: boolean } = {}
  ) {
    const color = model.color(item);
    const label = opts.label !== undefined ? opts.label : model.label(item);
    const inside = opts.inside ?? model.labelInside;
    const base = opts.radius ?? model.radius(item);
    return new LabeledCircleMarker([item.lat, item.lng], {
      renderer: this.canvas,
      radius: inside ? radiusForLabel(label, base) : base,
      color: this.surface(),
      weight: opts.ring === false ? 0 : 1,
      stroke: opts.ring !== false,
      fillColor: color,
      fillOpacity: label && inside ? Math.max(0.9, model.opacity) : model.opacity,
      label,
      labelPosition: inside ? "inside" : "right",
      labelColor: inside ? textOn(color) : this.dark ? "#f0efec" : "#0b0b0b",
      labelHalo: this.dark ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.9)",
      item,
    });
  }

  private shape(item: PlotItem, model: RenderModel): L.Layer {
    const color = model.color(item);
    const layer = L.geoJSON(item.geometry as Geometry, {
      style: () => ({
        renderer: this.canvas,
        color,
        weight: 2,
        opacity: Math.min(1, model.opacity + 0.15),
        fillColor: color,
        fillOpacity: model.opacity * 0.35,
      }),
      pointToLayer: (_f, latlng) => this.marker({ ...item, lat: latlng.lat, lng: latlng.lng }, model),
    });
    layer.eachLayer((l) => ((l as ItemLayer).options.item = item));
    return layer;
  }

  /** Shared hover tooltip + click popup for every layer in a group. */
  private interactive<T extends L.FeatureGroup>(group: T, model: RenderModel): T {
    group.on("mouseover", (e: L.LeafletMouseEvent & { layer?: ItemLayer }) => {
      const target = e.layer as ItemLayer | undefined;
      const item = target?.options.item;
      const region = target?.options.region;
      if (!item && !region) return;
      const content = document.createElement("div");
      const strong = document.createElement("strong");
      const detail = document.createElement("div");
      detail.className = "tip-detail";
      if (region) {
        strong.textContent = region.name;
        detail.textContent = `${Number.isFinite(region.value) ? region.value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "–"} · ${region.count.toLocaleString()} row${region.count === 1 ? "" : "s"}`;
      } else if (item) {
        const tip = model.tooltip(item);
        strong.textContent = tip.title;
        if (tip.detail) detail.textContent = tip.detail;
      }
      content.append(strong);
      if (detail.textContent) content.append(detail);
      const latlng =
        target && "getLatLng" in target && typeof (target as unknown as L.CircleMarker).getLatLng === "function"
          ? (target as unknown as L.CircleMarker).getLatLng()
          : e.latlng;
      const r = target && "getRadius" in target ? (target as unknown as L.CircleMarker).getRadius() : 0;
      this.hoverTip.options.offset = L.point(0, -r - 2);
      this.hoverTip.setLatLng(latlng).setContent(content);
      if (!this.map.hasLayer(this.hoverTip)) this.hoverTip.addTo(this.map);
      if (target && "setStyle" in target) {
        this.restoreHover();
        const path = target as unknown as L.Path;
        this.hovered = path;
        this.hoveredStyle = { weight: path.options.weight, color: path.options.color };
        // Lines lift by getting thicker; marks and regions get a contrasting outline
        path.setStyle(
          path instanceof L.Polyline && !(path instanceof L.Polygon)
            ? { weight: (path.options.weight ?? 2) + 2 }
            : { weight: 2.5, color: this.dark ? "#ffffff" : "#0b0b0b" }
        );
      }
    });
    group.on("mouseout", () => {
      this.hoverTip.close();
      this.restoreHover();
    });
    group.on("click", (e: L.LeafletMouseEvent & { layer?: ItemLayer }) => {
      const target = e.layer as ItemLayer | undefined;
      const item = target?.options.item;
      const region = target?.options.region;
      if (!item && !region) return;
      this.hoverTip.close();
      const el = region ? this.cb.regionPopup(region) : this.cb.itemPopup(item!);
      L.popup({ maxWidth: 440, minWidth: 220, maxHeight: 340, autoPanPadding: [24, 24], className: "row-popup" })
        .setLatLng(e.latlng)
        .setContent(el)
        .openOn(this.map);
    });
    return group;
  }

  private pointLayer(model: RenderModel): L.Layer {
    const layers: L.Layer[] = [];
    // Draw big bubbles first so small ones stay visible on top
    const ordered = [...model.items].sort((a, b) => model.radius(b) - model.radius(a));
    for (const item of ordered) {
      layers.push(item.geometry ? this.shape(item, model) : this.marker(item, model));
    }
    return this.interactive(L.featureGroup(layers), model);
  }

  private clusterLayer(model: RenderModel): L.Layer {
    const color = model.color(model.items[0] ?? { row: 0, lat: 0, lng: 0 });
    const group = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      maxClusterRadius: 60,
      iconCreateFunction: (cluster) => {
        const n = cluster.getChildCount();
        const size = Math.round(26 + Math.min(1, Math.log10(n) / 4) * 30);
        const el = document.createElement("div");
        el.className = "cluster-bubble";
        el.style.width = el.style.height = `${size}px`;
        el.style.background = color;
        el.style.color = textOn(color);
        el.textContent = n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
        return L.divIcon({ html: el, className: "cluster-icon", iconSize: L.point(size, size) });
      },
    });
    group.addLayers(model.items.map((item) => this.marker(item, model)));
    return this.interactive(group, model);
  }

  private heatLayer(model: RenderModel): L.Layer {
    const stops = heatStops(model.dark);
    const gradient: Record<number, string> = {};
    stops.forEach((c, i) => (gradient[0.2 + (i / (stops.length - 1)) * 0.8] = c));
    const layer = L.heatLayer(
      model.items.map((it) => [it.lat, it.lng, model.heatWeight(it)]),
      { radius: model.heatRadius, blur: model.heatBlur, max: 1, maxZoom: this.map.getZoom(), minOpacity: 0.15, gradient }
    ) as L.Layer & { setOptions(o: object): void };
    const rescale = () => layer.setOptions({ maxZoom: this.map.getZoom(), max: this.heatMax(model) });
    this.heatRescale = rescale;
    this.map.on("zoomend", rescale);
    layer.on("add", rescale);
    return layer;
  }

  /**
   * leaflet.heat sums point weights per grid cell and divides by `max`. Using a high
   * percentile of the cell sums at the current zoom keeps hot spots visible whether
   * there are 50 rows or 50,000, instead of fading out at low zooms.
   */
  private heatMax(model: RenderModel): number {
    const zoom = this.map.getZoom();
    const cell = Math.max(2, (model.heatRadius + model.heatBlur) / 2);
    const sums = new Map<string, number>();
    for (const it of model.items) {
      const p = this.map.project([it.lat, it.lng], zoom);
      const key = `${Math.floor(p.x / cell)}:${Math.floor(p.y / cell)}`;
      sums.set(key, (sums.get(key) ?? 0) + model.heatWeight(it));
    }
    const values = [...sums.values()].sort((a, b) => a - b);
    if (values.length === 0) return 1;
    const q = values[Math.min(values.length - 1, Math.floor(values.length * 0.97))];
    return Math.max(q, values[values.length - 1] * 0.05, 1e-6);
  }

  private pathLayer(model: RenderModel): L.Layer {
    const layers: L.Layer[] = [];
    for (const g of model.groups) {
      if (g.items.length > 1) {
        const line = L.polyline(
          g.items.map((it) => [it.lat, it.lng] as L.LatLngTuple),
          { renderer: this.canvas, color: g.color, weight: 3, opacity: Math.min(1, model.opacity + 0.1), interactive: false }
        );
        layers.push(line);
      }
      if (model.showPathPoints) {
        g.items.forEach((it, i) => {
          // Start and end points stand out; numbering defaults to position in the path
          const end = i === 0 || i === g.items.length - 1;
          const own = model.label(it);
          if (own) {
            layers.push(this.marker(it, model, { radius: 4, label: own }));
          } else if (end) {
            layers.push(this.marker(it, model, { radius: 7, label: i === 0 ? "S" : "E", inside: true }));
          } else {
            layers.push(this.marker(it, model, { radius: 2.5, label: null, ring: false }));
          }
        });
      }
    }
    return this.interactive(L.featureGroup(layers), model);
  }

  private linesLayer(model: RenderModel): L.Layer {
    const layers: L.Layer[] = [];
    const sorted = [...model.items].sort((a, b) => model.lineWidth(a) - model.lineWidth(b));
    for (const item of sorted) {
      if (!item.dest) continue;
      const a = L.latLng(item.lat, item.lng);
      const b = L.latLng(item.dest.lat, item.dest.lng);
      const line = L.polyline(curvePoints(a, b, model.curved), {
        renderer: this.canvas,
        color: model.color(item),
        weight: model.lineWidth(item),
        opacity: model.opacity,
      }) as unknown as ItemLayer;
      line.options.item = item;
      layers.push(line);
    }
    if (model.showPathPoints) {
      for (const item of model.items) {
        layers.push(this.marker(item, model, { radius: 3, label: null }));
        if (item.dest) {
          const dest = this.marker({ ...item, lat: item.dest.lat, lng: item.dest.lng }, model, { radius: 3, label: null });
          (dest.options as LabeledOptions).fillOpacity = 0.25;
          layers.push(dest);
        }
      }
    }
    return this.interactive(L.featureGroup(layers), model);
  }

  private regionLayer(model: RenderModel, shapes: Map<string, { feature: Feature<Geometry> }>): L.Layer {
    const layers: L.Layer[] = [];
    for (const region of model.regions) {
      const shape = shapes.get(region.key);
      if (shape) {
        const gj = L.geoJSON(shape.feature, {
          style: () => ({
            renderer: this.canvas,
            color: this.surface(),
            weight: 0.8,
            fillColor: region.color,
            fillOpacity: Math.max(0.35, model.opacity),
          }),
        });
        gj.eachLayer((l) => ((l as ItemLayer).options.region = region));
        layers.push(gj);
      } else {
        // Small countries missing from the shape set get a dot at their centroid
        const m = L.circleMarker([region.lat, region.lng], {
          renderer: this.canvas,
          radius: 6,
          color: this.surface(),
          weight: 1,
          fillColor: region.color,
          fillOpacity: 0.95,
        }) as unknown as ItemLayer;
        m.options.region = region;
        layers.push(m);
      }
    }
    return this.interactive(L.featureGroup(layers), model);
  }

  // ---------------------------------------------------------------------------
  // View

  fitTo(model: RenderModel) {
    const pts: L.LatLngTuple[] = [];
    if (model.layer === "regions") {
      model.regions.forEach((r) => pts.push([r.lat, r.lng]));
    } else {
      for (const it of model.items) {
        pts.push([it.lat, it.lng]);
        if (it.dest) pts.push([it.dest.lat, it.dest.lng]);
      }
    }
    if (pts.length === 0) return;
    if (model.layer === "regions") {
      // Shape bounds are unreliable (the Aleutians and Fiji straddle the antimeridian),
      // so fit the centroids, or the single region's own outline.
      const single = this.dataLayer instanceof L.FeatureGroup && model.regions.length === 1 ? this.dataLayer.getBounds() : null;
      const b = single && single.isValid() && single.getEast() - single.getWest() < 180 ? single : L.latLngBounds(pts);
      this.map.fitBounds(b, { padding: [48, 48], maxZoom: 6 });
      return;
    }
    const bounds = L.latLngBounds(pts);
    if (pts.length === 1 || bounds.getNorthEast().equals(bounds.getSouthWest())) {
      this.map.setView(pts[0], 11);
    } else {
      this.map.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
    }
  }

  setView(center: { lat: number; lng: number }, zoom: number) {
    this.map.setView([center.lat, center.lng], zoom, { animate: false });
  }

  /** Items whose location is inside the current viewport. */
  itemsInView(items: PlotItem[]): PlotItem[] {
    const b = this.map.getBounds();
    return items.filter((it) => b.contains([it.lat, it.lng]) || (it.dest && b.contains([it.dest.lat, it.dest.lng])));
  }

  destroy() {
    this.map.remove();
  }
}
