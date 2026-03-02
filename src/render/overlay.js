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
  const { els, overlayCtx, getDevicePixelRatio } = deps;

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

    drawScaleBar(ds);
    overlayCtx.restore();
  }

  return { drawOverlays };
}
