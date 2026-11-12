# fmap ROI reductions: spans, fptrs and measured enablement

This study records the exploration in [#35](https://github.com/chemimage/not-envi/issues/35).
It adds a C span kernel, an actual file-worker reduction operation, numeric/mask
parity checks, a placement-matched JavaScript control and a reproducible browser
benchmark. It enables the measured uint8 specialization selectively; it does not
enable the slower generic float reduction in the viewer at that stage.

The subsequent [#24 streaming driver](streaming-statistics.md) now uses bounded
moments/fixed-edge operations for source-backed analysis. Small float histograms
retain one bounded batch; larger ones accept the two-pass latency tradeoff to
bound temporary storage. The historical benchmark below does not establish a
speedup for that newer driver.

The subsequent [C module split](../wasm/README.md) moves scalar decoding into
`wasm/numeric`, the allocation-free reduction kernel into `wasm/reduction`,
and the pinned-page adapter into `fmap/src/fmap_reduction.c`. Public fmap
declarations are split by function, with `<fmap.h>` retained as an umbrella.
The modules are statically linked at the WASM build step and then embedded in
the offline HTML. This keeps one coordinated memory without making the kernel
depend on fmap internals. The measurements below identify the original
implementation/artifact; they remain historical checked results, not fresh
timings for every subsequent source refactor.

The [module-split recheck](benchmarks/fmap-reductions-modules-2026-11-12.json)
uses the same workload, controls, browser and five cold/repeat rounds with
artifact SHA-256 `eaa56a5cb6384ef944c5bc1c79aec4661b52de8ff8a24c6430212b0a869dccf0`.
Uint8 remained faster in all checked cases: for warm, pool-fitting 1024² BSQ,
materialized/C medians were 16.2/7.2 ms; BIP medians were 17.1/8.1 ms.
Generic Float32 retained the two-pass tradeoff, so the enablement decision
did not change. This recheck also validates numerical results and byte counters;
it does not establish that the source split itself caused a speedup.

## Why a leased span is sufficient

`FmapRegion.ptr()` creates an opaque logical mapping identity and virtual file
address, not a C pointer into resident bytes. `region.read()` still returns an
owned copied result. Resolving an fptr does not, on its own, eliminate decoding,
extraction, transport or raster allocation.

The worker already resolves requests through the authoritative mapping/fill
state and resumes processing with a pinned slot and exact valid range. The new
kernel consumes that span synchronously, with numeric type, byte order and
stride. It decodes and reduces without first writing a decoded output raster.
The existing planner still handles BSQ/BIL/BIP, sampling, coalescing and sparse
validity. A cross-page numeric value or gathered row slab uses bounded scratch.

There is no new public fptr interface. Window requests retain root-mapping
identity and generation checks. A future mapped-region reduction interface can
add logical-region bounds/lifetime semantics; it would not change the basic
compute benefit. An ordinary span returned as a copied JS array is different:
passing that array into a separate WASM memory would reintroduce a copy.

The C result is 261 doubles (2,088 bytes): min/max/count/sum/sum-of-squares plus
256 counts. That shared result is consumed before another C call or yield.
Each runnable job owns a separate compact JS accumulator. No WASM view or
resident pointer crosses an await or survives its lease. Actual WASM views are
reacquired after memory growth. Request cancellation/clear/unmap/close use the
existing admission and lease lifecycle; started provider reads stay charged
until settlement.

## Histogram and numerical contracts

- Uint8 values have only 256 possible values. One source pass accumulates exact
  value frequencies and moments; the client rebins those counts to the observed
  range used by `computeHistogram`. This avoids a second source pass.
- Other numeric types first find the finite observed range, then make a second
  source pass to build bins and moments. This saves ROI output storage, but may
  read/decode twice. Known externally supplied edges could fuse these passes;
  that is not the current observed-range UI contract.
- Samples are converted to Float32 before accumulation, matching the existing
  analysis path even for Float64/64-bit integer sources. This is not a promise
  to preserve source Float64 or integer precision in analysis. Non-finite
  converted samples are skipped. Empty/constant range and percentile/mode/bin
  rules match the existing histogram, including its large-constant edge case
  where adding `1e-6` cannot change the double-precision range.
- Sums and squared sums use double precision. Merging spans changes summation
  grouping, so generic float moments are compared with numerical tolerance;
  this is not a numerically stable variance estimator for all dynamic ranges.
  Uint8 integer moments in the supported count range are exactly representable.
- Optional byte masks are snapshotted after admission and sent in bounded
  chunks. A union mask includes an overlapping pixel once. The API does not
  construct polygon/selection unions or select their sample lattice for callers.
  The existing polygon/multi-selection UI remains on its current path.
- Requests preserve origin clamping but exclude samples beyond source bounds;
  padded raster zeros are not measured pixels. Histogram counts use Uint32, and
  larger requested sample counts are rejected. Sampling metadata still belongs
  to the caller; reduced samples are not silently described as full-resolution.

The additional logical reservation covers compact temporary accumulators and
the optional mask snapshot. Requests charge result/mask transport through the
existing per-source queue. A source still retains its configured pager/scratch
and numeric output capacity, even if a particular reduction does not use that
output buffer. This is not the shared application budget from #33, nor a
whole-browser heap bound.

## Original viewer decision (before #24 streaming)

Use the C one-pass path for whole-image and single-rectangle histograms with at
least 262,144 sampled pixels, **only for uint8 sources exposing
`reduceBandWindow()`**. The lower bound is the smallest measured image size,
not a measured universal crossover. The existing step selection, labels,
selection cancellation token and display synchronization are preserved.

Currently this directly benefits fmap ENVI data sources. TIFF wrappers do not
automatically expose this operation. Small requests, other numeric types,
polygons, multiple selections and incompatible sources keep the existing
viewer path. The generic and masked APIs are tested building blocks for #24;
they do not complete streamed area spectra, line reductions or polygon/union
orchestration. No SIMD build was introduced.

## Checked measurements

Run `npm run benchmark:fmap-reductions -- --output test-results/fmap-reductions.json`.
It checks identical results before recording reports for all three paths:

1. Current fmap window materialization into a Float32 analysis array, followed
   by the ordinary JS histogram.
2. A fused JS loop inside the file worker over the same leased spans.
3. The C kernel inside that worker, with the same pager/planner and bin policy.

The JS control supports uint8 and Float32, the two benchmark types, and is
selected only by the experimental `reductionBackend: "js"` option. Viewer
calls use C. This control separates placement/fusion benefits from language
effects, while retaining the existing source planning in both cases.

The committed [raw report](benchmarks/fmap-reductions-2026-11-12.json) was measured
on Windows/x64, Chromium 145.0.7632.6, on 2026-11-12. The C artifact SHA-256 is
`e74135cea5f9e0bf1b7ad95ae6d714d2c027609651129a6b199565c9851ea2e8`.
Each case has five explicit-cache-clear runs and five immediate repeat runs.
The pool either holds the entire input or is limited to 128 KiB. BSQ has one
band; BIP has three, reducing one. Timings include reads, transport and reduction,
but exclude initial worker/module startup and UI painting. Tests were not run
concurrently with this final measurement.

These are browser File/RAM workloads. "Cold" means the application pager was
cleared, not a cold physical drive or OS cache. "Warm" means an immediate repeat;
it can still reread the source when the pool is too small. Five samples are
limited evidence, not cross-machine/browser performance guarantees.

### Uint8

Median milliseconds, **cold / immediate repeat**.

| Image | Layout | Pool | Materialized + JS | Leased JS | Leased C |
| --- | --- | --- | --- | --- | --- |
| 512 x 512 | BSQ | fits input | 6.6 / 4.8 | 5.8 / 3.9 | 4.0 / 2.5 |
| 512 x 512 | BSQ | 128 KiB | 5.8 / 7.0 | 5.2 / 5.3 | 4.0 / 4.0 |
| 512 x 512 | BIP | fits input | 8.8 / 4.6 | 8.8 / 4.1 | 7.6 / 2.9 |
| 512 x 512 | BIP | 128 KiB | 9.2 / 8.8 | 8.9 / 8.8 | 7.7 / 8.0 |
| 1024 x 1024 | BSQ | fits input | 20.8 / 16.1 | 19.5 / 13.4 | 13.0 / 7.8 |
| 1024 x 1024 | BSQ | 128 KiB | 20.1 / 21.3 | 18.6 / 18.7 | 13.2 / 13.0 |
| 1024 x 1024 | BIP | fits input | 36.2 / 16.8 | 34.8 / 14.6 | 30.3 / 9.4 |
| 1024 x 1024 | BIP | 128 KiB | 35.1 / 42.3 | 35.5 / 33.2 | 33.6 / 29.5 |

### Float32

Median milliseconds, **cold / immediate repeat**.

| Image | Layout | Pool | Materialized + JS | Leased JS | Leased C |
| --- | --- | --- | --- | --- | --- |
| 512 x 512 | BSQ | fits input | 7.6 / 3.2 | 11.2 / 6.5 | 9.6 / 4.6 |
| 512 x 512 | BSQ | 128 KiB | 7.6 / 7.1 | 15.6 / 15.1 | 12.4 / 14.2 |
| 512 x 512 | BIP | fits input | 24.2 / 3.9 | 27.0 / 7.0 | 26.6 / 5.4 |
| 512 x 512 | BIP | 128 KiB | 23.0 / 23.0 | 45.7 / 46.7 | 44.8 / 46.5 |
| 1024 x 1024 | BSQ | fits input | 26.9 / 10.4 | 48.4 / 21.8 | 33.2 / 14.4 |
| 1024 x 1024 | BSQ | 128 KiB | 30.1 / 27.0 | 56.3 / 58.8 | 51.8 / 45.2 |
| 1024 x 1024 | BIP | fits input | 94.4 / 12.0 | 110.5 / 23.7 | 99.2 / 16.9 |
| 1024 x 1024 | BIP | 128 KiB | 98.8 / 94.1 | 202.0 / 184.4 | 185.7 / 189.3 |


Uint8 C reduction was faster than materialization in these cases and faster
than the placement-matched JS control. Float32 C reduction cut output traffic
but regressed latency against the ordinary path. With an undersized pool, its
second pass approximately doubled delivered source bytes. Moving the loop to
WASM does not eliminate that algorithmic cost.

This prototype computes moments in both generic passes and merges a compact
result in JS after each span. Range-only/bin-only kernels, persistent C job
accumulators and SIMD could reduce that overhead. The measured negative does
not rule out those implementations or useful wider fusion; it establishes that
this generic implementation should not replace the current latency-oriented
UI path. Avoiding eviction-driven rereads would require a different bin policy,
bounded retention strategy or suitable integer-domain specialization.

For a warm, pool-fitting 1024² window, materialization transfers 8,388,608 bytes
for uint8 (the existing generic numeric worker transport uses Float64) or
4,194,304 bytes for Float32. The reduction transfers 2,088 bytes for uint8 or
4,176 bytes over two generic passes. Pinned warm reductions make no decoded
sample copies. Cold/gathered spans and split-page values can still copy bounded
input scratch; this is not a blanket zero-copy claim.

## Validation and remaining work

Actual-WASM/browser checks cover all nine supported numeric types, three ENVI
layouts and both byte orders (54 combinations), unaligned cross-page values,
negative signed values, large 64-bit inputs, finite/non-finite/constant/empty
cases, sampling, irregular masks, per-job interleaving and admission drain.
Cancellation, clear, root unmap and close reject obsolete reductions. Direct
ABI checks reject unpinned pages, sparse holes, invalid type/range and oversized
scratch. Controller checks verify the measured path avoids full raster reads;
an offline production-HTML test exercises the embedded reduction worker.

Further work should separately measure masked/multiple-selection planning,
fixed-edge or small-integer-domain alternatives for float-like workloads,
SIMD and stable moment accumulation. Keep that work coordinated with #24 and
the shared budget in #33 rather than inferring those guarantees from this API.

For compressed TIFF (#34), resident file spans contain encoded bytes. Decoding
needs writable decoded output plus codec/predictor scratch. The issue discusses
codec-only replacement, libtiff's caller-buffer decoding and full-reader I/O
adapters. Libtiff may improve codec coverage or maintenance; it is not yet
benchmarked here and no TIFF decoding speedup is claimed.
