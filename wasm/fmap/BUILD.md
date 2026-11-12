# fmap C/WASM core

The fmap core is freestanding C compiled directly to WebAssembly. It owns a
fixed resident page pool, page metadata, pin counts, LRU selection, counters,
one page-sized scratch region for exact cold reads, and a bounded Float32
compatibility/Float64 numeric output buffer. The generic ABI decodes all nine
supported ENVI scalar types in either byte order; browser code remains
responsible for file range I/O.

The source/API boundaries are described in [the C module overview](../README.md).
`fmap_core.c` owns resident pages and numeric extraction adapters; `fmap_page_index.c`
provides the pool-bounded page-ID lookup. `fmap_mappings.c` owns the sparse
mapping tree, handle index and gap summaries. `fmap_fills.c` owns page-demand
admission, priorities, overlap deduplication, exact missing-range planning,
fill reservations, completion/cancellation and independently pinned leases.
`fmap_hash.c` shares the documented ID mixer, and `fmap_memory.c` supplies
shared memory helpers and a reusable metadata arena.
`fmap_reduction.c` validates pinned spans and adapts the independent
`wasm/reduction` kernels; extraction and reduction share `wasm/numeric` decoding.
`include/fmap.h` is a compatibility umbrella over functional public headers in
`include/fmap/` (cache, numeric, reduction, fills, mappings, diagnostics and status).
These headers declare the public WASM ABI and status codes. Browser callers
instantiate `fmap_core.wasm` and call `instance.exports.fmap_*`; C callers use
`#include <fmap.h>` with `wasm/fmap/include` on their include path. The header
describes the WASM ABI, including linear-memory addresses; this package does
not currently produce a native library. `src/fmap_internal.h` stays private:
it includes the public header and declares only cross-module implementation
helpers. Moving that file into the public include directory would expose those
helpers without making them exported functions. Mutable state stays
private to its owning module. Pool initialization establishes one layout and
places mapping and fill allocations after the pool, scratch and output regions. Cache
reset preserves mappings; successful pool reinitialization resets them.
Page lookup uses a fixed hash table sized from resident slots, while eviction
victim selection retains its separate linear LRU scan.

## Pinned build

The build is pinned to WASI SDK 24.0 (Clang/LLVM 18.1.2). The core does not use
WASI or libc; the SDK supplies a reproducible Windows Clang and `wasm-ld`.

Download and extract the official
[`wasi-sdk-24.0-x86_64-windows.tar.gz`](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-x86_64-windows.tar.gz).
Its SHA-256 must be
`0f934c6e7e171b5627c81b697a9e57e96d65cd889f56ce6077350de48978afd3`.
After extracting it, run from the repository root:

```powershell
$env:FMAP_CLANG = "C:\path\to\wasi-sdk-24.0-x86_64-windows\bin\clang.exe"
node scripts/build-fmap-wasm.mjs
```

For Linux CI the matching archive is
[`wasi-sdk-24.0-x86_64-linux.tar.gz`](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-x86_64-linux.tar.gz),
SHA-256 `c6c38aab56e5de88adf6c1ebc9c3ae8da72f88ec2b656fb024eda8d4167a0bc5`.
Set `FMAP_CLANG` to its `bin/clang` executable. CI checks the download hash before extraction.

The script rejects a compiler that does not report Clang 18.1.2, compiles every
public header independently as C/C++, checks a numeric/reduction-only consumer
without fmap dependencies, links the freestanding module, runs the direct ABI
suite, verifies the WASM magic bytes,
and writes:

- `wasm/fmap/pkg/fmap_core.wasm`
- `wasm/fmap/pkg/fmap_core.build.json`

Run the ABI suite independently with:

```powershell
node scripts/test-fmap-core.mjs
```

## Generated artifact policy

