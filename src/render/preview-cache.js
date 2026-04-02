function panelSlotValue(panelSlot) {
  return Number(panelSlot) || 1;
}

function clipToViewport(ctx, viewport) {
  if (!ctx || !viewport) return;
  if (
    typeof ctx.beginPath !== "function"
    || typeof ctx.rect !== "function"
    || typeof ctx.clip !== "function"
  ) {
    return;
  }
  ctx.beginPath();
  ctx.rect(
    Number(viewport.x) || 0,
    Number(viewport.y) || 0,
    Math.max(1, Number(viewport.w) || 1),
    Math.max(1, Number(viewport.h) || 1)
  );
  ctx.clip();
}

function drawOverviewImage(ctx, image, ds, viewport, eff) {
  const base = image;
  const samples = Number(ds?.meta?.samples || 0);
  const lines = Number(ds?.meta?.lines || 0);
  if (!base || samples <= 0 || lines <= 0) return false;
  const scale = Math.max(1e-9, Number(eff) || 0);
  const dx = (Number(viewport.x) || 0) - ((Number(ds?.view?.x) || 0) * scale);
  const dy = (Number(viewport.y) || 0) - ((Number(ds?.view?.y) || 0) * scale);
  const dw = samples * scale;
  const dh = lines * scale;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dw) || !Number.isFinite(dh)) return false;
  ctx.drawImage(base, dx, dy, dw, dh);
  return true;
}

function getOverviewBase(ds) {
  const mode = String(ds?.displayMode || "gray");
  const signature = `${ds?.id || "ds"}:${mode}:${Number(ds?.activeBand) || 0}`;
  if (ds?.previewOverview?.base && ds?.previewOverview?.signature === signature) {
    return ds.previewOverview.base;
  }
  return ds?.thumb?.base || null;
}

export function drawThumbnailOverview(ctx, ds, viewport, eff) {
  const base = getOverviewBase(ds);
  return drawOverviewImage(ctx, base, ds, viewport, eff);
}

function drawPreviewBackground(cpuCtx, viewport) {
  cpuCtx.fillStyle = "#000";
  cpuCtx.fillRect(
    Number(viewport.x) || 0,
    Number(viewport.y) || 0,
    Math.max(1, Number(viewport.w) || 1),
    Math.max(1, Number(viewport.h) || 1)
  );
}

export function drawThumbnailOnlyPreview({ els, ds, viewport, eff, tint = null, composite = "source-over" }) {
  const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
  const sourceBase = getOverviewBase(ds);
  const source = tint ? tintCanvas(sourceBase, tint) : sourceBase;
  if (!source) return false;
  cpuCtx.save();
  cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
  cpuCtx.imageSmoothingEnabled = false;
  cpuCtx.globalCompositeOperation = composite;
  if (composite === "source-over") drawPreviewBackground(cpuCtx, viewport);
  clipToViewport(cpuCtx, viewport);
  const drew = drawOverviewImage(cpuCtx, source, ds, viewport, eff);
  cpuCtx.restore();
  if (drew) {
    if (els.cpuCanvas?.style) els.cpuCanvas.style.display = "block";
    if (els.gpuCanvas?.style) els.gpuCanvas.style.display = "none";
  }
  return drew;
}

function cloneCanvasImage(sourceCanvas) {
  if (!sourceCanvas) return null;
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return sourceCanvas;
  }
  if (typeof navigator !== "undefined" && /jsdom/i.test(String(navigator.userAgent || ""))) {
    return sourceCanvas;
  }
  try {
    const copy = document.createElement("canvas");
    copy.width = Math.max(1, sourceCanvas.width || 1);
    copy.height = Math.max(1, sourceCanvas.height || 1);
    const ctx = copy.getContext("2d", { alpha: false });
    if (ctx && typeof ctx.drawImage === "function") ctx.drawImage(sourceCanvas, 0, 0);
    return copy;
  } catch (_err) {
    return sourceCanvas;
  }
}

function tintCanvas(sourceCanvas, color) {
  if (!sourceCanvas) return null;
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    return sourceCanvas;
  }
  try {
    const tinted = document.createElement("canvas");
    tinted.width = Math.max(1, sourceCanvas.width || 1);
    tinted.height = Math.max(1, sourceCanvas.height || 1);
    const ctx = tinted.getContext("2d", { alpha: true });
    if (!ctx) return sourceCanvas;
    ctx.drawImage(sourceCanvas, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, tinted.width, tinted.height);
    ctx.globalCompositeOperation = "source-over";
    return tinted;
  } catch (_err) {
    return sourceCanvas;
  }
}

