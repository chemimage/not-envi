# fmap initial implementation evidence

Date: 2026-11-10  
Scope: M0, M1, and the BSQ Float32 viewport/spectrum slice of M2 from issue #20.

## What is implemented

- The existing JavaScript data-source contracts now use consistent short EOF reads, owned return buffers, incremental page visits, per-source concurrency, unique cancellation identities, and generation-safe clear/close behavior.
- `wasm/fmap` is a dependency-free Rust `wasm32-unknown-unknown` pager pinned to Rust 1.85.1. It owns a fixed page pool, sparse resident metadata, pin/release state, LRU eviction, counters, and bounded little-endian Float32 extraction.
- `src/io/fmap` runs range reads in a dedicated worker with `FileReaderSync`, copies only resident pages into WASM, and returns bounded viewport or point-spectrum results.
- ENVI BSQ Float32 files can opt into fmap with `?fmap=1`. Unsupported ENVI layouts and types continue through the released JavaScript backend. fmap remains disabled by default.
- The committed WASM hash is verified during Vite startup and the artifact and worker are embedded in the single-file HTML build.

The selected `File` remains the backing store. The implementation does not copy the full input into OPFS, IndexedDB, JavaScript, or WASM memory.

## Reproduction commands

```text
npm run build:fmap
npm run benchmark:fmap
npm run test:fmap-large
npm run test:unit
npm run test:e2e
npm run build
npm run lint
```

`build:fmap` requires the pinned Rust toolchain and target described in `wasm/fmap/BUILD.md`. Normal application builds use the verified committed artifact and do not require Rust.

## Results on the implementation host

Host: Windows, headless Chromium supplied by Playwright.

- Rust/WASM: 5 Rust tests passed; the generated module is 30,962 bytes with SHA-256 `d2d6b02c6281408788661d692014e76ffa789d6e712fc793fd2ab22ab717c0cc`.
- Browser large-offset gate: known Float32 markers starting at byte 4,294,971,389 were decoded twice from a temporary on-disk sparse file. The first value crossed a 4 KiB page boundary. The tracked resident pool remained 8 KiB and the warm read produced cache hits.
- Synthetic baseline: deterministic BSQ, BIL, and BIP viewport/pan, spectrum, and bounded area-window workloads all passed their decoded-value checks against an ENVI source beginning beyond 5 GiB. Synthetic TIFF tile and strip range patterns also produced stable checksums.
- Synthetic pager comparison: an 8 GiB logical source, 256 KiB pages, 16 MiB pool, and 256 deterministic probes produced matching cold/warm checksums (`32117`) in both implementations. The observed run loaded 64 MiB cold and about 63.75 MiB warm for each pager policy. This is a deterministic pager comparison, not an end-to-end viewer or mobile speed claim.
- A configured 64 MiB resident pool occupied 65.5 MiB of WASM linear memory in the measured module: 64 MiB resident pages plus a 256 KiB output area, metadata, allocator state, and module overhead.
- Validation: 54 unit files / 301 tests passed; 12 default browser tests passed with the explicit large-file gate skipped; the explicit large-file test passed; lint passed; the single-file build assertion passed.
- CI installs the pinned Rust target and regenerates/verifies the WASM artifact before running the JavaScript and browser suites.

## Measured limitations

- fmap currently covers ENVI BSQ Float32 viewport reads and point spectra only. BIL, BIP, other ENVI types, TIFF, streaming analysis, and a shared whole-application budget remain later milestones.
- Little-endian Float32 extraction runs in WASM. Big-endian BSQ Float32 uses a bounded worker-side conversion fallback.
- One dedicated worker performs synchronous page reads serially. The client queue is bounded, but foreground priority, queue-age limits, and global byte reservations are not implemented yet.
- A changed cache-runtime budget is recorded but does not resize the already allocated WASM pool. Recreating the worker is required to reduce linear memory; that belongs to M3.
- Counters describe requested bytes, browser-delivered bytes, copies, useful values, cache activity, and the fixed resident pool. They do not measure physical disk traffic or all browser-internal allocations.
- No physical iOS/iPadOS or Android result is claimed. Default enablement and publishing require the later mobile and packaged-HTML validation milestone.
