import { describe, expect, test } from "vitest";
import {
  bandTileKey,
  buildBandProximityOrder,
  buildPyramidPrefetchPlan,
  computeMaxPyramidLevel,
  createPyramidController,
  pyramidLevelForEff,
  viewTileBounds
} from "../../src/render/pyramid-cache.js";

async function heldTileHarness(getVisibleViews) {
  const idle = [], reads = [];
  let hold = false;
  const controller = createPyramidController({
    now: () => performance.now(), requestIdle: (task) => { idle.push(task); return idle.length; }, cancelIdle: () => {},
    getActiveDatasetId: () => 1, getIOConcurrency: () => 1, getVisibleViews,
    readBandWindow: async (_meta, _source, band, x, y, w, h, step, _out, options) => {
      if (!hold) return new Float32Array(w * h).fill(1);
      // Deliberately ignore AbortSignal: stale results must still be rejected
      // when a backend cannot stop an already-started read.
      return new Promise((resolve) => reads.push({ band, x, y, step, options,
        key: bandTileKey(band, Math.log2(step), x / (128 * step), y / (128 * step)),
        resolve: (value = 1) => resolve(new Float32Array(w * h).fill(value)) }));
    }, readBandWindowBIP: async () => new Float32Array(0), onPerfUpdate: () => {}, onProgressiveRender: () => {}
  });
  const ds = { id: 1, meta: { samples: 8192, lines: 8192, bands: 1, interleave: "bsq" },
    ds: {}, view: { x: 1024, y: 1024, scale: 0.25 } };
  const view = () => controller.tryRasterFromPyramid(ds, 0, 0.25, 384, 384);
  await view();
  const pyr = ds.pyramid;
  pyr.readAdmission.setLimit(1);
  hold = true;
  const pumpUntil = async (condition) => {
    for (let turn = 0; turn < 100 && !condition(); turn += 1) {
      idle.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(condition()).toBe(true);
  };
  await pumpUntil(() => reads.length === 1 && pyr.readAdmission.waiting === 1);
  const cleanup = async () => {
    const pending = [...pyr.pending.values()];
    controller.disposePyramid(pyr);
    reads.forEach((read) => read.resolve());
    await Promise.allSettled(pending);
  };
  return { ds, pyr, reads, view, pumpUntil, cleanup };
}

describe("pyramid-cache", () => {
  test("unchanged views reuse composed planes and changed views discard their damage history", async () => {
    const controller = createPyramidController({ now: () => performance.now(), requestIdle: () => 1, cancelIdle: () => {},
      readBandWindow: async (_meta, _source, _band, _x, _y, w, h) => new Float32Array(w * h).fill(7),
      readBandWindowBIP: async () => new Float32Array(0), getActiveDatasetId: () => 1, getIOConcurrency: () => 2,
      onPerfUpdate: () => {}, onProgressiveRender: () => {} });
    const ds = { id: 1, meta: { samples: 1024, lines: 1024, bands: 1, interleave: "bsq", dataType: 1 },
      ds: {}, view: { x: 0, y: 0, scale: 0.25 } };
    const first = await controller.tryRasterFromPyramid(ds, 0, 0.25, 128, 128);
    const pixels = ds.pyramid.stats.composePixels;
    const second = await controller.tryRasterFromPyramid(ds, 0, 0.25, 128, 128);
    expect(second.dataF32).toBe(first.dataF32);
    expect(second.revision).toBe(first.revision);
    expect(second.dirtyRects).toEqual([]);
    expect(ds.pyramid.stats.composePixels).toBe(pixels);
    ds.view.x = 128;
    const moved = await controller.tryRasterFromPyramid(ds, 0, 0.25, 128, 128);
    expect(moved.compositionId).not.toBe(first.compositionId);
    expect(moved.dataF32.every((value) => value === 7)).toBe(true);
    controller.disposePyramid(ds.pyramid);
    expect(ds.pyramid.compositionCache.bytes).toBe(0);
  });

  test("a second visible panel retains useful work until that panel is removed", async () => {
    let visible = [{ view: { x: 1024, y: 1024 }, bands: [0], eff: 0.25, width: 384, height: 384 }];
    const h = await heldTileHarness(() => visible);
    const oldPending = [...h.pyr.pending.values()];
    try {
      h.ds.view.x = 6144; h.ds.view.y = 6144;
      await h.view();
      expect(h.reads[0].options.signal.aborted).toBe(false);
      expect(h.pyr.readAdmission.waiting).toBe(1);
      visible = [];
      h.ds.view.x += 512;
      await h.view();
      expect(h.reads[0].options.signal.aborted).toBe(true);
      expect(h.pyr.readAdmission.waiting).toBe(0);
      h.reads[0].resolve();
      const outcomes = await Promise.allSettled(oldPending);
      expect(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason.name === "AbortError")).toBe(true);
      expect(h.reads).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  test("an obsolete overview await cannot start more tile reads after switching bands", async () => {
    const held = [], bandsRead = [];
    const controller = createPyramidController({
      now: () => performance.now(), requestIdle: () => 1, cancelIdle: () => {},
      getActiveDatasetId: () => 1, getIOConcurrency: () => 1,
      readBandWindow: async (_meta, _source, band, _x, _y, w, h, _step, _out, options) => {
        bandsRead.push(band);
        if (band === 1 || held.length >= 2) return new Float32Array(w * h).fill(5);
        return new Promise((resolve) => held.push({ options, resolve: () => resolve(new Float32Array(w * h)) }));
      }, readBandWindowBIP: async () => new Float32Array(0), onPerfUpdate: () => {}, onProgressiveRender: () => {}
    });
    const ds = { id: 1, meta: { samples: 8192, lines: 8192, bands: 2, interleave: "bsq" },
      ds: {}, view: { x: 0, y: 0, scale: 0.25 } };
    const oldView = controller.tryRasterFromPyramid(ds, 0, 0.25, 384, 384);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(held).toHaveLength(2);
    const newView = controller.tryRasterFromPyramid(ds, 1, 0.25, 384, 384);
    expect(held.every(({ options }) => options.signal.aborted)).toBe(true);
    held.forEach((read) => read.resolve());
    await expect(oldView).resolves.toBeNull();
    await expect(newView).resolves.toBeTruthy();
    expect(bandsRead.filter((band) => band === 0)).toHaveLength(2);
    controller.disposePyramid(ds.pyramid);
  });

  test("a disjoint pan cancels admitted and admission-waiting tiles without accepting late data", async () => {
    const h = await heldTileHarness();
    const oldPending = [...h.pyr.pending.values()];
    try {
      h.ds.view.x = 6144; h.ds.view.y = 6144;
      await h.view();
      expect(h.pyr.readAdmission.waiting).toBe(0);
      expect(h.reads[0].options.signal.aborted).toBe(true);
      expect(h.reads[0].options.cancelled()).toBe(true);
      h.reads[0].resolve(9);
      const outcomes = await Promise.allSettled(oldPending);
      expect(outcomes.every((outcome) => outcome.status === "rejected" && outcome.reason.name === "AbortError")).toBe(true);
      expect(h.reads).toHaveLength(1);
      expect(h.pyr.tiles.has(h.reads[0].key)).toBe(false);
      expect(h.pyr.readAdmission.active).toBe(0);
    } finally { await h.cleanup(); }
  });

  test("an overlapping pan keeps useful admitted tiles and their admission waiters", async () => {
    const h = await heldTileHarness();
    const oldPending = [...h.pyr.pending.values()];
    try {
      h.ds.view.x += 512;
      await h.view();
      expect(h.reads[0].options.signal.aborted).toBe(false);
      expect(h.pyr.readAdmission.waiting).toBe(1);
      h.reads[0].resolve(3);
      await h.pumpUntil(() => h.reads.length === 2);
      expect(h.reads[1].options.signal.aborted).toBe(false);
      h.reads[1].resolve(4);
      const outcomes = await Promise.allSettled(oldPending);
      expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
      expect(h.pyr.tiles.get(h.reads[0].key).data[0]).toBe(3);
      expect(h.pyr.tiles.get(h.reads[1].key).data[0]).toBe(4);
    } finally { await h.cleanup(); }
  });

  test("returning to a cancelled tile keeps its replacement safe from old finalizers", async () => {
    const h = await heldTileHarness();
    const oldKey = h.reads[0].key;
    const oldPromise = h.pyr.pending.get(oldKey);
    try {
      h.ds.view.x = 6144; h.ds.view.y = 6144;
      await h.view();
      h.ds.view.x = 1024; h.ds.view.y = 1024;
      await h.view();
      await h.pumpUntil(() => h.pyr.pending.has(oldKey));
      const replacement = h.pyr.pending.get(oldKey);
      expect(replacement).not.toBe(oldPromise);
      h.reads[0].resolve(9);
      await expect(oldPromise).rejects.toMatchObject({ name: "AbortError" });
      await h.pumpUntil(() => h.reads.length === 2);
      expect(h.reads[1].key).toBe(oldKey);
      expect(h.pyr.pending.get(oldKey)).toBe(replacement);
      expect(h.pyr.queued.has(oldKey)).toBe(true);
      expect(h.pyr.tiles.has(oldKey)).toBe(false);
      h.reads[1].resolve(7);
      await replacement;
      expect(h.pyr.tiles.get(oldKey).data[0]).toBe(7);
    } finally { await h.cleanup(); }
  });

  test("per-request admission cancellation removes waiters without consuming a slot", async () => {
    const controller = createPyramidController({ getIOConcurrency: () => 1 });
    const ds = { meta: { samples: 128, lines: 128 } };
    controller.ensurePyramid(ds);
    const gate = ds.pyramid.readAdmission;
    gate.setLimit(1);
    const release = await gate.acquire();
    const abort = new AbortController();
    const obsolete = gate.acquire("foreground", { signal: abort.signal });
    const next = gate.acquire("foreground");
    abort.abort();
    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.active).toBe(1);
    expect(gate.waiting).toBe(1);
    release();
    const releaseNext = await next;
    releaseNext(); releaseNext();
    expect(gate.active).toBe(0);
    await expect(gate.acquire("foreground", { signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    controller.disposePyramid(ds.pyramid);
  });

  test.each([
    { eff: 0.25, pixels: 251 * 125, approximate: false },
    { eff: 2, pixels: 156 * 156, approximate: true }
  ])("clips coarse tiles to the image inside padded views at scale $eff", async ({ eff, pixels, approximate }) => {
    const controller = createPyramidController({
      now: () => 0, requestIdle: () => 1, cancelIdle: () => {},
      readBandWindow: async (_meta, _source, _band, _x, _y, w, h) => new Float32Array(w * h).fill(4),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {}, onProgressiveRender: () => {},
      getActiveDatasetId: () => 1, getIOConcurrency: () => 2
    });
    const ds = { id: 1, meta: { samples: 1001, lines: 499, bands: 1, interleave: "bsq" },
      ds: {}, view: { x: -100, y: -100, scale: eff } };
    const raster = await controller.tryRasterFromPyramid(ds, 0, eff, 512, 512);
    expect(raster.dataF32.reduce((count, value) => count + Number(Number.isFinite(value)), 0)).toBe(pixels);
    expect(raster.partial).toBe(false);
    expect(raster.approximate).toBe(approximate);
    expect(raster.coverage).toBe(1);
    controller.disposePyramid(ds.pyramid);
  });

  test("completed pyramid work does not poll idle callbacks or wake unchanged renders", async () => {
    const idle = [];
    let renders = 0;
    const controller = createPyramidController({
      now: () => 1000, requestIdle: (callback) => { idle.push(callback); return idle.length; },
      cancelIdle: () => {},
      readBandWindow: async (_meta, _source, _band, _x, _y, w, h) => new Float32Array(w * h),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {}, onProgressiveRender: () => { renders += 1; },
      getActiveDatasetId: () => 1, getIOConcurrency: () => 2
    });
    const ds = { id: 1, meta: { samples: 128, lines: 128, bands: 1, interleave: "bsq" },
      ds: {}, view: { x: 0, y: 0, scale: 1 } };
    await controller.tryRasterFromPyramid(ds, 0, 1, 128, 128);
    let processed = 0;
    while (processed < idle.length && processed < 10) {
      idle[processed++]();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(processed).toBeLessThan(10);
    expect(ds.pyramid.inflight.size).toBe(0);
    expect(renders).toBeGreaterThan(0); // The last tile must still wake rendering.
    const callbacks = idle.length;
    const renderCount = renders;
    const raster = await controller.tryRasterFromPyramid(ds, 0, 1, 128, 128);
    expect(raster.approximate).toBe(false);
    expect(idle.length).toBe(callbacks);
    expect(renders).toBe(renderCount);
    controller.disposePyramid(ds.pyramid);
  });

  test("visible RGB bands retain independent work and sharpen nearby tiles together", async () => {
    const controller = createPyramidController({
      now: () => 0, requestIdle: () => 1, cancelIdle: () => {},
      readBandWindow: async (_meta, _source, _band, _x, _y, w, h) => new Float32Array(w * h),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {}, onProgressiveRender: () => {},
      getActiveDatasetId: () => 1, getIOConcurrency: () => 2
    });
    const ds = { id: 1, meta: { samples: 8192, lines: 8192, bands: 4, interleave: "bsq" },
      ds: {}, view: { x: 1024, y: 1024, scale: 0.25 } };
    const options = { bands: [0, 1, 2] };
    await controller.tryRasterFromPyramid(ds, 0, 0.25, 384, 384, options);
    const firstKeys = ds.pyramid.qHi.filter((task) => task.level === 2).map((task) => task.key);
    expect(firstKeys).toHaveLength(27);
    for (const band of [1, 2]) {
      await controller.tryRasterFromPyramid(ds, band, 0.25, 384, 384, options);
      expect(ds.pyramid.qHi.filter((task) => task.level === 2).map((task) => task.key)).toEqual(firstKeys);
    }
    const targetTasks = ds.pyramid.qHi.filter((task) => task.level === 2);
    expect(targetTasks.slice(0, 3).map(({ band, tx, ty }) => [band, tx, ty]))
      .toEqual([[0, 3, 3], [1, 3, 3], [2, 3, 3]]);
    expect(new Set(targetTasks.map((task) => task.key)).size).toBe(27);
    const detailTasks = ds.pyramid.qHi.filter((task) => task.level < 4);
    expect(detailTasks.slice(0, 27).every((task) => task.level === 2)).toBe(true);
    expect(detailTasks.slice(27).every((task) => task.level === 3)).toBe(true);

    // A real display-band switch still discards queued work for hidden bands.
    await controller.tryRasterFromPyramid(ds, 3, 0.25, 384, 384);
    expect(ds.pyramid.qHi.every((task) => task.band === 3)).toBe(true);
    controller.disposePyramid(ds.pyramid);
  });

  test("pure helpers compute keys and levels", () => {
    expect(bandTileKey(3, 2, 10, 11)).toBe("3|2:10:11");
    expect(buildBandProximityOrder(5, 10, 3)).toEqual([5, 4, 6, 3, 7, 2, 8]);
    expect(computeMaxPyramidLevel({ samples: 256, lines: 128 }, 256)).toBe(1);
    expect(computeMaxPyramidLevel({ samples: 2048, lines: 2048 }, 256)).toBe(3);

    const ds = { pyramid: { maxLevel: 5 } };
    expect(pyramidLevelForEff(ds, 1.2)).toBe(0);
    expect(pyramidLevelForEff(ds, 0.5)).toBe(1);
    expect(pyramidLevelForEff(ds, 0.1)).toBe(3);
  });

  test("viewTileBounds computes tile coverage for viewport", () => {
    const ds = {
      meta: { samples: 2048, lines: 1024 },
      view: { x: 256, y: 128 }
    };
    const pyr = { tileSize: 256 };
    const b = viewTileBounds(ds, pyr, 1, 1, 512, 256);
    expect(b.tx0).toBeGreaterThanOrEqual(0);
    expect(b.ty0).toBeGreaterThanOrEqual(0);
    expect(b.tx1).toBeGreaterThanOrEqual(b.tx0);
    expect(b.ty1).toBeGreaterThanOrEqual(b.ty0);
  });

  test("buildPyramidPrefetchPlan favors nearby same-band tiles before adjacent bands", () => {
    const ds = {
      meta: { samples: 1024, lines: 1024, bands: 10 },
      view: { x: 0, y: 0, scale: 1 },
      pyramid: {
        tileSize: 128,
        maxLevel: 3,
        tiles: new Map(),
        pending: new Map(),
        queued: new Set([
          bandTileKey(5, 0, 0, 0),
          bandTileKey(5, 1, 0, 0),
          bandTileKey(5, 2, 0, 0),
          bandTileKey(5, 3, 0, 0)
        ])
      }
    };

    const plan = buildPyramidPrefetchPlan(ds, 5, 0, 1, 128, 128, 8, 2);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan[0].band).toBe(5);
    expect(plan[0].radius).toBe(1);
    expect(plan[0].tx).toBeLessThanOrEqual(1);
    expect(plan[0].ty).toBeLessThanOrEqual(1);
    expect(plan.some((task) => task.band === 4 || task.band === 6)).toBe(true);
  });

  test("controller manages inflight and dispose lifecycle", () => {
    let io = 4;
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getDevicePixelRatio: () => 1,
      getViewportSize: () => ({ width: 1, height: 1 }),
      getIOConcurrency: () => io
    });

    const ds = { meta: { samples: 1024, lines: 1024 }, pyramidBudgetBytes: 1024 };
    controller.ensurePyramid(ds);
    expect(ds.pyramid.maxInflight).toBe(4);

    io = 1;
    controller.updateInflightForIO(ds);
    expect(ds.pyramid.maxInflight).toBe(2);

    ds.pyramid.tiles.set("x", { bytes: 8 });
    ds.pyramid.pending.set("y", Promise.resolve(null));
    ds.pyramid.totalBytes = 8;
    controller.disposePyramid(ds.pyramid);
    expect(ds.pyramid.cancelled).toBe(true);
    expect(ds.pyramid.tiles.size).toBe(0);
    expect(ds.pyramid.pending.size).toBe(0);
    expect(ds.pyramid.totalBytes).toBe(0);
  });

  test("tile admission prefers queued foreground reads", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 1, height: 1 }),
      getIOConcurrency: () => 1
    });
    const ds = { meta: { samples: 256, lines: 256 } };
    controller.ensurePyramid(ds);
    const gate = ds.pyramid.readAdmission;
    gate.setLimit(1);
    const releaseActive = await gate.acquire("background");
    const order = [];
    const background = gate.acquire("background").then((release) => {
      order.push("background");
      return release;
    });
    const foreground = gate.acquire("foreground").then((release) => {
      order.push("foreground");
      return release;
    });

    expect(gate.waiting).toBe(2);
    releaseActive();
    const releaseForeground = await foreground;
    expect(order).toEqual(["foreground"]);
    releaseForeground();
    const releaseBackground = await background;
    expect(order).toEqual(["foreground", "background"]);
    releaseBackground();
    expect(gate.active).toBe(0);
  });

  test("disposing a pyramid rejects tile reads waiting for admission", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 1, height: 1 }),
      getIOConcurrency: () => 1
    });
    const ds = { meta: { samples: 256, lines: 256 } };
    controller.ensurePyramid(ds);
    const gate = ds.pyramid.readAdmission;
    gate.setLimit(1);
    const releaseActive = await gate.acquire("foreground");
    const waiting = gate.acquire("foreground").then(
      () => null,
      (error) => error
    );

    controller.disposePyramid(ds.pyramid);
    await expect(waiting).resolves.toMatchObject({ name: "AbortError" });
    expect(gate.waiting).toBe(0);
    releaseActive();
    expect(gate.active).toBe(0);
  });

  test("raising dynamic I/O concurrency wakes admitted tile reads", async () => {
    let io = 1;
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 1, height: 1 }),
      getIOConcurrency: () => io
    });
    const ds = { meta: { samples: 256, lines: 256 } };
    controller.ensurePyramid(ds);
    const gate = ds.pyramid.readAdmission;
    const first = await gate.acquire("foreground");
    const second = await gate.acquire("foreground");
    let thirdStarted = false;
    const third = gate.acquire("foreground").then((release) => {
      thirdStarted = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdStarted).toBe(false);

    io = 4;
    controller.updateInflightForIO(ds);
    const releaseThird = await third;
    expect(ds.pyramid.maxInflight).toBe(4);
    expect(thirdStarted).toBe(true);
    first();
    second();
    releaseThird();
  });

  test("immediate overview Promise.all reads share the tile admission limit", async () => {
    let active = 0;
    let peak = 0;
    const releases = [];
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => new Promise((resolve) => {
        active += 1;
        peak = Math.max(peak, active);
        releases.push(() => {
          active -= 1;
          resolve(new Float32Array(outW * outH));
        });
      }),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 128, height: 128 }),
      getIOConcurrency: () => 1
    });
    const ds = {
      id: 1,
      meta: { samples: 1024, lines: 1024, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 0.25 },
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);
    let settled = false;
    const raster = controller.tryRasterFromPyramid(ds, 0, 0.25, 128, 128)
      .finally(() => { settled = true; });

    for (let turn = 0; turn < 256 && !settled; turn += 1) {
      await Promise.resolve();
      while (releases.length) releases.shift()();
    }
    await raster;
    expect(peak).toBe(2);
    expect(ds.pyramid.readAdmission.active).toBe(0);
    expect(ds.pyramid.readAdmission.waiting).toBe(0);
  });

  test("tryRasterFromPyramid returns cached tile data", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getDevicePixelRatio: () => 1,
      getViewportSize: () => ({ width: 128, height: 128 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 256, lines: 256, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 0.5 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);
    const level = 1;
    const w = 128;
    const h = 128;
    const data = new Float32Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = i;
    ds.pyramid.tiles.set(bandTileKey(0, level, 0, 0), { band: 0, level, tx: 0, ty: 0, data, w, h, bytes: data.byteLength, t: 0 });

    const out = await controller.tryRasterFromPyramid(ds, 0, 0.5);
    expect(out).toBeTruthy();
    expect(out.w).toBe(128);
    expect(out.h).toBe(128);
    expect(out.dataF32[0]).toBe(0);
    expect(out.dataF32[100]).toBe(100);
  });

  test("tryRasterFromPyramid loads a coarse viewport level before returning gaps", async () => {
    let readOptions = null;
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH, _step, _out, options) => {
        readOptions = options;
        const data = new Float32Array(outW * outH);
        data.fill(7);
        return data;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getDevicePixelRatio: () => 1,
      getViewportSize: () => ({ width: 512, height: 128 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 1024, lines: 256, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 0.5 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);
    const level = 1;
    const tileData = new Float32Array(256 * 128);
    tileData.fill(1);
    ds.pyramid.tiles.set(bandTileKey(0, level, 0, 0), {
      band: 0,
      level,
      tx: 0,
      ty: 0,
      data: tileData,
      w: 256,
      h: 128,
      bytes: tileData.byteLength,
      t: 0
    });

    const out = await controller.tryRasterFromPyramid(ds, 0, 0.5);
    expect(out).toBeTruthy();
    expect(out.partial).toBe(false);
    expect(out.coverage).toBe(1);
    expect(typeof out.approximate).toBe("boolean");
    expect(Number.isNaN(out.dataF32[out.dataF32.length - 1])).toBe(false);
    expect(readOptions?.priority).toBe("foreground");
    expect(readOptions?.cancelled()).toBe(false);
    controller.disposePyramid(ds.pyramid);
    expect(readOptions?.cancelled()).toBe(true);
  });

  test("tryRasterFromPyramid pins coarse overview levels for reuse", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => {
        const data = new Float32Array(outW * outH);
        data.fill(4);
        return data;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 128, height: 128 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 1024, lines: 1024, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 0.25 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);

    const out = await controller.tryRasterFromPyramid(ds, 0, 0.25, 128, 128);
    expect(out).toBeTruthy();
    expect(ds.pyramid.pinnedKeys.size).toBeGreaterThan(0);
    const pinnedLevels = new Set(
      Array.from(ds.pyramid.pinnedKeys)
        .map((key) => ds.pyramid.tiles.get(key)?.level)
        .filter((level) => Number.isFinite(level))
    );
    expect(pinnedLevels.has(ds.pyramid.maxLevel)).toBe(true);

    // A fitted image can have blank margins. Those pixels remain NaN for
    // drawing, but must not count as missing source tiles after refinement.
    ds.view.x = -512;
    ds.view.y = -256;
    const fitted = await controller.tryRasterFromPyramid(ds, 0, 0.25, 512, 512);
    expect(Number.isNaN(fitted.dataF32[0])).toBe(true);
    expect(fitted.partial).toBe(false);
    expect(fitted.approximate).toBe(false);
    expect(fitted.coverage).toBe(1);
  });

  test("tryRasterFromPyramid returns zoomed-in preview data before full-resolution tiles land", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => {
        const data = new Float32Array(outW * outH);
        data.fill(9);
        return data;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getDevicePixelRatio: () => 1,
      getViewportSize: () => ({ width: 256, height: 128 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 1024, lines: 256, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 2 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);

    const out = await controller.tryRasterFromPyramid(ds, 0, 2);
    expect(out).toBeTruthy();
    expect(out.w).toBe(128);
    expect(out.h).toBe(64);
    expect(out.partial).toBe(false);
    expect(out.approximate).toBe(true);
    expect(out.dataF32[0]).toBe(9);
  });

  test("tryRasterFromPyramid keeps zoomed-in preview geometry aligned with direct sampling", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => {
        const data = new Float32Array(outW * outH);
        data.fill(5);
        return data;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getDevicePixelRatio: () => 1,
      getViewportSize: () => ({ width: 256, height: 128 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 1024, lines: 256, interleave: "bsq" },
      ds: {},
      view: { x: 0.9, y: 0.1, scale: 2 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);

    const out = await controller.tryRasterFromPyramid(ds, 0, 2);
    expect(out).toBeTruthy();
    expect(out.w).toBe(128);
    expect(out.h).toBe(64);
  });

  test("tryRasterFromPyramid aligns level-0 cached tiles for edge views outside bounds", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async () => new Float32Array(0),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 4, height: 2 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 4, lines: 2, interleave: "bsq" },
      ds: {},
      view: { x: -1, y: 0, scale: 1 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);
    ds.pyramid.tiles.set(bandTileKey(0, 0, 0, 0), {
      band: 0,
      level: 0,
      tx: 0,
      ty: 0,
      data: new Float32Array([
        10, 11, 12, 13,
        20, 21, 22, 23
      ]),
      w: 4,
      h: 2,
      bytes: 8 * Float32Array.BYTES_PER_ELEMENT,
      t: 0
    });

    const out = await controller.tryRasterFromPyramid(ds, 0, 1, 4, 2);
    expect(out).toBeTruthy();
    expect(out.w).toBe(4);
    expect(out.h).toBe(2);
    expect(Number.isNaN(out.dataF32[0])).toBe(true);
    expect(Array.from(out.dataF32.slice(1, 4))).toEqual([10, 11, 12]);
    expect(Number.isNaN(out.dataF32[4])).toBe(true);
    expect(Array.from(out.dataF32.slice(5, 8))).toEqual([20, 21, 22]);
  });

  test("background pyramid work runs for visible non-active datasets", async () => {
    let readCalls = 0;
    let idleUsed = false;
    const readPriorities = [];
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: (cb) => {
        if (!idleUsed) {
          idleUsed = true;
          cb();
        }
        return 1;
      },
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH, _step, _out, options) => {
        readCalls += 1;
        readPriorities.push(options?.priority);
        const data = new Float32Array(outW * outH);
        data.fill(3);
        return data;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => "other",
      getVisibleDatasetIds: () => ["visible-ds"],
      getViewportSize: () => ({ width: 1024, height: 1024 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: "visible-ds",
      meta: { samples: 2048, lines: 2048, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 1 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);
    ds.pyramid.maxLevel = 0;
    const tileData = new Float32Array(128 * 128);
    tileData.fill(1);
    ds.pyramid.tiles.set(bandTileKey(0, 0, 0, 0), {
      band: 0,
      level: 0,
      tx: 0,
      ty: 0,
      data: tileData,
      w: 128,
      h: 128,
      bytes: tileData.byteLength,
      t: 0
    });
    ds.pyramid.totalBytes = tileData.byteLength;

    const out = await controller.tryRasterFromPyramid(ds, 0, 1, 1024, 1024);
    await Promise.resolve();
    expect(out).toBeTruthy();
    expect(out.partial).toBe(true);
    expect(readCalls).toBeGreaterThan(0);
    expect(readPriorities).toContain("foreground");
  });

  test("speculative qLo prefetch uses background reader priority", async () => {
    let idleUsed = false;
    const readPriorities = [];
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: (cb) => {
        if (!idleUsed) {
          idleUsed = true;
          cb();
        }
        return 1;
      },
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH, _step, _out, options) => {
        readPriorities.push(options?.priority);
        return new Float32Array(outW * outH);
      },
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => "ds",
      getVisibleDatasetIds: () => ["ds"],
      getViewportSize: () => ({ width: 128, height: 128 }),
      getIOConcurrency: () => 2
    });
    const ds = {
      id: "ds",
      meta: { samples: 128, lines: 128, bands: 2, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 1 },
      activeBand: 0,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);
    ds.pyramid.maxLevel = 0;
    const data = new Float32Array(128 * 128);
    ds.pyramid.tiles.set(bandTileKey(0, 0, 0, 0), {
      band: 0, level: 0, tx: 0, ty: 0, data, w: 128, h: 128, bytes: data.byteLength, t: 0
    });
    ds.pyramid.totalBytes = data.byteLength;

    await controller.tryRasterFromPyramid(ds, 0, 1, 128, 128);
    await Promise.resolve();

    expect(readPriorities).toContain("background");
    expect(readPriorities).not.toContain("foreground");
  });

  test("tryRasterFromPyramid tolerates pyramid disposal during async overview fills", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => {
        const data = new Float32Array(outW * outH);
        data.fill(2);
        controller.disposePyramid(ds.pyramid);
        ds.pyramid = null;
        return data;
      },
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 128, height: 128 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 1024, lines: 1024, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 0.25 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);

    const out = await controller.tryRasterFromPyramid(ds, 0, 0.25, 128, 128);
    expect(out).toBeNull();
  });

  test("tryRasterFromPyramid drops stale queued focus tiles when the zoom target changes", async () => {
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => new Float32Array(outW * outH),
      readBandWindowBIP: async () => new Float32Array(0),
      onPerfUpdate: () => {},
      onProgressiveRender: () => {},
      getActiveDatasetId: () => 1,
      getViewportSize: () => ({ width: 128, height: 128 }),
      getIOConcurrency: () => 2
    });

    const ds = {
      id: 1,
      meta: { samples: 2048, lines: 2048, interleave: "bsq" },
      ds: {},
      view: { x: 0, y: 0, scale: 0.25 },
      activeBand: null,
      __pyrPreferImmediate: true
    };
    controller.ensurePyramid(ds);
    ds.pyramid.focus = { key: "stale-focus" };
    ds.pyramid.qHi.push({ key: "stale-hi", band: 0, level: 1, tx: 0, ty: 0 });
    ds.pyramid.qLo.push({ key: "stale-lo", band: 0, level: 1, tx: 1, ty: 0 });
    ds.pyramid.queued.add("stale-hi");
    ds.pyramid.queued.add("stale-lo");

    ds.view = { x: 1024, y: 1024, scale: 0.25 };
    await controller.tryRasterFromPyramid(ds, 0, 0.25, 128, 128);

    expect(ds.pyramid.focus?.key).not.toBe("stale-focus");
    expect(ds.pyramid.qHi.some((task) => task.key === "stale-hi")).toBe(false);
    expect(ds.pyramid.qLo.some((task) => task.key === "stale-lo")).toBe(false);
    expect(ds.pyramid.queued.has("stale-hi")).toBe(false);
    expect(ds.pyramid.queued.has("stale-lo")).toBe(false);
  });
});