function getFrameMap(ds) {
  if (!ds.lastScreenFrames || typeof ds.lastScreenFrames.get !== "function") {
    ds.lastScreenFrames = new Map();
  }
  if (ds.lastScreenFrame && !ds.lastScreenFrames.has(1)) {
    ds.lastScreenFrames.set(1, ds.lastScreenFrame);
  }
  return ds.lastScreenFrames;
}

function getRasterMap(ds) {
  if (!ds.lastRastersByPanel || typeof ds.lastRastersByPanel.get !== "function") {
    ds.lastRastersByPanel = new Map();
  }
  return ds.lastRastersByPanel;
}

function getCompositeRasterMap(ds) {
  if (!ds.lastCompositeRastersByPanel || typeof ds.lastCompositeRastersByPanel.get !== "function") {
    ds.lastCompositeRastersByPanel = new Map();
  }
  return ds.lastCompositeRastersByPanel;
}

export function updatePanelRasterCache(ds, panelSlot, raster = null, compositeRaster = null) {
  if (!ds) return;
  const slot = panelSlotValue(panelSlot);
  const rasterMap = getRasterMap(ds);
  const compositeMap = getCompositeRasterMap(ds);
  if (raster) rasterMap.set(slot, raster);
  else rasterMap.delete(slot);
  if (compositeRaster) compositeMap.set(slot, compositeRaster);
  else compositeMap.delete(slot);
}

export function isStableRaster(raster) {
  return !!raster && !raster.partial && !raster.approximate;
}

export function isStableCompositeRaster(compositeRaster) {
  return !!compositeRaster && !compositeRaster.partial && !compositeRaster.approximate;
}

export function updateScreenPreviewCache(ds, panelSlot, modeKey, eff, sourceCanvas, viewport = null) {
  if (!ds || !sourceCanvas) return;
  const frame = {
    modeKey,
    eff,
    viewX: ds.view.x,
    viewY: ds.view.y,
    drawW: Math.max(1, Number(viewport?.w) || Number(sourceCanvas.width) || 1),
    drawH: Math.max(1, Number(viewport?.h) || Number(sourceCanvas.height) || 1),
    canvas: cloneCanvasImage(sourceCanvas)
  };
  getFrameMap(ds).set(panelSlotValue(panelSlot), frame);
  ds.lastScreenFrame = frame;
}

export function drawCachedScreenPreview({ els, ds, panelSlot, modeKey, eff, viewport }) {
  const frame = getFrameMap(ds).get(panelSlotValue(panelSlot));
  if (!frame || frame.modeKey !== modeKey || !frame.canvas) {
    return drawThumbnailOnlyPreview({ els, ds, viewport, eff });
  }
  const prevEff = Math.max(1e-9, Number(frame.eff) || 0);
  const scale = eff / prevEff;
  if (!Number.isFinite(scale) || scale <= 0) {
    return drawThumbnailOnlyPreview({ els, ds, viewport, eff });
  }

  const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
  const dx = (Number(viewport.x) || 0) + (((Number(frame.viewX) || 0) - ds.view.x) * eff);
  const dy = (Number(viewport.y) || 0) + (((Number(frame.viewY) || 0) - ds.view.y) * eff);

  cpuCtx.save();
  cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
  cpuCtx.imageSmoothingEnabled = false;
  drawPreviewBackground(cpuCtx, viewport);
  clipToViewport(cpuCtx, viewport);
  drawThumbnailOverview(cpuCtx, ds, viewport, eff);
  cpuCtx.drawImage(
    frame.canvas,
    dx,
    dy,
    Math.max(1, Number(frame.drawW) || frame.canvas.width || 1) * scale,
    Math.max(1, Number(frame.drawH) || frame.canvas.height || 1) * scale
  );
  cpuCtx.restore();

  if (els.cpuCanvas?.style) els.cpuCanvas.style.display = "block";
  if (els.gpuCanvas?.style) els.gpuCanvas.style.display = "none";
  return true;
}

