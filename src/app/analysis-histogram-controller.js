import { choosePanelPlacementNearSelection } from "./panel-placement.js";

export function createAnalysisHistogramController(deps) {
  const {
    state,
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
    const axisHeight = 48 * dpr;
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

  function updateStatsPanel(stats) {
    if (!els.analysisStatN) return;
    if (!stats) {
      els.analysisStatN.textContent = "—";
      els.analysisStatRms.textContent = "—";
      els.analysisStatMode.textContent = "—";
      return;
    }
    els.analysisStatN.textContent = fmtNoGroup(stats.count || 0);
    els.analysisStatRms.textContent = formatNumber(stats.rms);
    els.analysisStatMode.textContent = formatNumber(stats.mode);
  }

  function updateHoverText(stats, binIndex) {
    if (!els.analysisHistHover) return;
    if (!stats || !stats.bins || binIndex < 0 || binIndex >= stats.bins.length) {
      els.analysisHistHover.textContent = "Hover a bin to inspect value/count.";
      return;
    }
    const bins = stats.bins.length;
    const bw = Number.isFinite(stats.binWidth) ? stats.binWidth : ((stats.max - stats.min) / Math.max(1, bins));
    const lo = stats.min + binIndex * bw;
    const hi = lo + bw;
    const count = stats.bins[binIndex] || 0;
    els.analysisHistHover.textContent = `Bin ${binIndex}: ${formatNumber(lo)} .. ${formatNumber(hi)}  |  Count ${fmtNoGroup(count)}`;
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
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(17,24,39,0.96)";
    ctx.fillRect(0, 0, w, h);

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
    ctx.fillStyle = "rgba(56,189,248,0.14)";
    ctx.fillRect(stdLowX, plot.plotY0, Math.max(1, stdHighX - stdLowX), plot.plotH);

    ctx.fillStyle = "rgba(148,163,184,0.45)";
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
    ctx.strokeStyle = "rgba(125,211,252,0.95)";
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(meanX, plot.plotY0);
    ctx.lineTo(meanX, plotBottom + (5 * dpr));
    ctx.stroke();

    // Keep a visible light frame around the active histogram plotting region.
    const borderW = 1 * dpr;
    const inset = borderW * 0.5;
    ctx.strokeStyle = "rgba(226,232,240,0.38)";
    ctx.lineWidth = borderW;
    ctx.strokeRect(
      plot.plotX0 + inset,
      plot.plotY0 + inset,
      Math.max(0, plot.plotW - borderW),
      Math.max(0, plot.plotH - borderW)
    );

    const tickHeight = 5 * dpr;
    ctx.strokeStyle = "rgba(203,213,225,0.75)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(plot.plotX0, plotBottom);
    ctx.lineTo(plot.plotX0, plotBottom + tickHeight);
    ctx.moveTo(plotRight, plotBottom);
    ctx.lineTo(plotRight, plotBottom + tickHeight);
    ctx.stroke();

    const axisFont = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.font = axisFont;
    ctx.fillStyle = "rgba(203,213,225,0.9)";
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillText(formatNumber(stats.min), plot.plotX0, plotBottom + (6 * dpr));
    ctx.textAlign = "right";
    ctx.fillText(formatNumber(stats.max), plotRight, plotBottom + (6 * dpr));

    const meanLabel = `Mean ${formatNumber(stats.mean)}`;
    const stdLabel = `StdDev ${formatNumber(stats.stdDev)}`;
    const labelWidth = Math.max(meanLabel.length, stdLabel.length) * 3.2 * dpr;
    const meanLabelX = clamp(meanX, plot.plotX0 + labelWidth, plotRight - labelWidth);
    ctx.fillStyle = "rgba(125,211,252,0.96)";
    ctx.textAlign = "center";
    ctx.fillText(meanLabel, meanLabelX, plotBottom + (20 * dpr));
    ctx.fillStyle = "rgba(125,211,252,0.72)";
    ctx.fillText(stdLabel, meanLabelX, plotBottom + (33 * dpr));

    const binWidth = Number.isFinite(stats.binWidth)
      ? stats.binWidth
      : ((stats.max - stats.min) / Math.max(1, bins.length));
    ctx.fillStyle = "rgba(15,23,42,0.78)";
    ctx.fillRect(plotRight - (116 * dpr), plot.plotY0 + (4 * dpr), 112 * dpr, 30 * dpr);
    ctx.fillStyle = "rgba(226,232,240,0.88)";
    ctx.textAlign = "right";
    ctx.fillText(`Bins ${fmtNoGroup(bins.length)}`, plotRight - (8 * dpr), plot.plotY0 + (7 * dpr));
    ctx.fillText(`Bin width ${formatNumber(binWidth)}`, plotRight - (8 * dpr), plot.plotY0 + (19 * dpr));

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
      updateStatsPanel(null);
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
      updateStatsPanel(stats);
      updateSamplingWarning(stats);
      updateHoverText(stats, -1);
      drawCanvas(stats);
      setStatus("ready", "ok");
    } catch (err) {
      console.warn("Analysis histogram failed", err);
      state.analysisHist.stats = null;
      updateStatsPanel(null);
      updateSamplingWarning(null);
      updateHoverText(null, -1);
      drawCanvas(null);
      setStatus("ready", "ok");
    } finally {
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
