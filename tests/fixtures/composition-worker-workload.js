import { createCompositionWorkerClient } from "../../src/render/composition-worker-client.js";
import { createRgbCompositor } from "../../src/render/rgb-composition.js";
import { tone01 } from "../../src/render/display-math.js";

const hash = (bytes) => {
  let value = 2166136261;
  for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
  return value >>> 0;
};

function compositor() {
  return createRgbCompositor({ tone01, createCanvas: () => document.createElement("canvas"),
    createImageData: (w, h) => new ImageData(w, h) });
}

/** Actual worker versus the shared synchronous pixel kernel. Timings describe
 * this workload, with no speed threshold: submit CPU includes patch copying and
 * postMessage, while elapsed time includes worker scheduling and bitmap delivery.
 * Readback/hash CPU is excluded from both paths' timing counters. */
export async function compositionWorkerWorkload() {
  const width = 512, height = 384;
  const params = [0, 1, 2].map(() => ({ minVal: 0, maxVal: 255, brightness: 0, gain: 1, contrast: 1 }));
  const rasters = [0, 1, 2].map((band) => ({ compositionId: band + 700, revision: 1, previousRevision: 0,
    w: width, h: height, dataF32: Float32Array.from({ length: width * height }, (_, i) => (i * 17 + band * 61) & 255),
    dirtyRects: [{ x: 0, y: 0, w: width, h: height }] }));
  const reference = compositor(), fallback = compositor();
  const client = createCompositionWorkerClient({ fallback: (...args) => fallback.compose(...args) });
  const readback = document.createElement("canvas"); readback.width = width; readback.height = height;
  const context = readback.getContext("2d", { willReadFrequently: true });
  const workerHashes = [], referenceHashes = [];
  let referenceCpuMs = 0, submitCpuMs = 0, workerElapsedMs = 0, heartbeatCount = 0, maxHeartbeatGapMs = 0;
  let previousBeat = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - previousBeat);
    previousBeat = now; heartbeatCount += 1;
  }, 5);
  try {
    for (let frame = 0; frame < 12; frame += 1) {
      if (frame > 0 && frame < 8) {
        const rect = { x: (frame % 4) * 128, y: Math.floor(frame / 4) * 96, w: 128, h: 96 };
        for (const raster of rasters) {
          raster.previousRevision = raster.revision; raster.revision += 1; raster.dirtyRects = [rect];
          for (let y = rect.y; y < rect.y + rect.h; y += 1) for (let x = rect.x; x < rect.x + rect.w; x += 1) {
            raster.dataF32[y * width + x] = (frame * 29 + x * 11 + y * 3 + raster.compositionId) & 255;
          }
        }
      }
      if (frame === 8) params[1].brightness = 0.15;
      if (frame === 10) {
        rasters[0].previousRevision = rasters[0].revision + 1; rasters[0].revision += 2;
        rasters[0].dataF32[0] = NaN;
      }
      const channels = frame === 9 ? [rasters[2], rasters[1], rasters[0]] : rasters;
      const options = { transparentNoData: frame >= 10 };
      let start = performance.now();
      const expected = reference.compose(channels, params, options);
      referenceCpuMs += performance.now() - start;
      referenceHashes.push(hash(expected.getContext("2d").getImageData(0, 0, width, height).data));
      start = performance.now();
      const pending = client.compose(channels, params, options, { key: "parity" });
      submitCpuMs += performance.now() - start;
      const drawable = await pending;
      workerElapsedMs += performance.now() - start;
      try {
        context.clearRect(0, 0, width, height); context.drawImage(drawable, 0, 0);
        workerHashes.push(hash(context.getImageData(0, 0, width, height).data));
      } finally { drawable?.close?.(); }
      if (rasters.some((raster) => raster.dataF32.byteLength !== width * height * 4)) throw new Error("Worker detached renderer-owned data.");
    }
    if (JSON.stringify(referenceHashes) !== JSON.stringify(workerHashes)) throw new Error("Worker RGB pixel mismatch.");
    if (!client.usingWorker()) throw new Error("Composition workload did not use a worker.");
    // An independent timer probe excludes reference/readback/hash work, unlike
    // the parity-loop heartbeat above. It reports blocking, never a pass/fail
    // latency threshold. Fresh IDs force the same complete image in both paths.
    const fresh = rasters.map((raster) => ({ ...raster, compositionId: raster.compositionId + 1000 }));
    const probe = async (operation) => {
      const start = performance.now();
      const timerDelay = new Promise((resolve) => setTimeout(() => resolve(performance.now() - start), 0));
      const pending = operation();
      const mainThreadCpuMs = performance.now() - start;
      const [drawable, timerDelayMs] = await Promise.all([pending, timerDelay]);
      const elapsedMs = performance.now() - start;
      drawable?.close?.();
      return { mainThreadCpuMs, timerDelayMs, elapsedMs };
    };
    const responsivenessProbe = {
      synchronous: await probe(() => reference.compose(fresh, params, { transparentNoData: true })),
      worker: await probe(() => client.compose(fresh, params, { transparentNoData: true }, { key: "probe" }))
    };
    return { width, height, frames: workerHashes.length, referenceHashes, workerHashes,
      referenceCpuMs, submitCpuMs, workerElapsedMs, heartbeatCount, maxHeartbeatGapMs,
      responsivenessProbe,
      stats: { ...client.stats }, sourceBytes: rasters.reduce((sum, raster) => sum + raster.dataF32.byteLength, 0) };
  } finally {
    clearInterval(timer); client.dispose(); reference.clear(); fallback.clear();
  }
}
