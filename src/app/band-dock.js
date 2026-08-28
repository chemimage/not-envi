import {
  getThreeBandDisplayMode,
  isThreeBandColorMode,
  isThreeBandDataset
} from "./three-band-display.js";

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactNumber(value) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs > 0 && (abs >= 100000 || abs < 0.001)) return value.toExponential(3);
  return String(Number(value.toFixed(4)));
}

export function buildBandDockEntries(ds, bandLabel = (_dataset, band) => `Band ${band}`) {
  const count = Math.max(0, Math.floor(Number(ds?.meta?.bands) || 0));
  const wavelengths = Array.isArray(ds?.meta?.wavelengths) ? ds.meta.wavelengths : null;
  const numericWavelengths = wavelengths && wavelengths.length >= count
    ? Array.from({ length: count }, (_unused, band) => finiteNumber(wavelengths[band]))
    : null;
  const hasNumericWavelengths = !!numericWavelengths && numericWavelengths.every((value) => value != null);
  const entries = Array.from({ length: count }, (_unused, band) => {
    const value = hasNumericWavelengths ? numericWavelengths[band] : band;
    return {
      band,
      value,
      label: hasNumericWavelengths ? compactNumber(value) : String(bandLabel(ds, band)),
      hasWavenumber: hasNumericWavelengths
    };
  });
  entries.sort((a, b) => (a.value - b.value) || (a.band - b.band));
  const minValue = entries[0]?.value ?? 0;
  const maxValue = entries[entries.length - 1]?.value ?? minValue;
  const span = maxValue - minValue;
  for (let index = 0; index < entries.length; index += 1) {
    entries[index].fraction = span > 0
      ? (entries[index].value - minValue) / span
      : (entries.length > 1 ? index / (entries.length - 1) : 0.5);
    entries[index].order = index;
  }
  return entries;
}

export function pickBandAtFraction(entries, fraction) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const target = Math.min(1, Math.max(0, Number(fraction) || 0));
  let best = entries[0];
  let bestDistance = Math.abs(best.fraction - target);
  for (let index = 1; index < entries.length; index += 1) {
    const candidate = entries[index];
    const distance = Math.abs(candidate.fraction - target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best.band;
}

export function representativeBandEntries(entries, maxTicks, importantBands = []) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const limit = Math.max(2, Math.floor(Number(maxTicks) || 2));
  if (entries.length <= limit) return entries.slice();
  const selectedOrders = new Set([0, entries.length - 1]);
  for (let index = 0; index < limit; index += 1) {
    selectedOrders.add(Math.round((index * (entries.length - 1)) / Math.max(1, limit - 1)));
  }
  for (const band of importantBands) {
    const found = entries.find((entry) => entry.band === band);
    if (found) selectedOrders.add(found.order);
  }
  return Array.from(selectedOrders)
    .sort((a, b) => a - b)
    .map((order) => entries[order]);
}

export function closestBandForLinkedDataset(sourceEntry, targetDs, fallbackBand = 0) {
  const targetEntries = buildBandDockEntries(targetDs);
  if (!targetEntries.length) return null;
  if (sourceEntry?.hasWavenumber && targetEntries.every((entry) => entry.hasWavenumber)) {
    let best = targetEntries[0];
    let distance = Math.abs(best.value - sourceEntry.value);
    for (let index = 1; index < targetEntries.length; index += 1) {
      const nextDistance = Math.abs(targetEntries[index].value - sourceEntry.value);
      if (nextDistance < distance) {
        best = targetEntries[index];
        distance = nextDistance;
      }
    }
    return best.band;
  }
  return Math.min(targetEntries.length - 1, Math.max(0, Math.floor(Number(fallbackBand) || 0)));
}

