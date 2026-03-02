import { createIcons, X } from "lucide";

import { formatExperimentSettingsInline, parseExperimentSettings } from "./experiment-meta.js";

export function createUIPanels(deps) {
  const {
    state,
    els,
    getActive,
    clamp,
    fmt,
    fmtNoGroup,
    humanBytes,
    bandLabel,
    setActiveDataset,
    closeDataset,
    drawHistogram,
    render,
    quickStatsFromArray,
    onNeedWholeStats
  } = deps;

  function getBandSettings(ds, band) {
    if (!ds.bandSettings.has(band)) {
      ds.bandSettings.set(band, { min: null, max: null, brightness: 0, gain: 1, contrast: 1, gamma: 1 });
    }
    return ds.bandSettings.get(band);
  }

  function resolveStats(ds) {
    const band = ds.activeBand;
    if (band == null) return null;
    if (state.histMode === "view") return ds.bandStatsView;
    return ds.bandStatsWhole.get(band) || null;
  }

  function syncRangeInputsFromSettings(ds, { force = false } = {}) {
    const b = ds.activeBand;
    if (b == null) return;
    const s = getBandSettings(ds, b);
    const stats = resolveStats(ds);

    let domMin;
    let domMax;
    if (stats) {
      domMin = stats.min;
      domMax = stats.max;
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

    if (force || document.activeElement !== els.numMin) els.numMin.value = fmt(minVal);
    if (force || document.activeElement !== els.numMax) els.numMax.value = fmt(maxVal);

  }

  function updateDisplayUI(force = false) {
    const ds = getActive();
    if (!ds || ds.activeBand == null) {
      els.dispDataset.textContent = "—";
      els.dispBand.textContent = "—";
      els.dispWl.textContent = "—";
      return;
    }
    const b = ds.activeBand;
    els.dispDataset.textContent = ds.name;
    els.dispBand.textContent = bandLabel(ds, b);
    els.dispBand.title = `Band index ${b}`;
    const wl = ds.meta.wavelengths ? ds.meta.wavelengths[b] : null;
    els.dispWl.textContent = (wl != null ? fmtNoGroup(wl) : "—") + (ds.meta.wlUnits ? ` ${ds.meta.wlUnits}` : "");

    const s = getBandSettings(ds, b);
    els.slContrast.value = String(s.contrast ?? 1);
    els.slBrightness.value = String(s.brightness ?? 0);
    els.slGain.value = String(s.gain ?? 1);
    els.numContrast.value = Number(els.slContrast.value).toFixed(2);
    els.numBrightness.value = Number(els.slBrightness.value).toFixed(2);
    els.numGain.value = Number(els.slGain.value).toFixed(2);

    syncRangeInputsFromSettings(ds, { force });
    drawHistogram(ds);
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

      head.appendChild(caret);
      head.appendChild(name);
      head.appendChild(meta);
      head.onclick = () => {
        if (ds.id !== state.activeId) setActiveDataset(ds.id, { preserveBandTreeScroll: true });
      };
      node.appendChild(head);

      if (ds.treeExpanded) {
        const bandsWrap = document.createElement("div");
        bandsWrap.className = "tree-bands";
        bandsWrap.addEventListener("scroll", () => {
          ds.treeScrollTop = bandsWrap.scrollTop;
        }, { passive: true });
        for (let b = 0; b < ds.meta.bands; b++) {
          const wl = ds.meta.wavelengths ? ds.meta.wavelengths[b] : null;
          const label = bandLabel(ds, b);
          if (q) {
            const hay = `${ds.name} ${b} ${label} ${wl != null ? fmtNoGroup(wl) : ""}`.toLowerCase();
            if (!hay.includes(q)) continue;
          }

          const row = document.createElement("div");
          row.className = `band-row${(ds.id === state.activeId && b === ds.activeBand) ? " active" : ""}`;
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
      if (ds.treeExpanded) {
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
    ds.activeBand = b;
    getBandSettings(ds, b);
    rebuildBandTree({ preserveScroll: true });
    updateDisplayUI(true);
    render();
    if (!ds.bandStatsWhole.has(b)) onNeedWholeStats(ds, b);
  }

  function applyRangeFromNumbers(ds) {
    const b = ds.activeBand;
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

    syncRangeInputsFromSettings(ds);
  }

  function resetDisplay(ds) {
    const b = ds.activeBand;
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
    const b = ds.activeBand;
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

  function rebuildDatasetList() {
    els.datasetCount.textContent = String(state.datasets.length);
    els.datasetList.innerHTML = "";
    for (const ds of state.datasets) {
      const div = document.createElement("div");
      div.className = `ds-item${ds.id === state.activeId ? " active" : ""}`;
      div.onclick = () => setActiveDataset(ds.id);

      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = ds.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      const dsInfo = `${ds.meta.samples}×${ds.meta.lines}  bands:${ds.meta.bands}  ${ds.meta.interleave}`;
      meta.textContent = dsInfo;
      left.appendChild(title);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "actions";
      const btnClose = document.createElement("button");
      btnClose.className = "btn danger icon-btn";
      btnClose.title = "Close dataset";
      btnClose.ariaLabel = "Close dataset";
      btnClose.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>';
      btnClose.onclick = (ev) => {
        ev.stopPropagation();
        closeDataset(ds.id);
      };
      actions.appendChild(btnClose);

      div.appendChild(left);
      div.appendChild(actions);
      div.onmouseenter = () => {
        showMetaHover(ds, div);
      };
      div.onmouseleave = () => {
        hideMetaHover();
      };
      els.datasetList.appendChild(div);
    }
    createIcons({ icons: { X }, attrs: { "aria-hidden": "true" } });
  }

  function showMetaHover(ds, rowEl) {
    if (!els.metaHoverPanel) return;
    renderMetaForDataset(ds);
    if (rowEl) {
      const rowRect = rowEl.getBoundingClientRect();
      const panelW = 340;
      const gap = 8;
      const rawLeft = rowRect.right + gap;
      const rawTop = rowRect.top;
      const left = Math.max(8, Math.min(rawLeft, window.innerWidth - panelW - 8));
      const top = Math.max(8, Math.min(rawTop, window.innerHeight - 220));
      els.metaHoverPanel.style.top = `${top}px`;
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
    const ds = getActive();
    renderMetaForDataset(ds);
  }

  function updatePerf() {
    const ds = getActive();
    if (!ds) {
      els.perfBarCacheText.textContent = "Cache: 0 B / 0 B";
      els.perfBarCacheFill.style.width = "0%";
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
  }

  return {
    rebuildDatasetList,
    updateMetaUI,
    updatePerf,
    rebuildBandTree,
    getBandSettings,
    resolveStats,
    setActiveBand,
    updateDisplayUI,
    syncRangeInputsFromSettings,
    applyRangeFromNumbers,
    resetDisplay,
    autoDisplay
  };
}
