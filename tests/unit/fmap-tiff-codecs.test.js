import { deflate } from "pako";
import { describe, expect, test } from "vitest";
import {
  decodeBoundedTiffBlock,
  decodeBoundedTiffBlockDirect,
  estimateBoundedTiffScratchBytes
} from "../../src/io/fmap/tiff-codecs.js";

const COMPRESSION_NONE = 1;
const COMPRESSION_LZW = 5;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_PACKBITS = 32773;
const CLEAR = 256;
const EOI = 257;

function bytes(buffer) {
  return Array.from(new Uint8Array(buffer));
}

// TIFF LZW uses MSB-first codes and early code-width changes.
function packTiffLzw(codes) {
  const bits = [];
  let width = 9;
  let nextCode = 258;
  let hasOldCode = false;
  for (const code of codes) {
    for (let shift = width - 1; shift >= 0; shift -= 1) bits.push((code >> shift) & 1);
    if (code === CLEAR) {
      width = 9;
      nextCode = 258;
      hasOldCode = false;
    } else if (code !== EOI) {
      if (hasOldCode && nextCode < 4096) {
        nextCode += 1;
        if (nextCode + 1 >= 2 ** width && width < 12) width += 1;
      }
      hasOldCode = true;
    }
  }
  const output = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { output[index >> 3] |= bit << (7 - (index & 7)); });
  return output;
}

function deltaEncode(bytesToEncode, stride = 1) {
  const encoded = Uint8Array.from(bytesToEncode);
  for (let index = encoded.length - 1; index >= stride; index -= 1) {
    encoded[index] = (encoded[index] - encoded[index - stride]) & 0xff;
  }
  return encoded;
}

describe("bounded TIFF PackBits", () => {
  test("decodes literals and repeats while treating -128 as a no-op", () => {
    const encoded = Uint8Array.from([0x80, 1, 65, 66, 0xfe, 67]);
    expect(bytes(decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_PACKBITS }, encoded, 5
    ))).toEqual([65, 66, 67, 67, 67]);
  });

  test("rejects truncated, overflowing, and short streams", () => {
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_PACKBITS }, Uint8Array.from([2, 65]), 3
    )).toThrow(/Truncated PackBits literal/);
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_PACKBITS }, Uint8Array.from([0x81, 9]), 8
    )).toThrow(/exceeded its 8-byte/);
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_PACKBITS }, Uint8Array.from([0, 9]), 2
    )).toThrow(/produced 1 bytes; expected exactly 2/);
  });
});

describe("bounded TIFF LZW", () => {
  test("decodes dictionary references and the code-equals-next special case", () => {
    const encoded = packTiffLzw([CLEAR, 65, 66, 258, 260, EOI]);
    expect(bytes(decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_LZW }, encoded, 7
    ))).toEqual(Array.from(new TextEncoder().encode("ABABABA")));
  });

  test("tracks TIFF early-change widths through 9, 10, 11, and 12 bits", () => {
    const literals = Array.from({ length: 2300 }, (_, index) => index & 0xff);
    const encoded = packTiffLzw([CLEAR, ...literals, EOI]);
    expect(bytes(decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_LZW }, encoded, literals.length
    ))).toEqual(literals);
  });

  test("resets the dictionary and code width after a clear code", () => {
    const first = Array.from({ length: 600 }, (_, index) => index & 0xff);
    const second = Array.from({ length: 300 }, (_, index) => (255 - index) & 0xff);
    const encoded = packTiffLzw([CLEAR, ...first, CLEAR, ...second, EOI]);
    expect(bytes(decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_LZW }, encoded, first.length + second.length
    ))).toEqual([...first, ...second]);
  });

  test("rejects missing EOI, bad dictionary codes, and output overflow", () => {
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_LZW }, packTiffLzw([CLEAR, 65]), 1
    )).toThrow(/before its EOI/);
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_LZW }, packTiffLzw([CLEAR, 65, 300, EOI]), 2
    )).toThrow(/Invalid TIFF LZW code 300/);
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_LZW }, packTiffLzw([CLEAR, 65, 66, EOI]), 1
    )).toThrow(/exceeded its 1-byte/);
  });
});

