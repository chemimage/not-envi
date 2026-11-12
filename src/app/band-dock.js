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

function closestEntryAtFraction(entries, fraction) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const target = Math.min(1, Math.max(0, Number(fraction) || 0));
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].fraction < target) low = middle + 1;
    else high = middle - 1;
  }
  const right = entries[Math.min(entries.length - 1, low)];
  const left = entries[Math.max(0, low - 1)];
  return Math.abs(left.fraction - target) <= Math.abs(right.fraction - target) ? left : right;
}

export function pickBandAtFraction(entries, fraction) {
  return closestEntryAtFraction(entries, fraction)?.band ?? null;
}

export function representativeBandEntries(entries, maxTicks, importantBands = []) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const limit = Math.max(2, Math.floor(Number(maxTicks) || 2));
  if (entries.length <= limit) return entries.slice();
  const selectedOrders = new Set([0, entries.length - 1]);
  for (let index = 0; index < limit; index += 1) {
    const targetFraction = index / Math.max(1, limit - 1);
    const closest = closestEntryAtFraction(entries, targetFraction);
    selectedOrders.add(closest.order);
  }
  for (const band of importantBands) {
    const found = entries.find((entry) => entry.band === band);
    if (found) selectedOrders.add(found.order);
  }
  return Array.from(selectedOrders)
    .sort((a, b) => a - b)
    .map((order) => entries[order]);
}

