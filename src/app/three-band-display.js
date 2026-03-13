export const THREE_BAND_DISPLAY_MODE_GRAY = "gray";
export const THREE_BAND_DISPLAY_MODE_RGB = "rgb";
export const THREE_BAND_DISPLAY_MODE_BGR = "bgr";

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
