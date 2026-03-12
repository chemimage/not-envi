export function unitToMicronsFactor(unitStr) {
  const u = String(unitStr || "").trim().toLowerCase();
  if (!u) return null;
  // Important: test the more specific names first to avoid matching "meter" in "micrometer".
  if (u.includes("micrometer") || u.includes("micrometre") || u.includes("micron") || u === "um" || u.includes("µm")) return 1;
  if (u.includes("nanometer") || u.includes("nanometre") || u === "nm") return 0.001;
  if (u.includes("millimeter") || u.includes("millimetre") || u === "mm") return 1000;
  if (u.includes("centimeter") || u.includes("centimetre") || u === "cm") return 10000;
  if (u === "m" || u === "meter" || u === "metre" || u.includes("meter") || u.includes("metre")) return 1_000_000;
  return null;
}

export function parseUmPerPixelFromMapInfo(mapInfo) {
  if (!Array.isArray(mapInfo) || mapInfo.length < 7) return null;
  const xPix = Number(mapInfo[5]);
  const yPix = Number(mapInfo[6]);
  if (!Number.isFinite(xPix) || !Number.isFinite(yPix) || xPix <= 0 || yPix <= 0) return null;

  let units = null;
  for (const it of mapInfo.slice(7)) {
    const m = String(it).match(/units\s*=\s*([^,}]+)/i);
    if (m) {
      units = m[1].trim();
      break;
    }
  }
  const factor = unitToMicronsFactor(units);
  if (!Number.isFinite(factor)) return null;
  return {
    umPerPixelX: xPix * factor,
    umPerPixelY: yPix * factor,
    source: "map info"
  };
}

export function parseUmPerPixelFromCustomFields(raw) {
  if (!raw || typeof raw !== "object") return null;
  // ENVI "pixel size" is natively expressed in meters unless a unit override is provided.
  const ENVI_NATIVE_PIXEL_SIZE_TO_UM = 1_000_000;
  const unitHints = [
    raw["pixel size units"],
    raw["spatial units"],
    raw["units"],
    raw["unit"]
  ].filter(Boolean);
  const hintedFactor = unitToMicronsFactor(unitHints[0] || "");

  const candidates = [
    ["pixel size", hintedFactor || ENVI_NATIVE_PIXEL_SIZE_TO_UM],
    ["pixel_size", hintedFactor || ENVI_NATIVE_PIXEL_SIZE_TO_UM],
    ["pixel size (um)", 1],
    ["pixel_size_um", 1]
  ];

  const parseXY = (v) => {
    if (Array.isArray(v) && v.length >= 2) {
      const x = Number(v[0]);
      const y = Number(v[1]);
      if (Number.isFinite(x) && Number.isFinite(y) && x > 0 && y > 0) return { x, y };
      return null;
    }
    const x = Number(v);
    if (Number.isFinite(x) && x > 0) return { x, y: x };
    return null;
  };

  for (const [k, unitOrFactor] of candidates) {
    if (!(k in raw)) continue;
    const parsed = parseXY(raw[k]);
    if (!parsed) continue;
    let f = Number(unitOrFactor);
    if (!Number.isFinite(f)) f = 1;
    return {
      umPerPixelX: parsed.x * f,
      umPerPixelY: parsed.y * f,
      source: `header:${k}`
    };
  }

  return null;
}
