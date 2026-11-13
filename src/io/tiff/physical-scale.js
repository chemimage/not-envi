// TIFF resolution is pixels per physical unit; dataset scale is microns/pixel.
// Native libtiff returns scalar floats, while GeoTIFF.js exposes rationals.
function rational(value) {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Number(value[0]) / Number(value[1]);
  return Number(value);
}

export function tiffPhysicalScale(directory) {
  const unit = Number(directory?.ResolutionUnit);
  const microns = unit === 2 ? 25400 : unit === 3 ? 10000 : 0;
  const x = rational(directory?.XResolution), y = rational(directory?.YResolution);
  if (!microns || !Number.isFinite(x) || x <= 0 || !Number.isFinite(y) || y <= 0) return null;
  return { umPerPixelX: microns / x, umPerPixelY: microns / y, source: "TIFF resolution" };
}
