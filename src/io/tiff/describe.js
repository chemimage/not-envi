import { BlobDataSource, ChunkCacheDataSource } from "../../core/data-source.js";
import { APP_CONFIG } from "../../app/config.js";
import {
  BandOffsetTiffDataSource,
  TiffBlockIndexedDataSource,
  buildBandOffsetSpecs,
  buildRawBandSpecs,
  buildRgbBandSpecs,
  buildWindowBandSpecs
} from "./data-sources.js";
import {
  buildMeta,
  buildRgbDisplayMeta,
  firstSafeOffsetOrNull,
  isHugeCompressedSingleStrip,
  isRawCompatibleGrayscale,
  isRawCompatibleSummary,
  isUncompressedSingleStrip,
  listTagValues,
  loadImageSummaries,
  loadSubIfdOverviewSummaries,
  needsRgbWindowSource,
  photometricName,
  resolveTiffCacheBudgets,
  resolveUniformSampleType,
  shouldValidateRawCandidate,
  validateRawCandidate
} from "./shared.js";

const FMAP_BLOCK_COMPRESSIONS = new Set([1, 5, 8, 32946, 32773]);

function supportsFmapBlockPath(summary) {
  return isRawCompatibleSummary(summary) && FMAP_BLOCK_COMPRESSIONS.has(Number(summary?.compression) || 1);
}

function checkedBytes(...values) {
  let total = 0;
  for (const value of values) {
    const bytes = Math.max(0, Math.floor(Number(value) || 0));
    total += bytes;
    if (!Number.isSafeInteger(total)) throw new RangeError("TIFF fallback working set exceeds the browser's exact integer range.");
  }
  return total;
}

function checkedProduct(...values) {
  let total = 1;
  for (const value of values) {
    total *= Math.max(0, Math.floor(Number(value) || 0));
    if (!Number.isSafeInteger(total)) throw new RangeError("TIFF fallback working set exceeds the browser's exact integer range.");
  }
  return total;
}

function fallbackBlockWorkingSet(summary, sampleType) {
  const directory = summary?.fileDirectory || {};
  const tiled = Array.isArray(summary?.tileOffsets) && summary.tileOffsets.length > 0;
  const blockWidth = tiled ? Number(directory.TileWidth) || summary.width : summary.width;
  const blockHeight = tiled
    ? Number(directory.TileLength) || summary.height
    : Math.min(summary.height, Number(summary.rowsPerStrip) || summary.height);
  const decoded = checkedProduct(blockWidth, blockHeight, summary.samplesPerPixel, sampleType.dataTypeInfo.bytes);
  const counts = tiled ? listTagValues(directory.TileByteCounts) : summary.stripByteCounts;
  const encoded = Math.max(0, ...counts.map((value) => Number(value) || 0));
  return { encoded, decoded, total: checkedBytes(encoded, decoded, decoded) };
}

function requireBoundedFallback(images, sampleType, deps) {
  const limit = Math.max(1, Number(
    deps?.tiffFmapOptions?.maxWorkingSetBytes ?? APP_CONFIG.fmap.maxQueuedBytes
  ) || 0);
  for (const summary of images) {
    const estimate = fallbackBlockWorkingSet(summary, sampleType);
    if (estimate.total > limit) {
      throw new Error(
        `TIFF fallback block requires about ${estimate.total} bytes (${estimate.encoded} encoded + `
        + `${estimate.decoded} decoded + ${estimate.decoded} scratch), exceeding the ${limit}-byte working-set limit. `
        + "Use a native overview or re-encode with smaller tiles/strips."
      );
    }
  }
}

function createChunkCache(file, deps) {
  if (deps?.tiffFmapRangeSource) {
    return { base: null, cached: deps.tiffFmapRangeSource, sharedFmapSource: true };
  }
  const base = new BlobDataSource(file);
  const cached = new ChunkCacheDataSource(base, {
    chunkSize: deps?.chunkSize ?? APP_CONFIG.io.defaultChunkSizeBytes,
    maxBytes: deps?.cacheBytes ?? APP_CONFIG.io.defaultDatasetCacheBytes,
    concurrency: deps?.ioConcurrency ?? APP_CONFIG.io.defaultConcurrency
  });
  return { base, cached, sharedFmapSource: false };
}

