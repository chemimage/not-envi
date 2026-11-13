import { resolveSpectralUnit } from "../render/spectrum-units.js";
import { regionSourceLabel } from "./region-labels.js";

// The catalog owns small, completed plot arrays. Source geometry is retained
// only to detect edits/deletion; viewing or regrouping never reads image data.
export function createComparisonSources({ comparisons, getPanel, getDataset, deleteSources, getSelection }) {
  const pointEpoch = new Map();

  function source(ds, slot, items = [], point = null, selectedRegion = false) {
    const geometry = items.map((item) => ({ id: item.id, points: JSON.stringify(item.points) }));
    const epoch = pointEpoch.get(ds.id) || 0;
    let removed = false;
    const descriptor = { dsId: ds.id, slot, items: geometry, point };
    return {
      isSelected: () => {
        const selection = getSelection?.();
        if (!selection || selection.dsId !== ds.id || selection.slot !== slot) return false;
        if (point) return !!selection.point && selection.point.id === point.id && selection.point.x === point.x && selection.point.y === point.y;
        if (selection.point) return false;
        const ids = (selection.items || []).map(item => item.id);
        if (selectedRegion && selection.selectedAreaId != null) return geometry.some(item => item.id === selection.selectedAreaId)
          && geometry.every(item => ids.includes(item.id));
        return ids.length === geometry.length && geometry.every(item => ids.includes(item.id));
      },
      key: `${ds.id}:${slot}:${point ? `point:${point.id ?? `${point.x},${point.y}`}` : geometry.map((item) => item.id).sort((a, b) => a - b).join(",") || "whole"}`,
      label: point ? `Point (${point.x}, ${point.y})` : regionSourceLabel(items, getPanel(slot)?.annotations?.drawings || items),
      check: () => {
        if (removed || getDataset(ds.id) !== ds || ds.ds?.closed) return "deleted";
        if (point) {
          if ((pointEpoch.get(ds.id) || 0) !== epoch) return "deleted";
          if (point.id == null) return "ready";
          const panel = getPanel(slot);
          const item = panel?.datasetId === ds.id && panel.annotations?.drawings?.find(item => item.tool === "point" && item.id === point.id);
          if (!item) return "deleted";
          return item.points[0]?.x === point.x && item.points[0]?.y === point.y ? "ready" : "changed";
        }
        const panel = getPanel(slot);
        if (panel?.datasetId !== ds.id) return "deleted";
        const current = geometry.map((item) => panel.annotations?.drawings?.find((drawing) => drawing.id === item.id));
        if (current.some((item) => !item)) return "deleted";
        return current.some((item, i) => JSON.stringify(item.points) !== geometry[i].points) ? "changed" : "ready";
      },
      deleteSource: () => {
        removed = true;
        deleteSources(descriptor);
      }
    };
  }

  function publish(kind, ds, slot, items, point, detail) {
    const origin = source(ds, slot, items, point, kind !== "line");
    const scale = JSON.stringify(ds.meta.scale);
    comparisons.publish({ ...origin, ...detail, kind,
      isSelected: () => origin.isSelected() && (kind !== "histogram" || getSelection?.()?.band === detail.band),
      check: () => {
        const status = origin.check();
        return kind === "line" && status === "ready" && JSON.stringify(ds.meta.scale) !== scale ? "changed" : status;
      },
      id: kind === "line" ? `${kind}:${origin.key}`
        : kind !== "line" && detail.color && items.length ? `${kind}:${ds.id}:${slot}:color:${detail.color.toLowerCase()}:${detail.band ?? "all"}`
        : `${kind}:${origin.key}:${detail.band ?? "all"}`,
      label: `${detail.label || origin.label} · ${ds.name || "Image"}`,
      color: detail.color || items.at(-1)?.color || "#e5e7eb" });
  }

  function histogram({ ds, slot, items, stats, band, color }) {
    if (!stats?.bins?.length) return;
    publish("histogram", ds, slot, items, null, {
      compatibility: "histogram:value", band, color, approximate: stats.trueRawSamples === false,
      label: `${regionSourceLabel(items, getPanel(slot)?.annotations?.drawings || items)} · Band ${band + 1}`,
      data: { values: Float64Array.from(stats.bins), min: stats.min, max: stats.max,
        binWidth: stats.binWidth, count: stats.count }
    });
  }

  function spectrum({ ds, ix, iy, xVals, yVals, opts, plotStyle = "line", source: metadata }) {
    const unit = xVals ? resolveSpectralUnit(ds) || "spectral coordinate" : "band index";
    publish("spectrum", ds, opts.plotSlot || 1, opts.plotItems || [],
      metadata.type === "area" ? null : opts.plotPoint || { x: ix, y: iy }, {
        compatibility: `spectrum:${unit}`, color: metadata.color, approximate: metadata.sampleStep > 1, plotStyle,
        xLabel: xVals ? `Spectral coordinate (${unit})` : "Band index",
        data: { values: Float64Array.from(yVals), x: xVals ? Float64Array.from(xVals) : null }
      });
  }

  function line({ anchor, target, result }) {
    if (!result?.values?.length) return;
    const { ds, item, band } = target;
    const a = item.points[0], b = item.points.at(-1), scale = ds.meta.scale;
    const lengthUm = scale?.umPerPixelX > 0 && scale?.umPerPixelY > 0
      ? Math.hypot((b.x - a.x) * scale.umPerPixelX, (b.y - a.y) * scale.umPerPixelY) : null;
    publish("line", ds, anchor.slot, [item], null, {
      compatibility: "line:distance", band, color: item.color, approximate: result.sampled,
      label: `Line ${item.id} · Band ${band + 1}`,
      data: { values: Float64Array.from(result.values), lengthPx: result.lengthPx, lengthUm }
    });
  }

  return { histogram, spectrum, line,
    clearPoints: (dsId) => pointEpoch.set(dsId, (pointEpoch.get(dsId) || 0) + 1) };
}
