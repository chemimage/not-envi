# fmap implementation evidence

Updated: 2026-11-10. Scope: C/WASM migration, bounded scheduling and cancellation,
sparse BSQ read planning, and format/browser/performance coverage for issue #20.
Whole-application budget integration is deferred at the maintainer's request.

## Current implementation

The core in `wasm/fmap/src/fmap_core.c` is freestanding C11, built with pinned
WASI SDK 24 / Clang 18.1.2. It has no WASI/libc imports. It owns a fixed page
pool, resident metadata, pin/release state, LRU eviction, 64-bit logical page
identities, endian-aware Float32 extraction, and one page each of scratch and
output storage. The JavaScript build verifies both the binary hash and the
normalized C source hash. Normal app builds use the committed module and do
not require a C compiler.

The browser worker reads the selected File directly using FileReaderSync.
The source remains on the selected provider; no whole-file import or OPFS
copy is performed. BSQ Float32 windows and point spectra use fmap when the
viewer is opened with `?fmap=1`. Other types/layouts and TIFF use the existing
backend. The feature remains disabled by default and has not been released.

## Scheduling and read planning

- Per-source admission limits cover queued request count/bytes, active result
  and temporary-read reservations, and maximum result size. Defaults are 64
  queued requests, 32 MiB queued reservations, 8 MiB active reservations, and
  4 MiB per result. Oversized operations fail with a request-budget error and
  must be split into smaller windows.
- Foreground requests precede speculative background work. Visible pyramid
  tiles use foreground priority; prefetch/preview work uses background
  priority. Background jobs expire or yield to foreground admission.
- Requests accept AbortSignal, a cancellation predicate, and an optional
  supersession key. Cancellation rejects the caller immediately but retains
  an active reservation until the worker acknowledges it.
- Worker generators release all page/scratch views between batches and yield
  to the event loop after a bounded amount of work. A single FileReaderSync
  call cannot be interrupted; provider stalls can exceed the normal batch
  duration. Closing the source terminates its worker.
- Dense windows reuse pages. Cold sparse spectra read exact spans into the
  C-owned scratch page, avoiding eviction of viewport pages. Nearby samples
  can be coalesced up to the configured gap and batch limits. The last sample
  determines the exact span end. Warm resident data is reused in either path.
- Cancellation is wired through viewport rendering, spectra, pyramid disposal,
  area reads, histograms, and previews. Obsolete results do not publish, and
  expected cancellation does not produce error UI.

## Reproduction

```text
npm run build:fmap
npm run test:fmap-core
npm run test:unit
npm run test:e2e
npm run test:fmap-browser
npm run test:fmap-large
npm run test:fmap-packaged
npm run benchmark:fmap
npm run benchmark:fmap-browser -- --output test-results/fmap-performance.json
npm run lint
```

Compiler setup is documented in `wasm/fmap/BUILD.md`. The packaged test builds
and validates the single HTML before running with network access disabled.
CI runs the compiler/ABI, unit, desktop/mobile-emulation, large-offset,
packaged-HTML, performance, lint, and build checks. Its performance JSON is
uploaded as the `fmap-performance` artifact.

## Validation on the implementation host

Windows with Playwright Chromium 145.0.7632.6:

- C module: 5,116 bytes, 28 exports, no imports; SHA-256
  `54a8c6dbcabce75e66dffafacf2999ee14de480ef26a6c340e651dfe79fe0173`.
- Direct ABI suite: endian decoding, scratch bounds, pin backpressure, LRU,
  generations, large page identities, and unchanged linear memory across
  200 logical pages passed.
- Unit suite: 54 files / 312 tests passed. Default browser suite: 16 passed,
  with the explicit sparse-file gate skipped there and run separately.
- Browser matrix: 12 tests passed across desktop, iPhone 13, and Pixel 7
  Chromium emulation. Each profile checks all 54 combinations of nine ENVI
  types, three layouts, and two byte orders; two combinations use fmap and
  52 verify fallback behavior. TIFF pixels, NaN/Infinity, unaligned/page-crossing
  samples, and active cancellation after reading starts are also checked.
- The real on-disk gate decoded markers starting beyond 4 GiB, including a
  Float32 crossing a page boundary, with an 8 KiB resident pool.
- The built HTML passed offline on `file://`: embedded worker results matched
  known Float32 values, and an existing TIFF fallback dataset also opened.
- A 64 MiB resident pool occupied 67,764,224 bytes (64.625 MiB) of C/WASM
  linear memory, including scratch, output, metadata, and module overhead.

## Browser performance snapshot

The checked workload uses a synthetic 32 MiB File, 512 x 512 x 32 BSQ Float32
values, 64 KiB pages, and a 512 KiB resident pool. Every output is checked
against deterministic expected values. This measures the browser bridge and
read policy; it is not a physical-drive or mobile measurement.

| Workload | Samples | p50 / p95 ms | Browser-delivered bytes |
| --- | ---: | ---: | ---: |
| Cold distinct viewports | 12 | 1.6 / 3.4 | 3,803,120 |
| Warm repeated viewport | 20 | 0.1 / 0.3 | 0 |
| Adjacent pans | 24 | 0.1 / 0.2 | 196,608 |
| Repeated sparse spectrum, fmap | 24 | 5.5 / 6.1 | 3,072 |
| Same spectra, chunk-cache baseline | 24 | 5.6 / 7.9 | 50,331,648 |

The spectrum checksums match. Browser read amplification is 1x for fmap and
16,384x for this deliberately cache-thrashing baseline. Cold strided viewports
still have about 19.3x amplification: page reuse trades extra bytes for fewer
range reads. Peak active reservation was 81,920 bytes, final pinned bytes were
zero, and the resident pool stayed at 512 KiB. The benchmark enforces value,
allocation, warm-read, and sparse-read invariants; latency has no flaky speed
threshold. Repeat the command to collect timings on another host.

## Remaining work

The shared global allocator, hidden-dataset memory reclamation, and worker
recreation for shrinking memory remain deferred. Existing caller outputs,
image caches, and browser internals are outside the per-source request bound.
Counters cover worker copies and browser-delivered bytes, not physical disk
traffic or every main-thread copy. BIL/BIP/other numeric types and TIFF have
fallback tests, but their processing has not moved into fmap. Streaming
analysis and broader read-policy tuning remain follow-up work.

Physical iOS/iPadOS and Android runs are still pending; Chromium emulation
does not establish mobile memory limits. Use [the device test protocol](FMAP_DEVICE_TESTS.md)
to record device, provider, latency, correctness, and stability before default
enablement or release.
