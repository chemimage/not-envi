# fmap implementation roadmap

Status: implementation in progress, 2026-11-10. The initial feature branch now uses C/WASM with cancellable batches and sparse BSQ read planning. See [implementation evidence](FMAP_INITIAL_IMPLEMENTATION.md).
Baseline: release `v1.10.0`, commit `f4ab87f` (application behavior from `3380e3e`).
fmap ("fake map") is the proposed subsystem name, not a claim of operating-system mmap support.

## Objective and boundaries

Read user-selected ENVI and TIFF datasets much larger than the browser's usable memory, including files larger than physical RAM on mobile devices. Keep originals on their existing storage and read only required regions. Do not import entire files into OPFS, IndexedDB, JavaScript arrays, or WASM memory.

The original file is the backing store. Browser storage quota is distinct from the application's live memory budget. fmap does not bypass browser permissions, process limits, or mobile tab termination. Users select files through existing file input/drag-and-drop or a supported picker; a typed operating-system path is not sufficient authorization. Do not require an installed server or native wrapper.

Keep the current UI, scientific value semantics, ENVI interleave/endian support, TIFF backend fallback, and downloadable single-file HTML deployment. Introduce the new backend behind a reversible feature switch. Do not describe it as validated for mobile until tested on physical devices.

## Architecture

```text
File / FileSystemFileHandle acquired through browser UI
  -> dedicated worker: range-read bridge
  -> bounded WASM resident pool + sparse page table
  -> format-aware ENVI/TIFF planner and processing
  -> bounded result buffers
  -> existing display and analysis controllers
```

WASM owns resident storage and compute over it. JavaScript bridges browser file APIs and worker messages. Avoid duplicating a full raw cache on both sides. A worker isolates synchronous reads and decoding from the UI, but synchronous work must be broken into bounded jobs so cancellation and new requests can be serviced.

Start with one worker and no SharedArrayBuffer requirement. Do not make cross-origin isolation or WASM threads prerequisites. Benchmark asynchronous `Blob.slice().arrayBuffer()` against worker-only `FileReaderSync` as transport choices. Both require explicit copying into ordinary WASM linear memory; count the temporary read allocation. Emscripten WORKERFS is a useful baseline for synchronous file reads, not a demand-paged mmap implementation.

Use a reproducible, pinned WASM toolchain. The selected implementation is freestanding C11 compiled with WASI SDK 24 / Clang 18.1.2, following the maintainer's preference for C. The module has no WASI/libc imports. Build instructions and the generated-artifact policy live in `wasm/fmap/BUILD.md`. File offsets use 64-bit integers independently of wasm32 pointers. At the JavaScript Blob boundary, convert only after checking exact safe-integer representability; reject unsupported offsets clearly. Never apply JavaScript bitwise coercion to file sizes or offsets.

Current priorities: finish bounded scheduling, useful cancellation, and read-policy improvements; add format/fallback, packaged HTML, mobile-emulation, and performance coverage. Whole-application budget integration (M3) is deferred at the maintainer's request. Per-source request/output limits remain enforced while that larger allocator is pending. Physical-device validation remains a separate manual gate.

## Required contracts

1. **Addressing:** `(source instance, generation, file offset)` identifies data. The page table contains only resident/in-flight entries, not an array proportional to file size. Test offsets around 2 GiB and 4 GiB and beyond.
2. **Leases:** acquisition returns bounded, pinned spans with valid-byte lengths. A lease is read-only and valid only until release. No pointer survives eviction or slot reuse. Make release exception-safe. Do not promise contiguous pointers for arbitrary large ranges.
3. **Bounded acquisition:** split operations larger than the pool into batches. Reserve bytes before starting I/O or decode. If all slots are pinned, apply backpressure; do not grow indefinitely or deadlock by holding a batch while waiting for its own replacement slots.
4. **Budget:** account for resident allocation, in-flight reads, temporary copies, decoder scratch, outputs in transit, retained display results, and decoded/pyramid caches. Charge allocated backing storage rather than only typed-view lengths; avoid double counting shared ownership. Browser/codec internal allocations remain outside exact accounting and need measured headroom.
5. **Fixed pool:** initially allocate a conservative bounded pool. Reuse slots instead of repeated memory growth. WASM memory is not generally shrinkable; a mobile budget reduction may require quiescing and recreating the worker. Do not claim eviction reduces the allocated linear-memory size.
6. **I/O:** raw reads consistently report available bytes; exact decoder reads reject truncation. Check offset addition, ENVI payload size, dimensions, and TIFF ranges before decoding. Do not fabricate missing samples as zeros.
7. **Lifecycle:** each open source has a unique cancellation owner, even for identical file metadata. Closing/clearing advances a generation; late completions cannot populate a newer cache. Cancel queued work and discard late active results. Shared page loads remain alive while another consumer needs them.
8. **Scheduling:** enforce aggregate per-source and global request/byte limits. Foreground viewport and probe work outrank speculative prefetch. A stale render must not publish output. Cancellation checkpoints occur between bounded I/O/decode batches.
9. **File changes:** external mutation may invalidate the File object. Surface failure and require reopening into a new generation; never combine old cached bytes with a refreshed file silently.
10. **Instrumentation:** separate requested bytes, browser-delivered bytes, cache hits, copied bytes, useful decoded values, retained allocation, pinned bytes, in-flight reservation, queue latency, and cancelled/stale work. Browser-delivered bytes are not measured physical disk traffic.