function createLinearSingleSource(summary, sampleType, file, deps) {
  if (!isRawCompatibleSummary(summary) || !isUncompressedSingleStrip(summary)) return null;
  const bytesPerSample = sampleType.dataTypeInfo.bytes;
  const { width, height, samplesPerPixel, planarConfiguration } = summary;
  const { base, cached, sharedFmapSource } = createChunkCache(file, deps);
  const description = String(file?.name || "TIFF");
  const stripOffset = firstSafeOffsetOrNull(summary.stripOffsets);
  if (stripOffset == null) {
    if (!sharedFmapSource) cached.close();
    return null;
  }

  if (samplesPerPixel === 1) {
    const bandBytes = width * height * bytesPerSample;
    if (summary.stripByteCounts[0] < bandBytes) {
      throw new Error("TIFF strip is smaller than expected grayscale image payload.");
    }
    return {
      base,
      cached,
      sharedFmapSource,
      meta: buildMeta({
        width,
        height,
        bands: 1,
        interleave: "bsq",
        littleEndian: true,
        dataType: sampleType.dataType,
        dataTypeInfo: sampleType.dataTypeInfo,
        headerOffset: stripOffset,
        description
      })
    };
  }

  if (samplesPerPixel === 3 && planarConfiguration === 1) {
    const rasterBytes = width * height * samplesPerPixel * bytesPerSample;
    if (summary.stripByteCounts[0] < rasterBytes) {
      throw new Error("TIFF strip is smaller than expected color image payload.");
    }
    return {
      base,
      cached,
      sharedFmapSource,
      meta: buildMeta({
        width,
        height,
        bands: 3,
        interleave: "bip",
        littleEndian: true,
        dataType: sampleType.dataType,
        dataTypeInfo: sampleType.dataTypeInfo,
        headerOffset: stripOffset,
        bandNames: ["Red", "Green", "Blue"],
        defaultBands: [0, 1, 2],
        defaultDisplayMode: "rgb",
        defaultAdjustColor: "red",
        description
      })
    };
  }

  if (!sharedFmapSource) cached.close();
  return null;
}

