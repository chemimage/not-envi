import { encodeExportJob } from "./encode-job.js";

self.onmessage = async ({ data }) => {
  try { self.postMessage({ result: await encodeExportJob(data) }); }
  catch (error) { self.postMessage({ error: error.message || String(error) }); }
};
