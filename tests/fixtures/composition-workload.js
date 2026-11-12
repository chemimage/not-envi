import { CompositionPlane } from "../../src/render/incremental-composition.js";
import { createRgbCompositor } from "../../src/render/rgb-composition.js";
import { tone01 } from "../../src/render/display-math.js";

/** Same kernel with fresh planes versus retained planes. This measures work
 * reuse, not literal historical-release timing. Every progressive RGBA frame
 * must match, and the final image is checked against independent source pixels. */
export function compositionWorkload() {
  const width = 512, height = 384, size = 64;
  const valueAt = (band, x, y) => (Math.imul(x + 17, 131) + Math.imul(y + 11, 73) + band * 47) & 255;
  const hash = (bytes) => { let h = 2166136261; for (const value of bytes) h = Math.imul(h ^ value, 16777619); return h >>> 0; };
  const expected = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4;
    for (let band = 0; band < 3; band += 1) expected[index + band] = valueAt(band, x, y);
    expected[index + 3] = 255;
  }
  const coarse = [0, 1, 2].map((band) => ({ level: 3, w: width / 8,
    data: Float32Array.from({ length: width * height / 64 }, (_, index) =>
      valueAt(band, (index % (width / 8)) * 8, Math.floor(index / (width / 8)) * 8)) }));
  const tiles = [];
  for (let ty = 0; ty < height / size; ty += 1) for (let tx = 0; tx < width / size; tx += 1) {
    tiles.push([0, 1, 2].map((band) => ({ level: 0, w: size, tx, ty,
      data: Float32Array.from({ length: size * size }, (_, index) =>
        valueAt(band, tx * size + index % size, ty * size + Math.floor(index / size))) })));
  }
  const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 255, brightness: 0, gain: 1, contrast: 1 }));
  function run(incremental) {
    let planes;
    let composePixels = 0;
    const frameHashes = [];
    const compositor = createRgbCompositor({ tone01, createCanvas: () => document.createElement("canvas"),
      createImageData: (w, h) => new ImageData(w, h) });
    const start = performance.now();
    for (let arrived = 0; arrived <= tiles.length; arrived += 4) {
      if (!incremental || !planes) planes = [0, 1, 2].map(() => new CompositionPlane("view", { w: width, h: height, idealLevel: 0 }, true));
      const rasters = planes.map((plane, band) => {
        plane.begin();
        plane.apply(coarse[band], "coarse", { x: 0, y: 0, w: width, h: height }, 8, 0, 0, 0, 0);
        for (let i = 0; i < arrived; i += 1) {
          const tile = tiles[i][band];
          plane.apply(tile, String(i), { x: tile.tx * size, y: tile.ty * size, w: size, h: size },
            1, 0, 0, tile.tx * size, tile.ty * size);
        }
        composePixels += plane.changedPixels;
        return { ...plane.finish(width * height), w: width, h: height, dataF32: plane.data };
      });
      const canvas = compositor.compose(rasters, params);
      frameHashes.push(hash(canvas.getContext("2d").getImageData(0, 0, width, height).data));
      const before = compositor.stats.pixelsColored;
      compositor.compose(rasters, params);
      if (compositor.stats.pixelsColored !== before) throw new Error("Unchanged frame was recolored.");
    }
    const result = { elapsedMs: performance.now() - start, composePixels,
      colorPixels: compositor.stats.pixelsColored, frameHashes, finalChecksum: frameHashes.at(-1) };
    compositor.clear();
    return result;
  }
  const full = run(false), incremental = run(true);
  const expectedChecksum = hash(expected);
  if (full.finalChecksum !== expectedChecksum || incremental.finalChecksum !== expectedChecksum
    || JSON.stringify(full.frameHashes) !== JSON.stringify(incremental.frameHashes)) throw new Error("Progressive composition pixel mismatch.");
  if (incremental.composePixels >= full.composePixels / 2 || incremental.colorPixels >= full.colorPixels / 2) {
    throw new Error("Retained composition did not reduce pixel work.");
  }
  return { width, height, tilesPerChannel: tiles.length, expectedChecksum, full, incremental };
}
