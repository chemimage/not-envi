# Test suite

Run `npm test` for unit/controller tests followed by the browser smoke workflow.
Use `npm run test:unit -- tests/unit/<name>.test.js` for a focused unit run.
Use `npm run benchmark:fmap` for the deterministic 8 GiB logical-source pager microbenchmark.
Use `npm run test:fmap-large` for the opt-in sparse-file browser gate; it creates a temporary file with markers beyond 4 GiB and removes it afterward.
Use `npm run test:fmap-core` for the C/WASM ABI and fixed-pool tests.
Use `npm run test:fmap-browser` for the format/cancellation matrix on desktop and mobile Chromium emulation profiles.
This includes overlapping window/range fill deduplication, retained partial-page reuse, and active clear/close tests against the real C/WASM worker. Unit tests also exercise priority promotion, shared-waiter cancellation, pinned-slot backpressure, and stale asynchronous read completion.
Mapped-region coverage checks shared file pages, pointer lifetime across clear/unmap/address reuse, safe high virtual addresses, and required reads waiting through tiny admission budgets. The C range index also runs randomized mapping churn against an interval oracle.
Resident-page tests cover hash collisions, pinning, eviction, reset/reinitialization, exact u64 IDs and lookup probe bounds. TIFF index tests cover compact offset columns, main/nested/linked IFDs, shared overview ancestry and page-family provenance. Browser tests check metadata-only indexing before selecting native levels, including reduced images that precede their base and independent grayscale band pyramids.
Use `npm run test:fmap-packaged` to build the single HTML and check ENVI and compressed TIFF worker values offline.
Use `npm run benchmark:fmap-browser -- --output test-results/fmap-performance.json` for checked ENVI/TIFF browser workloads, p50/p95 latency, read/copy counters, a page-policy reference, and a sparse-spectrum comparison with the chunk cache. Add `--envi-only` to isolate the ENVI workloads.
The report also includes a 12,812-pixel-wide strided viewport workload to expose worker scheduling overhead across many batches. Its repeated raw reads must reuse resident partial pages without additional file I/O; they do not measure pyramid tile reuse.
The mapping-index section measures checked insertion, lookup, release, automatic address allocation, fragmented-gap reuse, and metadata storage at 64, 1,024, and 16,384 ranges. Visit counters check that dense occupied subtrees are skipped. It excludes file I/O and worker messaging and has no latency pass threshold.
The resident-page index section checks 100,000 lookups at 64, 1,024 and 8,192 resident slots, recording hash probes and index storage independently of eviction selection and file I/O.

The format matrix exercises all nine supported ENVI numeric types, three layouts, and both byte orders through fmap. It checks Float64/64-bit integer precision, chunked large results, and cancellation. TIFF checks cover C/WASM-backed ranges, block decoding, retained backing storage, lifecycle, and unsupported-format behavior. The performance harness compares fmap with the existing backend on identical 1024 by 1024 raw/PackBits/LZW/Deflate tiles and strips, checking warm-read I/O and decode reservations with files larger than the raw page pool. The test LZW encoder emits literals with dictionary clears; this is not a compression-ratio benchmark. Existing-backend copy counts are unavailable and reported as null. Mobile emulation checks browser behavior at mobile viewport/touch settings; physical device validation and its protocol are tracked in [issue #26](https://github.com/chemimage/Hyve/issues/26).

`npm run benchmark:fmap-queues -- --output test-results/fmap-queues.json` measures queue construction/sorting, client execution and logical-output waiters, parked fpage cancellation, and pyramid admission across a view change. It runs production modules and C/WASM in Chromium with controlled provider latency (100 ms) and explicitly held pyramid reads; it is not a disk-throughput benchmark. Queue CPU timings exclude composition and reads. The report distinguishes removing unsent descriptors, cancelling admitted jobs, and draining already-started provider reads. View changes must cancel obsolete admitted/admission-waiting tiles; a real-worker bridge case checks that aborts reach fmap without accepting late tiles, starting more obsolete I/O, or leaking reservations. Unit tests also cover useful overlapping reads, band changes, and returning to a cancelled tile before its old backend settles. Timing values have no pass threshold and may fall below browser timer resolution.

## Choosing the test boundary

- Combine assertions when they describe stages of the same operation on the same fixture: loading and reading a dataset, opening and closing a panel, or enabling and disabling a feature.
- Keep intermediate assertions so a failure identifies which stage broke. Each test must create its own state; tests must not depend on another test running first.
- Use named `test.each` cases for the same contract with different formats, hardware profiles, or rendering modes. Keep each case independently reported.
- Retain separate tests for cancellation, concurrency, fallback implementations, boundary conditions, and distinct input gestures. Similar setup alone does not make these redundant.
- Prefer decoded output or observable behavior over checking that a function exists, a blob is nonempty, or a configuration constant equals its current value.
- Stub the hardware capabilities needed by a test and restore them afterward. Avoid silently returning when the host has different capabilities.

## Consolidated coverage

The September 2026 review covered all 51 original unit files and the browser smoke file. The changes reduced 293 unit cases to 273 and combined the two browser smoke cases into one workflow.

| Area | Shared workflow or retained boundary |
| --- | --- |
| Cache and configuration | Hardware detection feeds concurrency/preview decisions. Memory detection, configured budget fraction, and dataset budget assignment share one test. Cached reads, eviction, and close share a lifecycle. |
| Dataset panels | Switching datasets asserts the active ID alongside panel linking. Overlay relinking and restoration use the same original split-state fixture. Single-dataset and whole-session cleanup remain separate. |
| ENVI | Header parsing feeds normalization. File-list pairing feeds dataset creation and actual pixel reads, while malformed headers, aliases, scale metadata, and export byte encoding retain focused cases. |
| TIFF export | `tiff-backend.test.js` covers the underlying encoders through real decoding, signatures, page counts, and pixel values. The former header-only/nonempty-blob `tiff-encoder.test.js` is redundant. Single/multipage and Float32/UInt16 paths remain distinct. |
| TIFF loading and scheduling | Native/fallback parsing, palette/JPEG/raw blocks, planar layout, edge padding, overviews, cancellation, handle lifetime, and low-concurrency deadlocks retain separate cases. Hardware cache profiles share a named case table. |
| Spectrum | Open, coordinate-unit switching, area labels, and close share a panel lifecycle. Pending area results transition to sampled results on one controller. Hover modes, axis editing, deferred layout, area reduction, stale requests, and point reads retain separate coverage. |
| Rendering | Partial and approximate pyramid previews share a fixture with separate named cases. Progressive rendering, stale/in-flight requests, panel ordering, preview sources, pyramid disposal, and geometry remain independent. |
| Interaction and analysis | Marquee disable/enable/disable shares a lifecycle; linked-scale conversion feeds clamping; annotation remapping covers point conversion. Grid line existence is checked alongside its spacing. Draw tools, gestures, histogram controllers, and export UI retain distinct contracts. |
| Browser smoke | One page load verifies the empty state and then opens the multi-file chooser, checking browser errors across both stages. |

Small helper tests for formatting, display math, view geometry, band mapping, and HUD behavior remain where they protect a distinct result. Test count alone is not a reason to remove them.
