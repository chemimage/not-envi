import { clamp } from "../core/utils.js";
import { resolveRasterSampling } from "./raster-geometry.js";
import { resolveDisplayPanelBand } from "../app/display-panels.js";
import { createFloat32ScratchPool } from "../core/float-scratch.js";
import { APP_CONFIG } from "../app/config.js";
import {
  clearBaseCanvases,
  drawThumbnailOnlyPreview,
  drawCachedScreenPreview,
  drawOverlayCachedPreview,
  isStableCompositeRaster,
  isStableRaster,
  tintCanvas,
  updatePanelRasterCache,
  updateScreenPreviewCache,
  withPanelView
} from "./preview-cache.js";
import {
  getThreeBandDisplayMode,
  isThreeBandColorMode,
  resolveThreeBandChannelOrder
} from "../app/three-band-display.js";

export function createRenderer(deps) {
  const {
    state,
    els,
    now,
    setStatus,
    getActive,
    getActivePanel,
    getVisibleDatasetPanels,
    getDisplayCompositionMode,
    getPanelLayoutDevice,
    getBandSettings,
    resolveDisplayRange,
    initWebGPU,
    gpuSupported,
    gpuRender,
    cpuRenderGray,
    cpuRenderColor,
    buildGrayCanvas,
    buildColorCanvas,
    drawCanvasToViewport,
    tryRasterFromPyramid,
    readBandWindow,
    readBandWindowBIP,
    toFloat32,
    clampView,
    syncRangeInputsFromSettings,
    drawOverlays,
    updatePerf,
    renderThumbnail,
    ensureDatasetPreviewOverview,
    updateHud,
    ensureViewHistogram
  } = deps;

  function listVisiblePanels() {
    if (typeof getVisibleDatasetPanels === "function") {
      const visible = getVisibleDatasetPanels();
      if (Array.isArray(visible)) return visible;
    }
    const ds = getActive();
    if (!ds) return [];
    return [{ panel: (typeof getActivePanel === "function" ? (getActivePanel() || { slot: 1 }) : { slot: 1 }), dataset: ds }];
  }

  function compositionMode() {
    return (typeof getDisplayCompositionMode === "function")
      ? (getDisplayCompositionMode() || "split")
      : "split";
  }

  function isOverlayComposition(visible = null) {
    const entries = Array.isArray(visible) ? visible : listVisiblePanels();
    return compositionMode() === "overlay" && entries.length > 1;
  }

  function activePanelInfo() {
    if (typeof getActivePanel === "function") return getActivePanel() || null;
    const visible = listVisiblePanels();
    return visible[0]?.panel || null;
  }

  function panelLayout() {
    if (typeof getPanelLayoutDevice === "function") {
      const layout = getPanelLayoutDevice();
      if (Array.isArray(layout)) return layout;
    }
    return [{ slot: 1, x: 0, y: 0, w: els.cpuCanvas.width || 1, h: els.cpuCanvas.height || 1 }];
  }

  function overlayColorForSlot(slot) {
    return Number(slot) === 2 ? "rgb(251 146 60)" : "rgb(103 232 249)";
  }

  function renderPriority(entry, activeSlot) {
    const slot = Number(entry?.panel?.slot) || 1;
    return {
      activeRank: slot === Number(activeSlot) ? 0 : 1,
      slot
    };
  }

  function resolvePanelBand(panel, ds) {
    return resolveDisplayPanelBand(panel, ds);
  }

  const floatScratchPool = createFloat32ScratchPool({
    maxRetainedBuffers: APP_CONFIG.scratch.render.maxRetainedBuffers,
    maxRetainedElements: APP_CONFIG.scratch.render.maxRetainedElements
  });

  function getStableRenderKey(ds, panelSlot) {
    const slot = Number(panelSlot) || 1;
    const map = ds?.__stableRenderKeys;
    return map && typeof map.get === "function" ? (map.get(slot) || null) : null;
  }

  function getPanelRequestKey(ds, panelSlot) {
    const slot = Number(panelSlot) || 1;
    const map = ds?.__panelRenderRequests;
    return map && typeof map.get === "function" ? (map.get(slot) || null) : null;
  }

  function setPanelRequestKey(ds, panelSlot, requestKey) {
    if (!ds) return;
    if (!ds.__panelRenderRequests || typeof ds.__panelRenderRequests.get !== "function") {
      ds.__panelRenderRequests = new Map();
    }
    const slot = Number(panelSlot) || 1;
    if (requestKey) ds.__panelRenderRequests.set(slot, requestKey);
    else ds.__panelRenderRequests.delete(slot);
  }

  function formatViewCoord(value) {
    const num = Number(value) || 0;
    return Number.isFinite(num) ? num.toFixed(4) : "0.0000";
  }

  function formatViewScale(value) {
    const num = Number(value) || 0;
    return Number.isFinite(num) ? num.toFixed(6) : "0.000000";
  }

  function buildViewportRenderKey(ds, panelSlot, viewportW, viewportH) {
    return `${Number(panelSlot) || 1}|${formatViewCoord(ds?.view?.x)}|${formatViewCoord(ds?.view?.y)}|${formatViewScale(ds?.view?.scale)}|${Math.round(Number(viewportW) || 0)}x${Math.round(Number(viewportH) || 0)}`;
  }

  function buildPanelRequestKey(ds, panelSlot, modeKey, viewportW, viewportH) {
    return `${String(modeKey || "")}|${buildViewportRenderKey(ds, panelSlot, viewportW, viewportH)}`;
  }

  function isPanelRequestCurrent(ds, panelSlot, requestKey) {
    return getPanelRequestKey(ds, panelSlot) === requestKey;
  }

  function getPanelInFlightMap(ds) {
    if (!ds.__panelInFlightReads || typeof ds.__panelInFlightReads.get !== "function") {
      ds.__panelInFlightReads = new Map();
    }
    return ds.__panelInFlightReads;
  }

  function getPanelRefineState(ds, panelSlot) {
    const slot = Number(panelSlot) || 1;
    const map = ds?.__panelRefineStates;
    return map && typeof map.get === "function" ? (map.get(slot) || null) : null;
  }

  function setPanelRefineState(ds, panelSlot, stateValue) {
    if (!ds) return;
    if (!stateValue && (!ds.__panelRefineStates || typeof ds.__panelRefineStates.get !== "function")) {
      return;
    }
    if (!ds.__panelRefineStates || typeof ds.__panelRefineStates.get !== "function") {
      ds.__panelRefineStates = new Map();
    }
    const slot = Number(panelSlot) || 1;
    if (stateValue) ds.__panelRefineStates.set(slot, stateValue);
    else ds.__panelRefineStates.delete(slot);
  }

  function getForcedFullRenderKey(ds, panelSlot) {
    const slot = Number(panelSlot) || 1;
    const map = ds?.__panelForcedFullRenderKeys;
    return map && typeof map.get === "function" ? (map.get(slot) || null) : null;
  }

  function setForcedFullRenderKey(ds, panelSlot, renderKey) {
    if (!ds) return;
    if (!renderKey && (!ds.__panelForcedFullRenderKeys || typeof ds.__panelForcedFullRenderKeys.get !== "function")) {
      return;
    }
    if (!ds.__panelForcedFullRenderKeys || typeof ds.__panelForcedFullRenderKeys.get !== "function") {
      ds.__panelForcedFullRenderKeys = new Map();
    }
    const slot = Number(panelSlot) || 1;
    if (renderKey) ds.__panelForcedFullRenderKeys.set(slot, renderKey);
    else ds.__panelForcedFullRenderKeys.delete(slot);
  }

  async function getOrStartPanelRead(ds, panelSlot, requestKey, loader) {
    const slot = Number(panelSlot) || 1;
    const inflightMap = getPanelInFlightMap(ds);
    const existing = inflightMap.get(slot);
    if (existing && existing.requestKey === requestKey && existing.promise) {
      return existing.promise;
    }
    let promise;
    try {
      promise = Promise.resolve(loader());
    } catch (err) {
      promise = Promise.reject(err);
    }
    const entry = {
      requestKey,
      promise
    };
    inflightMap.set(slot, entry);
    try {
      return await entry.promise;
    } finally {
      if (inflightMap.get(slot) === entry) inflightMap.delete(slot);
    }
  }

  function setStableRenderKey(ds, panelSlot, renderKey) {
    if (!ds) return;
    if (!ds.__stableRenderKeys || typeof ds.__stableRenderKeys.get !== "function") {
      ds.__stableRenderKeys = new Map();
    }
    const slot = Number(panelSlot) || 1;
    if (renderKey) ds.__stableRenderKeys.set(slot, renderKey);
    else ds.__stableRenderKeys.delete(slot);
  }

  function ensureRenderStats(ds) {
    if (!ds.renderStats) {
      ds.renderStats = {
        pyramidAttempts: 0,
        pyramidHits: 0,
        pyramidMisses: 0,
        directReads: 0,
        directPixels: 0,
        directReadMs: 0
      };
    }
    return ds.renderStats;
  }

  function coarsenSamplingGeometry(geom, factor) {
    const f = Math.max(1, Math.floor(Number(factor) || 1));
    if (f <= 1) return geom;
    const rasterW = Math.max(1, Math.ceil(geom.rasterW / f));
    const rasterH = Math.max(1, Math.ceil(geom.rasterH / f));
    const colStart = Math.floor((Number(geom.colStart) || 0) / f);
    const rowStart = Math.floor((Number(geom.rowStart) || 0) / f);
    const validW = Math.max(0, Math.ceil((Number(geom.validW) || 0) / f));
    const validH = Math.max(0, Math.ceil((Number(geom.validH) || 0) / f));
    const step = Math.max(1, (Number(geom.step) || 1) * f);
    const colEnd = validW > 0 ? (colStart + validW - 1) : (colStart - 1);
    const rowEnd = validH > 0 ? (rowStart + validH - 1) : (rowStart - 1);
    return {
      ...geom,
      step,
      rasterW,
      rasterH,
      colStart,
      colEnd,
      rowStart,
      rowEnd,
      validW,
      validH,
      srcX0: (Number(geom.x0) || 0) + (colStart * step),
      srcY0: (Number(geom.y0) || 0) + (rowStart * step)
    };
  }

  function resolveAdaptivePreviewFactor(ds, band, eff, geom, panelSlot, viewportW, viewportH, options = null) {
    const renderKey = buildViewportRenderKey(ds, panelSlot, viewportW, viewportH);
    const stableRenderKey = getStableRenderKey(ds, panelSlot);
    const work = options?.work || (
      typeof ds?.ds?.estimateReadWork === "function"
        ? ds.ds.estimateReadWork(ds.meta, band, geom.srcX0, geom.srcY0, geom.validW, geom.validH, geom.step)
        : null
    );
    const sparseRawMultiplier = Math.max(1, Math.floor(Number(options?.sparseRawMultiplier) || 1));
    const readMultiplier = Math.max(1, Math.floor(Number(options?.readMultiplier) || 1));
    if (
      eff >= 1
      || stableRenderKey === renderKey
      || !work
    ) {
      return { factor: 1, renderKey, stableRenderKey, work };
    }
    const stagedRefine = getPanelRefineState(ds, panelSlot);
    const stagedLimit = stagedRefine && stagedRefine.renderKey === renderKey
      ? Math.max(1, Math.floor(Number(stagedRefine.maxFactor) || 1))
      : null;
    if (getForcedFullRenderKey(ds, panelSlot) === renderKey && stagedLimit == null) {
      return { factor: 1, renderKey, stableRenderKey, stagedLimit, work };
    }
    let factor = 1;
    if (Number(work?.previewFactor) > 1) {
      factor = Math.max(factor, Math.ceil(Number(work.previewFactor) || 1));
    }
    if (work?.sparseRaw && (Number(work.spanReads) * sparseRawMultiplier) > APP_CONFIG.render.previewMaxSparseSpans) {
      factor = Math.max(
        factor,
        Math.ceil((Number(work.spanReads) * sparseRawMultiplier) / APP_CONFIG.render.previewMaxSparseSpans)
      );
    }
    if (
      work?.nativeJpeg
      && Number(work.scaledDecodePixels) > (APP_CONFIG.render.previewMaxScaledDecodePixels || 0)
    ) {
      factor = Math.max(factor, Math.ceil(Math.sqrt(
        Number(work.scaledDecodePixels) / APP_CONFIG.render.previewMaxScaledDecodePixels
      )));
    }
    if (
      Number(APP_CONFIG.render.previewMaxReadBytes) > 0
      && Number(work?.estimatedBytes) > 0
      && (Number(work.estimatedBytes) * readMultiplier) > Number(APP_CONFIG.render.previewMaxReadBytes)
    ) {
      factor = Math.max(
        factor,
        Math.ceil((Number(work.estimatedBytes) * readMultiplier) / Number(APP_CONFIG.render.previewMaxReadBytes))
      );
    }
    factor = clamp(Math.max(1, factor), 1, APP_CONFIG.render.previewMaxFactor);
    if (stagedLimit != null) factor = Math.min(factor, stagedLimit);
    return { factor, renderKey, stableRenderKey, stagedLimit, work };
  }

  function applyApproximateRefineState(ds, panelSlot, raster, compositeRaster) {
    const currentRenderKey = raster?.renderKey || compositeRaster?.renderKey || null;
    const currentFactor = Math.max(
      1,
      Number(raster?.refineFactor) || 1,
      Number(compositeRaster?.refineFactor) || 1
    );
    const approximate = !!(raster?.approximate || compositeRaster?.approximate);
    if (!approximate) {
      if (currentRenderKey && getForcedFullRenderKey(ds, panelSlot) === currentRenderKey) {
        setForcedFullRenderKey(ds, panelSlot, null);
      }
      setPanelRefineState(ds, panelSlot, null);
      return false;
    }

    if (currentRenderKey && currentFactor > 1) {
      const nextFactor = Math.max(1, Math.ceil(currentFactor / 2));
      setPanelRefineState(ds, panelSlot, {
        renderKey: currentRenderKey,
        maxFactor: nextFactor
      });
      setForcedFullRenderKey(ds, panelSlot, null);
      return true;
    }

    if (currentRenderKey) setForcedFullRenderKey(ds, panelSlot, currentRenderKey);
    return true;
  }

  async function readRasterDirect(ds, band, eff, viewportW, viewportH) {
    const t0 = now();
    let approximate = false;
    const panelSlot = Number(ds.__renderPanelSlot) || 1;
    let geom = resolveRasterSampling(ds, viewportW, viewportH, eff);
    const { factor: previewFactor, renderKey } = resolveAdaptivePreviewFactor(ds, band, eff, geom, panelSlot, viewportW, viewportH);
    if (previewFactor > 1) {
      geom = coarsenSamplingGeometry(geom, previewFactor);
      approximate = true;
    }
    const {
      step,
      rasterW,
      rasterH,
      colStart,
      rowStart,
      validW,
      validH,
      srcX0,
      srcY0
    } = geom;
    const out = new Float32Array(rasterW * rasterH);
    const fullCoverage = colStart === 0 && rowStart === 0 && validW === rasterW && validH === rasterH;
    if (!fullCoverage) out.fill(Number.NaN);

    if (validW > 0 && validH > 0) {
      const scratch = fullCoverage ? out : floatScratchPool.acquire(validW * validH);
      try {
        let raw;
        if (ds.meta.interleave === "bip") {
          raw = await readBandWindowBIP(ds.meta, ds.ds, band, srcX0, srcY0, validW, validH, step, scratch);
        } else {
          raw = await readBandWindow(ds.meta, ds.ds, band, srcX0, srcY0, validW, validH, step, scratch);
        }
        const src = raw === scratch ? scratch : toFloat32(raw, scratch);
        if (fullCoverage) {
          if (src !== out) out.set(src.subarray(0, out.length), 0);
        } else {
          for (let r = 0; r < validH; r += 1) {
            const srcOff = r * validW;
            const dstOff = (rowStart + r) * rasterW + colStart;
            out.set(src.subarray(srcOff, srcOff + validW), dstOff);
          }
        }
      } finally {
        if (!fullCoverage) floatScratchPool.release(scratch);
      }
    }

    const stats = ensureRenderStats(ds);
    stats.directReads += 1;
    stats.directPixels += rasterW * rasterH;
    stats.directReadMs += now() - t0;
    return {
      band,
      dataF32: out,
      w: rasterW,
      h: rasterH,
      source: "direct",
      level: 0,
      step,
      x0: ds.view.x,
      y0: ds.view.y,
      approximate,
      renderKey,
      refineFactor: previewFactor
    };
  }

  async function readRasterForBand(ds, band, eff, viewportW, viewportH) {
    const stats = ensureRenderStats(ds);
    stats.pyramidAttempts += 1;
    let raster = await tryRasterFromPyramid(ds, band, eff, viewportW, viewportH);
    if (raster) {
      stats.pyramidHits += 1;
    }
    if (!raster) {
      stats.pyramidMisses += 1;
      setStatus("reading…", "warn");
      raster = await readRasterDirect(ds, band, eff, viewportW, viewportH);
    }
    return raster;
  }

  function packCompositeBandsToRasters(sourceBands, composite, geom, ds, approximate, renderKey, partial = false, refineFactor = 1) {
    if (!composite?.bands || composite.bands.length < 3) return null;
    const {
      step,
      rasterW,
      rasterH,
      colStart,
      rowStart,
      validW,
      validH
    } = geom;
    const fullCoverage = colStart === 0 && rowStart === 0 && validW === rasterW && validH === rasterH;
    return sourceBands.map((band) => {
      const out = new Float32Array(rasterW * rasterH);
      if (!fullCoverage || partial) out.fill(Number.NaN);
      const src = composite.bands[band];
      if (fullCoverage) {
        out.set(src.subarray(0, Math.min(out.length, src.length)), 0);
      } else {
        for (let r = 0; r < validH; r += 1) {
          const srcOff = r * validW;
          const dstOff = (rowStart + r) * rasterW + colStart;
          out.set(src.subarray(srcOff, srcOff + validW), dstOff);
        }
      }
      return {
        band,
        dataF32: out,
        w: rasterW,
        h: rasterH,
        source: "direct",
        level: 0,
        step,
        x0: ds.view.x,
        y0: ds.view.y,
        partial,
        approximate,
        renderKey,
        refineFactor
      };
    });
  }

  function buildColorChannelParams(ds, compositeRaster) {
    return compositeRaster.channelBands.map((channelBand) => {
      const channelSettings = getBandSettings(ds, channelBand);
      const channelRange = resolveDisplayRange(ds, channelBand, compositeRaster.rasterByBand.get(channelBand).dataF32);
      return {
        minVal: channelRange.minVal,
        maxVal: channelRange.maxVal,
        brightness: clamp(channelSettings.brightness ?? 0, -1, 1),
        gain: clamp(channelSettings.gain ?? 1, 0.0, 4.0),
        contrast: clamp(channelSettings.contrast ?? 1, 0.1, 3.0)
      };
    });
  }

  function buildCompositeCanvas(ds, compositeRaster, opts = null) {
    if (!compositeRaster) return null;
    const channelRasters = compositeRaster.channelBands.map((channelBand) => compositeRaster.rasterByBand.get(channelBand));
    const channelParams = buildColorChannelParams(ds, compositeRaster);
    return buildColorCanvas(channelRasters, channelParams, opts || undefined);
  }

  async function readCompositeRaster(ds, eff, viewportW, viewportH, options = null) {
    const mode = getThreeBandDisplayMode(ds);
    const sourceBands = [0, 1, 2];
    const channelBands = resolveThreeBandChannelOrder(mode);
    let rasters = null;
    if (
      typeof ds?.ds?.readCompositeWindow === "function"
      && typeof ds?.ds?.supportsCompositeWindow === "function"
      && ds.ds.supportsCompositeWindow()
    ) {
      const panelSlot = Number(ds.__renderPanelSlot) || 1;
      let geom = resolveRasterSampling(ds, viewportW, viewportH, eff);
      let approximate = false;
      const compositeWork = typeof ds?.ds?.estimateCompositeReadWork === "function"
        ? ds.ds.estimateCompositeReadWork(ds.meta, geom.srcX0, geom.srcY0, geom.validW, geom.validH, geom.step, sourceBands)
        : (
          typeof ds?.ds?.estimateReadWork === "function"
            ? ds.ds.estimateReadWork(ds.meta, 0, geom.srcX0, geom.srcY0, geom.validW, geom.validH, geom.step)
            : null
        );
      const {
        factor: previewFactor,
        renderKey
      } = resolveAdaptivePreviewFactor(ds, 0, eff, geom, panelSlot, viewportW, viewportH, {
        work: compositeWork,
        sparseRawMultiplier: sourceBands.length,
        readMultiplier: (typeof ds?.ds?.estimateCompositeReadWork === "function") ? 1 : sourceBands.length
      });
      if (previewFactor > 1) {
        geom = coarsenSamplingGeometry(geom, previewFactor);
        approximate = true;
      }
      const {
        step,
        rasterW,
        rasterH,
        colStart,
        rowStart,
        validW,
        validH,
        srcX0,
        srcY0
      } = geom;
      if (validW > 0 && validH > 0) {
        setStatus("reading…", "warn");
        const t0 = now();
        const composite = await ds.ds.readCompositeWindow(ds.meta, srcX0, srcY0, validW, validH, step, {
          cancelled: typeof options?.cancelled === "function" ? options.cancelled : null,
          onProgress: typeof options?.onPartial === "function"
            ? async (partialComposite) => {
              const partialRasters = packCompositeBandsToRasters(
                sourceBands,
                partialComposite,
                geom,
                ds,
                true,
                renderKey,
                true,
                previewFactor
              );
              if (!partialRasters) return;
              await options.onPartial({
                mode,
                channelBands,
                rasterByBand: new Map(partialRasters.map((raster) => [raster.band, raster])),
                partial: true,
                approximate: true,
                renderKey,
                refineFactor: previewFactor
              });
            }
            : null
        });
        if (!composite) return null;
        if (composite?.bands?.length === 3) {
          rasters = packCompositeBandsToRasters(sourceBands, composite, geom, ds, approximate, renderKey, false, previewFactor);
          const stats = ensureRenderStats(ds);
          stats.directReads += 1;
          stats.directPixels += rasterW * rasterH * 3;
          stats.directReadMs += now() - t0;
        }
      }
    }
    if (!rasters) {
      rasters = await Promise.all(sourceBands.map((band) => readRasterForBand(ds, band, eff, viewportW, viewportH)));
    }
    const rasterByBand = new Map(rasters.map((raster) => [raster.band, raster]));
    return {
      mode,
      channelBands,
      rasterByBand,
      partial: rasters.some((raster) => !!raster?.partial),
      approximate: rasters.some((raster) => !!raster?.approximate),
      renderKey: rasters.find((raster) => raster?.renderKey)?.renderKey || null,
      refineFactor: Math.max(1, ...rasters.map((raster) => Number(raster?.refineFactor) || 1))
    };
  }

  function resizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const rect = els.main.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (els.cpuCanvas.width !== w) els.cpuCanvas.width = w;
    if (els.cpuCanvas.height !== h) els.cpuCanvas.height = h;
    if (els.overlayCanvas.width !== w) els.overlayCanvas.width = w;
    if (els.overlayCanvas.height !== h) els.overlayCanvas.height = h;
  }

  function renderModeKey(ds, band, colorMode, colorRenderMode = null) {
    if (colorMode) return `color:${colorRenderMode || getThreeBandDisplayMode(ds)}`;
    return `gray:${band}`;
  }

  function scheduleRender() {
    if (state._rafPending) return;
    state._rafPending = true;
    requestAnimationFrame(() => {
      state._rafPending = false;
      render();
    });
  }

  let previewRafPending = false;

  function renderPreview() {
    const visible = listVisiblePanels();
    if (!visible.length) {
      resizeCanvases();
      clearBaseCanvases(els);
      return false;
    }

    resizeCanvases();
    clearBaseCanvases(els);
    const layout = panelLayout();
    if (isOverlayComposition(visible)) {
      const drew = drawOverlayCachedPreview({
        els,
        entries: visible,
        layout,
        resolvePanelBand,
        clampView,
        renderModeKey,
        overlayColorForSlot
      });
      renderThumbnail();
      updateHud();
      drawOverlays();
      return drew;
    }
    let drewAny = false;
    const dpr = window.devicePixelRatio || 1;
    for (const entry of visible) {
      const { panel, dataset: ds } = entry;
      const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
      const band = resolvePanelBand(panel, ds);
      if (!viewport || !ds || band == null) continue;
      const prevView = ds.view;
      ds.view = panel.view || prevView;
      try {
        if (typeof ensureDatasetPreviewOverview === "function") ensureDatasetPreviewOverview(ds);
        clampView(panel.slot, ds);
        const eff = ds.view.scale * dpr;
        const colorMode = isThreeBandColorMode(ds);
        const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
        const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);
        if (drawCachedScreenPreview({ els, ds, panelSlot: panel.slot, modeKey, eff, viewport })) {
          drewAny = true;
        }
      } finally {
        ds.view = prevView;
      }
    }
    renderThumbnail();
    updateHud();
    drawOverlays();
    return drewAny;
  }

  function schedulePreview() {
    if (previewRafPending) return;
    previewRafPending = true;
    requestAnimationFrame(() => {
      previewRafPending = false;
      renderPreview();
    });
  }

  async function renderSinglePanel(ds, panel, opts = {}) {
    state.renderSeq += 1;
    resizeCanvases();
    const dpr = window.devicePixelRatio || 1;
    const colorMode = isThreeBandColorMode(ds);
    const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
    const band = resolvePanelBand(panel, ds);
    if (band == null) return;
    const panelSlot = Number(panel?.slot) || 1;
    ds.__renderPanelSlot = panelSlot;
    const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);

    let useGPU = false;
    if (!colorMode && gpuSupported) {
      const ok = await initWebGPU();
      if (ok) useGPU = true;
    }

    clampView(panel?.slot, ds);
    const eff = ds.view.scale * dpr;
    const previewViewport = { x: 0, y: 0, w: els.cpuCanvas.width, h: els.cpuCanvas.height };
    const previewCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const settings = getBandSettings(ds, band);
    const requestKey = buildPanelRequestKey(ds, panelSlot, modeKey, previewViewport.w, previewViewport.h);
    setPanelRequestKey(ds, panelSlot, requestKey);
    if (typeof ensureDatasetPreviewOverview === "function") ensureDatasetPreviewOverview(ds);

    const reuse = !!opts.reuseRaster;
    let raster = null;
    let compositeRaster = null;
    const reuseComposite = reuse && ds.lastCompositeRaster && ds.lastCompositeRaster.mode === colorRenderMode;
    const reuseGray = reuse && ds.lastRaster && ds.lastRaster.band === band;
    const needsFreshRaster = colorMode ? !reuseComposite : !reuseGray;
    if (
      needsFreshRaster
      && (
        drawCachedScreenPreview({
          els,
          ds,
          panelSlot,
          modeKey,
          eff,
          viewport: previewViewport
        })
        || drawThumbnailOnlyPreview({ els, ds, viewport: previewViewport, eff })
      )
    ) {
      drawOverlays();
      updateHud();
    }
    if (colorMode) {
      if (reuseComposite) {
        compositeRaster = ds.lastCompositeRaster;
      } else {
        compositeRaster = await getOrStartPanelRead(ds, panelSlot, requestKey, () => readCompositeRaster(ds, eff, els.cpuCanvas.width, els.cpuCanvas.height, {
          cancelled: () => !isPanelRequestCurrent(ds, panelSlot, requestKey),
          onPartial: async (partialCompositeRaster) => {
            if (!isPanelRequestCurrent(ds, panelSlot, requestKey)) return;
            const partialCanvas = buildCompositeCanvas(ds, partialCompositeRaster, { transparentNoData: true });
            if (!partialCanvas) return;
            updateScreenPreviewCache(ds, panelSlot, modeKey, eff, partialCanvas, previewViewport);
            drawCanvasToViewport(previewCtx, partialCanvas, previewViewport, false);
          }
        }));
      }
      if (!compositeRaster || !isPanelRequestCurrent(ds, panelSlot, requestKey)) return;
      raster = compositeRaster.rasterByBand.get(band) || compositeRaster.rasterByBand.get(0) || null;
    } else {
      if (reuseGray) {
        raster = ds.lastRaster;
      } else {
        raster = await readRasterForBand(ds, band, eff, els.cpuCanvas.width, els.cpuCanvas.height);
      }
    }
    if (!isPanelRequestCurrent(ds, panelSlot, requestKey)) return;

    const stableComposite = colorMode ? isStableCompositeRaster(compositeRaster) : false;
    const stableRaster = colorMode ? stableComposite : isStableRaster(raster);
    if (colorMode) {
      ds.lastCompositeRaster = stableComposite ? compositeRaster : null;
      ds.lastRaster = stableRaster ? raster : null;
    } else {
      ds.lastRaster = stableRaster ? raster : null;
    }

    const range = resolveDisplayRange(ds, band, raster.dataF32);
    const params = {
      minVal: range.minVal,
      maxVal: range.maxVal,
      brightness: clamp(settings.brightness ?? 0, -1, 1),
      gain: clamp(settings.gain ?? 1, 0.0, 4.0),
      contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
    };
    syncRangeInputsFromSettings(ds);

    try {
      const t0 = now();
      if (els.gpuCanvas?.style) els.gpuCanvas.style.display = useGPU ? "block" : "none";
      if (els.cpuCanvas?.style) els.cpuCanvas.style.display = useGPU ? "none" : "block";
      let renderedCanvas = null;
      if (colorMode) {
        const channelRasters = compositeRaster.channelBands.map((channelBand) => compositeRaster.rasterByBand.get(channelBand));
        renderedCanvas = cpuRenderColor(channelRasters, buildColorChannelParams(ds, compositeRaster));
      } else if (useGPU) {
        gpuRender(raster.dataF32, raster.w, raster.h, params);
        renderedCanvas = els.gpuCanvas;
      } else {
        renderedCanvas = cpuRenderGray(raster.dataF32, raster.w, raster.h, params);
      }
      if (renderedCanvas || useGPU) {
        updateScreenPreviewCache(ds, panelSlot, modeKey, eff, renderedCanvas || els.gpuCanvas, previewViewport);
      }
      if (stableRaster || stableComposite) {
        updatePanelRasterCache(ds, panelSlot, raster, compositeRaster);
        setStableRenderKey(ds, panelSlot, raster?.renderKey || compositeRaster?.rasterByBand?.get?.(0)?.renderKey || compositeRaster?.rasterByBand?.get?.(band)?.renderKey || null);
      } else {
        updatePanelRasterCache(ds, panelSlot, null, null);
      }

      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      renderThumbnail();
      updateHud();
      drawOverlays();
      updatePerf();

      const needsRefine = applyApproximateRefineState(ds, panelSlot, raster, compositeRaster);
      if (needsRefine) scheduleRender();

      if (state.histViewDebounce) clearTimeout(state.histViewDebounce);
      state.histViewDebounce = setTimeout(() => {
        const d = getActive();
        if (!d || d.id !== ds.id) return;
        ensureViewHistogram(d);
      }, 180);
    } catch (e) {
      console.error(e);
      if (!isPanelRequestCurrent(ds, panelSlot, requestKey)) return;
      setStatus("render error", "err");
    } finally {
      ds.__renderPanelSlot = null;
    }
  }

  async function renderMultiPanel(opts = {}, visible = []) {
    const seq = ++state.renderSeq;
    resizeCanvases();
    clearBaseCanvases(els);
    const layout = panelLayout();
    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const dpr = window.devicePixelRatio || 1;
    const activeSlot = Number(activePanelInfo()?.slot) || Number(visible[0]?.panel?.slot) || 1;
    const ordered = visible.slice().sort((a, b) => {
      const pa = renderPriority(a, activeSlot);
      const pb = renderPriority(b, activeSlot);
      if (pa.activeRank !== pb.activeRank) return pa.activeRank - pb.activeRank;
      return pa.slot - pb.slot;
    });
    const t0 = now();
    const hasDistinctDatasets = new Set(ordered.map((entry) => String(entry?.dataset?.id || ""))).size === ordered.length;
    let needsRefineAny = false;

    try {
      for (const entry of ordered) {
        const { panel, dataset: ds } = entry;
        const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
        const band = resolvePanelBand(panel, ds);
        if (!viewport || !ds || band == null) continue;
        const prevView = ds.view;
        ds.view = panel.view || prevView;
        try {
          if (typeof ensureDatasetPreviewOverview === "function") ensureDatasetPreviewOverview(ds);
          clampView(panel.slot, ds);
          const eff = ds.view.scale * dpr;
          const colorMode = isThreeBandColorMode(ds);
          const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
          const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);
          drawCachedScreenPreview({ els, ds, panelSlot: panel.slot, modeKey, eff, viewport })
            || drawThumbnailOnlyPreview({ els, ds, viewport, eff });
        } finally {
          ds.view = prevView;
        }
      }

      const renderPanelEntry = async (entry) => {
        if (seq !== state.renderSeq) return;
        const { panel, dataset: ds } = entry;
        const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
        const band = resolvePanelBand(panel, ds);
        if (!viewport || !ds || band == null) return;
        await withPanelView(ds, panel, async () => {
          const panelSlot = Number(panel.slot) || 1;
          ds.__renderPanelSlot = panelSlot;
          try {
            if (typeof ensureDatasetPreviewOverview === "function") ensureDatasetPreviewOverview(ds);
            clampView(panel.slot, ds);
            const eff = ds.view.scale * dpr;
            const colorMode = isThreeBandColorMode(ds);
            const colorRenderMode = colorMode ? getThreeBandDisplayMode(ds) : null;
            const modeKey = renderModeKey(ds, band, colorMode, colorRenderMode);
            const requestKey = buildPanelRequestKey(ds, panelSlot, modeKey, viewport.w, viewport.h);
            setPanelRequestKey(ds, panelSlot, requestKey);

            let raster = null;
            let compositeRaster = null;
            if (colorMode) {
              compositeRaster = await getOrStartPanelRead(ds, panelSlot, requestKey, () => readCompositeRaster(ds, eff, viewport.w, viewport.h, {
                cancelled: () => !isPanelRequestCurrent(ds, panelSlot, requestKey),
                onPartial: async (partialCompositeRaster) => {
                  if (!isPanelRequestCurrent(ds, panelSlot, requestKey)) return;
                  const partialCanvas = buildCompositeCanvas(ds, partialCompositeRaster, { transparentNoData: true });
                  if (!partialCanvas) return;
                  updateScreenPreviewCache(ds, panelSlot, modeKey, eff, partialCanvas, viewport);
                  drawCanvasToViewport(cpuCtx, partialCanvas, viewport, false);
                }
              }));
              if (!compositeRaster || !isPanelRequestCurrent(ds, panelSlot, requestKey)) return;
              raster = compositeRaster.rasterByBand.get(band) || compositeRaster.rasterByBand.get(0) || null;
            } else {
              raster = await readRasterForBand(ds, band, eff, viewport.w, viewport.h);
            }
            if (!isPanelRequestCurrent(ds, panelSlot, requestKey)) return;

            const stableComposite = colorMode ? isStableCompositeRaster(compositeRaster) : false;
            const stableRaster = colorMode ? stableComposite : isStableRaster(raster);

            const settings = getBandSettings(ds, band);
            const range = resolveDisplayRange(ds, band, raster.dataF32);
            const params = {
              minVal: range.minVal,
              maxVal: range.maxVal,
              brightness: clamp(settings.brightness ?? 0, -1, 1),
              gain: clamp(settings.gain ?? 1, 0.0, 4.0),
              contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
            };

            let renderedCanvas = null;
            if (colorMode) {
              renderedCanvas = buildCompositeCanvas(ds, compositeRaster);
            } else {
              renderedCanvas = buildGrayCanvas(raster.dataF32, raster.w, raster.h, params);
            }
            drawCanvasToViewport(cpuCtx, renderedCanvas, viewport, false);
            if (renderedCanvas) {
              updateScreenPreviewCache(ds, panelSlot, modeKey, eff, renderedCanvas, viewport);
            }
            if (stableRaster || stableComposite) {
              updatePanelRasterCache(ds, panelSlot, raster, compositeRaster);
              setStableRenderKey(ds, panelSlot, raster?.renderKey || compositeRaster?.rasterByBand?.get?.(0)?.renderKey || compositeRaster?.rasterByBand?.get?.(band)?.renderKey || null);
            } else {
              updatePanelRasterCache(ds, panelSlot, null, null);
            }

            if (Number(panel.slot) === activeSlot) {
              ds.lastRaster = stableRaster ? raster : null;
              ds.lastCompositeRaster = stableComposite ? compositeRaster : null;
              syncRangeInputsFromSettings(ds);
            }

            if (applyApproximateRefineState(ds, panelSlot, raster, compositeRaster)) {
              needsRefineAny = true;
            }
          } finally {
            ds.__renderPanelSlot = null;
          }
        });
      };

      if (hasDistinctDatasets && ordered.length > 1) {
        await Promise.all(ordered.map((entry) => renderPanelEntry(entry)));
      } else {
        for (const entry of ordered) {
          if (seq !== state.renderSeq) return;
          await renderPanelEntry(entry);
        }
      }

      if (seq !== state.renderSeq) return;
      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      renderThumbnail();
      updateHud();
      drawOverlays();
      updatePerf();
      if (needsRefineAny) scheduleRender();

      const activeDs = getActive();
      if (activeDs) {
        if (state.histViewDebounce) clearTimeout(state.histViewDebounce);
        state.histViewDebounce = setTimeout(() => {
          const d = getActive();
          if (!d || d.id !== activeDs.id) return;
          ensureViewHistogram(d);
        }, 180);
      }
    } catch (e) {
      console.error(e);
      if (seq !== state.renderSeq) return;
      setStatus("render error", "err");
    }
  }

  async function renderOverlayPanels(opts = {}, visible = []) {
    const seq = ++state.renderSeq;
    resizeCanvases();
    clearBaseCanvases(els);
    const layout = panelLayout();
    const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
    const dpr = window.devicePixelRatio || 1;
    const activeSlot = Number(activePanelInfo()?.slot) || Number(visible[0]?.panel?.slot) || 1;
    const overlayLayers = [];
    const t0 = now();
    let needsRefineAny = false;

    try {
      drawOverlayCachedPreview({
        els,
        entries: visible,
        layout,
        resolvePanelBand,
        clampView,
        renderModeKey,
        overlayColorForSlot
      });

      for (const entry of visible) {
        if (seq !== state.renderSeq) return;
        const { panel, dataset: ds } = entry;
        const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
        const band = resolvePanelBand(panel, ds);
        if (!viewport || !ds || band == null) continue;
        await withPanelView(ds, panel, async () => {
          ds.__renderPanelSlot = Number(panel.slot) || 1;
          try {
            clampView(panel.slot, ds);
            const eff = ds.view.scale * dpr;
            const raster = await readRasterForBand(ds, band, eff, viewport.w, viewport.h);
            if (seq !== state.renderSeq) return;

            const stableRaster = isStableRaster(raster);
            const settings = getBandSettings(ds, band);
            const range = resolveDisplayRange(ds, band, raster.dataF32);
            const params = {
              minVal: range.minVal,
              maxVal: range.maxVal,
              brightness: clamp(settings.brightness ?? 0, -1, 1),
              gain: clamp(settings.gain ?? 1, 0.0, 4.0),
              contrast: clamp(settings.contrast ?? 1, 0.1, 3.0)
            };
            const renderedCanvas = buildGrayCanvas(raster.dataF32, raster.w, raster.h, params);

            if (renderedCanvas) {
              updateScreenPreviewCache(ds, panel.slot, renderModeKey(ds, band, false, null), eff, renderedCanvas, viewport);
            }
            if (stableRaster) {
              updatePanelRasterCache(ds, panel.slot, raster, null);
              setStableRenderKey(ds, panel.slot, raster?.renderKey || null);
            } else {
              updatePanelRasterCache(ds, panel.slot, null, null);
            }

            overlayLayers.push({
              panel,
              dataset: ds,
              viewport,
              renderedCanvas,
              stableRaster,
              raster
            });

            if (Number(panel.slot) === activeSlot) {
              ds.lastRaster = stableRaster ? raster : null;
              ds.lastCompositeRaster = null;
              syncRangeInputsFromSettings(ds);
            }
            if (applyApproximateRefineState(ds, panel.slot, raster, null)) {
              needsRefineAny = true;
            }
          } finally {
            ds.__renderPanelSlot = null;
          }
        });
      }

      if (seq !== state.renderSeq) return;
      const overlayViewport = overlayLayers[0]?.viewport || { x: 0, y: 0, w: els.cpuCanvas.width, h: els.cpuCanvas.height };
      cpuCtx.save();
      cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
      cpuCtx.fillStyle = "#000";
      cpuCtx.fillRect(Number(overlayViewport.x) || 0, Number(overlayViewport.y) || 0, Math.max(1, Number(overlayViewport.w) || 1), Math.max(1, Number(overlayViewport.h) || 1));
      cpuCtx.restore();

      for (let i = 0; i < overlayLayers.length; i += 1) {
        const layer = overlayLayers[i];
        const tinted = tintCanvas(layer.renderedCanvas, overlayColorForSlot(layer.panel.slot));
        cpuCtx.save();
        cpuCtx.globalCompositeOperation = i === 0 ? "source-over" : "lighter";
        drawCanvasToViewport(cpuCtx, tinted, layer.viewport, false);
        cpuCtx.restore();
      }

      state.lastRenderMs = now() - t0;
      setStatus("ready", "ok");
      renderThumbnail();
      updateHud();
      drawOverlays();
      updatePerf();
      if (needsRefineAny) scheduleRender();

      const activeDs = getActive();
      if (activeDs) {
        if (state.histViewDebounce) clearTimeout(state.histViewDebounce);
        state.histViewDebounce = setTimeout(() => {
          const d = getActive();
          if (!d || d.id !== activeDs.id) return;
          ensureViewHistogram(d);
        }, 180);
      }
    } catch (e) {
      console.error(e);
      if (seq !== state.renderSeq) return;
      setStatus("render error", "err");
    }
  }

  async function render(opts = {}) {
    const visible = listVisiblePanels();
    if (!visible.length) {
      resizeCanvases();
      clearBaseCanvases(els);
      return;
    }

    const activePanel = activePanelInfo();
    const activeEntry = visible.find((entry) => Number(entry.panel.slot) === Number(activePanel?.slot)) || visible[0];
    const activeDs = activeEntry?.dataset || getActive();
    if (!activeDs || resolvePanelBand(activeEntry?.panel || null, activeDs) == null) {
      resizeCanvases();
      clearBaseCanvases(els);
      return;
    }

    if (visible.length === 1) {
      await withPanelView(activeDs, activeEntry.panel, async () => {
        await renderSinglePanel(activeDs, activeEntry.panel, opts);
      });
      return;
    }

    if (els.gpuCanvas?.style) els.gpuCanvas.style.display = "none";
    if (els.cpuCanvas?.style) els.cpuCanvas.style.display = "block";
    if (isOverlayComposition(visible)) {
      await renderOverlayPanels(opts, visible);
      return;
    }
    await renderMultiPanel(opts, visible);
  }

  return {
    resizeCanvases,
    renderPreview,
    schedulePreview,
    scheduleRender,
    render
  };
}
