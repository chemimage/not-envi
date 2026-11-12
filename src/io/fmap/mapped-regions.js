import { checkedAdd, assertSafeFileInteger, createAbortError } from "./protocol.js";

const pointers = new WeakMap();

/**
 * Logical file positions, never WASM pointers. Mapping identity survives cache
 * eviction/clear but is never reused after unmap. All byte access still passes
 * through worker-side range-tree resolution and the shared file page cache.
 *
 * const region = await source.map({ offset: 4093, length: 10000 });
 * await region.readInto(region.ptr(7), new Uint8Array(128));
 * await region.release();
 *
 * Virtual bases are fpage-aligned; file offsets and access bounds are byte
 * exact. Overlapping file aliases share the file's page grid, not separate
 * mapping-relative caches. read() returns an owned bounded result; readInto()
 * copies into caller storage and does not expose evictable WASM views.
 */
export class FmapRegion {
  #source;
  #control;
  #released = false;
  #releasePromise = null;

  constructor(source, control, { mappingId, address, offset, length }) {
    this.#source = source;
    this.#control = control;
    Object.defineProperties(this, {
      mappingId: { value: mappingId, enumerable: true },
      address: { value: address, enumerable: true },
      offset: { value: offset, enumerable: true },
      length: { value: length, enumerable: true }
    });
  }

  get released() { return this.#released || this.#source.closed; }

  #requireLive() {
    if (this.released) throw createAbortError("fmap mapping has been released.");
  }

  ptr(offset = 0) {
    this.#requireLive();
    const relative = assertSafeFileInteger(offset, "mapping pointer offset");
    if (relative > this.length) throw new RangeError("fmap pointer exceeds its mapping.");
    const pointer = Object.freeze({ mappingId: this.mappingId, address: checkedAdd(this.address, relative) });
    pointers.set(pointer, { region: this, offset: relative });
    return pointer;
  }

  async read(pointer, length, out = null, options = {}) {
    options ||= {};
    this.#requireLive();
    const position = pointers.get(pointer);
    if (position?.region !== this) throw new TypeError("fmap pointer belongs to another mapping.");
    const count = assertSafeFileInteger(length, "mapped read length");
    if (checkedAdd(position.offset, count) > this.length) throw new RangeError("fmap read exceeds its mapping.");
    const cancelled = () => this.released || !!options.cancelled?.();
    return this.#source.readRange(checkedAdd(this.offset, position.offset), count, out, {
      ...options, cancelled, mappingId: this.mappingId, virtualAddress: pointer.address
    });
  }

  async readInto(pointer, destination, options = {}) {
    if (!(destination instanceof Uint8Array)) throw new TypeError("fmap readInto requires a Uint8Array.");
    this.#requireLive();
    const position = pointers.get(pointer);
    if (position?.region !== this) throw new TypeError("fmap pointer belongs to another mapping.");
    if (checkedAdd(position.offset, destination.byteLength) > this.length) throw new RangeError("fmap read exceeds its mapping.");
    // Caller storage may exceed one logical result. Advance a bounded cursor,
    // reserving only the chunk being filled, rather than materializing a copy.
    const chunkBytes = Math.min(this.#source.maxResultBytes, this.#source.maxLogicalResultBytes, this.#source.maxLogicalBytes);
    if (!destination.byteLength) await this.read(pointer, 0, destination, options);
    for (let cursor = 0; cursor < destination.byteLength; cursor += chunkBytes) {
      const target = destination.subarray(cursor, Math.min(destination.byteLength, cursor + chunkBytes));
      await this.read(this.ptr(position.offset + cursor), target.byteLength, target, options);
    }
    return destination.byteLength;
  }

  /** Unmapping removes access, not other mappings' shared cached bytes. */
  release() {
    if (this.#releasePromise) return this.#releasePromise;
    if (this.released) return Promise.resolve();
    this.#released = true;
    this.#releasePromise = this.#source.ready.then(() => this.#control("unmapRegion", { mappingId: this.mappingId }, 0));
    return this.#releasePromise;
  }
}

/** Main-thread handles only; the authoritative sparse range index lives in C. */
export class FmapMappings {
  constructor(source, control) {
    this.source = source;
    this.control = control;
    this.root = new FmapRegion(source, control, { mappingId: 1, address: 0, offset: 0, length: source.size });
  }

  async map({ offset = 0, length = this.source.size - offset, address } = {}) {
    const start = assertSafeFileInteger(offset, "mapping file offset");
    const count = assertSafeFileInteger(length, "mapping length");
    if (!count || checkedAdd(start, count) > this.source.size) throw new RangeError("fmap mapping is empty or exceeds EOF.");
    if (address != null) {
      assertSafeFileInteger(address, "mapping address");
      if (address % this.source.pageSize) throw new RangeError("fmap mapping address must be fpage aligned.");
      checkedAdd(address, count, "mapping address range");
    }
    await this.source.ready;
    const mapped = await this.control("mapRegion", { offset: start, length: count, address }, 0);
    return new FmapRegion(this.source, this.control, mapped);
  }
}
