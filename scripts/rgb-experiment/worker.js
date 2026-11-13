import { createRgbCompositor } from "./compositor.js";
import { tone01 } from "../../src/render/display-math.js";
import { reference, planar, fused } from "./kernels.js";
import { createWasmKernel } from "./wasm.js";

const mode = new URL(self.location.href).searchParams.get("mode");
let backend, compositor;
let upload = 0;
const ready = (async () => {
backend = mode.startsWith("wasm") ? await createWasmKernel(await (await fetch("/test-results/rgb-experiment.wasm")).arrayBuffer(), mode === "wasm-simd" ? "simd" : "scalar") : null;
compositor = createRgbCompositor({ tone01, colorize: backend?.colorize || ({ planar, fused }[mode] || reference),
  createImageData: (w, h) => new ImageData(w, h), createCanvas: () => {
    const canvas = new OffscreenCanvas(1, 1), get = canvas.getContext.bind(canvas);
    canvas.getContext = (...args) => {
      const ctx = get(...args), put = ctx.putImageData.bind(ctx);
      ctx.putImageData = (...args) => { const t = performance.now(); put(...args); upload += performance.now() - t; };
      return ctx;
    };
    return canvas;
  } });
})();
const planes = new Map();
self.onmessage = async ({ data: message }) => {
  try {
    await ready;
    const start = performance.now();
    const rasters = message.planes.map(input => {
      let plane = planes.get(input.id);
      if (!input.full && (!plane || plane.revision !== input.previousRevision)) throw new Error("Stale plane");
      if (!plane || input.full) plane = { w: input.w, h: input.h, dataF32: new Float32Array(input.w * input.h) };
      for (const patch of input.patches) for (let y = 0; y < patch.h; y++) plane.dataF32.set(patch.values.subarray(y * patch.w, (y + 1) * patch.w), (patch.y + y) * input.w + patch.x);
      Object.assign(plane, { compositionId: input.id, revision: input.revision, previousRevision: input.previousRevision,
        dirtyRects: input.patches.map(({ x, y, w, h }) => ({ x, y, w, h })) });
      planes.set(input.id, plane); return plane;
    });
    const ingested = performance.now(); upload = 0;
    const canvas = compositor.compose(rasters, message.params, message.opts);
    const composed = performance.now();
    const bitmap = await createImageBitmap(canvas);
    const finished = performance.now();
    self.postMessage({ id: message.id, bitmap, pixelsColored: compositor.stats.pixelsColored,
      planes: [...planes].map(([id, p]) => ({ id, w: p.w, h: p.h, revision: p.revision })),
      metrics: { ingest: ingested - start, color: composed - ingested - upload, upload, bitmap: finished - composed },
      wasm: backend?.stats() }, [bitmap]);
  } catch (error) { self.postMessage({ id: message.id, error: String(error) }); }
};
