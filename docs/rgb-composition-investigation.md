# RGB composition investigation (#36)

The CPU path has two independently measured costs: full-image tone mapping,
and unnecessary queued pixel copies during rapid tone changes. Explicit WASM
SIMD improves full recolors; preserving acknowledged resident planes improves
main-thread submission during bursts. Small dirty patches are instead limited
mainly by canvas upload. The initial prototypes are recorded separately from
the integrated implementation below, which uses 384 KiB of fixed SIMD scratch
and dispatch-time transport packing.

Measurements: Windows, Intel i7-12700K, headless Chromium 145, Clang 18.1.2
(WASI SDK 24.0). Each size/workload/candidate runs in a fresh worker, with
8 startup/warmup frames followed by 16 measured frames. Reports retain cold
timings, p50/p95, component timings, transfer counts, source hashes and the
generated WASM hash. A second run reverses candidate order.

## Full recolors

Worker round trip includes the real production client snapshot/transport path,
worker plane ingestion, composition, canvas upload and bitmap delivery. The
experimental worker mirrors the production compositor/protocol but retains
only the three tested planes and omits eviction. GPU completion is not fenced.

Representative forward-run milliseconds, **p50 / p95**:

| Workload | Original JS | Hoisted planar JS | Explicit SIMD |
| --- | ---: | ---: | ---: |
| 1024 x 768, RGB tone change | 17.7 / 41.9 | 11.3 / 13.6 | 4.9 / 5.2 |
| 1024 x 768, BGR + no-data | 22.3 / 23.8 | 13.0 / 13.5 | 5.2 / 5.7 |
| 2048 x 1536, RGB tone change | 69.9 / 161.2 | 44.3 / 45.3 | 21.5 / 25.5 |
| 2048 x 1536, BGR + no-data | 108.5 / 263.4 | 51.6 / 52.7 | 21.9 / 23.6 |
| 127 x 95 patch on 2048 x 1536 | 4.2 / 5.0 | 4.5 / 5.4 | 4.6 / 6.6 |

The original loop performs nested channel lookups, repeated tone calls and,
for transparency, per-pixel array callbacks. Hoisting plane/parameter state
and specializing the loops helps without WASM. Those changes were tested
together; these timings do not attribute a separate cost to each operation.
An unrolled fused JS alternative was less consistent than the planar loop.
Scalar C/WASM was generally similar to planar JS; changing languages alone
does not explain the SIMD improvement.