export function createBandDockController(deps) {
  const {
    els,
    getActive,
    bandLabel,
    onSelectBand,
    onCycleColorMode
  } = deps;
  const selector = els?.bandSelector;
  const track = els?.bandDockTrack;
  const valueOutput = els?.bandDockValue;
  let entries = [];
  let datasetId = null;
  let hoverBand = null;
  let draggingPointerId = null;

  function activeBand(ds) {
    const band = Number(ds?.activeBand);
    if (!entries.length) return null;
    if (!Number.isFinite(band)) return entries[0].band;
    return entries.some((entry) => entry.band === band) ? band : entries[0].band;
  }

  function entryForBand(band) {
    return entries.find((entry) => entry.band === band) || null;
  }

  function trackFraction(clientX) {
    if (!track || typeof track.getBoundingClientRect !== "function") return 0;
    const rect = track.getBoundingClientRect();
    const width = Number(rect.width) || Number(track.clientWidth) || 1;
    return Math.min(1, Math.max(0, (Number(clientX) - Number(rect.left || 0)) / width));
  }

  function maxVisibleTicks() {
    const width = Number(track?.clientWidth) || Number(track?.getBoundingClientRect?.().width) || 240;
    return Math.max(12, Math.min(64, Math.floor(width / 6)));
  }

  function positionValue(entry) {
    if (!entry || !valueOutput) return;
    const selectorRect = selector?.getBoundingClientRect?.();
    const trackRect = track?.getBoundingClientRect?.();
    if (selectorRect && trackRect && Number(trackRect.width) > 0) {
      const raw = (Number(trackRect.left) - Number(selectorRect.left)) + (entry.fraction * Number(trackRect.width));
      const estimatedWidth = Math.min(132, Math.max(28, (String(entry.label || "").length * 11) + 12));
      const valueWidth = Number(valueOutput.offsetWidth) || estimatedWidth;
      const halfWidth = (valueWidth / 2) + 4;
      const rightReserve = els.bandDock?.classList?.contains("has-color-mode") ? 48 : 0;
      const min = halfWidth;
      const max = Math.max(min, Number(selectorRect.width) - rightReserve - halfWidth);
      valueOutput.style.left = `${Math.min(max, Math.max(min, raw))}px`;
    } else {
      valueOutput.style.left = `${Math.min(92, Math.max(8, entry.fraction * 100))}%`;
    }
  }

  function renderTicks(ds) {
    if (!track) return;
    const selectedBand = activeBand(ds);
    const focusBand = hoverBand == null ? selectedBand : hoverBand;
    const showMagnification = hoverBand != null
      || draggingPointerId != null
      || (typeof document !== "undefined" && document.activeElement === selector);
    const displayEntry = entryForBand(focusBand);
    const focusEntry = showMagnification ? displayEntry : null;
    const importantBands = [selectedBand, focusBand];
    if (focusEntry) {
      for (const delta of [-2, -1, 1, 2]) {
        const neighbor = entries[focusEntry.order + delta];
        if (neighbor) importantBands.push(neighbor.band);
      }
    }
    const visible = representativeBandEntries(entries, maxVisibleTicks(), importantBands);
    track.replaceChildren();
    for (const entry of visible) {
      const tick = document.createElement("span");
      tick.className = "band-dock-tick";
      if (entry.band === selectedBand) tick.classList.add("active");
      if (focusEntry && entry.band === focusBand) tick.classList.add("hovered");
      const orderDistance = focusEntry ? Math.abs(entry.order - focusEntry.order) : Number.POSITIVE_INFINITY;
      const scale = orderDistance === 0 ? 3 : (orderDistance === 1 ? 2.15 : (orderDistance === 2 ? 1.45 : 1));
      tick.style.setProperty("--band-tick-x", `${entry.fraction * 100}%`);
      tick.style.setProperty("--band-tick-scale", String(scale));
      track.appendChild(tick);
    }
    if (displayEntry && valueOutput) {
      valueOutput.value = displayEntry.label;
      valueOutput.textContent = displayEntry.label;
      positionValue(displayEntry);
    }
  }

  function sync() {
    if (!selector || !track) return;
    const ds = getActive?.() || null;
    if (!ds) {
      entries = [];
      datasetId = null;
      hoverBand = null;
      track.replaceChildren();
      return;
    }
    if (String(datasetId || "") !== String(ds.id || "")) {
      datasetId = ds.id;
      hoverBand = null;
    }
    entries = buildBandDockEntries(ds, bandLabel);
    const first = entries[0];
    const last = entries[entries.length - 1];
    if (els.bandDockMin) {
      els.bandDockMin.textContent = first?.label || "—";
      els.bandDockMin.title = first?.label || "";
    }
    if (els.bandDockMax) {
      els.bandDockMax.textContent = last?.label || "—";
      els.bandDockMax.title = last?.label || "";
    }
    const colorCapable = isThreeBandDataset(ds);
    const locked = isThreeBandColorMode(ds);
    els.bandDock?.classList?.toggle("has-color-mode", colorCapable);
    selector.classList.toggle("locked", locked);
    selector.setAttribute("aria-disabled", locked ? "true" : "false");
    const selected = entryForBand(activeBand(ds));
    selector.setAttribute("aria-valuemin", "0");
    selector.setAttribute("aria-valuemax", String(Math.max(0, entries.length - 1)));
    selector.setAttribute("aria-valuenow", String(selected?.order ?? 0));
    selector.setAttribute("aria-valuetext", selected?.label || "—");
    if (els.bandColorMode) {
      const mode = getThreeBandDisplayMode(ds);
      const label = mode === "rgb" ? "RGB" : (mode === "bgr" ? "BGR" : "Gray");
      els.bandColorMode.textContent = label;
      els.bandColorMode.className = `band-color-mode mode-${mode}`;
      els.bandColorMode.title = locked
        ? `${label} color composite; click to change display mode`
        : "Gray bands; click to enable a color composite";
      els.bandColorMode.ariaLabel = els.bandColorMode.title;
      els.bandColorMode.setAttribute("aria-pressed", locked ? "true" : "false");
    }
    renderTicks(ds);
  }

  function selectAt(clientX) {
    const ds = getActive?.() || null;
    if (!ds || isThreeBandColorMode(ds)) return;
    const band = pickBandAtFraction(entries, trackFraction(clientX));
    if (band == null) return;
    hoverBand = band;
    if (activeBand(ds) !== band) onSelectBand?.(ds, band);
    else renderTicks(ds);
  }

  if (selector) {
    selector.addEventListener("pointerenter", (event) => {
      const ds = getActive?.() || null;
      if (!ds || isThreeBandColorMode(ds)) return;
      selector.classList.add("hovering");
      hoverBand = pickBandAtFraction(entries, trackFraction(event.clientX));
      renderTicks(ds);
    });
    selector.addEventListener("pointermove", (event) => {
      const ds = getActive?.() || null;
      if (!ds || isThreeBandColorMode(ds)) return;
      if (draggingPointerId != null && event.pointerId === draggingPointerId) {
        selectAt(event.clientX);
        return;
      }
      hoverBand = pickBandAtFraction(entries, trackFraction(event.clientX));
      renderTicks(ds);
    });
    selector.addEventListener("pointerleave", () => {
      if (draggingPointerId != null) return;
      hoverBand = null;
      selector.classList.remove("hovering");
      renderTicks(getActive?.() || null);
    });
    selector.addEventListener("pointerdown", (event) => {
      const ds = getActive?.() || null;
      if (!ds || isThreeBandColorMode(ds)) return;
      event.preventDefault();
      draggingPointerId = event.pointerId;
      selector.classList.add("dragging", "hovering");
      try { selector.setPointerCapture(event.pointerId); } catch (_err) {}
      selectAt(event.clientX);
    });
    const finishDrag = (event) => {
      if (draggingPointerId == null || event.pointerId !== draggingPointerId) return;
      try { selector.releasePointerCapture(event.pointerId); } catch (_err) {}
      draggingPointerId = null;
      selector.classList.remove("dragging");
    };
    selector.addEventListener("pointerup", finishDrag);
    selector.addEventListener("pointercancel", finishDrag);
    selector.addEventListener("keydown", (event) => {
      const ds = getActive?.() || null;
      if (!ds || isThreeBandColorMode(ds) || !entries.length) return;
      const current = entryForBand(activeBand(ds)) || entries[0];
      let order = current.order;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") order -= 1;
      else if (event.key === "ArrowRight" || event.key === "ArrowUp") order += 1;
      else if (event.key === "Home") order = 0;
      else if (event.key === "End") order = entries.length - 1;
      else return;
      event.preventDefault();
      const next = entries[Math.min(entries.length - 1, Math.max(0, order))];
      hoverBand = next.band;
      onSelectBand?.(ds, next.band);
    });
  }

  els?.bandColorMode?.addEventListener("click", (event) => {
    event.stopPropagation();
    const ds = getActive?.() || null;
    if (!ds || !isThreeBandDataset(ds)) return;
    onCycleColorMode?.(ds);
    sync();
  });

  if (selector && typeof window !== "undefined") window.addEventListener("resize", sync, { passive: true });

  return { sync };
}
