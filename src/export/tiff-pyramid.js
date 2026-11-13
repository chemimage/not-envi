import { LibtiffWriter } from "../io/tiff/libtiff/writer.js";

export const TIFF_PYRAMID_MIN_PIXELS = 4 * 1024 * 1024;
export const TIFF_PYRAMID_TILE_SIZE = 512;

export function shouldPyramidTiff(width, height) {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    && width * height >= TIFF_PYRAMID_MIN_PIXELS;
}

const constructors = { 1: Uint8Array, 2: Int16Array, 3: Int32Array, 4: Float32Array,
  5: Float64Array, 12: Uint16Array, 13: Uint32Array, 14: BigInt64Array, 15: BigUint64Array };
const sampleFormat = type => [4, 5].includes(type) ? 3 : [2, 3, 14].includes(type) ? 2 : 1;
const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const tileExtent = (size, limit) => Math.min(limit, Math.ceil(size / 16) * 16);

export function tiffStoragePixels(width, height) {
  if (!shouldPyramidTiff(width, height)) return width * height;
  let pixels = 0, w = width, h = height;
  for (;;) {
    const tileW = tileExtent(w, TIFF_PYRAMID_TILE_SIZE), tileH = tileExtent(h, TIFF_PYRAMID_TILE_SIZE);
    pixels += Math.ceil(w / tileW) * tileW * Math.ceil(h / tileH) * tileH;
    if (Math.max(w, h) <= TIFF_PYRAMID_TILE_SIZE) return pixels;
    w = Math.ceil(w / 2); h = Math.ceil(h / 2);
  }
}

function overview(planes, width, height, channels, rgba) {
  const w = Math.ceil(width / 2), h = Math.ceil(height / 2);
  return planes.map(source => {
    const out = new source.constructor(w * h * channels);
    const bigint = typeof source[0] === "bigint";
    const floating = source instanceof Float32Array || source instanceof Float64Array;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const at = (y * w + x) * channels;
      const rows = Math.min(2, height - y * 2), cols = Math.min(2, width - x * 2);
      if (rgba) {
        let alpha = 0, red = 0, green = 0, blue = 0;
        for (let dy = 0; dy < rows; dy++) for (let dx = 0; dx < cols; dx++) {
          const i = ((y * 2 + dy) * width + x * 2 + dx) * 4, a = source[i + 3];
          alpha += a; red += source[i] * a; green += source[i + 1] * a; blue += source[i + 2] * a;
        }
        out[at] = alpha ? Math.round(red / alpha) : 0;
        out[at + 1] = alpha ? Math.round(green / alpha) : 0;
        out[at + 2] = alpha ? Math.round(blue / alpha) : 0;
        out[at + 3] = Math.round(alpha / (rows * cols));
      } else for (let c = 0; c < channels; c++) {
        if (bigint) {
          let sum = 0n;
          for (let dy = 0; dy < rows; dy++) for (let dx = 0; dx < cols; dx++) sum += source[((y * 2 + dy) * width + x * 2 + dx) * channels + c];
          const n = BigInt(rows * cols);
          out[at + c] = sum < 0n ? -((-sum + n / 2n) / n) : (sum + n / 2n) / n;
        } else {
          let sum = 0, mean = 0, count = 0;
          for (let dy = 0; dy < rows; dy++) for (let dx = 0; dx < cols; dx++) {
            const value = source[((y * 2 + dy) * width + x * 2 + dx) * channels + c];
            if (Number.isFinite(value)) {
              count++;
              if (floating) mean += value / count - mean / count;
              else sum += value;
            }
          }
          out[at + c] = floating ? (count ? mean : NaN) : Math.round(sum / count);
        }
      }
    }
    return out;
  });
}

function tileBytes(source, width, height, x, y, tileWidth, tileHeight, channels, Ctor) {
  const tile = new Ctor(tileWidth * tileHeight * channels);
  const copyWidth = Math.min(tileWidth, width - x) * channels;
  for (let row = 0; row < Math.min(tileHeight, height - y); row++) {
    const start = ((y + row) * width + x) * channels;
    tile.set(source.subarray(start, start + copyWidth), row * tileWidth * channels);
  }
  const bytes = new Uint8Array(tile.buffer);
  if (!littleEndianHost && Ctor.BYTES_PER_ELEMENT > 1) {
    const n = Ctor.BYTES_PER_ELEMENT;
    for (let i = 0; i < bytes.length; i += n) for (let j = 0; j < n / 2; j++) {
      const value = bytes[i + j]; bytes[i + j] = bytes[i + n - j - 1]; bytes[i + n - j - 1] = value;
    }
  }
  return bytes;
}