async function describeSingleImageDataset(tiff, images, file, deps, raw, sampleType, budgets) {
  const first = images[0];
  const description = String(file?.name || "TIFF");
  const overviewSummaries = await loadSubIfdOverviewSummaries(tiff, first, deps);

  if (first.samplesPerPixel !== 1 && first.samplesPerPixel !== 3) {
    throw new Error("Only grayscale TIFF or 3-band TIFF images are supported.");
  }
  if (isHugeCompressedSingleStrip(first, sampleType, file) && !deps?.tiffFmapRangeSource) {
    throw new Error("Single huge compressed-strip TIFF is not supported. Re-save it as tiled/striped TIFF or uncompressed TIFF for fast access.");
  }

  let preferWindowBlocks = false;
  if (needsRgbWindowSource(first)) {
    const meta = buildRgbDisplayMeta(
      first,
      `${description} (${photometricName(first.photometricInterpretation)} converted to RGB)`
    );
    return {
      raw,
      meta,
      mode: "block-indexed",
      base: null,
      cached: new TiffBlockIndexedDataSource({
        file,
        tiff,
        meta,
        rangeSource: deps?.tiffFmapRangeSource || null,
        bandSpecs: buildRgbBandSpecs(first, 0),
        overviewSummaries,
        budgets,
        concurrency: deps?.ioConcurrency ?? APP_CONFIG.io.defaultConcurrency
      })
    };
  }

  const linear = createLinearSingleSource(first, sampleType, file, deps);
  if (linear) {
    linear.meta.littleEndian = !!tiff.littleEndian;
    if (
      !shouldValidateRawCandidate(first, sampleType, file, 1)
      || await validateRawCandidate(linear.meta, linear.cached, images)
    ) {
      return { raw, meta: linear.meta, mode: "linear", base: linear.base, cached: linear.cached };
    }
    if (!linear.sharedFmapSource) linear.cached.close();
    preferWindowBlocks = true;
  }

  const bandOffsets = buildBandOffsetSpecs(first, sampleType);
  if (bandOffsets) {
    const { cached, sharedFmapSource } = createChunkCache(file, deps);
    const meta = buildMeta({
      width: first.width,
      height: first.height,
      bands: 3,
      interleave: "bsq",
      littleEndian: !!tiff.littleEndian,
      dataType: sampleType.dataType,
      dataTypeInfo: sampleType.dataTypeInfo,
      bandNames: ["Red", "Green", "Blue"],
      defaultBands: [0, 1, 2],
      defaultDisplayMode: "rgb",
      defaultAdjustColor: "red",
      description
    });
    const source = new BandOffsetTiffDataSource(cached, meta, bandOffsets);
    if (
      !shouldValidateRawCandidate(first, sampleType, file, 1)
      || await validateRawCandidate(meta, source, images)
    ) {
      return { raw, meta, mode: "band-offset", base: null, cached: source };
    }
    if (!sharedFmapSource) source.close();
    preferWindowBlocks = true;
  }

  const meta = buildMeta({
    width: first.width,
    height: first.height,
    bands: first.samplesPerPixel,
    interleave: first.planarConfiguration === 1 ? "bip" : "bsq",
    littleEndian: !!tiff.littleEndian,
    dataType: sampleType.dataType,
    dataTypeInfo: sampleType.dataTypeInfo,
    bandNames: first.samplesPerPixel === 3 ? ["Red", "Green", "Blue"] : null,
    defaultBands: first.samplesPerPixel === 3 ? [0, 1, 2] : null,
    defaultDisplayMode: first.samplesPerPixel === 3 ? "rgb" : null,
    defaultAdjustColor: first.samplesPerPixel === 3 ? "red" : null,
    description
  });
  return {
    raw,
    meta,
    mode: "block-indexed",
    base: null,
    cached: new TiffBlockIndexedDataSource({
        file,
        tiff,
        meta,
        rangeSource: deps?.tiffFmapRangeSource || null,
        overviewSummaries,
        bandSpecs: preferWindowBlocks
          ? buildWindowBandSpecs(first, 0)
          : buildRawBandSpecs(first, sampleType, 0),
      budgets,
      concurrency: deps?.ioConcurrency ?? APP_CONFIG.io.defaultConcurrency
    })
  };
}

