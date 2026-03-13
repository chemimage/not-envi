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
    areaReducer,
    pointInPolygon,
    wavelengthArrayOrNull,
    fmtNoGroup
  } = deps;

  const ABORTED = Symbol("spectrum-area-aborted");
  const ABORT_CHECK_MASK = 1023;
  const BAND_PROGRESS_UPDATE_INTERVAL = 64;
  const BAND_UI_YIELD_INTERVAL = 24;
  let nonAreaSeq = 0;
  let areaReqSeq = 0;
  let areaInFlight = false;
  let areaPending = null;
  let areaPromise = Promise.resolve();

  function isAborted(shouldAbort) {
    return !!(typeof shouldAbort === "function" && shouldAbort());
  }

  function nextFrame() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  async function yieldToUi(shouldAbort) {
    await nextFrame();
    return isAborted(shouldAbort) ? ABORTED : null;
  }

  function buildSamplePlan(ds, valid, sampleStep, shouldAbort) {
    const sampleItems = [];
    const seen = new Set();
    let sampleCount = 0;
    const rowStride = ds.meta.samples;

    for (const item of valid) {
      if (isAborted(shouldAbort)) return ABORTED;
      const { selection, bounds } = item;
      const outW = Math.max(1, Math.ceil(bounds.width / sampleStep));
      const outH = Math.max(1, Math.ceil(bounds.height / sampleStep));
      const isShape = selection.tool === "shape" && Array.isArray(selection.points) && selection.points.length >= 3;
      const sampleIndices = [];
      let loopCount = 0;

      for (let row = 0; row < outH; row += 1) {
        const iy = bounds.y0 + row * sampleStep;
        if (iy > bounds.y1) continue;
        for (let col = 0; col < outW; col += 1) {
          loopCount += 1;
          if ((loopCount & ABORT_CHECK_MASK) === 0 && isAborted(shouldAbort)) return ABORTED;
          const ix = bounds.x0 + col * sampleStep;
          if (ix > bounds.x1) continue;
          if (isShape) {
            const cx = ix + (0.5 * sampleStep);
            const cy = iy + (0.5 * sampleStep);
            if (!pointInPolygon({ x: cx, y: cy }, selection.points)) continue;
          }
          const key = iy * rowStride + ix;
          if (seen.has(key)) continue;
          seen.add(key);
          sampleIndices.push((row * outW) + col);
          sampleCount += 1;
        }
      }

      if (sampleIndices.length) {
        sampleItems.push({
          bounds,
          outW,
          outH,
          sampleIndices: Uint32Array.from(sampleIndices)
        });
      }
    }

    if (!sampleCount || !sampleItems.length) return null;
    return { sampleItems, sampleCount };
  }

  async function reduceBandValues(values, sampleIndices, shouldAbort) {
    if (isAborted(shouldAbort)) return ABORTED;
    if (!values || !sampleIndices || !sampleIndices.length) return { sum: 0, sumSq: 0, count: 0 };
    if (areaReducer && typeof areaReducer.reduce === "function") {
      try {
        const out = await areaReducer.reduce(values, sampleIndices);
        if (isAborted(shouldAbort)) return ABORTED;
        return {
          sum: Number(out?.sum) || 0,
          sumSq: Number(out?.sumSq) || 0,
          count: Number(out?.count) || 0
        };
      } catch (_err) {
        // Fallback to local reduction if worker/client path fails.
      }
    }
    let sum = 0;
    let sumSq = 0;
    const count = sampleIndices.length;
    for (let i = 0; i < count; i += 1) {
      const v = values[sampleIndices[i]];
      sum += v;
      sumSq += (v * v);
    }
    return { sum, sumSq, count };
  }

  async function buildAreaAverageSpectrum(ds, selections, options = {}) {
    const shouldAbort = options.shouldAbort;
    if (!ds || !Array.isArray(selections) || !selections.length) return null;
    const valid = [];
    let totalArea = 0;
    for (const selection of selections) {
      if (isAborted(shouldAbort)) return ABORTED;
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
    const samplePlan = buildSamplePlan(ds, valid, sampleStep, shouldAbort);
    if (samplePlan === ABORTED) return ABORTED;
    if (!samplePlan) return null;
    const { sampleItems, sampleCount } = samplePlan;
    if (typeof options.onProgress === "function") {
      await Promise.resolve(options.onProgress({ completedBands: 0, totalBands: bands }));
      if (isAborted(shouldAbort)) return ABORTED;
    }

    for (let band = 0; band < bands; band += 1) {
      if (isAborted(shouldAbort)) return ABORTED;
      let sum = 0;
      let sumSq = 0;

      for (const item of sampleItems) {
        if (isAborted(shouldAbort)) return ABORTED;
        const { bounds, outW, outH, sampleIndices } = item;
        let raw;
        if (ds.meta.interleave === "bip") {
          raw = await readBandWindowBIP(ds.meta, ds.ds, band, bounds.x0, bounds.y0, outW, outH, sampleStep);
        } else {
          raw = await readBandWindow(ds.meta, ds.ds, band, bounds.x0, bounds.y0, outW, outH, sampleStep);
        }
        if (isAborted(shouldAbort)) return ABORTED;
        const f32 = toFloat32(raw);
        const reduced = await reduceBandValues(f32, sampleIndices, shouldAbort);
        if (reduced === ABORTED) return ABORTED;
        sum += reduced.sum;
        sumSq += reduced.sumSq;
      }

      if (sampleCount > 0) {
        const mean = sum / sampleCount;
        const variance = Math.max(0, (sumSq / sampleCount) - (mean * mean));
        spectrumMean[band] = mean;
        spectrumStd[band] = Math.sqrt(variance);
      } else {
        spectrumMean[band] = Number.NaN;
        spectrumStd[band] = Number.NaN;
      }

      const completedBands = band + 1;
      if (typeof options.onProgress === "function"
        && (completedBands === bands || (completedBands % BAND_PROGRESS_UPDATE_INTERVAL) === 0)) {
        await Promise.resolve(options.onProgress({ completedBands, totalBands: bands }));
        if (isAborted(shouldAbort)) return ABORTED;
      }
      if ((completedBands % BAND_UI_YIELD_INTERVAL) === 0) {
        const yielded = await yieldToUi(shouldAbort);
        if (yielded === ABORTED) return ABORTED;
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
      nonAreaSeq += 1;
      await spectrum.openSpectrumAt(ds, ix, iy, opts);
      return;
    }
    areaPending = {
      ds,
      ix,
      iy,
      opts: { ...opts },
      reqSeq: ++areaReqSeq
    };
    if (areaInFlight) return areaPromise;

    areaInFlight = true;
    areaPromise = (async () => {
      try {
        while (areaPending) {
          const req = areaPending;
          areaPending = null;
          const seqAtStart = nonAreaSeq;
          const reqSelections = getHistogramSelectionItems(req.ds);
          const selectionCount = reqSelections.length;
          const shouldAbort = () => seqAtStart !== nonAreaSeq || req.reqSeq !== areaReqSeq;
          if (!selectionCount) {
            if (shouldAbort()) continue;
            await spectrum.openSpectrumAt(req.ds, req.ix, req.iy, req.opts);
            continue;
          }
          const selectionBounds = resolveEffectiveSelectionBounds(req.ds, reqSelections);
          const effectiveIds = new Set(reqSelections.map((item) => item.id));
          const occluderBounds = resolveSelectionBoundsList(req.ds, listHistogramSelectionItems(req.ds))
            .filter((b) => !effectiveIds.has(b.id))
            .map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
          if (spectrum && typeof spectrum.showPendingSpectrum === "function") {
            await spectrum.showPendingSpectrum(req.ds, req.ix, req.iy, {
              ...req.opts,
              subLabel: `Area average (${fmtNoGroup(selectionCount)} region${selectionCount > 1 ? "s" : ""}, computing...)`,
              footLabel: `Computing 0/${fmtNoGroup(req.ds.meta.bands)} bands`,
              placeholderText: "Computing area average...",
              sourceType: "area",
              sourceMeta: {
                sampleCount: 0,
                selectionCount,
                sampleStep: 1
              },
              selectionBounds,
              selectionOccluders: occluderBounds
            });
          }
          if (shouldAbort()) continue;
          const areaWithProgress = await buildAreaAverageSpectrum(req.ds, reqSelections, {
            shouldAbort,
            onProgress: ({ completedBands, totalBands }) => {
              if (!spectrum || typeof spectrum.updateSpectrumStatus !== "function" || shouldAbort()) return;
              spectrum.updateSpectrumStatus({
                footLabel: `Computing ${fmtNoGroup(completedBands)}/${fmtNoGroup(totalBands)} bands`,
                placeholderText: "Computing area average..."
              });
            }
          });
          if (areaPending) continue;
          if (areaWithProgress === ABORTED || shouldAbort()) continue;
          if (!areaWithProgress || !areaWithProgress.yVals || !areaWithProgress.yVals.length) {
            if (shouldAbort()) continue;
            await spectrum.openSpectrumAt(req.ds, req.ix, req.iy, req.opts);
            continue;
          }

          const sampled = areaWithProgress.sampleStep > 1;
          const sampleLabel = sampled
            ? `${fmtNoGroup(areaWithProgress.sampleCount)} sampled px (step ${areaWithProgress.sampleStep})`
            : `${fmtNoGroup(areaWithProgress.sampleCount)} px`;
          const subLabel = `Area average (${sampleLabel}, ${fmtNoGroup(areaWithProgress.selectionCount)} region${areaWithProgress.selectionCount > 1 ? "s" : ""})`;
          if (shouldAbort()) continue;
          await spectrum.openSpectrumAt(req.ds, req.ix, req.iy, {
            ...req.opts,
            yVals: areaWithProgress.yVals,
            stdVals: areaWithProgress.stdVals,
            xVals: wavelengthArrayOrNull(req.ds),
            subLabel,
            sourceType: "area",
            sourceMeta: {
              sampleCount: areaWithProgress.sampleCount,
              selectionCount: areaWithProgress.selectionCount,
              sampleStep: areaWithProgress.sampleStep
            },
            selectionBounds,
            selectionOccluders: occluderBounds
          });
        }
      } finally {
        areaInFlight = false;
      }
    })();
    return areaPromise;
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
