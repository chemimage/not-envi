export function createSpectrumAreaController(deps) {
  const {
    getActive,
    spectrum,
    isHistogramSelectionTool,
    getHistogramSelectionItems,
    resolveSelectionBoundsForSpectrum,
    resolveEffectiveSelectionBounds,
    resolveSelectionBoundsList,
    listHistogramSelectionItems,
    readBandWindow,
    readBandWindowBIP,
    toFloat32,
    pointInPolygon,
    wavelengthArrayOrNull,
    fmtNoGroup
  } = deps;

  async function buildAreaAverageSpectrum(ds, selections) {
    if (!ds || !Array.isArray(selections) || !selections.length) return null;
    const valid = [];
    let totalArea = 0;
    for (const selection of selections) {
      if (!isHistogramSelectionTool(selection)) continue;
      const bounds = resolveSelectionBoundsForSpectrum(ds, selection);
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
      valid.push({ selection, bounds });
      totalArea += bounds.width * bounds.height;
    }
    if (!valid.length) return null;

    const targetSamples = 220_000;
    const sampleStep = Math.max(1, Math.ceil(Math.sqrt(totalArea / Math.max(1, targetSamples))));
    const bands = ds.meta.bands;
    const spectrumMean = new Float32Array(bands);
    const spectrumStd = new Float32Array(bands);
    let sampleCount = 0;

    for (let band = 0; band < bands; band += 1) {
      const seen = new Set();
      let sum = 0;
      let sumSq = 0;
      let count = 0;

      for (const item of valid) {
        const { selection, bounds } = item;
        const outW = Math.max(1, Math.ceil(bounds.width / sampleStep));
        const outH = Math.max(1, Math.ceil(bounds.height / sampleStep));
        let raw;
        if (ds.meta.interleave === "bip") {
          raw = await readBandWindowBIP(ds.meta, ds.ds, band, bounds.x0, bounds.y0, outW, outH, sampleStep);
        } else {
          raw = await readBandWindow(ds.meta, ds.ds, band, bounds.x0, bounds.y0, outW, outH, sampleStep);
        }
        const f32 = toFloat32(raw);
        const isShape = selection.tool === "shape" && Array.isArray(selection.points) && selection.points.length >= 3;
        for (let row = 0; row < outH; row += 1) {
          const iy = bounds.y0 + row * sampleStep;
          if (iy > bounds.y1) continue;
          for (let col = 0; col < outW; col += 1) {
            const ix = bounds.x0 + col * sampleStep;
            if (ix > bounds.x1) continue;
            if (isShape) {
              const cx = ix + (0.5 * sampleStep);
              const cy = iy + (0.5 * sampleStep);
              if (!pointInPolygon({ x: cx, y: cy }, selection.points)) continue;
            }
            const key = iy * ds.meta.samples + ix;
            if (seen.has(key)) continue;
            seen.add(key);
            const v = f32[row * outW + col];
            sum += v;
            sumSq += (v * v);
            count += 1;
          }
        }
      }

      if (count > 0) {
        const mean = sum / count;
        const variance = Math.max(0, (sumSq / count) - (mean * mean));
        spectrumMean[band] = mean;
        spectrumStd[band] = Math.sqrt(variance);
        if (!sampleCount) sampleCount = count;
      } else {
        spectrumMean[band] = Number.NaN;
        spectrumStd[band] = Number.NaN;
      }
    }

    if (!sampleCount) return null;
    return {
      yVals: spectrumMean,
      stdVals: spectrumStd,
      sampleCount,
      sampleStep,
      selectionCount: valid.length
    };
  }

  async function openSpectrumAt(ds, ix, iy, opts = {}) {
    if (!ds) return;
    const selections = getHistogramSelectionItems(ds);
    const useArea = !!(opts.forceArea || selections.length);
    if (!useArea) {
      await spectrum.openSpectrumAt(ds, ix, iy, opts);
      return;
    }

    const area = await buildAreaAverageSpectrum(ds, selections);
    if (!area || !area.yVals || !area.yVals.length) {
      await spectrum.openSpectrumAt(ds, ix, iy, opts);
      return;
    }
    const selectionBounds = resolveEffectiveSelectionBounds(ds, selections);
    const effectiveIds = new Set(selections.map((item) => item.id));
    const occluderBounds = resolveSelectionBoundsList(ds, listHistogramSelectionItems(ds))
      .filter((b) => !effectiveIds.has(b.id))
      .map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));

    const sampled = area.sampleStep > 1;
    const sampleLabel = sampled
      ? `${fmtNoGroup(area.sampleCount)} sampled px (step ${area.sampleStep})`
      : `${fmtNoGroup(area.sampleCount)} px`;
    const subLabel = `Area average (${sampleLabel}, ${fmtNoGroup(area.selectionCount)} region${area.selectionCount > 1 ? "s" : ""})`;
    await spectrum.openSpectrumAt(ds, ix, iy, {
      ...opts,
      yVals: area.yVals,
      stdVals: area.stdVals,
      xVals: wavelengthArrayOrNull(ds),
      subLabel,
      sourceType: "area",
      sourceMeta: {
        sampleCount: area.sampleCount,
        selectionCount: area.selectionCount,
        sampleStep: area.sampleStep
      },
      selectionBounds,
      selectionOccluders: occluderBounds
    });
  }

  async function openSpectrumForEffectiveArea(ds = null, anchor = null, noReposition = false) {
    const target = ds || getActive();
    if (!target) return false;
    const selections = getHistogramSelectionItems(target);
    if (!selections.length) return false;
    await openSpectrumAt(target, 0, 0, {
      clientX: Number(anchor?.clientX),
      clientY: Number(anchor?.clientY),
      pointerType: anchor?.pointerType === "touch" ? "touch" : "mouse",
      noReposition: !!noReposition,
      forceArea: true
    });
    return true;
  }

  return {
    openSpectrumAt,
    openSpectrumForEffectiveArea
  };
}
