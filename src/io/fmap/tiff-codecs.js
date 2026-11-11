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

function abortSignals(options) {
  return Array.from(new Set([
    options?.signal,
    ...(Array.isArray(options?.signals) ? options.signals : [])
  ].filter((signal) => signal && typeof signal.addEventListener === "function")));
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
  const signals = abortSignals(options);
  if (signals.some((signal) => signal.aborted) || options.cancelled?.()) return Promise.reject(abortError());
  if (typeof Worker === "undefined") {
    return Promise.resolve().then(() => decodeBoundedTiffBlockDirect(
      fileDirectory,
      buffer,
      expectedBytes,
      options
    ));
  }

  return new Promise((resolve, reject) => {
    let input;
    try {
      input = transferableInput(buffer);
    } catch (error) {
      reject(error);
      return;
    }
    const worker = new InlineTiffCodecWorker();
    let settled = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      for (const signal of signals) signal.removeEventListener?.("abort", onAbort);
      if (timer != null) clearInterval(timer);
      try { worker.terminate(); } catch (_error) {}
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(abortError());
    for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
    if (typeof options.cancelled === "function") {
      timer = setInterval(() => {
        try {
          if (options.cancelled()) onAbort();
        } catch (error) {
          finish(error);
        }
      }, 16);
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
    if (signals.some((signal) => signal.aborted)) {
      onAbort();
      return;
    }
    try {
      worker.postMessage({
        id: 1,
        fileDirectory: codecDirectory(fileDirectory),
        buffer: input,
        expectedBytes,
        littleEndian: options.littleEndian
      }, [input]);
    } catch (error) {
      finish(error);
    }
  });
}

export { decodeBoundedTiffBlockDirect, estimateBoundedTiffScratchBytes };
