import { decodeBoundedTiffBlockDirect } from "./tiff-codecs-core.js";

self.onmessage = (event) => {
  const message = event.data || {};
  try {
    const buffer = decodeBoundedTiffBlockDirect(
      message.fileDirectory,
      message.buffer,
      message.expectedBytes,
      { littleEndian: message.littleEndian }
    );
    self.postMessage({ id: message.id, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({
      id: message.id,
      error: { name: error?.name || "Error", message: error?.message || String(error) }
    });
  }
};