export function bandDockMagnificationScale(entryFraction, focusFraction, radius = 0.12) {
  const entry = finiteNumber(entryFraction);
  const focus = finiteNumber(focusFraction);
  const falloffRadius = Math.max(0.001, finiteNumber(radius) ?? 0.12);
  if (entry == null || focus == null) return 1;
  const normalizedDistance = Math.abs(entry - focus) / falloffRadius;
  if (normalizedDistance >= 1) return 1;
  const influence = (1 + Math.cos(Math.PI * normalizedDistance)) / 2;
  return 1 + (2 * influence);
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
  const previewOutput = els?.bandDockPreview;
  const input = els?.bandDockInput;
  const candidates = els?.bandDockCandidates;
  let entries = [];
  let datasetId = null;
  let hoverBand = null;
  let hoverFraction = null;
  let draggingPointerId = null;
  let pressStart = null;
  let lastClick = null;
  let editing = false;

  function matchingEntries(query) {
    const typed = query.trim().toLowerCase();
    return typed ? entries.filter((entry) => entry.label.toLowerCase().includes(typed)).slice(0, 8) : [];
  }

  function renderCandidates() {
    if (!candidates || !input) return;
    const matches = matchingEntries(input.value);
    candidates.replaceChildren(...matches.map((entry) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "band-dock-candidate";
      option.setAttribute("role", "option");
      option.textContent = entry.label;
      option.addEventListener("pointerdown", (event) => event.preventDefault());
      option.addEventListener("click", () => finishEditing(entry));
      return option;
    }));
    candidates.hidden = !matches.length;
  }

  function finishEditing(entry = null) {
    if (!editing) return;
    const ds = getActive?.() || null;
    editing = false;
    lastClick = null;
    selector.classList.remove("editing");
    if (input) input.hidden = true;
    if (candidates) candidates.hidden = true;
    hoverBand = null;
    hoverFraction = null;
    if (entry && ds && activeBand(ds) !== entry.band) onSelectBand?.(ds, entry.band);
    else renderTicks(ds);
  }

  function submitEditing() {
    const query = input?.value.trim() || "";
    if (!query) return finishEditing();
    const exact = entries.find((entry) => entry.label.toLowerCase() === query.toLowerCase());
    const matches = matchingEntries(query);
    let entry = exact || matches[0];
    if (!entry) {
      const target = Number(query);
      if (!Number.isFinite(target)) return;
      entry = entries.reduce((best, next) =>
        !best || Math.abs(next.value - target) < Math.abs(best.value - target) ? next : best, null);
    }
    finishEditing(entry);
  }

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

  function positionOutput(output, entry) {
    if (!entry || !output) return;
    const selectorRect = selector?.getBoundingClientRect?.();
    const trackRect = track?.getBoundingClientRect?.();
    if (selectorRect && trackRect && Number(trackRect.width) > 0) {
      const raw = (Number(trackRect.left) - Number(selectorRect.left)) + (entry.fraction * Number(trackRect.width));
      const estimatedWidth = Math.min(132, Math.max(28, (String(entry.label || "").length * 11) + 12));
      const valueWidth = Number(output.offsetWidth) || estimatedWidth;
      const halfWidth = (valueWidth / 2) + 4;
      const rightReserve = els.bandDock?.classList?.contains("has-color-mode") ? 48 : 0;
      const min = halfWidth;
      const max = Math.max(min, Number(selectorRect.width) - rightReserve - halfWidth);
      output.style.left = `${Math.min(max, Math.max(min, raw))}px`;
    } else {
      output.style.left = `${Math.min(92, Math.max(8, entry.fraction * 100))}%`;
    }
  }

  function renderTicks(ds) {
    if (!track) return;
    const selectedBand = activeBand(ds);
    const selectedEntry = entryForBand(selectedBand);
    const focusBand = hoverBand == null ? selectedBand : hoverBand;
    const showMagnification = hoverBand != null
      || draggingPointerId != null
      || (typeof document !== "undefined" && document.activeElement === selector);
    const displayEntry = entryForBand(focusBand);
    const focusEntry = showMagnification ? displayEntry : null;
    const importantBands = [selectedBand, focusBand];
    const visible = representativeBandEntries(entries, maxVisibleTicks(), importantBands);
    const existingTicks = new Map(Array.from(track.querySelectorAll(".band-dock-tick"))
      .map((tick) => [tick.dataset.band, tick]));
    const visibleBands = new Set();
    const magnificationCenter = showMagnification
      ? (finiteNumber(hoverFraction) ?? focusEntry?.fraction ?? null)
      : selectedEntry?.fraction ?? null;
    for (const entry of visible) {
      const key = String(entry.band);
      visibleBands.add(key);
      const tick = existingTicks.get(key) || document.createElement("span");
      tick.className = "band-dock-tick";
      tick.dataset.band = key;
      if (entry.band === selectedBand) tick.classList.add("active");
      if (focusEntry && focusBand !== selectedBand && entry.band === focusBand) tick.classList.add("hovered");
      const scale = bandDockMagnificationScale(entry.fraction, magnificationCenter);
      if (focusEntry && focusBand !== selectedBand && entry.band !== selectedBand && scale > 1.02) {
        tick.classList.add("preview-neighbor");
      }
      tick.style.setProperty("--band-tick-x", `${entry.fraction * 100}%`);
      tick.style.setProperty("--band-tick-scale", String(scale));
      track.appendChild(tick);
    }
    for (const [band, tick] of existingTicks) {
      if (!visibleBands.has(band)) tick.remove();
    }
    if (selectedEntry && valueOutput) {
      valueOutput.value = selectedEntry.label;
      valueOutput.textContent = selectedEntry.label;
      positionOutput(valueOutput, selectedEntry);
    }
    const showPreview = !!(focusEntry && displayEntry && displayEntry.band !== selectedBand);
    selector?.classList?.toggle("previewing", showPreview);
    if (showPreview && previewOutput) {
      previewOutput.value = displayEntry.label;
      previewOutput.textContent = displayEntry.label;
      positionOutput(previewOutput, displayEntry);
    }
  }

  function sync() {
    if (!selector || !track) return;
    const ds = getActive?.() || null;
    if (!ds) {
      finishEditing();
      entries = [];
      datasetId = null;
      hoverBand = null;
      hoverFraction = null;
      selector.classList.remove("previewing");
      track.replaceChildren();
      return;
    }
    if (String(datasetId || "") !== String(ds.id || "")) {
      finishEditing();
      datasetId = ds.id;
      hoverBand = null;
      hoverFraction = null;
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
    els.bandDock?.classList?.toggle("is-composite", locked);
    selector.classList.toggle("locked", locked);
    selector.setAttribute("role", locked ? "group" : "slider");
    selector.setAttribute("aria-label", locked ? "Color composite" : "Current image wavenumber");
    selector.tabIndex = locked ? -1 : 0;
    selector.setAttribute("aria-disabled", locked ? "true" : "false");
    const selected = entryForBand(activeBand(ds));
    if (locked) {
      for (const name of ["aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"]) selector.removeAttribute(name);
    } else {
      selector.setAttribute("aria-valuemin", "0");
      selector.setAttribute("aria-valuemax", String(Math.max(0, entries.length - 1)));
      selector.setAttribute("aria-valuenow", String(selected?.order ?? 0));
      selector.setAttribute("aria-valuetext", selected?.label || "—");
    }
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

  function previewAt(clientX) {
    const ds = getActive?.() || null;
    if (!ds || isThreeBandColorMode(ds)) return;
    const fraction = trackFraction(clientX);
    const band = pickBandAtFraction(entries, fraction);
    if (band == null) return;
    const unchanged = hoverBand === band && hoverFraction === fraction;
    hoverBand = band;
    hoverFraction = fraction;
    if (unchanged) return;
    renderTicks(ds);
  }

  if (selector) {
    input?.addEventListener("input", renderCandidates);
    input?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); submitEditing(); }
      else if (event.key === "Escape") { event.preventDefault(); finishEditing(); }
    });
    input?.addEventListener("blur", () => finishEditing());
    selector.addEventListener("pointerenter", (event) => {
      if (editing) return;
      const ds = getActive?.() || null;
      if (!ds || isThreeBandColorMode(ds)) return;
      selector.classList.add("hovering");
      hoverFraction = trackFraction(event.clientX);
      hoverBand = pickBandAtFraction(entries, hoverFraction);
      renderTicks(ds);
    });
    selector.addEventListener("pointermove", (event) => {
      if (editing) return;
      const ds = getActive?.() || null;
      if (!ds || isThreeBandColorMode(ds)) return;
      if (draggingPointerId != null && event.pointerId === draggingPointerId) {
        previewAt(event.clientX);
        return;
      }
      const nextFraction = trackFraction(event.clientX);
      const nextBand = pickBandAtFraction(entries, nextFraction);
      if (nextBand === hoverBand && nextFraction === hoverFraction) return;
      hoverBand = nextBand;
      hoverFraction = nextFraction;
      renderTicks(ds);
    });
    selector.addEventListener("pointerleave", () => {
      if (draggingPointerId != null) return;
      hoverBand = null;
      hoverFraction = null;
      selector.classList.remove("hovering");
      renderTicks(getActive?.() || null);
    });
    selector.addEventListener("pointerdown", (event) => {
      if (editing) return;
      const ds = getActive?.() || null;
      if (!ds || isThreeBandColorMode(ds)) return;
      event.preventDefault();
      const now = Date.now();
      if (input && lastClick && now - lastClick.time < 500
        && Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) < 12
        && event.pointerType === lastClick.pointerType) {
        lastClick = null;
        editing = true;
        selector.classList.add("editing");
        hoverBand = null;
        hoverFraction = null;
        input.hidden = false;
        input.value = "";
        if (candidates) candidates.hidden = true;
        input.focus();
        return;
      }
      lastClick = null;
      pressStart = { x: event.clientX, y: event.clientY };
      draggingPointerId = event.pointerId;
      selector.classList.add("dragging", "hovering");
      try { selector.setPointerCapture(event.pointerId); } catch (_err) {}
      previewAt(event.clientX);
    });
    const finishDrag = (event, commit = true) => {
      if (draggingPointerId == null || event.pointerId !== draggingPointerId) return;
      try { selector.releasePointerCapture(event.pointerId); } catch (_err) {}
      draggingPointerId = null;
      lastClick = commit && pressStart
        && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) < 12
        ? { time: Date.now(), x: event.clientX, y: event.clientY, pointerType: event.pointerType }
        : null;
      pressStart = null;
      selector.classList.remove("dragging");
      const ds = getActive?.() || null;
      if (commit && ds && hoverBand != null && activeBand(ds) !== hoverBand) {
        onSelectBand?.(ds, hoverBand);
      } else {
        renderTicks(ds);
      }
    };
    selector.addEventListener("pointerup", finishDrag);
    selector.addEventListener("pointercancel", (event) => finishDrag(event, false));
    selector.addEventListener("keydown", (event) => {
      if (editing) return;
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
      hoverFraction = next.fraction;
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
