import { APP_CONFIG } from "../../src/app/config.js";
import { readBandWindow, readBandWindowBIP } from "../../src/core/raster-io.js";
import { createFmapDataSource } from "../../src/io/fmap/index.js";
import { bandTileKey, createPyramidController, levelInfo } from "../../src/render/pyramid-cache.js";
import { FMAP_PROVIDER_RELEASE } from "./fmap-provider-control.js";

/** Browser integration workload. Caller gates the worker provider so cancellation
 * occurs during an actual fill. Only coarse display tiles are seeded; fine reads
 * use the production raster adapter, fmap client, worker, queue and C/WASM pool. */
export async function exercisePyramidFmapCancellation() {
  const wasmBytes = await (await fetch("/wasm/fmap/pkg/fmap_core.wasm")).arrayBuffer();
  const meta = { samples: 2048, lines: 2048, bands: 1, headerOffset: 0, interleave: "bsq",
    dataType: 1, littleEndian: true, dataTypeInfo: { bytes: 1, ctor: Uint8Array } };
  const source = createFmapDataSource(new File([new Uint8Array(2048 * 2048).fill(7)], "pan-cancel.dat"), meta, {
    wasmBytes, pageSize: 4096, poolBytes: 65536, concurrency: 1,
    maxResultBytes: 262144, maxInflightBytes: 524288, maxLogicalBytes: 524288
  });
  const idle = [];
  // Match the app's adapter signature; core raster I/O has an additional
  // concurrency argument before out/options.
  const adapt = (reader) => (meta, source, band, x, y, w, h, step, out, options) =>
    reader(meta, source, band, x, y, w, h, step, 1, out, options);
  const controller = createPyramidController({ now: () => performance.now(),
    requestIdle: (task) => { idle.push(task); return idle.length; }, cancelIdle: () => {},
    getActiveDatasetId: () => 1, getIOConcurrency: () => 1,
    readBandWindow: adapt(readBandWindow), readBandWindowBIP: adapt(readBandWindowBIP),
    onPerfUpdate: () => {}, onProgressiveRender: () => {} });
  const ds = { id: 1, meta, ds: source, view: { x: 0, y: 0, scale: 1 } };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const until = async (condition) => {
    const deadline = performance.now() + 5000;
    while (!await condition()) {
      if (performance.now() > deadline) throw new Error("Pyramid/fmap cancellation did not settle.");
      await tick();
    }
  };
  const drained = (s) => s.activeRequests === 0 && s.queuedRequests === 0 && s.waitingRequests === 0
    && s.waitingLogicalRequests === 0 && s.logicalBytesReserved === 0 && s.fillActiveReads === 0
    && s.fillQueueRequests === 0 && s.fillParkedRequests === 0 && s.pinnedBytes === 0;
  try {
    await source.ready;
    controller.ensurePyramid(ds);
    const pyr = ds.pyramid;
    for (let level = pyr.maxLevel; level > pyr.maxLevel - APP_CONFIG.pyramid.pinnedOverviewLevels; level -= 1) {
      const info = levelInfo(ds, pyr, level);
      for (let ty = 0; ty < info.tilesY; ty += 1) for (let tx = 0; tx < info.tilesX; tx += 1) {
        const w = Math.min(pyr.tileSize, info.downW - tx * pyr.tileSize);
        const h = Math.min(pyr.tileSize, info.downH - ty * pyr.tileSize);
        const data = new Float32Array(w * h).fill(7);
        const key = bandTileKey(0, level, tx, ty);
        pyr.tiles.set(key, { band: 0, level, tx, ty, w, h, data, bytes: data.byteLength, t: ++pyr.tick });
        pyr.pinnedKeys.add(key);
        pyr.totalBytes += data.byteLength;
      }
    }
    await controller.tryRasterFromPyramid(ds, 0, 1, 128, 128);
    let before;
    await until(async () => {
      idle.shift()?.();
      before = await source.getStats();
      return before.fillActiveReads === 1 && before.queuedRequests > 0;
    });
    const oldKeys = [...pyr.pending.keys()];
    const oldPromises = [...pyr.pending.values()].map((promise) => promise.then(() => "fulfilled", (error) => error.name));
    const start = performance.now();
    ds.view.x = 1024; ds.view.y = 1024;
    await controller.tryRasterFromPyramid(ds, 0, 1, 128, 128);
    const outcomes = await Promise.all(oldPromises);
    const cancellationMs = performance.now() - start;
    const acknowledged = await source.getStats();
    source.worker.postMessage({ type: FMAP_PROVIDER_RELEASE });
    let final;
    await until(async () => { final = await source.getStats(); return drained(final); });
    return { cancellationMs, outcomes, oldTileCached: oldKeys.some((key) => pyr.tiles.has(key)),
      cancelledTiles: pyr.stats.cancelledTileReads, workerCancelledRequests: final.workerCancelledRequests,
      providerReads: final.readCalls, providerBytes: final.browserBytes, drained: drained(final),
      before: { active: before.activeRequests, queued: before.queuedRequests, providerReads: before.fillActiveReads },
      afterAcknowledgement: { active: acknowledged.activeRequests, providerReads: acknowledged.fillActiveReads,
        pinnedBytes: acknowledged.pinnedBytes } };
  } finally {
    controller.disposePyramid(ds.pyramid);
    source.close();
  }
}