The SIMD kernel uses `wasm_simd128.h` intrinsics and two double-precision lanes
per channel. It preserves the JS arithmetic order and division rather than
using Float32 approximation or reciprocal multiplication. Explicit NaN masks
permit pseudo-min/max clamping; an exact bounded integral-to-byte conversion
avoids saturating SIMD float-to-integer conversion. The original, more literal
SIMD implementation barely improved on planar JS before these refinements.
See [LLVM's intrinsic definitions](https://clang.llvm.org/doxygen/wasm__simd128_8h.html).

Canvas upload accounts for several milliseconds on the largest dirty-patch
case, while pixel processing is only 0.1-0.5 ms. SIMD does not improve that
end-to-end path in this experiment. Tone-only steady-state transport is tiny
because the worker already owns the unchanged source planes.

## Rapid tone changes

The production client uses `active ? null : known.get(planeId)` when preparing
transport. While a job is active, each new tone-only request therefore packs
all three unchanged source planes. Replacing an already queued request limits
retention but still pays the allocation/copy cost before cancellation.

A synchronous burst of 12 tone changes on the largest image produced:

| Candidate | Main-thread submission total | Latest result elapsed | Additional pixel transfer |
| --- | ---: | ---: | ---: |
| Original JS/client | 121.2 ms | 203.7 ms | 36 MiB |
| SIMD/original client | 125.5 ms | 158.8 ms | 36 MiB |
| SIMD/resident-plane client prototype | 0.3 ms | 40.7 ms | 0 |

The narrow reuse prototype accepts an acknowledged revision only when that
exact plane/dimensions/revision is also present unchanged in the active job.
Other cases retain the original conservative transport behavior. Each burst
rejected 11 obsolete promises with `AbortError`, delivered only the latest
result, and matched its pixels against the JS oracle. This is a synthetic
worst-case burst, not a measured slider interaction in the application.

## Correctness, memory and recommendation

Each final run checked 17,975,296 byte comparisons against the original JS
oracle: random Float32 bit patterns, half-byte boundaries, NaNs/infinities,
unusual tone settings, zero/reversed ranges, transparency, odd tails, nonzero
rectangle origins and untouched exterior pixels. Every measured worker
configuration also checked its final canvas pixels. This is empirical parity,
not a proof over all possible inputs.

The prototype stages changed planes into WASM and copies output back to
ImageData; those costs are included. It retains about **48.1 MiB of additional
WASM memory** at 2048 x 1536, alongside existing JS buffers. Recoloring does not
grow that fixed allocation, but this is not an application-wide memory bound.
WASM-backed worker planes/output ownership should be designed before shipping,
in coordination with #33. Cold creation remains much slower than warm frames.

Recommended implementation order:

1. Remove redundant tone-only queued copies while preserving snapshot and
   revision safety; validate overlapping views, eviction, failures and fallback.
2. Integrate the double-precision SIMD kernel with a JS fallback and explicit
   worker memory ownership. Keep it independent of the file pager.
3. Verify browser engines, offline packaging and lifecycle cancellation before
   enabling the new backend. Treat small-patch canvas costs as separate work.

The sections above record the isolated prototype phase. The implementation
follow-up below supersedes its full-frame WASM ownership and narrow client
reuse strategy. Prototype measurements remain distinct from integrated results.

Reproduce in PowerShell (set `FMAP_CLANG` to WASI SDK 24.0's `bin/clang.exe`):

```powershell
node scripts/benchmark-rgb-kernels.mjs docs/benchmarks/rgb-kernels-intrinsics-2026-11-13.json
$env:RGB_BENCH_REVERSE = '1'
node scripts/benchmark-rgb-kernels.mjs docs/benchmarks/rgb-kernels-intrinsics-reverse-2026-11-13.json
```

Sources are under `scripts/rgb-experiment/`; compilation and the generated
resident-client variant stay under ignored `test-results/`. Machine-readable
reports are [forward](benchmarks/rgb-kernels-intrinsics-2026-11-13.json) and
[reverse](benchmarks/rgb-kernels-intrinsics-reverse-2026-11-13.json).

## Integrated implementation

The client now snapshots immutable source data/dirty rectangles on submission,
then packs transport only when dispatching the surviving job. Packing uses the
latest worker acknowledgement, including eviction, so it does not predict what
an active job will retain. Superseded queued jobs allocate no transport buffers;
tone-only jobs with resident revisions send no pixels. Snapshot ownership and
copy-on-write for genuinely changing source data remain necessary.

The independent `wasm/rgb` module uses fixed **384 KiB** linear memory, including
16,384-pixel input/output scratch and its stack. Each batch stages only pixels
being recolored and copies that batch into the existing retained ImageData.
This keeps existing worker plane/output ownership and eliminates the prototype's
48 MiB of duplicate frame storage. The memory cannot grow. This is additional
per-worker scratch, not a bound on all existing caches/canvas/browser memory.

The kernel loads inside the display worker. Unsupported SIMD, blocked loading
or compilation failure selects the original JS worker loop; the existing main
thread fallback remains available for worker failures. The source-hashed WASM
artifact is verified by Vite and rebuilt/shared by CI independently of fmap.
Both the kernel and its worker are embedded in the offline single-file build.

[Integrated measurements](benchmarks/rgb-composition-integrated-2026-11-13.json)
use the actual production client and worker, including bounded staging/copies:

| Workload | Worker round trip p50 / p95 |
| --- | ---: |
| 1024 x 768 tone change | 5.4 / 7.2 ms |
| 2048 x 1536 tone change | 23.0 / 24.3 ms |
| 2048 x 1536 BGR/no-data | 24.8 / 29.6 ms |
| 128 x 96 patch on 2048 x 1536 | 3.2 / 5.6 ms |

The integrated 12-tone-change burst required 1.2 ms main-thread submission,
45.6 ms to the latest result, zero packed/transferred pixel bytes, and 11
expected cancellations; final pixels matched. These timings are synthetic
local observations, not universal latency guarantees.

Local validation includes numerical parity over random Float32 bit patterns and
tone parameters, odd tails, both batch dimensions, fixed-memory checks,
progressive/revision refresh, dirty updates, queue rebasing/eviction,
cancellation and immutable fallback snapshots. Browser coverage explicitly
checks SIMD use, JS worker fallback and coalesced tone bursts. The offline
package test requires the embedded RGB worker to report SIMD and 384 KiB.

Reproduce integrated timings with:

```powershell
node scripts/benchmark-rgb-composition.mjs docs/benchmarks/rgb-composition-integrated-2026-11-13.json
```

The prototype benchmark pins its original client to `d320a5d`, so the production
queue fix does not silently change its baseline on later reruns.
