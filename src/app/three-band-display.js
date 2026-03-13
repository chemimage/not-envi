export const THREE_BAND_DISPLAY_MODE_GRAY = "gray";
export const THREE_BAND_DISPLAY_MODE_RGB = "rgb";
export const THREE_BAND_DISPLAY_MODE_BGR = "bgr";
export const THREE_BAND_ADJUST_RED = "red";
export const THREE_BAND_ADJUST_GREEN = "green";
export const THREE_BAND_ADJUST_BLUE = "blue";

export function isThreeBandDataset(ds) {
  return !!(ds && ds.meta && Number(ds.meta.bands) === 3);
}

export function normalizeThreeBandDisplayMode(mode) {
  if (mode === THREE_BAND_DISPLAY_MODE_RGB) return THREE_BAND_DISPLAY_MODE_RGB;
  if (mode === THREE_BAND_DISPLAY_MODE_BGR) return THREE_BAND_DISPLAY_MODE_BGR;
  return THREE_BAND_DISPLAY_MODE_GRAY;
}

export function getThreeBandDisplayMode(ds) {
  if (!isThreeBandDataset(ds)) return THREE_BAND_DISPLAY_MODE_GRAY;
  return normalizeThreeBandDisplayMode(ds.displayMode);
}

export function isThreeBandColorMode(ds) {
  const mode = getThreeBandDisplayMode(ds);
  return mode === THREE_BAND_DISPLAY_MODE_RGB || mode === THREE_BAND_DISPLAY_MODE_BGR;
}

export function resolveThreeBandChannelOrder(dsOrMode) {
  const mode = (typeof dsOrMode === "string")
    ? normalizeThreeBandDisplayMode(dsOrMode)
    : getThreeBandDisplayMode(dsOrMode);
  return mode === THREE_BAND_DISPLAY_MODE_BGR ? [2, 1, 0] : [0, 1, 2];
}

export function cycleThreeBandDisplayMode(mode) {
  const current = normalizeThreeBandDisplayMode(mode);
  if (current === THREE_BAND_DISPLAY_MODE_GRAY) return THREE_BAND_DISPLAY_MODE_RGB;
  if (current === THREE_BAND_DISPLAY_MODE_RGB) return THREE_BAND_DISPLAY_MODE_BGR;
  return THREE_BAND_DISPLAY_MODE_GRAY;
}

export function normalizeThreeBandAdjustColor(color) {
  if (color === THREE_BAND_ADJUST_GREEN) return THREE_BAND_ADJUST_GREEN;
  if (color === THREE_BAND_ADJUST_BLUE) return THREE_BAND_ADJUST_BLUE;
  return THREE_BAND_ADJUST_RED;
}

export function getThreeBandAdjustColor(ds) {
  return normalizeThreeBandAdjustColor(ds?.displayAdjustColor);
}

export function cycleThreeBandAdjustColor(color) {
  const current = normalizeThreeBandAdjustColor(color);
  if (current === THREE_BAND_ADJUST_RED) return THREE_BAND_ADJUST_GREEN;
  if (current === THREE_BAND_ADJUST_GREEN) return THREE_BAND_ADJUST_BLUE;
  return THREE_BAND_ADJUST_RED;
}

export function resolveThreeBandColorBandMap(dsOrMode) {
  const order = resolveThreeBandChannelOrder(dsOrMode);
  return {
    [THREE_BAND_ADJUST_RED]: order[0],
    [THREE_BAND_ADJUST_GREEN]: order[1],
    [THREE_BAND_ADJUST_BLUE]: order[2]
  };
}

export function resolveThreeBandAdjustBand(ds) {
  if (!isThreeBandColorMode(ds)) return Number.isFinite(ds?.activeBand) ? ds.activeBand : null;
  const map = resolveThreeBandColorBandMap(ds);
  return map[getThreeBandAdjustColor(ds)];
}

export function resolveThreeBandAdjustColorForBand(dsOrMode, band) {
  const map = resolveThreeBandColorBandMap(dsOrMode);
  if (map[THREE_BAND_ADJUST_GREEN] === band) return THREE_BAND_ADJUST_GREEN;
  if (map[THREE_BAND_ADJUST_BLUE] === band) return THREE_BAND_ADJUST_BLUE;
  return THREE_BAND_ADJUST_RED;
}
