import { describe, expect, test } from "vitest";
import { pixelOffset, readBandWindow, readBandWindowBIP, toFloat32 } from "../../src/core/raster-io.js";

function makeMeta(interleave, samples = 3, lines = 2, bands = 2) {
  return {
    samples,
    lines,
    bands,
    headerOffset: 0,
    interleave,
    littleEndian: true,
    dataTypeInfo: {
      bytes: 2,
      ctor: Uint16Array,
      dv: "getUint16"
    }
  };
}

function valueAt(x, y, b) {
  return (b * 100) + (y * 10) + x;
}

function makeBuffer(meta) {
  const bytes = meta.dataTypeInfo.bytes;
  const total = meta.samples * meta.lines * meta.bands * bytes;
  const ab = new ArrayBuffer(total);
  const dv = new DataView(ab);
  for (let y = 0; y < meta.lines; y += 1) {
    for (let x = 0; x < meta.samples; x += 1) {
      for (let b = 0; b < meta.bands; b += 1) {
        const v = valueAt(x, y, b);
        let off = 0;
        if (meta.interleave === "bsq") {
          off = (((b * meta.lines + y) * meta.samples + x) * bytes);
        } else if (meta.interleave === "bil") {
          off = ((((y * meta.bands + b) * meta.samples + x) * bytes));
        } else {
          off = ((((y * meta.samples + x) * meta.bands + b) * bytes));
        }
        dv.setUint16(off, v, true);
      }
    }
  }
  return new Uint8Array(ab);
}

function makeDs(u8) {
  return {
    async read(offset, length) {
      return u8.subarray(offset, offset + length);
    }
  };
}

function makeDsReadIntoOnly(u8) {
  const stats = { readIntoCalls: 0 };
  return {
    stats,
    async read() {
      throw new Error("read() should not be used when readInto() is available");
    },
    async readInto(offset, dest, destOffset = 0, length = dest.byteLength) {
      stats.readIntoCalls += 1;
      const view = u8.subarray(offset, offset + length);
      dest.set(view, destOffset);
      return view.byteLength;
    }
  };
}

describe("raster-io", () => {
  test("pixelOffset computes offsets for bsq/bil/bip", () => {
    const bsq = makeMeta("bsq", 4, 3, 2);
    const bil = makeMeta("bil", 4, 3, 2);
    const bip = makeMeta("bip", 4, 3, 2);

    expect(pixelOffset(bsq, 1, 2, 1)).toBe((((1 * 3 + 2) * 4 + 1) * 2));
    expect(pixelOffset(bil, 1, 2, 1)).toBe(((((2 * 2 + 1) * 4 + 1) * 2)));
    expect(pixelOffset(bip, 1, 2, 1)).toBe(((((2 * 4 + 1) * 2 + 1) * 2)));
  });

  test("readBandWindow returns expected samples for bsq", async () => {
    const meta = makeMeta("bsq");
    const ds = makeDs(makeBuffer(meta));
    const out = await readBandWindow(meta, ds, 1, 0, 0, 3, 2, 1, 2);
    expect(Array.from(out)).toEqual([100, 101, 102, 110, 111, 112]);
  });

  test("readBandWindow returns expected samples for bil", async () => {
    const meta = makeMeta("bil");
    const ds = makeDs(makeBuffer(meta));
    const out = await readBandWindow(meta, ds, 1, 0, 0, 3, 2, 1, 2);
    expect(Array.from(out)).toEqual([100, 101, 102, 110, 111, 112]);
  });

  test("readBandWindowBIP returns expected samples for bip", async () => {
    const meta = makeMeta("bip");
    const ds = makeDs(makeBuffer(meta));
    const out = await readBandWindowBIP(meta, ds, 0, 1, 0, 2, 2, 1, 2);
    expect(Array.from(out)).toEqual([1, 2, 11, 12]);
  });

  test("readBandWindow fills a provided Float32Array via readInto", async () => {
    const meta = makeMeta("bsq");
    const ds = makeDsReadIntoOnly(makeBuffer(meta));
    const dest = new Float32Array(6);
    const out = await readBandWindow(meta, ds, 1, 0, 0, 3, 2, 1, 2, dest);
    expect(out).toBe(dest);
    expect(Array.from(out)).toEqual([100, 101, 102, 110, 111, 112]);
  });

  test("readBandWindowBIP fills a provided Float32Array via readInto", async () => {
    const meta = makeMeta("bip");
    const ds = makeDsReadIntoOnly(makeBuffer(meta));
    const dest = new Float32Array(4);
    const out = await readBandWindowBIP(meta, ds, 0, 1, 0, 2, 2, 1, 2, dest);
    expect(out).toBe(dest);
    expect(Array.from(out)).toEqual([1, 2, 11, 12]);
  });

  test("readBandWindow groups contiguous full-width rows into one slab read", async () => {
    const meta = makeMeta("bsq", 3, 4, 2);
    const ds = makeDsReadIntoOnly(makeBuffer(meta));
    const out = await readBandWindow(meta, ds, 1, 0, 0, 3, 4, 1, 2);
    expect(Array.from(out)).toEqual([100, 101, 102, 110, 111, 112, 120, 121, 122, 130, 131, 132]);
    expect(ds.stats.readIntoCalls).toBe(1);
  });

  test("readBandWindowBIP groups contiguous full-width rows into one slab read", async () => {
    const meta = makeMeta("bip", 3, 4, 2);
    const ds = makeDsReadIntoOnly(makeBuffer(meta));
    const out = await readBandWindowBIP(meta, ds, 1, 0, 0, 3, 4, 1, 2);
    expect(Array.from(out)).toEqual([100, 101, 102, 110, 111, 112, 120, 121, 122, 130, 131, 132]);
    expect(ds.stats.readIntoCalls).toBe(1);
  });

  test("readBandWindow delegates to a custom datasource reader", async () => {
    const meta = makeMeta("bsq", 4, 4, 2);
    const ds = {
      async readBandWindow(_meta, band, x0, y0, outW, outH, step, out) {
        expect(band).toBe(1);
        expect(x0).toBe(1);
        expect(y0).toBe(1);
        expect(outW).toBe(2);
        expect(outH).toBe(2);
        expect(step).toBe(1);
        out.set([100, 101, 110, 111]);
        return out;
      }
    };
    const out = await readBandWindow(meta, ds, 1, 1, 1, 2, 2, 1, 2);
    expect(Array.from(out)).toEqual([100, 101, 110, 111]);
  });

  test("readBandWindowBIP delegates to a custom datasource reader", async () => {
    const meta = makeMeta("bip", 4, 4, 3);
    const ds = {
      async readBandWindowBIP(_meta, band, x0, y0, outW, outH, step, out) {
        expect(band).toBe(2);
        expect(x0).toBe(0);
        expect(y0).toBe(1);
        expect(outW).toBe(2);
        expect(outH).toBe(2);
        expect(step).toBe(1);
        out.set([200, 201, 210, 211]);
        return out;
      }
    };
    const out = await readBandWindowBIP(meta, ds, 2, 0, 1, 2, 2, 1, 2);
    expect(Array.from(out)).toEqual([200, 201, 210, 211]);
  });

  test("toFloat32 converts numeric arrays", () => {
    const inArr = new Uint16Array([1, 2, 3]);
    const out = toFloat32(inArr);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  test("toFloat32 can fill a provided destination buffer", () => {
    const inArr = new Uint16Array([4, 5, 6]);
    const dest = new Float32Array(3);
    const out = toFloat32(inArr, dest);
    expect(out).toBe(dest);
    expect(Array.from(dest)).toEqual([4, 5, 6]);
  });
});
