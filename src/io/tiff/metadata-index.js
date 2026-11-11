function safe(value, label, positive = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) {
    throw new RangeError(`Unsupported TIFF ${label}: ${String(value)}.`);
  }
  return number;
}

/** Exact numeric columns: Float64 retains every supported integer above 4 GiB. */
export function compactTiffIntegers(value, label = "offset", positive = false) {
  const input = value == null ? [] : Array.isArray(value) || ArrayBuffer.isView(value) ? value : [value];
  let wide = false;
  for (const entry of input) if (safe(entry, label, positive) > 0xffffffff) wide = true;
  const Ctor = wide ? Float64Array : Uint32Array;
  if (input instanceof Ctor) return input;
  return Ctor.from(input, (entry) => Number(entry));
}

/** One image-level geometry and two columns, never one retained object per block. */
export function createCompactBlockTable(summary, imageIndex = 0) {
  const width = safe(summary.width, "image width", true);
  const height = safe(summary.height, "image height", true);
  const isTiled = summary.tileOffsets.length > 0;
  const blockWidth = isTiled ? safe(summary.fileDirectory?.TileWidth || width, "tile width", true) : width;
  const blockHeight = isTiled ? safe(summary.fileDirectory?.TileLength || height, "tile height", true)
    : Math.min(height, safe(summary.rowsPerStrip || height, "rows per strip", true));
  const numBlocksX = Math.ceil(width / blockWidth), numBlocksY = Math.ceil(height / blockHeight);
  const groups = summary.planarConfiguration === 2 ? safe(summary.samplesPerPixel, "samples per pixel", true) : 1;
  const blocksPerGroup = safe(numBlocksX * numBlocksY, "block count", true);
  const blockCount = safe(blocksPerGroup * groups, "plane block count", true);
  const offsets = compactTiffIntegers(isTiled ? summary.tileOffsets : summary.stripOffsets, "tile/strip offset");
  const byteCounts = compactTiffIntegers(isTiled ? summary.fileDirectory?.TileByteCounts : summary.stripByteCounts,
    "tile/strip byte count", true);
  if (offsets.length < blockCount || byteCounts.length < blockCount) {
    throw new Error("TIFF is missing complete tile/strip offset metadata.");
  }
  for (let i = 0; i < blockCount; i += 1) safe(offsets[i] + byteCounts[i], "block end");
  try { summary.image.tiles = null; } catch (_error) { /* External decoder may expose a read-only cache. */ }
  const views = new Array(groups);
  const table = { image: summary.image, summary, imageIndex, isTiled, blockWidth, blockHeight,
    numBlocksX, numBlocksY, groups, blockCount, blocksPerGroup, offsets, byteCounts,
    group(groupIndex) {
      if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex >= groups) throw new RangeError("Invalid TIFF plane.");
      if (!views[groupIndex]) views[groupIndex] = Object.freeze({
        length: blocksPerGroup,
        at(localIndex) {
          if (!Number.isInteger(localIndex) || localIndex < 0 || localIndex >= blocksPerGroup) return undefined;
          const bx = localIndex % numBlocksX, by = Math.floor(localIndex / numBlocksX);
          const index = groupIndex * blocksPerGroup + localIndex;
          const x0 = bx * blockWidth, y0 = by * blockHeight;
          return { key: `img${imageIndex}:g${groupIndex}:b${localIndex}`, imageIndex, group: groupIndex,
            bx, by, x0, y0, w: Math.min(blockWidth, width - x0), h: Math.min(blockHeight, height - y0),
            offset: offsets[index], byteCount: byteCounts[index] };
        }
      });
      return views[groupIndex];
    }
  };
  return table;
}

const offsetOf = (summary) => Number(summary.fileDirectory?.__ifdOffset);
const same = (a, b) => a.length === b.length && a.every((value, index) => Number(value) === Number(b[index]));
const associated = (summary) => !!(Number(summary.newSubfileType) & 4)
  || /\b(label|macro)\b/i.test(`${summary.fileDirectory?.ImageDescription || ""} ${summary.fileDirectory?.PageName || ""}`);

/** Parent relation or an explicit reduced-image flag is required by callers. */
export function compatibleTiffOverview(base, candidate) {
  if (associated(candidate) || candidate.width <= 0 || candidate.height <= 0
      || candidate.width > base.width || candidate.height > base.height
      || candidate.width === base.width && candidate.height === base.height) return false;
  if (candidate.samplesPerPixel !== base.samplesPerPixel
      || candidate.planarConfiguration !== base.planarConfiguration
      || candidate.photometricInterpretation !== base.photometricInterpretation
      || !same(candidate.bitsPerSample, base.bitsPerSample) || !same(candidate.sampleFormats, base.sampleFormats)) return false;
  if (base.pageNumber?.length && candidate.pageNumber?.length && base.pageNumber[0] !== candidate.pageNumber[0]) return false;
  // Allow one output-pixel rounding error when deriving reduced dimensions.
  return Math.abs(base.width * candidate.height - base.height * candidate.width) <= Math.max(base.width, base.height);
}

/** Canonical IFD families; ordinary same-layout main-chain pages remain distinct. */
export function buildTiffImageCatalog(mainImages, allImages, parentsByOffset = new Map()) {
  const byOffset = new Map(allImages.map((summary) => [offsetOf(summary), summary]));
  const families = [], owner = new Map(), associatedImages = [];
  const add = (family, summary) => {
    if (!family.levels.includes(summary)) family.levels.push(summary);
    if (!owner.has(offsetOf(summary))) owner.set(offsetOf(summary), new Set());
    owner.get(offsetOf(summary)).add(family);
  };
  for (const summary of mainImages) {
    if (associated(summary)) { associatedImages.push(summary); continue; }
    const family = Number(summary.newSubfileType) & 1
      ? families.findLast((entry) => compatibleTiffOverview(entry.base, summary)) : null;
    if (family) add(family, summary);
    else { const next = { base: summary, levels: [] }; families.push(next); add(next, summary); }
  }
  const mainSet = new Set(mainImages);
  const ancestorFamilies = (offset) => {
    const pending = [...(parentsByOffset.get(offset) || [])], visited = new Set([offset]), result = new Set();
    while (pending.length) {
      const parent = pending.shift();
      if (visited.has(parent)) continue;
      visited.add(parent);
      if (owner.has(parent)) {
        for (const family of owner.get(parent)) result.add(family);
        continue;
      }
      pending.push(...(parentsByOffset.get(parent) || []));
    }
    return result;
  };
  for (const summary of allImages) {
    if (mainSet.has(summary)) continue;
    let attached = false;
    for (const family of ancestorFamilies(offsetOf(summary))) {
      if (!compatibleTiffOverview(family.base, summary)) continue;
      add(family, summary);
      attached = true;
    }
    if (!attached) associatedImages.push(summary);
  }
  for (const family of families) {
    family.levels.sort((a, b) => b.width * b.height - a.width * a.height);
    // The same IFD may be referenced by multiple bases. Scale belongs to the
    // family-level view; image, directory and typed block columns stay shared.
    family.levels = family.levels.map((level) => {
      if (level === family.base) return level;
      const scaleX = family.base.width / level.width, scaleY = family.base.height / level.height;
      return { ...level, isOverview: true, overviewOffset: offsetOf(level), scaleX, scaleY, scale: Math.min(scaleX, scaleY) };
    });
  }
  return { mainImages, allImages, byOffset, families, associatedImages };
}
