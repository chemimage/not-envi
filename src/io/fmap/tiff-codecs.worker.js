import { decodeLibtiffBlock } from "../tiff/libtiff/codec.js";

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    const buffer = await decodeLibtiffBlock(
      message.fileDirectory,
      message.buffer,
      message.expectedBytes,
      { littleEndian: message.littleEndian, wasmModule: message.wasmModule }
    );
    self.postMessage({ id: message.id, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({
      id: message.id,
      error: { name: error?.name || "Error", message: error?.message || String(error) }
    });
  }
};
