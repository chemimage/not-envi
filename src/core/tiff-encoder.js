export function tiffSampleFormatForEnviType(enviType) {
  if ([1, 12, 13, 15].includes(enviType)) return 1;
  if ([2, 3, 14].includes(enviType)) return 2;
  if ([4, 5].includes(enviType)) return 3;
  return 1;
}

export function littleEndianBytes(view, bytesPerSample) {
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytesPerSample === 1) return new Uint8Array(u8);
  if (isHostLittleEndian()) return new Uint8Array(u8);
  return encodeSampleBytesLittleEndian({ dataType: inferEnviTypeFromView(view), dataTypeInfo: { bytes: bytesPerSample } }, view);
}

let HOST_LITTLE_ENDIAN = null;

function isHostLittleEndian() {
  if (HOST_LITTLE_ENDIAN == null) {
    const probe = new Uint16Array([0x00ff]);
    HOST_LITTLE_ENDIAN = new Uint8Array(probe.buffer)[0] === 0xff;
  }
  return HOST_LITTLE_ENDIAN;
}

function inferEnviTypeFromView(view) {
  if (view instanceof Uint8Array || view instanceof Uint8ClampedArray) return 1;
  if (view instanceof Int16Array) return 2;
  if (view instanceof Int32Array) return 3;
  if (view instanceof Float32Array) return 4;
  if (view instanceof Float64Array) return 5;
  if (view instanceof Uint16Array) return 12;
  if (view instanceof Uint32Array) return 13;
  if (typeof BigInt64Array !== "undefined" && view instanceof BigInt64Array) return 14;
  if (typeof BigUint64Array !== "undefined" && view instanceof BigUint64Array) return 15;
  return 4;
}

function coerceBigInt(v, unsigned) {
  if (typeof v === "bigint") return v;
  if (!Number.isFinite(v)) return 0n;
  const n = Math.trunc(v);
  if (unsigned && n < 0) return 0n;
  return BigInt(n);
}

function encodeSampleBytesLittleEndian(meta, values) {
  if (!ArrayBuffer.isView(values)) {
    throw new Error("Raw TIFF page must be a typed array.");
  }

  const n = Number(values.length) || 0;
  const type = Number(meta?.dataType);
  const bytesPerSample = Number(meta?.dataTypeInfo?.bytes) || 0;
  if (!n || !bytesPerSample) return new Uint8Array(0);

  const buf = new ArrayBuffer(n * bytesPerSample);
  const dv = new DataView(buf);
  let o = 0;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    switch (type) {
      case 1: dv.setUint8(o, Number(v) || 0); o += 1; break;
      case 2: dv.setInt16(o, Number(v) || 0, true); o += 2; break;
      case 3: dv.setInt32(o, Number(v) || 0, true); o += 4; break;
      case 4: dv.setFloat32(o, Number(v) || 0, true); o += 4; break;
      case 5: dv.setFloat64(o, Number(v) || 0, true); o += 8; break;
      case 12: dv.setUint16(o, Number(v) || 0, true); o += 2; break;
      case 13: dv.setUint32(o, Number(v) || 0, true); o += 4; break;
      case 14:
        if (typeof dv.setBigInt64 !== "function") throw new Error("This browser does not support int64 TIFF export.");
        dv.setBigInt64(o, coerceBigInt(v, false), true);
        o += 8;
        break;
      case 15:
        if (typeof dv.setBigUint64 !== "function") throw new Error("This browser does not support uint64 TIFF export.");
        dv.setBigUint64(o, coerceBigInt(v, true), true);
        o += 8;
        break;
      default:
        throw new Error(`Unsupported raw TIFF data type for export: ${type}`);
    }
  }
  return new Uint8Array(buf);
}

function reverseSampleBytes(view, bytesPerSample) {
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytesPerSample === 1) return new Uint8Array(u8);
  const out = new Uint8Array(u8.length);
  for (let i = 0; i < u8.length; i += bytesPerSample) {
    for (let j = 0; j < bytesPerSample; j += 1) {
      out[i + j] = u8[i + (bytesPerSample - 1 - j)];
    }
  }
  return out;
}

function normalizeRawPageBytes(meta, page, expectedSamples) {
  const bytesPerSample = meta.dataTypeInfo.bytes;
  const expectedBytes = expectedSamples * bytesPerSample;
  if (
    page instanceof Uint8Array
    && Number(meta.dataType) !== 1
    && bytesPerSample > 1
    && page.byteLength === expectedBytes
    && page.length !== expectedSamples
  ) {
    return reverseSampleBytes(page, bytesPerSample);
  }
  return encodeSampleBytesLittleEndian(meta, page);
}

