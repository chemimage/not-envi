import { describe, expect, test, vi } from "vitest";
import { probeValueAtBand, readSpectrumAtPixel, wavelengthArrayOrNull } from "../../src/render/spectrum-data.js";

function makeMeta(interleave, samples = 3, lines = 2, bands = 3) {
  return {
    samples,
    lines,
    bands,
    headerOffset: 0,
    interleave,
    littleEndian: true,
    wavelengths: [450, "550", 650],
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

function makeDs(meta) {
  const u8 = makeBuffer(meta);
  return {
    meta,
    ds: {
      async read(offset, length) {
        return u8.subarray(offset, offset + length);
      }
    }
  };
}

describe("spectrum-data", () => {
  test("probeValueAtBand reads single value", async () => {
    const ds = makeDs(makeMeta("bsq"));
    const v = await probeValueAtBand(ds, 2, 1, 1);
    expect(v).toBe(112);
  });

  test("probeValueAtBand returns null for out-of-bounds", async () => {
    const ds = makeDs(makeMeta("bsq"));
    const v = await probeValueAtBand(ds, -1, 0, 0);
    expect(v).toBeNull();
  });

  test("readSpectrumAtPixel supports bip path", async () => {
    const ds = makeDs(makeMeta("bip"));
    const out = await readSpectrumAtPixel(ds, 1, 1, 2);
    expect(Array.from(out)).toEqual([11, 111, 211]);
  });

  test("readSpectrumAtPixel supports bsq/bil per-band reads", async () => {
    const dsBsq = makeDs(makeMeta("bsq"));
    const outBsq = await readSpectrumAtPixel(dsBsq, 1, 1, 2);
    expect(Array.from(outBsq)).toEqual([11, 111, 211]);

    const dsBil = makeDs(makeMeta("bil"));
    const outBil = await readSpectrumAtPixel(dsBil, 1, 1, 2);
    expect(Array.from(outBil)).toEqual([11, 111, 211]);
  });

  test("custom datasource hooks are preferred for probe and spectrum reads", async () => {
    const probeValue = vi.fn(async () => 42);
    const spectrumValue = vi.fn(async () => Float32Array.from([7, 8, 9]));
    const ds = {
      meta: makeMeta("bsq"),
      ds: {
        probeValueAtBand: probeValue,
        readSpectrumAtPixel: spectrumValue
      }
    };

    expect(await probeValueAtBand(ds, 1, 1, 2)).toBe(42);
    expect(Array.from(await readSpectrumAtPixel(ds, 1, 1, 2))).toEqual([7, 8, 9]);
    expect(probeValue).toHaveBeenCalledWith(ds.meta, 1, 1, 2);
    expect(spectrumValue).toHaveBeenCalledWith(ds.meta, 1, 1, 2);
  });

  test("forwards per-request options to a custom spectrum reader", async () => {
    const spectrumValue = vi.fn(async () => Float32Array.from([7, 8, 9]));
    const ds = { meta: makeMeta("bsq"), ds: { readSpectrumAtPixel: spectrumValue } };
    const options = { cancelled: () => false, priority: "foreground" };

    await readSpectrumAtPixel(ds, 1, 1, 3, options);

    expect(spectrumValue).toHaveBeenCalledWith(ds.meta, 1, 1, 3, options);
  });

  test("wavelengthArrayOrNull normalizes numeric-like values", () => {
    const ds = makeDs(makeMeta("bsq"));
    expect(wavelengthArrayOrNull(ds)).toEqual([450, 550, 650]);

    const bad = makeDs({ ...makeMeta("bsq"), wavelengths: [450, "bad", 650] });
    expect(wavelengthArrayOrNull(bad)).toBeNull();

    const withUnits = makeDs({ ...makeMeta("bsq"), wavelengths: ["4000 cm-1", "3990 cm^-1", "3980 cm⁻1"] });
    expect(wavelengthArrayOrNull(withUnits)).toEqual([4000, 3990, 3980]);
  });
});