export function drawOverlayCachedPreview({
  els,
  entries,
  layout,
  resolvePanelBand,
  clampView,
  renderModeKey,
  overlayColorForSlot
}) {
  const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
  const dpr = window.devicePixelRatio || 1;
  let drewAny = false;
  let clearedViewport = false;

  for (const entry of entries) {
    const { panel, dataset: ds } = entry;
    const viewport = layout.find((rect) => Number(rect.slot) === Number(panel.slot));
    const band = resolvePanelBand(panel, ds);
    if (!viewport || !ds || band == null) continue;

    const prevView = ds.view;
    ds.view = panel.view || prevView;
    try {
      clampView(panel.slot, ds);
      const eff = ds.view.scale * dpr;
      const modeKey = renderModeKey(ds, band, false, null);
      const frame = getFrameMap(ds).get(panelSlotValue(panel.slot));
      if (!frame || frame.modeKey !== modeKey || !frame.canvas) {
        const drewThumb = drawThumbnailOnlyPreview({
          els,
          ds,
          viewport,
          eff,
          tint: overlayColorForSlot(panel.slot),
          composite: clearedViewport ? "lighter" : "source-over"
        });
        if (drewThumb) {
          clearedViewport = true;
          drewAny = true;
        }
        continue;
      }

      const prevEff = Math.max(1e-9, Number(frame.eff) || 0);
      const scale = eff / prevEff;
      if (!Number.isFinite(scale) || scale <= 0) {
        const drewThumb = drawThumbnailOnlyPreview({
          els,
          ds,
          viewport,
          eff,
          tint: overlayColorForSlot(panel.slot),
          composite: clearedViewport ? "lighter" : "source-over"
        });
        if (drewThumb) {
          clearedViewport = true;
          drewAny = true;
        }
        continue;
      }
      const tinted = tintCanvas(frame.canvas, overlayColorForSlot(panel.slot));
      const dx = (Number(viewport.x) || 0) + (((Number(frame.viewX) || 0) - ds.view.x) * eff);
      const dy = (Number(viewport.y) || 0) + (((Number(frame.viewY) || 0) - ds.view.y) * eff);

      cpuCtx.save();
      cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
      cpuCtx.imageSmoothingEnabled = false;
      cpuCtx.globalCompositeOperation = clearedViewport ? "lighter" : "source-over";
      if (!clearedViewport) {
        drawPreviewBackground(cpuCtx, viewport);
        clearedViewport = true;
      }
      clipToViewport(cpuCtx, viewport);
      drawThumbnailOverview(cpuCtx, ds, viewport, eff);
      cpuCtx.drawImage(
        tinted,
        dx,
        dy,
        Math.max(1, Number(frame.drawW) || tinted.width || 1) * scale,
        Math.max(1, Number(frame.drawH) || tinted.height || 1) * scale
      );
      cpuCtx.restore();
      drewAny = true;
    } finally {
      ds.view = prevView;
    }
  }

  if (drewAny) {
    if (els.cpuCanvas?.style) els.cpuCanvas.style.display = "block";
    if (els.gpuCanvas?.style) els.gpuCanvas.style.display = "none";
  }
  return drewAny;
}

export async function withPanelView(ds, panel, fn) {
  if (!ds || !panel) return fn();
  const prevView = ds.view;
  ds.view = panel.view || prevView;
  try {
    return await fn();
  } finally {
    ds.view = prevView;
  }
}

export function clearBaseCanvases(els) {
  const gpuCtx = (els.gpuCanvas && typeof els.gpuCanvas.getContext === "function")
    ? els.gpuCanvas.getContext("2d", { alpha: false })
    : null;
  const cpuCtx = els.cpuCanvas.getContext("2d", { alpha: false });
  const overlayCtx = els.overlayCanvas.getContext("2d", { alpha: true });
  if (els.gpuCanvas && els.gpuCanvas.style) els.gpuCanvas.style.display = "none";
  if (els.cpuCanvas && els.cpuCanvas.style) els.cpuCanvas.style.display = "block";
  if (gpuCtx) {
    gpuCtx.setTransform(1, 0, 0, 1, 0, 0);
    gpuCtx.fillStyle = "#000";
    gpuCtx.fillRect(0, 0, els.gpuCanvas.width, els.gpuCanvas.height);
  }
  cpuCtx.setTransform(1, 0, 0, 1, 0, 0);
  cpuCtx.fillStyle = "#000";
  cpuCtx.fillRect(0, 0, els.cpuCanvas.width, els.cpuCanvas.height);
  overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
  overlayCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
}
