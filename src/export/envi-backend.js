function pushListLine(lines, key, values) {
  if (!Array.isArray(values) || !values.length) return;
  const out = values.map((v) => String(v == null ? "" : v).trim()).filter((v) => v.length > 0);
  if (!out.length) return;
  lines.push(`${key} = {${out.join(", ")}}`);
}

function coerceBigInt(v, unsigned) {
  if (typeof v === "bigint") return v;
  if (!Number.isFinite(v)) return 0n;
  const n = Math.trunc(v);
  if (unsigned && n < 0) return 0n;
  return BigInt(n);
}

export function encodeEnviBandBytes(meta, values, littleEndian = true) {
  const n = Number(values?.length) || 0;
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
      case 2: dv.setInt16(o, Number(v) || 0, littleEndian); o += 2; break;
      case 3: dv.setInt32(o, Number(v) || 0, littleEndian); o += 4; break;
      case 4: dv.setFloat32(o, Number(v) || 0, littleEndian); o += 4; break;
      case 5: dv.setFloat64(o, Number(v) || 0, littleEndian); o += 8; break;
      case 12: dv.setUint16(o, Number(v) || 0, littleEndian); o += 2; break;
      case 13: dv.setUint32(o, Number(v) || 0, littleEndian); o += 4; break;
      case 14: {
        if (typeof dv.setBigInt64 !== "function") throw new Error("This browser does not support ENVI int64 export.");
        dv.setBigInt64(o, coerceBigInt(v, false), littleEndian);
        o += 8;
        break;
      }
      case 15: {
        if (typeof dv.setBigUint64 !== "function") throw new Error("This browser does not support ENVI uint64 export.");
        dv.setBigUint64(o, coerceBigInt(v, true), littleEndian);
        o += 8;
        break;
      }
      default:
        throw new Error(`Unsupported ENVI data type for export: ${type}`);
    }
  }
  return new Uint8Array(buf);
}

export function buildEnviHeaderText({
  meta,
  width,
  height,
  bands,
  interleave = "bsq",
  littleEndian = true,
  dataFileName = ""
}) {
  const lines = [];
  lines.push("ENVI");
  lines.push("description = {Exported by not-envi}");
  lines.push(`samples = ${Math.max(1, Math.floor(width || 1))}`);
  lines.push(`lines = ${Math.max(1, Math.floor(height || 1))}`);
  lines.push(`bands = ${Math.max(1, Math.floor(bands || 1))}`);
  lines.push("header offset = 0");
  lines.push("file type = ENVI Standard");
  lines.push(`data type = ${Number(meta?.dataType) || 4}`);
  lines.push(`interleave = ${String(interleave || "bsq").toLowerCase()}`);
  lines.push(`byte order = ${littleEndian ? 0 : 1}`);
  if (dataFileName) lines.push(`data file = ${dataFileName}`);

  const wlUnits = String(meta?.wlUnits || "").trim();
  if (wlUnits) lines.push(`wavelength units = ${wlUnits}`);
  if (Array.isArray(meta?.bandNames) && meta.bandNames.length === bands) {
    pushListLine(lines, "band names", meta.bandNames);
  }
  if (Array.isArray(meta?.wavelengths) && meta.wavelengths.length === bands) {
    pushListLine(lines, "wavelength", meta.wavelengths);
  }

  return `${lines.join("\n")}\n`;
}

