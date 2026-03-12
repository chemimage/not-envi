import { choosePanelPlacementNearSelection } from "./panel-placement.js";

export function createAnalysisHistogramController(deps) {
  const {
    state,
    els,
    clamp,
    fmtNoGroup,
    formatNumber,
    getActive,
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

  function getCanvasPlotRect(canvasWidth, canvasHeight) {
    return {
      plotX0: 0,
      plotY0: 0,
      plotW: canvasWidth,
      plotH: canvasHeight
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
      els.analysisStatRange.textContent = "—";
      els.analysisStatMeanStd.textContent = "—";
      els.analysisStatMode.textContent = "—";
      els.analysisStatBins.textContent = "—";
      els.analysisStatBinWidth.textContent = "—";
      return;
    }
    const bins = stats.bins?.length || 0;
    const binWidth = Number.isFinite(stats.binWidth) ? stats.binWidth : ((stats.max - stats.min) / Math.max(1, bins));
    els.analysisStatN.textContent = fmtNoGroup(stats.count || 0);
    els.analysisStatRange.textContent = `${formatNumber(stats.min)} / ${formatNumber(stats.max)}`;
    els.analysisStatMeanStd.textContent = `${formatNumber(stats.mean)} / ${formatNumber(stats.stdDev)}`;
    els.analysisStatMode.textContent = formatNumber(stats.mode);
    els.analysisStatBins.textContent = fmtNoGroup(bins);
    els.analysisStatBinWidth.textContent = formatNumber(binWidth);
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
    const plot = getCanvasPlotRect(w, h);
    const barW = plot.plotW / bins.length;
    const hoverBin = state.analysisHist.hoverBin;

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

    ctx.restore();
  }

  function resolveStatsForPanel(ds) {
    if (!ds || ds.activeBand == null) return null;
    const selections = getHistogramSelectionItems(ds);
    if (selections.length) {
      const selectionKey = histogramSelectionKeyFromItems(selections);
      const selectionStats = ds.bandStatsSelection;
      if (selectionStats && selectionStats.band === ds.activeBand && selectionStats.selectionKey === selectionKey && selectionStats.stats?.bins) {
        return selectionStats.stats;
      }
    }
    const wholeStats = ds.bandStatsWhole.get(ds.activeBand) || null;
    if (wholeStats && wholeStats.bins && wholeStats.count > 0) return wholeStats;
    if (ds.lastRaster && ds.lastRaster.band === ds.activeBand && ds.lastRaster.dataF32?.length) {
      return computeHistogram(ds.lastRaster.dataF32, 256);
    }
    return null;
  }

  async function ensureStatsForPanel(ds) {
    if (!ds || ds.activeBand == null) return null;
    const selections = getHistogramSelectionItems(ds);
    if (selections.length) {
      const selectionKey = histogramSelectionKeyFromItems(selections);
      const selStats = ds.bandStatsSelection;
      const ready = !!(selStats && selStats.band === ds.activeBand && selStats.selectionKey === selectionKey && selStats.stats);
      if (!ready) await updateSelectionHistogram(ds, selections);
    } else if (!ds.bandStatsWhole.has(ds.activeBand)) {
      await buildBandStatsWhole(ds, ds.activeBand);
    }
    return resolveStatsForPanel(ds);
  }

  function positionPanel() {
    if (!els.analysisHistPanel || !els.btnToolHistogram) return;
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
      updateHoverText(stats, -1);
      drawCanvas(stats);
      setStatus("ready", "ok");
    } catch (err) {
      console.warn("Analysis histogram failed", err);
      state.analysisHist.stats = null;
      updateStatsPanel(null);
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
    els.analysisHistPanel.style.display = "block";
    els.analysisHistPanel.setAttribute("aria-hidden", "false");
    positionPanel();
    refresh().catch(() => {});
  }

  function closePanel() {
    state.analysisHist.open = false;
    state.analysisHist.hoverBin = -1;
    syncButtonState();
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
    const plot = getCanvasPlotRect(canvas.width, canvas.height);
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

  return {
    refresh,
    positionPanel,
    openPanel,
    closePanel,
    togglePanel,
    getOpen,
    setOpen,
    onPointerMove,
    onPointerLeave
  };
}
