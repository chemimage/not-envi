import { tiffSampleFormatForEnviType } from "../core/tiff-encoder.js";

export const TIFF_PYRAMID_MIN_PIXELS = 4 * 1024 * 1024;
export const TIFF_PYRAMID_TILE_SIZE = 512;

export function shouldPyramidTiff(width, height) {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    && width * height >= TIFF_PYRAMID_MIN_PIXELS;
}

const constructors = { 1: Uint8Array, 2: Int16Array, 3: Int32Array, 4: Float32Array,
  5: Float64Array, 12: Uint16Array, 13: Uint32Array, 14: BigInt64Array, 15: BigUint64Array };
const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const align4 = value => Math.ceil(value / 4) * 4;
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
export function encodePyramidalTiff({ width, height, pages, meta, rendered = false, composite = false,
  tileSize = TIFF_PYRAMID_TILE_SIZE, overviewMaxEdge = TIFF_PYRAMID_TILE_SIZE }) {
  const Ctor = rendered ? Uint8Array : constructors[meta?.dataType];
  if (!Ctor || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || !pages?.length || !Number.isInteger(tileSize) || tileSize < 16 || tileSize % 16 || overviewMaxEdge < 1) {
    throw new Error("Invalid image data for pyramidal TIFF export.");
  }
  const samples = rendered ? 4 : composite ? 3 : 1;
  const planar = composite ? 2 : 1, channels = planar === 2 ? 1 : samples;
  const planes = rendered ? pages.map(page => [page.data]) : composite ? [pages] : pages.map(page => [page]);
  if (composite && pages.length !== 3) throw new Error("RGB TIFF export requires three channel planes.");
  for (const image of planes) for (const plane of image) {
    if (!ArrayBuffer.isView(plane) || plane.length !== width * height * channels) throw new Error("TIFF planes must share dimensions.");
  }
  const bases = [], nodes = [];
  for (const image of planes) {
    const base = { w: width, h: height, planes: image, children: [] };
    bases.push(base); nodes.push(base);
    let w = width, h = height;
    while (Math.max(w, h) > overviewMaxEdge) {
      w = Math.ceil(w / 2); h = Math.ceil(h / 2);
      const child = { w, h, reduced: true, children: [] };
      base.children.push(child); nodes.push(child);
    }
  }
  let cursor = 8;
  for (const node of nodes) {
    node.tileWidth = tileExtent(node.w, tileSize);
    node.tileHeight = tileExtent(node.h, tileSize);
    node.tileByteCount = node.tileWidth * node.tileHeight * channels * Ctor.BYTES_PER_ELEMENT;
    const tileCount = Math.ceil(node.w / node.tileWidth) * Math.ceil(node.h / node.tileHeight) * (planar === 2 ? samples : 1);
    node.offsets = new Array(tileCount);
    node.tags = [
      [254, 4, [node.reduced ? 1 : 0]], [256, 4, [node.w]], [257, 4, [node.h]],
      [258, 3, Array(samples).fill(Ctor.BYTES_PER_ELEMENT * 8)], [259, 3, [1]],
      [262, 3, [samples === 1 ? 1 : 2]], [277, 3, [samples]], [284, 3, [planar]],
      [322, 4, [node.tileWidth]], [323, 4, [node.tileHeight]], [324, 4, node.offsets],
      [325, 4, Array(tileCount).fill(node.tileByteCount)],
      [339, 3, Array(samples).fill(rendered ? 1 : tiffSampleFormatForEnviType(Number(meta.dataType)))]
    ];
    if (rendered) node.tags.push([338, 3, [2]]);
    if (node.children.length) node.tags.push([330, 4, node.children.map(() => 0)]);
    node.tags.sort((a, b) => a[0] - b[0]);
    node.ifd = cursor;
    cursor += 2 + node.tags.length * 12 + 4;
  }
  for (const node of nodes) {
    if (node.children.length) node.tags.find(tag => tag[0] === 330)[2] = node.children.map(child => child.ifd);
    for (const tag of node.tags) {
      if (tag[2].length * (tag[1] === 3 ? 2 : 4) > 4) {
        cursor = align4(cursor); tag[3] = cursor;
        cursor += tag[2].length * (tag[1] === 3 ? 2 : 4);
      }
    }
  }
  const headerSize = Math.ceil(cursor / 8) * 8;
  cursor = headerSize;
  for (const node of nodes) for (let i = 0; i < node.offsets.length; i++) {
    node.offsets[i] = cursor; cursor += node.tileByteCount;
  }
  if (!Number.isSafeInteger(cursor) || cursor > 0xffffffff) {
    throw new Error("Pyramidal export exceeds the classic TIFF size limit. Select a smaller region.");
  }
  const header = new ArrayBuffer(headerSize), view = new DataView(header);
  view.setUint16(0, 0x4949, true); view.setUint16(2, 42, true); view.setUint32(4, bases[0].ifd, true);
  for (const node of nodes) {
    view.setUint16(node.ifd, node.tags.length, true);
    node.tags.forEach(([tag, type, values, external], i) => {
      const at = node.ifd + 2 + i * 12;
      view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, values.length, true);
      if (external != null) view.setUint32(at + 8, external, true);
      values.forEach((value, j) => {
        const pos = (external ?? at + 8) + j * (type === 3 ? 2 : 4);
        if (type === 3) view.setUint16(pos, value, true); else view.setUint32(pos, value, true);
      });
    });
    const index = bases.indexOf(node);
    view.setUint32(node.ifd + 2 + node.tags.length * 12, index >= 0 && index + 1 < bases.length ? bases[index + 1].ifd : 0, true);
  }
  const parts = [header];
  for (const base of bases) {
    let image = base.planes, previous = base;
    for (const node of [base, ...base.children]) {
      if (node !== base) image = overview(image, previous.w, previous.h, channels, rendered);
      for (const plane of image) for (let y = 0; y < node.h; y += node.tileHeight) for (let x = 0; x < node.w; x += node.tileWidth) {
        parts.push(tileBytes(plane, node.w, node.h, x, y, node.tileWidth, node.tileHeight, channels, Ctor));
      }
      previous = node;
    }
  }
  return new Blob(parts, { type: "image/tiff" });
}
