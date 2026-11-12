import { createPyramidCompositionClient } from "../../src/render/pyramid-composition-client.js";
import { CompositionPlane } from "../../src/render/incremental-composition.js";
import { computeHistogram } from "../../src/render/display-math.js";

/** Real worker projection/statistics parity, including retained worker-plane
 * eviction. Timings are descriptive; assertions concern pixels and ownership. */
export async function pyramidWorkerWorkload() {
  const w = 16, h = 12, geometry = { w, h, idealLevel: 0 };
  const sourceArrays = [];
  const tile = (level, width, count, valueAt) => {
    const data = Float32Array.from({ length: count }, (_, i) => valueAt(i)); sourceArrays.push(data);
    return { level, w: width, data };
  };
  const op = (value, key, rect, factor = 1) => ({ tile: value, key, rect, factor,
    originX: 0, originY: 0, tileX: rect.x / factor, tileY: rect.y / factor });
  const fullRect = { x: 0, y: 0, w, h };
  const same = (actual, expected, name) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Pyramid worker ${name} mismatch.`);
  };
  const client = createPyramidCompositionClient(2048);
  let frames = 0;
  const results = [];
  try {
    for (const uint8 of [true, false]) {
      const coarse = tile(1, w / 2, w * h / 4, (i) => uint8 ? (i * 7) & 255 : i / 7);
      const lateCoarse = tile(1, w / 2, w * h / 4, () => uint8 ? 244 : -999);
      const fine = tile(0, 4, 16, (i) => uint8 ? i : i / 3);
      const final = tile(0, w, w * h, (i) => uint8 ? (i * 19) & 255 : i === 1 ? NaN : i / 11);
      const stages = [
        [op(coarse, "coarse", fullRect, 2)],
        [op(coarse, "coarse", fullRect, 2), op(fine, "fine", { x: 0, y: 0, w: 4, h: 4 })],
        [op(lateCoarse, "coarse", fullRect, 2), op(fine, "fine", { x: 0, y: 0, w: 4, h: 4 })],
        [op(lateCoarse, "coarse", fullRect, 2), op(fine, "fine", { x: 0, y: 0, w: 4, h: 4 }), op(final, "final", fullRect)]
      ];
      const key = uint8 ? "panel:byte" : "panel:float", viewKey = "first-view";
      const reference = new CompositionPlane(viewKey, geometry, uint8);
      let last;
      for (const operations of stages) {
        reference.begin();
        for (const operation of operations) reference.apply(operation.tile, operation.key, operation.rect,
          operation.factor, operation.originX, operation.originY, operation.tileX, operation.tileY);
        const metadata = reference.finish(w * h);
        const result = await client.compose({ key, viewKey, geometry, uint8, requiredPixels: w * h, operations });
        same([...result.data], [...reference.data], "pixels");
        same(result.histogramStats, metadata.histogramStats, "statistics");
        same(result.displayRangeStats, metadata.displayRangeStats, "display range");
        same(result.dirtyRects, metadata.dirtyRects, "damage");
        same([result.filledCount, result.fineCount], [reference.filledCount, reference.fineCount], "coverage");
        last = result; frames += 1;
      }
      same(last.histogramStats, computeHistogram(final.data), "exact final statistics");
      const snapshot = [...last.data], before = client.stats.inputBytes;
      const unchanged = await client.compose({ key, viewKey, geometry, uint8, requiredPixels: w * h, operations: stages.at(-1) });
      same(unchanged.changedPixels, 0, "unchanged writes");
      same(client.stats.inputBytes, before, "unchanged tile transport");

      // A small budget retains only one uint8 plane (including its counts), so
      // another view forces eviction on the worker and its client mirror.
      const otherKey = `${key}:other`;
      await client.compose({ key: otherKey, viewKey, geometry, uint8: true, requiredPixels: w * h,
        operations: [op(tile(0, w, w * h, () => 23), "other", fullRect)] });
      if (client.peek(key, viewKey)) throw new Error("Evicted worker plane kept a stale client mirror.");
      const restored = await client.compose({ key, viewKey, geometry, uint8, requiredPixels: w * h, operations: stages.at(-1) });
      same([...restored.data], snapshot, "evicted view restoration");
      const reset = await client.compose({ key, viewKey: "moved-view", geometry, uint8, requiredPixels: w * h,
        operations: [op(coarse, "coarse", fullRect, 2)] });
      if (reset.compositionId === restored.compositionId) throw new Error("View reset reused the old composition identity.");
      same([...last.data], snapshot, "immutable exported snapshot");
      if (client.bytes > client.limit || client.stats.workerBytes > client.limit) throw new Error("Pyramid display cache exceeded its budget.");
      results.push({ uint8, finalCount: last.histogramStats.count, changedPixels: last.changedPixels });
    }
    if (client.stats.mode !== "worker") throw new Error(`Pyramid workload fell back: ${client.stats.fallbackReason}`);
    const input = { key: "cancel", viewKey: "cancel-view", geometry, uint8: false, requiredPixels: w * h,
      operations: [op(tile(0, w, w * h, (i) => i / 2), "cancel", fullRect)] };
    const settle = (promise) => promise.then(() => "fulfilled", (error) => error.name);
    const obsolete = settle(client.compose(input));
    const latest = client.compose({ ...input, viewKey: "latest-view" });
    const outcome = await obsolete;
    const newest = await latest;
    same(outcome, "AbortError", "superseded request");
    same([...newest.data], [...input.operations[0].tile.data], "latest view");
    const clearing = settle(client.compose({ ...input, viewKey: "clear-view" }));
    client.clear();
    same(await clearing, "AbortError", "clear cancellation");
    const restarted = await client.compose(input);
    same([...restarted.data], [...input.operations[0].tile.data], "clear restart");
    if (sourceArrays.some((data) => !data.byteLength)) throw new Error("Pyramid worker detached source tiles.");
    return { frames, results, sourceArrays: sourceArrays.length, stats: { ...client.stats },
      mirrorBytes: client.bytes, mirrorLimit: client.limit, cancellation: outcome };
  } finally { client.dispose(); }
}