Initial mobile experiments should use configurable total application-managed budgets such as 64/128/256 MiB, with the raw pool only a portion of each budget. These are test configurations, not established safe device limits. Do not infer free RAM from `navigator.deviceMemory` or treat a heap limit as available memory. Global allocations must remain within the configured budget even with many hidden datasets.

## Existing code and observed gaps

| Code | Migration role / issue to cover |
| --- | --- |
| `src/core/data-source.js` | Replace range-wide page retention with bounded acquisition; normalize EOF, ownership, lifecycle and concurrency contracts. |
| `src/core/shared-scheduler.js` | Preserve fairness while separating source identity from cancellation identity and enforcing aggregate limits. |
| `src/io/envi-loader.js`, `src/core/envi-parser.js` | Validate safe dimensions, header offset and minimum payload length; retain file selection behavior. |
| `src/core/raster-io.js`, `src/io/envi-data-source.js` | Consolidate read planning, avoid duplicate slab logic, migrate endian conversion and band extraction. |
| `src/render/spectrum-data.js` | Sparse BSQ spectra need different read planning from contiguous BIP spectra. |
| `src/io/tiff/data-sources.js`, `src/io/tiff/backend/` | Preserve compressed block semantics, native overviews and fallback; audit retained raw views and decoder allocations. |
| `src/app/cache-runtime.js` | Replace independent cache floors with an enforceable total budget and immediate trimming/backpressure. |
| `src/render/pyramid-cache.js`, `src/render/preview-cache.js` | Coordinate decoded/output ownership and cancel stale prefetch; do not rebuild all pyramid levels eagerly. |
| `src/app/area-reduction-worker-client.js`, `src/app/workers/area-reduction.worker.js` | Reuse worker lifecycle lessons; avoid transferring entire datasets for analysis. |
| `scripts/inline-dist.mjs`, `.github/workflows/` | Package WASM/worker bytes offline in the single HTML and validate the actual built artifact. |

Synthetic probes on `3380e3e` established: (a) a 512 KiB visit loads all pages before its first callback despite a 128 KiB cache budget; (b) a cross-page read pads beyond EOF while a single-page read is short; (c) clear can be undone by an in-flight read; (d) closing one instance cancels another with the same metadata-derived owner; (e) source concurrency=1 allows independent simultaneous reads; (f) 16 BSQ bands with 1 MiB pages and a two-page cache read 16 MiB per 64-byte spectrum, including a repeated probe. These are reproducible contract/workload examples, not device benchmarks or evidence of all real-world access patterns.

## Implementation milestones and acceptance gates

### M0 — Executable baseline and contracts

- Add focused regressions for the observations above and an instrumented synthetic range source that represents very large files without allocating them.
- Record baseline counters and latency for BSQ/BIL/BIP viewports, spectra, pan/zoom, area reductions, and TIFF tiles/strips. Use deterministic values and compare actual decoded outputs.
- Specify span, budget, lifecycle and worker message contracts before rewriting consumers. Suggested module boundary: `src/io/fmap/` for bridge/client/protocol, `wasm/fmap/` for pager/processing, and dedicated tests/benchmarks.
- Gate: runnable benchmark command and tests that distinguish existing behavior from required behavior. Do not leave newly failing tests in the default CI suite; pair each contract regression with its implementation or keep baseline probes explicitly separate.

### M1 — Minimal WASM pager with browser file bridge

- Build an actual WASM core, fixed resident pool, sparse page lookup, pin/release, in-flight deduplication and LRU eviction of unpinned slots. Start with configurable fixed page size; measure before adding complexity.
- Implement bounded range reads and explicit ownership at the JS/WASM boundary. Batch calls; never invoke WASM or browser I/O once per pixel.
- Test short reads, cross-page typed values, unaligned headers, all-pinned backpressure, clear/close during reads, two instances of the same file, and repeated open/close cycles.
- Gate: real browser worker reads beyond 4 GiB using an on-disk sparse fixture with known markers; stable tracked allocations under repeated random requests; no full-file initialization or OPFS copy. Synthetic large offsets alone do not prove browser file support.

