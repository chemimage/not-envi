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
  const { els, overlayCtx, getDevicePixelRatio, getDrawData } = deps;
  const SCALEBAR_EDGE_PAD_CSS = 10;
  const SCALEBAR_HUD_GAP_CSS = 8;
  const HUD_RADIUS_CSS = 2;

  function colorWithAlpha(color, alpha) {
    if (!color) return `rgba(255,45,45,${alpha})`;
    const c = String(color).trim();
    const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(c);
    if (!m) return c;
    let hex = m[1];
    if (hex.length === 3) {
      hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function toScreen(ds, pt, eff) {
    return {
      x: (pt.x - ds.view.x) * eff,
      y: (pt.y - ds.view.y) * eff
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

  function drawRulerProfile(ds, item, a, b, dpr, profileHover = null) {
    if (!ds || !item || !Array.isArray(item.points) || item.points.length < 2) return;
    const raster = ds.lastRaster;
    if (!raster || raster.band !== ds.activeBand || !raster.dataF32) return;
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
      const v = sampleRasterValue(raster, ix, iy);
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
    const v = sampleRasterValue(raster, ix, iy);
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

  function drawLine(ds, item, eff, dpr, profileHover = null) {
    if (!item.points || item.points.length < 2) return;
    const a = toScreen(ds, item.points[0], eff);
    const b = toScreen(ds, item.points[item.points.length - 1], eff);
    overlayCtx.strokeStyle = colorWithAlpha(item.color, 0.95);
    overlayCtx.lineWidth = 2 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(a.x, a.y);
    overlayCtx.lineTo(b.x, b.y);
    overlayCtx.stroke();
    if (item.tool === "ruler") {
      drawRulerProfile(ds, item, a, b, dpr, profileHover);
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

  function drawRect(ds, item, eff, dpr, isSelection = false, marqueeOffset = 0) {
    if (!item.points || item.points.length < 2) return;
    const a = toScreen(ds, item.points[0], eff);
    const b = toScreen(ds, item.points[item.points.length - 1], eff);
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

  function drawShape(ds, item, eff, dpr, isSelection = false, marqueeOffset = 0) {
    if (!item.points || item.points.length < 2) return;
    overlayCtx.fillStyle = colorWithAlpha(item.color, 0.28);
    overlayCtx.strokeStyle = colorWithAlpha(item.color, 0.95);
    overlayCtx.lineWidth = 2 * dpr;
    const buildPath = () => {
      overlayCtx.beginPath();
      const p0 = toScreen(ds, item.points[0], eff);
      overlayCtx.moveTo(p0.x, p0.y);
      for (let i = 1; i < item.points.length; i += 1) {
        const p = toScreen(ds, item.points[i], eff);
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

  function drawOneAnnotation(ds, item, eff, dpr, itemIndex = -1, rulerProfileHover = null, selectionIds = null, marqueeOffset = 0) {
    if (!item || !item.tool) return;
    const isSelection = !!(selectionIds && selectionIds.has(item.id));
    if (item.tool === "ruler" || item.tool === "line") {
      const hover = (rulerProfileHover && rulerProfileHover.drawingIndex === itemIndex) ? rulerProfileHover : null;
      drawLine(ds, item, eff, dpr, hover);
    }
    else if (item.tool === "rect") drawRect(ds, item, eff, dpr, isSelection, marqueeOffset);
    else if (item.tool === "shape") drawShape(ds, item, eff, dpr, isSelection, marqueeOffset);
  }

  function drawAnnotations(ds) {
    if (!getDrawData) return;
    const drawData = getDrawData(ds);
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
      drawOneAnnotation(ds, items[i], eff, dpr, i, rulerProfileHover, selectionIds, marqueeOffset);
    }
    if (drawData.draft) drawOneAnnotation(ds, drawData.draft, eff, dpr, -1, null, null, 0);
  }

  function computeReferenceSpacing(ds, dpr) {
    const eff = Math.max(1e-9, ds.view.scale * dpr);
    const targetCssPx = 96;
    const targetDevPx = targetCssPx * dpr;
    const imgSpacing = Math.max(1, targetDevPx / eff);
    const stepImgPx = Math.max(1, Math.pow(2, Math.round(Math.log2(imgSpacing))));
    return {
      stepImgPx,
      stepDevPx: stepImgPx * eff
    };
  }

  function isGridEnabled() {
    if (els.btnGrid) return els.btnGrid.getAttribute("aria-pressed") === "true";
    return !!(els.chkGrid && els.chkGrid.checked);
  }

  function resolveScaleBarAnchor(canvasW, canvasH, dpr, boxH) {
    const edgePad = SCALEBAR_EDGE_PAD_CSS * dpr;
    let right = canvasW - edgePad;
    let top = edgePad;
    const host = els.main;
    let anchorRect = null;
    const anchors = [els.hudControls, els.overlayHUD];
    for (const anchor of anchors) {
      if (!anchor || !anchor.getBoundingClientRect) continue;
      const rect = anchor.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) continue;
      anchorRect = rect;
      break;
    }
    if (host && host.getBoundingClientRect && anchorRect) {
      const hostRect = host.getBoundingClientRect();
      if (Number.isFinite(hostRect.left) && Number.isFinite(anchorRect.right)) {
        right = (anchorRect.right - hostRect.left) * dpr;
        top = (anchorRect.bottom - hostRect.top) * dpr + (SCALEBAR_HUD_GAP_CSS * dpr);
      }
    }
    const clampedRight = Math.min(canvasW - edgePad, Math.max(edgePad, right));
    const maxTop = Math.max(edgePad, canvasH - edgePad - boxH);
    const clampedTop = Math.min(maxTop, Math.max(edgePad, top));
    return { right: clampedRight, top: clampedTop };
  }

  function drawScaleBar(ds) {
    const dpr = getDevicePixelRatio();
    const ref = computeReferenceSpacing(ds, dpr);
    const barImgPx = ref.stepImgPx;
    const barDevPx = ref.stepDevPx;
    const canvasW = els.overlayCanvas.width;
    const canvasH = els.overlayCanvas.height;
    let label = "";
    const sc = ds.meta.scale;

    if (sc && Number.isFinite(sc.umPerPixelX) && sc.umPerPixelX > 0) {
      const umPerPx = Number(sc.umPerPixelX);
      label = formatDistanceUm(barImgPx * umPerPx);
    } else {
      label = `${fmtNoGroup(barImgPx)} px`;
    }

    const innerPad = 10 * dpr;
    const tickLen = 6 * dpr;
    const labelGap = 4 * dpr;
    const linePadTop = 2 * dpr;
    const fontPx = 12 * dpr;

    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.font = `${fontPx}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace`;
    overlayCtx.textAlign = "right";
    overlayCtx.textBaseline = "top";

    const textW = overlayCtx.measureText(label).width;
    const boxW = Math.max(barDevPx, textW) + innerPad * 2;
    const boxH = (innerPad + linePadTop + tickLen + labelGap + fontPx + innerPad);

    const anchor = resolveScaleBarAnchor(canvasW, canvasH, dpr, boxH);
    const anchoredX1 = anchor.right;
    const anchoredY0 = anchor.top;
    const anchoredX0 = anchoredX1 - boxW;

    overlayCtx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(overlayCtx, anchoredX0, anchoredY0, boxW, boxH, HUD_RADIUS_CSS * dpr);
    overlayCtx.fill();

    const barX1 = anchoredX1 - innerPad;
    const barX0 = barX1 - barDevPx;
    const barY = anchoredY0 + innerPad + linePadTop;

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
    overlayCtx.fillText(label, anchoredX1 - innerPad, barY + tickLen + labelGap);
    overlayCtx.restore();
  }

  function computeRenderedImageRect(ds) {
    const dpr = getDevicePixelRatio();
    const eff = ds.view.scale * dpr;
    const canvasW = els.overlayCanvas.width;
    const canvasH = els.overlayCanvas.height;
    const geom = resolveRasterSampling(ds, canvasW, canvasH, eff);
    return geom.displayRect;
  }

  function drawOverlays(ds) {
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    if (!ds) {
      overlayCtx.restore();
      return;
    }

    if (isGridEnabled()) {
      const dpr = getDevicePixelRatio();
      const eff = ds.view.scale * dpr;
      const canvasW = els.overlayCanvas.width;
      const canvasH = els.overlayCanvas.height;
      const viewW = canvasW / eff;
      const viewH = canvasH / eff;
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
        const sx = (x - ds.view.x) * eff;
        overlayCtx.moveTo(sx, 0);
        overlayCtx.lineTo(sx, canvasH);
      }
      for (let y = startY; y <= endY; y += step) {
        const sy = (y - ds.view.y) * eff;
        overlayCtx.moveTo(0, sy);
        overlayCtx.lineTo(canvasW, sy);
      }
      overlayCtx.stroke();
    }

    {
      const dpr = getDevicePixelRatio();
      const canvasW = els.overlayCanvas.width;
      const canvasH = els.overlayCanvas.height;
      const imgRect = computeRenderedImageRect(ds);
      if (imgRect && (imgRect.w < (canvasW - 1) || imgRect.h < (canvasH - 1))) {
        overlayCtx.save();
        overlayCtx.setLineDash([4 * dpr, 4 * dpr]);
        overlayCtx.lineDashOffset = 0;
        overlayCtx.strokeStyle = "rgba(226,232,240,0.5)";
        overlayCtx.lineWidth = 1.25 * dpr;
        overlayCtx.strokeRect(imgRect.x, imgRect.y, imgRect.w, imgRect.h);
        overlayCtx.restore();
      }
    }

    drawAnnotations(ds);
    drawScaleBar(ds);
    overlayCtx.restore();
  }

  return { drawOverlays };
}