async function describeMultiPageDataset(tiff, images, file, deps, raw, sampleType, budgets) {
  const first = images[0];
  const description = String(file?.name || "TIFF");

  for (let index = 0; index < images.length; index += 1) {
    const summary = images[index];
    if (summary.width !== first.width || summary.height !== first.height) {
      throw new Error("Multi-page TIFF pages must share the same dimensions.");
    }
    if (summary.samplesPerPixel !== 1) {
      throw new Error("Multi-page TIFF support is currently limited to grayscale pages.");
    }
    if (isHugeCompressedSingleStrip(summary, sampleType, file) && !deps?.tiffFmapRangeSource) {
      throw new Error("Single huge compressed-strip TIFF page is not supported. Re-save it as tiled/striped TIFF or uncompressed TIFF for fast access.");
    }
    if (!isRawCompatibleGrayscale(summary)) {
      throw new Error(`Multi-page TIFF page ${index + 1} uses unsupported ${photometricName(summary.photometricInterpretation)} photometric data.`);
    }
    const pageType = resolveUniformSampleType(summary, `TIFF page ${index + 1}`);
    if (pageType.dataType !== sampleType.dataType) {
      throw new Error("Multi-page TIFF pages must share the same sample type.");
    }
  }

  const bandBytes = first.width * first.height * sampleType.dataTypeInfo.bytes;
  let preferWindowBlocks = false;
  const simplePages = images.map((summary) => {
    if (!isUncompressedSingleStrip(summary) || summary.samplesPerPixel !== 1) return null;
    if (summary.stripByteCounts[0] < bandBytes) {
      throw new Error("TIFF page strip is smaller than expected band payload.");
    }
    return firstSafeOffsetOrNull(summary.stripOffsets);
  });

  if (simplePages.every((offset) => Number.isFinite(Number(offset)))) {
    const { base, cached, sharedFmapSource } = createChunkCache(file, deps);
    const contiguous = simplePages.every((offset, index) => offset === (simplePages[0] + (index * bandBytes)));
    const meta = buildMeta({
      width: first.width,
      height: first.height,
      bands: images.length,
      interleave: "bsq",
      littleEndian: !!tiff.littleEndian,
      dataType: sampleType.dataType,
      dataTypeInfo: sampleType.dataTypeInfo,
      description
    });
    if (contiguous) {
      meta.headerOffset = simplePages[0];
      if (
        !shouldValidateRawCandidate(first, sampleType, file, images.length)
        || await validateRawCandidate(meta, cached, images)
      ) {
        return { raw, meta, mode: "linear", base, cached };
      }
      if (!sharedFmapSource) cached.close();
      preferWindowBlocks = true;
    } else {
      const source = new BandOffsetTiffDataSource(cached, meta, simplePages);
      if (
        !shouldValidateRawCandidate(first, sampleType, file, images.length)
        || await validateRawCandidate(meta, source, images)
      ) {
        return { raw, meta, mode: "band-offset", base: null, cached: source };
      }
      if (!sharedFmapSource) source.close();
      preferWindowBlocks = true;
    }
  }

  const meta = buildMeta({
    width: first.width,
    height: first.height,
    bands: images.length,
    interleave: "bsq",
    littleEndian: !!tiff.littleEndian,
    dataType: sampleType.dataType,
    dataTypeInfo: sampleType.dataTypeInfo,
    description
  });
  return {
    raw,
    meta,
    mode: "block-indexed",
    base: null,
    cached: new TiffBlockIndexedDataSource({
      file,
      tiff,
      meta,
      rangeSource: deps?.tiffFmapRangeSource || null,
      bandSpecs: preferWindowBlocks
        ? images.flatMap((summary, index) => buildWindowBandSpecs(summary, index))
        : images.flatMap((summary, index) => buildRawBandSpecs(summary, sampleType, index)),
      budgets,
      concurrency: deps?.ioConcurrency ?? APP_CONFIG.io.defaultConcurrency
    })
  };
}

export async function describeTiffDataset(tiff, file, deps = {}) {
  deps?.setStatus?.("indexing TIFF…", "warn");
  const images = await loadImageSummaries(tiff, deps);
  const first = images[0];
  const sampleType = resolveUniformSampleType(first, "TIFF image");
  const budgets = resolveTiffCacheBudgets(deps);
  const requestedFmapSource = deps?.tiffFmapRangeSource || null;
  const useFmap = !!requestedFmapSource && images.every(supportsFmapBlockPath);
  if (requestedFmapSource && !useFmap) {
    try {
      requireBoundedFallback(images, sampleType, deps);
    } catch (error) {
      requestedFmapSource.close?.();
      throw error;
    }
  }
  const effectiveDeps = useFmap ? deps : { ...deps, tiffFmapRangeSource: null };
  const raw = {
    format: "tiff",
    imageCount: images.length,
    bigTiff: !!tiff.bigTiff,
    photometricInterpretation: first.photometricInterpretation,
    fmap: useFmap
  };
  if (requestedFmapSource && !useFmap) {
    const unsupported = images.find((summary) => !supportsFmapBlockPath(summary)) || first;
    raw.fmapReason = isRawCompatibleSummary(unsupported)
      ? `compression ${Number(unsupported.compression) || 1} uses the bounded TIFF fallback`
      : `${photometricName(unsupported.photometricInterpretation)} conversion uses the bounded TIFF fallback`;
  }

  try {
    if (images.length === 1) {
      raw.overviewCount = 0;
      const desc = await describeSingleImageDataset(tiff, images, file, effectiveDeps, raw, sampleType, budgets);
      raw.overviewCount = Number(desc?.cached?.overviewCount || 0);
      return desc;
    }
    return await describeMultiPageDataset(tiff, images, file, effectiveDeps, raw, sampleType, budgets);
  } finally {
    if (requestedFmapSource && !useFmap) requestedFmapSource.close?.();
  }
}
