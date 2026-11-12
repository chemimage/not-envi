import { resolveAnalysisColor } from "./analysis-color.js";
import { createFloat32ScratchPool } from "../core/float-scratch.js";
import { APP_CONFIG } from "./config.js";
import { ANALYSIS_BATCH_VALUES, createAnalysisPlan } from "../core/analysis-batches.js";
import { streamStatistics } from "../core/stream-statistics.js";

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
  const floatScratchPool = createFloat32ScratchPool({
    maxRetainedBytes: ANALYSIS_BATCH_VALUES * 8,
    maxRetainedBuffers: APP_CONFIG.scratch.spectrumArea.maxRetainedBuffers,
    maxRetainedElements: APP_CONFIG.scratch.spectrumArea.maxRetainedElements
  });

  const ABORTED = Symbol("spectrum-area-aborted");
  let nonAreaSeq = 0;
  let areaReqSeq = 0;
  let areaInFlight = false;
  let areaPending = null;
  let areaPromise = Promise.resolve();

  function isAborted(shouldAbort) {
    return !!(typeof shouldAbort === "function" && shouldAbort());
  }

  function isAbortError(error) {
    return error?.name === "AbortError";
  }

  async function readWindowF32(ds, band, x0, y0, outW, outH, step, options = null) {
    const length = Math.max(0, outW * outH);
    const scratch = floatScratchPool.acquire(length);
    try {
      const raw = ds.meta.interleave === "bip"
        ? await readBandWindowBIP(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch, options)
        : await readBandWindow(ds.meta, ds.ds, band, x0, y0, outW, outH, step, scratch, options);
      return {
        data: raw === scratch ? scratch : toFloat32(raw, scratch),
        release() {
          floatScratchPool.release(scratch);
        }
      };
    } catch (err) {
      floatScratchPool.release(scratch);
      throw err;
    }
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
    const finiteCounts = new Float64Array(bands);
    const plan = createAnalysisPlan(valid.map(({ selection, bounds }) => ({ selection, bounds,
      outW: Math.max(1, Math.ceil(bounds.width / sampleStep)),
      outH: Math.max(1, Math.ceil(bounds.height / sampleStep)) })), sampleStep,
    (selection, x, y) => pointInPolygon({ x, y }, selection.points));
    let sampleCount = 0;
    for (let band = 0; band < bands; band += 1) {
      if (isAborted(shouldAbort)) return ABORTED;
      let stats;
      try {
        stats = await streamStatistics({ ds, band, plan, cancelled: shouldAbort,
          readWindow: (batch, readOptions) => readWindowF32(ds, band, batch.x0, batch.y0,
            batch.outW, batch.outH, sampleStep, readOptions),
          onProgress: ({ completed, total }) => options.onProgress?.({
            completedBands: band + (total ? completed / total : 0), totalBands: bands,
            completedBatches: band * plan.batchCount + completed, totalBatches: bands * plan.batchCount
          }) });
      } catch (error) {
        if (isAbortError(error) && (isAborted(shouldAbort) || ds.ds?.closed)) return ABORTED;
        throw error;
      }
      if (isAborted(shouldAbort)) return ABORTED;
      const { sum, sumSq, count: finiteCount } = stats;
      finiteCounts[band] = finiteCount;
      sampleCount = stats.sampleCount;
      if (finiteCount > 0) {
        const mean = sum / finiteCount;
        const variance = Math.max(0, (sumSq / finiteCount) - (mean * mean));
        spectrumMean[band] = mean;
        spectrumStd[band] = Math.sqrt(variance);
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
      finiteCounts,
      complete: true,
      selectionCount: valid.length
    };
  }

  async function openSpectrumAt(ds, ix, iy, opts = {}) {
    if (!ds) return;
    opts = { ...opts, plotSlot: deps.getPanelSlot?.() || 1 };
    const selections = getHistogramSelectionItems(ds);
    const useArea = !opts.forcePoint && !!(opts.forceArea || selections.length);
    if (!useArea) {
      nonAreaSeq += 1;
      const work = deps.beginAnnotationWork?.(ds, { point: { x: ix, y: iy }, label: "Computing spectrum" });
      try {
        await spectrum.openSpectrumAt(ds, ix, iy, opts);
      } finally {
        work?.done();
      }
      return;
    }
    areaPending?.work?.done();
    areaPending = {
      ds,
      ix,
      iy,
      opts: { ...opts },
      reqSeq: ++areaReqSeq,
      work: deps.beginAnnotationWork?.(ds, { items: selections, label: "Computing spectrum" })
    };
    if (areaInFlight) return areaPromise;

    areaInFlight = true;
    areaPromise = (async () => {
      try {
        while (areaPending) {
          const req = areaPending;
          areaPending = null;
          try {
            const seqAtStart = nonAreaSeq;
            const reqSelections = getHistogramSelectionItems(req.ds);
            const selectionCount = reqSelections.length;
            const sourceColor = resolveAnalysisColor(reqSelections, req.ds.selectedAreaId);
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
                plotItems: reqSelections.map((item) => ({ ...item, points: item.points.map((p) => ({ ...p })) })),
                sourceColor,
                sourceType: "area",
                sourceMeta: {
                  sampleCount: 0,
                  selectionCount,
                  sampleStep: 1,
                  complete: false
                },
                selectionBounds,
                selectionOccluders: occluderBounds
              });
            }
            if (shouldAbort()) continue;
            const areaWithProgress = await buildAreaAverageSpectrum(req.ds, reqSelections, {
              shouldAbort,
              onProgress: ({ completedBands, totalBands, completedBatches, totalBatches }) => {
                if (!shouldAbort()) req.work?.update(completedBatches, totalBatches);
                if (!spectrum || typeof spectrum.updateSpectrumStatus !== "function" || shouldAbort()) return;
                spectrum.updateSpectrumStatus({
                  footLabel: `Computing ${fmtNoGroup(completedBatches)}/${fmtNoGroup(totalBatches)} batches (${fmtNoGroup(Math.floor(completedBands))}/${fmtNoGroup(totalBands)} bands)`,
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
              plotItems: reqSelections.map((item) => ({ ...item, points: item.points.map((p) => ({ ...p })) })),
              sourceColor,
              sourceType: "area",
              sourceMeta: {
                sampleCount: areaWithProgress.sampleCount,
                selectionCount: areaWithProgress.selectionCount,
                sampleStep: areaWithProgress.sampleStep,
                finiteCounts: areaWithProgress.finiteCounts, complete: true
              },
              selectionBounds,
              selectionOccluders: occluderBounds
            });
          } finally {
            req.work?.done();
          }
        }
      } finally {
        areaPending?.work?.done();
        areaPending = null;
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

  function cancel() {
    nonAreaSeq += 1;
    areaReqSeq += 1;
    areaPending?.work?.done();
    areaPending = null;
  }

  return {
    cancel,
    openSpectrumAt,
    openSpectrumForEffectiveArea
  };
}
