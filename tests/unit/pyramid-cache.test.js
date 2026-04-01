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

describe("pyramid-cache", () => {
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
    const controller = createPyramidController({
      now: () => 0,
      requestIdle: () => 1,
      cancelIdle: () => {},
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => {
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
      readBandWindow: async (_meta, _ds, _band, _x0, _y0, outW, outH) => {
        readCalls += 1;
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
  });
});
