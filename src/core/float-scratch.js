import { APP_CONFIG } from "../app/config.js";

export function createFloat32ScratchPool(options = {}) {
  const maxRetainedBuffers = Math.max(
    1,
    Math.floor(Number(options.maxRetainedBuffers) || APP_CONFIG.scratch.defaultMaxRetainedBuffers)
  );
  const maxRetainedElements = Math.max(
    0,
    Math.floor(Number(options.maxRetainedElements) || APP_CONFIG.scratch.defaultMaxRetainedElements)
  );
  const buckets = new Map();

  function acquire(length) {
    const size = Math.max(0, Math.floor(Number(length) || 0));
    if (!size) return new Float32Array(0);
    const bucket = buckets.get(size);
    if (bucket?.length) return bucket.pop();
    return new Float32Array(size);
  }

  function release(arr) {
    if (!(arr instanceof Float32Array) || !arr.length) return;
    const size = arr.length;
    if (size > maxRetainedElements) return;
    let bucket = buckets.get(size);
    if (!bucket) {
      bucket = [];
      buckets.set(size, bucket);
    }
    if (bucket.length < maxRetainedBuffers) bucket.push(arr);
  }

  function clear() {
    buckets.clear();
  }

  return {
    acquire,
    release,
    clear
  };
}
