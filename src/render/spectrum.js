import { fmtNoGroup, fmtUm } from "../core/utils.js";

function formatAxisNumber(v) {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return "—";
  if (a >= 1000) return fmtNoGroup(Math.round(v));
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

export function isCmInverseUnit(unit) {
  const raw = String(unit || "").trim().toLowerCase();
  if (!raw) return false;
  const normalized = raw.replace(/[−–]/g, "-").replace(/\s+/g, "");
  return normalized.includes("cm-1")
    || normalized.includes("cm^-1")
    || normalized.includes("cm⁻1")
    || normalized.includes("1/cm");
}

export function medianBandInterval(xVals) {
  if (!xVals || xVals.length < 2) return null;
  const steps = [];
  for (let i = 1; i < xVals.length; i += 1) {
    const a = Number(xVals[i - 1]);
    const b = Number(xVals[i]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = Math.abs(b - a);
    if (d > 0) steps.push(d);
  }
  if (!steps.length) return null;
  steps.sort((a, b) => a - b);
  const mid = Math.floor(steps.length / 2);
  if (steps.length % 2 === 1) return steps[mid];
  return (steps[mid - 1] + steps[mid]) * 0.5;
}

export function shouldUseBarSpectrumPlot(xVals, wlUnits, threshold = 8) {
  if (!isCmInverseUnit(wlUnits)) return false;
  const med = medianBandInterval(xVals);
  if (!Number.isFinite(med)) return false;
  return med > threshold;
}

function inferCmInverseUnitFromWavelengthEntries(entries) {
  if (!Array.isArray(entries)) return "";
  for (let i = 0; i < entries.length; i += 1) {
    const raw = entries[i];
    if (raw == null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    if (isCmInverseUnit(text)) return "cm-1";
  }
  return "";
}

function resolveSpectralUnit(ds) {
  const explicit = (ds?.meta?.wlUnits && String(ds.meta.wlUnits).trim()) ? String(ds.meta.wlUnits).trim() : "";
  if (explicit) return explicit;
  return inferCmInverseUnitFromWavelengthEntries(ds?.meta?.wavelengths);
}

export function createSpectrumController(deps) {
  const {
    els,
    specCtx,
    getActive,
    bandLabel,
    updatePerf,
    sanitizeFilePart,
    downloadBlob,
    setActiveBand,
    readSpectrumAtPixel,
    wavelengthArrayOrNull
  } = deps;

  let specSeq = 0;
  const specState = {
    open: false,
    dsId: null,
    x: 0,
    y: 0,
    xVals: null,
    yVals: null,
    stdVals: null,
    plot: null,
    activeBandX: null,
    bandDragPointerId: null,
    bandDragByHandle: false,
    source: { type: "pixel", sampleCount: 0, selectionCount: 0, sampleStep: 1 }
  };

  function nextFrame() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  function showSpectrumPanel(show) {
    if (!els.specPanel) return;
    els.specPanel.style.display = show ? "block" : "none";
    specState.open = !!show;
  }

  function setSpecSub(text) {
    if (els.specSub) els.specSub.textContent = text;
  }

  function setSpecFoot(text) {
    if (els.specFoot) els.specFoot.textContent = text;
  }

  function resetSpectrumData() {
    specState.xVals = null;
    specState.yVals = null;
    specState.stdVals = null;
    specState.plot = null;
    specState.activeBandX = null;
  }

  function applySpectrumSource(opts = {}) {
    specState.source = {
      type: opts.sourceType === "area" ? "area" : "pixel",
      sampleCount: Number.isFinite(opts?.sourceMeta?.sampleCount) ? opts.sourceMeta.sampleCount : 0,
      selectionCount: Number.isFinite(opts?.sourceMeta?.selectionCount) ? opts.sourceMeta.selectionCount : 0,
      sampleStep: Number.isFinite(opts?.sourceMeta?.sampleStep) ? opts.sourceMeta.sampleStep : 1
    };
  }

  function applySpectrumSubLabel(ds, ix, iy, opts = {}) {
    if (opts.subLabel && String(opts.subLabel).trim()) {
      setSpecSub(String(opts.subLabel));
      return;
    }
    const sc = ds.meta.scale;
    if (sc && Number.isFinite(sc.umPerPixelX) && Number.isFinite(sc.umPerPixelY)) {
      const xUm = ix * Number(sc.umPerPixelX);
      const yUm = iy * Number(sc.umPerPixelY);
      setSpecSub(`x:${fmtUm(xUm)} µm  y:${fmtUm(yUm)} µm  (px ${ix},${iy})`);
      return;
    }
    setSpecSub(`px ${ix}, ${iy}`);
  }

  function drawSpectrumPlaceholder(message = "Computing spectrum...") {
    resizeSpecCanvas();
    const c = els.specCanvas;
    const ctx = specCtx;
    if (!c || !ctx) return;
    const W = c.width;
    const H = c.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgb(17, 24, 39)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(229,231,235,0.92)";
    ctx.font = `${Math.round(12 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(message), W / 2, H / 2);
  }

  function summarizeSpectrum(yVals) {
    if (!yVals || !yVals.length) return null;
    let n = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < yVals.length; i += 1) {
      const v = Number(yVals[i]);
      if (!Number.isFinite(v)) continue;
      n += 1;
      sum += v;
      sumSq += (v * v);
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!n) return null;
    const mean = sum / n;
    const rms = Math.sqrt(sumSq / n);
    const variance = Math.max(0, (sumSq / n) - (mean * mean));
    const std = Math.sqrt(variance);
    return { n, min, max, mean, std, rms };
  }

  function resizeSpecCanvas() {
    if (!els.specCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const r = els.specCanvas.getBoundingClientRect();
    const w = Math.max(10, Math.floor(r.width * dpr));
    const h = Math.max(10, Math.floor(r.height * dpr));
    if (els.specCanvas.width !== w || els.specCanvas.height !== h) {
      els.specCanvas.width = w;
      els.specCanvas.height = h;
    }
  }

  function positionSpectrumPanel(anchor = null) {
    if (!els.specPanel || !els.main || !anchor) return;
    if (!Number.isFinite(anchor.clientX) || !Number.isFinite(anchor.clientY)) return;
    const mainRect = els.main.getBoundingClientRect();
    const panelRect = els.specPanel.getBoundingClientRect();
    const panelW = Math.max(220, panelRect.width || 380);
    const panelH = Math.max(120, panelRect.height || 230);
    const gap = anchor.pointerType === "touch" ? 56 : 28;
    const margin = 8;

    const localX = anchor.clientX - mainRect.left;
    const localY = anchor.clientY - mainRect.top;
    let x = localX + gap;
    let y = localY + gap;

    if (x + panelW > mainRect.width - margin) x = localX - panelW - gap;
    if (y + panelH > mainRect.height - margin) y = localY - panelH - gap;
    x = Math.max(margin, Math.min(x, mainRect.width - panelW - margin));
    y = Math.max(margin, Math.min(y, mainRect.height - panelH - margin));

    els.specPanel.style.left = `${Math.round(x)}px`;
    els.specPanel.style.top = `${Math.round(y)}px`;
    els.specPanel.style.right = "auto";
    els.specPanel.style.bottom = "auto";
  }

  function rectOverlapArea(a, b) {
    const x0 = Math.max(a.x, b.x);
    const y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w);
    const y1 = Math.min(a.y + a.h, b.y + b.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    return (x1 - x0) * (y1 - y0);
  }

  function positionSpectrumPanelNearSelection(ds, selectionBounds, occluderBounds = [], pointerType = "mouse") {
    if (!els.specPanel || !els.main || !selectionBounds) return false;
    const mainRect = els.main.getBoundingClientRect();
    const panelRect = els.specPanel.getBoundingClientRect();
    const panelW = Math.max(220, panelRect.width || 380);
    const panelH = Math.max(120, panelRect.height || 230);
    const gap = pointerType === "touch" ? 56 : 28;
    const margin = 8;

    const scale = Math.max(1e-9, Number(ds?.view?.scale) || 1);
    const sx0 = (selectionBounds.x0 - ds.view.x) * scale;
    const sy0 = (selectionBounds.y0 - ds.view.y) * scale;
    const sx1 = (selectionBounds.x1 + 1 - ds.view.x) * scale;
    const sy1 = (selectionBounds.y1 + 1 - ds.view.y) * scale;
    const selRect = {
      x: Math.min(sx0, sx1),
      y: Math.min(sy0, sy1),
      w: Math.max(1, Math.abs(sx1 - sx0)),
      h: Math.max(1, Math.abs(sy1 - sy0))
    };

    const cx = selRect.x + (selRect.w / 2);
    const cy = selRect.y + (selRect.h / 2);
    const occluderRects = Array.isArray(occluderBounds)
      ? occluderBounds.map((b) => {
        const ox0 = (b.x0 - ds.view.x) * scale;
        const oy0 = (b.y0 - ds.view.y) * scale;
        const ox1 = (b.x1 + 1 - ds.view.x) * scale;
        const oy1 = (b.y1 + 1 - ds.view.y) * scale;
        return {
          x: Math.min(ox0, ox1),
          y: Math.min(oy0, oy1),
          w: Math.max(1, Math.abs(ox1 - ox0)),
          h: Math.max(1, Math.abs(oy1 - oy0))
        };
      })
      .filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h))
      : [];

    const candidates = [
      { x: selRect.x + selRect.w + gap, y: cy - (panelH / 2) },
      { x: selRect.x - panelW - gap, y: cy - (panelH / 2) },
      { x: cx - (panelW / 2), y: selRect.y + selRect.h + gap },
      { x: cx - (panelW / 2), y: selRect.y - panelH - gap },
      { x: selRect.x + selRect.w + gap, y: selRect.y + selRect.h + gap },
      { x: selRect.x - panelW - gap, y: selRect.y - panelH - gap },
      { x: selRect.x + selRect.w + gap, y: selRect.y - panelH - gap },
      { x: selRect.x - panelW - gap, y: selRect.y + selRect.h + gap }
    ];

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    let bestOccluderOverlap = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
      const x = Math.max(margin, Math.min(cand.x, mainRect.width - panelW - margin));
      const y = Math.max(margin, Math.min(cand.y, mainRect.height - panelH - margin));
      const panel = { x, y, w: panelW, h: panelH };
      const targetOverlap = rectOverlapArea(panel, selRect);
      let occluderOverlap = 0;
      for (const occ of occluderRects) occluderOverlap += rectOverlapArea(panel, occ);
      const dx = x - cand.x;
      const dy = y - cand.y;
      const dist = Math.hypot(dx, dy);
      const score = (occluderOverlap * 40) + (targetOverlap * 6) + dist;
      if (occluderOverlap < bestOccluderOverlap || (occluderOverlap === bestOccluderOverlap && score < bestScore)) {
        bestOccluderOverlap = occluderOverlap;
        bestScore = score;
        best = { x, y };
      }
    }
    if (!best) return false;
    els.specPanel.style.left = `${Math.round(best.x)}px`;
    els.specPanel.style.top = `${Math.round(best.y)}px`;
    els.specPanel.style.right = "auto";
    els.specPanel.style.bottom = "auto";
    return true;
  }

  function positionSpectrumFromOptions(ds, opts = {}) {
    if (opts.noReposition) return;
    const pointerType = opts.pointerType === "touch" ? "touch" : "mouse";
    const hasAreaPlacement = (specState.source.type === "area" && opts.selectionBounds);
    const didAreaPlace = hasAreaPlacement
      ? positionSpectrumPanelNearSelection(ds, opts.selectionBounds, opts.selectionOccluders || [], pointerType)
      : false;
    if (!didAreaPlace) {
      positionSpectrumPanel({
        clientX: Number(opts.clientX),
        clientY: Number(opts.clientY),
        pointerType
      });
    }
  }

  function drawSpectrumPlot(ds, xVals, yVals, stdVals = null, sampleCount = 0) {
    resizeSpecCanvas();
    const c = els.specCanvas;
    const ctx = specCtx;
    const W = c.width;
    const H = c.height;
    const dpr = window.devicePixelRatio || 1;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgb(17, 24, 39)";
    ctx.fillRect(0, 0, W, H);

    const padL = Math.round(52 * dpr);
    const padR = Math.round(12 * dpr);
    const padT = Math.round(12 * dpr);
    const padB = Math.round(30 * dpr);

    const x0 = padL;
    const y0 = padT;
    const x1 = W - padR;
    const y1 = H - padB;
    const plotW = Math.max(1, x1 - x0);
    const plotH = Math.max(1, y1 - y0);

    let xmin = Number.POSITIVE_INFINITY;
    let xmax = Number.NEGATIVE_INFINITY;
    let ymin = Number.POSITIVE_INFINITY;
    let ymax = Number.NEGATIVE_INFINITY;
    const ciScale = (Number.isFinite(sampleCount) && sampleCount > 1) ? (1.96 / Math.sqrt(sampleCount)) : 0;
    const useCI = !!(stdVals && stdVals.length && ciScale > 0);
    const unit = resolveSpectralUnit(ds);
    const useBarPlot = !!(xVals && shouldUseBarSpectrumPlot(xVals, unit, 8));
    for (let i = 0; i < yVals.length; i++) {
      const xv = xVals ? xVals[i] : i;
      const yv = yVals[i];
      if (Number.isFinite(xv)) { xmin = Math.min(xmin, xv); xmax = Math.max(xmax, xv); }
      if (!Number.isFinite(yv)) continue;
      if (useCI && Number.isFinite(stdVals[i])) {
        const ci = stdVals[i] * ciScale;
        ymin = Math.min(ymin, yv - ci);
        ymax = Math.max(ymax, yv + ci);
      } else {
        ymin = Math.min(ymin, yv);
        ymax = Math.max(ymax, yv);
      }
    }
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmin === xmax) {
      xmin = 0;
      xmax = Math.max(1, yVals.length - 1);
    }
    if (!Number.isFinite(ymin) || !Number.isFinite(ymax) || ymin === ymax) {
      ymin = Number.isFinite(ymin) ? ymin : 0;
      ymax = ymin + 1;
    }
    const yPad = (ymax - ymin) * 0.06;
    ymin -= yPad;
    ymax += yPad;

    const xToPx = (x) => x0 + ((x - xmin) / (xmax - xmin)) * plotW;
    const yToPx = (y) => y1 - ((y - ymin) / (ymax - ymin)) * plotH;
    const bandCenters = new Float64Array(yVals.length);
    for (let i = 0; i < yVals.length; i += 1) {
      const xv = xVals ? xVals[i] : i;
      bandCenters[i] = Number.isFinite(xv) ? xToPx(xv) : Number.NaN;
    }
    specState.plot = { x0, y0, x1, y1, plotW, plotH, n: yVals.length, bandCenters };

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    const gridN = 4;
    for (let i = 0; i <= gridN; i++) {
      const yy = y0 + (i / gridN) * plotH;
      ctx.moveTo(x0, yy);
      ctx.lineTo(x1, yy);
    }
    for (let i = 0; i <= gridN; i++) {
      const xx = x0 + (i / gridN) * plotW;
      ctx.moveTo(xx, y0);
      ctx.lineTo(xx, y1);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    const N = yVals.length;
    const step = Math.max(1, Math.ceil(N / (useBarPlot ? 1000 : 1400)));
    if (useCI && !useBarPlot) {
      const upper = [];
      const lower = [];
      for (let i = 0; i < N; i += step) {
        const xv = xVals ? xVals[i] : i;
        const yv = yVals[i];
        const sd = stdVals[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv) || !Number.isFinite(sd)) continue;
        const ci = sd * ciScale;
        upper.push({ x: xToPx(xv), y: yToPx(yv + ci) });
        lower.push({ x: xToPx(xv), y: yToPx(yv - ci) });
      }
      if (upper.length > 1 && lower.length > 1) {
        ctx.save();
        ctx.fillStyle = "rgba(148,163,184,0.22)";
        ctx.beginPath();
        ctx.moveTo(upper[0].x, upper[0].y);
        for (let i = 1; i < upper.length; i += 1) ctx.lineTo(upper[i].x, upper[i].y);
        for (let i = lower.length - 1; i >= 0; i -= 1) ctx.lineTo(lower[i].x, lower[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    if (useBarPlot) {
      const xRange = Math.max(1e-9, xmax - xmin);
      ctx.fillStyle = "rgba(229,231,235,0.78)";
      ctx.strokeStyle = "rgba(148,163,184,0.95)";
      ctx.lineWidth = 1 * dpr;
      for (let i = 0; i < N; i += step) {
        const xv = xVals ? xVals[i] : i;
        const yv = yVals[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        const px = xToPx(xv);
        const py = yToPx(yv);
        const prevX = (i > 0) ? Number(xVals ? xVals[i - 1] : (i - 1)) : Number.NaN;
        const nextX = (i + 1 < N) ? Number(xVals ? xVals[i + 1] : (i + 1)) : Number.NaN;
        const leftGap = Number.isFinite(prevX) ? Math.abs(xv - prevX) : Number.NaN;
        const rightGap = Number.isFinite(nextX) ? Math.abs(nextX - xv) : Number.NaN;
        let spanX = Number.NaN;
        if (Number.isFinite(leftGap) && Number.isFinite(rightGap)) spanX = Math.min(leftGap, rightGap);
        else if (Number.isFinite(leftGap)) spanX = leftGap;
        else if (Number.isFinite(rightGap)) spanX = rightGap;
        if (!Number.isFinite(spanX) || spanX <= 0) spanX = xRange / Math.max(1, N);
        const barW = Math.max(1 * dpr, ((spanX / xRange) * plotW) * 0.72);
        const left = px - (barW * 0.5);
        const h = Math.max(1 * dpr, y1 - py);
        ctx.fillRect(left, py, barW, h);

        if (useCI && Number.isFinite(stdVals[i])) {
          const ci = stdVals[i] * ciScale;
          const top = yToPx(yv + ci);
          const bot = yToPx(yv - ci);
          const cap = Math.max(3 * dpr, Math.min(10 * dpr, barW * 0.45));
          ctx.beginPath();
          ctx.moveTo(px, top);
          ctx.lineTo(px, bot);
          ctx.moveTo(px - cap, top);
          ctx.lineTo(px + cap, top);
          ctx.moveTo(px - cap, bot);
          ctx.lineTo(px + cap, bot);
          ctx.stroke();
        }
      }
    } else {
      ctx.strokeStyle = "rgba(229,231,235,0.95)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < N; i += step) {
        const xv = xVals ? xVals[i] : i;
        const yv = yVals[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        const px = xToPx(xv);
        const py = yToPx(yv);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    const selBand = (ds && Number.isFinite(ds.activeBand)) ? ds.activeBand : null;
    specState.activeBandX = null;
    if (selBand != null && selBand >= 0 && selBand < yVals.length) {
      const xv = xVals ? xVals[selBand] : selBand;
      const yv = yVals[selBand];
      if (Number.isFinite(xv)) {
        const px = xToPx(xv);
        specState.activeBandX = px;
        ctx.save();
        ctx.strokeStyle = "rgba(156,163,175,0.65)";
        ctx.lineWidth = 1 * dpr;
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.beginPath();
        ctx.moveTo(px, y0);
        ctx.lineTo(px, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        if (Number.isFinite(yv)) {
          const py = yToPx(yv);
          ctx.fillStyle = "rgba(209,213,219,0.95)";
          ctx.beginPath();
          ctx.arc(px, py, 3 * dpr, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ctx.lineWidth = 1 * dpr;
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    ctx.fillStyle = "rgba(229,231,235,0.92)";
    ctx.font = `${Math.round(11 * dpr)}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const yv = ymin + (1 - t) * (ymax - ymin);
      const py = y0 + t * plotH;
      ctx.fillText(formatAxisNumber(yv), x0 - 8 * dpr, py);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const xv = xmin + t * (xmax - xmin);
      const px = x0 + t * plotW;
      ctx.fillText(formatAxisNumber(xv), px, y1 + 6 * dpr);
    }
  }

  async function openSpectrumAt(ds, ix, iy, opts = {}) {
    if (!ds) return;
    specState.dsId = ds.id;
    specState.x = ix;
    specState.y = iy;
    applySpectrumSource(opts);
    const mySeq = ++specSeq;

    showSpectrumPanel(true);
    applySpectrumSubLabel(ds, ix, iy, opts);
    await nextFrame();
    if (mySeq !== specSeq) return;
    positionSpectrumFromOptions(ds, opts);

    try {
      let yVals = opts.yVals || null;
      if (!(yVals && yVals.length)) yVals = await readSpectrumAtPixel(ds, ix, iy);
      if (mySeq !== specSeq) return;
      const xVals = (opts.xVals && opts.xVals.length) ? opts.xVals : wavelengthArrayOrNull(ds);
      const stdVals = (opts.stdVals && opts.stdVals.length) ? opts.stdVals : null;
      drawSpectrumPlot(ds, xVals, yVals, stdVals, specState.source.sampleCount || 0);
      specState.xVals = xVals;
      specState.yVals = yVals;
      specState.stdVals = stdVals;
      const stats = summarizeSpectrum(yVals);
      if (!stats) {
        setSpecFoot("No finite values.");
      } else {
        setSpecFoot(
          `Mean ${formatAxisNumber(stats.mean)}  StdDev ${formatAxisNumber(stats.std)}  RMS ${formatAxisNumber(stats.rms)}  Min/Max ${formatAxisNumber(stats.min)} / ${formatAxisNumber(stats.max)}`
        );
      }
      updatePerf();
    } catch (e) {
      console.error(e);
      setSpecSub("Failed to read spectrum.");
      setSpecFoot("Failed to compute spectrum.");
    }
  }

  async function showPendingSpectrum(ds, ix, iy, opts = {}) {
    if (!ds) return;
    specState.dsId = ds.id;
    specState.x = ix;
    specState.y = iy;
    applySpectrumSource(opts);
    resetSpectrumData();
    const mySeq = ++specSeq;

    showSpectrumPanel(true);
    applySpectrumSubLabel(ds, ix, iy, opts);
    setSpecFoot(opts.footLabel && String(opts.footLabel).trim()
      ? String(opts.footLabel)
      : "Computing spectrum...");

    await nextFrame();
    if (mySeq !== specSeq) return;
    positionSpectrumFromOptions(ds, opts);
    drawSpectrumPlaceholder(opts.placeholderText || "Computing spectrum...");
  }

  function updateSpectrumStatus(opts = {}) {
    if (!specState.open) return;
    if (opts.subLabel && String(opts.subLabel).trim()) setSpecSub(String(opts.subLabel));
    if (opts.footLabel && String(opts.footLabel).trim()) setSpecFoot(String(opts.footLabel));
    if (opts.placeholderText && String(opts.placeholderText).trim()) drawSpectrumPlaceholder(String(opts.placeholderText));
  }

  function bandFromClientX(clientX) {
    if (!els.specCanvas || !specState.plot || !Number.isFinite(clientX)) return null;
    const { x0, plotW, n, bandCenters } = specState.plot;
    if (!Number.isFinite(n) || n <= 0) return null;
    const rect = els.specCanvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (clientX - rect.left) * dpr;
    if (bandCenters && bandCenters.length === n) {
      let bestIdx = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < n; i += 1) {
        const cx = Number(bandCenters[i]);
        if (!Number.isFinite(cx)) continue;
        const dist = Math.abs(cx - x);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      if (bestIdx != null) return bestIdx;
    }
    if (!Number.isFinite(plotW) || plotW <= 0) return null;
    const t = Math.max(0, Math.min(1, (x - x0) / plotW));
    return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
  }

  function applyActiveBandFromIndex(idx) {
    const ds = getActive();
    if (!ds || ds.id !== specState.dsId || !Number.isFinite(idx)) return false;
    const band = Math.max(0, Math.min(ds.meta.bands - 1, idx | 0));
    if (ds.activeBand === band) return false;
    if (setActiveBand) setActiveBand(ds, band);
    else ds.activeBand = band;
    if (specState.yVals) {
      drawSpectrumPlot(ds, specState.xVals, specState.yVals, specState.stdVals, specState.source?.sampleCount || 0);
    }
    return true;
  }

  function redrawSpectrum() {
    if (!specState.open) return;
    const ds = getActive();
    if (!ds || ds.id !== specState.dsId || !specState.yVals) return;
    drawSpectrumPlot(ds, specState.xVals, specState.yVals, specState.stdVals, specState.source?.sampleCount || 0);
  }

  function closeSpectrum() {
    specSeq++;
    resetSpectrumData();
    specState.source = { type: "pixel", sampleCount: 0, selectionCount: 0, sampleStep: 1 };
    showSpectrumPanel(false);
  }

  function exportSpectrumCSV() {
    const ds = getActive();
    if (!ds || !specState.open || ds.id !== specState.dsId || !specState.yVals) {
      alert("Spectrum not ready yet. Double‑click in the image to open it first.");
      return;
    }

    const yVals = specState.yVals;
    const xVals = specState.xVals;
    const unit = (ds.meta.wlUnits && String(ds.meta.wlUnits).trim()) ? String(ds.meta.wlUnits).trim() : "";
    const xLabel = xVals ? (unit || "wavelength") : "band_index";

    const lines = [];
    lines.push(`# dataset: ${ds.name}`);
    if (specState.source && specState.source.type === "area") {
      lines.push("# source: area_average");
      if (Number.isFinite(specState.source.sampleCount) && specState.source.sampleCount > 0) {
        lines.push(`# sample_pixels: ${specState.source.sampleCount}`);
      }
      if (Number.isFinite(specState.source.selectionCount) && specState.source.selectionCount > 0) {
        lines.push(`# selection_count: ${specState.source.selectionCount}`);
      }
      if (Number.isFinite(specState.source.sampleStep) && specState.source.sampleStep > 1) {
        lines.push(`# sample_step: ${specState.source.sampleStep}`);
      }
    } else {
      lines.push(`# pixel: ${specState.x},${specState.y}`);
      if (ds.meta.scale && Number.isFinite(ds.meta.scale.umPerPixelX) && Number.isFinite(ds.meta.scale.umPerPixelY)) {
        const xUm = specState.x * Number(ds.meta.scale.umPerPixelX);
        const yUm = specState.y * Number(ds.meta.scale.umPerPixelY);
        lines.push(`# physical_um: ${fmtUm(xUm)},${fmtUm(yUm)}`);
      }
    }
    lines.push(`# bands: ${ds.meta.bands}`);
    if (ds.activeBand != null) lines.push(`# active_band: ${ds.activeBand}`);

    const cols = ["band_index", "band_name"];
    if (xVals) cols.push(xLabel);
    cols.push("value");
    lines.push(cols.join(","));

    const names = Array.isArray(ds.meta.bandNames) ? ds.meta.bandNames : null;
    for (let b = 0; b < yVals.length; b++) {
      const name = (names && names[b] != null) ? String(names[b]).trim().replace(/\s+/g, " ") : "";
      const row = [String(b), `"${name.replace(/"/g, "\"\"")}"`];
      if (xVals) row.push(String(xVals[b]));
      row.push(String(yVals[b]));
      lines.push(row.join(","));
    }

    const csv = `${lines.join("\n")}\n`;
    const base = (specState.source && specState.source.type === "area")
      ? `${ds.name}_spectrum_area`
      : `${ds.name}_spectrum_${specState.x}_${specState.y}`;
    downloadBlob(new Blob([csv], { type: "text/csv" }), `${sanitizeFilePart(base)}.csv`);
  }

  function isOpenForDatasetId(id) {
    return !!specState.open && specState.dsId === id;
  }

  if (els.specCanvas && typeof els.specCanvas.addEventListener === "function") {
    els.specCanvas.addEventListener("pointerdown", (ev) => {
      if (!specState.open || !specState.plot) return;
      const rect = els.specCanvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = (ev.clientX - rect.left) * dpr;
      const y = (ev.clientY - rect.top) * dpr;
      const plot = specState.plot;
      const withinPlot = (x >= plot.x0 && x <= plot.x1 && y >= plot.y0 && y <= plot.y1);
      if (!withinPlot) return;
      const handleTol = Math.max(8 * dpr, 10);
      const onHandle = Number.isFinite(specState.activeBandX) && Math.abs(x - specState.activeBandX) <= handleTol;
      if (!onHandle) return;
      specState.bandDragPointerId = ev.pointerId;
      specState.bandDragByHandle = true;
      try { els.specCanvas.setPointerCapture(ev.pointerId); } catch (_err) {}
      const idx = bandFromClientX(ev.clientX);
      if (idx != null) applyActiveBandFromIndex(idx);
      ev.preventDefault();
      ev.stopPropagation();
    });

    els.specCanvas.addEventListener("pointermove", (ev) => {
      if (specState.bandDragPointerId == null || ev.pointerId !== specState.bandDragPointerId) return;
      const idx = bandFromClientX(ev.clientX);
      if (idx != null) applyActiveBandFromIndex(idx);
      ev.preventDefault();
      ev.stopPropagation();
    });

    const endBandDrag = (ev) => {
      if (specState.bandDragPointerId == null || ev.pointerId !== specState.bandDragPointerId) return;
      try { els.specCanvas.releasePointerCapture(ev.pointerId); } catch (_err) {}
      specState.bandDragPointerId = null;
      specState.bandDragByHandle = false;
      ev.preventDefault();
      ev.stopPropagation();
    };
    els.specCanvas.addEventListener("pointerup", endBandDrag);
    els.specCanvas.addEventListener("pointercancel", endBandDrag);
  }

  return {
    openSpectrumAt,
    showPendingSpectrum,
    updateSpectrumStatus,
    redrawSpectrum,
    closeSpectrum,
    exportSpectrumCSV,
    isOpenForDatasetId
  };
}
