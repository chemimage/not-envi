import { encodeExportJob } from "./encode-job.js";

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: encodeExportJob(data) }); }
  catch (error) { self.postMessage({ error: error.message || String(error) }); }
};
