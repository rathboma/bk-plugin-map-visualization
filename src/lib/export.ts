import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Dataset } from "./dataset";
import { toJsonValue } from "./dataset";
import type { PlotItem } from "./build";
import type { RegionDatum } from "./model";
import { loadCountryShapes, loadStateShapes } from "./geo/regions";

function rowProperties(ds: Dataset, row: number): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  ds.columns.forEach((c, i) => {
    const v = toJsonValue(ds.rows[row][i]);
    props[c] = typeof v === "object" && v !== null ? JSON.parse(JSON.stringify(v)) : v;
  });
  return props;
}

export function itemsToGeoJson(ds: Dataset, items: PlotItem[], asLines: boolean): FeatureCollection {
  const features: Feature[] = items.map((it) => {
    let geometry: Geometry;
    if (asLines && it.dest) {
      geometry = { type: "LineString", coordinates: [[it.lng, it.lat], [it.dest.lng, it.dest.lat]] };
    } else {
      geometry = it.geometry ?? { type: "Point", coordinates: [it.lng, it.lat] };
    }
    return { type: "Feature", geometry, properties: rowProperties(ds, it.row) };
  });
  return { type: "FeatureCollection", features };
}

export async function regionsToGeoJson(regions: RegionDatum[], kind: "country" | "us-state", valueName: string): Promise<FeatureCollection> {
  const shapes = kind === "us-state" ? await loadStateShapes() : await loadCountryShapes();
  const features: Feature[] = regions.map((r) => ({
    type: "Feature",
    geometry: shapes.get(r.key)?.feature.geometry ?? { type: "Point", coordinates: [r.lng, r.lat] },
    properties: { code: r.key, name: r.name, [valueName]: Number.isFinite(r.value) ? r.value : null, rows: r.count },
  }));
  return { type: "FeatureCollection", features };
}

/** Render an element (map + legend) to a PNG data URL. */
export async function elementToPng(el: HTMLElement): Promise<string> {
  const { toPng } = await import("html-to-image");
  return toPng(el, {
    pixelRatio: 2,
    cacheBust: false,
    filter: (node) => {
      const cls = (node as HTMLElement).classList;
      return !cls || !(cls.contains("leaflet-control-zoom") || cls.contains("no-export"));
    },
  });
}
