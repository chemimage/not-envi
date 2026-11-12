import { expect, test, vi } from "vitest";
import { readBandWindow, readBandWindowBIP } from "../../src/core/raster-io.js";

test.each([readBandWindow, readBandWindowBIP])("%s checks a source output limit before allocating or dispatching", async (read) => {
  const allocate = vi.fn(function () { throw new Error("allocated before admission"); });
  const meta = { dataTypeInfo: { ctor: allocate } };
  const ds = { maxWindowResultBytes: 64, readBandWindow: vi.fn() };
  await expect(read(meta, ds, 0, 0, 0, 100000, 100000, 1)).rejects.toThrow("output limit");
  expect(allocate).not.toHaveBeenCalled();
  expect(ds.readBandWindow).not.toHaveBeenCalled();
});

test.each([
  [readBandWindow, "bsq", 1], [readBandWindow, "bil", 2],
  [readBandWindowBIP, "bip", 1], [readBandWindowBIP, "bip", 2]
])("%s forwards cancellation into %s reads with step %s", async (read, interleave, step) => {
  const meta = { samples: 4, lines: 4, bands: 1, headerOffset: 0, interleave,
    littleEndian: true, dataTypeInfo: { ctor: Uint8Array, bytes: 1, dv: "getUint8" } };
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const ds = {
    readInto: vi.fn(async (_offset, out, _start, length, received) => {
      expect(received).toBe(options);
      controller.abort();
      out.fill(17);
      return length;
    })
  };
  await expect(read(meta, ds, 0, 0, 0, 2, 2, step, 1, null, options)).rejects.toMatchObject({ name: "AbortError" });
  expect(ds.readInto).toHaveBeenCalledOnce();
});

test.each([readBandWindow, readBandWindowBIP])("%s admits budgeted custom windows before output allocation", async (read) => {
  const allocate = vi.fn(function () { throw new Error("allocated before admission"); });
  const meta = { samples: 100000, lines: 100000, dataTypeInfo: { ctor: allocate } };
  const ds = {
    managesWindowOutput: true,
    readBandWindow: vi.fn(async () => { throw new RangeError("logical result budget exceeded"); })
  };
  await expect(read(meta, ds, 0, 0, 0, 100000, 100000, 1)).rejects.toThrow("logical result budget exceeded");
  expect(allocate).not.toHaveBeenCalled();
  expect(ds.readBandWindow).toHaveBeenCalledOnce();
});

test.each([readBandWindow, readBandWindowBIP])("%s passes clipping and destination ownership to the budgeted reader", async (read) => {
  const meta = { samples: 3, lines: 2, dataTypeInfo: { ctor: Uint16Array } };
  const out = new Uint16Array(6);
  const options = { signal: new AbortController().signal };
  const ds = {
    managesWindowOutput: true,
    readBandWindow: vi.fn(async (_meta, _band, _x, _y, _w, _h, _step, target) => {
      target[0] = 17;
      return target;
    })
  };
  expect(await read(meta, ds, 1, 2, 1, 3, 2, 1, 2, out, options)).toBe(out);
  expect(ds.readBandWindow).toHaveBeenCalledWith(meta, 1, 2, 1, 3, 2, 1, out, options);
  expect([...out]).toEqual([17, 0, 0, 0, 0, 0]);
  expect(ds.stats.raster.decodedPixels).toBe(1);
});