// Overview directories are SubIFDs, not pages in the full-resolution band
// chain. Each full-resolution plane retains its own independent pyramid.
export function encodePyramidalTiff(options) {
  return encodeTiff({ ...options, pyramid: true });
}

export async function encodeTiff({ width, height, pages, meta, rendered = false, composite = false,
  compiled, pyramid = shouldPyramidTiff(width, height), bigTiff,
  tileSize = TIFF_PYRAMID_TILE_SIZE, overviewMaxEdge = TIFF_PYRAMID_TILE_SIZE }) {
  const Ctor = rendered ? Uint8Array : constructors[meta?.dataType];
  if (!Ctor || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 0xffffffff || height > 0xffffffff || !pages?.length
    || !Number.isInteger(tileSize) || tileSize < 16 || tileSize > 512 || tileSize % 16
    || !Number.isInteger(overviewMaxEdge) || overviewMaxEdge < 1) {
    throw new Error("Invalid image data for TIFF export.");
  }
  const samples = rendered ? 4 : composite ? 3 : 1;
  const planar = composite ? 2 : 1, channels = planar === 2 ? 1 : samples;
  const planes = rendered ? pages.map(page => [page.data]) : composite ? [pages] : pages.map(page => [page]);
  if (composite && pages.length !== 3) throw new Error("RGB TIFF export requires three channel planes.");
  for (const image of planes) for (const plane of image) {
    if (!ArrayBuffer.isView(plane) || plane.length !== width * height * channels) throw new Error("TIFF planes must share dimensions.");
    if (!(plane instanceof Ctor) && !(rendered && plane instanceof Uint8ClampedArray)) throw new Error("TIFF plane type does not match its sample metadata.");
  }
  const levels = [{ w: width, h: height }];
  while (pyramid && Math.max(levels.at(-1).w, levels.at(-1).h) > overviewMaxEdge) {
    const { w, h } = levels.at(-1);
    levels.push({ w: Math.ceil(w / 2), h: Math.ceil(h / 2) });
  }
  // Allow for padded tiles, codec expansion and directory arrays. Choose the
  // offset format before encoding; compression must never decide correctness.
  const storage = levels.reduce((total, { w, h }) => total + (pyramid
    ? Math.ceil(w / tileExtent(w, tileSize)) * tileExtent(w, tileSize)
      * Math.ceil(h / tileExtent(h, tileSize)) * tileExtent(h, tileSize) : w * h), 0);
  const upperBytes = storage * samples * planes.length * Ctor.BYTES_PER_ELEMENT * 1.02 + planes.length * levels.length * 65536;
  const writer = await LibtiffWriter.open(compiled, bigTiff ?? upperBytes >= 0xf0000000);
  const sx = Number(meta?.scale?.umPerPixelX), sy = Number(meta?.scale?.umPerPixelY);
  const calibrated = Number.isFinite(sx) && sx > 0 && Number.isFinite(sy) && sy > 0;
  try {
    for (const base of planes) {
      let image = base;
      for (let level = 0; level < levels.length; level++) {
        const { w, h } = levels[level];
        if (level) image = overview(image, levels[level - 1].w, levels[level - 1].h, channels, rendered);
        const blockW = pyramid ? tileExtent(w, tileSize) : w;
        const blockH = pyramid ? tileExtent(h, tileSize) : Math.min(h, Math.max(1, Math.floor(1024 * 1024 / (w * channels * Ctor.BYTES_PER_ELEMENT))));
        await writer.call("ne_tiff_write_image", [w, h, Ctor.BYTES_PER_ELEMENT * 8, samples,
          rendered ? 1 : sampleFormat(Number(meta.dataType)), planar, rendered ? 1 : 0,
          pyramid ? blockW : 0, pyramid ? blockH : 0, blockH, pyramid ? 8 : 1, level ? 1 : 0,
          level ? 0 : levels.length - 1,
          calibrated ? 10000 / sx * w / width : 0, calibrated ? 10000 / sy * h / height : 0]);
        let index = 0;
        for (const plane of image) for (let y = 0; y < h; y += blockH) for (let x = 0; x < w; x += blockW) {
          const rows = pyramid ? blockH : Math.min(blockH, h - y);
          await writer.block(index++, tileBytes(plane, w, h, x, y, blockW, rows, channels, Ctor));
        }
        await writer.call("ne_tiff_write_directory");
      }
    }
    return await writer.finish();
  } finally { writer.close(); }
}
