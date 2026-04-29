import { formatExperimentSettingsInline, parseExperimentSettings } from "./experiment-meta.js";
import { DISPLAY_COMPOSITION_OVERLAY, resolveDisplayLinkColorName, resolveDisplayPanelBand } from "./display-panels.js";
import {
  THREE_BAND_ADJUST_BLUE,
  THREE_BAND_ADJUST_GREEN,
  THREE_BAND_ADJUST_RED,
  THREE_BAND_DISPLAY_MODE_BGR,
  THREE_BAND_DISPLAY_MODE_GRAY,
  THREE_BAND_DISPLAY_MODE_RGB,
  cycleThreeBandAdjustColor,
  cycleThreeBandDisplayMode,
  getThreeBandAdjustColor,
  resolveThreeBandAdjustBand,
  resolveThreeBandAdjustColorForBand,
  getThreeBandDisplayMode,
  isThreeBandColorMode,
  isThreeBandDataset
} from "./three-band-display.js";
import { APP_CONFIG } from "./config.js";

export function createUIPanels(deps) {
  const {
    state,
    els,
    cacheBudget,
    getActive,
    getActivePanel,
    clamp,
    fmt,
    fmtNoGroup,
    humanBytes,
    bandLabel,
    setActiveDataset,
    cycleDatasetPanel,
    closeDataset,
    drawHistogram,
    render,
    quickStatsFromArray,
    onNeedWholeStats,
    onBandChanged
  } = deps;
  let metaPinnedDatasetId = null;
  let metaPinnedRowEl = null;
  let metaHoverDatasetId = null;

  function getBandSettings(ds, band) {
    if (!ds.bandSettings.has(band)) {
      ds.bandSettings.set(band, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 });
    }
    return ds.bandSettings.get(band);
  }

  function resolveStats(ds) {
    const band = resolveDisplayControlBand(ds);
    if (band == null) return null;
    // Display panel histogram always follows the currently adjusted display band.
    if (ds.bandStatsWhole.has(band)) return ds.bandStatsWhole.get(band) || null;
    if (ds.bandStatsView && (ds.bandStatsView.band == null || Number(ds.bandStatsView.band) === Number(band))) {
      return ds.bandStatsView;
    }
    return null;
  }

  function describeThreeBandDisplayMode(mode) {
    if (mode === THREE_BAND_DISPLAY_MODE_RGB) return "RGB image";
    if (mode === THREE_BAND_DISPLAY_MODE_BGR) return "BGR image";
    return "Multi-bands";
  }

  function describeAdjustColor(color) {
    if (color === THREE_BAND_ADJUST_GREEN) return "Adjust green channel";
    if (color === THREE_BAND_ADJUST_BLUE) return "Adjust blue channel";
    return "Adjust red channel";
  }

  function displayPanelLabel(slot) {
    return Number(slot) === 2 ? "R" : "L";
  }

  function displayPanelTitle(slot) {
    return Number(slot) === 2 ? "Right panel" : "Left panel";
  }

  function resolveDisplayControlBand(ds) {
    return resolveThreeBandAdjustBand(ds);
  }

  function estimateWholeStatsWork(ds) {
    if (!ds?.meta || typeof ds?.ds?.estimateReadWork !== "function") return null;
    const band = resolveDisplayControlBand(ds);
    if (band == null) return null;
    const target = 512;
    const stepX = Math.ceil(Number(ds.meta.samples || 0) / target);
    const stepY = Math.ceil(Number(ds.meta.lines || 0) / target);
    const step = Math.max(1, Math.max(stepX, stepY));
    const outW = Math.min(target, Math.ceil(Number(ds.meta.samples || 0) / step));
    const outH = Math.min(target, Math.ceil(Number(ds.meta.lines || 0) / step));
    return ds.ds.estimateReadWork(ds.meta, band, 0, 0, outW, outH, step);
  }

  function shouldAutoWholeStats(ds) {
    if (!ds?.meta) return true;
    const estimated = estimateWholeStatsWork(ds);
    if (Number(estimated?.estimatedBytes) > Number(APP_CONFIG.histogram.autoWholeStatsMaxReadBytes || 0)) {
      return false;
    }
    const pixels = Number(ds.meta.samples || 0) * Number(ds.meta.lines || 0);
    return pixels <= Number(APP_CONFIG.histogram.autoWholeStatsMaxPixels || 0);
  }

  function requestWholeStatsIfNeeded(ds, band, opts = {}) {
    if (!ds || band == null) return;
    if (!shouldAutoWholeStats(ds)) return;
    if (!opts.force && ds.bandStatsWhole.has(band)) return;
    onNeedWholeStats(ds, band);
  }

  function resolveActiveBandForDataset(ds) {
    if (!ds) return null;
    const panel = (typeof getActivePanel === "function") ? getActivePanel() : null;
    if (panel && String(panel.datasetId || "") === String(ds.id || "")) {
      return resolveDisplayPanelBand(panel, ds);
    }
    return resolveDisplayPanelBand(null, ds);
  }

  function numericBandSortValue(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const s = String(value ?? "").trim();
    if (!s) return null;
    const direct = Number(s);
    if (Number.isFinite(direct)) return direct;
    const match = s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function sortedBandIndices(ds) {
    const bandCount = Math.max(0, Math.floor(Number(ds?.meta?.bands) || 0));
    const entries = [];
    for (let b = 0; b < bandCount; b += 1) {
      const wl = Array.isArray(ds?.meta?.wavelengths) ? ds.meta.wavelengths[b] : null;
      const label = bandLabel(ds, b);
      const sortValue = numericBandSortValue(wl ?? label);
      entries.push({ band: b, sortValue });
    }
    if (!entries.length || entries.some((entry) => entry.sortValue == null)) {
      return entries.map((entry) => entry.band);
    }
    return entries
      .slice()
      .sort((a, b) => (a.sortValue - b.sortValue) || (a.band - b.band))
      .map((entry) => entry.band);
  }

  function syncDisplayAdjustButton(ds) {
    if (!els.btnHistChannel) return;
    if (!ds || !isThreeBandColorMode(ds)) {
      els.btnHistChannel.style.display = "none";
      els.btnHistChannel.textContent = "";
      els.btnHistChannel.className = "hist-channel-btn";
      return;
    }
    const color = getThreeBandAdjustColor(ds);
    const label = describeAdjustColor(color);
    els.btnHistChannel.style.display = "inline-flex";
    els.btnHistChannel.className = `hist-channel-btn channel-${color}`;
    els.btnHistChannel.textContent = color === THREE_BAND_ADJUST_GREEN
      ? "G"
      : (color === THREE_BAND_ADJUST_BLUE ? "B" : "R");
    els.btnHistChannel.title = label;
    els.btnHistChannel.ariaLabel = label;
  }

  function cycleDisplayAdjustColor(ds) {
    if (!ds || !isThreeBandColorMode(ds)) return;
    ds.displayAdjustColor = cycleThreeBandAdjustColor(getThreeBandAdjustColor(ds));
    const band = resolveDisplayControlBand(ds);
    requestWholeStatsIfNeeded(ds, band);
    updateDisplayUI(true);
  }

  function cycleDatasetDisplayMode(ds) {
    if (!isThreeBandDataset(ds)) return;
    const prevMode = getThreeBandDisplayMode(ds);
    const nextMode = cycleThreeBandDisplayMode(prevMode);
    ds.displayMode = nextMode;
    if (nextMode !== THREE_BAND_DISPLAY_MODE_GRAY && prevMode === THREE_BAND_DISPLAY_MODE_GRAY) {
      ds.displayAdjustColor = resolveThreeBandAdjustColorForBand(nextMode, ds.activeBand);
    }
    ds.lastRaster = null;
    ds.lastCompositeRaster = null;
    if (ds.thumb) {
      ds.thumb.ready = false;
      ds.thumb.base = null;
      ds.thumb.buildKey = null;
      ds.thumb.buildPendingKey = null;
    }
    for (let b = 0; b < 3; b += 1) requestWholeStatsIfNeeded(ds, b, { force: true });
    rebuildBandTree({ preserveScroll: true });
    updateDisplayUI(true);
    render();
  }

  function formatDisplayRangeInput(v) {
    if (!Number.isFinite(v)) return "";
    if (v === 0) return "0";
    const compact = Number(v).toPrecision(3);
    return compact
      .replace(/(\.\d*?[1-9])0+(e.*)?$/i, "$1$2")
      .replace(/\.0+(e.*)?$/i, "$1")
      .replace(/e\+?/i, "e");
  }

  function syncRangeInputsFromSettings(ds, { force = false } = {}) {
    const b = resolveDisplayControlBand(ds);
    if (b == null) return;
    const s = getBandSettings(ds, b);
    const stats = resolveStats(ds);
    const compositeRaster = ds.lastCompositeRaster && ds.lastCompositeRaster.rasterByBand
      ? ds.lastCompositeRaster.rasterByBand.get(b)
      : null;

    let domMin;
    let domMax;
    if (stats) {
      domMin = stats.min;
      domMax = stats.max;
    } else if (compositeRaster && compositeRaster.dataF32?.length) {
      const est = quickStatsFromArray(compositeRaster.dataF32);
      domMin = est.min;
      domMax = est.max;
    } else if (ds.lastRaster && ds.lastRaster.band === b) {
      const est = quickStatsFromArray(ds.lastRaster.dataF32);
      domMin = est.min;
      domMax = est.max;
    } else {
      domMin = 0;
      domMax = 1;
    }

    if (!Number.isFinite(domMin) || !Number.isFinite(domMax) || domMax === domMin) {
      domMin = 0;
      domMax = 1;
    }

    const curMin = (s.min != null && Number.isFinite(s.min)) ? s.min : (stats ? stats.p1 : domMin);
    const curMax = (s.max != null && Number.isFinite(s.max)) ? s.max : (stats ? stats.p99 : domMax);
    const minVal = clamp(curMin, domMin, domMax);
    const maxVal = clamp(curMax, domMin, domMax);

    if (force || document.activeElement !== els.numMin) els.numMin.value = formatDisplayRangeInput(minVal);
    if (force || document.activeElement !== els.numMax) els.numMax.value = formatDisplayRangeInput(maxVal);

  }

  function updateDisplayUI(force = false) {
    const ds = getActive();
    syncDisplayAdjustButton(ds);
    if (!ds) return;
    const b = resolveDisplayControlBand(ds);
    if (b == null) return;

    const s = getBandSettings(ds, b);
    els.slContrast.value = String(s.contrast ?? 1);
    els.slBrightness.value = String(s.brightness ?? 0);
    els.slGain.value = String(s.gain ?? 1);
    els.numContrast.value = Number(els.slContrast.value).toFixed(2);
    els.numBrightness.value = Number(els.slBrightness.value).toFixed(2);
    els.numGain.value = Number(els.slGain.value).toFixed(2);

    syncRangeInputsFromSettings(ds, { force });
    drawHistogram(ds);
    if (!resolveStats(ds)) requestWholeStatsIfNeeded(ds, b);
  }

  function rebuildBandTree({ preserveScroll = false } = {}) {
    const q = (els.bandSearch.value || "").trim().toLowerCase();
    const prevScroll = preserveScroll ? els.bandTree.scrollTop : 0;
    const bandScrollById = new Map();
    if (preserveScroll) {
      const existingNodes = els.bandTree.querySelectorAll(".tree-ds[data-dsid]");
      for (const node of existingNodes) {
        const id = node.getAttribute("data-dsid");
        const bands = node.querySelector(".tree-bands");
        if (id && bands) bandScrollById.set(id, bands.scrollTop || 0);
      }
    }
    els.bandTree.innerHTML = "";

    for (const ds of state.datasets) {
      if (preserveScroll && bandScrollById.has(ds.id)) {
        ds.treeScrollTop = bandScrollById.get(ds.id);
      }
      const node = document.createElement("div");
      node.className = `tree-ds${ds.id === state.activeId ? " active" : ""}`;
      node.dataset.dsid = ds.id;

      const head = document.createElement("div");
      head.className = "tree-head";

      const caret = document.createElement("button");
      caret.className = "caret";
      caret.textContent = ds.treeExpanded ? "▾" : "▸";
      caret.title = ds.treeExpanded ? "Collapse" : "Expand";
      caret.onclick = (ev) => {
        ev.stopPropagation();
        ds.treeExpanded = !ds.treeExpanded;
        rebuildBandTree({ preserveScroll: true });
      };

      const name = document.createElement("div");
      name.className = "tree-name";
      name.textContent = ds.name;
      name.title = ds.name;

      const meta = document.createElement("div");
      meta.className = "tree-meta";
      meta.textContent = `${ds.meta.bands} bands`;
      const displayMode = getThreeBandDisplayMode(ds);
      const showBands = ds.treeExpanded && !isThreeBandColorMode(ds);

      head.appendChild(caret);
      head.appendChild(name);
      head.appendChild(meta);
      if (isThreeBandDataset(ds)) {
        const modeBtn = document.createElement("button");
        modeBtn.type = "button";
        modeBtn.className = `display-mode-btn mode-${displayMode}`;
        const modeLabel = describeThreeBandDisplayMode(displayMode);
        modeBtn.title = modeLabel;
        modeBtn.ariaLabel = modeLabel;
        modeBtn.setAttribute("aria-pressed", displayMode === THREE_BAND_DISPLAY_MODE_GRAY ? "false" : "true");
        modeBtn.onclick = (ev) => {
          ev.stopPropagation();
          if (ds.id !== state.activeId) setActiveDataset(ds.id, { preserveBandTreeScroll: true });
          cycleDatasetDisplayMode(ds);
        };
        head.appendChild(modeBtn);
      }
      head.onclick = () => {
        if (ds.id !== state.activeId) setActiveDataset(ds.id, { preserveBandTreeScroll: true });
      };
      node.appendChild(head);

      if (showBands) {
        const bandsWrap = document.createElement("div");
        bandsWrap.className = "tree-bands";
        bandsWrap.addEventListener("scroll", () => {
          ds.treeScrollTop = bandsWrap.scrollTop;
        }, { passive: true });
        for (const b of sortedBandIndices(ds)) {
          const wl = ds.meta.wavelengths ? ds.meta.wavelengths[b] : null;
          const label = bandLabel(ds, b);
          if (q) {
            const hay = `${ds.name} ${b} ${label} ${wl != null ? fmtNoGroup(wl) : ""}`.toLowerCase();
            if (!hay.includes(q)) continue;
          }

          const row = document.createElement("div");
          row.className = `band-row${(ds.id === state.activeId && b === resolveActiveBandForDataset(ds)) ? " active" : ""}`;
          row.onclick = () => {
            if (ds.id !== state.activeId) setActiveDataset(ds.id, { preserveBandTreeScroll: true });
            setActiveBand(ds, b);
          };

          const lab = document.createElement("div");
          lab.className = "label";
          lab.textContent = label;
          lab.title = `Band ${b}`;
          row.appendChild(lab);
          bandsWrap.appendChild(row);
        }
        node.appendChild(bandsWrap);
      }

      els.bandTree.appendChild(node);
      if (showBands) {
        const bandsWrap = node.querySelector(".tree-bands");
        if (bandsWrap) {
          const target = Number(ds.treeScrollTop || 0);
          bandsWrap.scrollTop = target;
          requestAnimationFrame(() => {
            bandsWrap.scrollTop = target;
          });
        }
      }
    }

    if (preserveScroll) els.bandTree.scrollTop = prevScroll;
  }

  function setActiveBand(ds, band) {
    if (!ds) return;
    const b = clamp(band | 0, 0, ds.meta.bands - 1);
    const activePanel = (typeof getActivePanel === "function") ? getActivePanel() : null;
    if (activePanel && String(activePanel.datasetId || "") === String(ds.id || "")) {
      activePanel.activeBand = b;
    }
    ds.activeBand = b;
    getBandSettings(ds, b);
    rebuildBandTree({ preserveScroll: true });
    updateDisplayUI(true);
    render();
    requestWholeStatsIfNeeded(ds, b);
    if (onBandChanged) onBandChanged(ds, b);
  }

  function applyRangeFromNumbers(ds) {
    const b = resolveDisplayControlBand(ds);
    if (b == null) return;
    const s = getBandSettings(ds, b);
    const stats = resolveStats(ds);
    if (!stats) return;

    const domMin = stats.min;
    const domMax = stats.max;
    let minVal = Number(els.numMin.value);
    let maxVal = Number(els.numMax.value);
    if (!Number.isFinite(minVal)) minVal = s.min ?? stats.p1;
    if (!Number.isFinite(maxVal)) maxVal = s.max ?? stats.p99;
    if (minVal > maxVal) {
      const tmp = minVal;
      minVal = maxVal;
      maxVal = tmp;
    }

    minVal = clamp(minVal, domMin, domMax);
    maxVal = clamp(maxVal, domMin, domMax);
    s.min = minVal;
    s.max = maxVal;

    syncRangeInputsFromSettings(ds, { force: true });
  }

  function resetDisplay(ds) {
    const b = resolveDisplayControlBand(ds);
    if (b == null) return;
    const s = getBandSettings(ds, b);
    s.min = null;
    s.max = null;
    s.brightness = 0;
    s.gain = 1;
    s.contrast = 1;
    updateDisplayUI(true);
    render({ reuseRaster: true });
  }

  function autoDisplay(ds) {
    const b = resolveDisplayControlBand(ds);
    if (b == null) return;
    const s = getBandSettings(ds, b);
    const stats = ds.bandStatsWhole.get(b) || ds.bandStatsView;
    if (stats) {
      s.min = stats.p1;
      s.max = stats.p99;
    } else {
      s.min = null;
      s.max = null;
    }
    s.brightness = 0;
    s.gain = 1;
    s.contrast = 1;
    updateDisplayUI(true);
    render({ reuseRaster: true });
  }

  function setAppEmptyMode() {
    if (!els.app) return;
    els.app.dataset.empty = state.datasets.length ? "false" : "true";
  }

  function isDatasetRowExpanded(dsId) {
    return !!(dsId && (metaHoverDatasetId === dsId || metaPinnedDatasetId === dsId));
  }

  function refreshDatasetRowExpansion() {
    if (!els.datasetList) return;
    let expandedCount = 0;
    const rows = els.datasetList.querySelectorAll(".ds-item[data-dsid]");
    rows.forEach((row) => {
      const dsId = row.getAttribute("data-dsid");
      const expanded = isDatasetRowExpanded(dsId);
      row.classList.toggle("expanded", expanded);
      if (expanded) expandedCount += 1;
    });
    if (els.datasetDock && els.datasetDock.classList) {
      els.datasetDock.classList.toggle("has-expanded", expandedCount > 0);
    }
  }

  function clearPinnedMetaPanel({ hidePanel = true } = {}) {
    metaPinnedDatasetId = null;
    metaPinnedRowEl = null;
    if (hidePanel) hideMetaHover();
  }

  function syncDatasetTitleOverflow(rowEl) {
    const titleEl = rowEl?.querySelector?.(".title");
    const textEl = rowEl?.querySelector?.(".title-text");
    if (!titleEl || !textEl) return;
    const containerWidth = Number(titleEl.clientWidth) || 0;
    const textWidth = Number(textEl.scrollWidth) || 0;
    const overflow = Math.max(0, Math.ceil(textWidth - containerWidth));
    const isOverflowing = overflow > 2;
    titleEl.classList.toggle("overflowing", isOverflowing);
    if (isOverflowing) {
      titleEl.style.setProperty("--title-marquee-distance", `${overflow + 24}px`);
      titleEl.style.setProperty("--title-marquee-duration", `${Math.max(4, Math.min(14, (overflow + 24) / 32))}s`);
    } else {
      titleEl.style.removeProperty("--title-marquee-distance");
      titleEl.style.removeProperty("--title-marquee-duration");
    }
  }

  function showPinnedMetaPanel(ds, rowEl = null) {
    if (!ds || !els.metaHoverPanel) return;
    metaPinnedDatasetId = ds.id;
    metaPinnedRowEl = rowEl || null;
    metaHoverDatasetId = ds.id;
    renderMetaForDataset(ds);
    showMetaHover(ds, rowEl, { pinned: true });
    refreshDatasetRowExpansion();
    if (rowEl && rowEl.scrollIntoView) {
      try { rowEl.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_err) {}
    }
  }

  function closePinnedMetaPanel() {
    if (!metaPinnedDatasetId) return;
    clearPinnedMetaPanel();
    metaHoverDatasetId = null;
    refreshDatasetRowExpansion();
  }

  function rebuildDatasetList() {
    setAppEmptyMode();
    if (!els.datasetList) return;
    if (els.datasetCount) els.datasetCount.textContent = String(state.datasets.length);
    els.datasetList.innerHTML = "";
    if (metaPinnedDatasetId && !state.datasets.some((d) => d.id === metaPinnedDatasetId)) {
      clearPinnedMetaPanel();
    }
    for (const ds of state.datasets) {
      const div = document.createElement("div");
      div.className = `ds-item${ds.id === state.activeId ? " active" : ""}`;
      div.dataset.dsid = ds.id;
      div.tabIndex = 0;
      div.onclick = () => setActiveDataset(ds.id);

      const left = document.createElement("div");
      left.className = "body";
      const title = document.createElement("div");
      title.className = "title";
      title.title = ds.name;
      const titleText = document.createElement("span");
      titleText.className = "title-text";
      titleText.textContent = ds.name;
      title.appendChild(titleText);
      const meta = document.createElement("div");
      meta.className = "meta";
      const dsInfo = `${fmt(ds.meta.samples)}×${fmt(ds.meta.lines)}  bands:${fmt(ds.meta.bands)}`;
      meta.textContent = dsInfo;
      left.appendChild(title);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "actions";
      const panel1 = Array.isArray(state.displayPanels)
        ? state.displayPanels.find((item) => Number(item?.slot) === 1)
        : null;
      const panel2 = Array.isArray(state.displayPanels)
        ? state.displayPanels.find((item) => Number(item?.slot) === 2)
        : null;
      const overlayActive = (
        state.displayCompositionMode === DISPLAY_COMPOSITION_OVERLAY
        && String(panel1?.datasetId || "") === String(ds.id)
        && String(panel2?.datasetId || "") === String(ds.id)
      );
      const slotButtons = [
        { key: 1, label: displayPanelLabel(1), panel: panel1, title: displayPanelTitle(1) },
        { key: 2, label: displayPanelLabel(2), panel: panel2, title: displayPanelTitle(2) },
        { key: "both", label: "L|R", panel: null, title: "Blend left and right panels" }
      ];
      for (const slotButton of slotButtons) {
        const slot = slotButton.key;
        const panel = slotButton.panel;
        const active = slot === "both"
          ? overlayActive
          : (!!panel && String(panel.datasetId || "") === String(ds.id));
        const colorName = slot === "both"
          ? ""
          : (active ? resolveDisplayLinkColorName(state, slot) : "");
        const independent = slot !== "both" && active && !colorName;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = [
          "slot-btn",
          slot === "both" ? "slot-both" : `slot-panel-${slot}`,
          active ? "active" : "",
          independent ? "independent" : "",
          active && colorName ? `slot-link-${colorName}` : "",
          active && slot === "both" ? "overlay-active" : "",
          active && slot !== "both" && Number(state.activePanelSlot) === slot ? "selected" : ""
        ].filter(Boolean).join(" ");
        btn.title = active
          ? (
            slot === "both"
              ? "Blended across left and right panels"
              : (
                overlayActive
                  ? `${slotButton.title} layer`
                  : (independent ? `${slotButton.title} (independent)` : `${slotButton.title} (linked)`)
              )
          )
          : slotButton.title;
        btn.ariaLabel = btn.title;
        btn.textContent = slotButton.label;
        btn.onclick = (ev) => {
          ev.stopPropagation();
          if (cycleDatasetPanel) cycleDatasetPanel(ds.id, slot, { preserveBandTreeScroll: true });
        };
        actions.appendChild(btn);
      }
      const slotClose = document.createElement("button");
      slotClose.type = "button";
      slotClose.className = "slot-btn slot-close";
      slotClose.title = "Close dataset";
      slotClose.ariaLabel = "Close dataset";
      slotClose.textContent = "X";
      slotClose.onclick = (ev) => {
        ev.stopPropagation();
        closeDataset(ds.id);
      };
      actions.appendChild(slotClose);

      div.appendChild(left);
      div.appendChild(actions);
      div.onmouseenter = () => {
        if (metaPinnedDatasetId && metaPinnedDatasetId !== ds.id) return;
        syncDatasetTitleOverflow(div);
        metaHoverDatasetId = ds.id;
        refreshDatasetRowExpansion();
      };
      div.onmouseleave = () => {
        if (metaPinnedDatasetId === ds.id) return;
        if (metaHoverDatasetId === ds.id) metaHoverDatasetId = null;
        refreshDatasetRowExpansion();
      };
      div.ondblclick = (ev) => {
        ev.stopPropagation();
        showPinnedMetaPanel(ds, div);
      };
      div.onfocus = () => {
        syncDatasetTitleOverflow(div);
        if (metaPinnedDatasetId && metaPinnedDatasetId !== ds.id) return;
        metaHoverDatasetId = ds.id;
        refreshDatasetRowExpansion();
      };
      div.onblur = () => {
        if (metaPinnedDatasetId === ds.id) return;
        if (metaHoverDatasetId === ds.id) metaHoverDatasetId = null;
        refreshDatasetRowExpansion();
      };
      div.onkeydown = (ev) => {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        setActiveDataset(ds.id);
      };
      div.onpointerdown = (ev) => {
        if (ev.pointerType === "touch") {
          try { div.focus({ preventScroll: true }); } catch (_err) { div.focus(); }
        }
        if (ev.pointerType !== "touch") return;
        showPinnedMetaPanel(ds, div);
      };
      els.datasetList.appendChild(div);
      syncDatasetTitleOverflow(div);
      if (metaPinnedDatasetId === ds.id) metaPinnedRowEl = div;
    }
    refreshDatasetRowExpansion();
    els.datasetList.classList.toggle("few", state.datasets.length <= 2);
    if (els.datasetViewport) {
      if (state.datasets.length > 2) {
        requestAnimationFrame(() => {
          els.datasetViewport.scrollTop = Math.max(0, els.datasetViewport.scrollHeight - els.datasetViewport.clientHeight);
        });
      } else {
        els.datasetViewport.scrollTop = 0;
      }
    }
    if (metaPinnedDatasetId) {
      const pinned = state.datasets.find((d) => d.id === metaPinnedDatasetId) || null;
      if (pinned) showMetaHover(pinned, metaPinnedRowEl, { pinned: true });
      else clearPinnedMetaPanel();
    }
  }

  function showMetaHover(ds, rowEl, { pinned = false } = {}) {
    if (!els.metaHoverPanel) return;
    renderMetaForDataset(ds);
    if (pinned) {
      const gap = 10;
      const panelW = Math.max(280, Math.min(420, els.metaHoverPanel.offsetWidth || 340));
      const panelH = Math.max(160, els.metaHoverPanel.offsetHeight || 220);
      const dockRect = (els.datasetDock && els.datasetDock.getBoundingClientRect)
        ? els.datasetDock.getBoundingClientRect()
        : null;
      const rawLeft = dockRect ? (dockRect.right + gap) : gap;
      const left = Math.max(8, Math.min(rawLeft, window.innerWidth - panelW - 8));
      const top = Math.max(8, Math.min(window.innerHeight - panelH - gap, window.innerHeight - 8));
      els.metaHoverPanel.style.left = `${left}px`;
      els.metaHoverPanel.style.top = `${top}px`;
      els.metaHoverPanel.style.right = "auto";
      els.metaHoverPanel.style.bottom = "auto";
    } else if (rowEl) {
      const rowRect = rowEl.getBoundingClientRect();
      const panelW = 340;
      const gap = 8;
      const rawLeft = rowRect.right + gap;
      const rawTop = rowRect.top;
      const left = Math.max(8, Math.min(rawLeft, window.innerWidth - panelW - 8));
      const top = Math.max(8, Math.min(rawTop, window.innerHeight - 220));
      els.metaHoverPanel.style.top = `${top}px`;
      els.metaHoverPanel.style.bottom = "auto";
      els.metaHoverPanel.style.left = `${left}px`;
      els.metaHoverPanel.style.right = "auto";
    }
    els.metaHoverPanel.style.display = "block";
  }

  function hideMetaHover() {
    if (!els.metaHoverPanel) return;
    els.metaHoverPanel.style.display = "none";
  }

  function renderMetaForDataset(ds) {
    if (!ds) {
      els.metaSamples.textContent = "—";
      els.metaLines.textContent = "—";
      els.metaBands.textContent = "—";
      els.metaInterleave.textContent = "—";
      els.metaType.textContent = "—";
      els.metaEndian.textContent = "—";
      els.metaWlUnits.textContent = "—";
      els.metaScale.textContent = "—";
      if (els.metaExpKv) {
        els.metaExpKv.innerHTML = "";
        els.metaExpKv.style.display = "none";
      }
      els.metaExtra.textContent = "—";
      return;
    }
    els.metaSamples.textContent = fmt(ds.meta.samples);
    els.metaLines.textContent = fmt(ds.meta.lines);
    els.metaBands.textContent = fmt(ds.meta.bands);
    els.metaInterleave.textContent = ds.meta.interleave;
    els.metaType.textContent = `${ds.meta.dataType} (${ds.meta.dataTypeInfo.name})`;
    els.metaEndian.textContent = ds.meta.littleEndian ? "little" : "big";
    els.metaWlUnits.textContent = (ds.meta.wlUnits && String(ds.meta.wlUnits).trim()) ? String(ds.meta.wlUnits).trim() : "—";

    const sc = ds.meta.scale;
    if (sc && Number.isFinite(sc.umPerPixelX) && Number.isFinite(sc.umPerPixelY)) {
      const x = Number(sc.umPerPixelX);
      const y = Number(sc.umPerPixelY);
      const same = Math.abs(x - y) <= Math.max(1e-9, Math.abs(x) * 1e-6);
      els.metaScale.textContent = same ? `${fmtNoGroup(x)} µm/px` : `${fmtNoGroup(x)} × ${fmtNoGroup(y)} µm/px`;
      els.metaScale.title = `Parsed from ${sc.source || "header"}`;
    } else {
      els.metaScale.textContent = "—";
      els.metaScale.title = "";
    }
    const expEntries = parseExperimentSettings(ds.meta.desc);
    if (els.metaExpKv) {
      els.metaExpKv.innerHTML = "";
      if (expEntries.length) {
        const frag = document.createDocumentFragment();
        for (const entry of expEntries) {
          const k = document.createElement("div");
          k.className = "k";
          k.textContent = entry.label;
          const v = document.createElement("div");
          v.className = "v";
          v.textContent = entry.value;
          frag.appendChild(k);
          frag.appendChild(v);
        }
        els.metaExpKv.appendChild(frag);
        els.metaExpKv.style.display = "grid";
      } else {
        els.metaExpKv.style.display = "none";
      }
    }

    const expText = formatExperimentSettingsInline(expEntries);
    if (expText) {
      els.metaExtra.textContent = "—";
      return;
    }

    const desc = (ds.meta.desc && String(ds.meta.desc).trim()) ? String(ds.meta.desc).trim() : "";
    els.metaExtra.textContent = desc || "—";
  }

  function updateMetaUI() {
    const ds = metaPinnedDatasetId
      ? (state.datasets.find((item) => item.id === metaPinnedDatasetId) || getActive())
      : getActive();
    renderMetaForDataset(ds);
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("pointerdown", (ev) => {
      if (!metaPinnedDatasetId) return;
      const target = ev.target;
      if (!target || !target.closest) {
        closePinnedMetaPanel();
        return;
      }
      if (metaPinnedRowEl && metaPinnedRowEl.contains(target)) return;
      if (els.metaHoverPanel && els.metaHoverPanel.contains(target)) return;
      closePinnedMetaPanel();
    }, true);
  }

  function detectBrowserHardware() {
    const cores = Number(
      (typeof navigator !== "undefined" && navigator && navigator.hardwareConcurrency)
        ? navigator.hardwareConcurrency
        : 0
    );
    const deviceMemoryGiB = Number(
      (typeof navigator !== "undefined" && navigator && navigator.deviceMemory)
        ? navigator.deviceMemory
        : 0
    );
    return {
      cores: Number.isFinite(cores) && cores > 0 ? Math.max(1, Math.floor(cores)) : 0,
      deviceMemoryGiB: Number.isFinite(deviceMemoryGiB) && deviceMemoryGiB > 0 ? deviceMemoryGiB : 0
    };
  }

  function buildPerfDetail(ds, chunkCap, pyramidCap, ioStats, rasterStats, pyramidStats, renderStats) {
    const hardware = detectBrowserHardware();
    const lines = [
      `Browser: ${hardware.cores ? fmtNoGroup(hardware.cores) : "n/a"} cores, ${hardware.deviceMemoryGiB ? `${fmtNoGroup(hardware.deviceMemoryGiB)} GiB deviceMemory` : "deviceMemory n/a"}`,
      `Budgets: ${cacheBudget?.totalBytes ? humanBytes(cacheBudget.totalBytes) : "n/a"} total from ${cacheBudget?.detectedBudgetBasisBytes ? humanBytes(cacheBudget.detectedBudgetBasisBytes) : "n/a"} basis, dataset ${humanBytes(chunkCap)} chunk + ${humanBytes(pyramidCap)} pyramid`,
      `Source: ${humanBytes(ioStats.bytesRead || 0)} in ${fmtNoGroup(ioStats.readCalls || 0)} read / ${fmtNoGroup(ioStats.readIntoCalls || 0)} readInto`,
      `Chunk cache: ${fmtNoGroup(ioStats.cacheHits || 0)} hits / ${fmtNoGroup(ioStats.cacheMisses || 0)} misses / ${fmtNoGroup(ioStats.cacheEvictions || 0)} evictions`,
      `Raster decode: ${fmtNoGroup(rasterStats.windowCalls || 0)} windows, ${fmtNoGroup(rasterStats.slabWindowCalls || 0)} slab, ${fmtNoGroup(rasterStats.rowWindowCalls || 0)} row, ${(Number(rasterStats.windowReadMs) || 0).toFixed(1)} ms`,
      `Pyramid: ${fmtNoGroup(pyramidStats.tileReads || 0)} tile reads, ${fmtNoGroup(pyramidStats.tilesComposed || 0)} tiles composed, ${(Number(pyramidStats.composeMs) || 0).toFixed(1)} ms`,
      `Renderer: ${fmtNoGroup(renderStats.pyramidHits || 0)} pyramid hits / ${fmtNoGroup(renderStats.pyramidMisses || 0)} direct fallbacks, ${(Number(renderStats.directReadMs) || 0).toFixed(1)} ms direct`
    ];
    if (ds?.meta?.sourceFormat === "tiff") {
      lines.splice(2, 0, `TIFF: ${String(ds.ds?.profileName || "standard")} profile, ${humanBytes(Number(ds.ds?.rawCacheLimitBytes || ds.ds?.rawSource?.maxBytes || 0))} raw + ${humanBytes(Number(ds.ds?.decodedCacheLimitBytes || ds.ds?.decodedCache?.maxBytes || 0))} decoded, ${fmtNoGroup(Number(ds.ds?.workerPoolSize || 0))} workers, ${fmtNoGroup(Number(ds.ds?.taskConcurrency || 0))} tasks`);
    }
    return lines.join("\n");
  }

  function updatePerf() {
    if (!els.perfBarCacheText || !els.perfBarCacheFill) return;
    const ds = getActive();
    if (!ds) {
      els.perfBarCacheText.textContent = "Cache: 0 B / 0 B";
      els.perfBarCacheFill.style.width = "0%";
      const hardware = detectBrowserHardware();
      const detail = `Browser: ${hardware.cores ? fmtNoGroup(hardware.cores) : "n/a"} cores, ${hardware.deviceMemoryGiB ? `${fmtNoGroup(hardware.deviceMemoryGiB)} GiB deviceMemory` : "deviceMemory n/a"}\nBudgets: ${cacheBudget?.totalBytes ? humanBytes(cacheBudget.totalBytes) : "n/a"} total from ${cacheBudget?.detectedBudgetBasisBytes ? humanBytes(cacheBudget.detectedBudgetBasisBytes) : "n/a"} basis`;
      els.perfBarCacheText.title = detail;
      els.perfBarCacheFill.title = detail;
      return;
    }
    const chunkUsed = ds.ds.cacheBytes ? ds.ds.cacheBytes() : 0;
    const pyramidUsed = ds.pyramid ? ds.pyramid.totalBytes : 0;

    const chunkCap = (ds.ds && ds.ds.maxBytes) ? ds.ds.maxBytes : 0;
    const pyramidCap = (ds.pyramid && ds.pyramid.limitBytes) ? ds.pyramid.limitBytes : 0;
    const cap = Math.max(1, chunkCap + pyramidCap);
    const used = chunkUsed + pyramidUsed;
    const frac = clamp(used / cap, 0, 1);
    els.perfBarCacheFill.style.width = `${(frac * 100).toFixed(1)}%`;
    els.perfBarCacheText.textContent = `Cache: ${humanBytes(used)} / ${humanBytes(cap)}`;
    const ioStats = ds.ds?.stats || {};
    const rasterStats = ioStats.raster || {};
    const pyramidStats = ds.pyramid?.stats || {};
    const renderStats = ds.renderStats || {};
    const detail = buildPerfDetail(ds, chunkCap, pyramidCap, ioStats, rasterStats, pyramidStats, renderStats);
    els.perfBarCacheText.title = detail;
    els.perfBarCacheFill.title = detail;
  }

  return {
    rebuildDatasetList,
    updateMetaUI,
    updatePerf,
    rebuildBandTree,
    getBandSettings,
    resolveDisplayControlBand,
    resolveStats,
    setActiveBand,
    updateDisplayUI,
    syncRangeInputsFromSettings,
    applyRangeFromNumbers,
    resetDisplay,
    autoDisplay,
    cycleDisplayAdjustColor
  };
}
