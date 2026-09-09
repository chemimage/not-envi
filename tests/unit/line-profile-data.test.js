import { expect, test, vi } from "vitest";
import { readLineProfile } from "../../src/render/line-profile-data.js";

test("samples both endpoints in source coordinates and bounds long profiles", async () => {
  const ds = { meta: { samples: 100, lines: 100 }, ds: {
    probeValueAtBand: async (_meta, x, y, band) => band * 100 + y * 10 + x
  } };
  const line = { points: [{ x: 0, y: 0 }, { x: 3, y: 4 }] };
  const result = await readLineProfile(ds, line, 2, { maxSamples: 3 });
  expect(result.lengthPx).toBe(5);
  expect(result.sampled).toBe(true);
  expect(Array.from(result.values)).toEqual([200, 222, 243]);
  line.points.reverse();
  expect(Array.from((await readLineProfile(ds, line, 2, { maxSamples: 3 })).values))
    .toEqual([243, 222, 200]);
});

test("cancellation stops bounded workers before they schedule more reads", async () => {
  let cancelled = false;
  const releases = [];
  const probe = vi.fn(() => new Promise(resolve => releases.push(resolve)));
  const ds = { meta: { samples: 100, lines: 100 }, ds: { probeValueAtBand: probe } };
  const pending = readLineProfile(ds, { points: [{ x: 0, y: 0 }, { x: 99, y: 0 }] }, 0,
    { concurrency: 2, cancelled: () => cancelled });
  expect(probe).toHaveBeenCalledTimes(2);
  cancelled = true;
  releases.forEach(resolve => resolve(1));
  expect(await pending).toBeNull();
  expect(probe).toHaveBeenCalledTimes(2);
});
