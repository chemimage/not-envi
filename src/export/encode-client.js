import InlineExportWorker from "./encode.worker.js?worker&inline";
import { loadLibtiffCompiled } from "../io/tiff/libtiff/compiled.js";

// Inputs may belong to a source cache: clone rather than detach their buffers.
// A worker lives for one encoding operation and is always retired on settlement.
export async function encodeInWorker(job) {
  const compiled = job.kind === "envi" ? undefined : await loadLibtiffCompiled();
  return new Promise((resolve, reject) => {
    const worker = new InlineExportWorker();
    const finish = (error, value) => {
      worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
    worker.onerror = (event) => finish(new Error(event.message || "Export encoder failed."));
    worker.onmessageerror = () => finish(new Error("Could not receive encoded export."));
    try { worker.postMessage({ ...job, compiled }); }
    catch (error) { finish(error); }
  });
}
