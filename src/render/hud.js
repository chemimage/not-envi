import { fmtUm } from "../core/utils.js";

export function createHudController(deps) {
  const {
    els,
    state,
    getActive,
    screenToImage
  } = deps;

  function formatNu(ds) {
    const b = ds.activeBand;
    if (b == null) return "—";
    const wl = ds.meta.wavelengths ? Number(ds.meta.wavelengths[b]) : NaN;
    if (!Number.isFinite(wl)) return "—";
    const units = (ds.meta.wlUnits && String(ds.meta.wlUnits).trim()) ? ` ${String(ds.meta.wlUnits).trim()}` : "";
    return `${wl.toFixed(1)}${units}`;
  }

  function setHudText(xText, yText, nuText, title = "") {
    els.hudPos.innerHTML = `<b>x</b>: ${xText}  <b>y</b>: ${yText}  <b>&nu;</b>: ${nuText}`;
    els.hudPos.title = title;
  }

  function updateHud() {
    const ds = getActive();
    if (!ds) {
      setHudText("—", "—", "—");
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const img = screenToImage(state.mouse.x * dpr, state.mouse.y * dpr);
    const ix = Math.floor(img.x);
    const iy = Math.floor(img.y);
    const nuText = formatNu(ds);

    const sc = ds.meta.scale;
    if (sc && Number.isFinite(sc.umPerPixelX) && Number.isFinite(sc.umPerPixelY)) {
      const xUm = ix * Number(sc.umPerPixelX);
      const yUm = iy * Number(sc.umPerPixelY);
      setHudText(`${fmtUm(xUm)} µm`, `${fmtUm(yUm)} µm`, nuText, `px x:${ix}  y:${iy}`);
      return;
    }

    setHudText(String(ix), String(iy), nuText);
  }

  return { updateHud };
}
