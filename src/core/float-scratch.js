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
  const maxRetainedBytes = options.maxRetainedBytes ?? Infinity;
  let retainedBytes = 0;

  function acquire(length) {
    const size = Math.max(0, Math.floor(Number(length) || 0));
    if (!size) return new Float32Array(0);
    const bucket = buckets.get(size);
    if (bucket?.length) {
      const result = bucket.pop();
      if (!bucket.length) buckets.delete(size);
      retainedBytes -= result.byteLength;
      return result;
    }
    return new Float32Array(size);
  }

  function release(arr) {
    if (!(arr instanceof Float32Array) || !arr.length) return;
    const size = arr.length;
    if (size > maxRetainedElements) return;
    if (retainedBytes + arr.byteLength > maxRetainedBytes) return;
    let bucket = buckets.get(size);
    if (!bucket) {
      bucket = [];
      buckets.set(size, bucket);
    }
    if (bucket.length < maxRetainedBuffers) {
      bucket.push(arr);
      retainedBytes += arr.byteLength;
    }
  }

  function clear() {
    buckets.clear();
    retainedBytes = 0;
  }

  return {
    acquire,
    release,
    clear,
    stats: () => ({ retainedBytes })
  };
}
