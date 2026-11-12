import { fmtUm } from "../core/utils.js";
import { readLineProfile } from "./line-profile-data.js";

export function createLineProfileController({
  els, getTarget, bandLabel, onShow = () => {}, onDelete = () => {}, onResult,
  readProfile = readLineProfile, maxSamples = 1024, concurrency = 3
}) {
  const canvas = els.lineProfileCanvas;
  const ctx = canvas.getContext("2d", { alpha: true });
  let anchor = null;
  let target = null;
  let result = null;
  let sequence = 0;
  let requestKey = "";
  let timer = null;
  let unit = "px";
  let message = "";
  let hover = null;
  let plot = null;

  function physicalLength() {
    const scale = target?.ds.meta.scale;
    if (!(scale?.umPerPixelX > 0 && scale?.umPerPixelY > 0)
      || !Number.isFinite(scale.umPerPixelX) || !Number.isFinite(scale.umPerPixelY)) return null;
    const a = target.item.points[0];
    const b = target.item.points.at(-1);
    return Math.hypot((b.x - a.x) * scale.umPerPixelX, (b.y - a.y) * scale.umPerPixelY);
  }

  function syncMetadata() {
    if (!target) return;
    const a = target.item.points[0];
    const b = target.item.points.at(-1);
    els.lineProfileCoordinates.textContent = `(${fmtUm(a.x)}, ${fmtUm(a.y)}) → (${fmtUm(b.x)}, ${fmtUm(b.y)})`;
    els.lineProfileBand.textContent = bandLabel(target.ds, target.band);
    const calibrated = physicalLength() !== null;
    if (!calibrated) unit = "px";
    els.btnLineProfileUm.disabled = !calibrated;
    els.btnLineProfileUm.title = calibrated ? "Distance in micrometers" : "Spatial calibration unavailable";
    els.btnLineProfileUm.setAttribute("aria-pressed", String(unit === "um"));
    els.btnLineProfilePx.setAttribute("aria-pressed", String(unit === "px"));
    els.lineProfileStatus.textContent = message || (result?.sampled
      ? `Sampled: ${result.values.length} points along the line.` : "Hover to inspect values.");
  }

  function redraw() {
    if (!anchor || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);
    syncMetadata();
    plot = null;
    const finiteValues = result ? Array.from(result.values).filter(Number.isFinite) : [];
    if (!finiteValues.length) {
      ctx.fillStyle = "rgba(229,231,235,0.92)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(message || "No finite values along this line.", w / 2, h / 2);
      return;
    }
    const length = unit === "um" ? physicalLength() : result.lengthPx;
    let min = Math.min(...finiteValues);
    let max = Math.max(...finiteValues);
    const pad = (max - min) * 0.06 || Math.max(Math.abs(min) * 0.06, 1);
    min -= pad;
    max += pad;
    plot = { left: 58, top: 14, width: Math.max(1, w - 76), height: Math.max(1, h - 58) };
    const px = (fraction) => plot.left + fraction * plot.width;
    const py = (value) => plot.top + (max - value) / (max - min) * plot.height;
    ctx.font = "12px system-ui";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const fraction = i / 4;
      const x = px(fraction);
      const y = plot.top + fraction * plot.height;
      ctx.strokeStyle = "rgba(148,163,184,0.15)";
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.top + plot.height);
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.left + plot.width, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(229,231,235,0.92)";
      ctx.textAlign = "center";
      ctx.fillText(fmtUm(length * fraction), x, plot.top + plot.height + 17);
      ctx.textAlign = "right";
      ctx.fillText(fmtUm(max - fraction * (max - min)), plot.left - 7, y + 4);
    }
    ctx.textAlign = "center";
    ctx.fillText(`Distance (${unit === "um" ? "µm" : "px"})`, plot.left + plot.width / 2, h - 5);
    ctx.strokeStyle = target.item.color || "#e5e7eb";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let connected = false;
    result.values.forEach((value, i) => {
      if (!Number.isFinite(value)) { connected = false; return; }
      const x = px(i / (result.values.length - 1));
      if (connected) ctx.lineTo(x, py(value));
      else ctx.moveTo(x, py(value));
      connected = true;
    });
    ctx.stroke();
    if (hover !== null) {
      const index = Math.round(hover * (result.values.length - 1));
      const x = px(index / (result.values.length - 1));
      ctx.strokeStyle = "rgba(229,231,235,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.top + plot.height);
      ctx.stroke();
      els.lineProfileStatus.textContent = `${fmtUm(length * index / (result.values.length - 1))} ${unit === "um" ? "µm" : "px"} · value = ${Number.isFinite(result.values[index]) ? fmtUm(result.values[index]) : "—"}`;
    }
  }

  function close() {
    sequence += 1;
    clearTimeout(timer);
    timer = null;
    anchor = null;
    target = null;
    result = null;
    requestKey = "";
    els.lineProfilePanel.style.display = "none";
    els.lineProfilePanel.setAttribute("aria-hidden", "true");
  }

  function refresh(immediate = false) {
    if (!anchor) return;
    const next = getTarget(anchor);
    if (!next) { close(); return; }
    target = next;
    const key = JSON.stringify([next.ds.id, next.item.id, next.item.points, next.band, next.ds.meta.scale]);
    if (key === requestKey) return;
    requestKey = key;
    const seq = ++sequence;
    clearTimeout(timer);
    result = null;
    hover = null;
    message = "Computing line profile…";
    redraw();
    const read = async () => {
      timer = null;
      try {
        const data = await readProfile(next.ds, next.item, next.band, {
          maxSamples, concurrency, cancelled: () => seq !== sequence,
          onProgress: ({ completed, total }) => {
            if (seq !== sequence) return;
            message = `Computing line profile… ${completed}/${total} samples`;
            els.lineProfileStatus.textContent = message;
          }
        });
        if (seq !== sequence) return;
        result = data;
        message = "";
        if (data) onResult?.({ anchor: { ...anchor }, target: next, result: data });
      } catch (error) {
        if (seq !== sequence) return;
        message = "Could not read this line profile.";
        console.warn("Line profile failed", error);
      }
      redraw();
    };
    if (immediate) return read();
    timer = setTimeout(read, 75);
  }

  function open(nextAnchor) {
    anchor = nextAnchor;
    requestKey = "";
    els.lineProfilePanel.style.display = "flex";
    els.lineProfilePanel.setAttribute("aria-hidden", "false");
    onShow();
    return refresh(true);
  }

  els.btnLineProfileDelete?.addEventListener("click", () => {
    if (!anchor) return;
    const deleted = { ...anchor };
    close(); // Retire an in-flight read before removing its source annotation.
    onDelete(deleted);
  });
  els.btnLineProfileClose.addEventListener("click", close);
  for (const [button, value] of [[els.btnLineProfileUm, "um"], [els.btnLineProfilePx, "px"]]) {
    button.addEventListener("click", () => { unit = value; redraw(); });
  }
  canvas.addEventListener("pointermove", (event) => {
    if (!plot) return;
    const rect = canvas.getBoundingClientRect();
    hover = Math.min(1, Math.max(0, (event.clientX - rect.left - plot.left) / plot.width));
    redraw();
  });
  canvas.addEventListener("pointerleave", () => { hover = null; redraw(); });
  window.addEventListener("resize", redraw);
  return { open, refresh, redraw, close };
}
