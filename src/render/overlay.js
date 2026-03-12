import { fmtNoGroup } from "../core/utils.js";

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

function chooseNiceValue(ideal, toCssLen) {
  if (!Number.isFinite(ideal) || ideal <= 0) return null;
  const target = 140;
  const minOk = 60;
  const maxOk = 240;

  const exp = Math.floor(Math.log10(ideal));
  const mults = [1, 2, 5];

  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let e = exp - 2; e <= exp + 2; e++) {
    const pow = Math.pow(10, e);
    for (const m of mults) {
      const v = m * pow;
      const len = toCssLen(v);
      if (!Number.isFinite(len) || len <= 0) continue;
      const penalty = (len < minOk || len > maxOk) ? 500 : 0;
      const score = Math.abs(len - target) + penalty;
      if (score < bestScore) {
        bestScore = score;
        best = v;
      }
    }
  }
  return best ?? ideal;
}

export function createOverlayRenderer(deps) {
  const { els, overlayCtx, getDevicePixelRatio, getDrawData } = deps;

  function colorWithAlpha(color, alpha) {
    if (!color) return `rgba(34,197,94,${alpha})`;
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

  function drawLine(ds, item, eff, dpr, rulerHover = null, itemIndex = -1) {
    if (!item.points || item.points.length < 2) return;
    const a = toScreen(ds, item.points[0], eff);
    const b = toScreen(ds, item.points[item.points.length - 1], eff);
    overlayCtx.strokeStyle = colorWithAlpha(item.color, 0.95);
    overlayCtx.lineWidth = 2 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(a.x, a.y);
    overlayCtx.lineTo(b.x, b.y);
    overlayCtx.stroke();

    if (item.tool === "ruler" && rulerHover && rulerHover.drawingIndex === itemIndex) {
      const r = 5 * dpr;
      overlayCtx.fillStyle = colorWithAlpha(item.color, 0.95);
      overlayCtx.strokeStyle = "rgba(17,24,39,0.95)";
      overlayCtx.lineWidth = 1.5 * dpr;
      const showFirst = rulerHover.pointIndex === 0;
      const endpoint = showFirst ? a : b;
      overlayCtx.beginPath();
      overlayCtx.arc(endpoint.x, endpoint.y, r, 0, Math.PI * 2);
      overlayCtx.fill();
      overlayCtx.stroke();
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

  function drawOneAnnotation(ds, item, eff, dpr, rulerHover, itemIndex, selectionIds = null, marqueeOffset = 0) {
    if (!item || !item.tool) return;
    const isSelection = !!(selectionIds && selectionIds.has(item.id));
    if (item.tool === "ruler" || item.tool === "line") drawLine(ds, item, eff, dpr, rulerHover, itemIndex);
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
    const rulerHover = drawData.rulerHover || null;
    const selectionIds = new Set(
      Array.isArray(drawData.selectionIds)
        ? drawData.selectionIds.filter((id) => Number.isFinite(id))
        : []
    );
    const marqueeOffset = Number.isFinite(drawData.marqueeOffset) ? drawData.marqueeOffset : 0;
    for (let i = 0; i < items.length; i += 1) {
      drawOneAnnotation(ds, items[i], eff, dpr, rulerHover, i, selectionIds, marqueeOffset);
    }
    if (drawData.draft) drawOneAnnotation(ds, drawData.draft, eff, dpr, null, -1, null, 0);
  }

  function drawScaleBar(ds) {
    if (!els.chkScale.checked) return;

    const dpr = getDevicePixelRatio();
    const eff = ds.view.scale * dpr;
    const canvasW = els.overlayCanvas.width;
    const canvasH = els.overlayCanvas.height;

    let barImgPx = 0;
    let label = "";
    const sc = ds.meta.scale;

    if (sc && Number.isFinite(sc.umPerPixelX) && sc.umPerPixelX > 0) {
      const umPerPx = Number(sc.umPerPixelX);
      const idealUm = 140 * umPerPx / Math.max(1e-9, ds.view.scale);
      const niceUm = chooseNiceValue(idealUm, (um) => (um / umPerPx) * ds.view.scale);
      barImgPx = niceUm / umPerPx;
      label = formatDistanceUm(niceUm);
    } else {
      const idealPx = 140 / Math.max(1e-9, ds.view.scale);
      const nicePx = chooseNiceValue(idealPx, (px) => px * ds.view.scale);
      barImgPx = Math.max(1, Math.round(nicePx));
      label = `${fmtNoGroup(barImgPx)} px`;
    }

    const barDevPx = barImgPx * eff;
    const pad = 12 * dpr;
    const innerPad = 10 * dpr;
    const barYGap = 10 * dpr;
    const fontPx = 12 * dpr;

    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.font = `${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    overlayCtx.textAlign = "right";
    overlayCtx.textBaseline = "top";

    const textW = overlayCtx.measureText(label).width;
    const boxW = Math.max(barDevPx, textW) + innerPad * 2;
    const boxH = (fontPx + barYGap + 8 * dpr + innerPad * 2);

    const x1 = canvasW - pad;
    const y1 = canvasH - pad;
    const x0 = x1 - boxW;
    const y0 = y1 - boxH;

    overlayCtx.fillStyle = "rgba(0,0,0,0.55)";
    overlayCtx.strokeStyle = "rgba(255,255,255,0.22)";
    overlayCtx.lineWidth = 1 * dpr;
    roundRect(overlayCtx, x0, y0, boxW, boxH, 8 * dpr);
    overlayCtx.fill();
    overlayCtx.stroke();

    overlayCtx.fillStyle = "rgba(255,255,255,0.92)";
    overlayCtx.fillText(label, x1 - innerPad, y0 + innerPad);

    const barX1 = x1 - innerPad;
    const barX0 = barX1 - barDevPx;
    const barY = y1 - innerPad - 2 * dpr;

    overlayCtx.strokeStyle = "rgba(255,255,255,0.92)";
    overlayCtx.lineWidth = 1 * dpr;
    overlayCtx.beginPath();
    overlayCtx.moveTo(barX0, barY);
    overlayCtx.lineTo(barX1, barY);
    overlayCtx.moveTo(barX0, barY - 6 * dpr);
    overlayCtx.lineTo(barX0, barY + 1 * dpr);
    overlayCtx.moveTo(barX1, barY - 6 * dpr);
    overlayCtx.lineTo(barX1, barY + 1 * dpr);
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function drawOverlays(ds) {
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    if (!ds) {
      overlayCtx.restore();
      return;
    }

    if (els.chkGrid.checked) {
      const dpr = getDevicePixelRatio();
      const eff = ds.view.scale * dpr;
      const canvasW = els.overlayCanvas.width;
      const canvasH = els.overlayCanvas.height;
      const viewW = canvasW / eff;
      const viewH = canvasH / eff;

      const targetPx = 100;
      const imgSpacing = Math.max(1, targetPx / eff);
      const step = Math.pow(2, Math.round(Math.log2(imgSpacing)));

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
      const eff = ds.view.scale * dpr;
      const canvasW = els.overlayCanvas.width;
      const canvasH = els.overlayCanvas.height;
      const imgW = ds.meta.samples * eff;
      const imgH = ds.meta.lines * eff;
      if (imgW < (canvasW - 1) || imgH < (canvasH - 1)) {
        const x = (0 - ds.view.x) * eff;
        const y = (0 - ds.view.y) * eff;
        overlayCtx.save();
        overlayCtx.setLineDash([4 * dpr, 4 * dpr]);
        overlayCtx.lineDashOffset = 0;
        overlayCtx.strokeStyle = "rgba(226,232,240,0.5)";
        overlayCtx.lineWidth = 1.25 * dpr;
        overlayCtx.strokeRect(x, y, imgW, imgH);
        overlayCtx.restore();
      }
    }

    drawAnnotations(ds);
    drawScaleBar(ds);
    overlayCtx.restore();
  }

  return { drawOverlays };
}
