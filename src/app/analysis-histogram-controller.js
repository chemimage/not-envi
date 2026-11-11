import { choosePanelPlacementNearSelection } from "./panel-placement.js";

export function createAnalysisHistogramController(deps) {
  const {
    state,
    arrangeAnalysisPanels,
    els,
    clamp,
    fmtNoGroup,
    formatNumber,
    getActive,
    getDisplayBand,
    getHistogramSelectionItems,
    histogramSelectionKeyFromItems,
    updateSelectionHistogram,
    buildBandStatsWhole,
    computeHistogram,
    resolveEffectiveSelectionBounds,
    resolveSelectionBoundsList,
    listHistogramSelectionItems,
    setStatus
  } = deps;

  function resolveHistogramBand(ds) {
    if (!ds) return null;
    return (typeof getDisplayBand === "function") ? getDisplayBand(ds) : ds.activeBand;
  }

  function resolveViewRaster(ds, band) {
    if (!ds || band == null) return null;
    const compositeRaster = ds.lastCompositeRaster?.rasterByBand?.get?.(band) || null;
    if (compositeRaster?.dataF32?.length) return compositeRaster;
    if (ds.lastRaster?.band === band && ds.lastRaster?.dataF32?.length) return ds.lastRaster;
    return null;
  }

  function getCanvasPlotRect(canvasWidth, canvasHeight, dpr = 1) {
    const horizontalPad = 10 * dpr;
    const topPad = 8 * dpr;
    const axisHeight = 80 * dpr;
    return {
      plotX0: horizontalPad,
      plotY0: topPad,
      plotW: Math.max(1, canvasWidth - (horizontalPad * 2)),
      plotH: Math.max(1, canvasHeight - topPad - axisHeight)
    };
  }

  function setBusy(isBusy) {
    if (!els.btnToolHistogram) return;
    els.btnToolHistogram.classList.toggle("loading", !!isBusy);
    els.btnToolHistogram.disabled = !!isBusy;
    els.btnToolHistogram.setAttribute("aria-busy", isBusy ? "true" : "false");
  }

  function syncButtonState() {
    if (!els.btnToolHistogram) return;
    els.btnToolHistogram.classList.toggle("active", !!state.analysisHist.open);
    els.btnToolHistogram.setAttribute("aria-pressed", state.analysisHist.open ? "true" : "false");
  }

  function updateSummary(stats) {
    if (!els.analysisStatN || !els.analysisStatMode) return;
    els.analysisStatN.textContent = stats ? fmtNoGroup(stats.count || 0) : "—";
    els.analysisStatMode.textContent = stats ? formatNumber(stats.mode) : "—";
  }

  function updateHoverText(stats, binIndex) {
    if (!els.analysisHistHover) return;
    if (!stats || !stats.bins || binIndex < 0 || binIndex >= stats.bins.length) {
      els.analysisHistHover.textContent = "Hover to inspect values.";
      els.analysisHistHover.classList.remove("active");
      return;
    }
    const bins = stats.bins.length;
    const bw = Number.isFinite(stats.binWidth) ? stats.binWidth : ((stats.max - stats.min) / Math.max(1, bins));
    const lo = stats.min + binIndex * bw;
    const hi = lo + bw;
    const count = stats.bins[binIndex] || 0;
    els.analysisHistHover.textContent = `Bin ${binIndex}: ${formatNumber(lo)} .. ${formatNumber(hi)}  |  Count ${fmtNoGroup(count)}`;
    els.analysisHistHover.classList.add("active");
  }

  function resolveSamplingWarning(stats) {
    if (!stats || stats.trueRawSamples !== false) return "";
    const step = Number.isFinite(stats.sampleStep) ? stats.sampleStep : 1;
    if (stats.samplingMode === "view-raster") {
      return "Approximate: using the current view raster, not full raw-resolution samples.";
    }
    if (stats.samplingMode === "whole-subsampled") {
      return `Approximate: whole-image histogram is sampled every ${fmtNoGroup(step)} pixel${step === 1 ? "" : "s"}.`;
    }
    if (stats.samplingMode === "selection-subsampled") {
      return `Approximate: selection histogram is sampled every ${fmtNoGroup(step)} pixel${step === 1 ? "" : "s"}.`;
    }
    return "Approximate: not using full raw-resolution samples.";
  }

  function updateSamplingWarning(stats) {
    if (!els.analysisHistWarning) return;
    const text = resolveSamplingWarning(stats);
    els.analysisHistWarning.textContent = text;
    els.analysisHistWarning.style.display = text ? "block" : "none";
  }

  function drawCanvas(stats) {
    if (!els.analysisHistCanvas) return;
    const canvas = els.analysisHistCanvas;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d", { alpha: true });
    const canvasStyle = window.getComputedStyle?.(canvas);
    const annotationFontSize = Number.parseFloat(canvasStyle?.fontSize || "") || 14;
    const annotationFontFamily = canvasStyle?.fontFamily || "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
    const themeValue = (name, fallback) => canvasStyle?.getPropertyValue(name)?.trim() || fallback;
    const annotationColor = canvasStyle?.color || "rgba(229,231,235,0.9)";
    const accentColor = themeValue("--hist-accent", "rgba(34,211,238,0.96)");
    const accentMutedColor = themeValue("--hist-accent-muted", "rgba(34,211,238,0.72)");
    const accentRegionColor = themeValue("--hist-accent-region", "rgba(34,211,238,0.14)");
    const mutedColor = themeValue("--hist-muted", "rgba(156,163,175,0.9)");
    const overlayColor = themeValue("--hist-overlay", "rgba(17,24,39,0.82)");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!stats || !stats.bins || !stats.bins.length) {
      ctx.fillStyle = "rgba(209,213,219,0.9)";
      ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
      ctx.fillText("Histogram not ready", 10 * dpr, 20 * dpr);
      ctx.restore();
      return;
    }

    const bins = stats.bins;
    const maxBin = Math.max(1, ...bins);
    const plot = getCanvasPlotRect(w, h, dpr);
    const barW = plot.plotW / bins.length;
    const hoverBin = state.analysisHist.hoverBin;
    const plotRight = plot.plotX0 + plot.plotW;
    const plotBottom = plot.plotY0 + plot.plotH;
    const valueRange = Math.max(Number.EPSILON, stats.max - stats.min);
    const valueX = (value) => plot.plotX0 + (clamp((value - stats.min) / valueRange, 0, 1) * plot.plotW);
    const meanX = valueX(stats.mean);
    const stdLowX = valueX(stats.mean - stats.stdDev);
    const stdHighX = valueX(stats.mean + stats.stdDev);

    // Show the one-standard-deviation spread behind the distribution bars.
    ctx.fillStyle = accentRegionColor;
    ctx.fillRect(stdLowX, plot.plotY0, Math.max(1, stdHighX - stdLowX), plot.plotH);

    ctx.fillStyle = "rgba(156,163,175,0.45)";
    for (let i = 0; i < bins.length; i += 1) {
      const bh = (bins[i] / maxBin) * plot.plotH;
      const x = plot.plotX0 + i * barW;
      const y = plot.plotY0 + (plot.plotH - bh);
      ctx.fillRect(x, y, Math.max(1, barW), bh);
    }

    if (hoverBin >= 0 && hoverBin < bins.length) {
      const bh = (bins[hoverBin] / maxBin) * plot.plotH;
      const x = plot.plotX0 + hoverBin * barW;
      const y = plot.plotY0 + (plot.plotH - bh);
      ctx.fillStyle = "rgba(250,204,21,0.85)";
      ctx.fillRect(x, y, Math.max(1, barW), bh);
      ctx.strokeStyle = "rgba(250,204,21,0.95)";
      ctx.lineWidth = 1.25 * dpr;
      ctx.beginPath();
      ctx.moveTo(x + (0.5 * barW), plot.plotY0);
      ctx.lineTo(x + (0.5 * barW), plot.plotY0 + plot.plotH);
      ctx.stroke();
    }

    // Keep the mean visible as the primary spatial statistic marker.
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(meanX, plot.plotY0);
    ctx.lineTo(meanX, plotBottom + (5 * dpr));
    ctx.stroke();

    const tickHeight = 5 * dpr;
    ctx.strokeStyle = "rgba(209,213,219,0.75)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(plot.plotX0, plotBottom);
    ctx.lineTo(plotRight, plotBottom);
    ctx.moveTo(plot.plotX0, plotBottom);
    ctx.lineTo(plot.plotX0, plotBottom + tickHeight);
    ctx.moveTo(plotRight, plotBottom);
    ctx.lineTo(plotRight, plotBottom + tickHeight);
    ctx.stroke();

    const axisFont = `${annotationFontSize * dpr}px ${annotationFontFamily}`;
    ctx.font = axisFont;
    ctx.fillStyle = annotationColor;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(formatNumber(stats.min), plot.plotX0, plotBottom + (6 * dpr));
    ctx.textAlign = "right";
    ctx.fillText(formatNumber(stats.max), plotRight, plotBottom + (6 * dpr));

    const meanLabel = `mean = ${formatNumber(stats.mean)}`;
    const stdLabel = `std = ${formatNumber(stats.stdDev)}`;
    const rmsLabel = `rms = ${formatNumber(stats.rms)}`;
    const labelWidth = Math.max(meanLabel.length, stdLabel.length, rmsLabel.length) * 4.2 * dpr;
    const meanLabelX = clamp(meanX, plot.plotX0 + labelWidth, plotRight - labelWidth);
    ctx.fillStyle = accentColor;
    ctx.textAlign = "center";
    ctx.fillText(meanLabel, meanLabelX, plotBottom + (25 * dpr));
    ctx.fillStyle = accentMutedColor;
    ctx.fillText(stdLabel, meanLabelX, plotBottom + (43 * dpr));
    ctx.fillText(rmsLabel, meanLabelX, plotBottom + (61 * dpr));

    const binWidth = Number.isFinite(stats.binWidth)
      ? stats.binWidth
      : ((stats.max - stats.min) / Math.max(1, bins.length));
    const metaWidth = 140 * dpr;
    const metaRight = plotRight - (6 * dpr);
    const metaLeft = metaRight - metaWidth;
    const metaEqualsX = metaLeft + (72 * dpr);
    const drawMetadataRow = (label, value, y) => {
      ctx.fillStyle = mutedColor;
      ctx.textAlign = "right";
      ctx.fillText(label, metaEqualsX - (8 * dpr), y);
      ctx.textAlign = "center";
      ctx.fillText("=", metaEqualsX, y);
      ctx.fillStyle = annotationColor;
      ctx.textAlign = "left";
      ctx.fillText(value, metaEqualsX + (8 * dpr), y);
    };
    ctx.font = `${Math.max(10, annotationFontSize - 2) * dpr}px ${annotationFontFamily}`;
    ctx.fillStyle = overlayColor;
    ctx.fillRect(metaLeft, plot.plotY0 + (5 * dpr), metaWidth, 40 * dpr);
    drawMetadataRow("bins", fmtNoGroup(bins.length), plot.plotY0 + (8 * dpr));
    drawMetadataRow("bin width", formatNumber(binWidth), plot.plotY0 + (25 * dpr));

    ctx.restore();
  }

  function resolveStatsForPanel(ds) {
    const band = resolveHistogramBand(ds);
    if (!ds || band == null) return null;
    const selections = getHistogramSelectionItems(ds);
    if (selections.length) {
      const selectionKey = histogramSelectionKeyFromItems(selections);
      const selectionStats = ds.bandStatsSelection;
      if (selectionStats && selectionStats.band === band && selectionStats.selectionKey === selectionKey && selectionStats.stats?.bins) {
        return selectionStats.stats;
      }
    }
    const wholeStats = ds.bandStatsWhole.get(band) || null;
    if (wholeStats && wholeStats.bins && wholeStats.count > 0) return wholeStats;
    const raster = resolveViewRaster(ds, band);
    if (raster) {
      return {
        ...computeHistogram(raster.dataF32, 256),
        sampleStep: Number.isFinite(raster.step) ? raster.step : 1,
        trueRawSamples: false,
        samplingMode: "view-raster"
      };
    }
    return null;
  }

  async function ensureStatsForPanel(ds) {
    const band = resolveHistogramBand(ds);
    if (!ds || band == null) return null;
    const selections = getHistogramSelectionItems(ds);
    if (selections.length) {
      const selectionKey = histogramSelectionKeyFromItems(selections);
      const selStats = ds.bandStatsSelection;
      const ready = !!(selStats && selStats.band === band && selStats.selectionKey === selectionKey && selStats.stats);
      if (!ready) await updateSelectionHistogram(ds, selections);
    } else if (!ds.bandStatsWhole.has(band)) {
      await buildBandStatsWhole(ds, band);
    }
    return resolveStatsForPanel(ds);
  }

  function positionPanel() {
    if (arrangeAnalysisPanels?.()) return;
    if (!els.analysisHistPanel || !els.btnToolHistogram) return;
    if (els.analysisHistPanel.dataset?.floatingUserPlaced === "true") return;
    const ds = getActive();
    const selections = ds ? getHistogramSelectionItems(ds) : [];
    if (ds && selections.length) {
      const targetBounds = resolveEffectiveSelectionBounds(ds, selections);
      const effectiveIds = new Set(selections.map((item) => item.id));
      const allBounds = resolveSelectionBoundsList(ds, listHistogramSelectionItems(ds));
      const avoidBounds = allBounds
        .filter((b) => !effectiveIds.has(b.id))
        .map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
      const panelRect = els.analysisHistPanel.getBoundingClientRect();
      const placement = choosePanelPlacementNearSelection({
        ds,
        mainRect: els.main ? els.main.getBoundingClientRect() : null,
        panelWidth: panelRect.width || 380,
        panelHeight: panelRect.height || 360,
        targetBounds,
        avoidBounds,
        pointerType: "mouse"
      });
      if (placement) {
        els.analysisHistPanel.style.left = `${Math.round(placement.x)}px`;
        els.analysisHistPanel.style.top = `${Math.round(placement.y)}px`;
        return;
      }
    }

    const trigger = els.btnToolHistogram.getBoundingClientRect();
    const panelWidth = 380;
    const left = clamp(trigger.right + 8, 8, Math.max(8, window.innerWidth - panelWidth - 8));
    const top = clamp(trigger.top, 8, Math.max(8, window.innerHeight - 360));
    els.analysisHistPanel.style.left = `${left}px`;
    els.analysisHistPanel.style.top = `${top}px`;
  }

  async function refresh() {
    if (!state.analysisHist.open || !els.analysisHistPanel) return;
    positionPanel();
    const ds = getActive();
    state.analysisHist.hoverBin = -1;
    if (!ds) {
      state.analysisHist.stats = null;
      updateSummary(null);
      updateSamplingWarning(null);
      updateHoverText(null, -1);
      drawCanvas(null);
      return;
    }

    setBusy(true);
    setStatus("histogram…", "warn");
    try {
      const stats = await ensureStatsForPanel(ds);
      state.analysisHist.stats = stats;
      updateSummary(stats);
      updateSamplingWarning(stats);
      updateHoverText(stats, -1);
      drawCanvas(stats);
      setStatus("ready", "ok");
    } catch (err) {
      console.warn("Analysis histogram failed", err);
      state.analysisHist.stats = null;
      updateSummary(null);
      updateSamplingWarning(null);
      updateHoverText(null, -1);
      drawCanvas(null);
      setStatus("ready", "ok");
    } finally {
      positionPanel();
      setBusy(false);
    }
  }

  function openPanel() {
    if (!els.analysisHistPanel) return;
    state.analysisHist.open = true;
    syncButtonState();
    els.analysisHistPanel.style.display = "flex";
    els.analysisHistPanel.setAttribute("aria-hidden", "false");
    positionPanel();
    refresh().catch(() => {});
  }

  function closePanel() {
    state.analysisHist.open = false;
    state.analysisHist.hoverBin = -1;
    syncButtonState();
    updateSamplingWarning(null);
    if (els.analysisHistPanel) {
      els.analysisHistPanel.style.display = "none";
      els.analysisHistPanel.setAttribute("aria-hidden", "true");
    }
    setBusy(false);
  }

  function togglePanel() {
    if (state.analysisHist.open) closePanel();
    else openPanel();
  }

  function getOpen() {
    return !!state.analysisHist.open;
  }

  function setOpen(nextOpen) {
    if (nextOpen) openPanel();
    else closePanel();
  }

  function onPointerMove(ev) {
    const stats = state.analysisHist.stats;
    const canvas = els.analysisHistCanvas;
    if (!stats || !canvas || !stats.bins?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * dpr;
    const y = (ev.clientY - rect.top) * dpr;
    const plot = getCanvasPlotRect(canvas.width, canvas.height, dpr);
    if (x < plot.plotX0 || x > (plot.plotX0 + plot.plotW) || y < plot.plotY0 || y > (plot.plotY0 + plot.plotH)) {
      if (state.analysisHist.hoverBin !== -1) {
        state.analysisHist.hoverBin = -1;
        updateHoverText(stats, -1);
        drawCanvas(stats);
      }
      return;
    }
    const t = clamp((x - plot.plotX0) / Math.max(1, plot.plotW), 0, 0.999999);
    const idx = clamp(Math.floor(t * stats.bins.length), 0, stats.bins.length - 1);
    if (idx === state.analysisHist.hoverBin) return;
    state.analysisHist.hoverBin = idx;
    updateHoverText(stats, idx);
    drawCanvas(stats);
  }

  function onPointerLeave() {
    const stats = state.analysisHist.stats;
    if (!stats) return;
    if (state.analysisHist.hoverBin === -1) return;
    state.analysisHist.hoverBin = -1;
    updateHoverText(stats, -1);
    drawCanvas(stats);
  }

  function redraw() {
    drawCanvas(state.analysisHist.stats || null);
  }

  return {
    refresh,
    positionPanel,
    openPanel,
    closePanel,
    togglePanel,
    getOpen,
    setOpen,
    onPointerMove,
    onPointerLeave,
    redraw
  };
}
