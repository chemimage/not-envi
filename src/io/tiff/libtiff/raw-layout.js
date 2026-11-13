/** Coalesce only proven, tightly packed raw ranges, including libtiff's
 * synthetic chopped strips. This keeps large raw TIFFs on bounded fmap reads. */
export function coalesceRawStrips(directory, fileSize) {
  const samples = Number(directory.SamplesPerPixel || 1);
  if (Number(directory.Compression || 1) !== 1 || directory.TileOffsets?.length
    || Number(directory.PlanarConfiguration || 1) !== 1 && samples !== 1) return;
  const offsets = directory.StripOffsets, counts = directory.StripByteCounts;
  const width = Number(directory.ImageWidth), height = Number(directory.ImageLength);
  const rows = Number(directory.RowsPerStrip || height), bits = Number(directory.BitsPerSample);
  const rowBytes = width * samples * bits / 8, total = rowBytes * height;
  if (!offsets?.length || offsets.length !== counts?.length || offsets.length !== Math.ceil(height / rows)
    || !Number.isSafeInteger(rows) || rows <= 0 || !Number.isSafeInteger(rowBytes) || rowBytes <= 0
    || !Number.isSafeInteger(total) || !Number.isSafeInteger(offsets[0] + total) || offsets[0] + total > fileSize) return;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] !== offsets[0] + i * rows * rowBytes || counts[i] !== Math.min(rows, height - i * rows) * rowBytes) return;
  }
  const Offset = offsets[0] > 0xffffffff ? Float64Array : Uint32Array;
  const Count = total > 0xffffffff ? Float64Array : Uint32Array;
  directory.StripOffsets = new Offset([offsets[0]]);
  directory.StripByteCounts = new Count([total]);
  directory.RowsPerStrip = height;
}
