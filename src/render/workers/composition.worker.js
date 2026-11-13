import { createRgbCompositor } from "../rgb-composition.js";
import { tone01 } from "../display-math.js";
import { loadRgbSimdKernel } from "../rgb-simd-loader.js";

const planes = new Map();
let bytes = 0;
let compositor, kernel;
// Register the message handler synchronously; messages received during WASM
// startup wait inside the handler instead of being lost to a top-level await.
const ready = loadRgbSimdKernel().then(value => {
  kernel = value;
  compositor = createRgbCompositor({ createCanvas: () => new OffscreenCanvas(1, 1),
    createImageData: (w, h) => new ImageData(w, h), tone01, colorize: kernel?.colorize });
});

self.onmessage = async ({ data: message }) => {
  try {
    await ready;
    const rasters = message.planes.map((input) => {
      let plane = planes.get(input.id);
      if (!input.full && (!plane || plane.w !== input.w || plane.h !== input.h
        || plane.revision !== input.previousRevision)) throw new Error("Composition plane revision is no longer resident.");
      if (!plane || input.full) {
        if (plane) bytes -= plane.dataF32.byteLength;
        plane = { w: input.w, h: input.h, dataF32: new Float32Array(input.w * input.h) };
        bytes += plane.dataF32.byteLength;
      }
      for (const patch of input.patches) for (let y = 0; y < patch.h; y += 1) {
        plane.dataF32.set(patch.values.subarray(y * patch.w, (y + 1) * patch.w), (patch.y + y) * input.w + patch.x);
      }
      Object.assign(plane, { compositionId: input.id, revision: input.revision,
        previousRevision: input.previousRevision, dirtyRects: input.patches.map(({ x, y, w, h }) => ({ x, y, w, h })) });
      planes.delete(input.id); planes.set(input.id, plane);
      return plane;
    });
    const canvas = compositor.compose(rasters, message.params, message.opts);
    // createImageBitmap preserves the retained canvas contents. In contrast,
    // transferToImageBitmap would clear it and invalidate later dirty updates.
    const bitmap = await createImageBitmap(canvas);
    while (planes.size > 6 || bytes > message.maxBytes) {
      const id = planes.keys().next().value;
      bytes -= planes.get(id).dataF32.byteLength; planes.delete(id);
    }
    self.postMessage({ id: message.id, bitmap, pixelsColored: compositor.stats.pixelsColored,
      kernel: kernel ? { ...kernel.stats } : { backend: "js", allocatedBytes: 0 },
      planes: [...planes].map(([id, plane]) => ({ id, w: plane.w, h: plane.h, revision: plane.revision })) }, [bitmap]);
  } catch (error) {
    planes.clear(); bytes = 0; compositor?.clear();
    self.postMessage({ id: message.id, error: error?.message || String(error) });
  }
};
