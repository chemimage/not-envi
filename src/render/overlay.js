import { fmtNoGroup } from "../core/utils.js";
import { resolveRasterSampling } from "./raster-geometry.js";

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function formatDistanceUm(um) {
  const a = Math.abs(um);
  if (a >= 1000) {
    const mm = um / 1000;
    const s = (Math.abs(mm - Math.round(mm)) < 1e-9)
      ? String(Math.round(mm))
      : mm.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `${s} mm`;
  }
  if (a >= 1) {
    const s = (Math.abs(um - Math.round(um)) < 1e-9)
      ? String(Math.round(um))
      : um.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `${s} µm`;
  }
  const nm = um * 1000;
  const s = (Math.abs(nm - Math.round(nm)) < 1e-9)
    ? String(Math.round(nm))
    : nm.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${s} nm`;
}

export function createOverlayRenderer(deps) {
  const {
    els,
    overlayCtx,
    getDevicePixelRatio,
    getDrawData
  } = deps;

  function colorWithAlpha(color, alpha) {
    if (!color) return `rgba(255,45,45,${alpha})`;
    const c = String(color).trim();
    const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(c);
    if (!m) return c;
    let hex = m[1];
    if (hex.length === 3) hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function toScreen(ds, pt, eff, viewport) {
    return {
      x: viewport.x + ((pt.x - ds.view.x) * eff),
      y: viewport.y + ((pt.y - ds.view.y) * eff)
    };
  }

  function rulerDistanceLabel(ds, item) {
    if (!item || !Array.isArray(item.points) || item.points.length < 2) return "";
    const a = item.points[0];
    const b = item.points[item.points.length - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const pxDist = Math.hypot(dx, dy);
    if (!Number.isFinite(pxDist) || pxDist <= 0) return "";

    const sc = ds && ds.meta ? ds.meta.scale : null;
    const umX = Number(sc?.umPerPixelX);
    const umY = Number.isFinite(sc?.umPerPixelY) && sc.umPerPixelY > 0 ? Number(sc.umPerPixelY) : umX;
    if (Number.isFinite(umX) && umX > 0) {
      const umDist = Math.hypot(dx * umX, dy * umY);
      if (Number.isFinite(umDist) && umDist > 0) return formatDistanceUm(umDist);
    }
    const s = (Math.abs(pxDist - Math.round(pxDist)) < 1e-6)
      ? String(Math.round(pxDist))
      : pxDist.toFixed(1).replace(/0+$/, "").replace(/\.$/, "");
    return `${s} px`;
  }

  function sampleRasterValue(raster, ix, iy) {
    if (!raster || !raster.dataF32 || !Number.isFinite(raster.w) || !Number.isFinite(raster.h)) return Number.NaN;
    const step = Math.max(1, Number(raster.step) || 1);
    const x0 = Number(raster.x0) || 0;
    const y0 = Number(raster.y0) || 0;
    const rx = Math.round((ix - x0) / step);
    const ry = Math.round((iy - y0) / step);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return Number.NaN;
    if (rx < 0 || ry < 0 || rx >= raster.w || ry >= raster.h) return Number.NaN;
    return raster.dataF32[ry * raster.w + rx];
  }

  function rulerUpNormal(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || len <= 1e-6) return null;
    let nx = -dy / len;
    let ny = dx / len;
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    return { nx, ny, len };
  }

  function normalizedLabelAngle(a, b) {
    let ang = Math.atan2(b.y - a.y, b.x - a.x);
    if (ang > (Math.PI * 0.5)) ang -= Math.PI;
    if (ang < -(Math.PI * 0.5)) ang += Math.PI;
    return ang;
  }

  function drawOrientedLabel(text, cx, cy, ang, dpr) {
    if (!text) return;
    const fontPx = 11 * dpr;
    const padX = 6 * dpr;
    const padY = 3 * dpr;
    overlayCtx.save();
    overlayCtx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
    overlayCtx.textAlign = "left";
    overlayCtx.textBaseline = "top";
    const textW = overlayCtx.measureText(text).width;
    const boxW = textW + (padX * 2);
    const boxH = fontPx + (padY * 2);
    const x = -boxW * 0.5;
    const y = -boxH * 0.5;
    overlayCtx.translate(cx, cy);
    overlayCtx.rotate(ang);
    overlayCtx.fillStyle = "rgba(0,0,0,0.68)";
    roundRect(overlayCtx, x, y, boxW, boxH, 2 * dpr);
    overlayCtx.fill();
    overlayCtx.fillStyle = "rgba(255,255,255,0.93)";
    overlayCtx.fillText(text, x + padX, y + padY);
    overlayCtx.restore();
  }

  function formatProfileValue(v) {
    if (!Number.isFinite(v)) return "—";
    const av = Math.abs(v);
    if (av > 0 && (av >= 1e5 || av < 1e-3)) return v.toExponential(3);
    return Number(v).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }

  function drawRulerProfile(ds, item, a, b, dpr, viewport, profileHover = null, raster = null, activeBand = null) {
    if (!ds || !item || !Array.isArray(item.points) || item.points.length < 2) return;
    const targetRaster = raster || ds.lastRaster;
    const band = Number.isFinite(Number(activeBand)) ? Number(activeBand) : ds.activeBand;
    if (!targetRaster || targetRaster.band !== band || !targetRaster.dataF32) return;
    const ai = item.points[0];
    const bi = item.points[item.points.length - 1];
    const lenImg = Math.hypot(bi.x - ai.x, bi.y - ai.y);
    if (!Number.isFinite(lenImg) || lenImg < 2) return;

    const samples = Math.max(24, Math.min(256, Math.round(lenImg)));
    const values = new Float32Array(samples);
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    let valid = 0;
    for (let i = 0; i < samples; i += 1) {
      const t = i / Math.max(1, samples - 1);
      const ix = ai.x + (bi.x - ai.x) * t;
      const iy = ai.y + (bi.y - ai.y) * t;
      const v = sampleRasterValue(targetRaster, ix, iy);
      values[i] = v;
      if (Number.isFinite(v)) {
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        valid += 1;
      }
    }
    if (valid < 2) return;

    const n = rulerUpNormal(a, b);
    if (!n) return;
    const offset = 10 * dpr;
    const profileScaleRaw = Number(item?.profileScale);
    const profileScale = Number.isFinite(profileScaleRaw) && profileScaleRaw > 0 ? Math.min(12, Math.max(0.15, profileScaleRaw)) : 1;
    const amp = 22 * dpr * profileScale;
    const range = Math.max(1e-12, maxV - minV);

    const ax = a.x + n.nx * offset;
    const ay = a.y + n.ny * offset;
    const bx = b.x + n.nx * offset;
    const by = b.y + n.ny * offset;
    overlayCtx.strokeStyle = "rgba(226,232,240,0.35)";
    overlayCtx.lineWidth = 1 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(ax, ay);
    overlayCtx.lineTo(bx, by);
    overlayCtx.stroke();

    overlayCtx.strokeStyle = colorWithAlpha(item.color, 0.95);
    overlayCtx.lineWidth = 1.5 * dpr;
    overlayCtx.beginPath();
    let hasRun = false;
    for (let i = 0; i < samples; i += 1) {
      const v = values[i];
      if (!Number.isFinite(v)) {
        hasRun = false;
        continue;
      }
      const t = i / Math.max(1, samples - 1);
      const bx0 = a.x + (b.x - a.x) * t;
      const by0 = a.y + (b.y - a.y) * t;
      const u = (v - minV) / range;
      const d = offset + (u * amp);
      const px = bx0 + n.nx * d;
      const py = by0 + n.ny * d;
      if (!hasRun) {
        overlayCtx.moveTo(px, py);
        hasRun = true;
      } else {
        overlayCtx.lineTo(px, py);
      }
    }
    if (hasRun) overlayCtx.stroke();

    if (!profileHover || !Number.isFinite(profileHover.x) || !Number.isFinite(profileHover.y)) return;
    const vAxisX = bx - ax;
    const vAxisY = by - ay;
    const vLen2 = (vAxisX * vAxisX) + (vAxisY * vAxisY);
    if (!Number.isFinite(vLen2) || vLen2 <= 1e-9) return;
    const rawT = (((profileHover.x - ax) * vAxisX) + ((profileHover.y - ay) * vAxisY)) / vLen2;
    const t = Math.max(0, Math.min(1, rawT));
    const ix = ai.x + (bi.x - ai.x) * t;
    const iy = ai.y + (bi.y - ai.y) * t;
    const v = sampleRasterValue(targetRaster, ix, iy);
    if (!Number.isFinite(v)) return;
    const u = (v - minV) / range;
    const d = offset + (u * amp);
    const bx0 = a.x + (b.x - a.x) * t;
    const by0 = a.y + (b.y - a.y) * t;
    const x0 = bx0 + (n.nx * offset);
    const y0 = by0 + (n.ny * offset);
    const x1 = bx0 + (n.nx * d);
    const y1 = by0 + (n.ny * d);
    overlayCtx.strokeStyle = "rgba(226,232,240,0.35)";
    overlayCtx.lineWidth = 1 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(x0, y0);
    overlayCtx.lineTo(x1, y1);
    overlayCtx.stroke();

    const ang = normalizedLabelAngle(a, b);
    const labelX = x1 + (n.nx * (8 * dpr));
    const labelY = y1 + (n.ny * (8 * dpr));
    drawOrientedLabel(formatProfileValue(v), labelX, labelY, ang, dpr);
  }

  function drawRulerLabel(ds, item, a, b, dpr) {
    const text = rulerDistanceLabel(ds, item);
    if (!text) return;
    const cx = (a.x + b.x) * 0.5;
    const cy = (a.y + b.y) * 0.5;
    const ang = normalizedLabelAngle(a, b);
    drawOrientedLabel(text, cx, cy, ang, dpr);
  }

  function drawLine(ds, item, eff, dpr, viewport, profileHover = null, opts = {}) {
    if (!item.points || item.points.length < 2) return;
    const a = toScreen(ds, item.points[0], eff, viewport);
    const b = toScreen(ds, item.points[item.points.length - 1], eff, viewport);
    overlayCtx.strokeStyle = colorWithAlpha(item.color, 0.95);
    overlayCtx.lineWidth = 2 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(a.x, a.y);
    overlayCtx.lineTo(b.x, b.y);
    overlayCtx.stroke();
    if (item.tool === "ruler") {
      drawRulerProfile(ds, item, a, b, dpr, viewport, profileHover, opts.raster || null, opts.activeBand);
      drawRulerLabel(ds, item, a, b, dpr);
    }
  }

  function drawMarqueeStroke(pathBuilder, dpr, marqueeOffset = 0) {
    const offset = Number.isFinite(marqueeOffset) ? marqueeOffset : 0;
    overlayCtx.save();
    overlayCtx.setLineDash([3 * dpr, 3 * dpr]);
    overlayCtx.lineWidth = 2 * dpr;
    overlayCtx.strokeStyle = "rgba(17,24,39,0.95)";
    overlayCtx.lineDashOffset = -offset * dpr;
    pathBuilder();
    overlayCtx.stroke();
    overlayCtx.strokeStyle = "rgba(244,244,245,0.95)";
    overlayCtx.lineDashOffset = -(offset + 3) * dpr;
    pathBuilder();
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function drawRect(ds, item, eff, dpr, viewport, isSelection = false, marqueeOffset = 0) {
    if (!item.points || item.points.length < 2) return;
    const a = toScreen(ds, item.points[0], eff, viewport);
    const b = toScreen(ds, item.points[item.points.length - 1], eff, viewport);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    if (w < 1 || h < 1) return;
    overlayCtx.fillStyle = colorWithAlpha(item.color, 0.28);
    overlayCtx.strokeStyle = colorWithAlpha(item.color, 0.95);
    overlayCtx.lineWidth = 2 * dpr;
    overlayCtx.beginPath();
    overlayCtx.rect(x, y, w, h);
    overlayCtx.fill();
    if (isSelection) {
      drawMarqueeStroke(() => {
        overlayCtx.beginPath();
        overlayCtx.rect(x, y, w, h);
      }, dpr, marqueeOffset);
    } else {
      overlayCtx.stroke();
    }
  }

  function drawShape(ds, item, eff, dpr, viewport, isSelection = false, marqueeOffset = 0) {
    if (!item.points || item.points.length < 2) return;
    overlayCtx.fillStyle = colorWithAlpha(item.color, 0.28);
    overlayCtx.strokeStyle = colorWithAlpha(item.color, 0.95);
    overlayCtx.lineWidth = 2 * dpr;
    const buildPath = () => {
      overlayCtx.beginPath();
      const p0 = toScreen(ds, item.points[0], eff, viewport);
      overlayCtx.moveTo(p0.x, p0.y);
      for (let i = 1; i < item.points.length; i += 1) {
        const p = toScreen(ds, item.points[i], eff, viewport);
        overlayCtx.lineTo(p.x, p.y);
      }
      overlayCtx.closePath();
    };
    buildPath();
    overlayCtx.fill();
    if (isSelection) {
      drawMarqueeStroke(buildPath, dpr, marqueeOffset);
    } else {
      overlayCtx.stroke();
    }
  }

  function drawOneAnnotation(ds, item, eff, dpr, viewport, itemIndex = -1, rulerProfileHover = null, selectionIds = null, marqueeOffset = 0, opts = {}) {
    if (!item || !item.tool) return;
    const isSelection = !!(selectionIds && selectionIds.has(item.id));
    if (item.tool === "ruler" || item.tool === "line") {
      const hover = (rulerProfileHover && rulerProfileHover.drawingIndex === itemIndex) ? rulerProfileHover : null;
      drawLine(ds, item, eff, dpr, viewport, hover, opts);
    }
    else if (item.tool === "rect") drawRect(ds, item, eff, dpr, viewport, isSelection, marqueeOffset);
    else if (item.tool === "shape") drawShape(ds, item, eff, dpr, viewport, isSelection, marqueeOffset);
  }

  function drawAnnotations(ds, viewport, opts = {}) {
    if (!getDrawData) return;
    const drawData = getDrawData(ds, opts.annotations || null);
    if (!drawData) return;
    const dpr = getDevicePixelRatio();
    const eff = ds.view.scale * dpr;
    const items = Array.isArray(drawData.items) ? drawData.items : [];
    const rulerProfileHover = drawData.rulerProfileHover || null;
    const selectionIds = new Set(
      Array.isArray(drawData.selectionIds)
        ? drawData.selectionIds.filter((id) => Number.isFinite(id))
        : []
    );
    const marqueeOffset = Number.isFinite(drawData.marqueeOffset) ? drawData.marqueeOffset : 0;
    for (let i = 0; i < items.length; i += 1) {
      drawOneAnnotation(ds, items[i], eff, dpr, viewport, i, rulerProfileHover, selectionIds, marqueeOffset, opts);
    }
    if (drawData.draft) drawOneAnnotation(ds, drawData.draft, eff, dpr, viewport, -1, null, null, 0, opts);
  }

  function snapToDecimal125Step(value) {
    const v = Math.max(1, Number(value) || 1);
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const norm = v / base;
    if (norm <= 1) return Math.max(1, base);
    if (norm <= 2) return Math.max(1, 2 * base);
    if (norm <= 5) return Math.max(1, 5 * base);
    return Math.max(1, 10 * base);
  }

  function computeReferenceSpacing(ds, dpr) {
    const eff = Math.max(1e-9, ds.view.scale * dpr);
    const targetCssPx = 96;
    const targetDevPx = targetCssPx * dpr;
    const imgSpacing = Math.max(1, targetDevPx / eff);
    const stepImgPx = snapToDecimal125Step(imgSpacing);
    return {
      stepImgPx,
      stepDevPx: stepImgPx * eff
    };
  }

  function isGridEnabled() {
    if (els.btnGrid) return els.btnGrid.getAttribute("aria-pressed") === "true";
    return !!(els.chkGrid && els.chkGrid.checked);
  }

  function drawScaleBar(ds, viewport) {
    const dpr = getDevicePixelRatio();
    const ref = computeReferenceSpacing(ds, dpr);
    const barImgPx = ref.stepImgPx;
    const barDevPx = ref.stepDevPx;
    let label = "";
    const sc = ds.meta.scale;

    if (sc && Number.isFinite(sc.umPerPixelX) && sc.umPerPixelX > 0) {
      const umPerPx = Number(sc.umPerPixelX);
      label = formatDistanceUm(barImgPx * umPerPx);
    } else {
      label = `${fmtNoGroup(barImgPx)} px`;
    }

    const inset = 10 * dpr;
    const tickLen = 6 * dpr;
    const fontPx = 12 * dpr;
    overlayCtx.save();
    overlayCtx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
    overlayCtx.textAlign = "right";
    overlayCtx.textBaseline = "top";
    const textW = overlayCtx.measureText(label).width;
    const boxW = Math.max(barDevPx, textW) + (inset * 2);
    const boxH = (fontPx + tickLen + (inset * 1.8));
    const x1 = viewport.x + viewport.w - inset;
    const x0 = x1 - boxW;
    const y0 = viewport.y + inset;
    const barX1 = x1 - inset;
    const barX0 = barX1 - barDevPx;
    const barY = y0 + inset * 0.5;

    overlayCtx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(overlayCtx, x0, y0, boxW, boxH, 2 * dpr);
    overlayCtx.fill();

    overlayCtx.strokeStyle = "rgba(255,255,255,0.92)";
    overlayCtx.lineWidth = 1 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(barX0, barY);
    overlayCtx.lineTo(barX1, barY);
    overlayCtx.moveTo(barX0, barY);
    overlayCtx.lineTo(barX0, barY + tickLen);
    overlayCtx.moveTo(barX1, barY);
    overlayCtx.lineTo(barX1, barY + tickLen);
    overlayCtx.stroke();
    overlayCtx.fillStyle = "rgba(255,255,255,0.92)";
    overlayCtx.fillText(label, x1 - inset, barY + tickLen + (3 * dpr));
    overlayCtx.restore();
  }

  function computeRenderedImageRect(ds, viewport) {
    const dpr = getDevicePixelRatio();
    const eff = ds.view.scale * dpr;
    const geom = resolveRasterSampling(ds, viewport.w, viewport.h, eff);
    return geom.displayRect
      ? {
        x: viewport.x + geom.displayRect.x,
        y: viewport.y + geom.displayRect.y,
        w: geom.displayRect.w,
        h: geom.displayRect.h
      }
      : null;
  }

  function drawPanelBorder(viewport, dpr, active = false, color = "rgba(226,232,240,0.4)", label = "", opts = {}) {
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.strokeStyle = color;
    overlayCtx.lineWidth = active ? (4 * dpr) : (2 * dpr);
    overlayCtx.strokeRect(viewport.x, viewport.y, viewport.w, viewport.h);
    if (label) {
      const tagW = 18 * dpr;
      const tagH = 18 * dpr;
      const tagInset = 6 * dpr;
      const labelIndex = Math.max(0, Number(opts?.labelIndex) || 0);
      const stackOffset = (opts?.composition === "overlay") ? (labelIndex * (tagH + (4 * dpr))) : 0;
      const tagX = viewport.x + viewport.w - tagW - tagInset;
      const tagY = viewport.y + viewport.h - tagH - tagInset - stackOffset;
      overlayCtx.fillStyle = color;
      roundRect(overlayCtx, tagX, tagY, tagW, tagH, 2 * dpr);
      overlayCtx.fill();
      overlayCtx.fillStyle = "rgba(15,23,42,0.92)";
      overlayCtx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      overlayCtx.textAlign = "center";
      overlayCtx.textBaseline = "middle";
      overlayCtx.fillText(String(label), tagX + (tagW * 0.5), tagY + (tagH * 0.5));
    }
    overlayCtx.restore();
  }

  function drawOverlaysForPanel(ds, viewport, opts = {}) {
    if (!ds || !viewport) return;
    const dpr = getDevicePixelRatio();
    overlayCtx.save();
    if (typeof overlayCtx.clip === "function") {
      overlayCtx.beginPath();
      overlayCtx.rect(viewport.x, viewport.y, viewport.w, viewport.h);
      overlayCtx.clip();
    }

    if (isGridEnabled()) {
      const eff = ds.view.scale * dpr;
      const viewW = viewport.w / eff;
      const viewH = viewport.h / eff;
      const ref = computeReferenceSpacing(ds, dpr);
      const step = ref.stepImgPx;
      const startX = Math.floor(ds.view.x / step) * step;
      const endX = ds.view.x + viewW;
      const startY = Math.floor(ds.view.y / step) * step;
      const endY = ds.view.y + viewH;

      overlayCtx.strokeStyle = "rgba(255,255,255,0.12)";
      overlayCtx.lineWidth = 1 * dpr;
      overlayCtx.beginPath();
      for (let x = startX; x <= endX; x += step) {
        const sx = viewport.x + ((x - ds.view.x) * eff);
        overlayCtx.moveTo(sx, viewport.y);
        overlayCtx.lineTo(sx, viewport.y + viewport.h);
      }
      for (let y = startY; y <= endY; y += step) {
        const sy = viewport.y + ((y - ds.view.y) * eff);
        overlayCtx.moveTo(viewport.x, sy);
        overlayCtx.lineTo(viewport.x + viewport.w, sy);
      }
      overlayCtx.stroke();
    }

    const imgRect = computeRenderedImageRect(ds, viewport);
    if (imgRect && (imgRect.w < (viewport.w - 1) || imgRect.h < (viewport.h - 1))) {
      overlayCtx.save();
      overlayCtx.setLineDash([4 * dpr, 4 * dpr]);
      overlayCtx.strokeStyle = "rgba(226,232,240,0.5)";
      overlayCtx.lineWidth = 1.25 * dpr;
      overlayCtx.strokeRect(imgRect.x, imgRect.y, imgRect.w, imgRect.h);
      overlayCtx.restore();
    }

    drawAnnotations(ds, viewport, opts);
    if (opts.showScaleBar) drawScaleBar(ds, viewport);
    overlayCtx.restore();
    drawPanelBorder(viewport, dpr, !!opts.active, opts.borderColor, opts.label, opts);
  }

  function clearOverlay() {
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    overlayCtx.restore();
  }

  function drawOverlays(ds) {
    clearOverlay();
    if (!ds) return;
    drawOverlaysForPanel(ds, {
      x: 0,
      y: 0,
      w: els.overlayCanvas.width,
      h: els.overlayCanvas.height
    }, {
      active: true,
      showScaleBar: true,
      borderColor: "rgba(226,232,240,0.55)",
      label: ""
    });
  }

  return {
    clearOverlay,
    drawOverlays,
    drawOverlaysForPanel
  };
}