export function encodeTIFF_MultiPage_GrayRaw(meta, w, h, pages) {
  const bytesPerSample = meta.dataTypeInfo.bytes;
  const bits = bytesPerSample * 8;
  const sampleFormat = tiffSampleFormatForEnviType(meta.dataType);

  const N = pages.length;
  const numEntries = 11;
  const ifdSize = 2 + numEntries * 12 + 4;
  const headerSize = 8;
  const ifdArea = N * ifdSize;
  const firstPixelOffset = headerSize + ifdArea;

  const ifdBuf = new ArrayBuffer(firstPixelOffset);
  const dv = new DataView(ifdBuf);
  dv.setUint8(0, 0x49);
  dv.setUint8(1, 0x49);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);

  let pixelCursor = firstPixelOffset;
  const pixelParts = [];

  const writeEntry = (dataView, o, tag, type, count, value) => {
    dataView.setUint16(o + 0, tag, true);
    dataView.setUint16(o + 2, type, true);
    dataView.setUint32(o + 4, count, true);
    dataView.setUint32(o + 8, value, true);
  };

  for (let i = 0; i < N; i += 1) {
    const page = pages[i];
    const pixelBytes = normalizeRawPageBytes(meta, page, w * h);
    const bytes = pixelBytes.byteLength;
    const ifdOff = 8 + i * ifdSize;
    dv.setUint16(ifdOff, numEntries, true);
    let o = ifdOff + 2;

    writeEntry(dv, o, 256, 4, 1, w); o += 12;
    writeEntry(dv, o, 257, 4, 1, h); o += 12;
    writeEntry(dv, o, 258, 3, 1, bits); o += 12;
    writeEntry(dv, o, 259, 3, 1, 1); o += 12;
    writeEntry(dv, o, 262, 3, 1, 1); o += 12;
    writeEntry(dv, o, 273, 4, 1, pixelCursor); o += 12;
    writeEntry(dv, o, 277, 3, 1, 1); o += 12;
    writeEntry(dv, o, 278, 4, 1, h); o += 12;
    writeEntry(dv, o, 279, 4, 1, bytes); o += 12;
    writeEntry(dv, o, 284, 3, 1, 1); o += 12;
    writeEntry(dv, o, 339, 3, 1, sampleFormat); o += 12;

    dv.setUint32(ifdOff + 2 + numEntries * 12, (i === N - 1) ? 0 : (8 + (i + 1) * ifdSize), true);
    pixelParts.push(pixelBytes);
    pixelCursor += bytes;
  }

  const out = new Uint8Array(pixelCursor);
  out.set(new Uint8Array(ifdBuf), 0);
  let at = firstPixelOffset;
  for (const p of pixelParts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return new Blob([out], { type: "image/tiff" });
}

export function encodeTIFF_RGBA8(imageData) {
  const w = imageData.width;
  const h = imageData.height;
  const pixels = imageData.data;

  const ifdOffset = 8;
  const entries = [
    [256, 4, 1, w],
    [257, 4, 1, h],
    [258, 3, 4, 0],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 0],
    [277, 3, 1, 4],
    [278, 4, 1, h],
    [279, 4, 1, pixels.byteLength],
    [282, 5, 1, 0],
    [283, 5, 1, 0],
    [296, 3, 1, 2],
    [338, 3, 1, 2]
  ];

  const numEntries = entries.length;
  const ifdSize = 2 + numEntries * 12 + 4;

  const bitsPerSample = new Uint16Array([8, 8, 8, 8]);
  const xRes = new Uint32Array([72, 1]);
  const yRes = new Uint32Array([72, 1]);
  const extraSize = bitsPerSample.byteLength + xRes.byteLength + yRes.byteLength;
  const pixelOffset = ifdOffset + ifdSize + extraSize;
  const total = pixelOffset + pixels.byteLength;

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint8(o++, 0x49);
  dv.setUint8(o++, 0x49);
  dv.setUint16(o, 42, true); o += 2;
  dv.setUint32(o, ifdOffset, true); o += 4;

  dv.setUint16(ifdOffset, numEntries, true);
  let eoff = ifdOffset + 2;

  let cursor = ifdOffset + ifdSize;
  const bitsOffset = cursor; cursor += bitsPerSample.byteLength;
  const xResOffset = cursor; cursor += xRes.byteLength;
  const yResOffset = cursor; cursor += yRes.byteLength;

  for (const [tag, type, count, value] of entries) {
    dv.setUint16(eoff + 0, tag, true);
    dv.setUint16(eoff + 2, type, true);
    dv.setUint32(eoff + 4, count, true);
    let v = value;
    if (tag === 258) v = bitsOffset;
    if (tag === 273) v = pixelOffset;
    if (tag === 282) v = xResOffset;
    if (tag === 283) v = yResOffset;
    dv.setUint32(eoff + 8, v, true);
    eoff += 12;
  }

  dv.setUint32(ifdOffset + 2 + numEntries * 12, 0, true);
  for (let i = 0; i < bitsPerSample.length; i += 1) {
    dv.setUint16(bitsOffset + i * 2, bitsPerSample[i], true);
  }
  for (let i = 0; i < xRes.length; i += 1) {
    dv.setUint32(xResOffset + i * 4, xRes[i], true);
  }
  for (let i = 0; i < yRes.length; i += 1) {
    dv.setUint32(yResOffset + i * 4, yRes[i], true);
  }
  new Uint8Array(buf, pixelOffset, pixels.byteLength).set(pixels);

  return new Blob([buf], { type: "image/tiff" });
}