The `.wasm` file and build manifest are committed so the JavaScript build can
remain offline and reproduce the single-file application. Do not hand-edit
them. Regenerate both through the build script after changing any C source or header,
then review the recorded compiler, command, exports, size, and SHA-256.
The build discovers and compiles every `.c` file under the `src` directories of
`wasm/fmap`, `wasm/numeric` and `wasm/reduction`, including subdirectories.
The manifest records the linked module names, every `.c` and `.h` path under
their `src` and `include` directories relative to `wasm`, and its normalized
LF source hash, plus a deterministic hash of that complete sorted source set.
Build and Vite verification use the same discovery and hashing helper. Vite
rejects a stale binary after a source/header edit, addition, removal or rename
until the artifact is regenerated; CRLF versus LF checkouts hash identically.

This core is single-threaded and does not require `SharedArrayBuffer` or
cross-origin isolation. It grows linear memory once to establish the requested
fixed pool, and can grow further for sparse mapping metadata. Reinitializing
reuses the same heap base and does not accumulate resident pools; WASM memory
itself cannot shrink.

## Fill policy ABI and resource boundaries

`fmap_fill_init(fileSize:u64, concurrency:u32, maxCount:u32, maxBytes:u32)`
configures one queue per pool. `fmap_fill_submit(page:u64, offset, length,
fillGrain, priority)` returns a positive opaque demand ID or a negative status.
Priority 0 precedes priority 1; foreground demands can displace unstarted
background admission without cancelling consumers. Admitted count/bytes and
active provider concurrency remain separate limits. Full-refill fallback on
validity-table exhaustion and fill-grain expansion are bounded by the page/EOF.

`fmap_fill_poll()` returns zero or a pointer to a 24-byte command snapshot:
four little-endian u32 fields (fill ID, slot, page-relative start, length),
followed by the exact u64 file offset. The browser adapter copies this snapshot
and performs the asynchronous read. After settlement, `fmap_fill_prepare(id)`
returns zero for a retired command, or a write pointer checked against the
fill epoch, cache generation, slot page and reservation identity. Copy bytes
synchronously into a freshly acquired memory view, then call
`fmap_fill_complete(id, success)`. Failure uses success=0; duplicate settlement
is harmless. No pointer or WASM view may cross an await or allocating C call.

`fmap_fill_event()` returns zero or a pointer to a 24-byte event snapshot:
six little-endian fields (demand ID, slot, offset, length, signed error status,
failure fill ID). Success transfers the reserved pin to a delivered lease.
Release it with `fmap_fill_release(demandId)`; each consumer owns its own pin.
`fmap_fill_cancel(id)` cancels pending consumers, preserving shared fills.
Errors -9 and -10 denote cancellation and provider failure respectively.

`fmap_fill_clear()` invalidates pending demands and delivered leases, clears
the cache while preserving mappings, and retires active commands. Started
provider reads remain charged until `complete`, even after close. Old commands
cannot get a write pointer or release a new slot reservation. Demand/fill IDs
are never reused within a module instance; exhaustion fails explicitly. Raw
cache reset/pool reinitialization reject live fill state: use fill clear and
drain provider reads first. Mapping reset returns only its own arena blocks,
so it cannot overwrite fill descriptors or leases.

