import InlineTiffCodecWorker from "./tiff-codecs.worker.js?worker&inline";
import {
  decodeBoundedTiffBlockDirect,
  estimateBoundedTiffScratchBytes
} from "./tiff-codecs-core.js";

function abortError() {
  const error = new Error("TIFF block decode aborted.");
  error.name = "AbortError";
  return error;
}

function transferableInput(buffer) {
  if (buffer instanceof ArrayBuffer) return buffer;
  if (ArrayBuffer.isView(buffer)
    && buffer.byteOffset === 0
    && buffer.byteLength === buffer.buffer.byteLength) return buffer.buffer;
  if (ArrayBuffer.isView(buffer)) return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  throw new TypeError("TIFF codec input must be an ArrayBuffer or typed-array view.");
}

function codecDirectory(fileDirectory) {
  return {
    Compression: fileDirectory?.Compression ?? fileDirectory?.compression ?? 1,
    Predictor: fileDirectory?.Predictor ?? fileDirectory?.predictor ?? 1,
    BitsPerSample: fileDirectory?.BitsPerSample ?? fileDirectory?.bitsPerSample,
    SamplesPerPixel: fileDirectory?.SamplesPerPixel ?? fileDirectory?.samplesPerPixel,
    PlanarConfiguration: fileDirectory?.PlanarConfiguration ?? fileDirectory?.planarConfiguration,
    TileWidth: fileDirectory?.TileWidth ?? fileDirectory?.tileWidth,
    ImageWidth: fileDirectory?.ImageWidth ?? fileDirectory?.imageWidth
  };
}

/** Decode in a disposable inline worker; Node/unit environments use the same bounded core directly. */
export function decodeBoundedTiffBlock(fileDirectory, buffer, expectedBytes, options = {}) {
  if (options.signal?.aborted || options.cancelled?.()) return Promise.reject(abortError());
  if (typeof Worker === "undefined") {
    return Promise.resolve().then(() => decodeBoundedTiffBlockDirect(
      fileDirectory,
      buffer,
      expectedBytes,
      options
    ));
  }

  return new Promise((resolve, reject) => {
    const worker = new InlineTiffCodecWorker();
    const input = transferableInput(buffer);
    let settled = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener?.("abort", onAbort);
      if (timer != null) clearInterval(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(abortError());
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    if (typeof options.cancelled === "function") {
      timer = setInterval(() => { if (options.cancelled()) onAbort(); }, 16);
    }
    worker.onerror = () => finish(new Error("Bounded TIFF codec worker crashed."));
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.error) {
        const error = new Error(String(data.error.message || "Bounded TIFF decode failed."));
        error.name = String(data.error.name || "Error");
        finish(error);
      } else {
        finish(null, data.buffer);
      }
    };
    worker.postMessage({
      id: 1,
      fileDirectory: codecDirectory(fileDirectory),
      buffer: input,
      expectedBytes,
      littleEndian: options.littleEndian
    }, [input]);
  });
}

export { decodeBoundedTiffBlockDirect, estimateBoundedTiffScratchBytes };