describe("bounded TIFF Deflate", () => {
  test("streams valid output into the exact reservation", () => {
    const source = Uint8Array.from({ length: 70000 }, (_, index) => index & 0xff);
    expect(bytes(decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_DEFLATE }, deflate(source), source.length
    ))).toEqual(Array.from(source));
  });

  test("aborts a decompression bomb before output exceeds its reservation", () => {
    const bomb = deflate(new Uint8Array(256 * 1024));
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_DEFLATE }, bomb, 16
    )).toThrow(/exceeded its 16-byte/);
  });

  test("rejects invalid and short output", () => {
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_DEFLATE }, Uint8Array.from([1, 2, 3]), 1
    )).toThrow(/Invalid TIFF Deflate/);
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_DEFLATE }, deflate(Uint8Array.from([1, 2])), 3
    )).toThrow(/produced 2 bytes; expected exactly 3/);
  });
});

describe("bounded TIFF predictors", () => {
  test("applies Predictor 2 in explicit big-endian sample order", () => {
    const encoded = Uint8Array.from([0x01, 0x02, 0x02, 0x03, 0x01, 0x04]);
    const directory = {
      Compression: COMPRESSION_NONE,
      Predictor: 2,
      BitsPerSample: [16],
      SamplesPerPixel: 1,
      PlanarConfiguration: 1,
      ImageWidth: 3
    };
    expect(bytes(decodeBoundedTiffBlockDirect(
      directory, encoded, encoded.length, { littleEndian: false }
    ))).toEqual([0x01, 0x02, 0x03, 0x05, 0x04, 0x09]);
  });

  test("reconstructs Predictor 3 byte planes into each file byte order", () => {
    const shuffled = [0x3f, 0x40, 0x80, 0, 0, 0, 0, 0];
    const encoded = deltaEncode(shuffled);
    const directory = {
      Compression: COMPRESSION_NONE,
      Predictor: 3,
      BitsPerSample: [32],
      SamplesPerPixel: 1,
      PlanarConfiguration: 1,
      ImageWidth: 2
    };
    expect(bytes(decodeBoundedTiffBlockDirect(
      directory, encoded, encoded.length, { littleEndian: false }
    ))).toEqual([0x3f, 0x80, 0, 0, 0x40, 0, 0, 0]);
    expect(bytes(decodeBoundedTiffBlockDirect(
      directory, encoded, encoded.length, { littleEndian: true }
    ))).toEqual([0, 0, 0x80, 0x3f, 0, 0, 0, 0x40]);
  });

  test("requires byte order for multi-byte predictors", () => {
    expect(() => decodeBoundedTiffBlockDirect({
      Compression: COMPRESSION_NONE,
      Predictor: 2,
      BitsPerSample: [16],
      SamplesPerPixel: 1,
      ImageWidth: 1
    }, Uint8Array.from([0, 1]), 2)).toThrow(/byte order/);
  });
});

describe("bounded TIFF codec contract", () => {
  test("reports bounded codec and Predictor 3 scratch", () => {
    expect(estimateBoundedTiffScratchBytes({ Compression: COMPRESSION_PACKBITS })).toBe(0);
    expect(estimateBoundedTiffScratchBytes({ Compression: COMPRESSION_LZW })).toBe(16384);
    expect(estimateBoundedTiffScratchBytes({ Compression: COMPRESSION_DEFLATE })).toBe(98304);
    expect(estimateBoundedTiffScratchBytes({
      Compression: COMPRESSION_DEFLATE,
      Predictor: 3,
      BitsPerSample: [32, 32, 32],
      SamplesPerPixel: 3,
      ImageWidth: 10
    })).toBe(98304 + 120);
  });

  test("rejects unsafe lengths, unsupported compression, and cancellation", () => {
    expect(() => decodeBoundedTiffBlockDirect({}, new Uint8Array(), Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe integer/);
    expect(() => decodeBoundedTiffBlockDirect({ Compression: 7 }, new Uint8Array(), 0)).toThrow(/Unsupported/);
    expect(() => decodeBoundedTiffBlockDirect(
      { Compression: COMPRESSION_NONE }, new Uint8Array(), 0, { cancelled: () => true }
    )).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });

  test("uses the same bounded core through the async API fallback", async () => {
    await expect(decodeBoundedTiffBlock(
      { Compression: COMPRESSION_PACKBITS }, Uint8Array.from([2, 10, 20, 30]), 3
    )).resolves.toEqual(expect.any(ArrayBuffer));
    expect(bytes(await decodeBoundedTiffBlock(
      { Compression: COMPRESSION_PACKBITS }, Uint8Array.from([2, 10, 20, 30]), 3
    ))).toEqual([10, 20, 30]);
  });
});