### M2 — ENVI vertical slice behind a switch

- Support existing ENVI data types, endian modes and BSQ/BIL/BIP layouts. Validate the declared payload before data access. Preserve existing numeric conversion semantics and document precision limits.
- Move window extraction and point spectra into the worker/WASM path. Integrate with current async rendering interfaces and cancellation sequences.
- Plan exact last-sample spans rather than overreading `outputWidth * step` unnecessarily. Estimate unique missing pages and reuse; coalesce adjacent reads with bounded overread. Compare page sizes and consider sparse bypass/subpages only after measuring cold and warm workloads.
- Gate: parity with the reference backend, working viewer interaction, repeated spectra without pathological cache churn for the selected policy, and bounded allocations independent of total file size. Record throughput and p50/p95 latency, not just average speed.

### M3 — Shared budgets and streaming analysis

- Integrate raw pages, pyramid/preview caches, output pools and reduction scratch into one budget allocator with reservations and headroom. Make hidden datasets surrender budget.
- Stream histograms and area/line reductions through bounded batches. Transfer only bounded result buffers; return/recycle buffers after consumption. Account for transfer copies from WASM memory.
- Bound prefetch by both bytes and queue age. Test foreground requests during scans, rapid pan/zoom, cancellation, dataset removal, and simultaneous panels.
- Gate: repeated interaction reaches a memory plateau; lowering budgets behaves explicitly; no stale results or starvation. Keep browser total memory observations separate from exact application counters.

### M4 — TIFF integration

- Start with uncompressed tiled TIFF; then compressed tiles, planar configurations, overviews, and strips. Preserve the existing backend as fallback while each path gains parity coverage.
- Align range reads to encoded blocks where appropriate. A compressed block's decoded size can exceed the raw page pool: reserve decode/output space before dispatch.
- For a giant compressed strip, use a verified bounded streaming decoder if available; otherwise fail that operation clearly or select a supported overview. Do not promise arbitrary TIFFs fit bounded memory merely because raw bytes are paged.
- Gate: parity on representative BigTIFF, edge tiles, compressed blocks, multi-page files and native overviews; decoded backing storage remains accounted for after raw eviction.

### M5 — Mobile validation and release readiness

- Test current desktop Chromium/Firefox/Safari where supported and physical iOS/iPadOS Safari and Android Chrome. Document precise versions, devices, budgets, file sizes and file-provider type. Cloud-provider files may have different availability and latency.
- Exercise files larger than RAM, not only large dimensions in a mock. Record cold/warm open time, time to first useful view, p95 pan/probe latency, read/copy amplification, tracked peak allocation and observed browser stability.
- Run the built single-file HTML with network disabled and load a local dataset; verify embedded workers and WASM instantiate and existing TIFF fallback still works. Test Pages HTTPS separately. Retain file-input fallback when picker APIs are absent.
- Gate: unit + E2E + WASM tests + build pass, physical-device evidence recorded, and no unexplained correctness regressions. Performance claims require results against the same baseline and fixtures. Default enablement is a later decision based on evidence, not part of this handoff.

## First task for GPT-5.6 Sol

Work from `v1.10.0` plus this document on a feature branch. Inspect current source and repository instructions before editing. Implement M0 and M1, then one BSQ Float32 viewport and spectrum slice of M2 behind a disabled-by-default switch. Use the released backend as the comparison oracle on valid fixtures, but do not preserve its known EOF/lifecycle bugs as desired behavior.

Deliver the actual WASM source, pinned build instructions, browser bridge, focused tests, a benchmark harness, and a short evidence report with commands and measured limits. Keep UI behavior and release/deployment settings stable. Do not publish or enable the backend by default as part of this initial implementation. Expand format coverage only after the bounded-memory and large-offset gates pass. If a dependency or browser limitation blocks a gate, report the concrete limitation rather than silently loading the whole file or copying it to OPFS.

## Primary references

- [File handle / external modification behavior](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/getFile)
- [File picker availability and user activation](https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker)
- [Sync access handles are OPFS-only](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle)
- [Emscripten WORKERFS](https://emscripten.org/docs/api_reference/Filesystem-API.html#workerfs)
- [WORKERFS range reads and copy implementation](https://github.com/emscripten-core/emscripten/blob/main/src/lib/libworkerfs.js)
- [WASM memory growth and view invalidation](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow)

These references were consulted during design discussion. Recheck support and pin dependency revisions at implementation time; do not treat moving upstream links as a reproducible build specification.
