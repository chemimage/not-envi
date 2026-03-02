import { fmtUm } from "../core/utils.js";

export function createHudController(deps) {
  const {
    els,
    state,
    getActive,
    screenToImage,
    bandLabel,
    probeValueAtBand
  } = deps;

  let probeSeq = 0;
  let hudTimer = null;

  async function probeValue(ds, ix, iy, band) {
    const mySeq = ++probeSeq;
    const v = await probeValueAtBand(ds, ix, iy, band);
    if (mySeq !== probeSeq) return null;
    return v;
  }

  function updateHud() {
    const ds = getActive();
    if (!ds) {
      els.hudPos.textContent = "x: —  y: —";
      els.hudPos.title = "";
      els.hudVal.textContent = "value: —";
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const img = screenToImage(state.mouse.x * dpr, state.mouse.y * dpr);
    const ix = Math.floor(img.x);
    const iy = Math.floor(img.y);

    const sc = ds.meta.scale;
    if (sc && Number.isFinite(sc.umPerPixelX) && Number.isFinite(sc.umPerPixelY)) {
      const xUm = ix * Number(sc.umPerPixelX);
      const yUm = iy * Number(sc.umPerPixelY);
      els.hudPos.textContent = `x: ${fmtUm(xUm)} µm  y: ${fmtUm(yUm)} µm`;
      els.hudPos.title = `px x:${ix}  y:${iy}`;
    } else {
      els.hudPos.textContent = `x: ${ix}  y: ${iy}`;
      els.hudPos.title = "";
    }

    const band = ds.activeBand;
    if (band == null) {
      els.hudVal.textContent = "value: —";
      return;
    }

    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      probeValue(ds, ix, iy, band).then((v) => {
        if (v === null || v === undefined || !Number.isFinite(v)) {
          els.hudVal.textContent = "value: —";
        } else {
          const bName = bandLabel(ds, band);
          els.hudVal.textContent = `${bName}: ${v.toFixed(4)}`;
        }
      }).catch(() => {});
    }, 40);
  }

  return { updateHud };
}
