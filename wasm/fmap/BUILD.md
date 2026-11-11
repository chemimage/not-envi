# fmap WASM core

The fmap core is a dependency-free Rust `cdylib`. It owns a fixed resident
page pool, page metadata, pin counts, LRU selection, counters, and a bounded
Float32 extraction buffer. Browser code remains responsible for range I/O.

## Pinned build

The checked-in `rust-toolchain.toml` pins Rust 1.85.1 and the
`wasm32-unknown-unknown` target. Install rustup, then run from the repository
root:

```powershell
node scripts/build-fmap-wasm.mjs
```

The script runs native Rust unit tests, builds the release WASM, verifies its
magic bytes, and writes:

- `wasm/fmap/pkg/fmap_core.wasm`
- `wasm/fmap/pkg/fmap_core.build.json`

Set `FMAP_CARGO` to an explicit Cargo executable when it is not on `PATH`.
The script rejects a Cargo toolchain whose `rustc` is not exactly 1.85.1.

## Generated artifact policy

The `.wasm` file and build manifest are committed so the normal JavaScript
build can remain offline and reproduce the single-file application. Do not
hand-edit them. Regenerate both through the build script after changing Rust
sources, and review the SHA-256 and exported surface recorded in the manifest.

This first core is single-threaded and does not require `SharedArrayBuffer` or
cross-origin isolation. Its WASM memory can grow while initializing the fixed
pool but cannot shrink; changing the budget is expected to recreate the worker.