`fmap_fill_concurrency(n)` changes the read limit without dropping active work.
`fmap_fill_stat(index)` returns u64 counters; their names and stable order are
listed in `src/io/fmap/page-fill-queue.js`. In addition to queue/read/copy
counts, `fillLiveDemands` includes pending events and unreleased leases, and
`peakFillLiveDemands` records its high water mark. `fillMetadataBytes` counts
allocated fill-node payload storage, excluding shared allocator headers,
mapping storage, JS callbacks/Promises and browser buffers. Reusable 32-node
chunks retain their high water capacity until pool reinitialization. Parked
metadata can grow with outstanding demand until wasm32 memory allocation fails;
it is not bounded by the admitted-demand limits. ID lookup and queue selection
use linear lists, so repeated submission/cancellation can take quadratic time.
This change establishes policy ownership, not a whole-tab memory budget (#24)
or a general speedup.

### Local validation, 2026-11-11

Windows 11 build 26100, Playwright Chromium 145.0.7632.6, pinned Clang
18.1.2. Baseline file tree: `c584695` (same tree as `769a9c0`). The
regenerated core is 33,925 bytes. All 524 unit tests, 40 desktop browser
tests, four opt-in large-file tests, the offline ENVI/TIFF single-file worker
test, the core ABI suite, lint and the packaged build passed.

The checked browser benchmark preserved ENVI read/delivered/copy counts:
cold 162 fills / 3,149,825 browser bytes / 8,764,585 copied bytes; warm
zero fills and zero browser bytes; adjacent pans three fills / 196,608
browser bytes; sparse spectra 768 fills / 3,072 browser bytes / 6,144 copied
bytes. Value checks, warm-cache reuse, TIFF codec/reservation workloads and
worker parity also passed. These are synthetic browser File workloads, not
physical-drive throughput measurements.

The queue benchmark uses five rounds per size, two admitted descriptors,
one held provider read, and cancellation of every other demand. Each round
issued one 64-byte provider read and drained all queue counts and pins.
Times below are p50/p95 milliseconds; timer resolution and run noise apply.

| Demands | Enqueue before | Enqueue after | Cancel before | Cancel after | C node payload storage |
| --- | --- | --- | --- | --- | --- |
| 128 | 0.4 / 0.8 | 0.2 / 0.4 | 0.4 / 0.7 | 0.4 / 0.5 | 9,984 B |
| 512 | 2.3 / 2.6 | 1.0 / 1.3 | 4.4 / 4.6 | 4.3 / 4.4 | 31,488 B |
| 2,048 | 31.8 / 66.5 | 20.1 / 28.0 | 31.8 / 33.9 | 38.2 / 55.9 | 117,504 B |

Enqueue improved in this run; large-queue cancellation regressed. This does
not establish a general performance improvement or change the linear-list
complexity. Raw before/after reports are local ignored outputs under
`test-results/fmap-{browser,queues}-{before,after}-29.json`; rerun the two
documented benchmark commands for current measurements. The summary above
preserves the observed comparison independently of those temporary reports.


## Synchronous span reduction ABI

These `fmap_*` exports are compatibility adapters in `fmap_reduction.c`.
The independent `<reduction.h>` API takes caller-owned spans and result buffers;
it has no pager dependency or shared global result. Clang/LLD links it alongside
fmap into one WASM memory before the ordinary HTML embedding step.

`fmap_reduce_numeric(slot, offset, count, stride, type, littleEndian, asF32,
bins, min, max)` reads a pinned resident span and checks sample validity.
`fmap_reduce_scratch_numeric(offset, count, stride, type, littleEndian, asF32,
bins, min, max, validBytes)` uses the bounded scratch region for assembled
cross-page values or row slabs. Both return the requested sample count on
success, including skipped non-finite values, or an ordinary negative status.
The actual finite sample count is in the result. `bins=0` computes statistics
only; `bins=1..256` additionally uses caller-provided bin edges. `asF32=1`
rounds each decoded sample to Float32 to match the existing analysis contract.

`fmap_reduction_ptr()` addresses 261 doubles: min, max, finite count, sum,
sum-of-squares, then 256 bin counts. These 2,088 bytes are shared synchronous
scratch, overwritten by the next reduction call; the worker merges them into
a separate compact per-job accumulator before releasing its page lease or
yielding. Empty spans report positive/negative infinity for min/max and zero
count. This is not a job handle or a persistent pointer. No raw page pointer
is retained across async I/O, memory growth, cache release or cancellation.

The client uses one exact uint8 frequency-table pass, then rebins the 256
counts to observed edges. Other types use a range pass followed by a second
source pass. `reduceBandWindow()` returns compact bins and moments, not a
raster, and checks generation, root mapping lifetime, cancellation and per-source
admission through the existing request path. Optional masks use admitted byte
snapshots and bounded transport chunks. Returned counts are Uint32 and requests
above that count capacity are rejected. Requested windows use the existing
origin-clamping convention; padded samples outside the source are excluded from
the reduction (they are not measured zeros).

See [the reduction study](../../docs/fmap-reductions.md) for the fptr/span
boundary, measured default-enablement decision, reproducible benchmark and
remaining streaming/shared-budget boundaries. This ABI does not add SIMD or
TIFF codecs and does not establish a whole-tab memory quota.
